import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { Wait, WaitTask } from '../types'
import { detect, inspect } from './inspect'
import { factLabel, factsOf, type Facts } from './facts'
import { outputLines, parseWait, phrase, replyTokens, SYSTEM_PROMPT, waitPrompt, type TaskInput, type WakeupInput } from './summary'

// What the row above the prompt shows. `none` until the agent first stops in this session.
const wait = atom({ plugin: 'shell-insight', key: 'wait' } as const, { kind: 'none' } as Wait)

/** A background task as the host's Stop event lists it. */
type Background = { id: string; type: string; status: string; description: string; command?: string }
type Cron = { id?: string; schedule?: string; prompt: string }
/** What was learned about a task when it went to the background. */
type Launch = { startedAt?: number; output?: string; facts?: Promise<Facts | undefined> }

const STALE_MS = 2 * 60 * 1000
const RESUMMARIZE_MS = 60 * 1000
const TAIL_BYTES = 4096

// Keep host capabilities explicit: native mod validation follows each $.noun.method call.
function observer($: EngineInterface) {
  return {
    cwd: () => $.session.cwd(), now: () => $.clock.now(),
    every: (ms: number, f: () => void) => $.clock.every(ms, f), after: (ms: number, f: () => void) => $.clock.after(ms, f),
    stat: (p: string, o: {resolve:true}) => $.fs.stat(p, o),
    read: (p: string, o: {as:'text',offset:number,length:number}) => $.fs.read(p, o),
    complete: (r: Parameters<EngineInterface['model']['complete']>[0], signal: AbortSignal) => $.model.complete(r, {signal}),
    debug: (text: string) => $.ui.log(`shell-insight: ${text}`, { to: 'debug' }),
  }
}
type Host = ReturnType<typeof observer>

function integer(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value))) : fallback
}

export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = seconds % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

function ago(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

function tag(text: string, name: string) {
  return new RegExp(`<${name}>([^<]{1,200})</${name}>`).exec(text)?.[1]?.trim()
}

function texts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap(b => b && typeof b === 'object' && (b as {type?: unknown}).type === 'text'
    && typeof (b as {text?: unknown}).text === 'string' ? [(b as {text: string}).text] : [])
}

