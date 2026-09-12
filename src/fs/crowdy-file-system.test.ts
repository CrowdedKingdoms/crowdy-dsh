/**
 * Behavioral tests for the Crowdy Studio filesystem backend.
 *
 * The backend is exercised through a fake API client, so these assert the
 * contract the harness relies on — target identity, listing, guarded writes,
 * literal edits, and the conflict vocabulary — without a running game API.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'

import { CrowdyApiError } from '../crowdy/client.js'
import type { CrowdyProject, CrowdyProjectFile, CrowdyTarget } from '../crowdy/client.js'
import { CrowdyFileSystem, versionOf } from './crowdy-file-system.js'

const ROOT = '/mnt/crowdy'

function file(
  target: CrowdyTarget,
  path: string,
  content: string,
  revision = '1',
): CrowdyProjectFile {
  return { target, path, content, revision, updatedAt: '2026-01-01T00:00:00Z' }
}

/** A fake Crowdy Studio API holding one project in memory. */
class FakeApi {
  saves: Array<{ expectedRevision: string; upserts?: unknown[]; deletes?: unknown[] }> = []
  loads = 0
  /** When set, the next save rejects with a revision conflict. */
  conflictOnNextSave = false

  tokens: Array<string | undefined> = []

  constructor(private project: CrowdyProject) {}

  setToken(token: string | undefined): void {
    this.tokens.push(token)
  }

  async loadProject(): Promise<CrowdyProject> {
    this.loads += 1
    return structuredClone(this.project)
  }

  async saveFiles(args: {
    projectId: string
    expectedRevision: string
    upserts?: Array<{ target: CrowdyTarget; path: string; content: string }>
    deletes?: Array<{ target: CrowdyTarget; path: string }>
  }): Promise<CrowdyProject> {
    this.saves.push(args)

    if (this.conflictOnNextSave) {
      this.conflictOnNextSave = false
      throw new CrowdyApiError(
        'CROWDY_STUDIO_REVISION_CONFLICT: expected project revision 1; current revision is 4.',
        'CROWDY_STUDIO_REVISION_CONFLICT',
      )
    }
    if (args.expectedRevision !== this.project.revision) {
      throw new CrowdyApiError('stale', 'CROWDY_STUDIO_REVISION_CONFLICT')
    }

    for (const upsert of args.upserts ?? []) {
      const existing = this.project.files.find(
        (entry) => entry.target === upsert.target && entry.path === upsert.path,
      )
      if (existing) existing.content = upsert.content
      else this.project.files.push(file(upsert.target, upsert.path, upsert.content))
    }
    for (const remove of args.deletes ?? []) {
      this.project.files = this.project.files.filter(
        (entry) => !(entry.target === remove.target && entry.path === remove.path),
      )
    }
    this.project.revision = String(BigInt(this.project.revision) + 1n)
    return structuredClone(this.project)
  }
}

function harness(files: CrowdyProjectFile[] = []) {
  const project: CrowdyProject = {
    projectId: 'proj-1',
    appId: '2',
    ownerUserId: '7',
    name: 'Test',
    revision: '1',
    archived: false,
    files,
    updatedAt: '2026-01-01T00:00:00Z',
  }
  const api = new FakeApi(project)
  const ctx = new Context()
  const fs = new CrowdyFileSystem(ctx, {
    graphqlUrl: 'http://localhost:3000/graphql',
    appId: '2',
    projectId: 'proj-1',
    root: ROOT,
    appToken: 'token',
    githubFirst: false,
    // Reads must not be served from a stale snapshot across assertions.
    snapshotTtlMs: 0,
  })
  fs.client = api as unknown as CrowdyFileSystem['client']
  return { fs, api, project }
}

const sha = (text: string) => String(versionOf(text))

