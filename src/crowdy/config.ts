/**
 * Boot configuration shared by every Crowdy plugin.
 *
 * Two hosts run these plugins:
 *
 *   - the **browser worker image** embedded by Crowdy Studio, where the page
 *     writes `$DSH_HOME/crowdy.json` into the worker's virtual filesystem as a
 *     pre-boot overlay before the harness tree mounts;
 *   - the **developer cockpit** (`dsh web --patch profile/crowdy-node.patch.yml`
 *     on Node 22), where the same keys arrive as `CROWDY_*` environment
 *     variables.
 *
 * Both hosts converge here. Environment wins over the file so a developer can
 * override one field without editing the overlay.
 *
 * @module @crowdedkingdoms/crowdy-dsh/crowdy/config
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** File the page-side bridge writes into the worker's `$DSH_HOME`. */
export const CROWDY_CONFIG_FILENAME = 'crowdy.json'

export interface CrowdyBootConfig {
  /** GraphQL endpoint of the game API serving Crowdy Studio. */
  graphqlUrl: string
  /** App tenant id (a GraphQL BigInt carried as a decimal string). */
  appId: string
  /** Project whose files become the agent's filesystem. */
  projectId: string
  /**
   * App-scoped bearer. In the browser it arrives ONLY over the bridge
   * (`page.hello` / `page.token`) and is held in memory; the page never writes
   * it into `crowdy.json`. In the cockpit it is `CROWDY_APP_TOKEN`.
   */
  appToken?: string
  /** Fallback credentials for the cockpit only (never present in the browser). */
  email?: string
  password?: string
  /** Virtual mount point for the project trees. */
  root?: string
  /**
   * Name of the `BroadcastChannel` the Studio page listens on. Absent in the
   * cockpit, where there is no page and page-executed tools are unavailable.
   */
  bridgeChannel?: string
  /** One-time secret the page put in the boot message; every bridge frame carries it. */
  bridgeNonce?: string
  /** Studio origin used to render wallet links in tool messages. */
  studioOrigin?: string
  /** OPFS scope for session persistence (browser only); see `./persist`. */
  persistScope?: string
}

const ENV_KEYS: Record<keyof CrowdyBootConfig, string> = {
  graphqlUrl: 'CROWDY_GRAPHQL_URL',
  appId: 'CROWDY_APP_ID',
  projectId: 'CROWDY_PROJECT_ID',
  appToken: 'CROWDY_APP_TOKEN',
  email: 'CROWDY_EMAIL',
  password: 'CROWDY_PASSWORD',
  root: 'CROWDY_MOUNT',
  bridgeChannel: 'CROWDY_BRIDGE_CHANNEL',
  bridgeNonce: 'CROWDY_BRIDGE_NONCE',
  studioOrigin: 'CROWDY_STUDIO_ORIGIN',
  persistScope: 'CROWDY_PERSIST_SCOPE',
}

function readFile(home: string | undefined): Partial<CrowdyBootConfig> {
  if (!home) return {}
  try {
    const text = readFileSync(join(home, CROWDY_CONFIG_FILENAME), 'utf8')
    const parsed = JSON.parse(text) as Partial<CrowdyBootConfig>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Resolve the boot configuration from `$DSH_HOME/crowdy.json` and the
 * environment. Missing required fields are reported together so the first
 * failed tool call names every problem at once.
 */
export function loadCrowdyConfig(overrides: Partial<CrowdyBootConfig> = {}): CrowdyBootConfig {
  const env = process.env
  const file = readFile(env.DSH_HOME)
  const pick = <K extends keyof CrowdyBootConfig>(key: K): CrowdyBootConfig[K] | undefined => {
    const fromEnv = env[ENV_KEYS[key]]
    if (fromEnv !== undefined && fromEnv !== '') {
      return fromEnv as CrowdyBootConfig[K]
    }
    if (overrides[key] !== undefined) return overrides[key]
    return file[key]
  }
  const graphqlUrl = pick('graphqlUrl') ?? 'http://localhost:3000/graphql'
  const config: CrowdyBootConfig = {
    graphqlUrl,
    appId: pick('appId') ?? '0',
    projectId: pick('projectId') ?? '',
    appToken: pick('appToken'),
    email: pick('email'),
    password: pick('password'),
    root: pick('root'),
    bridgeChannel: pick('bridgeChannel'),
    bridgeNonce: pick('bridgeNonce'),
    studioOrigin: pick('studioOrigin'),
    persistScope: pick('persistScope'),
  }
  return config
}

/** Human-readable reason the configuration cannot reach a project yet. */
export function describeMissing(config: CrowdyBootConfig): string | undefined {
  const missing: string[] = []
  if (!config.appId || config.appId === '0') missing.push('appId')
  if (!config.projectId) missing.push('projectId')
  if (!config.appToken && !(config.email && config.password)) missing.push('appToken')
  if (missing.length === 0) return undefined
  return `Crowdy Studio is not connected yet (missing ${missing.join(', ')}). Open a project in Crowdy Studio and try again.`
}
