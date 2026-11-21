import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const response = { stdout: '', stderr: '', interrupted: false }
const scripts: Record<string, string> = {
  '/workspace/ci.sh': '#!/bin/sh\nexport GH_TOKEN=private-test-marker\ngh run watch 1234\n',
  '/workspace/image.sh': '#!/bin/sh\ndocker build -t api .\n',
  '/workspace/tests.sh': '#!/bin/sh\nnpm test\n',
}
const outputs: Record<string, string> = {
  '/claude/tasks/t1.output': 'build: step 4/9\nAuthorization: Bearer leaked-output-marker\nbuild: step 5/9\n',
  '/claude/tasks/t2.output': '#5 [api 3/7] RUN npm ci\n',
  '/claude/tasks/t3.output': 'PASS src/a.test.ts\n',
}
const TASKS = [
  { id: 't1', command: 'bash ci.sh', description: 'Run sample A' },
  { id: 't2', command: 'bash image.sh', description: 'Run sample B' },
  { id: 't3', command: 'bash tests.sh', description: 'Run sample C' },
]
const BAND = {
  plugin: 'shell-insight', component: 'AbovePrompt', requestId: 'band', surface: 'terminal',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false as boolean, maxRows: 10, bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

type Reply = { text?: string; delay?: number }

function host(on: On, reply: Reply = {}) {
  const clock = mock.clock(on)
  const prompts: string[] = []
  const statuses: (string | undefined)[] = []
  const mtimes: Record<string, number> = {}
  const reads: string[] = []
  const files = { ...scripts, ...outputs }
  on('session.cwd', () => ({ value: '/workspace' }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_, e) => { statuses.push(e.text); return { value: undefined } })
  on('fs.stat', (_, e) => {
    const body = files[e.path]
    if (body === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file', size: body.length, mtimeMs: mtimes[e.path] ?? 0, isLink: false, realPath: e.path } }
  })
  on('fs.read', (_, e) => {
    reads.push(e.path)
    const body = files[e.path] ?? ''
    return { value: body.slice(e.offset ?? 0, (e.offset ?? 0) + (e.length ?? body.length)) }
  })
  on('model.complete', async (_, e) => {
    prompts.push(e.prompt)
    if (reply.delay) await clock.sleep(reply.delay)
    if (reply.text === undefined) return { value: { isAnswered: false, reason: 'empty-reply', usage } }
    return { value: { isAnswered: true, text: reply.text, usage } }
  })
  on('tool.call', () => ({ result: response }))
  on('classic.PostToolUse', () => ({}))
  on('classic.Stop', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  return { clock, prompts, statuses, mtimes, reads, files }
}

async function launch($: Engine, h: ReturnType<typeof host>, n = 3) {
  for (const t of TASKS.slice(0, n)) {
    const input = { command: t.command, description: t.description, run_in_background: true }
    await $.tool.call({ tool: 'Bash', tool_use_id: `use-${t.id}`, ...input })
    await $.classic.PostToolUse({ tool_name: 'Bash', tool_use_id: `use-${t.id}`, cwd: '/workspace', tool_input: input,
      tool_response: { ...response, backgroundTaskId: t.id } })
    await $.session.append({ door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: `row-${t.id}`,
      message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: `use-${t.id}`,
        content: `Command running in background with ID: ${t.id}. Output is being written to: /claude/tasks/${t.id}.output. You will be notified.` }] } })
    h.mtimes[`/claude/tasks/${t.id}.output`] = h.clock.now()
  }
}

function stop($: Engine, n = 3, crons: { prompt: string }[] = []) {
  return $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'Started the CI watch, image build and tests.',
    background_tasks: TASKS.slice(0, n).map(t => ({ ...t, type: 'shell', status: 'running' })),
    session_crons: crons.map((c, i) => ({ id: `c${i}`, schedule: '*/5 * * * *', recurring: true, ...c })),
  } as never)
}

