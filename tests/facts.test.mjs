import assert from 'node:assert/strict'
import test from 'node:test'
import {factLabel, factsOf, safeTarget} from '../hooks/facts.ts'
import {outputLines} from '../hooks/summary.ts'

const files = {
  '/w/build.sh': 'NODE_ENV=production npm run build\ndocker build --build-arg NODE_ENV=production -t api .\n',
  '/w/ci.sh': '#!/bin/sh\nRUN_ID=$(\n  gh run list --json databaseId --jq .[0].databaseId\n)\ngh run watch "$RUN_ID"\n',
  '/w/poll.sh': 'until curl -fsS https://api.example.com/health?token=abc; do\n  sleep 10\ndone\nkubectl rollout status deploy/api -n prod\n',
  '/w/sub/x.sh': 'export GH_TOKEN=ghp_secretvalue123\ngh pr checks 42 --watch\nsource ./lib.sh\n',
  '/w/sub/lib.sh': 'helm upgrade api ./chart -n prod\n',
  '/w/timer.sh': 'printf x\ntimeout 100s sleep 200\n',
}
const reader = async path => { const body = files[path.split('/./').join('/')]; return body === undefined ? {} : {body} }
const runs = f => f.steps.map(s => s.run)

test('common wrappers still lead to the entry script', async () => {
  for (const command of ['bash -euo pipefail ci.sh', 'timeout 300 bash ci.sh', 'env X=1 bash ci.sh', "bash -lc 'bash ci.sh'", 'cd /w && bash ci.sh', 'rtk proxy sh ci.sh']) {
    const f = await factsOf(command, '/w', reader)
    assert.equal(f.scriptStatus, 'read', command)
    const watch = f.steps.find(s => s.run === 'gh run watch')
    assert.ok(watch, command)
    assert.equal(watch.waits, true)
    assert.equal(watch.target, '$RUN_ID')
    assert.ok(runs(f).includes('gh run list'), command)
  }
})

test('an assignment no longer hides the command it prefixes', async () => {
  const f = await factsOf('bash build.sh', '/w', reader)
  assert.deepEqual(runs(f), ['npm run build', 'docker build'])
  assert.ok(!JSON.stringify(f).includes('production'))
})

test('credentials in a script never reach the facts, and sourced scripts are followed', async () => {
  const f = await factsOf('cd sub && bash x.sh', '/w', reader)
  assert.ok(!JSON.stringify(f).includes('ghp_secret'))
  assert.ok(runs(f).includes('gh pr checks'))
  assert.ok(runs(f).includes('helm upgrade'))
})

test('a polling loop becomes a repeating step', async () => {
  const f = await factsOf('sh poll.sh', '/w', reader)
  const curl = f.steps.find(s => s.run === 'curl')
  assert.equal(curl.every, '10s')
  assert.equal(curl.waits, true)
  assert.equal(curl.target, 'api.example.com/health')
  assert.ok(!JSON.stringify(f).includes('token=abc'))
  assert.ok(runs(f).includes('kubectl rollout status'))
  assert.ok(!runs(f).includes('sleep'))
})

test('script status says why a script was not analyzed', async () => {
  assert.equal((await factsOf('bash $DIR/x.sh', '/w', reader)).scriptStatus, 'dynamic')
  assert.equal((await factsOf('bash missing.sh', '/w', reader)).scriptStatus, 'unavailable')
  assert.equal((await factsOf('bash ci.sh', '/w', async () => ({ignored: true}))).scriptStatus, 'ignored')
  assert.equal((await factsOf('gh pr checks 7 --watch --repo acme/web', '/w', reader)).scriptStatus, 'inline')
})

test('a script written by the same command is analyzed without touching the disk', async () => {
  const command = "cat > /tmp/d/t.sh <<'EOF'\ngh run watch 99\nEOF\nsh /tmp/d/t.sh"
  const f = await factsOf(command, '/w', async (path, body) => {
    assert.equal(path, '/tmp/d/t.sh'); assert.equal(body, 'gh run watch 99\n'); return {body}
  })
  assert.equal(f.scriptStatus, 'read')
  assert.deepEqual(runs(f), ['gh run watch'])
})

test('a timeout around a sleep reads as a timer with its limit', async () => {
  const f = await factsOf('sh timer.sh', '/w', reader)
  assert.deepEqual(f.steps.map(s => [s.run, s.limit, s.waits]), [['sleep', '100s', true]])
  assert.equal(factLabel(f), 'Timer 100s')
})

test('flag values are dropped', async () => {
  const f = await factsOf('npm test -- --token=ghp_abcdefgh', '/w', reader)
  assert.deepEqual(runs(f), ['npm test'])
  assert.ok(!JSON.stringify(f).includes('ghp_'))
})

test('output keeps the newest meaningful lines', () => {
  const text = '[####----] 40%\nstep 1/9\nstep 2/9\nstep 3/9\nAuthorization: Bearer xyz\n✓ build 2m\n|||||\n* deploy (ID 123)\n'
  assert.deepEqual(outputLines(text), ['step 3/9', '[line withheld: possible credential]', '✓ build 2m', '* deploy (ID 123)'])
  assert.equal(outputLines('Authorization: Bearer xyz', false)[0], 'Authorization: Bearer xyz')
})

test('only identifiers survive as targets', () => {
  assert.equal(safeTarget('https://u:p@host.example.com/a/b?token=x'), 'host.example.com/a/b')
  assert.equal(safeTarget('$RUN_ID'), '$RUN_ID')
  assert.equal(safeTarget('$GH_TOKEN'), undefined)
  assert.equal(safeTarget('ghp_abcdefgh1'), undefined)
})

