/**
 * Closed-world `crowdy-compute-sdk` catalog: lookup, aliases, and the
 * system-prompt section the agent reads instead of guessing names.
 */

import { qualifiedName, type SdkEntry } from './parse-sdk.js'

export interface SdkLookupHit {
  found: boolean
  query: string
  /** Exact catalog entry when `found`. */
  match?: SdkEntry
  /** Alias mapping that fired (`emit` → emit_event / emit_channel / …). */
  viaAlias?: string
  /** Nearby real names when the query is not in the catalog. */
  nearest: SdkEntry[]
  note: string
}

/**
 * Invented names the agent has already reached for. Values are catalog
 * function names (unqualified). Keep this list curated; the parser cannot
 * know what the model will hallucinate.
 */
export const SDK_ALIASES: Readonly<Record<string, readonly string[]>> = {
  emit: ['emit_event', 'emit_channel', 'emit_spatial'],
  spawn: ['voxel_set'],
  'crowdy::spawn': ['voxel_set'],
  host_place_block: ['voxel_set'],
  place_block: ['voxel_set'],
  set_block: ['voxel_set'],
}

const FORBIDDEN_CRATES = ['glam']

/** Harness tool, not a WASM host function. Looking it up in the SDK is the miss. */
export const GAME_CONTEXT_LOOKUP_NOTE =
  'game_context is the Harness tool, not a crowdy::api function and not a host_call name. ' +
  'Call the `game_context` tool to read the live current chunk and block catalog. ' +
  'Place blocks with crowdy::api::voxel_set using that chunk (SERVER only). ' +
  'A disco ball is SERVER voxel_set of dirt/sand/stone in a sphere near the TOP of the claimed chunk; shine and mock rays are CLIENT mesh_asset_spawn disco_rig, not wool/gold. ' +
  'Do not write crowdy::host_call("game_context") or crowdy::api::game_context.'

export const PLUGIN_HOST_LOOKUP_NOTE =
  'Disco look and held meshes are CLIENT host_call, not crowdy::api. ' +
  'Appearance: crowdy::host_call("grid_skin_set", json!({ "remap": { "1": { "all": "mod_slot_00" }, "2": { "all": "mod_slot_00", "emission": 10 }, "3": { "all": "mod_slot_00" }, "6": { "all": "mod_slot_00", "emission": 8 } }, "paint": [{ "slot": 0, "fill": "#1a1a1a", "speckle": "#ffe066", "speckleCount": 28, "seed": 0 }] })). ' +
  'Shimmer: CLIENT on_tick re-calls grid_skin_set with the same remap and a cycling paint.seed (and fill/speckle). Keep emission stable. ' +
  'A disco ball in the sky is SERVER crowdy::api::voxel_set of dirt/sand/stone (ids 2,6,3) radius-3 near local y 12–14 of the current claimed chunk. Keep the floor. Do not voxel_set wool/gold. ' +
  'Shine + mock rays: CLIENT mesh_asset_register { id:"disco", kind:"primitive", primitive:{ shape:"disco_rig" } } then mesh_asset_spawn { id:"disco", pose:{ x, y, z, yaw } } at the ball. on_tick re-spawns the same id with cycling pose.yaw. Not ray-traced lights and not voxel_set columns. Keep grid_skin_set shimmer on the floor. ' +
  'Uploaded glTF: call Harness tool mesh_artifacts, then CLIENT mesh_asset_register { id, kind:"gltf", artifactHash } and mesh_asset_spawn. Never embed bytes. ' +
  'Bow: crowdy::host_call("mesh_asset_register", json!({ "id": "bow", "kind": "primitive", "primitive": { "shape": "bow_placeholder" } })) then mesh_asset_attach { "id": "bow", "anchor": "hand" }. ' +
  'CLIENT cannot voxel_set in Blocks with Friends.'

const PLUGIN_HOST_LOOKUPS = new Set([
  'grid_skin_set',
  'grid_skin_clear',
  'mesh_asset_register',
  'mesh_asset_attach',
  'mesh_asset_spawn',
  'mesh_asset_clear',
  'mechanics_emit',
  'disco',
  'disco_skin',
  'disco_ball',
  'disco_ray',
  'disco_rig',
  'rays',
  'shimmer',
  'restyle',
  'skin',
  'gltf',
  'artifactHash',
  'mesh_artifacts',
  'bow',
  'bow_placeholder',
])

