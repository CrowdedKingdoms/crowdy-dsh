/**
 * Session persistence for the browser worker: mirror the harness home's
 * durable state (session logs, projection caches, user settings) from the
 * in-memory VFS into the origin-private file system, so a reload or a later
 * visit restores the player's sessions.
 *
 * The page half (`web/crowdy-boot.ts`) reads the same OPFS directory before the
 * worker boots and feeds it back as a pre-boot overlay, so nothing here needs
 * to run before the tree is up. In Node (the developer cockpit) OPFS does not
 * exist and the plugin is inert: the real disk already persists `$DSH_HOME`.
 *
 * @module @crowdedkingdoms/crowdy-dsh/persist
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface Config {
  /**
   * OPFS directory that holds this harness's mirror. The page derives it from
   * the app and player so two players on one browser never share sessions.
   * Also readable from `$DSH_HOME/crowdy.json` as `persistScope`.
   */
  scope?: string
  /** Sweep interval in milliseconds. */
  intervalMs?: number
  /** Total bytes kept in the mirror; the oldest session directories go first. */
  maxBytes?: number
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'crowdy-persist'

export const Config: z<Config> = z.object({
  scope: z.string(),
  intervalMs: z.number().default(3_000),
  maxBytes: z.number().default(48 * 1024 * 1024),
}) as unknown as z<Config>

/** Home-relative trees worth keeping across reloads. */
export const PERSISTED_HOME_TREES = ['sessions', 'storages'] as const
/** Home-relative single files worth keeping across reloads. */
export const PERSISTED_HOME_FILES = ['settings.yaml'] as const

/** Root directory name inside OPFS; scopes hang under it. */
export const OPFS_ROOT = 'crowdy-dsh'

interface OpfsDirectory {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectory>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFile>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  entries?(): AsyncIterableIterator<[string, OpfsDirectory | OpfsFile]>
  keys?(): AsyncIterableIterator<string>
  kind: 'directory'
}

interface OpfsFile {
  kind: 'file'
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>
  getFile(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer>; lastModified: number }>
}

function opfsRoot(): Promise<OpfsDirectory> | undefined {
  const storage = (globalThis as { navigator?: { storage?: { getDirectory?: () => Promise<OpfsDirectory> } } }).navigator?.storage
  if (!storage || typeof storage.getDirectory !== 'function') return undefined
  return storage.getDirectory()
}

async function ensureDirectory(root: OpfsDirectory, segments: string[]): Promise<OpfsDirectory> {
  let current = root
  for (const segment of segments) current = await current.getDirectoryHandle(segment, { create: true })
  return current
}

/** Resolve the scope from row config, then `crowdy.json`, then a fixed default. */
export function resolveScope(config: Config, home: string | undefined): string {
  if (config.scope) return config.scope
  if (home) {
    try {
      const parsed = JSON.parse(readFileSync(join(home, 'crowdy.json'), 'utf8')) as { persistScope?: unknown }
      if (typeof parsed.persistScope === 'string' && parsed.persistScope) return parsed.persistScope
    } catch {
      // No page config: fall through to the default scope.
    }
  }
  return 'default'
}

function listFiles(root: string, directory: string, out: Map<string, { mtime: number; size: number }>): void {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry)
    let info
    try {
      info = statSync(path)
    } catch {
      continue
    }
    if (info.isDirectory()) listFiles(root, path, out)
    else if (info.isFile()) out.set(relative(root, path), { mtime: info.mtimeMs, size: info.size })
  }
}

/** Snapshot of every persisted file under the home, keyed by home-relative path. */
export function snapshotHome(home: string): Map<string, { mtime: number; size: number }> {
  const out = new Map<string, { mtime: number; size: number }>()
  for (const tree of PERSISTED_HOME_TREES) listFiles(home, join(home, tree), out)
  for (const file of PERSISTED_HOME_FILES) {
    try {
      const info = statSync(join(home, file))
      if (info.isFile()) out.set(file, { mtime: info.mtimeMs, size: info.size })
    } catch {
      // absent
    }
  }
  return out
}

export class HomeMirror {
  private readonly seen = new Map<string, number>()
  private running = false

  constructor(
    private readonly home: string,
    private readonly scopeDir: Promise<OpfsDirectory>,
    private readonly maxBytes: number,
    private readonly warn: (message: string) => void,
  ) {}

  /** Copy every file whose mtime moved since the last sweep. */
  async sweep(): Promise<number> {
    if (this.running) return 0
    this.running = true
    try {
      const snapshot = snapshotHome(this.home)
      const scope = await this.scopeDir
      let copied = 0
      let total = 0
      for (const [path, info] of snapshot) {
        total += info.size
        if (this.seen.get(path) === info.mtime) continue
        const bytes = readFileSync(join(this.home, path))
        const segments = path.split('/')
        const leaf = segments.pop()!
        const directory = await ensureDirectory(scope, segments)
        const handle = await directory.getFileHandle(leaf, { create: true })
        const writable = await handle.createWritable()
        await writable.write(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
        await writable.close()
        this.seen.set(path, info.mtime)
        copied += 1
      }
      if (total > this.maxBytes) await this.trim(snapshot, total)
      return copied
    } catch (error) {
      this.warn(`session mirror sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      return 0
    } finally {
      this.running = false
    }
  }

  /** Drop the oldest session directories from the mirror until under budget. */
  private async trim(snapshot: Map<string, { mtime: number; size: number }>, total: number): Promise<void> {
    const sessions = new Map<string, { mtime: number; size: number }>()
    for (const [path, info] of snapshot) {
      if (!path.startsWith('sessions/')) continue
      const key = path.split('/').slice(0, 3).join('/')
      const current = sessions.get(key) ?? { mtime: 0, size: 0 }
      sessions.set(key, { mtime: Math.max(current.mtime, info.mtime), size: current.size + info.size })
    }
    const oldestFirst = [...sessions.entries()].sort((a, b) => a[1].mtime - b[1].mtime)
    const scope = await this.scopeDir
    for (const [key, info] of oldestFirst) {
      if (total <= this.maxBytes) break
      const segments = key.split('/')
      const leaf = segments.pop()!
      try {
        const directory = await ensureDirectory(scope, segments)
        await directory.removeEntry(leaf, { recursive: true })
        total -= info.size
        for (const path of [...this.seen.keys()]) if (path.startsWith(`${key}/`)) this.seen.delete(path)
      } catch (error) {
        this.warn(`session mirror trim failed for ${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const root = opfsRoot()
  const home = process.env.DSH_HOME
  if (!root || !home) {
    // Node cockpit or a browser without OPFS: the disk (or nothing) persists.
    return
  }
  const scope = resolveScope(config, home)
  const scopeDir = root.then((directory) => ensureDirectory(directory, [OPFS_ROOT, ...scope.split('/').filter(Boolean)]))
  const mirror = new HomeMirror(home, scopeDir, config.maxBytes ?? 48 * 1024 * 1024, (message) => {
    console.warn(`crowdy-persist: ${message}`)
  })
  const interval = setInterval(() => {
    void mirror.sweep()
  }, config.intervalMs ?? 3_000)
  ctx.effect(() => () => {
    clearInterval(interval)
  }, 'crowdy session mirror')
  void mirror.sweep()
}