test('literal script text or credential arguments do not become operation names, targets or durations', async () => {
  for (const cmd of ['curl --api-key private-marker https://example.test', 'npm run ghp_private-marker',
    'watch -n private-marker gh pr checks 1', 'timeout private-marker sleep 10', 'python -m "print(private-marker)"',
    'node -e private-marker', 'node -p private-marker', '"program private-marker"', 'curl https://ghp_private-marker.test/health']) {
    assert.doesNotMatch(JSON.stringify(await factsOf(cmd, '/w', reader)), /private-marker/, cmd)
  }
})

test('inline bodies pass through the same path policy and bounded recursion as files', async () => {
  const cmd = "cat > /w/private.sh <<'END'\nsh /w/private.sh\nEND\nsh /w/private.sh"
  const denied = await factsOf(cmd, '/w', async () => ({ignored: true}))
  assert.deepEqual(denied, {scriptStatus: 'ignored', steps: [], omitted: 0})
  let reads = 0
  await factsOf(cmd, '/w', async (_, body) => { reads++; return {body} })
  assert.ok(reads > 0 && reads <= 3)
})

test('the manual examples have meaningful labels without script source or a model', async () => {
  const {readFile} = await import('node:fs/promises')
  for (const [name, label] of [['wait-100s', 'Timer 100s'], ['sample-b', 'Markdown heading count README.md'], ['sample-c', 'Manifest version read plugin.json']]) {
    const body = await readFile(new URL(`./manual/${name}.sh`, import.meta.url), 'utf8')
    const f = await factsOf(`sh ${name}.sh`, '/w', async () => ({body}))
    assert.equal(factLabel(f), label)
    assert.doesNotMatch(JSON.stringify(f), /require\(|#!\/bin\/sh|printf/)
  }
})

test('the readiness guard is the awaited condition; sleep is only its cadence', async () => {
  for (const [guard, condition] of [
    ['while [ ! -f /tmp/build.ready ]', 'regular file exists'],
    ['until test -e /tmp/build.ready', 'path exists'],
    ['while ! [[ -d /tmp/build.ready ]]', 'directory exists'],
    ['while test -e /tmp/build.ready', 'path absent'],
    ['until [ ! -d /tmp/build.ready ]', 'directory absent'],
  ]) {
    const f = await factsOf(`${guard}; do sleep 5; done`, '/w', reader)
    assert.deepEqual(f.steps, [{run: 'test', category: 'file wait', condition, target: 'build.ready', waits: true, every: '5s'}])
    assert.match(factLabel(f), condition.endsWith('absent') ? /build.ready to disappear/ : /build.ready to appear/)
    assert.doesNotMatch(JSON.stringify(f), /\/tmp\//)
  }
  const complex = await factsOf('while [ ! -f /tmp/a ] && [ ! -f /tmp/b ]; do sleep 5; done', '/w', reader)
  assert.equal(complex.partial, true)
  assert.equal(complex.steps[0].category, 'polling loop')
  assert.equal(complex.steps[0].condition, undefined)
})

test('function bodies are traversed only on a direct call, in declaration order', async () => {
  const definition = "unused() {\n printf '%s' '}';\n sh ci.sh;\n}\n"
  const opened = []
  const read = async path => { opened.push(path); return reader(path) }
  const f = await factsOf(definition + 'sleep 200', '/w', read)
  assert.equal(factLabel(f), 'Timer 200s')
  assert.deepEqual(opened, [])
  const called = await factsOf(definition + 'unused', '/w', read)
  assert.deepEqual(opened, ['/w/ci.sh'])
  assert.ok(runs(called).includes('gh run watch'))
  const double = await factsOf('f() { sleep 1; }; f; function f { sleep 2; }; f', '/w', reader)
  assert.deepEqual(double.steps.map(s => s.target), ['1s', '2s'])
  const recursive = await factsOf('again() { again; }; again; sleep 10', '/w', reader)
  assert.equal(recursive.partial, true)
  assert.equal(factLabel(recursive), 'Timer 10s')
  const unsupported = await factsOf('f() if true; then gh run watch 42; fi', '/w', reader)
  assert.equal(unsupported.partial, true)
  assert.deepEqual(unsupported.steps, [])
})

test('child shell directory and functions are isolated; sourced and called functions share the caller', async () => {
  const scripts = {'/w/first.sh': 'cd sub\nhelper() { sleep 72; }', '/w/second.sh': 'npm test', '/w/sub/second.sh': 'npm run build'}
  for (const [prefix, shared] of [['bash first.sh', false], ['. first.sh', true], ["sh -c '. first.sh'", false],
    ['( . first.sh )', false], ['f() ( . first.sh ); f', false], ['f() { . first.sh; }; f', true]]) {
    const opened = []
    const f = await factsOf(`${prefix}\nsh second.sh\nhelper`, '/w', async path => { opened.push(path); return {body:scripts[path]} })
    assert.deepEqual(opened, ['/w/first.sh', shared ? '/w/sub/second.sh' : '/w/second.sh'], prefix)
    assert.equal(runs(f).includes('sleep'), shared, prefix)
    assert.ok(runs(f).includes(shared ? 'npm run build' : 'npm test'), prefix)
  }
})

test('a computed cd does not cause script reads at a guessed directory', async () => {
  const opened = []
  const f = await factsOf('cd "$DIR"; sh ci.sh', '/w', async p => { opened.push(p); return reader(p) })
  assert.deepEqual(opened, [])
  assert.equal(f.partial, true)
  assert.equal(f.scriptStatus, 'dynamic')
})
