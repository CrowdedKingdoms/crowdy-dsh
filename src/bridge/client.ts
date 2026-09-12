/**
 * Worker-side half of the page bridge: a request/response and event layer
 * over one `BroadcastChannel`.
 *
 * `BroadcastChannel` is the one same-origin primitive a dedicated worker, the
 * iframe that spawned it, and the embedding Studio page all share without the
 * worker knowing its own port topology. The harness's own tunnel to the iframe
 * is untouched; this channel is separate and ignores frames it did not define.
 *
 * @module @crowdedkingdoms/crowdy-dsh/bridge/client
 */

import {
  BRIDGE_ERROR_CODES,
  CROWDY_BRIDGE_PROTOCOL_VERSION,
  isBridgeFrame,
  type BridgeFrame,
  type BridgeMethod,
  type BridgeRequestMap,
  type PageEvent,
  type PageEventMap,
  type WorkerEvent,
  type WorkerEventMap,
} from './protocol.js'

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

interface ChannelLike {
  postMessage(message: unknown): void
  close(): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

type ChannelFactory = (name: string) => ChannelLike

function defaultChannelFactory(): ChannelFactory | undefined {
  const scope = globalThis as { BroadcastChannel?: new (name: string) => ChannelLike }
  if (typeof scope.BroadcastChannel !== 'function') return undefined
  const ctor = scope.BroadcastChannel
  return (name) => new ctor(name)
}

export interface BridgeClientOptions {
  /** Channel name the page chose; absent means no page (developer cockpit). */
  channel?: string
  /** Boot nonce from the page; frames without it are dropped, frames sent carry it. */
  nonce?: string
  /** Default per-request deadline. Draft tests are slow, so tools pass their own. */
  timeoutMs?: number
  /** Test seam. */
  channelFactory?: ChannelFactory
}

export class BridgeClient {
  private readonly channel: ChannelLike | undefined
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | undefined }
  >()
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()
  private readonly timeoutMs: number
  private readonly nonce: string
  private sequence = 0
  /** Whether a page has said hello since the channel opened. */
  pagePresent = false

  constructor(options: BridgeClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.nonce = options.nonce ?? ''
    const factory = options.channelFactory ?? defaultChannelFactory()
    if (options.channel && !options.nonce) {
      console.warn('crowdy bridge: a channel without a boot nonce; refusing to join (the page must send crowdy.json with bridgeNonce)')
    }
    if (options.channel && options.nonce && factory) {
      this.channel = factory(options.channel)
      this.channel.addEventListener('message', (event) => {
        this.handle(event.data)
      })
    }
  }

  /** True when a channel exists (a page may or may not be listening yet). */
  get available(): boolean {
    return this.channel !== undefined
  }

  on<E extends PageEvent>(event: E, listener: (payload: PageEventMap[E]) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as (payload: unknown) => void)
    return () => {
      set?.delete(listener as (payload: unknown) => void)
    }
  }

  emit<E extends WorkerEvent>(event: E, payload: WorkerEventMap[E]): void {
    if (!this.channel) return
    const frame: BridgeFrame = { v: CROWDY_BRIDGE_PROTOCOL_VERSION, n: this.nonce, from: 'worker', t: 'event', event, payload }
    this.channel.postMessage(frame)
  }

  async request<M extends BridgeMethod>(
    method: M,
    params: BridgeRequestMap[M]['params'],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<BridgeRequestMap[M]['result']> {
    if (!this.channel) {
      throw new BridgeError(
        'This action needs the Crowdy Studio page, which is not connected to the harness (developer cockpit).',
        BRIDGE_ERROR_CODES.unavailable,
      )
    }
    if (!this.pagePresent) {
      throw new BridgeError(
        'Crowdy Studio has not connected to the agent yet. Keep the Studio panel open and retry in a moment.',
        BRIDGE_ERROR_CODES.unavailable,
      )
    }
    options.signal?.throwIfAborted()
    this.sequence += 1
    const id = `w${this.sequence}-${Date.now().toString(36)}`
    const frame: BridgeFrame = { v: CROWDY_BRIDGE_PROTOCOL_VERSION, n: this.nonce, from: 'worker', t: 'req', id, method, params }
    return new Promise<BridgeRequestMap[M]['result']>((resolve, reject) => {
      const timeout = options.timeoutMs ?? this.timeoutMs
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError(`Crowdy Studio did not answer ${method} within ${Math.round(timeout / 1000)}s.`, BRIDGE_ERROR_CODES.timeout))
      }, timeout)
      const onAbort = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new BridgeError(`${method} was cancelled.`, BRIDGE_ERROR_CODES.refused))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          resolve(value as BridgeRequestMap[M]['result'])
        },
        reject: (error) => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      this.channel!.postMessage(frame)
    })
  }

  close(): void {
    for (const entry of this.pending.values()) {
      entry.reject(new BridgeError('The bridge closed.', BRIDGE_ERROR_CODES.unavailable))
    }
    this.pending.clear()
    this.channel?.close()
  }

  private handle(data: unknown): void {
    if (!isBridgeFrame(data, this.nonce) || data.from !== 'page') return
    switch (data.t) {
      case 'res': {
        const entry = this.pending.get(data.id)
        if (!entry) return
        this.pending.delete(data.id)
        entry.resolve(data.result)
        return
      }
      case 'err': {
        const entry = this.pending.get(data.id)
        if (!entry) return
        this.pending.delete(data.id)
        entry.reject(new BridgeError(data.message, data.code || BRIDGE_ERROR_CODES.pageError))
        return
      }
      case 'event': {
        if (data.event === 'page.hello') this.pagePresent = true
        if (data.event === 'page.bye') this.pagePresent = false
        const set = this.listeners.get(data.event)
        if (!set) return
        for (const listener of set) {
          try {
            listener(data.payload)
          } catch (error) {
            console.warn(`crowdy bridge: listener for ${data.event} threw`, error)
          }
        }
        return
      }
      default:
        return
    }
  }
}