export function isPluginHostLookup(raw: string, query = ''): boolean {
  const normalized = query || raw
  if (PLUGIN_HOST_LOOKUPS.has(normalized)) return true
  return /host_call\s*\(\s*["'](?:grid_skin_set|mesh_asset_register|mesh_asset_attach|mesh_asset_spawn|mechanics_emit)["']/i.test(raw)
}

export function isHarnessGameContextLookup(raw: string, query = ''): boolean {
  const normalized = query || raw
  if (normalized === 'game_context') return true
  return /host_call\s*\(\s*["']game_context["']/i.test(raw)
}

function normalizeQuery(raw: string): string {
  return raw
    .trim()
    .replace(/^:+/u, '')
    .replace(/^(?:crowdy::api::|crowdy::)/u, '')
    .replace(/\(.*$/u, '')
    .trim()
}

function byName(catalog: readonly SdkEntry[], name: string): SdkEntry | undefined {
  return catalog.find((entry) => entry.name === name)
}

/** Dice coefficient on character bigrams — enough for `emit` vs `emit_event`. */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return a.includes(b) || b.includes(a) ? 0.4 : 0
  const grams = (value: string): string[] => {
    const out: string[] = []
    for (let i = 0; i < value.length - 1; i += 1) out.push(value.slice(i, i + 2))
    return out
  }
  const left = grams(a)
  const right = new Map<string, number>()
  for (const g of grams(b)) right.set(g, (right.get(g) ?? 0) + 1)
  let hits = 0
  for (const g of left) {
    const n = right.get(g) ?? 0
    if (n > 0) {
      hits += 1
      right.set(g, n - 1)
    }
  }
  return (2 * hits) / (left.length + grams(b).length)
}

export function nearestEntries(
  catalog: readonly SdkEntry[],
  query: string,
  limit = 3,
): SdkEntry[] {
  return [...catalog]
    .map((entry) => ({ entry, score: nameSimilarity(query, entry.name) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map((row) => row.entry)
}

/**
 * Resolve a rustc / agent name against the catalog. Exact hits win;
 * then curated aliases; then nearest real names. Never invents a function.
 */
export function lookupSdkName(catalog: readonly SdkEntry[], raw: string): SdkLookupHit {
  const query = normalizeQuery(raw)
  if (!query) {
    return {
      found: false,
      query: raw,
      nearest: [],
      note: 'empty name — pass the identifier rustc could not find',
    }
  }
  if (FORBIDDEN_CRATES.includes(query)) {
    return {
      found: false,
      query,
      nearest: [],
      note:
        'glam is forbidden in Crowdy Studio crates. Do not add it to Cargo.toml. ' +
        'Use only functions in this catalog.',
    }
  }

  if (isHarnessGameContextLookup(raw, query)) {
    const voxel = byName(catalog, 'voxel_set')
    return {
      found: false,
      query,
      nearest: voxel ? [voxel] : [],
      note: GAME_CONTEXT_LOOKUP_NOTE,
    }
  }

  if (isPluginHostLookup(raw, query)) {
    return {
      found: false,
      query,
      nearest: [],
      note: PLUGIN_HOST_LOOKUP_NOTE,
    }
  }

  const exact = byName(catalog, query)
  if (exact) {
    return {
      found: true,
      query,
      match: exact,
      nearest: [],
      note: `${qualifiedName(exact)} is in the catalog.`,
    }
  }

  const aliasTargets = SDK_ALIASES[query] ?? SDK_ALIASES[raw.trim()]
  if (aliasTargets) {
    const mapped = aliasTargets
      .map((name) => byName(catalog, name))
      .filter((entry): entry is SdkEntry => entry !== undefined)
    return {
      found: false,
      query,
      viaAlias: query,
      nearest: mapped,
      note:
        `${query} is not a crowdy-compute-sdk function. Use ` +
        `${mapped.map(qualifiedName).join(' / ') || 'a listed function'} instead.`,
    }
  }

  const nearest = nearestEntries(catalog, query)
  return {
    found: false,
    query,
    nearest,
    note:
      `${query} is not in the catalog. Do not invent crowdy::api::${query}. ` +
      (nearest.length > 0
        ? `Nearest real functions: ${nearest.map(qualifiedName).join(', ')}.`
        : 'Remove the call and leave a TODO if no listed function matches.'),
  }
}

export function formatLookup(hit: SdkLookupHit): string {
  const lines = [hit.note]
  const show = hit.match ? [hit.match] : hit.nearest
  for (const entry of show) {
    lines.push('')
    lines.push(qualifiedName(entry))
    lines.push(`  ${entry.signature}`)
    if (entry.doc) lines.push(`  ${entry.doc}`)
  }
  return lines.join('\n')
}

const RULES = [
  'Closed-world SDK. Only the functions below exist on `crowdy` / `crowdy::api`.',
  'Do not invent names (`crowdy::api::emit`, `crowdy::spawn`, `host_place_block`).',
  'If rustc says cannot find function X, call `sdk_lookup` with X before editing.',
  'If no listed function matches the intent, remove the call and leave a TODO — do not guess.',
  'Do not add crates. glam is forbidden. Cargo.toml may only declare allowlisted crates (crowdy-compute-sdk, game-kit-*, serde, serde_json, rand).',
  'World block writes: crowdy::api::voxel_set((cx,cy,cz), (vx,vy,vz), block_i32, None) on SERVER only. Always match the Result (`out_of_grid`, `permission_denied`, `bad_args`); never `let _ = voxel_set(...)`. CLIENT cannot voxel_set in Blocks with Friends.',
  'Call the Harness tool `game_context` (not a WASM API, not host_call) before writing. Stay inside grid bounds.',
  'Claimed-grid disco look is CLIENT crowdy::host_call("grid_skin_set", json!({ "remap": { "1": { "all": "mod_slot_00" }, "2": { "all": "mod_slot_00", "emission": 10 }, "3": { "all": "mod_slot_00" }, "6": { "all": "mod_slot_00", "emission": 8 } }, "paint": [{ "slot": 0, "fill": "#1a1a1a", "speckle": "#ffe066", "speckleCount": 28, "seed": 0 }] })). Do not SERVER voxel_set wool, gold, or glowstone as a skin. A disco ball in the sky is SERVER voxel_set of dirt/sand/stone (ids 2,6,3) radius-3 near the TOP of the current claimed chunk (local y 12–14), keep the floor — the CLIENT skin restyles those blocks. CLIENT on_tick may re-call grid_skin_set with cycling paint.seed for shimmer; keep remap/emission stable.',
  'Disco shine + mock rays: CLIENT mesh_asset_register primitive disco_rig then mesh_asset_spawn at the ball with pose.yaw. on_tick re-spawns the same id with cycling yaw so beams spin. Not ray-traced lights. Not voxel_set columns.',
  'Placeholder bow is CLIENT host_call mesh_asset_register primitive bow_placeholder then mesh_asset_attach anchor hand. Not a mini-block. Not voxel_set.',
  'Uploaded glTF meshes: call Harness tool mesh_artifacts, then CLIENT mesh_asset_register kind gltf with artifactHash from that list, then mesh_asset_spawn. Never embed GLB bytes in host_call or Studio files.',
  'Studio Invoke payload is UTF-8 JSON `{export, params, callerUserId, gridId}`. Parse `params` (chunk / chunk_x/y/z). Never treat the first 24 bytes as coordinates.',
  'emit_spatial uuid_hex must be exactly 64 hex characters. emit_event is denied for player modules — use emit_spatial or emit_channel.',
].join(' ')

/** System-prompt section: rules plus the full function index. */
export function formatSdkPrompt(catalog: readonly SdkEntry[]): string {
  const crate = catalog.filter((e) => e.module === 'crate')
  const api = catalog.filter((e) => e.module === 'api')
  const block = (title: string, rows: readonly SdkEntry[]): string => {
    const body = rows
      .map((entry) => {
        const doc = entry.doc ? ` — ${entry.doc}` : ''
        return `- ${qualifiedName(entry)} :: ${entry.signature}${doc}`
      })
      .join('\n')
    return `${title}\n${body}`
  }
  return [
    RULES,
    '',
    block('Crate-root helpers (`use crowdy_compute_sdk as crowdy`):', crate),
    '',
    block('Host API (`crowdy::api::*`):', api),
  ].join('\n')
}
