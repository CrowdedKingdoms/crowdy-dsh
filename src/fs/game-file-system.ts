/**
 * Game filesystem backend: the page's draft of the bound game repository.
 *
 * The page owns the draft (CrowdyJS `DraftStore`). This backend keeps a
 * snapshot of it, path -> git blob id, from `draft.tree`, and follows every
 * change through `page.draftChanged`; file text is fetched with `draft.read`
 * in batches and cached by blob id, which never changes meaning. Versions are
 * those blob ids, so listing, stat and read always agree. Writes carry the
 * harness's own guarded-write intent to the page (`createIfAbsent` /
 * `ifHash`), so an edit made on the page since the model read a file is a
 * stale write here, never a silent overwrite. Nothing here commits: a write
 * changes the draft, and `commit_game_files` asks the player.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'

import type {} from '../bridge/client-service.js'
import { BridgeError, type BridgeClient } from '../bridge/client.js'
import { DRAFT_ERROR_CODES, type DraftChangedPayload, type DraftTree } from '../bridge/protocol.js'
import { loadCrowdyConfig, type CrowdyBootConfig } from '../crowdy/config.js'
import { normalizeAbsolute, resolveAgainst } from '../crowdy/paths.js'
import { isRepoPath } from '../crowdy/repo-paths.js'
import { ScratchStore } from './scratch-store.js'
import type { StudioFileSystem } from './studio-fs.js'

const DIRECTORY_VERSION = FsVersion('crowdy-directory')
const SCRATCH_DIRS = ['captures', 'context'] as const
const READ_BATCH = 100
/** Search reads at most this much text, and skips files larger than the per-file cap. */
const SEARCH_MAX_BYTES = 8 * 1024 * 1024
const SEARCH_MAX_FILE_BYTES = 256 * 1024
const SEARCH_MAX_FILES = 2_000

interface Entry {
  hash: string
  size: number
  binary: boolean
}

export interface Config {
  root?: string
  /** How long the first read waits for the page to say hello. */
  pageWaitMs?: number
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

/** The page's draft error codes, in the harness's filesystem vocabulary. */
function fsCodeFor(code: string, intent?: FsWriteIntent): FsErrorCode {
  switch (code) {
    case DRAFT_ERROR_CODES.stale:
      return intent?.kind === 'createIfAbsent' ? 'FS_NOT_OBSERVED' : 'FS_STALE_VERSION'
    case DRAFT_ERROR_CODES.notFound:
      return 'FS_NOT_FOUND'
    case DRAFT_ERROR_CODES.refused:
      return 'FS_PERMISSION_DENIED'
    case DRAFT_ERROR_CODES.tooLarge:
      return 'FS_TOO_LARGE'
    default:
      return 'FS_IO_ERROR'
  }
}

export class GameFileSystem extends FileSystem implements StudioFileSystem {
  static inject = ['crowdyBridgeClient']
  static Config: z<Config> = z.object({
    root: z.string(),
    pageWaitMs: z.number().default(10_000),
  }) as unknown as z<Config>

  readonly studioMode = 'game' as const
  boot: CrowdyBootConfig
  readonly scratch = new ScratchStore()
  private readonly root: string
  private readonly pageWaitMs: number
  private readonly client: BridgeClient
  private entries = new Map<string, Entry>()
  private deleted = new Set<string>()
  private baseCommitSha: string | null = null
  private revision = -1
  private loaded: Promise<void> | null = null
  /** Blob id -> text. */
  private readonly text = new Map<string, string>()
  private readonly warnings: string[] = []
  private readonly warningListeners = new Set<(message: string) => void>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.boot = loadCrowdyConfig({ root: config.root })
    this.root = normalizeAbsolute(this.boot.root ?? config.root ?? '/dsh/workspace')
    this.pageWaitMs = config.pageWaitMs ?? 10_000
    this.client = ctx.crowdyBridgeClient.client
  }

  // ── StudioFileSystem ───────────────────────────────────────────────────────

  get mountRoot(): string {
    return this.root
  }

  get storeReason(): string | undefined {
    return this.baseCommitSha ? `game draft on ${this.baseCommitSha.slice(0, 7)}` : 'game draft'
  }

  setProject(projectId: string): void {
    if (projectId === this.boot.projectId) return
    this.boot = { ...this.boot, projectId }
    this.invalidate()
  }

  /** The game backend holds no token; the bridge publishes it for the model route. */
  setToken(_token: string | undefined): void {}

  invalidate(): void {
    this.loaded = null
  }

