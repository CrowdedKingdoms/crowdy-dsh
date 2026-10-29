/**
 * Game mode: `ctx.fs` is the page's draft of the bound repository. Versions
 * are the page's blob ids, so listing, stat and read agree, and a guarded
 * write carries the harness intent to the page instead of overwriting.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import { BridgeError } from '../bridge/client.js'
import { DRAFT_ERROR_CODES } from '../bridge/protocol.js'
import { CrowdyFileSystem } from './crowdy-file-system.js'
import { apply as applyFs } from './entry.js'
import { GameFileSystem } from './game-file-system.js'

const ROOT = '/dsh/workspace'

function blobId(text: string): string {
  const bytes = Buffer.from(text, 'utf8')
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

/** A page answering the v5 draft requests over an in-memory draft. */
class FakePage {
  readonly files = new Map<string, string>()
  readonly base = new Map<string, string>()
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = []
  revision = 0

  constructor(files: Record<string, string>) {
    for (const [path, text] of Object.entries(files)) {
      this.files.set(path, text)
      this.base.set(path, text)
    }
  }

  readonly client = {
    whenPagePresent: async (): Promise<void> => {},
    request: async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      this.requests.push({ method, params })
      return this.answer(method, params)
    },
  }

  edit(path: string, text: string): void {
    this.files.set(path, text)
    this.revision += 1
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'draft.tree':
        return {
          baseCommitSha: 'base0',
          revision: this.revision,
          entries: [...this.files].map(([path, text]) => ({
            path,
            hash: blobId(text),
            size: Buffer.byteLength(text),
            binary: path.endsWith('.png'),
            dirty: this.base.get(path) !== text,
          })),
          deleted: [...this.base.keys()].filter((path) => !this.files.has(path)),
          truncated: false,
        }
      case 'draft.read': {
        const paths = params.paths as string[]
        return {
          files: paths.filter((p) => this.files.has(p)).map((p) => ({ path: p, hash: blobId(this.files.get(p)!), content: this.files.get(p)! })),
          missing: paths.filter((p) => !this.files.has(p)),
          binary: [],
        }
      }
      case 'draft.write': {
        const path = params.path as string
        const content = params.content as string
        const precondition = params.precondition as { kind: string; hash?: string } | undefined
        const current = this.files.get(path)
        if (precondition?.kind === 'createIfAbsent' && current !== undefined) {
          throw new BridgeError(`${path} already exists.`, DRAFT_ERROR_CODES.stale)
        }
        if (precondition?.kind === 'ifHash' && (current === undefined || blobId(current) !== precondition.hash)) {
          throw new BridgeError(`${path} changed.`, DRAFT_ERROR_CODES.stale)
        }
        this.edit(path, content)
        return { path, hash: blobId(content), previousHash: current === undefined ? null : blobId(current), revision: this.revision }
      }
      case 'draft.delete': {
        const path = params.path as string
        const current = this.files.get(path)
        if (current === undefined) throw new BridgeError(`${path} is not in the draft.`, DRAFT_ERROR_CODES.notFound)
        this.files.delete(path)
        this.revision += 1
        return { path, previousHash: blobId(current), revision: this.revision }
      }
      default:
        throw new BridgeError(`unexpected ${method}`, 'BRIDGE_REFUSED')
    }
  }
}

function mount(page: FakePage): GameFileSystem {
  const ctx = new Context()
  ctx.provide('crowdyBridgeClient', { client: page.client })
  return new GameFileSystem(ctx, { root: ROOT, pageWaitMs: 100 })
}

function withMode(mode: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env.CROWDY_STUDIO_MODE
  if (mode === undefined) delete process.env.CROWDY_STUDIO_MODE
  else process.env.CROWDY_STUDIO_MODE = mode
  return run().finally(() => {
    if (previous === undefined) delete process.env.CROWDY_STUDIO_MODE
    else process.env.CROWDY_STUDIO_MODE = previous
  })
}

describe('the filesystem plugin', () => {
  it('mounts the mod crates when the boot omits studioMode', async () => {
    await withMode(undefined, async () => {
      const ctx = new Context()
      await applyFs(ctx, { appId: '2', projectId: 'proj-1', root: ROOT })
      assert.ok(ctx.fs instanceof CrowdyFileSystem)
    })
  })

  it('mounts the game draft, and only it, when the boot says studioMode game', async () => {
    await withMode('game', async () => {
      const ctx = new Context()
      ctx.provide('crowdyBridgeClient', { client: new FakePage({}).client })
      await applyFs(ctx, { root: ROOT })
      assert.ok(ctx.fs instanceof GameFileSystem)
      assert.equal(ctx.fs instanceof CrowdyFileSystem, false)
    })
  })
})

