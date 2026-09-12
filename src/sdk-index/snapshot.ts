/**
 * Vendored crowdy-compute-sdk 0.1.5 catalog.
 *
 * The cockpit must not import the CK API repository at runtime. When the SDK crate
 * source is available, `parseCrowdyComputeSdk` can rebuild this list; tests
 * compare the two so a bump without a snapshot update fails loudly.
 */

import type { SdkEntry } from './parse-sdk.js'

export const SDK_SNAPSHOT_VERSION = '0.1.5'

export const SDK_SNAPSHOT: readonly SdkEntry[] = [
  {
    name: 'log',
    module: 'crate',
    signature: 'fn log(level: u32, msg: &str)',
    doc: '',
  },
  {
    name: 'now_ms',
    module: 'crate',
    signature: 'fn now_ms() -> u64',
    doc: '',
  },
  {
    name: 'state_get',
    module: 'crate',
    signature: 'fn state_get() -> Vec<u8>',
    doc: "Read the module's durable state blob (empty vec when unset).",
  },
  {
    name: 'state_set',
    module: 'crate',
    signature: 'fn state_set(bytes: &[u8]) -> bool',
    doc: "Replace the module's durable state blob. Returns false when over the cap.",
  },
  {
    name: 'random_bytes',
    module: 'crate',
    signature: 'fn random_bytes(len: usize) -> Vec<u8>',
    doc: "Host-seeded random bytes (via the deterministic WASI stub).",
  },
  {
    name: 'pack_return',
    module: 'crate',
    signature: 'fn pack_return(bytes: Vec<u8>) -> u64',
    doc: 'Leak `bytes` and pack its (ptr, len) into the u64 return convention.',
  },
  {
    name: 'host_call',
    module: 'crate',
    signature: 'fn host_call(fn_name: &str, args: serde_json::Value) -> Result<serde_json::Value, HostError>',
    doc: 'Call a host API function with JSON args; returns the `data` payload.',
  },
  {
    name: 'container_create',
    module: 'api',
    signature:
      'fn container_create(type_name: &str, session_id: Option<&str>, properties: Value) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'container_create_for',
    module: 'api',
    signature:
      'fn container_create_for(type_name: &str, display_name: &str, session_id: Option<&str>, owner_user_id: Option<&str>, properties: Value) -> Result<Value, HostError>',
    doc: 'Create a container with explicit display name / owner. The module is a',
  },
  {
    name: 'container_get',
    module: 'api',
    signature: 'fn container_get(container_id: &str) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'container_get_batch',
    module: 'api',
    signature: 'fn container_get_batch(container_ids: &[&str]) -> Result<Value, HostError>',
    doc: 'Batched container_get: up to 32 ids -> [{container, properties}] in',
  },
  {
    name: 'containers_list',
    module: 'api',
    signature:
      'fn containers_list(type_name: Option<&str>, session_id: Option<&str>) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'containers_list_where',
    module: 'api',
    signature:
      'fn containers_list_where(type_name: Option<&str>, session_id: Option<&str>, wher: &[Predicate], limit: Option<u32>, offset: Option<u32>) -> Result<Value, HostError>',
    doc: 'Filtered/paged container list: up to 8 AND-combined property',
  },
  {
    name: 'container_delete',
    module: 'api',
    signature: 'fn container_delete(container_id: &str) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'property_set',
    module: 'api',
    signature:
      'fn property_set(container_id: &str, key: &str, value_type: &str, value: Value) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'model_invoke',
    module: 'api',
    signature:
      'fn model_invoke(function_name: &str, self_container_id: &str, params: Value, session_id: Option<&str>, caller_user_id: Option<&str>) -> Result<Value, HostError>',
    doc: 'Invoke an autonomous-invocable Model function transactionally from a',
  },
  {
    name: 'model_invoke_with_world',
    module: 'api',
    signature:
      'fn model_invoke_with_world(function_name: &str, self_container_id: &str, params: Value, session_id: Option<&str>, caller_user_id: Option<&str>, world_writes: &[WorldWrite]) -> Result<Value, HostError>',
    doc: '`model_invoke` with atomic world writes: the voxel writes and the',
  },
  {
    name: 'edge_add',
    module: 'api',
    signature:
      'fn edge_add(from_container_id: &str, to_container_id: &str, relationship_type: &str) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'edge_delete',
    module: 'api',
    signature:
      'fn edge_delete(from_container_id: &str, to_container_id: &str, relationship_type: &str) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'sessions_list',
    module: 'api',
    signature: 'fn sessions_list(status: Option<&str>) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'user_state_get',
    module: 'api',
    signature: 'fn user_state_get(user_id: &str) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'user_state_set',
    module: 'api',
    signature: 'fn user_state_set(user_id: &str, state_base64: &str) -> Result<Value, HostError>',
    doc: 'state is base64-encoded bytes.',
  },
  {
    name: 'avatar_state_get',
    module: 'api',
    signature: 'fn avatar_state_get(avatar_id: &str) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'grid_state_get',
    module: 'api',
    signature: 'fn grid_state_get(grid_id: &str) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'grid_state_set',
    module: 'api',
    signature: 'fn grid_state_set(grid_id: &str, state_base64: &str) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'chunk_get',
    module: 'api',
    signature: 'fn chunk_get(x: i64, y: i64, z: i64) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'voxels_list',
    module: 'api',
    signature: 'fn voxels_list(x: i64, y: i64, z: i64) -> Result<Value, HostError>',
    doc: 'List the voxels recorded in one chunk (capped host-side; voxelType +',
  },
  {
    name: 'actors_list',
    module: 'api',
    signature: 'fn actors_list(x: i64, y: i64, z: i64) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'actors_list_radius',
    module: 'api',
    signature:
      'fn actors_list_radius(x: i64, y: i64, z: i64, radius_xz: u8, radius_y: u8) -> Result<Value, HostError>',
    doc: 'Actors in a chunk box around (x,y,z): radiusXz clamped to 3, radiusY',
  },
  {
    name: 'voxel_set',
    module: 'api',
    signature:
      'fn voxel_set(chunk: (i64, i64, i64), voxel: (u8, u8, u8), voxel_type: i32, state_base64: Option<&str>) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'grid_permission_check',
    module: 'api',
    signature:
      'fn grid_permission_check(user_id: &str, grid_id: &str, permission_key: &str) -> Result<bool, HostError>',
    doc: '',
  },
  {
    name: 'emit_spatial',
    module: 'api',
    signature:
      'fn emit_spatial(kind: &str, chunk: (i64, i64, i64), uuid_hex: &str, payload_base64: &str, distance: u8, decay: u8) -> Result<Value, HostError>',
    doc: 'kind: "actor" | "voxel" | "client_event" | "server_event" (host maps to',
  },
  {
    name: 'emit_channel',
    module: 'api',
    signature: 'fn emit_channel(channel_id: &str, payload_base64: &str) -> Result<Value, HostError>',
    doc: '',
  },
  {
    name: 'emit_event',
    module: 'api',
    signature: 'fn emit_event(name: &str, payload: Value) -> Result<Value, HostError>',
    doc: 'Emit a compute event other modules (or this one) can subscribe to via',
  },
]
