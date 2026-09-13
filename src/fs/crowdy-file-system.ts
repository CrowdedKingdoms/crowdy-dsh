/**
 * A DeepSeek Harness `ctx.fs` backend whose execution world is a Crowdy Studio
 * project instead of a disk.
 *
 * The harness expects a filesystem; Crowdy Studio offers a small versioned bag
 * of files behind a GraphQL API (or, for a GitHub-bound project, the bound
 * repository). This class bridges the two:
 *
 *   - identity  — a target key is the virtual absolute path, which is stable
 *                 because Crowdy paths never alias (no symlinks, no hardlinks).
 *   - freshness — `FsVersion` is a content hash, so a version changes exactly
 *                 when the bytes change.
 *   - atomicity — every mutation is one store commit guarded by the revision it
 *                 read, and a lost race surfaces as `FS_STALE_VERSION` rather
 *                 than a silent overwrite.
 *
 * Beside the two project trees the mount carries in-memory scratch directories
 * (`captures/`, `context/`) the Studio page fills over the bridge; see
 * {@link ScratchStore}.
 *
 * @module @crowdedkingdoms/crowdy-dsh/fs
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

import { CrowdyApiError, CrowdyStudioClient } from '../crowdy/client.js'
import type { CrowdyProjectFile, CrowdyTarget } from '../crowdy/client.js'
import { loadCrowdyConfig, describeMissing, type CrowdyBootConfig } from '../crowdy/config.js'
import {
  DEFAULT_ROOT,
  classify,
  directChildren,
  isAcceptableProjectPath,
  normalizeAbsolute,
  resolveAgainst,
  scratchDirectories,
  targetDirectories,
  toVirtualPath,
} from '../crowdy/paths.js'
import { CrowdyProjectStore, describeSource, type ProjectSnapshot, type ProjectStore } from '../crowdy/project-store.js'
import { ScratchStore } from './scratch-store.js'

export type Config = Partial<CrowdyBootConfig> & {
  /** How long a project snapshot may be reused for reads, in milliseconds. */
  snapshotTtlMs?: number
}

/** Directories have no meaningful content version; guards only apply to files. */
const DIRECTORY_VERSION = FsVersion('crowdy-directory')

/** Normalize line endings so `before`/`after` always share one diff basis. */
function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/**
 * Content-addressed freshness token. FNV-1a over UTF-16 code units: no
 * `node:crypto` (absent in the browser worker), synchronous, and collisions
 * only ever cost one spurious re-read of a small Rust file.
 */
export function versionOf(content: string): FsVersion {
  const text = toLf(content)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 ^= code & 0xff
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h1 ^= code >>> 8
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= code
    h2 = Math.imul(h2, 0x27d4eb2f) >>> 0
  }
  return FsVersion(`fnv:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}:${text.length}`)
}

/**
 * The model route resolves its bearer through `apiKeyEnv: CROWDY_APP_TOKEN`.
 * The credentials provider reads the process environment on every request and
 * the browser worker never sees a `.env` file (the launcher that reads those is
 * absent there), so the token is published to `process.env` directly. In the
 * cockpit the variable is already set by the operator and this is a no-op.
 */
export const APP_TOKEN_ENV = 'CROWDY_APP_TOKEN'
/** How long the first project load waits for the page to hand over the token. */
const CREDENTIAL_WAIT_MS = 5_000

