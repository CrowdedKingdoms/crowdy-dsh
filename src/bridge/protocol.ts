/**
 * Wire protocol between the harness (running in the browser worker) and the
 * Crowdy Studio page that embeds it. Both sides join one `BroadcastChannel`
 * whose name the page chose and wrote into `crowdy.json`.
 *
 * The page executes anything that needs the game or the Studio editor
 * (screenshots, draft tests, deploys, project switching, game observation); the
 * worker executes file edits and model calls. CrowdyJS mirrors these types in
 * `src/crowdy-dsh/protocol.ts`; keep the two in step.
 *
 * @module @crowdedkingdoms/crowdy-dsh/bridge-protocol
 */

/**
 * v3 (crowdy-dsh 0.3 / CrowdyJS 17): a project carries `source` and
 * `githubSha`. A GITHUB project's files are the server's mirror of the bound
 * repository at that commit; the worker writes them as commits carrying
 * `expectedCommitSha = githubSha` and mirrors nothing back to Studio itself.
 * `page.project` / `page.saved` re-announce the commit whenever it moves so the
 * worker's next write carries the current one.
 */
/**
 * v4 (crowdy-dsh 0.4 / CrowdyJS 17.7, DN-10): grid requests. `grid.context`
 * names the grid the open project is bound to; `grid.programRun` and
 * `grid.programStatus` run a JS grid program from a project file inside it.
 * The page answers them only when its game offers a grid capability.
 */
/**
 * v5 (crowdy-dsh 0.5 / CrowdyJS 18.23): game mode. A boot with
 * `studioMode: 'game'` edits the bound Construct game, not the mod crates. The
 * page owns a draft of the repository; the worker reads it as a snapshot
 * (`draft.tree`, batched `draft.read`), writes under the harness's own write
 * preconditions (`draft.write` / `draft.delete`), and learns of every other
 * change from `page.draftChanged`. `draft.commit` publishes the draft as ONE
 * commit with the agent's message after the player confirms on the page;
 * `preview.status` reports whether the world took the draft. Versions are git
 * blob SHA-1 hashes, so an unchanged draft file hashes to its GitHub blob.
 * `worker.ready` names the modes the worker can mount; a page that booted
 * game mode against a worker without it keeps the mod editor. The v4 game
 * requests (`studio.putGameFile`, `listRepo`, ...) were never published.
 */
export const CROWDY_BRIDGE_PROTOCOL_VERSION = 5 as const

/** Which Studio editor a boot mounts. Fixed for the life of the worker. */
export type StudioMode = 'mod' | 'game'

export type BridgeSide = 'page' | 'worker'

/**
 * Envelope: every frame carries the protocol version, the boot nonce `n` and
 * the sender. A `BroadcastChannel` is open to every same-origin script, so
 * both sides drop any frame whose nonce is not the one the page handed the
 * worker in the boot message.
 */
export type BridgeFrame =
  | { v: typeof CROWDY_BRIDGE_PROTOCOL_VERSION; n: string; from: BridgeSide; t: 'req'; id: string; method: string; params: unknown }
  | { v: typeof CROWDY_BRIDGE_PROTOCOL_VERSION; n: string; from: BridgeSide; t: 'res'; id: string; result: unknown }
  | { v: typeof CROWDY_BRIDGE_PROTOCOL_VERSION; n: string; from: BridgeSide; t: 'err'; id: string; code: string; message: string }
  | { v: typeof CROWDY_BRIDGE_PROTOCOL_VERSION; n: string; from: BridgeSide; t: 'event'; event: string; payload: unknown }

// ── Requests the worker sends; the page answers ──────────────────────────────

export interface ScreenshotResult {
  /** Suggested file name, e.g. `capture-0003.png`. */
  name: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  /** Encoded bytes (structured-cloned, not transferred). */
  bytes: ArrayBuffer
  width: number
  height: number
  /** What was on screen, in the page's words (HUD text, phase). */
  caption?: string
}

export interface StudioDiagnostic {
  target: 'SERVER' | 'CLIENT'
  path: string
  line?: number
  column?: number
  severity: 'error' | 'warning' | 'info'
  message: string
}

export interface RuntimeStatus {
  target: 'SERVER' | 'CLIENT'
  phase: string
  moduleName?: string
  runningRevision?: string
  savedRevision?: string
  message?: string
}

export interface BuildResult {
  ok: boolean
  /** `draft` or `live`. */
  mode: 'draft' | 'live'
  summary: string
  diagnostics: StudioDiagnostic[]
  /** Compiler output, truncated by the page. */
  buildLog: string
  runtime: RuntimeStatus[]
  /** Set when the page captured the game after the client target started. */
  screenshot?: ScreenshotResult
}

export type ProjectSource = 'STUDIO' | 'GITHUB'

