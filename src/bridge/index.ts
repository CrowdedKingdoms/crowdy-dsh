/**
 * Cordis service `ctx.crowdyBridge`: the harness's link to the Crowdy Studio
 * page. It joins the page's `BroadcastChannel`, keeps the filesystem backend's
 * token and project in step with the page, mirrors page-shared context into
 * the `context/` and `captures/` scratch directories, and lets tools ask the
 * page to run a draft test, take a screenshot, or switch projects.
 *
 * @module @crowdedkingdoms/crowdy-dsh/bridge
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent'

import { CrowdyFileSystem } from '../fs/crowdy-file-system.js'
import type { ScratchFile } from '../fs/scratch-store.js'
import { BridgeClient, BridgeError } from './client.js'
import type { ScreenshotResult, StudioDiagnostic, RuntimeStatus } from './protocol.js'

export { BridgeClient, BridgeError } from './client.js'
export * from './protocol.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    crowdyBridge: CrowdyBridge
  }
}

export interface Config {
  /** Override the channel name from `crowdy.json` (tests). */
  channel?: string
  /** Override the boot nonce from `crowdy.json` (tests). */
  nonce?: string
  /** Default request deadline in milliseconds. */
  timeoutMs?: number
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'crowdy-bridge'

export class CrowdyBridge extends Service {
  static inject = ['fs']
  static Config: z<Config> = z.object({
    channel: z.string(),
    nonce: z.string(),
    timeoutMs: z.number().default(15_000),
  }) as unknown as z<Config>

  readonly client: BridgeClient
  readonly fs: CrowdyFileSystem
  private captureCounter = 0
  private readonly disposers: Array<() => void> = []

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'crowdyBridge')
    const fs = ctx.fs
    if (!(fs instanceof CrowdyFileSystem)) {
      throw new Error('crowdy-bridge: ctx.fs must be the Crowdy filesystem backend (@crowdedkingdoms/crowdy-dsh/fs).')
    }
    this.fs = fs
    this.client = new BridgeClient({
      channel: config.channel ?? fs.boot.bridgeChannel,
      nonce: config.nonce ?? fs.boot.bridgeNonce,
      timeoutMs: config.timeoutMs,
    })
    this.wire()
    // Registrations unwind with the plugin: the channel closes and the fs
    // listeners detach when the row unloads.
    ctx.effect(() => () => {
      for (const dispose of this.disposers) dispose()
      this.disposers.length = 0
      this.client.close()
    }, 'crowdy bridge')
  }

  /** Whether a Studio page is attached (page-executed tools can work). */
  get pageConnected(): boolean {
    return this.client.available && this.client.pagePresent
  }

  /** Store a capture under `captures/` and return its virtual path. */
  putCapture(shot: ScreenshotResult): { path: string; file: ScratchFile } {
    this.captureCounter += 1
    const extension = shot.mediaType === 'image/jpeg' ? 'jpg' : shot.mediaType === 'image/webp' ? 'webp' : 'png'
    const name = shot.name && /^[\w.-]+$/.test(shot.name) ? shot.name : `capture-${String(this.captureCounter).padStart(4, '0')}.${extension}`
    const file = this.fs.scratch.putBytes('captures', name, new Uint8Array(shot.bytes))
    if (shot.caption) this.fs.scratch.putText('captures', `${name}.txt`, shot.caption)
    return { path: `${this.fs.mountRoot}/captures/${name}`, file }
  }

  /** Store page-shared context as readable files under `context/`. */
  putContext(payload: {
    observation?: unknown
    clientLogs?: string[]
    diagnostics?: StudioDiagnostic[]
    runtime?: RuntimeStatus[]
    note?: string
  }): string[] {
    const written: string[] = []
    const put = (name: string, text: string) => {
      this.fs.scratch.putText('context', name, text)
      written.push(`${this.fs.mountRoot}/context/${name}`)
    }
    if (payload.observation !== undefined) put('game-observation.json', JSON.stringify(payload.observation, null, 2))
    if (payload.clientLogs) put('client-logs.txt', payload.clientLogs.join('\n'))
    if (payload.diagnostics) put('diagnostics.json', JSON.stringify(payload.diagnostics, null, 2))
    if (payload.runtime) put('runtime.json', JSON.stringify(payload.runtime, null, 2))
    if (payload.note) put('note.txt', payload.note)
    return written
  }

  /**
   * Queue text into the player's current session: the most recently created
   * live agent, or a fresh session in the project mount when none is live.
   * Uses the same host controller the web client's composer goes through, so
   * the message shows up in the pane like a typed one.
   */
  async promptAgent(text: string, mode: 'queue' | 'steer'): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    const sessions = this.ctx.get('sessionController')
    if (!sessions) throw new Error('no session controller in this composition')
    const agents = this.ctx.get('agents')
    const live = agents?.list() ?? []
    let sessionId = live.length > 0 ? live[live.length - 1]!.session.id : undefined
    if (sessionId === undefined) {
      const created = await sessions.create({ cwd: this.fs.mountRoot, agentPreset: 'crowdy' })
      sessionId = created.sessionId
    }
    await sessions.prompt(
      {
        requestId: `crowdy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` as never,
        sessionId,
        mode,
        content: [{ type: 'text', text: trimmed }],
      },
      new AbortController().signal,
    )
  }

  private wire(): void {
    const { client, fs } = this
    if (!client.available) return
    this.disposers.push(
      client.on('page.hello', (payload) => {
        if (payload.appToken) fs.setToken(payload.appToken)
        if (payload.projectId) fs.setProject(payload.projectId)
        fs.invalidate()
        client.emit('worker.ready', { root: fs.mountRoot, ...(fs.storeReason ? { store: fs.storeReason } : {}) })
      }),
      client.on('page.token', (payload) => {
        // Also republishes CROWDY_APP_TOKEN, which the model route reads per request.
        fs.setToken(payload.appToken)
      }),
      client.on('page.project', (payload) => {
        if (payload.projectId) fs.setProject(payload.projectId)
        // Same project, moved commit (bind, refresh, or a Studio save on a
        // bound project): the snapshot is behind the mirror.
        fs.invalidate()
      }),
      client.on('page.saved', () => {
        fs.invalidate()
      }),
      client.on('page.context', (payload) => {
        this.putContext(payload)
      }),
      client.on('page.capture', (payload) => {
        this.putCapture(payload)
      }),
      client.on('page.prompt', (payload) => {
        void this.promptAgent(payload.text, payload.mode ?? 'queue').catch((error: unknown) => {
          client.emit('worker.warning', {
            message: `The prompt from Crowdy Studio was not delivered: ${error instanceof Error ? error.message : String(error)}`,
          })
        })
      }),
      fs.onChange((change) => {
        client.emit('worker.fileChanged', change)
      }),
      // A GitHub->Studio fallback or a failed mirror is the player's business:
      // the page shows it in the pane instead of it sitting in a buffer.
      fs.onWarning((message) => {
        client.emit('worker.warning', { message })
      }),
    )
    for (const message of fs.drainWarnings()) client.emit('worker.warning', { message })
    // Announce so a page that connected before the worker booted learns we exist.
    client.emit('worker.ready', { root: fs.mountRoot })
  }
}

export default CrowdyBridge
