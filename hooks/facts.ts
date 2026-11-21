// Turn a background command, and the scripts it runs, into a short list of facts:
// which external commands run, on what, how often. The summary model receives these
// facts, never script source. No shell evaluation or execution happens here.

/** How a task's entry script was obtained. */
export type ScriptStatus =
  | 'read'         // read from disk and analyzed
  | 'inline'       // no script: the command itself was analyzed
  | 'dynamic'      // the script path is computed ($VAR, glob, ~): not guessed
  | 'unavailable'  // missing, too large, not text, or outside the readable places
  | 'ignored'      // matches ignorePaths

/** One external command a task runs. Values are masked; only safe targets are kept. */
export type Step = {
  /** Program and subcommand, e.g. `gh run watch`, `docker build`, `npm run build`. */
  run: string
  /** What kind of work it is, for known tools, e.g. `CI run watch`. */
  category?: string
  /** A safe identifier of what it acts on: a tag, host, run ID, `$VAR`, a file name. */
  target?: string
  /** It repeats in a loop, with this sleep between rounds when one is given. */
  every?: string
  /** It runs under `timeout` with this limit. */
  limit?: string
  /** It blocks until something external happens (a watch, a poll, a timer). */
  waits?: boolean
}

export type Facts = { scriptStatus: ScriptStatus; script?: string; steps: Step[]; omitted: number }

/**
 * Reads one script by absolute path, the way inspect() allows, judged against the task's
 * original directory: a `cd` inside the command never widens what may be read.
 */
export type ScriptReader = (path: string, inlineBody?: string) => Promise<{ body?: string; ignored?: boolean }>

type Cmd = { words: string[]; heredoc?: string; out?: string; loop?: number }
type Lexed = { cmds: Cmd[]; loops: Map<number, string> }

const MAX_TEXT = 512 * 1024
const MAX_CMDS = 600
const MAX_STEPS = 12
const MAX_SCRIPTS = 6
const MAX_DEPTH = 3
const COMPUTED = '$(…)'

/** The index of the `)` matching the `(` at `open`, skipping quoted text. */
function matchParen(text: string, open: number) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c === "'") { const e = text.indexOf("'", i + 1); if (e < 0) return text.length; i = e; continue }
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return text.length
}