describe('GameFileSystem', () => {
  it('lists the draft with the page blob ids as versions, so stat and read agree', async () => {
    const page = new FakePage({ 'src/game/scenes/home.ts': 'export const home = 1\n', 'README.md': '# Game\n' })
    const fs = mount(page)
    const root = await fs.resolve(ROOT)
    const names = (await fs.listDir(root)).map((entry) => entry.name).sort()
    assert.deepEqual(names, ['README.md', 'captures', 'context', 'src'])
    const target = await fs.resolve(`${ROOT}/src/game/scenes/home.ts`)
    const info = await fs.stat(target)
    assert.equal(String(info?.version), blobId('export const home = 1\n'))
    assert.equal(await fs.readText(target), 'export const home = 1\n')
  })

  it('reads several files in one batch and serves a reread from the blob cache', async () => {
    const page = new FakePage({ 'a.ts': 'a', 'b.ts': 'b' })
    const fs = mount(page)
    const snapshot = await fs.searchSnapshot()
    assert.deepEqual(snapshot.files.map((f) => f.virtualPath).sort(), [`${ROOT}/a.ts`, `${ROOT}/b.ts`])
    const reads = page.requests.filter((r) => r.method === 'draft.read')
    assert.equal(reads.length, 1)
    await fs.readText(await fs.resolve(`${ROOT}/a.ts`))
    assert.equal(page.requests.filter((r) => r.method === 'draft.read').length, 1)
  })

  it('carries replaceIfVersion to the page and reports a stale write when the page changed the file', async () => {
    const page = new FakePage({ 'a.ts': 'one' })
    const fs = mount(page)
    const target = await fs.resolve(`${ROOT}/a.ts`)
    const version = (await fs.stat(target))!.version
    page.edit('a.ts', 'the player typed this')
    await assert.rejects(
      fs.writeText(target, 'model', { kind: 'replaceIfVersion', version }),
      (error: { code?: string }) => error.code === 'FS_STALE_VERSION',
    )
    assert.equal(page.files.get('a.ts'), 'the player typed this')
  })

  it('creates with createIfAbsent and refuses it over an existing file', async () => {
    const page = new FakePage({ 'a.ts': 'one' })
    const fs = mount(page)
    const created = await fs.writeText(await fs.resolve(`${ROOT}/src/new.ts`), 'x', { kind: 'createIfAbsent' })
    assert.equal(created.operation, 'create')
    assert.equal(String(created.version), blobId('x'))
    await assert.rejects(
      fs.writeText(await fs.resolve(`${ROOT}/a.ts`), 'y', { kind: 'createIfAbsent' }),
      (error: { code?: string }) => error.code === 'FS_NOT_OBSERVED',
    )
  })

  it('follows page.draftChanged without a fresh listing', async () => {
    const page = new FakePage({ 'a.ts': 'one' })
    const fs = mount(page)
    await fs.stat(await fs.resolve(`${ROOT}/a.ts`))
    const trees = () => page.requests.filter((r) => r.method === 'draft.tree').length
    assert.equal(trees(), 1)
    page.edit('a.ts', 'two')
    fs.applyDraftChange({ revision: page.revision, baseCommitSha: 'base0', changes: [{ path: 'a.ts', hash: blobId('two') }], source: 'player' })
    assert.equal(await fs.readText(await fs.resolve(`${ROOT}/a.ts`)), 'two')
    assert.equal(trees(), 1)
    fs.applyDraftChange({ revision: page.revision + 1, baseCommitSha: 'base1', changes: [], source: 'rebase' })
    await fs.stat(await fs.resolve(`${ROOT}/a.ts`))
    assert.equal(trees(), 2)
  })

  it('refuses paths outside the repository and binary reads', async () => {
    const page = new FakePage({ 'art/logo.png': 'PNG', '.env': 'SECRET=1' })
    const fs = mount(page)
    await assert.rejects(fs.readText(await fs.resolve(`${ROOT}/art/logo.png`)), (error: { code?: string }) => error.code === 'FS_NOT_TEXT')
    await assert.rejects(
      fs.writeText(await fs.resolve(`${ROOT}/.github/workflows/ci.yml`), 'x'),
      (error: { code?: string }) => error.code === 'FS_PERMISSION_DENIED',
    )
    const names = (await fs.listDir(await fs.resolve(ROOT))).map((entry) => entry.name)
    assert.equal(names.includes('.env'), false)
  })

  it('keeps captures and context as page scratch, not repository files', async () => {
    const page = new FakePage({})
    const fs = mount(page)
    await assert.rejects(
      fs.writeText(await fs.resolve(`${ROOT}/captures/shot.png`), 'x'),
      (error: { code?: string }) => error.code === 'FS_PERMISSION_DENIED',
    )
    assert.equal(page.requests.some((r) => r.method === 'draft.write'), false)
  })
})