function publishTokenToEnvironment(token: string | undefined): void {
  if (!token) return
  if (typeof process === 'undefined' || !process.env) return
  process.env[APP_TOKEN_ENV] = token
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
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

export class CrowdyFileSystem extends FileSystem {
  static Config: z<Config> = z.object({
    graphqlUrl: z.string(),
    appId: z.string(),
    projectId: z.string(),
    root: z.string(),
    appToken: z.string(),
    email: z.string(),
    password: z.string(),
    bridgeChannel: z.string(),
    bridgeNonce: z.string(),
    studioOrigin: z.string(),
    snapshotTtlMs: z.number().default(750),
  }) as unknown as z<Config>

  /** Effective boot configuration (file + environment + row config). */
  boot: CrowdyBootConfig
  /** API client; replaceable in tests, mirroring the local backend's `internals` hook. */
  client: CrowdyStudioClient
  /** In-memory scratch files the page and tools share. */
  readonly scratch = new ScratchStore()
  private readonly root: string
  private readonly snapshotTtl: number

  /** Cached project snapshot; reads may reuse it briefly, mutations never do. */
  private snapshot: { project: ProjectSnapshot; at: number } | undefined
  private inflight: Promise<ProjectSnapshot> | undefined
  private store: ProjectStore | undefined
  /** Per-path tail promise serializing each read-guard-write critical section. */
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Listeners told when the project files changed through this backend. */
  private readonly changeListeners = new Set<(change: { target: CrowdyTarget; path: string }) => void>()
  private readonly warnings: string[] = []
  private readonly warningListeners = new Set<(message: string) => void>()
  /** Resolved (and replaced) each time a bearer arrives over the bridge. */
  private tokenWaiters: Array<() => void> = []

  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    const { snapshotTtlMs, ...overrides } = config
    this.snapshotTtl = snapshotTtlMs ?? 750
    this.boot = loadCrowdyConfig(overrides)
    this.root = normalizeAbsolute(this.boot.root ?? DEFAULT_ROOT)
    publishTokenToEnvironment(this.boot.appToken)
    this.client = new CrowdyStudioClient({
      endpoint: this.boot.graphqlUrl,
      appId: this.boot.appId,
      appToken: this.boot.appToken,
      email: this.boot.email,
      password: this.boot.password,
    })
  }

  // ── bridge hooks ───────────────────────────────────────────────────────────

  /** Virtual root the project is mounted at. */
  get mountRoot(): string {
    return this.root
  }

  /** Human-readable description of where files currently come from (known after the first load). */
  get storeReason(): string | undefined {
    return this.snapshot ? describeSource(this.snapshot.project) : undefined
  }

  /** Point the backend at another project (the page switched projects). */
  setProject(projectId: string): void {
    if (projectId === this.boot.projectId) return
    this.boot = { ...this.boot, projectId }
    this.snapshot = undefined
    this.store = undefined
  }

  /** Replace the bearer after the page refreshed the app token. */
  setToken(token: string | undefined): void {
    this.boot = { ...this.boot, appToken: token }
    this.client.setToken(token)
    publishTokenToEnvironment(token)
    if (token) {
      const waiters = this.tokenWaiters
      this.tokenWaiters = []
      for (const wake of waiters) wake()
    }
  }

  /** Whether a bearer (or cockpit credentials) is available right now. */
  get hasCredentials(): boolean {
    return Boolean(this.boot.appToken || (this.boot.email && this.boot.password))
  }

  /**
   * In the browser the token follows the boot over the bridge rather than
   * riding in `crowdy.json`, so the first project load may run a beat ahead of
   * it. Wait briefly for it instead of failing the model's first tool call.
   */
  private waitForCredentials(timeoutMs: number): Promise<boolean> {
    if (this.hasCredentials) return Promise.resolve(true)
    // Without a page bridge nobody will ever deliver a token; fail now.
    if (!this.boot.bridgeChannel) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.tokenWaiters = this.tokenWaiters.filter((wake) => wake !== wake_)
        resolve(this.hasCredentials)
      }, timeoutMs)
      const wake_ = () => {
        clearTimeout(timer)
        resolve(true)
      }
      this.tokenWaiters.push(wake_)
    })
  }

  /** Subscribe to warnings (store fallbacks, failed mirrors) as they happen. */
  onWarning(listener: (message: string) => void): () => void {
    this.warningListeners.add(listener)
    return () => {
      this.warningListeners.delete(listener)
    }
  }

  private warn(message: string): void {
    if (this.warningListeners.size === 0) {
      this.warnings.push(message)
      return
    }
    for (const listener of this.warningListeners) listener(message)
  }

  /** Subscribe to writes made through this backend. */
  onChange(listener: (change: { target: CrowdyTarget; path: string }) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  /** Drop any cached snapshot so the next read refetches (the page saved). */
  invalidate(): void {
    this.snapshot = undefined
  }

  /** Warnings accumulated since the last drain (mirror failures, fallbacks). */
  drainWarnings(): string[] {
    return this.warnings.splice(0, this.warnings.length)
  }

  // ── identity ───────────────────────────────────────────────────────────────

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    this.assertLive(opts?.signal)
    // Absent files must still resolve: a create needs a target before it exists.
    const absolute = resolveAgainst(this.baseFor(opts?.cwd), path)
    return { targetKey: FsTargetKey(`crowdy:${absolute}`), displayPath: absolute }
  }

  /**
   * Pick the base for relative paths. A session's cwd comes from the host
   * workspace and may point anywhere; resolving against a directory outside
   * the mount would make every relative path a miss, so a foreign cwd falls
   * back to the project root.
   */
  private baseFor(cwd: string | undefined): string {
    if (!cwd) return this.root
    const candidate = normalizeAbsolute(cwd)
    return classify(candidate, this.root) ? candidate : this.root
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

  // ── metadata ───────────────────────────────────────────────────────────────

  async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    this.assertLive(signal)
    const absolute = this.absolute(target)
    const spot = classify(absolute, this.root)
    if (!spot) return undefined

    if (spot.kind === 'root' || spot.kind === 'target' || spot.kind === 'scratch-dir') {
      return { version: DIRECTORY_VERSION, type: 'directory' }
    }
    if (spot.kind === 'scratch-file') {
      const file = this.scratch.get(spot.dir, spot.name)
      return file ? { version: FsVersion(file.version), type: 'file', size: file.bytes.byteLength } : undefined
    }

    const project = await this.project()
    const file = this.find(project, spot.location.target, spot.location.path)
    if (file) {
      return { version: versionOf(file.content), type: 'file', size: byteLength(file.content) }
    }

    // Directories are implied by the paths of the files beneath them.
    const prefix = `${spot.location.path}/`
    const isImpliedDirectory = project.files.some(
      (entry) => entry.target === spot.location.target && entry.path.startsWith(prefix),
    )
    return isImpliedDirectory ? { version: DIRECTORY_VERSION, type: 'directory' } : undefined
  }

  async lstat(
    path: string,
    opts?: { cwd?: string },
    signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    // Crowdy projects have no symlinks, so lstat and stat agree by construction.
    const target = await this.resolve(path, { cwd: opts?.cwd, signal })
    const info = await this.stat(target, signal)
    return info === undefined ? undefined : { ...info }
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    this.assertLive(signal)
    const absolute = this.absolute(target)
    const spot = classify(absolute, this.root)
    if (spot?.kind === 'scratch-file') {
      const file = this.scratch.get(spot.dir, spot.name)
      if (!file) throw new FsError(`${absolute} does not exist.`, 'FS_NOT_FOUND')
      if (file.text === undefined) {
        throw new FsError(`${absolute} is binary; use read_image for screenshots.`, 'FS_NOT_TEXT')
      }
      return file.text
    }
    const { file } = await this.requireFile(target)
    return file.content
  }

  async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // Crowdy caps a file at 64 KiB, so the whole text is always one chunk.
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
      throw new FsError(
        `${this.absolute(target)} is ${bytes.byteLength} bytes, above the ${maxBytes}-byte cap.`,
        'FS_TOO_LARGE',
      )
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
    const absolute = this.absolute(target)
    const spot = classify(absolute, this.root)
    if (spot?.kind === 'scratch-file') {
      const file = this.scratch.get(spot.dir, spot.name)
      if (!file) throw new FsError(`${absolute} does not exist.`, 'FS_NOT_FOUND')
      return file.bytes
    }
    const { file } = await this.requireFile(target)
    return new TextEncoder().encode(file.content)
  }

  async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    this.assertLive(signal)
    const absolute = this.absolute(target)
    const spot = classify(absolute, this.root)
    if (!spot) {
      throw new FsError(`${absolute} is outside the Crowdy project mount.`, 'FS_NOT_FOUND')
    }

    if (spot.kind === 'root') {
      return Promise.all(
        [...targetDirectories(this.root), ...scratchDirectories(this.root)].map(async (path) => ({
          name: path.slice(path.lastIndexOf('/') + 1),
          type: 'directory' as const,
          target: await this.resolve(path),
          version: DIRECTORY_VERSION,
        })),
      )
    }
    if (spot.kind === 'scratch-dir') {
      return Promise.all(
        this.scratch.list(spot.dir).map(async ({ name, file }) => ({
          name,
          type: 'file' as const,
          target: await this.resolve(`${absolute}/${name}`),
          version: FsVersion(file.version),
          size: file.bytes.byteLength,
        })),
      )
    }
    if (spot.kind === 'scratch-file') {
      throw new FsError(`${absolute} is not a directory.`, 'FS_NOT_DIRECTORY')
    }

    const project = await this.project()
    const scope = spot.kind === 'target' ? '' : spot.location.path
    const scopedTarget = spot.kind === 'target' ? spot.target : spot.location.target
    const paths = project.files
      .filter((entry) => entry.target === scopedTarget)
      .map((entry) => entry.path)

    if (spot.kind === 'file' && !paths.some((path) => path.startsWith(`${scope}/`))) {
      throw new FsError(`${absolute} is not a directory.`, 'FS_NOT_DIRECTORY')
    }

    return Promise.all(
      directChildren(paths, scope).map(async (child) => {
        const childPath = scope ? `${scope}/${child.name}` : child.name
        const entry = child.isDirectory ? undefined : this.find(project, scopedTarget, childPath)
        return {
          name: child.name,
          type: child.isDirectory ? ('directory' as const) : ('file' as const),
          target: await this.resolve(toVirtualPath(scopedTarget, childPath, this.root)),
          version: entry ? versionOf(entry.content) : DIRECTORY_VERSION,
          ...(entry ? { size: byteLength(entry.content) } : {}),
        }
      }),
    )
  }

  // ── mutations ──────────────────────────────────────────────────────────────

  async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
  ): Promise<FsWriteOutcome> {
    const location = this.requireWritableLocation(target)
    return this.withLock(target.targetKey, async () => {
      this.assertLive(signal)
      const project = await this.project({ fresh: true })
      const existing = this.find(project, location.target, location.path)

      if (expected?.kind === 'createIfAbsent' && existing) {
        throw new FsError(
          `${target.displayPath} already exists; a guarded create cannot replace it.`,
          'FS_NOT_OBSERVED',
        )
      }
      if (expected?.kind === 'replaceIfVersion') {
        if (!existing) {
          throw new FsError(
            `${target.displayPath} no longer exists, so the guarded replace is stale.`,
            'FS_STALE_VERSION',
          )
        }
        if (versionOf(existing.content) !== expected.version) {
          throw new FsError(
            `${target.displayPath} changed since it was read; re-read it before writing.`,
            'FS_STALE_VERSION',
          )
        }
      }

      await this.commit(project, { upserts: [{ ...location, content }] }, target.displayPath)

      return {
        operation: existing ? ('update' as const) : ('create' as const),
        version: versionOf(content),
        before: existing ? toLf(existing.content) : null,
        after: toLf(content),
      }
    })
  }

  async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    signal?: AbortSignal,
  ): Promise<FsEditOutcome> {
    const location = this.requireWritableLocation(target)
    return this.withLock(target.targetKey, async () => {
      this.assertLive(signal)
      const project = await this.project({ fresh: true })
      const existing = this.find(project, location.target, location.path)
      if (!existing) {
        throw new FsError(`${target.displayPath} does not exist.`, 'FS_NOT_FOUND')
      }

      const before = toLf(existing.content)
      if (expected && versionOf(existing.content) !== expected.version) {
        throw new FsError(
          `${target.displayPath} changed since it was read; re-read it before editing.`,
          'FS_STALE_VERSION',
        )
      }

      const oldString = toLf(edit.oldString)
      const matches = countOccurrences(before, oldString)
      if (matches === 0) {
        throw new FsError(
          `The literal text to replace was not found in ${target.displayPath}.`,
          'FS_EDIT_NOT_FOUND',
        )
      }
      if (matches > 1 && !edit.replaceAll) {
        throw new FsError(
          `The literal text matches ${matches} times in ${target.displayPath}; pass replaceAll or use a longer, unique match.`,
          'FS_AMBIGUOUS_EDIT',
        )
      }

      const newString = toLf(edit.newString)
      const after = edit.replaceAll
        ? before.split(oldString).join(newString)
        : before.replace(oldString, newString)

      await this.commit(project, { upserts: [{ ...location, content: after }] }, target.displayPath)
      return { version: versionOf(after), before, after }
    })
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Apply a batch under the snapshot's revision, translating a lost optimistic
   * race into the harness's stale-version vocabulary so the tool layer can tell
   * the model to re-read rather than reporting an opaque server error.
   */
  private async commit(
    project: ProjectSnapshot,
    batch: {
      upserts?: Array<{ target: CrowdyTarget; path: string; content: string }>
      deletes?: Array<{ target: CrowdyTarget; path: string }>
    },
    displayPath: string,
  ): Promise<void> {
    const store = await this.currentStore()
    try {
      const updated = await store.commit(project, batch)
      this.snapshot = { project: updated, at: Date.now() }
    } catch (error) {
      this.snapshot = undefined
      if (error instanceof CrowdyApiError && error.isRevisionConflict) {
        throw new FsError(
          `${displayPath} was modified concurrently (in Crowdy Studio or on GitHub); re-read it and retry.`,
          'FS_STALE_VERSION',
          { cause: error },
        )
      }
      if (error instanceof CrowdyApiError && error.isAuthFailure) {
        throw new FsError(
          `Crowdy Studio rejected the write to ${displayPath}: the session is no longer valid. Reopen Crowdy Studio to sign in again.`,
          'FS_PERMISSION_DENIED',
          { cause: error },
        )
      }
      throw new FsError(
        `Crowdy Studio rejected the write to ${displayPath}: ${(error as Error).message}`,
        'FS_IO_ERROR',
        { cause: error as Error },
      )
    }
    for (const change of [...(batch.upserts ?? []), ...(batch.deletes ?? [])]) {
      for (const listener of this.changeListeners) listener({ target: change.target, path: change.path })
    }
  }

  /**
   * One coherent view of every project file for the search tools: the virtual
   * mount root plus each file's virtual absolute path and content. Reuses the
   * same snapshot as reads, so glob/grep and read describe the same tree.
   */
  async searchSnapshot(): Promise<{
    root: string
    files: Array<{ virtualPath: string; content: string }>
  }> {
    const project = await this.project()
    const files = project.files.map((entry) => ({
      virtualPath: toVirtualPath(entry.target, entry.path, this.root),
      content: entry.content,
    }))
    for (const dir of ['context'] as const) {
      for (const { name, file } of this.scratch.list(dir)) {
        if (file.text !== undefined) {
          files.push({ virtualPath: `${this.root}/${dir}/${name}`, content: file.text })
        }
      }
    }
    return { root: this.root, files }
  }

  /** The current project snapshot, for tools that want the whole tree. */
  async currentProject(): Promise<ProjectSnapshot> {
    return this.project()
  }

  /** Fetch the project, collapsing bursts and deduping concurrent fetches. */
  private async project(opts: { fresh?: boolean } = {}): Promise<ProjectSnapshot> {
    if (!opts.fresh && this.snapshot && Date.now() - this.snapshot.at < this.snapshotTtl) {
      return this.snapshot.project
    }
    if (!this.inflight) {
      const projectId = this.boot.projectId
      this.inflight = this.waitForCredentials(CREDENTIAL_WAIT_MS)
        .then(() => {
          const missing = describeMissing(this.boot)
          if (missing) throw new FsError(missing, 'FS_IO_ERROR')
          return this.currentStore().load()
        })
        .then((project) => {
          this.snapshot = { project, at: Date.now() }
          return project
        })
        .catch((error: unknown) => {
          if (error instanceof FsError) throw error
          if (error instanceof CrowdyApiError && error.isAuthFailure) {
            throw new FsError(
              `Could not load Crowdy Studio project ${projectId}: the session is no longer valid. Reopen Crowdy Studio to sign in again.`,
              'FS_PERMISSION_DENIED',
              { cause: error },
            )
          }
          throw new FsError(
            `Could not load Crowdy Studio project ${projectId}: ${(error as Error).message}`,
            'FS_IO_ERROR',
            { cause: error as Error },
          )
        })
        .finally(() => {
          this.inflight = undefined
        })
    }
    return this.inflight
  }

  /**
   * The store for the current project. Which path a write takes (Studio
   * revision or GitHub commit) is decided per snapshot by the project's
   * `source`, so there is nothing to re-decide here.
   */
  private currentStore(): ProjectStore {
    if (!this.store) this.store = new CrowdyProjectStore(this.client, this.boot.projectId)
    return this.store
  }

  private find(
    project: ProjectSnapshot,
    target: CrowdyProjectFile['target'],
    path: string,
  ): CrowdyProjectFile | undefined {
    return project.files.find((entry) => entry.target === target && entry.path === path)
  }

  private async requireFile(target: FsTarget) {
    const absolute = this.absolute(target)
    const spot = classify(absolute, this.root)
    if (!spot) {
      throw new FsError(`${absolute} is outside the Crowdy project mount.`, 'FS_NOT_FOUND')
    }
    if (spot.kind !== 'file') {
      throw new FsError(`${absolute} is a directory, not a regular file.`, 'FS_NOT_REGULAR_FILE')
    }
    const project = await this.project()
    const file = this.find(project, spot.location.target, spot.location.path)
    if (!file) {
      throw new FsError(`${absolute} does not exist in the Crowdy project.`, 'FS_NOT_FOUND')
    }
    return { file, location: spot.location }
  }

  /**
   * Reject a write that Crowdy Studio would refuse anyway, so the model gets a
   * precise reason instead of a generic server validation failure.
   */
  private requireWritableLocation(target: FsTarget) {
    const absolute = this.absolute(target)
    const spot = classify(absolute, this.root)
    if (!spot) {
      throw new FsError(
        `${absolute} is outside the Crowdy project mount at ${this.root}.`,
        'FS_SANDBOX_DENIED',
      )
    }
    if (spot.kind === 'scratch-dir' || spot.kind === 'scratch-file') {
      throw new FsError(
        `${absolute} is read-only: captures/ and context/ are filled by Crowdy Studio, not by edits.`,
        'FS_PERMISSION_DENIED',
      )
    }
    if (spot.kind !== 'file') {
      throw new FsError(`${absolute} is a directory and cannot be written.`, 'FS_NOT_REGULAR_FILE')
    }
    if (!isAcceptableProjectPath(spot.location.path)) {
      throw new FsError(
        `Crowdy Studio only stores Cargo.toml or .rs files under src/; ${spot.location.path} is not allowed.`,
        'FS_PERMISSION_DENIED',
      )
    }
    return spot.location
  }

  private absolute(target: FsTarget): string {
    const key = String(target.targetKey)
    return key.startsWith('crowdy:') ? key.slice('crowdy:'.length) : key
  }

  private assertLive(signal?: AbortSignal): void {
    if (signal?.aborted) throw new FsError('The filesystem operation was aborted.', 'FS_ABORTED')
  }

  /** Serialize mutations per path so a read-guard-write window cannot interleave. */
  private async withLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.then(op, op)
    // The tail must not reject, or the next waiter would inherit this failure.
    const tail = run.catch(() => undefined)
    this.locks.set(key, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }
}

export default CrowdyFileSystem
