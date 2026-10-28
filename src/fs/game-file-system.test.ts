/**
 * Game mode lists the bound repository and writes the draft. The mod crates
 * and the GitHub commit stay on the other pair.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'

import { activeStudioMode } from '../crowdy/config.js'

import { apply as applyModFs } from './entry.js'
import { apply as applyGameFs } from './game-entry.js'
import { CrowdyFileSystem } from './crowdy-file-system.js'
import { GameFileSystem } from './game-file-system.js'

const ROOT = '/dsh/workspace'

function withMode(mode: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env.CROWDY_STUDIO_MODE
  if (mode === undefined) delete process.env.CROWDY_STUDIO_MODE
  else process.env.CROWDY_STUDIO_MODE = mode
  return run().finally(() => {
    if (previous === undefined) delete process.env.CROWDY_STUDIO_MODE
    else process.env.CROWDY_STUDIO_MODE = previous
  })
}

describe('exclusive filesystem plugins', () => {
  it('mounts only the mod crates when the boot omits studioMode', async () => {
    await withMode(undefined, async () => {
      const ctx = new Context()
      await applyGameFs(ctx, { root: ROOT })
      await applyModFs(ctx, { appId: '2', projectId: 'proj-1', root: ROOT })
      assert.ok(ctx.fs instanceof CrowdyFileSystem)
      assert.equal(ctx.fs instanceof GameFileSystem, false)
    })
  })

  it('reads studioMode from crowdy.json when the environment does not set it', async () => {
    const previousHome = process.env.DSH_HOME
    const previousMode = process.env.CROWDY_STUDIO_MODE
    const home = mkdtempSync(join(tmpdir(), 'crowdy-boot-'))
    writeFileSync(join(home, 'crowdy.json'), JSON.stringify({ studioMode: 'game' }))
    process.env.DSH_HOME = home
    delete process.env.CROWDY_STUDIO_MODE
    try {
      assert.equal(activeStudioMode(), 'game')
      const ctx = new Context()
      await applyModFs(ctx, { appId: '2', projectId: 'proj-1', root: ROOT })
      await applyGameFs(ctx, { root: ROOT })
      assert.ok(ctx.fs instanceof GameFileSystem)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (previousMode === undefined) delete process.env.CROWDY_STUDIO_MODE
      else process.env.CROWDY_STUDIO_MODE = previousMode
    }
  })

  it('mounts only the repository when the boot is game mode', async () => {
    await withMode('game', async () => {
      const ctx = new Context()
      await applyModFs(ctx, { appId: '2', projectId: 'proj-1', root: ROOT })
      await applyGameFs(ctx, { root: ROOT })
      assert.ok(ctx.fs instanceof GameFileSystem)
      assert.equal(ctx.fs instanceof CrowdyFileSystem, false)
    })
  })
})

describe('GameFileSystem', () => {
  it('lists the repository and writes the draft without calling GitHub', async () => {
    const files = new Map<string, string>([
      ['src/main.ts', 'export {}\n'],
      ['src/scenes/pool.mjs', 'export const pool = 1\n'],
    ])
    const calls: string[] = []
    const listing: Record<string, Array<{ name: string; type: 'file' | 'directory' }>> = {
      '': [{ name: 'src', type: 'directory' }],
      src: [
        { name: 'main.ts', type: 'file' },
        { name: 'scenes', type: 'directory' },
      ],
      'src/scenes': [{ name: 'pool.mjs', type: 'file' }],
    }
    const ctx = new Context()
    const bridge = {
      client: {
        async request(method: string, params: { path?: string; content?: string }) {
          calls.push(method)
          if (method === 'studio.listRepo') return { entries: listing[params.path ?? ''] ?? [] }
          if (method === 'studio.readRepoFile') return { content: files.get(params.path ?? '') }
          if (method === 'studio.putGameFile') {
            files.set(params.path ?? '', params.content ?? '')
            return { path: params.path }
          }
          throw new Error(`unexpected ${method}`)
        },
      },
    }
    const fs = new GameFileSystem(ctx, { root: ROOT })
    fs.attachPage(bridge)
    const root = await fs.listDir(await fs.resolve(ROOT))
    assert.deepEqual(
      root.map((entry) => entry.name).filter((name) => name !== 'captures' && name !== 'context'),
      ['src'],
    )
    const scenes = await fs.listDir(await fs.resolve(`${ROOT}/src/scenes`))
    assert.deepEqual(
      scenes.map((entry) => entry.name),
      ['pool.mjs'],
    )
    assert.equal(await fs.readText(await fs.resolve(`${ROOT}/src/main.ts`)), 'export {}\n')
    await fs.writeText(await fs.resolve(`${ROOT}/src/main.ts`), 'export const next = 1\n')
    assert.equal(files.get('src/main.ts'), 'export const next = 1\n')
    assert.deepEqual(calls.filter((method) => method !== 'studio.listRepo' && method !== 'studio.readRepoFile'), [
      'studio.putGameFile',
    ])
    await assert.rejects(fs.writeText(await fs.resolve(`${ROOT}/.git/config`), 'nope'))
    assert.equal(await fs.stat(await fs.resolve('/dsh/.git')), undefined)
    assert.equal(await fs.lstat('/dsh/.git'), undefined)
  })
})