/** Split shell text into simple commands. Quotes are removed; expansions stay as text. */
export function lex(text: string, depth = 0): Lexed {
  const cmds: Cmd[] = []
  const loops = new Map<number, string>()
  if (text.length > MAX_TEXT || depth > MAX_DEPTH) return { cmds, loops }
  const stack: number[] = []
  let loopId = 0
  let words: string[] = [], word = '', started = false
  let current: Cmd = { words: [] }
  let redirect: 'out' | 'skip' | undefined
  const heredocs: { delim: string; strip: boolean; cmd: Cmd }[] = []

  const endWord = () => {
    if (started) {
      if (redirect === 'out') current.out = word
      else if (!redirect) words.push(word)
      redirect = undefined
    }
    word = ''; started = false
  }
  const endCommand = () => {
    endWord()
    let w = words
    words = []
    while (w.length) {
      const k = w[0]!
      if (k === 'while' || k === 'until') { stack.push(++loopId); loops.set(loopId, k); w = w.slice(1); continue }
      if (k === 'for' || k === 'select') { stack.push(++loopId); loops.set(loopId, 'for'); w = []; break }
      if (k === 'done') { stack.pop(); w = w.slice(1); continue }
      if (['do', 'then', 'else', 'elif', 'if', 'fi', '!', 'time', '{', '}', 'esac'].includes(k)) { w = w.slice(1); continue }
      if (k === 'case' || k === 'function' || /^[^\s()]+\)$/.test(k)) { w = []; break }
      break
    }
    const cmd = current
    current = { words: [] }
    if (w.length && cmds.length < MAX_CMDS) { cmd.words = w; cmd.loop = stack[stack.length - 1]; cmds.push(cmd) }
    else if (cmd.heredoc !== undefined || heredocs.some(h => h.cmd === cmd)) { cmd.words = w }
  }
  const nested = (inner: string) => {
    const sub = lex(inner, depth + 1)
    for (const c of sub.cmds) if (cmds.length < MAX_CMDS) cmds.push({ ...c, loop: stack[stack.length - 1] })
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '\\') {
      if (text[i + 1] === '\n') { i++; continue }
      word += text[i + 1] ?? ''; started = true; i++; continue
    }
    if (c === "'") {
      const e = text.indexOf("'", i + 1), end = e < 0 ? text.length : e
      word += text.slice(i + 1, end); started = true; i = end; continue
    }
    if (c === '"') {
      let j = i + 1
      for (; j < text.length && text[j] !== '"'; j++) {
        const d = text[j]!
        if (d === '\\' && j + 1 < text.length) { word += text[++j]; continue }
        if (d === '$' && text[j + 1] === '(') {
          const e = matchParen(text, j + 1)
          if (text[j + 2] !== '(') nested(text.slice(j + 2, e))
          word += COMPUTED; j = e; continue
        }
        if (d === '`') {
          const e = text.indexOf('`', j + 1), end = e < 0 ? text.length : e
          nested(text.slice(j + 1, end)); word += COMPUTED; j = end; continue
        }
        word += d
      }
      started = true; i = j; continue
    }
    if (c === '`') {
      const e = text.indexOf('`', i + 1), end = e < 0 ? text.length : e
      nested(text.slice(i + 1, end)); word += COMPUTED; started = true; i = end; continue
    }
    if (c === '$' && text[i + 1] === '(') {
      const e = matchParen(text, i + 1)
      if (text[i + 2] !== '(') nested(text.slice(i + 2, e))
      word += COMPUTED; started = true; i = e; continue
    }
    if (c === '$' && text[i + 1] === '{') {
      const e = text.indexOf('}', i), end = e < 0 ? text.length - 1 : e
      word += text.slice(i, end + 1); started = true; i = end; continue
    }
    if (c === '#' && !started) {
      const e = text.indexOf('\n', i)
      i = (e < 0 ? text.length : e) - 1; continue
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue }
    if (c === '\n') {
      endCommand()
      // Heredoc bodies are data: attach them to their command and skip them.
      let pos = i + 1
      for (const h of heredocs.splice(0)) {
        const start = pos
        for (;;) {
          if (pos >= text.length) { h.cmd.heredoc = text.slice(start); break }
          const e = text.indexOf('\n', pos), lineEnd = e < 0 ? text.length : e
          const line = text.slice(pos, lineEnd)
          pos = lineEnd + 1
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) { h.cmd.heredoc = text.slice(start, Math.max(start, lineEnd - line.length)); break }
        }
      }
      i = pos - 1; continue
    }
    if (c === ';' || c === '&' || c === '|') {
      endCommand()
      while (';&|'.includes(text[i + 1] ?? 'x')) i++
      continue
    }
    if (c === '(' || c === ')') {
      if (c === '(' && text[i + 1] === ')') { words = []; word = ''; started = false; i++; continue } // name() {
      endCommand(); continue
    }
    if (c === '<' || c === '>') {
      if (started && /^\d+$/.test(word)) { word = ''; started = false } else endWord()
      let op = c
      while ('<>&|-'.includes(text[i + 1] ?? 'x') && op.length < 3) op += text[++i]
      if (op === '<<' || op === '<<-') {
        let j = i + 1
        while (text[j] === ' ' || text[j] === '\t') j++
        let delim = ''
        for (; j < text.length && !/[\s;&|<>()]/.test(text[j]!); j++) if (!`'"\\`.includes(text[j]!)) delim += text[j]
        if (delim) heredocs.push({ delim, strip: op === '<<-', cmd: current })
        i = j - 1; continue
      }
      if (op.endsWith('&') && /[\d-]/.test(text[i + 1] ?? '')) { i++; continue } // 2>&1, >&-
      redirect = op.includes('>') ? 'out' : 'skip'
      continue
    }
    word += c; started = true
  }
  endCommand()
  return { cmds, loops }
}

// ---------------------------------------------------------------------------
// Classification