  applyDraftChange(change: DraftChangedPayload): void {
    // A reload or a rebase can move every path at once: take a fresh snapshot.
    if (change.source === 'reload' || change.source === 'rebase' || change.revision < this.revision) {
      this.invalidate()
      return
    }
    if (!this.loaded) return
    this.revision = Math.max(this.revision, change.revision)
    this.baseCommitSha = change.baseCommitSha
    for (const { path, hash } of change.changes) {
      if (hash === null) {
        this.entries.delete(path)
        this.deleted.add(path)
        continue
      }
      this.deleted.delete(path)
      const known = this.text.get(hash)
      const previous = this.entries.get(path)
      this.entries.set(path, {
        hash,
        size: known !== undefined ? new TextEncoder().encode(known).byteLength : (previous?.size ?? 0),
        binary: false,
      })
    }
  }

  onChange(_listener: (change: { target: 'SERVER' | 'CLIENT'; path: string }) => void): () => void {
    // The page announces game-mode changes itself (`page.draftChanged`).
    return () => {}
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

  async searchSnapshot(): Promise<{ root: string; files: Array<{ virtualPath: string; content: string }> }> {
    await this.ensureLoaded()
    const candidates = [...this.entries]
      .filter(([, entry]) => !entry.binary && entry.size <= SEARCH_MAX_FILE_BYTES)
      .slice(0, SEARCH_MAX_FILES)
    let budget = SEARCH_MAX_BYTES
    const wanted: string[] = []
    for (const [path, entry] of candidates) {
      if (budget - entry.size < 0) break
      budget -= entry.size
      wanted.push(path)
    }
    const texts = await this.readMany(wanted)
    const files: Array<{ virtualPath: string; content: string }> = []
    for (const path of wanted) {
      const content = texts.get(path)
      if (content !== undefined) files.push({ virtualPath: `${this.root}/${path}`, content })
    }
    for (const { name, file } of this.scratch.list('context')) {
      if (file.text !== undefined) files.push({ virtualPath: `${this.root}/context/${name}`, content: file.text })
    }
    return { root: this.root, files }
  }

  // ── FileSystem ─────────────────────────────────────────────────────────────

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
    // Parents of the mount (the harness walks them looking for `.git`) are not the repository.
    const relative = this.relativeOrNull(target)
    if (relative === null) return undefined
    if (relative === '' || (SCRATCH_DIRS as readonly string[]).includes(relative)) {
      return { version: DIRECTORY_VERSION, type: 'directory' }
    }
    const scratch = this.scratchFile(relative)
    if (scratch !== undefined) {
      return scratch ? { version: FsVersion(scratch.version), type: 'file', size: scratch.bytes.byteLength } : undefined
    }
    if (!isRepoPath(relative)) return undefined
    await this.ensureLoaded(signal)
    const entry = this.entries.get(relative)
    if (entry) return { version: FsVersion(entry.hash), type: 'file', size: entry.size }
    const prefix = `${relative}/`
    for (const path of this.entries.keys()) {
      if (path.startsWith(prefix)) return { version: DIRECTORY_VERSION, type: 'directory' }
    }
    return undefined
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const target = await this.resolve(path, { cwd: opts?.cwd, signal })
    const info = await this.stat(target, signal)
    return info === undefined ? undefined : { ...info }
  }

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    this.assertLive(signal)
    const relative = this.relative(target)
    const scratch = this.scratchFile(relative)
    if (scratch !== undefined) {
      if (!scratch) throw new FsError(`${this.absolute(target)} does not exist.`, 'FS_NOT_FOUND')
      if (scratch.text === undefined) {
        throw new FsError(`${this.absolute(target)} is binary; use read_image for screenshots.`, 'FS_NOT_TEXT')
      }
      return scratch.text
    }
    return this.readRepoText(relative, signal)
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
    const bytes = await this.bytesOf(target, signal)
    if (bytes.byteLength > maxBytes) {
      throw new FsError(`${this.absolute(target)} is ${bytes.byteLength} bytes, above the ${maxBytes}-byte cap.`, 'FS_TOO_LARGE')
    }
    return bytes
  }

  async readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertLive(signal)
    const bytes = await this.bytesOf(target, signal)
    if (range.offset >= bytes.byteLength) return new Uint8Array(0)
    return bytes.slice(range.offset, range.offset + range.length)
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    this.assertLive(signal)
    const relative = this.relative(target)
    if ((SCRATCH_DIRS as readonly string[]).includes(relative)) {
      return Promise.all(
        this.scratch.list(relative as (typeof SCRATCH_DIRS)[number]).map(async ({ name, file }) => ({
          name,
          type: 'file' as const,
          target: await this.resolve(`${this.root}/${relative}/${name}`),
          version: FsVersion(file.version),
          size: file.bytes.byteLength,
        })),
      )
    }
    if (relative !== '' && !isRepoPath(relative)) {
      throw new FsError(`${this.absolute(target)} is outside the repository.`, 'FS_NOT_FOUND')
    }
    await this.ensureLoaded(signal)
    const prefix = relative === '' ? '' : `${relative}/`
    if (relative !== '' && this.entries.has(relative)) {
      throw new FsError(`${this.absolute(target)} is not a directory.`, 'FS_NOT_DIRECTORY')
    }
    const files = new Map<string, Entry>()
    const dirs = new Set<string>()
    for (const [path, entry] of this.entries) {
      if (!path.startsWith(prefix)) continue
      const rest = path.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash === -1) files.set(rest, entry)
      else dirs.add(rest.slice(0, slash))
    }
    if (relative !== '' && files.size === 0 && dirs.size === 0) {
      throw new FsError(`${this.absolute(target)} does not exist in the draft.`, 'FS_NOT_FOUND')
    }
    const listed: FsDirEntry[] = []
    for (const name of [...dirs].sort()) {
      listed.push({ name, type: 'directory', target: await this.resolve(`${this.root}/${prefix}${name}`), version: DIRECTORY_VERSION })
    }
    for (const name of [...files.keys()].sort()) {
      const entry = files.get(name)!
      listed.push({
        name,
        type: 'file',
        target: await this.resolve(`${this.root}/${prefix}${name}`),
        version: FsVersion(entry.hash),
        size: entry.size,
      })
    }
    if (relative === '') {
      for (const dir of SCRATCH_DIRS) {
        listed.push({ name: dir, type: 'directory', target: await this.resolve(`${this.root}/${dir}`), version: DIRECTORY_VERSION })
      }
    }
    return listed
  }

  async writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal): Promise<FsWriteOutcome> {
    this.assertLive(signal)
    const relative = this.requireWritable(target)
    await this.ensureLoaded(signal)
    const precondition =
      expected?.kind === 'createIfAbsent'
        ? ({ kind: 'createIfAbsent' } as const)
        : expected?.kind === 'replaceIfVersion'
          ? ({ kind: 'ifHash', hash: String(expected.version) } as const)
          : undefined
    let result: { path: string; hash: string; previousHash: string | null; revision: number }
    try {
      result = await this.client.request(
        'draft.write',
        { path: relative, content, ...(precondition ? { precondition } : {}) },
        { signal, timeoutMs: 30_000 },
      )
    } catch (error) {
      throw this.asFsError(error, relative, expected)
    }
    const before = result.previousHash ? (this.text.get(result.previousHash) ?? null) : null
    this.text.set(result.hash, content)
    this.entries.set(relative, { hash: result.hash, size: new TextEncoder().encode(content).byteLength, binary: false })
    this.deleted.delete(relative)
    this.revision = Math.max(this.revision, result.revision)
    return {
      operation: result.previousHash === null ? 'create' : 'update',
      version: FsVersion(result.hash),
      before: before === null ? null : toLf(before),
      after: toLf(content),
    }
  }

  async editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal): Promise<FsEditOutcome> {
    this.assertLive(signal)
    const relative = this.requireWritable(target)
    const existing = await this.readRepoText(relative, signal)
    const current = this.entries.get(relative)
    if (!current) throw new FsError(`${target.displayPath} does not exist.`, 'FS_NOT_FOUND')
    if (expected && String(expected.version) !== current.hash) {
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
    const newString = toLf(edit.newString)
    const after = edit.replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString)
    const written = await this.writeText(target, after, { kind: 'replaceIfVersion', version: FsVersion(current.hash) }, signal)
    return { version: written.version, before, after }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async ensureLoaded(signal?: AbortSignal): Promise<void> {
    this.loaded ??= this.loadTree()
    try {
      await this.loaded
    } catch (error) {
      this.loaded = null
      throw error
    }
    this.assertLive(signal)
  }

  private async loadTree(): Promise<void> {
    await this.client.whenPagePresent(this.pageWaitMs)
    let tree: DraftTree
    try {
      tree = await this.client.request('draft.tree', {}, { timeoutMs: 30_000 })
    } catch (error) {
      throw this.asFsError(error, '')
    }
    const entries = new Map<string, Entry>()
    for (const entry of tree.entries) {
      if (isRepoPath(entry.path)) entries.set(entry.path, { hash: entry.hash, size: entry.size, binary: entry.binary })
    }
    this.entries = entries
    this.deleted = new Set(tree.deleted)
    this.baseCommitSha = tree.baseCommitSha
    this.revision = tree.revision
    if (tree.truncated) this.warn('The game repository is larger than the draft lists; some files are not visible to the agent.')
  }

  private async readRepoText(relative: string, signal?: AbortSignal): Promise<string> {
    if (!isRepoPath(relative)) throw new FsError(`${relative} is outside the repository.`, 'FS_PERMISSION_DENIED')
    await this.ensureLoaded(signal)
    const entry = this.entries.get(relative)
    if (!entry) throw new FsError(`${this.root}/${relative} does not exist in the draft.`, 'FS_NOT_FOUND')
    if (entry.binary) throw new FsError(`${this.root}/${relative} is a binary file; the game editor reads text only.`, 'FS_NOT_TEXT')
    const texts = await this.readMany([relative], signal)
    const content = texts.get(relative)
    if (content === undefined) throw new FsError(`${this.root}/${relative} does not exist in the draft.`, 'FS_NOT_FOUND')
    return content
  }

  /** Text of `paths` from the cache by blob id, fetching the rest in batches. */
  private async readMany(paths: readonly string[], signal?: AbortSignal): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const fetch: string[] = []
    for (const path of paths) {
      const entry = this.entries.get(path)
      if (!entry || entry.binary) continue
      const cached = this.text.get(entry.hash)
      if (cached !== undefined) out.set(path, cached)
      else fetch.push(path)
    }
    for (let i = 0; i < fetch.length; i += READ_BATCH) {
      const batch = fetch.slice(i, i + READ_BATCH)
      let result: { files: Array<{ path: string; hash: string; content: string }>; missing: string[]; binary?: string[] }
      try {
        result = await this.client.request('draft.read', { paths: batch }, { signal, timeoutMs: 30_000 })
      } catch (error) {
        throw this.asFsError(error, batch[0] ?? '')
      }
      for (const file of result.files) {
        this.text.set(file.hash, file.content)
        out.set(file.path, file.content)
        const entry = this.entries.get(file.path)
        if (entry && entry.hash !== file.hash) this.entries.set(file.path, { ...entry, hash: file.hash })
      }
      for (const path of result.binary ?? []) {
        const entry = this.entries.get(path)
        if (entry) this.entries.set(path, { ...entry, binary: true })
      }
    }
    return out
  }

  private async bytesOf(target: FsTarget, signal?: AbortSignal): Promise<Uint8Array> {
    const relative = this.relative(target)
    const scratch = this.scratchFile(relative)
    if (scratch !== undefined) {
      if (!scratch) throw new FsError(`${this.absolute(target)} does not exist.`, 'FS_NOT_FOUND')
      return scratch.bytes
    }
    return new TextEncoder().encode(await this.readRepoText(relative, signal))
  }

  /** undefined: not a scratch path; null: a scratch path with no file. */
  private scratchFile(relative: string): ReturnType<ScratchStore['get']> | null | undefined {
    for (const dir of SCRATCH_DIRS) {
      if (relative.startsWith(`${dir}/`)) return this.scratch.get(dir, relative.slice(dir.length + 1)) ?? null
    }
    return undefined
  }

  private requireWritable(target: FsTarget): string {
    const relative = this.relative(target)
    if (this.scratchFile(relative) !== undefined || (SCRATCH_DIRS as readonly string[]).includes(relative)) {
      throw new FsError(`${this.absolute(target)} is read-only; the page fills captures/ and context/.`, 'FS_PERMISSION_DENIED')
    }
    if (!isRepoPath(relative)) {
      throw new FsError(`${this.absolute(target)} is not a file the game editor may write.`, 'FS_PERMISSION_DENIED')
    }
    return relative
  }

  private asFsError(error: unknown, path: string, intent?: FsWriteIntent): FsError {
    if (error instanceof FsError) return error
    if (error instanceof BridgeError) {
      const display = path ? `${this.root}/${path}` : this.root
      if (error.code === DRAFT_ERROR_CODES.stale) {
        return new FsError(
          intent?.kind === 'createIfAbsent'
            ? `${display} already exists in the draft; read it before replacing it.`
            : `${display} changed in the draft since it was read; re-read it before writing.`,
          fsCodeFor(error.code, intent),
        )
      }
      if ((Object.values(DRAFT_ERROR_CODES) as string[]).includes(error.code)) {
        return new FsError(error.message, fsCodeFor(error.code, intent))
      }
      return new FsError(error.message, 'FS_IO_ERROR')
    }
    return new FsError(error instanceof Error ? error.message : String(error), 'FS_IO_ERROR')
  }

  private relativeOrNull(target: FsTarget): string | null {
    const absolute = this.absolute(target)
    if (absolute === this.root) return ''
    return absolute.startsWith(`${this.root}/`) ? absolute.slice(this.root.length + 1) : null
  }

  private relative(target: FsTarget): string {
    const relative = this.relativeOrNull(target)
    if (relative === null) {
      throw new FsError(`${this.absolute(target)} is outside the repository mount at ${this.root}.`, 'FS_NOT_FOUND')
    }
    return relative
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

  private warn(message: string): void {
    if (this.warningListeners.size === 0) this.warnings.push(message)
    for (const listener of this.warningListeners) listener(message)
  }

  private assertLive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new FsError('The filesystem operation was aborted.', 'FS_ABORTED')
  }
}

export default GameFileSystem