describe('CrowdyFileSystem', () => {
  describe('mounting', () => {
    it('registers as ctx.fs when loaded as a Cordis plugin', async () => {
      const ctx = new Context()
      const fiber = await ctx.plugin(CrowdyFileSystem, {
        appId: '2',
        projectId: 'proj-1',
        root: ROOT,
      })

      assert.ok(ctx.fs instanceof CrowdyFileSystem, 'the harness filesystem seam is occupied')
      // Schemastery defaults must survive the plugin boundary.
      assert.equal((ctx.fs as CrowdyFileSystem).boot.graphqlUrl, 'http://localhost:3000/graphql')
      await fiber.dispose()
    })

    it('waits for the token the page sends over the bridge before the first load', async () => {
      const { api, project } = harness([file('SERVER', 'src/main.rs', 'fn main() {}')])
      // Other harnesses in this process published their token to the
      // environment, as the browser backend does; a fresh worker starts clean.
      delete process.env.CROWDY_APP_TOKEN
      const ctx = new Context()
      const fs = new CrowdyFileSystem(ctx, {
        graphqlUrl: 'http://localhost:3000/graphql',
        appId: '2',
        projectId: 'proj-1',
        root: ROOT,
        bridgeChannel: 'crowdy-dsh:test',
        bridgeNonce: 'n1',
        githubFirst: false,
        snapshotTtlMs: 0,
      })
      fs.client = api as unknown as CrowdyFileSystem['client']
      assert.equal(fs.hasCredentials, false)
      assert.equal(fs.boot.appToken, undefined, 'no token rides in the boot config')
      const read = fs.readText(await fs.resolve(`${ROOT}/server/src/main.rs`))
      let settled = false
      void read.then(() => (settled = true), () => (settled = true))
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(settled, false, 'the read is parked until the token arrives')
      fs.setToken('page-token')
      assert.equal(await read, 'fn main() {}')
      assert.equal(process.env.CROWDY_APP_TOKEN, 'page-token')
      void project
    })

    it('hands warnings to a listener as they happen, and buffers them otherwise', () => {
      const { fs } = harness()
      const seen: string[] = []
      const off = fs.onWarning((message) => seen.push(message))
      ;(fs as unknown as { warn(message: string): void }).warn('GitHub is unreachable; using the Studio copy')
      assert.deepEqual(seen, ['GitHub is unreachable; using the Studio copy'])
      assert.deepEqual(fs.drainWarnings(), [], 'delivered warnings are not buffered twice')
      off()
      ;(fs as unknown as { warn(message: string): void }).warn('mirror to Studio failed')
      assert.deepEqual(fs.drainWarnings(), ['mirror to Studio failed'])
    })

    it('reports what is missing instead of guessing a project', async () => {
      const ctx = new Context()
      const fiber = await ctx.plugin(CrowdyFileSystem, { appId: '2', root: ROOT })
      const fs = ctx.fs as CrowdyFileSystem
      assert.equal(fs.boot.projectId, '')
      await assert.rejects(
        fs.readText(await fs.resolve(`${ROOT}/server/src/main.rs`)),
        (error: unknown) => error instanceof FsError && error.code === 'FS_IO_ERROR' && /projectId/.test(error.message),
      )
      await fiber.dispose()
    })
  })

  describe('identity and metadata', () => {
    it('maps the two target trees onto one virtual root', async () => {
      const { fs } = harness([file('SERVER', 'src/main.rs', 'fn main() {}')])

      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)
      assert.equal(target.displayPath, `${ROOT}/server/src/main.rs`)

      const info = await fs.stat(target)
      assert.equal(info?.type, 'file')
      assert.equal(info?.version, sha('fn main() {}'))
      assert.equal(info?.size, 12)
    })

    it('resolves relative paths against the mount when the session cwd is elsewhere', async () => {
      const { fs } = harness([file('CLIENT', 'Cargo.toml', '[package]')])

      // A host workspace cwd points at real disk; it must not defeat resolution.
      const target = await fs.resolve('client/Cargo.toml', { cwd: '/home/someone/elsewhere' })
      assert.equal(target.displayPath, `${ROOT}/client/Cargo.toml`)
      assert.equal((await fs.stat(target))?.type, 'file')
    })

    it('reports an absent file as undefined rather than throwing', async () => {
      const { fs } = harness()
      assert.equal(await fs.stat(await fs.resolve(`${ROOT}/server/src/absent.rs`)), undefined)
    })

    it('treats directories implied by file paths as directories', async () => {
      const { fs } = harness([file('SERVER', 'src/deep/nested.rs', 'x')])

      assert.equal((await fs.stat(await fs.resolve(`${ROOT}`)))?.type, 'directory')
      assert.equal((await fs.stat(await fs.resolve(`${ROOT}/server`)))?.type, 'directory')
      assert.equal((await fs.stat(await fs.resolve(`${ROOT}/server/src`)))?.type, 'directory')
      assert.equal((await fs.stat(await fs.resolve(`${ROOT}/server/src/deep`)))?.type, 'directory')
    })

    it('answers containment without exposing target keys', async () => {
      const { fs } = harness()
      const parent = await fs.resolve(`${ROOT}/server`)
      const child = await fs.resolve(`${ROOT}/server/src/main.rs`)
      const other = await fs.resolve(`${ROOT}/client/src/main.rs`)

      assert.equal(fs.contains(parent, child), true)
      assert.equal(fs.contains(parent, parent), true)
      assert.equal(fs.contains(parent, other), false)
    })
  })

  describe('reads', () => {
    it('returns file content and streams it as one chunk', async () => {
      const { fs } = harness([file('SERVER', 'src/main.rs', 'fn main() {}')])
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      assert.equal(await fs.readText(target), 'fn main() {}')

      const chunks: string[] = []
      for await (const chunk of await fs.streamText(target)) chunks.push(chunk)
      assert.deepEqual(chunks, ['fn main() {}'])
    })

    it('raises FS_NOT_FOUND for a missing file', async () => {
      const { fs } = harness()
      const target = await fs.resolve(`${ROOT}/server/src/gone.rs`)
      await assert.rejects(
        () => fs.readText(target),
        (error: FsError) => error.code === 'FS_NOT_FOUND',
      )
    })

    it('lists the target and scratch directories at the root', async () => {
      const { fs } = harness()
      const entries = await fs.listDir(await fs.resolve(ROOT))
      assert.deepEqual(
        entries.map((entry) => entry.name),
        ['client', 'server', 'captures', 'context'],
      )
      assert.ok(entries.every((entry) => entry.type === 'directory'))
    })

    it('serves page-shared captures and context as read-only scratch files', async () => {
      const { fs } = harness()
      fs.scratch.putText('context', 'note.txt', 'hello')
      fs.scratch.putBytes('captures', 'shot.png', new Uint8Array([1, 2, 3]))
      const note = await fs.resolve(`${ROOT}/context/note.txt`)
      assert.equal(await fs.readText(note), 'hello')
      const shot = await fs.resolve(`${ROOT}/captures/shot.png`)
      assert.deepEqual([...(await fs.readBytes(shot, undefined, 10))], [1, 2, 3])
      assert.deepEqual([...(await fs.readByteRange(shot, { offset: 1, length: 5 }))], [2, 3])
      await assert.rejects(fs.readText(shot), (error: unknown) => error instanceof FsError && error.code === 'FS_NOT_TEXT')
      await assert.rejects(
        fs.writeText(note, 'nope'),
        (error: unknown) => error instanceof FsError && error.code === 'FS_PERMISSION_DENIED',
      )
      const listed = await fs.listDir(await fs.resolve(`${ROOT}/captures`))
      assert.deepEqual(listed.map((entry) => entry.name), ['shot.png'])
    })

    it('lists direct children only, synthesizing intermediate directories', async () => {
      const { fs } = harness([
        file('SERVER', 'Cargo.toml', '[package]'),
        file('SERVER', 'src/main.rs', 'a'),
        file('SERVER', 'src/deep/nested.rs', 'b'),
      ])

      const top = await fs.listDir(await fs.resolve(`${ROOT}/server`))
      assert.deepEqual(
        top.map((entry) => `${entry.name}:${entry.type}`),
        ['Cargo.toml:file', 'src:directory'],
      )

      const src = await fs.listDir(await fs.resolve(`${ROOT}/server/src`))
      assert.deepEqual(
        src.map((entry) => `${entry.name}:${entry.type}`),
        ['deep:directory', 'main.rs:file'],
      )
    })
  })

  describe('writes', () => {
    it('creates a file and reports the before/after diff basis', async () => {
      const { fs, api } = harness()
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      const outcome = await fs.writeText(target, 'fn main() {}')

      assert.equal(outcome.operation, 'create')
      assert.equal(outcome.before, null)
      assert.equal(outcome.after, 'fn main() {}')
      assert.equal(outcome.version, sha('fn main() {}'))
      assert.deepEqual(api.saves[0]?.upserts, [
        { target: 'SERVER', path: 'src/main.rs', content: 'fn main() {}' },
      ])
    })

    it('updates a file under the project revision it read', async () => {
      const { fs, api } = harness([file('SERVER', 'src/main.rs', 'old')])
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      const outcome = await fs.writeText(target, 'new')

      assert.equal(outcome.operation, 'update')
      assert.equal(outcome.before, 'old')
      assert.equal(api.saves[0]?.expectedRevision, '1')
    })

    it('rejects a guarded create when the file already exists', async () => {
      const { fs } = harness([file('SERVER', 'src/main.rs', 'here')])
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      await assert.rejects(
        () => fs.writeText(target, 'x', { kind: 'createIfAbsent' }),
        (error: FsError) => error.code === 'FS_NOT_OBSERVED',
      )
    })

    it('rejects a guarded replace whose version no longer matches', async () => {
      const { fs } = harness([file('SERVER', 'src/main.rs', 'current')])
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      await assert.rejects(
        () =>
          fs.writeText(target, 'x', { kind: 'replaceIfVersion', version: FsVersion(sha('stale')) }),
        (error: FsError) => error.code === 'FS_STALE_VERSION',
      )
    })

    it('translates a server revision conflict into FS_STALE_VERSION', async () => {
      const { fs, api } = harness([file('SERVER', 'src/main.rs', 'a')])
      api.conflictOnNextSave = true
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      await assert.rejects(
        () => fs.writeText(target, 'b'),
        (error: FsError) => {
          assert.equal(error.code, 'FS_STALE_VERSION')
          assert.match(error.message, /modified concurrently/)
          return true
        },
      )
    })

    it('refuses paths Crowdy Studio would not store', async () => {
      const { fs } = harness()
      const target = await fs.resolve(`${ROOT}/server/notes.txt`)

      await assert.rejects(
        () => fs.writeText(target, 'x'),
        (error: FsError) => error.code === 'FS_PERMISSION_DENIED',
      )
    })

    it('refuses to write outside the project mount', async () => {
      const { fs } = harness()
      const target = await fs.resolve('/etc/passwd')

      await assert.rejects(
        () => fs.writeText(target, 'x'),
        (error: FsError) => error.code === 'FS_SANDBOX_DENIED',
      )
    })

    it('serializes concurrent writes so the loser sees the winner', async () => {
      const { fs, api } = harness([file('SERVER', 'src/main.rs', 'start')])
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      await Promise.all([fs.writeText(target, 'first'), fs.writeText(target, 'second')])

      // Both committed, each against the revision current at its turn.
      assert.deepEqual(
        api.saves.map((save) => save.expectedRevision),
        ['1', '2'],
      )
    })
  })

  describe('edits', () => {
    it('replaces a unique literal match', async () => {
      const { fs } = harness([file('SERVER', 'src/main.rs', 'let x = 1;\nlet y = 2;\n')])
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      const outcome = await fs.editText(target, {
        oldString: 'let x = 1;',
        newString: 'let x = 41;',
        replaceAll: false,
      })

      assert.equal(outcome.after, 'let x = 41;\nlet y = 2;\n')
      assert.equal(outcome.before, 'let x = 1;\nlet y = 2;\n')
    })

    it('reports an ambiguous edit instead of guessing', async () => {
      const { fs } = harness([file('SERVER', 'src/main.rs', 'dup\ndup\n')])
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      await assert.rejects(
        () => fs.editText(target, { oldString: 'dup', newString: 'x', replaceAll: false }),
        (error: FsError) => {
          assert.equal(error.code, 'FS_AMBIGUOUS_EDIT')
          assert.match(error.message, /matches 2 times/)
          return true
        },
      )
    })

    it('replaces every match when asked', async () => {
      const { fs } = harness([file('SERVER', 'src/main.rs', 'dup\ndup\n')])
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      const outcome = await fs.editText(target, {
        oldString: 'dup',
        newString: 'x',
        replaceAll: true,
      })
      assert.equal(outcome.after, 'x\nx\n')
    })

    it('reports a literal that is not present', async () => {
      const { fs } = harness([file('SERVER', 'src/main.rs', 'contents')])
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      await assert.rejects(
        () => fs.editText(target, { oldString: 'absent', newString: 'x', replaceAll: false }),
        (error: FsError) => error.code === 'FS_EDIT_NOT_FOUND',
      )
    })

    it('honors a stale version guard before matching', async () => {
      const { fs } = harness([file('SERVER', 'src/main.rs', 'contents')])
      const target = await fs.resolve(`${ROOT}/server/src/main.rs`)

      await assert.rejects(
        () =>
          fs.editText(
            target,
            { oldString: 'contents', newString: 'x', replaceAll: false },
            { version: FsVersion(sha('something else')) },
          ),
        (error: FsError) => error.code === 'FS_STALE_VERSION',
      )
    })
  })
})