const QUIET = new Set(['echo', 'printf', 'true', 'false', ':', 'set', 'export', 'local', 'declare', 'typeset',
  'readonly', 'unset', 'shift', 'exit', 'return', 'break', 'continue', 'trap', 'read', 'test', '[', '[[', ']]',
  'wait', 'let', 'eval', 'pushd', 'popd', 'cat', 'tee', 'date', 'pwd', 'mkdir', 'rm', 'cp', 'mv', 'touch',
  'chmod', 'chown', 'ln', 'basename', 'dirname', 'realpath', 'readlink', 'which', 'type', 'hash', 'umask',
  'shopt', 'alias', 'getopts', 'logger', 'clear', 'tput', 'stty', 'exec', 'source', '.'])
const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'ksh'])
// CLIs whose first one or two words name the operation.
const SUBCOMMANDS: Record<string, number> = {
  gh: 2, glab: 2, git: 1, docker: 2, podman: 2, kubectl: 2, oc: 2, helm: 1, npm: 2, pnpm: 2, yarn: 2, bun: 2,
  npx: 1, cargo: 1, go: 1, terraform: 1, tofu: 1, pulumi: 1, aws: 2, gcloud: 3, az: 2, fly: 1, flyctl: 1,
  vercel: 1, netlify: 1, firebase: 1, make: 1, just: 1, task: 1, poetry: 1, uv: 1, pip: 1, dotnet: 1, mvn: 1,
  gradle: 1, gradlew: 1, bazel: 1, skaffold: 1, argocd: 2, gsutil: 1, wrangler: 1, nx: 1, turbo: 1, deno: 1,
  pytest: 0, jest: 0, vitest: 0, playwright: 1, ansible: 0, 'ansible-playbook': 0, rsync: 0, ssh: 0, scp: 0,
}
// Flags whose value is a safe, useful target. Values of every other flag are dropped.
const TARGET_FLAGS = /^--?(?:t|tag|n|namespace|repo|R|w|workflow|b|branch|env|environment|app|a|name|service|cluster|project|region|f|file|context|job|j|stage|target|image)$/
const VALUE_FLAGS = /^--?(?:t|tag|n|namespace|repo|R|w|workflow|b|branch|env|environment|app|a|name|service|cluster|project|region|f|file|context|job|j|stage|target|image|o|output|c|config|p|port|u|user|H|header|d|data|X|request|build-arg|label|platform|timeout|interval|q|query|jq|json|template|limit|L|s|signal|k)$/
const FLAG_NAMES: Record<string, string> = { '-n': 'namespace', '-t': 'tag', '-R': 'repo', '-w': 'workflow',
  '-b': 'branch', '-a': 'app', '-f': 'file', '-j': 'job' }
