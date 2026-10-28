/**
 * Game filesystem plugin backend: the bound repository draft, not the mod crates.
 *
 * Reads and listings come from the Studio page (`studio.listRepo`,
 * `studio.readRepoFile`). A write updates that draft through `studio.putGameFile`
 * and does not commit. `commit_game_file` is the commit.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'

import { loadCrowdyConfig, type CrowdyBootConfig } from '../crowdy/config.js'
import { isRepoDir, isRepoPath } from '../crowdy/repo-paths.js'
import { normalizeAbsolute, resolveAgainst } from '../crowdy/paths.js'
import { ScratchStore } from './scratch-store.js'
import { versionOf } from './crowdy-file-system.js'

const DIRECTORY_VERSION = FsVersion('crowdy-directory')
const APP_TOKEN_ENV = 'CROWDY_APP_TOKEN'

interface RepoEntry {
  name: string
  type: 'file' | 'directory'
}

interface RepoBridge {
  client: {
    request(method: string, params: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<unknown>
  }
}

export interface Config {
  root?: string
}

function publishToken(token: string | undefined): void {
  if (!token || typeof process === 'undefined' || !process.env) return
  process.env[APP_TOKEN_ENV] = token
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

export class GameFileSystem extends FileSystem {
  static Config: z<Config> = z.object({
    root: z.string(),
  }) as unknown as z<Config>

  boot: CrowdyBootConfig
  readonly scratch = new ScratchStore()
  private readonly root: string
  private readonly files = new Map<string, string>()
  private page: RepoBridge | undefined

  /**
   * The bridge plugin calls this once it is up. The filesystem cannot inject
   * `crowdyBridge`: the bridge already injects `fs`, and Cordis rejects a
   * property read that was not injected.
   */
  attachPage(bridge: RepoBridge): void {
    this.page = bridge
  }

  private readonly changeListeners = new Set<(change: { target: 'SERVER' | 'CLIENT' | 'REPO'; path: string }) => void>()
  private readonly warnings: string[] = []
  private readonly warningListeners = new Set<(message: string) => void>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.boot = loadCrowdyConfig({ root: config.root })
    this.root = normalizeAbsolute(this.boot.root ?? config.root ?? '/dsh/workspace')
    publishToken(this.boot.appToken)
  }

  get mountRoot(): string {
    return this.root
  }

  get storeReason(): string {
    return 'bound repository draft'
  }

  setProject(projectId: string): void {
    if (projectId === this.boot.projectId) return
    this.boot = { ...this.boot, projectId }
    this.invalidate()
  }

  setToken(token: string | undefined): void {
    this.boot = { ...this.boot, appToken: token }
    publishToken(token)
  }

  invalidate(): void {
    this.files.clear()
  }

  onWarning(listener: (message: string) => void): () => void {
    this.warningListeners.add(listener)
    return () => {
      this.warningListeners.delete(listener)
    }
  }

  drainWarnings(): string[] {
    return this.warnings.splice(0, this.warnings.length)
  }

  onChange(listener: (change: { target: 'SERVER' | 'CLIENT' | 'REPO'; path: string }) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  async searchSnapshot(): Promise<{ root: string; files: Array<{ virtualPath: string; content: string }> }> {
    const files: Array<{ virtualPath: string; content: string }> = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await this.entries(dir)) {
        const child = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.type === 'directory') await walk(child)
        else files.push({ virtualPath: `${this.root}/${child}`, content: await this.readRelative(child) })
      }
    }
    await walk('')
    for (const { name, file } of this.scratch.list('context')) {
      if (file.text !== undefined) files.push({ virtualPath: `${this.root}/context/${name}`, content: file.text })
    }
    return { root: this.root, files }
  }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    this.assertLive(opts?.signal)
    const absolute = resolveAgainst(this.baseFor(opts?.cwd), path)
    return { targetKey: FsTargetKey(`repo:${absolute}`), displayPath: absolute }
  }

  processPath(target: FsTarget): string {
    return this.absolute(target)
  }

  fileUrl(target: FsTarget): string {
    const encoded = this.absolute(target)
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    return `file://${encoded}`
  }

  contains(parent: FsTarget, child: FsTarget): boolean {
    const base = this.absolute(parent)
    const candidate = this.absolute(child)
    return candidate === base || candidate.startsWith(base === '/' ? '/' : `${base}/`)
  }

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    this.assertLive(signal)
    // The harness walks parents looking for `.git`. Those paths are not the
    // repository; an absent probe lets the walk stop at the mount.
    if (!this.insideMount(target)) return undefined
    const relative = this.relative(target)
    if (relative === '') return { version: DIRECTORY_VERSION, type: 'directory' }
    if (relative === 'captures' || relative === 'context') return { version: DIRECTORY_VERSION, type: 'directory' }
    if (relative.startsWith('captures/') || relative.startsWith('context/')) {
      const dir = relative.startsWith('captures/') ? 'captures' : 'context'
      const name = relative.slice(dir.length + 1)
      const file = this.scratch.get(dir, name)
      return file ? { version: FsVersion(file.version), type: 'file', size: file.bytes.byteLength } : undefined
    }
    if (!isRepoPath(relative)) return undefined
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : ''
    const name = relative.slice(parent.length === 0 ? 0 : parent.length + 1)
    const entries = await this.entries(parent, signal)
    const found = entries.find((entry) => entry.name === name)
    if (!found) return undefined
    if (found.type === 'directory') return { version: DIRECTORY_VERSION, type: 'directory' }
    const content = await this.readRelative(relative, signal)
    return { version: versionOf(content), type: 'file', size: new TextEncoder().encode(content).byteLength }
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const target = await this.resolve(path, { cwd: opts?.cwd, signal })
    const info = await this.stat(target, signal)
    return info === undefined ? undefined : { ...info }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    this.assertLive(signal)
    const relative = this.relative(target)
    if (relative.startsWith('captures/') || relative.startsWith('context/')) {
      const dir = relative.startsWith('captures/') ? 'captures' : 'context'
      const file = this.scratch.get(dir, relative.slice(dir.length + 1))
      if (!file || file.text === undefined) throw new FsError(`${this.absolute(target)} does not exist.`, 'FS_NOT_FOUND')
      return file.text
    }
    return this.readRelative(relative, signal)
  }

  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const content = await this.readText(target, signal)
    return {
      async *[Symbol.asyncIterator]() {
        yield content
      },
    }
  }

  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    this.assertLive(signal)
    const bytes = await this.bytesOf(target)
    if (bytes.byteLength > maxBytes) {
      throw new FsError(`${this.absolute(target)} is ${bytes.byteLength} bytes, above the ${maxBytes}-byte cap.`, 'FS_TOO_LARGE')
    }
    return bytes
  }

  async readByteRange(
    target: FsTarget,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.assertLive(signal)
    const bytes = await this.bytesOf(target)
    if (range.offset >= bytes.byteLength) return new Uint8Array(0)
    return bytes.slice(range.offset, range.offset + range.length)
  }

  private async bytesOf(target: FsTarget): Promise<Uint8Array> {
    const relative = this.relative(target)
    if (relative.startsWith('captures/') || relative.startsWith('context/')) {
      const dir = relative.startsWith('captures/') ? 'captures' : 'context'
      const file = this.scratch.get(dir, relative.slice(dir.length + 1))
      if (!file) throw new FsError(`${this.absolute(target)} does not exist.`, 'FS_NOT_FOUND')
      return file.bytes
    }
    return new TextEncoder().encode(await this.readRelative(relative, undefined))
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    this.assertLive(signal)
    const relative = this.relative(target)
    if (relative === 'captures' || relative === 'context') {
      const dir = relative
      return Promise.all(
        this.scratch.list(dir).map(async ({ name, file }) => ({
          name,
          type: 'file' as const,
          target: await this.resolve(`${this.root}/${dir}/${name}`),
          version: FsVersion(file.version),
          size: file.bytes.byteLength,
        })),
      )
    }
    if (relative !== '' && !isRepoDir(relative)) {
      throw new FsError(`${this.absolute(target)} is outside the repository.`, 'FS_NOT_FOUND')
    }
    const entries = await this.entries(relative, signal)
    const listed = await Promise.all(
      entries.map(async (entry) => {
        const child = relative ? `${relative}/${entry.name}` : entry.name
        return {
          name: entry.name,
          type: entry.type,
          target: await this.resolve(`${this.root}/${child}`),
          version: entry.type === 'directory' ? DIRECTORY_VERSION : versionOf(this.files.get(child) ?? entry.name),
        }
      }),
    )
    if (relative === '') {
      for (const dir of ['captures', 'context'] as const) {
        listed.push({
          name: dir,
          type: 'directory',
          target: await this.resolve(`${this.root}/${dir}`),
          version: DIRECTORY_VERSION,
        })
      }
    }
    return listed
  }

  async writeText(
    target: FsTarget,
    content: string,
    _expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    this.assertLive(signal)
    const relative = this.requireWritable(target)
    const before = this.files.has(relative) ? toLf(this.files.get(relative) ?? '') : null
    await this.bridge(signal).client.request('studio.putGameFile', { path: relative, content }, { signal, timeoutMs: 30_000 })
    this.files.set(relative, content)
    this.emitChange(relative)
    return {
      operation: before === null ? 'create' : 'update',
      version: versionOf(content),
      before,
      after: toLf(content),
    }
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    this.assertLive(signal)
    const relative = this.requireWritable(target)
    const existing = await this.readRelative(relative, signal)
    if (expected && versionOf(existing) !== expected.version) {
      throw new FsError(`${target.displayPath} changed since it was read; re-read it before editing.`, 'FS_STALE_VERSION')
    }
    const before = toLf(existing)
    const oldString = toLf(edit.oldString)
    const matches = countOccurrences(before, oldString)
    if (matches === 0) {
      throw new FsError(`The literal text to replace was not found in ${target.displayPath}.`, 'FS_EDIT_NOT_FOUND')
    }
    if (matches > 1 && !edit.replaceAll) {
      throw new FsError(
        `The literal text matches ${matches} times in ${target.displayPath}; pass replaceAll or use a longer, unique match.`,
        'FS_AMBIGUOUS_EDIT',
      )
    }
    const after = edit.replaceAll ? before.split(oldString).join(toLf(edit.newString)) : before.replace(oldString, toLf(edit.newString))
    await this.writeText(target, after, undefined, signal)
    return { version: versionOf(after), before, after }
  }

  private async entries(dir: string, signal?: AbortSignal): Promise<RepoEntry[]> {
    const result = (await this.bridge(signal).client.request(
      'studio.listRepo',
      { path: dir },
      { signal, timeoutMs: 15_000 },
    )) as { entries?: RepoEntry[] }
    return Array.isArray(result.entries) ? result.entries : []
  }

  private async readRelative(relative: string, signal?: AbortSignal): Promise<string> {
    if (!isRepoPath(relative)) throw new FsError(`${relative} is outside the repository.`, 'FS_PERMISSION_DENIED')
    const cached = this.files.get(relative)
    if (cached !== undefined) return cached
    const result = (await this.bridge(signal).client.request(
      'studio.readRepoFile',
      { path: relative },
      { signal, timeoutMs: 15_000 },
    )) as { content?: unknown }
    if (typeof result.content !== 'string') throw new FsError(`${relative} does not exist in the repository.`, 'FS_NOT_FOUND')
    this.files.set(relative, result.content)
    return result.content
  }

  private bridge(signal?: AbortSignal): RepoBridge {
    this.assertLive(signal)
    if (!this.page?.client) throw new FsError('The Studio page is not connected.', 'FS_NOT_FOUND')
    return this.page
  }

  private requireWritable(target: FsTarget): string {
    const relative = this.relative(target)
    if (!isRepoPath(relative)) {
      throw new FsError(`${this.absolute(target)} is not a file in the bound repository.`, 'FS_PERMISSION_DENIED')
    }
    return relative
  }

  private relative(target: FsTarget): string {
    const absolute = this.absolute(target)
    if (absolute === this.root) return ''
    if (!absolute.startsWith(`${this.root}/`)) {
      throw new FsError(`${absolute} is outside the repository mount at ${this.root}.`, 'FS_NOT_FOUND')
    }
    return absolute.slice(this.root.length + 1)
  }

  private insideMount(target: FsTarget): boolean {
    const absolute = this.absolute(target)
    return absolute === this.root || absolute.startsWith(`${this.root}/`)
  }

  private absolute(target: FsTarget): string {
    const key = String(target.targetKey)
    return key.startsWith('repo:') ? key.slice('repo:'.length) : key
  }

  private baseFor(cwd: string | undefined): string {
    if (!cwd) return this.root
    const candidate = normalizeAbsolute(cwd)
    return candidate === this.root || candidate.startsWith(`${this.root}/`) ? candidate : this.root
  }

  private emitChange(path: string): void {
    const change = { target: 'REPO' as const, path }
    for (const listener of this.changeListeners) listener(change)
  }

  private assertLive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new FsError('The filesystem operation was aborted.', 'FS_ABORTED')
  }
}

export default GameFileSystem
