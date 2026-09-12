/**
 * Closed-world crowdy-compute-sdk index plugin.
 *
 * @module @crowdy/dsh-cockpit/sdk-index
 */

export { apply, Config, inject, name } from './plugin.js'
export type { Config as SdkIndexConfig } from './plugin.js'
export {
  formatLookup,
  formatSdkPrompt,
  GAME_CONTEXT_LOOKUP_NOTE,
  isHarnessGameContextLookup,
  lookupSdkName,
  nearestEntries,
  nameSimilarity,
  SDK_ALIASES,
} from './catalog.js'
export type { SdkLookupHit } from './catalog.js'
export { parseCrowdyComputeSdk, qualifiedName } from './parse-sdk.js'
export type { SdkEntry, SdkModule } from './parse-sdk.js'
export { SDK_SNAPSHOT, SDK_SNAPSHOT_VERSION } from './snapshot.js'
