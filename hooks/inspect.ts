type Entry = { kind: 'inline' | 'script'; path?: string; partial?: boolean; constructed?: boolean; inlineBody?: string }
type Result = { body?: string; unavailable?: boolean; ignored?: boolean }
type Stat = { kind: string; size: number; mtimeMs: number; isLink: boolean; realPath?: string }
type FileHost = {
  stat(path: string, opts: { resolve: true }): Promise<Stat>
  read(path: string, opts: { as: 'text'; offset: number; length: number }): Promise<string>
}

const COMMAND_LIMIT = 256 * 1024
const FILE_LIMIT = 1024 * 1024
const shellFile = /\.(?:ba)?sh$/
const shell = /^(?:(?:\/usr)?\/bin\/)?(?:bash|sh|dash)$/
const shellBang = /^#![ \t]*(?:\/(?:usr\/)?bin\/(?:bash|sh|dash)|\/usr\/bin\/env[ \t]+(?:bash|sh|dash))(?:[ \t\r\n]|$)/
const partialScript = (): Entry => ({ kind: 'script', partial: true })

// Lex just the first simple command. Never evaluate expansions, resolve PATH, or
// interpret arbitrary shell source as another command to open on disk.
function firstCommand(text: string) {
  const words: string[] = []
  let word = '', quoted = '', started = false, bad = false, i = 0
  function finish() {
    if (started) words.push(word)
    started = false
    word = ''
  }
  for (; i < text.length; i++) {
    const c = text.charAt(i)
    if (quoted && c === quoted) { quoted = ''; continue }
    if (c === '\\' && quoted !== "'") {
      const next = text[i + 1]
      if (!next) { bad = true; break }
      if (next === '\n') { i++; continue }
      started = true
      if (quoted && !'"$`\\'.includes(next)) word += c
      else { word += next; i++ }
      continue
    }
    if (!quoted && (c === "'" || c === '"')) { quoted = c; started = true; continue }
    if (!quoted && (c === ' ' || c === '\t')) { finish(); continue }
    if (!quoted && !started && c === '#') break
    if (!quoted && '|&;<>\n()'.includes(c)) break
    if ((quoted !== "'" && '$`'.includes(c)) || (!quoted && '*?[~{}!'.includes(c))) {
      // NUL cannot be a literal path or argument. Preserve the word boundary.
      word += '\0'
    } else word += c
    started = true
    if (words.length > 256 || word.length > 8192) { bad = true; break }
  }
  finish()
  return { words, rest: text.slice(i), bad: bad || !!quoted }
}

function simple(command: string): Entry {
  const { words, rest, bad } = firstCommand(command)
  const tail = !!rest && (!rest.startsWith('#') || rest.includes('\n'))
  const [program, ...args] = words
  if (!program) return { kind: 'inline', partial: true }
  let path: string | undefined
  if (shell.test(program)) {
    let i = 0
    for (; i < args.length; i++) {
      if (args[i] === '--') { i++; break }
      if (/(?:^|\/)bash$/.test(program) && ['--norc', '--noprofile'].includes(args[i]!)) continue
      if (!args[i]!.startsWith('-')) break
      if (/^-[a-zA-Z]*[cs][a-zA-Z]*$/.test(args[i]!)) return { kind: 'inline', partial: true }
      if (!/^-[euxfnv]+$/.test(args[i]!)) return partialScript()
    }
    path = args[i]
    if (!path || bad || !safeSpelling(path)) return partialScript()
  } else if (program.includes('/') && (shellFile.test(program) || !program.split('/').pop()?.includes('.'))) {
    if (bad || !safeSpelling(program)) return partialScript()
    path = program
  } else {
    return bad || tail ? { kind: 'inline', partial: true } : { kind: 'inline' }
  }
  // A redirect could overwrite the very file we're about to inspect.
  if (/^[<>]/.test(rest)) return partialScript()
  return tail ? { kind: 'script', path, partial: true } : { kind: 'script', path }
}

// Use POSIX separators only. JS trim() also strips literal path characters
// such as NBSP; a trailing-space regex can rescan long interior runs.
function shellTrim(text: string) {
  let first = 0, last = text.length
  while (first < last && ' \t\n'.includes(text.charAt(first))) first++
  while (last > first && ' \t\n'.includes(text.charAt(last - 1))) last--
  return text.slice(first, last)
}

