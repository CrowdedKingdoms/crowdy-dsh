/**
 * Cordis service `ctx.crowdyBridgeClient`: the worker's end of the page
 * channel, on its own. The game filesystem talks to the page through it and
 * so does `ctx.crowdyBridge`; neither depends on the other, which is what
 * keeps the filesystem and the bridge from needing each other at startup.
 *
 * @module @crowdedkingdoms/crowdy-dsh/bridge-client
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { loadCrowdyConfig } from '../crowdy/config.js'
import { BridgeClient } from './client.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    crowdyBridgeClient: CrowdyBridgeClientService
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

export const name = 'crowdy-bridge-client'

export class CrowdyBridgeClientService extends Service {
  static Config: z<Config> = z.object({
    channel: z.string(),
    nonce: z.string(),
    timeoutMs: z.number().default(15_000),
  }) as unknown as z<Config>

  readonly client: BridgeClient

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'crowdyBridgeClient')
    const boot = loadCrowdyConfig()
    this.client = new BridgeClient({
      channel: config.channel ?? boot.bridgeChannel,
      nonce: config.nonce ?? boot.bridgeNonce,
      timeoutMs: config.timeoutMs,
    })
    ctx.effect(() => () => this.client.close(), 'crowdy bridge client')
  }
}

export default CrowdyBridgeClientService
