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
export const CROWDY_BRIDGE_PROTOCOL_VERSION = 3 as const

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
}

/** Events the worker emits. */
export interface WorkerEventMap {
  'worker.ready': { root: string; store?: string }
  'worker.fileChanged': { target: 'SERVER' | 'CLIENT'; path: string }
  'worker.warning': { message: string }
  /** Ask the editor to reveal a file, e.g. from a diagnostic the model cited. */
  'worker.openFile': { target: 'SERVER' | 'CLIENT'; path: string; line?: number }
}

export type PageEvent = keyof PageEventMap
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