/** Strip terminal escapes and other controls from a task's raw output. */
function printable(text: string) {
  return text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g, '')
    .replace(/\r(?!\n)/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

// "Run script A", "Run sample-b.sh", "Background task": says nothing about the work.
const generic = /^(?:(?:run|start|execute|launch|kick off|begin)\b[\w\s.-]{0,24}|[\w\s-]{0,20}\b(?:script|task|command|job|sample|process)\b[\w\s.-]{0,12})$/i

function fallbackLabel(t: Background, facts?: Facts) {
  const own = phrase(t.description, 50)
  const known = facts ? factLabel(facts) : undefined
  return own && (!generic.test(own) || !known) ? own : known ?? own ?? t.type ?? 'task'
}

function fallbackHeadline(labels: string[], crons: Cron[]) {
  const names = Array.from(new Set(labels))
  if (crons.length) names.push(crons.length === 1 ? 'a scheduled wakeup' : `${crons.length} scheduled wakeups`)
  if (!names.length) return 'background work'
  return phrase(names.join(' and '), 110) ?? `${labels.length} background tasks`
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return
  const maxBytes = integer(options.maxScriptBytes, 65536, 1, 262144)
  const timeoutMs = integer(options.summaryTimeoutMs, 10000, 100, 60000)
  const ignores = String(options.ignorePaths || '').split('\n').map(s => s.trim()).filter(Boolean)
  const language = String(options.language || 'en'), model = String(options.model || 'haiku')
  const mask = options.redactSecrets !== false

  const launched = new Map<string, Launch>()
  // The work the row describes now. `version` changes whenever that set changes.
  let pending: Background[] = [], crons: Cron[] = [], lastMessage = '', version = 0
  let tick: Timer | undefined, stop: AbortController | undefined, attempt = 0

  function quiet() { tick?.cancel(); tick = undefined; stop?.abort(); stop = undefined }

  function remember(id: string, patch: Launch) {
    if (!launched.has(id) && launched.size >= 256) launched.delete(launched.keys().next().value!)
    launched.set(id, { ...launched.get(id), ...patch })
  }

  // Facts about a command; scripts are judged against the directory the command ran in.
  function factsFor(h: Host, command: string, cwd: string): Promise<Facts | undefined> {
    if (ignores.length) {
      const entry = detect(command)
      if (!entry.path || entry.partial) return Promise.resolve({ scriptStatus: 'ignored', steps: [], omitted: 0 })
    }
    return factsOf(command, cwd, async (path, inlineBody) => {
      const info = await inspect(h, { kind: 'script', path, constructed: inlineBody !== undefined, inlineBody }, cwd, maxBytes, ignores)
      return { body: info.body, ignored: info.ignored || (ignores.length > 0 && info.body === undefined) }
    }, ignores.length > 0).catch(() => undefined)
  }

  async function tailOf(h: Host, path: string | undefined) {
    // Only the file the host itself named for a task, never a path from a command.
    if (!path || !/^\/[^\0]*\/tasks\/[\w-]{1,64}\.output$/.test(path) || path.includes('/../')) return undefined
    try {
      const s = await h.stat(path, { resolve: true })
      if (s.kind !== 'file' || s.isLink !== false || s.realPath !== path || !Number.isSafeInteger(s.size) || s.size < 0) return undefined
      const offset = Math.max(0, s.size - TAIL_BYTES)
      const text = printable(await h.read(path, { as: 'text', offset, length: TAIL_BYTES }))
      // The first bytes of a clipped line may have contained a credential marker.
      return offset ? text.replace(/^[^\n]*(?:\n|$)/, '') : text
    } catch { return undefined }
  }

  async function outputTimes(h: Host, tasks: WaitTask[]) {
    return Promise.all(tasks.map(async t => {
      const path = launched.get(t.id)?.output
      if (!path) return t
      try { const s = await h.stat(path, { resolve: true }); return { ...t, outputAt: s.mtimeMs } } catch { return t }
    }))
  }

  // One model request for everything still pending, built from the task set current now.
  async function summarize(save: (f: (w: Wait) => Wait) => Promise<unknown>, h: Host, signal: AbortSignal) {
    const n = ++attempt, v = version, tasks = pending, wakes = crons
    const sessionCwd = await h.cwd().catch(() => '')
    const now = await h.now()
    const facts = await Promise.all(tasks.map(t =>
      launched.get(t.id)?.facts ?? (t.command ? factsFor(h, t.command, sessionCwd) : Promise.resolve(undefined))))
    if (signal.aborted || v !== version) return
    // Labels from facts first, so the row improves even when the model gives nothing.
    const labels = tasks.map((t, i) => fallbackLabel(t, facts[i]))
    const stale = () => signal.aborted || v !== version
    await save(w => stale() || w.kind !== 'waiting' ? w : { ...w, headline: fallbackHeadline(labels, wakes),
      tasks: w.tasks.map(r => { const i = tasks.findIndex(t => t.id === r.id); return i < 0 ? r : { ...r, label: labels[i]! } }) })

    const inputs: TaskInput[] = []
    for (const [i, t] of tasks.entries()) {
      const f = facts[i]
      const hidden = f?.scriptStatus === 'ignored' || (ignores.length > 0 && f?.scriptStatus !== 'read')
      const tail = hidden ? undefined : await tailOf(h, launched.get(t.id)?.output)
      const started = launched.get(t.id)?.startedAt
      inputs.push({ id: String(i + 1), description: t.description, facts: facts[i],
        output: tail === undefined ? undefined : outputLines(tail, mask),
        runningFor: started === undefined ? undefined : duration(now - started) })
    }
    const wakeups: WakeupInput[] = wakes.map((c, i) => ({ id: `w${i + 1}`, schedule: c.schedule ?? '', prompt: c.prompt }))
    const ids = [...inputs.map(x => x.id), ...wakeups.map(x => x.id)]
    const sent = `#${n} tasks=${tasks.length} wakeups=${wakeups.length} facts=[${facts.map(f =>
      f ? `${f.scriptStatus}:${f.steps.length}` : 'none').join(',')}] model=${model}`
    let reply: Awaited<ReturnType<Host['complete']>>
    if (stale()) return
    try {
      reply = await h.complete({ model, effort: 'low', maxTokens: replyTokens(ids.length), timeoutMs, system: SYSTEM_PROMPT,
        prompt: waitPrompt(inputs, wakeups, lastMessage, language, mask) }, signal)
    } catch (error) {
      h.debug(`summary ${sent} source=fallback reason=request-error (${error instanceof Error ? error.name : 'error'})`)
      return
    }
    if (signal.aborted || v !== version) { h.debug(`summary ${sent} source=fallback reason=stale-task-set`); return }
    if (!reply.isAnswered) { h.debug(`summary ${sent} source=fallback reason=no-answer (${reply.reason})`); return }
    const parsed = parseWait(reply.text, ids)
    const accepted = Object.keys(parsed.tasks).length
    h.debug(`summary ${sent} source=${parsed.headline || accepted ? 'model' : 'fallback'} headline=${parsed.headline ? 'accepted' : 'fallback'} ` +
      `labels=${accepted}/${ids.length}${parsed.problems.length ? ` problems=${parsed.problems.join('; ')}` : ''}`)
    await save(w => stale() || w.kind !== 'waiting' ? w : {
      ...w, headline: parsed.headline ?? w.headline,
      tasks: w.tasks.map(r => {
        const i = tasks.findIndex(t => t.id === r.id)
        const label = i < 0 ? undefined : parsed.tasks[String(i + 1)]
        return label ? { ...r, label } : r
      }),
    })
  }

  on('session.start', ($, e, next) => {
    // A status line from the earlier per-call version would otherwise stay on screen.
    $.ui.status(undefined)
    return next(e)
  })

  // A command went to the background: note when, and learn what it runs while its scripts exist.
  on('classic.PostToolUse', { tool_name: 'Bash' }, async ($, e, next) => {
    const task = (e.tool_response as { backgroundTaskId?: unknown } | null)?.backgroundTaskId
    if (typeof task === 'string' && task.length > 0 && task.length <= 64) {
      try {
        const h = observer($)
        const command = (e.tool_input as { command?: unknown } | null)?.command
        const cwd = typeof e.cwd === 'string' && e.cwd.startsWith('/') ? e.cwd : await h.cwd().catch(() => '')
        const facts = typeof command === 'string' && command.length <= 262144 ? factsFor(h, command, cwd) : undefined
        remember(task, { startedAt: await h.now(), facts })
      } catch { /* Observing never changes the tool result. */ }
    }
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    for (const block of e.message.content) {
      // "Command running in background with ID: x. Output is being written to: /…/tasks/x.output"
      if (e.door === 'tool-result' && e.origin.kind === 'tool' && e.origin.tool === 'Bash' && block.type === 'tool_result') {
        for (const text of texts((block as { content?: unknown }).content)) {
          const id = /\bID: ([\w-]{1,64})\b/.exec(text)?.[1]
          const path = /written to: (\/\S+?\.output)\b/.exec(text)?.[1]
          if (id && path && path.endsWith(`/${id}.output`)) remember(id, { output: path })
        }
      }
      // A finished task: drop it from the row at once, before the agent's next turn redraws.
      if ((e.origin.kind === 'task-notification' || (e.origin.kind === 'engine' && e.message.type === 'user')) && block.type === 'text'
          && typeof block.text === 'string' && block.text.includes('<task-notification>')) {
        const id = tag(block.text, 'task-id')
        if (id && /^(completed|failed|stopped|cancelled|killed)$/.test(tag(block.text, 'status') ?? '') && pending.some(t => t.id === id)) {
          pending = pending.filter(t => t.id !== id); version++
          if (!pending.length && !crons.length) quiet()
          await update($, wait, (w): Wait => {
            if (w.kind !== 'waiting') return w
            const tasks = w.tasks.filter(t => t.id !== id)
            return tasks.length || w.wakeups ? { ...w, tasks, headline: fallbackHeadline(tasks.map(t => t.label), crons) }
              : { kind: 'stopped' }
          })
        }
      }
    }
    return next(e)
  })

  // The agent is working again: its own spinner says so. The next Stop redraws the row.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      quiet(); pending = []; crons = []; version++
      await update($, wait, (): Wait => ({ kind: 'none' }))
    }
    return next(e)
  })

  // The main agent's turn ended. SubagentStop is a separate event, so this is the main loop.
  on('classic.Stop', async ($, e, next) => {
    try {
      quiet()
      const h = observer($)
      const save = (f: (w: Wait) => Wait) => update($, wait, f)
      pending = ((e.background_tasks ?? []) as Background[])
        .filter(t => t && typeof t.id === 'string' && (t.status === 'running' || t.status === 'pending'))
      crons = ((e.session_crons ?? []) as Cron[]).filter(c => c && typeof c.prompt === 'string')
      lastMessage = typeof e.last_assistant_message === 'string' ? e.last_assistant_message : ''
      version++
      const now = await h.now()
      if (!pending.length && !crons.length) {
        await update($, wait, (): Wait => ({ kind: 'stopped' }))
        return next(e)
      }
      const rows: WaitTask[] = pending.map(t => ({ id: t.id, label: fallbackLabel(t), startedAt: launched.get(t.id)?.startedAt ?? now }))
      await update($, wait, (): Wait => ({ kind: 'waiting', headline: fallbackHeadline(rows.map(r => r.label), crons),
        tasks: rows, wakeups: crons.length, since: now, now }))

      // New output or a task ending marks the summary dirty; a refresh runs once the
      // cooldown allows, from the task set current at that moment.
      let inFlight = false, dirty = false, lastSummary = now, ticks = 0, seen = version
      const outputAt = new Map<string, number>()
      const own = stop = new AbortController()
      const run = () => {
        if (inFlight) return
        inFlight = true; dirty = false; seen = version
        h.after(0, async () => {
          try { await summarize(save, h, own.signal) } catch { /* keep the fallback */ }
          finally { inFlight = false }
        })
      }
      run()
      tick = h.every(1000, async () => {
        ticks++
        const at = await h.now()
        let fresh: WaitTask[] | undefined
        if (ticks % 5 === 1) {
          const w = await read($, wait)
          if (w.kind === 'waiting') fresh = await outputTimes(h, w.tasks)
        }
        if (own.signal.aborted) return
        await update($, wait, w => own.signal.aborted || w.kind !== 'waiting' ? w : { ...w, now: at, tasks: fresh
          ? w.tasks.map(t => ({ ...t, outputAt: fresh!.find(f => f.id === t.id)?.outputAt ?? t.outputAt })) : w.tasks })
        for (const t of fresh ?? []) {
          if (t.outputAt === undefined) continue
          if (t.outputAt > (outputAt.get(t.id) ?? now)) dirty = true
          outputAt.set(t.id, t.outputAt)
        }
        if (version !== seen) dirty = true
        if (!own.signal.aborted && dirty && !inFlight && pending.length + crons.length > 0 && at - lastSummary >= RESUMMARIZE_MS) {
          lastSummary = at; run()
        }
      })
    } catch { /* Observing never changes the stop. */ }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.isWorking || e.props.hasSurvey) return next(e)
    const w = await read($, wait)
    if (w.kind === 'none') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    if (w.kind === 'stopped') return <Text color="inactive">○ Stopped — nothing running</Text>

    const times = w.tasks.flatMap(t => t.outputAt === undefined ? [] : [t.outputAt])
    const silent = times.length ? Math.max(0, w.now - Math.max(...times)) : undefined
    const stale = silent !== undefined && silent > STALE_MS
    const count = w.tasks.length + w.wakeups
    const parts = w.tasks.map(t => `${t.label} ${duration(w.now - t.startedAt)}`)
    if (w.wakeups) parts.push(w.wakeups === 1 ? 'wakeup scheduled' : `${w.wakeups} wakeups scheduled`)
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color={stale ? 'warning' : 'success'}>●</Text>
          <Text bold> Waiting {duration(w.now - w.since)}</Text>
          <Text> · {w.headline}</Text>
          {count > 1 ? <Text color="inactive"> ({count} tasks)</Text> : null}
        </Text>
        <Text wrap="truncate-end" color="inactive">
          {'  '}{parts.join(' · ')}
          {silent === undefined ? null : stale
            ? <Text color="warning"> · no output for {ago(silent)}</Text>
            : <Text> · output {ago(silent)} ago</Text>}
        </Text>
      </Box>
    )
  })

  on('session.end', async ($, e, next) => {
    quiet()
    launched.clear(); pending = []; crons = []
    await update($, wait, (): Wait => ({ kind: 'none' }))
    return next(e)
  })
}
