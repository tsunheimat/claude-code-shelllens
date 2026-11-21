import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, open, realpath, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detect, inspect } from '../hooks/inspect.ts'

test('reads a real script in the working directory without running it', async t => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'shell-insight-'))
  t.after(() => rm(dir, {recursive:true, force:true}))
  const path = join(dir, 'build steps.sh'), marker = join(dir, 'unexpected')
  const body = `#!/bin/sh\ntouch '${marker}'\nnpm run build\nnpm test\n`
  await writeFile(path, body, {mode:0o700})
  const fs = {
    async stat(p) {
      const s = await lstat(p)
      return {kind:s.isFile() ? 'file' : 'other', size:s.size, mtimeMs:s.mtimeMs,
        isLink:s.isSymbolicLink(), realPath:await realpath(p)}
    },
    async read(p, {length, offset}) {
      const handle = await open(p, 'r')
      try {
        const buffer = Buffer.alloc(length)
        const {bytesRead} = await handle.read(buffer, 0, length, offset)
        return buffer.toString('utf8', 0, bytesRead)
      } finally { await handle.close() }
    },
  }
  const entry = detect('rtk proxy bash "./build steps.sh"')
  assert.deepEqual(await inspect(fs, entry, dir, 65536, []), {body})
  await assert.rejects(access(marker), {code:'ENOENT'})
})