export interface ProjectSummary {
  projectId: string
  name: string
  kind: string
  updatedAt: string
  /** Where the files are authored. GITHUB means the repository is the working tree. */
  source: ProjectSource
  /** Commit the GITHUB project mirrors; null for a STUDIO project. */
  githubSha: string | null
  /** Bound repository label (`owner/repo@branch`) when the project is GitHub-bound. */
  github?: string
}

export interface ProjectListResult {
  projects: ProjectSummary[]
  currentProjectId: string | null
}

export interface ProjectOpenResult {
  project: ProjectSummary
}

export interface ProjectCreateParams {
  name: string
  /** Template id from the Studio starter catalog; omitted means the blank full-stack template. */
  template?: string
}

export interface LogLinesResult {
  lines: string[]
  truncated: boolean
}

export interface GameObservationResult {
  /** Structured observation as the game's PlayerHost reports it. */
  observation: unknown
  capturedAt: string
}

/** Method names with their parameter and result shapes. */
/** The grid the open project is bound to (v4). */
export interface GridContext {
  appId: string
  gridId: string
  low: { x: string; y: string; z: string }
  high: { x: string; y: string; z: string }
  owned: boolean
  channels: Array<{ groupId: string; name: string }>
  sessions: Array<{ sessionId: string; name: string | null; status: string }>
}

/** One JS grid program the page is running (v4). */
export interface GridProgramStatus {
  path: string
  running: boolean
  startedAt?: string
  lastError?: string
  log: string[]
}

// ── Game mode: the draft of the bound repository (v5) ───────────────────────

/** One file of the draft as the page serves it. */
export interface DraftEntry {
  /** Repository-relative path. */
  path: string
  /** Git blob SHA-1 of the content (`blob <bytes>\0<content>`). */
  hash: string
  /** Bytes. */
  size: number
  /** Not UTF-8 text, or larger than the page serves as text: listed, never readable. */
  binary: boolean
  /** Differs from the base commit (written, created, or deleted in the draft). */
  dirty: boolean
}

export interface DraftTree {
  /** Commit the draft is based on; null for a store with no remote base. */
  baseCommitSha: string | null
  /** Bumps on every draft change; `page.draftChanged` carries it. */
  revision: number
  entries: DraftEntry[]
  /** Paths deleted in the draft that still exist at the base. */
  deleted: string[]
  /** Entries were dropped because the tree is larger than the page serves. */
  truncated: boolean
}

/** A write precondition, mapped from the harness's guarded-write intent. */
export type DraftPrecondition = { kind: 'createIfAbsent' } | { kind: 'ifHash'; hash: string }

export interface DraftFileText {
  path: string
  hash: string
  content: string
}

export interface DraftWriteResult {
  path: string
  hash: string
  /** Hash before the write; null when the write created the file. */
  previousHash: string | null
  revision: number
}

export interface DraftCommitResult {
  commitSha: string
  /** Paths written or deleted by the commit. */
  committed: string[]
  /** The new base commit. */
  baseCommitSha: string
}

export interface PreviewStatus {
  /** Draft revision the running world reflects. */
  revision: number
  ok: boolean
  /** Scene id the world shows. */
  scene?: string
  errors: Array<{ path?: string; line?: number; column?: number; message: string }>
  /** Shown when the game cannot preview this file (outside its content layer). */
  note?: string
}

export interface SkillSummary {
  name: string
  description: string
  /** Playbook page that holds the body, e.g. `skills/<name>/SKILL.md`. */
  page: string
}

/** Stable `err` codes the page answers draft requests with. */
export const DRAFT_ERROR_CODES = {
  /** An `ifHash` or `createIfAbsent` precondition failed. */
  stale: 'DRAFT_STALE',
  notFound: 'DRAFT_NOT_FOUND',
  /** The path is outside what the dock may touch. */
  refused: 'DRAFT_PATH_REFUSED',
  tooLarge: 'DRAFT_TOO_LARGE',
  /** The branch moved and these paths changed on both sides. */
  conflict: 'DRAFT_CONFLICT',
  /** The player declined the commit. */
  declined: 'DRAFT_DECLINED',
  /** This page or project has no draft (mod mode, unbound project). */
  unavailable: 'DRAFT_UNAVAILABLE',
} as const

