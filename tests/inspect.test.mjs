import test from 'node:test'
import assert from 'node:assert/strict'
import { detect, inspect } from '../hooks/inspect.ts'

const cwd = '/work/project'
function fixture(body = 'npm run build\nnpm test\n', specs = []) {
  const reads = [], stats = []
  const bytes = Buffer.from(body)
  const fs = {
    async stat(path, opts) {
      assert.deepEqual(opts, { resolve: true })
      const spec = specs[stats.length]
      stats.push(path)
      if (spec instanceof Error) throw spec
      return { kind: 'file', realPath: path, isLink: false, size: bytes.length, mtimeMs: 1, ...spec }
    },
    async read(path, opts) {
      reads.push({ path, ...opts })
      assert.equal(opts.as, 'text')
      assert.equal(opts.offset, 0)
      assert.ok(Number.isSafeInteger(opts.length))
      return bytes.subarray(0, opts.length).toString()
    },
  }
  return { fs, reads, stats }
}

test('recognizes literal shell invocations, safe flags and quoted paths', () => {
  for (const [command, path] of [
    ['bash /tmp/build.sh', '/tmp/build.sh'], ['sh /tmp/build.sh', '/tmp/build.sh'],
    ['bash --noprofile --norc ./x.sh', './x.sh'],
    ['/bin/bash -eux -- "/tmp/build x.sh" arg', '/tmp/build x.sh'],
    ["./scripts/'test runner'.sh", './scripts/test runner.sh'], ['scripts/build', 'scripts/build'],
    ['bash test\\ runner.sh # only a comment', 'test runner.sh'],
  ]) assert.deepEqual(detect(command), { kind: 'script', path }, command)
  assert.deepEqual(detect('bash a.sh && sh b.sh'), { kind: 'script', path: 'a.sh', partial: true })
  assert.equal(detect('bash a.sh # first\nsh b.sh').partial, true)
  assert.deepEqual(detect('npm test'), { kind: 'inline' })
})

test('does not guess a script from an argument, expansion, option value, or changed cwd', async () => {
  const { fs, reads, stats } = fixture()
  for (const command of ['cat ./build.sh', 'cd elsewhere && bash build.sh', "bash -c 'sh b.sh'",
    'sh -s build.sh', 'bash --rcfile opts.sh', 'bash ../build.sh', 'bash "$DIR/build.sh"',
    'bash /tmp/*.sh', "bash '/tmp/unclosed.sh", 'bash x.sh >x.sh', 'bash $(pwd)/x.sh',
    './build.sh'.repeat(40000)]) {
    const entry = detect(command)
    assert.equal(entry.path, undefined, command.slice(0, 60))
    await inspect(fs, entry, cwd, 1024, [])
  }
  assert.deepEqual([stats, reads], [[], []])
})

test('reads the actual entry with an explicit byte range and checks placement again', async () => {
  for (const [command, resolved] of [['bash /tmp/build.sh', '/tmp/build.sh'], ['sh "./release tasks/test.sh"', '/work/project/release tasks/test.sh']]) {
    const body = 'npm run build\nnpm test\n# \u{1f680}\n'
    const { fs, stats, reads } = fixture(body)
    assert.deepEqual(await inspect(fs, detect(command), cwd, Buffer.byteLength(body), []), { body })
    assert.deepEqual(stats, [resolved, resolved])
    assert.deepEqual(reads, [{ path: resolved, as: 'text', offset: 0, length: Buffer.byteLength(body) + 1 }])
  }
})

