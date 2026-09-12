/**
 * The slice of CrowdyJS the harness plugins use.
 *
 * `tsc` compiles this file to a plain re-export; `scripts/bundle-sdk.mjs` then
 * overwrites `lib/vendor/crowdyjs-sdk.js` with an esbuild bundle of the same
 * names, so the browser-worker image carries only the client, the generated
 * documents and `graphql` — not the Studio editor, Monaco or tree-sitter that
 * CrowdyJS lists as dependencies. Everything else in this package imports the
 * SDK through here and nowhere else.
 *
 * @module @crowdedkingdoms/crowdy-dsh/vendor/crowdyjs-sdk
 */

export { createCrowdyClient, CrowdyGraphQLError } from '@crowdedkingdoms/crowdyjs'
export type { CrowdyClient } from '@crowdedkingdoms/crowdyjs'
export {
  CrowdyStudioProjectCreateDocument,
  CrowdyStudioProjectDocument,
} from '@crowdedkingdoms/crowdyjs/generated'
export type { CrowdyStudioTarget as GeneratedTarget } from '@crowdedkingdoms/crowdyjs/generated'