export interface BridgeRequestMap {
  'studio.screenshot': { params: { label?: string }; result: ScreenshotResult }
  'studio.draftTest': { params: Record<string, never>; result: BuildResult }
  'studio.deployLive': { params: Record<string, never>; result: BuildResult }
  'studio.runtimeStatus': { params: Record<string, never>; result: { runtime: RuntimeStatus[] } }
  'studio.runtimeLogs': { params: { limit?: number }; result: LogLinesResult }
  'studio.clientLogs': { params: { limit?: number }; result: LogLinesResult }
  'studio.projectList': { params: Record<string, never>; result: ProjectListResult }
  'studio.projectOpen': { params: { projectId: string }; result: ProjectOpenResult }
  'studio.projectCreate': { params: ProjectCreateParams; result: ProjectOpenResult }
  'game.observe': { params: Record<string, never>; result: GameObservationResult }
  'grid.context': { params: Record<string, never>; result: { grid: GridContext | null } }
  'grid.programRun': { params: { path: string; stop?: boolean }; result: { program: GridProgramStatus } }
  'grid.programStatus': { params: Record<string, never>; result: { programs: GridProgramStatus[] } }
  'studio.readPlaybook': { params: { page: string }; result: { text: string } }
  'studio.listSkills': { params: Record<string, never>; result: { skills: SkillSummary[] } }
  'draft.tree': { params: Record<string, never>; result: DraftTree }
  /** `binary` lists requested paths that exist but are not text. */
  'draft.read': { params: { paths: string[] }; result: { files: DraftFileText[]; missing: string[]; binary: string[] } }
  'draft.write': { params: { path: string; content: string; precondition?: DraftPrecondition }; result: DraftWriteResult }
  /** No harness tool deletes yet (dsh-fs has no remove); this is the guarded channel when one does. */
  'draft.delete': {
    params: { path: string; precondition?: { kind: 'ifHash'; hash: string } }
    result: { path: string; previousHash: string; revision: number }
  }
  /** Confirmed with the player on the page; the commit message is the agent's. */
  'draft.commit': { params: { message: string; paths?: string[] }; result: DraftCommitResult }
  'preview.status': { params: { afterRevision?: number; timeoutMs?: number }; result: PreviewStatus }
}

export type BridgeMethod = keyof BridgeRequestMap

// ── Events ───────────────────────────────────────────────────────────────────

/** Events the page emits. */
export interface PageEventMap {
  /** Page joined the channel or reloaded its state. */
  'page.hello': {
    appId: string
    projectId: string | null
    appToken?: string
    source?: ProjectSource
    githubSha?: string | null
  }
  'page.token': { appToken: string }
  /** The open project changed, or a GITHUB project's commit moved (bind, refresh, save). */
  'page.project': { projectId: string | null; source?: ProjectSource; githubSha?: string | null }
  /** The page saved the project itself; cached snapshots are stale. */
  'page.saved': { revision?: string; githubSha?: string | null }
  /** Shared context the model may read under `context/`. */
  'page.context': {
    observation?: unknown
    clientLogs?: string[]
    diagnostics?: StudioDiagnostic[]
    runtime?: RuntimeStatus[]
    note?: string
  }
  /** A capture the player took from the pane header. */
  'page.capture': ScreenshotResult
  /**
   * Text the page wants the agent to work on (e.g. "Fix with AI" from a
   * diagnostic). Queued into the most recent live session, or a new one.
   */
  'page.prompt': { text: string; mode?: 'queue' | 'steer' }
  /** The page is going away; tools should fail fast. */
  'page.bye': Record<string, never>
  /**
   * The draft changed (v5). `hash: null` is a deletion. Every change is
   * announced, the agent's own writes included, so a snapshot never trails.
   */
  'page.draftChanged': {
    revision: number
    baseCommitSha: string | null
    changes: Array<{ path: string; hash: string | null }>
    source: 'player' | 'agent' | 'commit' | 'rebase' | 'reload'
  }
}

/** Events the worker emits. */
export interface WorkerEventMap {
  /** `modes` lists what this worker can mount and `mode` what it mounted (v5). */
  'worker.ready': { root: string; store?: string; modes?: StudioMode[]; mode?: StudioMode }
  /** Mod mode: the worker changed a project file. Game-mode writes are announced by the page. */
  'worker.fileChanged': { target: 'SERVER' | 'CLIENT'; path: string }
  'worker.warning': { message: string }
  /** Ask the editor to reveal a file, e.g. from a diagnostic the model cited. */
  'worker.openFile': { target: 'SERVER' | 'CLIENT' | 'REPO'; path: string; line?: number }
}

export type PageEvent = keyof PageEventMap
export type DraftChangedPayload = PageEventMap['page.draftChanged']
export type WorkerEvent = keyof WorkerEventMap

export const BRIDGE_ERROR_CODES = {
  unavailable: 'BRIDGE_UNAVAILABLE',
  timeout: 'BRIDGE_TIMEOUT',
  refused: 'BRIDGE_REFUSED',
  pageError: 'PAGE_ERROR',
} as const

export function isBridgeFrame(value: unknown, nonce?: string): value is BridgeFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<BridgeFrame>
  if (frame.v !== CROWDY_BRIDGE_PROTOCOL_VERSION || typeof frame.n !== 'string' || typeof frame.t !== 'string') return false
  if (frame.from !== 'page' && frame.from !== 'worker') return false
  return nonce === undefined || frame.n === nonce
}