test('quoted heredoc is inspected from the command, never from a previous file', async () => {
  const { fs, reads, stats } = fixture('stale')
  for (const header of ["cat > '/tmp/run x.sh' <<'E'", 'cat <<"E" > "/tmp/run x.sh"']) {
    const command = header + "\nls -la\nE\nsh '/tmp/run x.sh'"
    const entry = detect(command)
    assert.equal(entry.constructed, true)
    assert.deepEqual(await inspect(fs, entry, cwd, 8, []), { body: 'ls -la\n' })
    assert.deepEqual(await inspect(fs, entry, cwd, 3, []), { unavailable: true })
    assert.deepEqual(await inspect(fs, entry, cwd, 8, ['/tmp/run x.sh']), { ignored: true })
    for (const uncertain of [command.replace(/<<['"]E['"]/, '<<E'), command.replace('sh \'/tmp/run x.sh\'', 'sh /tmp/b.sh')]) {
      assert.deepEqual(await inspect(fs, detect(uncertain), cwd, 8, []), { unavailable: true })
      assert.deepEqual(await inspect(fs, detect(uncertain), cwd, 8, ['/tmp']), { ignored: true })
    }
  }
  assert.deepEqual([stats, reads], [[], []])
})

test('literal ignores apply to exact file or subtree before host access', async () => {
  for (const rule of ['build/x.sh', './build/', '/work/project/build', '/', '*.sh']) {
    const { fs, reads, stats } = fixture()
    assert.deepEqual(await inspect(fs, detect('sh build/x.sh'), cwd, 256, [rule]), { ignored: true }, rule)
    assert.deepEqual([reads, stats], [[], []])
  }
  assert.ok((await inspect(fixture().fs, detect('sh builds/x.sh'), cwd, 256, ['build'])).body)
})

test('unrelated files and unsafe path scopes are never probed', async () => {
  for (const name of ['/dev/tty', '/etc/config.sh', '/work/project2/x.sh', '/tmp/other-session/x.sh',
    '/tmp/archive', 'private.json', './credentials.sh', './secrets/snapshot.sh', '.config/x.sh',
    'a/../x.sh', '//server/test.sh', 'a.sh/', 'dir/.', './.env']) {
    const { fs, stats, reads } = fixture()
    assert.deepEqual(await inspect(fs, { kind: 'script', path: name }, cwd, 256, []), { unavailable: true }, name)
    assert.deepEqual([reads, stats], [[], []])
  }
})

test('fails closed before body read on stat, size and symlink failures', async () => {
  for (const spec of [new Error('ENOENT'), { isLink: true }, { realPath: '/tmp/moved.sh' },
    { realPath: undefined }, { kind: 'other' }, { kind: 'dir' }, { size: -1 }, { size: 129 }]) {
    const { fs, reads } = fixture('echo ok', [spec])
    assert.deepEqual(await inspect(fs, detect('bash x.sh'), cwd, 128, []), { unavailable: true })
    assert.deepEqual(reads, [])
  }
})

test('discards binary, invalid text, other interpreters, denied and unstable reads', async () => {
  const no = { unavailable: true }
  const entry = detect('bash x.sh')
  for (const body of [Buffer.from([0xc3, 0x28]), 'hi\0there', '#!/usr/bin/python\nprint(5)']) {
    assert.deepEqual(await inspect(fixture(body).fs, entry, cwd, 1024, []), no)
  }
  for (const change of [{ isLink: true }, { mtimeMs: 2 }, { size: 512 }, { realPath: '/elsewhere' }]) {
    assert.deepEqual(await inspect(fixture('ok', [{}, change]).fs, entry, cwd, 1024, []), no)
  }
  assert.deepEqual(await inspect(fixture('grew', [{ size: 2 }]).fs, entry, cwd, 1024, []), no)
  const { fs } = fixture()
  fs.read = async () => { throw new Error('EACCES') }
  assert.deepEqual(await inspect(fs, entry, cwd, 1024, []), no)
})

test('extensionless direct executables require a shell shebang before a full read', async () => {
  const entry = detect('./build')
  const body = '#!/usr/bin/env bash\nnpm test\n'
  assert.deepEqual(await inspect(fixture(body).fs, entry, cwd, 4096, []), { body })
  const { fs, reads } = fixture('#!/usr/bin/python\n' + 'x'.repeat(512))
  assert.deepEqual(await inspect(fs, entry, cwd, 4096, []), { unavailable: true })
  assert.deepEqual(reads.map(r => r.length), [128])
})