function finish($: Engine, id: string, kind: 'task-notification' | 'engine' = 'task-notification') {
  return $.session.append({ door: 'queue', origin: { kind }, uuid: `done-${id}`, message: { type: 'user', content: [{
    type: 'text', text: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` }] } })
}

const payload = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))

const lines = async ($: Engine, props: Partial<typeof BAND.props> = {}) => {
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props } })
  const all = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  // Rows only: a Text nested in another Text is part of its row.
  return all.filter((a: { text: string }) => !all.some((b: { text: string }) => b !== a && b.text.length > a.text.length && b.text.includes(a.text)))
}

test('says nothing while the agent works: no row, no status line, no model call', async ($, on) => {
  const h = host(on, { text: '{}' })
  await launch($, h)
  await h.clock.advance(5000)
  expect(h.prompts).toHaveLength(0)
  expect(h.statuses.filter(s => s !== undefined)).toHaveLength(0)
  expect(await lines($)).toHaveLength(0)
  await stop($)
  await h.clock.advance(100)
  // The row stays out of the way during a later turn, too.
  expect(await lines($, { isWorking: true })).toHaveLength(0)
})

test('three scripts read as one goal, from their scripts and recent output, in one request', async ($, on) => {
  const h = host(on, { text: '{"headline":"CI run, API image and unit tests","tasks":["CI run watch","API image build","Unit tests"]}' })
  await launch($, h)
  await h.clock.advance(40000)
  await stop($)
  await h.clock.advance(1000)
  expect(h.prompts).toHaveLength(1)
  const prompt = JSON.stringify(payload(h.prompts[0]!))
  for (const seen of ['gh run watch', 'docker build', 'npm test', 'build: step 5/9', 'RUN npm ci', 'PASS src/a.test.ts'])
    expect(prompt).toContain(seen)
  expect(prompt).not.toContain('private-test-marker')
  expect(prompt).not.toContain('leaked-output-marker')

  await h.clock.advance(2000)
  const [head, detail] = await lines($)
  expect(head?.text).toMatch(/^● Waiting 0:0[23] · CI run, API image and unit tests \(3 tasks\)$/)
  expect(head?.text).not.toContain('Run sample')
  expect(detail?.text).toMatch(/CI run watch 0:4\d · API image build 0:4\d · Unit tests 0:4\d · output \d+s ago/)
})

test('without a model answer generic descriptions improve from local facts', async ($, on) => {
  const h = host(on)
  await launch($, h, 1)
  await stop($, 1)
  await h.clock.advance(1500)
  const [head, detail] = await lines($)
  expect(head?.text).toMatch(/^● Waiting 0:01 · CI run watch 1234$/)
  expect(detail?.text).toMatch(/^ {2}CI run watch 1234 0:01/)
})

test('a malformed or unsafe reply keeps the fallback', async ($, on) => {
  const h = host(on, { text: '{"headline":"`rm -rf` <b>x</b>","tasks":["TOKEN=abc","$(y)","**z**"]}' })
  await launch($, h)
  await stop($)
  await h.clock.advance(1500)
  const [head] = await lines($)
  expect(head?.text).toMatch(/CI run watch 1234 and Container image build.* and Tests/)
  expect(head?.text).not.toContain('rm -rf')
})

test('stopped with nothing running says so, dimmed', async ($, on) => {
  host(on)
  await stop($, 0)
  const [line] = await lines($)
  expect(line?.text).toBe('○ Stopped — nothing running')
  expect(line?.props.color).toBe('inactive')
})

test('the dot is green while output flows and yellow after two quiet minutes', async ($, on) => {
  const h = host(on)
  await launch($, h, 1)
  await stop($, 1)
  await h.clock.advance(3000)
  let [head, detail] = await lines($)
  expect(head?.text.startsWith('●')).toBe(true)
  expect(JSON.stringify(head)).toContain('"success"')
  expect(detail?.text).toMatch(/output \d+s ago/)
  await h.clock.advance(3 * 60 * 1000)
  ;[head, detail] = await lines($)
  expect(JSON.stringify(head)).toContain('"warning"')
  expect(detail?.text).toContain('no output for 3m')
})

test('a finished task leaves the row at once, and the next turn hides it', async ($, on) => {
  const h = host(on, { text: '{"headline":"CI and image","tasks":["CI","Image"]}' })
  await launch($, h, 2)
  await stop($, 2)
  await h.clock.advance(1000)
  await finish($, 't1', 'engine')
  const [headline, detail] = await lines($)
  expect(headline?.text).not.toContain('CI')
  expect(detail?.text).not.toContain('CI ')
  expect(detail?.text).toContain('Image')
  await $.turn.start({ text: 'notification', turnId: 'next' })
  expect(await lines($)).toHaveLength(0)
})

test('a scheduled wakeup counts as waiting', async ($, on) => {
  const h = host(on)
  await stop($, 0, [{ prompt: 'check the deploy pipeline' }])
  await h.clock.advance(1000)
  const [head, detail] = await lines($)
  expect(head?.text).toContain('Waiting')
  expect(detail?.text).toContain('wakeup scheduled')
  expect(h.prompts[0]).toContain('check the deploy pipeline')
})

test('ignored tasks contribute neither file contents nor output, even with masking off',
  { options: { ignorePaths: 'ci.sh', redactSecrets: false } }, async ($, on) => {
    const h = host(on)
    h.files['/workspace/image.sh'] = 'docker build -t api .\nsource ci.sh\n'
    await launch($, h)
    await stop($)
    await h.clock.advance(2000)
    const [a, b, c] = payload(h.prompts[0]!).tasks
    for (const task of [a, b]) {
      expect(task.scriptStatus).toBe('ignored')
      expect(task.steps).toHaveLength(0)
      expect(task.recentOutput).toHaveLength(0)
      expect(task.script).toBe(undefined)
    }
    for (const path of ['/workspace/ci.sh', '/claude/tasks/t1.output', '/claude/tasks/t2.output']) expect(h.reads).not.toContain(path)
    expect(c.recentOutput).toContain('PASS src/a.test.ts')
  })

test('a single output change during cooldown is summarized once even if output then stops', async ($, on) => {
  const h = host(on)
  await launch($, h, 1)
  await stop($, 1)
  await h.clock.advance(100)
  h.files['/claude/tasks/t1.output'] = 'package stage now running\n'
  h.mtimes['/claude/tasks/t1.output'] = h.clock.now()
  await h.clock.advance(59000)
  expect(h.prompts).toHaveLength(1)
  await h.clock.advance(2000)
  expect(h.prompts).toHaveLength(2)
  expect(payload(h.prompts[1]!).tasks[0].recentOutput).toContain('package stage now running')
  await h.clock.advance(65000)
  expect(h.prompts).toHaveLength(2)
})

test('keep accepted purpose wording during and after an unsuccessful refresh; accept later fields independently', async ($, on) => {
  const reply: Reply = { text: '{"headline":"Release checks before deployment","tasks":{"1":"Release pipeline checks"}}' }
  const h = host(on, reply)
  await launch($, h, 1)
  await stop($, 1)
  await h.clock.advance(2000)
  const check = async (headline: string, label: string) => {
    const [head, detail] = await lines($)
    expect(head?.text).toContain(headline)
    expect(detail?.text).toContain(label)
  }
  await check('Release checks before deployment', 'Release pipeline checks')

  delete reply.text
  reply.delay = 5000
  h.mtimes['/claude/tasks/t1.output'] = h.clock.now()
  await h.clock.advance(59000)
  expect(h.prompts).toHaveLength(2)
  await check('Release checks before deployment', 'Release pipeline checks')
  await h.clock.advance(6000)
  await check('Release checks before deployment', 'Release pipeline checks')

  reply.delay = 0
  reply.text = '{"headline":"CI has completed","tasks":{"1":"Release workflow validation"}}'
  h.mtimes['/claude/tasks/t1.output'] = h.clock.now()
  await h.clock.advance(60000)
  expect(h.prompts).toHaveLength(3)
  await check('Release checks before deployment', 'Release workflow validation')

  reply.text = '{"headline":"Deployment gate checks","tasks":{"1":"TOKEN=abc"}}'
  h.mtimes['/claude/tasks/t1.output'] = h.clock.now()
  await h.clock.advance(60000)
  expect(h.prompts).toHaveLength(4)
  await check('Deployment gate checks', 'Release workflow validation')
})

test('a failed refresh retains only surviving labels and never restores the old combined headline', async ($, on) => {
  const reply: Reply = { text: '{"headline":"CI checks and image preparation","tasks":{"1":"Workflow checks","2":"API packaging"}}' }
  const h = host(on, reply)
  await launch($, h, 2)
  await stop($, 2)
  await h.clock.advance(2000)
  expect((await lines($))[0]?.text).toContain('CI checks and image preparation')
  await finish($, 't1')
  delete reply.text
  await h.clock.advance(61000)
  expect(h.prompts).toHaveLength(2)
  const [head, detail] = await lines($)
  expect(head?.text).toContain('API packaging')
  expect(head?.text).not.toContain('CI checks')
  expect(detail?.text).toContain('API packaging')
  expect(detail?.text).not.toContain('Workflow checks')
})

test('discard an in-flight answer for finished work and refresh only the surviving task', async ($, on) => {
  const h = host(on, { text: '{"headline":"Obsolete CI goal","tasks":["Old CI","Old image"]}', delay: 5000 })
  await launch($, h, 2)
  await stop($, 2)
  await h.clock.advance(100)
  expect(h.prompts).toHaveLength(1)
  await finish($, 't1')
  await h.clock.advance(5500)
  const [head] = await lines($)
  expect(head?.text).toContain('Container image build')
  expect(head?.text).not.toContain('CI')
  await h.clock.advance(55000)
  expect(h.prompts).toHaveLength(2)
  const tasks = payload(h.prompts[1]!).tasks
  expect(tasks).toHaveLength(1)
  expect(tasks[0].script).toBe('image.sh')
})

test('the last task ending becomes idle and a late answer cannot restart the row', async ($, on) => {
  const h = host(on, { text: '{"headline":"Old CI goal","tasks":["Old CI"]}', delay: 5000 })
  await launch($, h, 1)
  await stop($, 1)
  await h.clock.advance(100)
  await finish($, 't1')
  expect((await lines($))[0]?.text).toBe('○ Stopped — nothing running')
  await h.clock.advance(65000)
  expect((await lines($))[0]?.text).toBe('○ Stopped — nothing running')
  expect(h.prompts).toHaveLength(1)
})

test('an answer that arrives after the agent resumed is dropped', async ($, on) => {
  const h = host(on, { text: '{"headline":"Late","tasks":["x"]}', delay: 5000 })
  await launch($, h, 1)
  await stop($, 1)
  await h.clock.advance(100)
  await $.turn.start({ text: 'go on', turnId: 'next' })
  await h.clock.advance(6000)
  expect(await lines($)).toHaveLength(0)
})

test('disabled leaves everything alone', { options: { enabled: false } }, async ($, on) => {
  const h = host(on, { text: '{}' })
  await launch($, h)
  await stop($)
  await h.clock.advance(3000)
  expect(h.prompts).toHaveLength(0)
  expect(await lines($)).toHaveLength(0)
})