// One intentionally narrow construction: cat writes a literal heredoc, followed
// by one invocation of exactly that file. No file on disk is evidence here.
function heredoc(command: string): Entry | undefined {
  const newline = command.indexOf('\n')
  if (newline < 0 || newline > 8192) return undefined
  const header = command.slice(0, newline)
  if (!/^cat[ \t]/.test(header)) return undefined
  const redirects = header.slice(3).split('<<')
  if (redirects.length === 1) return undefined
  const unknown: Entry = { kind: 'script', constructed: true, partial: true }
  if (redirects.length !== 2) return unknown
  const left = shellTrim(redirects[0]!), right = shellTrim(redirects[1]!)
  const delimiterFirst = !left && /^(['"])([A-Za-z_][A-Za-z_0-9]*)\1[ \t]*>/.exec(right)
  const delimiterLast = left.startsWith('>') && /^(['"])([A-Za-z_][A-Za-z_0-9]*)\1$/.exec(right)
  const rawPath = delimiterFirst ? shellTrim(right.slice(delimiterFirst[0].length)) : shellTrim(left.slice(1))
  const delimiter = delimiterFirst ? delimiterFirst[2] : delimiterLast && delimiterLast[2]
  if (!rawPath || !delimiter) return unknown
  const target = firstCommand(rawPath)
  if (target.bad || target.rest || target.words.length !== 1 || !safeSpelling(target.words[0]!)) return unknown
  const stop = command.indexOf('\n' + delimiter + '\n', newline)
  if (stop < 0) return unknown
  const invoked = simple(command.slice(stop + delimiter.length + 2))
  if (invoked.partial || invoked.path !== target.words[0]) return unknown
  return { ...invoked, constructed: true, inlineBody: command.slice(newline + 1, stop + 1) }
}

export function detect(command: string): Entry {
  if (command.length > COMMAND_LIMIT || command.includes('\0')) return { kind: 'inline', partial: true }
  command = shellTrim(command)
  command = command.replace(/^rtk[ \t]+proxy[ \t]+/, '')
  return heredoc(command) ?? simple(command)
}

function safeSpelling(path: string) {
  return path.length > 0 && path.length <= 4096 && /^[A-Za-z0-9_ .@+\/-]+$/.test(path) &&
    !path.includes('//') && !path.endsWith('/') && !path.endsWith('/.') &&
    !path.split('/').some(s => s !== '.' && s.startsWith('.'))
}
function normalized(path: string) {
  return '/' + path.split('/').filter(s => s && s !== '.').join('/')
}
function isUnder(path: string, root: string) {
  return path === root || root === '/' || path.startsWith(root + '/')
}

// Ignore entries are literal file or subtree paths (relative to the observed
// cwd or absolute), not globs. A malformed entry disables inspection, rather
// than silently broadening access. Check before stat, read or use of inlineBody.
function ignored(path: string, cwd: string, ignores: string[]) {
  return ignores.some(rule => {
    if (!rule || rule.length > 4096 || /[\\\x00-\x1f*?\[\]{}~]/.test(rule) || rule.includes('//') || rule.split('/').includes('..')) return true
    return isUnder(path, normalized(rule.startsWith('/') ? rule : `${cwd}/${rule}`))
  })
}

function textSize(text: string) {
  let bytes = 0
  for (const c of text) {
    const cp = c.codePointAt(0)!
    bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp <= 65535 ? 3 : 4
  }
  return bytes
}

function plain(text: string) {
  return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f�]/.test(text)
}

export async function inspect(fs: FileHost, entry: Entry, cwd: string, maxBytes: number, ignores: string[]): Promise<Result> {
  if (entry.kind === 'inline') return {}
  const no: Result = { unavailable: true }
  const name = entry.path
  if (!name && ignores.length) return { ignored: true }
  if (!name || !safeSpelling(name) || !cwd.startsWith('/') || !safeSpelling(cwd.replace(/\/$/, ''))) return no
  const root = normalized(cwd)
  const path = normalized(name.startsWith('/') ? name : `${root}/${name}`)
  if (ignored(path, root, ignores)) return { ignored: true }
  // The host exposes no uid. Do not traverse arbitrary shared temp trees;
  // outside cwd, only an explicitly named shell file directly in /tmp qualifies.
  const temp = /^\/tmp\/[^/]+\.(?:ba)?sh$/.test(path)
  if ((!isUnder(path, root) && !temp) || /^\/(?:dev|sys|proc|etc)(?:\/|$)/.test(path) ||
      (root === '/tmp' && !temp) || /(?:^|\/)(?:secrets?|credentials?|id_rsa|id_ed25519)(?:[./_-]|$)/i.test(path)) return no
  const base = path.slice(path.lastIndexOf('/') + 1)
  const extensionless = !base.includes('.')
  if (!extensionless && !shellFile.test(base)) return no
  const limit = Math.min(maxBytes, FILE_LIMIT)
  if (!Number.isSafeInteger(limit) || limit < 1) return no
  if (entry.constructed) {
    const body = entry.inlineBody
    return body !== undefined && body.length <= limit && textSize(body) <= limit && plain(body) ? { body } : no
  }
  try {
    const before = await fs.stat(path, { resolve: true })
    if (before.kind !== 'file' || before.isLink !== false || before.realPath !== path ||
        !Number.isSafeInteger(before.size) || before.size < 0 || before.size > limit) return no
    const read = (length: number) => fs.read(path, { as: 'text', offset: 0, length })
    // Extensionless executables are shell scripts only with a shell shebang.
    if (extensionless && !shellBang.test(await read(Math.min(before.size + 1, 128)))) return no
    const body = await read(before.size + 1)
    if (body.length > limit || !plain(body) || textSize(body) !== before.size ||
        (body.startsWith('#!') && !shellBang.test(body)) || (extensionless && !shellBang.test(body))) return no
    // No atomic no-follow handle: discard anything whose placement or metadata
    // changed across the read. This cannot establish inode identity/ownership.
    const after = await fs.stat(path, { resolve: true })
    if (after.realPath !== path || after.kind !== 'file' || after.isLink !== false ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs) return no
    return { body }
  } catch { return no }
}