const CATEGORIES: [RegExp, string, boolean?][] = [
  [/^(gh run watch|gh pr checks|gh run view|glab ci (status|view)|glab pipeline)/, 'CI run watch', true],
  [/^gh run list|^gh workflow (view|list)/, 'CI run lookup'],
  [/^gh workflow run|^glab ci run/, 'CI workflow trigger'],
  [/^gh pr (merge|create)/, 'pull request update'],
  [/^(docker|podman) (buildx build|build|image build)|^buildah|^kaniko|^docker buildx bake/, 'container image build'],
  [/^(docker|podman) (push|image push)/, 'container image push'],
  [/^(docker|podman) (compose up|run|start)/, 'container run'],
  [/^(kubectl|oc) (rollout status|wait)/, 'Kubernetes rollout wait', true],
  [/^(kubectl|oc) (apply|rollout restart|set image|create|scale)/, 'Kubernetes change'],
  [/^(kubectl|oc) (logs|get|describe)/, 'Kubernetes status read'],
  [/^helm (upgrade|install|rollback)/, 'Helm release'],
  [/^(terraform|tofu) (apply|destroy)|^pulumi (up|destroy)/, 'infrastructure change'],
  [/^(terraform|tofu) plan|^pulumi preview/, 'infrastructure plan'],
  [/^(aws (ecs|cloudformation|lambda) wait|aws [a-z0-9-]+ wait)/, 'AWS resource wait', true],
  [/^(aws (ecs update-service|deploy)|gcloud (run|app|functions) deploy|az [a-z]+ (deploy|up)|fly(ctl)? deploy|vercel|netlify deploy|firebase deploy|wrangler (deploy|publish)|argocd app sync)/, 'deployment'],
  [/^argocd app wait/, 'deployment wait', true],
  [/^(npm|pnpm|yarn|bun) (run )?(test|test:\S+)$|^(pytest|jest|vitest|go test|cargo test|dotnet test|mvn test|gradlew? test|playwright test)/, 'tests'],
  [/^(npm|pnpm|yarn|bun) (run )?(build|build:\S+)$|^(go build|cargo build|dotnet build|mvn (package|install)|gradlew? (build|assemble)|bazel build|nx build|turbo (run )?build)/, 'build'],
  [/^(npm|pnpm|yarn|bun) (install|ci|add)$|^(pip|uv|poetry) (install|sync)/, 'dependency install'],
  [/^(npm|pnpm|yarn|bun) (run )?(lint|typecheck|check)\b/, 'lint and type check'],
  [/^(npm|pnpm|yarn|bun) (run )?(deploy|release|publish)\b|^npm publish/, 'release'],
  [/^(npm|pnpm|yarn|bun) (run|exec)\b/, 'package script'],
  [/^(make|just|task)\b/, 'make target'],
  [/^(curl|wget|http|https|xh)\b/, 'HTTP request'],
  [/^(nc|ping|dig|nslookup)\b/, 'network check'],
  [/^sleep\b/, 'timer', true],
  [/^git (push|pull|fetch|clone)/, 'git sync'],
  [/^(ssh|scp|rsync)\b/, 'remote host operation'],
  [/^(grep|egrep|rg|sed|awk|jq|yq|wc|sort|uniq|head|tail|cut|tr|xargs|find)\b/, 'text processing'],
  [/^(node|python3?|ruby|deno|bun|php|perl) /, 'program run'],
  [/^watch\b/, 'repeated command', true],
]
const LOW = new Set(['text processing', 'program run'])

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const secretish = /(?:authorization|cookie|pass(?:word|phrase|wd)|secret|token|api[-_]?key|private[-_]?key|credential|bearer)/i
const knownToken = /\b(?:sk-|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AKIA|ASIA|AIza|eyJ)[a-zA-Z0-9_./+=-]{4,}/i

