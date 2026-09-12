/**
 * Package entry: the Cordis plugin DSH mounts as `ctx.fs`, plus the sibling
 * plugins a Crowdy composition inserts (search, SDK index, page bridge, tools,
 * in-memory attachments). Each plugin is also reachable as a subpath export so
 * a `cordis.patch.yml` row can name it directly.
 *
 * @module @crowdedkingdoms/crowdy-dsh
 */

export { CrowdyFileSystem, default, versionOf } from './fs/crowdy-file-system.js'
export type { Config } from './fs/crowdy-file-system.js'
export { ScratchStore } from './fs/scratch-store.js'

export { CrowdyApiError, CrowdyStudioClient } from './crowdy/client.js'
export type {
  CrowdyFileDelete,
  CrowdyFileUpsert,
  CrowdyProject,
  CrowdyProjectFile,
  CrowdyTarget,
} from './crowdy/client.js'
export { loadCrowdyConfig, describeMissing, CROWDY_CONFIG_FILENAME } from './crowdy/config.js'
export type { CrowdyBootConfig } from './crowdy/config.js'
export {
  GitHubProjectStore,
  StudioProjectStore,
  selectProjectStore,
  isSourcePath,
} from './crowdy/project-store.js'
export type { ProjectSnapshot, ProjectStore } from './crowdy/project-store.js'

export { CrowdyAttachmentStore, imageDimensions } from './attachments/crowdy-attachment-store.js'
