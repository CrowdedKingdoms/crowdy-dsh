import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

import { formatLookup, formatSdkPrompt, lookupSdkName } from './catalog.js'
import { parseCrowdyComputeSdk } from './parse-sdk.js'
import { SDK_SNAPSHOT } from './snapshot.js'

const FIXTURE = `
pub fn log(level: u32, msg: &str) {}
pub fn now_ms() -> u64 { 0 }

/// Read the module's durable state blob (empty vec when unset).
pub fn state_get() -> Vec<u8> { vec![] }

pub mod api {
    pub fn voxel_set(
        chunk: (i64, i64, i64),
        voxel: (u8, u8, u8),
        voxel_type: i32,
        state_base64: Option<&str>,
    ) -> Result<Value, HostError> { todo!() }

    pub struct Predicate { pub key: String }
    impl Predicate {
        pub fn new(key: &str, op: &str, value: Value) -> Self { todo!() }
    }

    /// Emit a compute event other modules can subscribe to.
    pub fn emit_event(name: &str, payload: Value) -> Result<Value, HostError> { todo!() }
    pub fn emit_channel(channel_id: &str, payload_base64: &str) -> Result<Value, HostError> { todo!() }
    pub fn emit_spatial(
        kind: &str,
        chunk: (i64, i64, i64),
        uuid_hex: &str,
        payload_base64: &str,
        distance: u8,
        decay: u8,
    ) -> Result<Value, HostError> { todo!() }
}
`

describe('parseCrowdyComputeSdk', () => {
  it('splits crate-root helpers from api wrappers and skips impl methods', () => {
    const entries = parseCrowdyComputeSdk(FIXTURE)
    assert.deepEqual(
      entries.map((e) => `${e.module}:${e.name}`),
      [
        'crate:log',
        'crate:now_ms',
        'crate:state_get',
        'api:voxel_set',
        'api:emit_event',
        'api:emit_channel',
        'api:emit_spatial',
      ],
    )
    assert.equal(entries.find((e) => e.name === 'new'), undefined)
    assert.match(entries.find((e) => e.name === 'state_get')?.doc ?? '', /durable state/)
    assert.match(entries.find((e) => e.name === 'voxel_set')?.signature ?? '', /voxel_type: i32/)
  })
})

describe('lookupSdkName', () => {
  const catalog = parseCrowdyComputeSdk(FIXTURE)

  it('hits an exact api name', () => {
    const hit = lookupSdkName(catalog, 'crowdy::api::emit_event')
    assert.equal(hit.found, true)
    assert.equal(hit.match?.name, 'emit_event')
  })

  it('maps the invented emit name onto the three real emit_* functions', () => {
    const hit = lookupSdkName(catalog, 'emit')
    assert.equal(hit.found, false)
    assert.deepEqual(
      hit.nearest.map((e) => e.name),
      ['emit_event', 'emit_channel', 'emit_spatial'],
    )
    assert.match(formatLookup(hit), /emit_event/)
    assert.match(formatLookup(hit), /is not a crowdy-compute-sdk function/)
  })

  it('maps spawn / host_place_block onto voxel_set', () => {
    assert.equal(lookupSdkName(catalog, 'crowdy::spawn').nearest[0]?.name, 'voxel_set')
    assert.equal(lookupSdkName(catalog, 'host_place_block').nearest[0]?.name, 'voxel_set')
  })

  it('refuses glam instead of suggesting a function', () => {
    const hit = lookupSdkName(catalog, 'glam')
    assert.equal(hit.found, false)
    assert.equal(hit.nearest.length, 0)
    assert.match(hit.note, /forbidden/)
  })

  it('redirects game_context to the Harness tool instead of inventing a WASM API', () => {
    for (const name of ['game_context', 'crowdy::api::game_context', 'host_call("game_context")']) {
      const hit = lookupSdkName(catalog, name)
      assert.equal(hit.found, false)
      assert.match(hit.note, /Harness tool/)
      assert.match(hit.note, /Do not write crowdy::host_call/)
      assert.equal(hit.nearest[0]?.name, 'voxel_set')
    }
  })

  it('redirects disco / grid_skin_set / bow to CLIENT host_call, not voxel_set', () => {
    for (const name of ['disco', 'disco_skin', 'disco_rig', 'grid_skin_set', 'bow', 'mesh_asset_register', 'mesh_asset_spawn']) {
      const hit = lookupSdkName(catalog, name)
      assert.equal(hit.found, false)
      assert.equal(hit.nearest.length, 0)
      assert.match(hit.note, /host_call/)
      assert.match(hit.note, /grid_skin_set/)
      assert.doesNotMatch(hit.note, /Use crowdy::api::voxel_set/)
    }
    const disco = lookupSdkName(catalog, 'disco_rig')
    assert.match(disco.note, /disco_rig/)
    assert.match(disco.note, /pose.yaw/)
  })
})

describe('formatSdkPrompt', () => {
  it('forbids invented names and lists both modules', () => {
    const text = formatSdkPrompt(parseCrowdyComputeSdk(FIXTURE))
    assert.match(text, /Do not invent names/)
    assert.match(text, /crowdy::api::emit_event/)
    assert.match(text, /crowdy::log/)
    assert.doesNotMatch(text, /^- crowdy::api::emit ::/m)
  })

  it('documents invoke envelope, voxel_set Result, and emit_spatial uuid', () => {
    const text = formatSdkPrompt(parseCrowdyComputeSdk(FIXTURE))
    assert.match(text, /export, params, callerUserId, gridId/)
    assert.match(text, /never `let _ = voxel_set/)
    assert.match(text, /64 hex/)
    assert.match(text, /emit_event is denied/)
    assert.match(text, /Harness tool `game_context`/)
    assert.match(text, /grid_skin_set/)
    assert.match(text, /paint.seed/)
    assert.match(text, /on_tick/)
    assert.match(text, /mesh_asset_register/)
    assert.match(text, /disco_rig/)
    assert.match(text, /pose.yaw/)
    assert.match(text, /CLIENT cannot voxel_set/)
  })
})

describe('SDK_SNAPSHOT vs live crate (when present)', () => {
  it('names match crowdy-compute-sdk 0.1.5 when the source tree is here', async () => {
    // The live crate lives in the CK API repository, which is not a dependency
    // of this package; point CROWDY_COMPUTE_SDK_SRC at its lib.rs to compare.
    const candidates = [process.env.CROWDY_COMPUTE_SDK_SRC].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    )
    let source: string | undefined
    for (const path of candidates) {
      try {
        source = await readFile(path, 'utf8')
        break
      } catch {
        /* optional */
      }
    }
    if (!source) return
    const live = parseCrowdyComputeSdk(source).map((e) => e.name).sort()
    const snap = SDK_SNAPSHOT.map((e) => e.name).sort()
    assert.deepEqual(snap, live)
    assert.equal(live.includes('emit'), false)
    assert.ok(live.includes('emit_event'))
  })
})