/** A value safe to show: an identifier, tag, host, number or variable name. */
export function safeTarget(value: string): string | undefined {
  if (!value || value.length > 400) return undefined
  const url = /^(https?|wss?):\/\/(?:[^@/\s]*@)?([\w.-]+(?::\d+)?)([^?#\s]*)/.exec(value)
  if (url) {
    if (secretish.test(url[2]!) || knownToken.test(url[2]!)) return undefined
    const path = url[3]!.split('/').filter(s => /^[\w.-]{1,30}$/.test(s) && !/[0-9a-f]{20,}/i.test(s)
      && !secretish.test(s) && !knownToken.test(s)).slice(0, 2)
    return [url[2], ...path].join('/')
  }
  if (value.length > 120 || secretish.test(value) || knownToken.test(value)) return undefined
  if (value.includes(COMPUTED)) return value === COMPUTED ? 'computed value' : undefined
  const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value)
  if (variable) return secretish.test(variable[1]!) ? undefined : `$${variable[1]}`
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return value.slice(0, value.indexOf('=')) + '=…'
  if (!/^[\w.:\/@#+%,-]{1,80}$/.test(value) || /[0-9a-f]{24,}/i.test(value)) return undefined
  return value.includes('/') && !/^[\w.-]+\/[\w.-]+$/.test(value) ? basename(value) : value
}

/** Describe one simple command (wrappers already removed). */
export function classify(words: string[], limit?: string): Step | undefined {
  const program = basename(words[0] ?? '')
  if (!/^[\w.+-]{1,64}$/.test(program) || QUIET.has(program) || secretish.test(program) || knownToken.test(program)) return undefined
  // A credential option may take an ordinary-looking value in the next word.
  // Keep the operation before it, not that value as a target or a subcommand.
  let args = words.slice(1)
  // Recognize a manifest version lookup without retaining the JavaScript expression.
  if (program === 'node' && ['-p', '--print'].includes(args[0] ?? '')) {
    const file = /^require\(\s*(['"])(?:[.\w/-]+\/)?(package\.json|plugin\.json)\1\s*\)\.version$/.exec(args[1] ?? '')?.[2]
    return file ? { run: 'node', category: 'manifest version read', target: file } : { run: 'node', category: 'program run' }
  }
  if (program === 'grep' && args[0] === '-c' && /^\^#{1,6} $/.test(args[1] ?? '') && args[2]?.endsWith('.md')) {
    return { run: 'grep', category: 'Markdown heading count', target: safeTarget(basename(args[2])) }
  }
  const privateArg = args.findIndex(a => a.startsWith('-') && (secretish.test(a) || /^-(?:[upb].*|-(?:[\w-]*[-_])?(?:auth|key|user|header|data|cookie)(?:=|$))$|^-[Hd]/.test(a)))
  if (privateArg >= 0) args = args.slice(0, privateArg)
  const depth = SUBCOMMANDS[program] ?? (/^(node|python3?|ruby|deno|php|perl)$/.test(program) ? 1 : 0)
  const parts = [program]
  let i = 0
  for (; i < args.length && parts.length <= depth; i++) {
    const a = args[i]!
    if (a.startsWith('-')) {
      if (program.startsWith('python') && a === '-m') {
        const m = args[++i]; if (m && /^[\w.]{1,64}$/.test(m) && safeTarget(m)) parts.push(`-m ${m}`)
        i = args.length; break
      }
      if (VALUE_FLAGS.test(a)) i++
      if (/^(node|python3?|ruby|deno|php|perl)$/.test(program) && /^-(?:e|c|p|-eval|-print)$/.test(a)) { parts.push('inline code'); i = args.length; break }
      continue
    }
    if (/^[a-z][\w:.-]{0,30}$/i.test(a) && safeTarget(a)) parts.push(a)
    else if (/^(node|python3?|ruby|deno|php|perl)$/.test(program) && /^[\w./-]+$/.test(a) && safeTarget(basename(a))) parts.push(basename(a))
    else break
  }
  const run = parts.join(' ')
  // The first safe positional value after the operation, and any safe named target.
  const targets: string[] = []
  for (let j = i; j < args.length && targets.length < 2; j++) {
    const a = args[j]!
    if (a.startsWith('-')) {
      const eq = a.indexOf('=')
      const flag = eq > 0 ? a.slice(0, eq) : a
      const value = eq > 0 ? a.slice(eq + 1) : (VALUE_FLAGS.test(a) ? args[++j] : undefined)
      if (value !== undefined && TARGET_FLAGS.test(flag)) {
        const safe = safeTarget(value)
        if (safe) targets.push((FLAG_NAMES[flag] ?? flag.replace(/^-+/, '')) + ' ' + safe)
      }
      continue
    }
    if (targets.some(t => !t.includes(' '))) continue
    const safe = safeTarget(a)
    if (safe && safe !== '.') targets.push(safe)
  }
  const category = CATEGORIES.find(([pattern]) => pattern.test(run))
    ?? CATEGORIES.find(([pattern]) => pattern.test(run + ' ' + args.join(' ')))
  if (program === 'sleep' && targets[0] && /^\d+(\.\d+)?$/.test(targets[0])) targets[0] += 's'
  const step: Step = { run }
  if (category) step.category = category[1]
  if (targets.length) step.target = targets.join(', ')
  if (category?.[2]) step.waits = true
  if (limit && /^\d{1,9}(?:\.\d{1,4})?[smhd]?$/.test(limit)) step.limit = limit
  if (program === 'gh' && /^gh (pr checks|run watch)/.test(run) && args.includes('--watch')) step.waits = true
  return step
}

type Context = {
  cwd: string
  reader: ScriptReader
  strictPaths: boolean
  files: Map<string, string>
  scripts: number
  depth: number
  status?: ScriptStatus
  name?: string
  steps: Step[]
}

const literal = (p: string) => !!p && !/[$*?[\]{}~`]/.test(p) && !p.includes(COMPUTED)
const join = (cwd: string, p: string) => p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`

/** Remove command wrappers: timeout, env, nohup, sudo, rtk proxy, watch and the like. */
function unwrap(words: string[]): { words: string[]; limit?: string; every?: string } {
  let w = words, limit: string | undefined, every: string | undefined
  for (let guard = 0; guard < 8 && w.length; guard++) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w = w.slice(1)
    const p = basename(w[0] ?? '')
    let rest = w.slice(1)
    if (p === 'timeout') {
      while (rest[0]?.startsWith('-')) rest = /^-(s|k)$|^--(signal|kill-after)$/.test(rest[0]) ? rest.slice(2) : rest.slice(1)
      limit = rest[0]; w = rest.slice(1); continue
    }
    if (p === 'env') {
      while (rest.length && (rest[0]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)))
        rest = /^-(u|C|S)$/.test(rest[0]!) ? rest.slice(2) : rest.slice(1)
      w = rest; continue
    }
    if (p === 'sudo' || p === 'doas') {
      while (rest[0]?.startsWith('-')) rest = /^-(u|g|h|p|C)$/.test(rest[0]) ? rest.slice(2) : rest.slice(1)
      w = rest; continue
    }
    if (p === 'nice' || p === 'ionice' || p === 'stdbuf' || p === 'chrt' || p === 'taskset') {
      while (rest[0]?.startsWith('-')) rest = /^-(n|c|p)$/.test(rest[0]) ? rest.slice(2) : rest.slice(1)
      w = rest; continue
    }
    if (p === 'watch') {
      while (rest[0]?.startsWith('-')) {
        if (/^-(n|-interval)$/.test(rest[0])) { every = rest[1] ? `${rest[1]}s` : undefined; rest = rest.slice(2) }
        else if (/^--interval=/.test(rest[0])) { every = `${rest[0].slice(11)}s`; rest = rest.slice(1) }
        else rest = rest.slice(1)
      }
      every ??= '2s'; w = rest; continue
    }
    if (p === 'rtk' && rest[0] === 'proxy') { w = rest.slice(1); continue }
    if (['nohup', 'time', 'exec', 'command', 'builtin', 'unbuffer', 'caffeinate', 'xvfb-run', 'script'].includes(p) && rest.length) {
      if (p === 'command' && /^-[vV]$/.test(rest[0] ?? '')) return { words: [] }
      w = rest.filter((a, i) => !(i === 0 && a.startsWith('-') && p !== 'command')); continue
    }
    break
  }
  return { words: w, limit, every }
}

async function runScript(ctx: Context, path: string) {
  const entry = ctx.status === undefined
  if (!literal(path)) { if (ctx.strictPaths) ctx.status = 'ignored'; else if (entry) ctx.status = 'dynamic'; ctx.steps.push({ run: 'script', target: 'computed path' }); return }
  const full = join(ctx.cwd, path)
  if (entry) ctx.name = basename(path)
  let body: string | undefined
  if (ctx.scripts < MAX_SCRIPTS && ctx.depth < MAX_DEPTH) {
    ctx.scripts++
    const got = await ctx.reader(full, ctx.files.get(full))
    if (got.ignored) { ctx.status = 'ignored'; return }
    body = got.body
  }
  if (body === undefined) {
    if (ctx.strictPaths) ctx.status = 'ignored'; else if (entry) ctx.status = 'unavailable'
    const name = safeTarget(basename(path))
    ctx.steps.push(name ? { run: 'script', target: name } : { run: 'script' })
    return
  }
  if (entry) ctx.status = 'read'
  ctx.depth++
  try { await analyze(ctx, body) } finally { ctx.depth-- }
}

async function analyze(ctx: Context, text: string) {
  const { cmds, loops } = lex(text)
  const first = ctx.steps.length
  const stepLoop: (number | undefined)[] = []
  const add = (s: Step | undefined, loop?: number) => { if (s) { ctx.steps.push(s); stepLoop[ctx.steps.length - 1 - first] = loop } }
  for (const cmd of cmds) {
    if (ctx.status === 'ignored' || ctx.steps.length > 200) break
    // A file this command writes from a heredoc is known without reading the disk.
    if (cmd.heredoc !== undefined && cmd.out && literal(cmd.out)) ctx.files.set(join(ctx.cwd, cmd.out), cmd.heredoc)
    const { words, limit, every } = unwrap(cmd.words)
    const program = basename(words[0] ?? '')
    if (!program) continue
    if (program === 'cd') {
      const to = words[1]
      if (to && literal(to)) ctx.cwd = join(ctx.cwd, to).replace(/\/\.(?=\/|$)/g, '')
      continue
    }
    if (SHELLS.has(program)) {
      let i = 1, code: string | undefined
      for (; i < words.length && /^[-+]/.test(words[i]!); i++) {
        const f = words[i]!
        if (f === '--') { i++; break }
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(f)) { code = words[i + 1]; break }
        if (/^[-+][a-zA-Z]*o$/.test(f)) i++
      }
      if (code !== undefined) {
        ctx.depth++
        try { if (ctx.depth <= MAX_DEPTH) await analyze(ctx, code) } finally { ctx.depth-- }
      } else if (words[i]) await runScript(ctx, words[i]!)
      continue
    }
    if (program === 'source' || program === '.') { if (words[1]) await runScript(ctx, words[1]); continue }
    if (words[0]!.includes('/') && (/\.(?:ba)?sh$/.test(program) || !program.includes('.'))) { await runScript(ctx, words[0]!); continue }
    const step = classify(words, limit)
    if (step && every) { step.every = /^\d{1,9}(?:\.\d{1,4})?s$/.test(every) ? every : 'repeatedly'; step.waits = true }
    add(step, cmd.loop)
  }
  // Loops: a sleep inside sets the polling interval of the other commands in it.
  for (const [id, kind] of loops) {
    const inLoop = ctx.steps.slice(first).map((s, i) => ({ s, i })).filter(x => stepLoop[x.i] === id)
    const sleep = inLoop.find(x => x.s.run === 'sleep')
    const others = inLoop.filter(x => x.s.run !== 'sleep')
    if (!others.length) continue
    for (const { s } of others) {
      s.every = sleep?.s.target && /^\d+(\.\d+)?[smhd]?$/.test(sleep.s.target) ? sleep.s.target : 'repeatedly'
      if (kind !== 'for' || sleep) s.waits = true
    }
    if (sleep) sleep.s.run = ''
  }
  for (let i = ctx.steps.length - 1; i >= first; i--) if (!ctx.steps[i]!.run) ctx.steps.splice(i, 1)
}

function rank(s: Step) {
  return s.waits ? 0 : s.category && !LOW.has(s.category) ? 1 : !s.category && s.run !== 'script' ? 2 : 3
}

/** Facts about one background command, reading the scripts it runs through `reader`. */
export async function factsOf(command: string, cwd: string, reader: ScriptReader, strictPaths = false): Promise<Facts> {
  const ctx: Context = { cwd, reader, strictPaths, files: new Map(), scripts: 0, depth: 0, steps: [] }
  try { await analyze(ctx, command) } catch { if (strictPaths) ctx.status = 'ignored' }
  if (ctx.status === 'ignored') return { scriptStatus: 'ignored', steps: [], omitted: 0 }
  // One entry per distinct operation and target, most telling first, in source order within a rank.
  const seen = new Set<string>()
  const unique = ctx.steps.filter(s => {
    const key = `${s.run}|${s.target ?? ''}|${s.every ?? ''}`
    if (seen.has(key)) return false
    seen.add(key); return true
  })
  const ordered = unique.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(x => x.s)
  const steps = ordered.slice(0, MAX_STEPS)
  const facts: Facts = { scriptStatus: ctx.status ?? 'inline', steps, omitted: ordered.length - steps.length }
  if (ctx.name) { const n = safeTarget(ctx.name); if (n) facts.script = n }
  return facts
}

/** A short label from facts alone, for when no model answer is available. */
export function factLabel(f: Facts): string | undefined {
  const s = f.steps.find(x => x.waits && x.category) ?? f.steps.find(x => x.category && !LOW.has(x.category))
    ?? f.steps.find(x => x.waits) ?? f.steps[0]
  if (!s || s.run === 'script') return undefined
  const what = s.category ?? s.run
  const first = s.run === 'sleep' ? s.limit ?? s.target : s.target?.split(', ')[0]
  const target = first && !first.includes(' ') && first.length <= 32 ? ` ${first}` : ''
  return `${what[0]!.toUpperCase()}${what.slice(1)}${target}`
}
