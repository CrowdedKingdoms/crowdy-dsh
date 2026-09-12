/**
 * Where a project's files live: the bound GitHub repository when the owner
 * bound one (GitHub is then the source of truth and Studio holds the deployable
 * mirror), otherwise the Crowdy Studio project itself.
 *
 * Both stores present the same versioned bag of `(target, path, content)` so
 * the filesystem backend never learns which one it is talking to.
 *
 * @module @crowdedkingdoms/crowdy-dsh/crowdy/project-store
 */

import { CrowdyApiError, CrowdyStudioClient } from './client.js'
import type { CrowdyFileDelete, CrowdyFileUpsert, CrowdyProjectFile, CrowdyTarget } from './client.js'
import {
  layoutFromTree,
  parseCrowdyJson,
  repoPathToStudioFile,
  studioFileToRepoPath,
  type GitHubLayout,
} from './github-layout.js'

export interface ProjectSnapshot {
  /** Opaque store-wide version; every mutation must present the one it read. */
  revision: string
  files: CrowdyProjectFile[]
  source: 'studio' | 'github'
  /** Human-readable origin for tool messages, e.g. `owner/repo@main`. */
  label: string
}

export interface ProjectBatch {
  upserts?: CrowdyFileUpsert[]
  deletes?: CrowdyFileDelete[]
}

export interface ProjectStore {
  readonly kind: 'studio' | 'github'
  load(): Promise<ProjectSnapshot>
  /**
   * Apply a batch against `snapshot`. A lost race throws {@link CrowdyApiError}
   * with `isRevisionConflict`; the caller re-reads and retries or reports.
   */
  commit(snapshot: ProjectSnapshot, batch: ProjectBatch): Promise<ProjectSnapshot>
}

/** Crowdy Studio project files behind `crowdyStudioProject*`. */
export class StudioProjectStore implements ProjectStore {
  readonly kind = 'studio' as const

  constructor(
    private readonly client: CrowdyStudioClient,
    private readonly projectId: string,
  ) {}

  async load(): Promise<ProjectSnapshot> {
    const project = await this.client.loadProject(this.projectId)
    return {
      revision: project.revision,
      files: project.files,
      source: 'studio',
      label: `Crowdy Studio project "${project.name}"`,
    }
  }

  async commit(snapshot: ProjectSnapshot, batch: ProjectBatch): Promise<ProjectSnapshot> {
    const project = await this.client.saveFiles({
      projectId: this.projectId,
      expectedRevision: snapshot.revision,
      ...batch,
    })
    return {
      revision: project.revision,
      files: project.files,
      source: 'studio',
      label: snapshot.label,
    }
  }
}

interface GitHubFileState {
  sha: string
  repoPath: string
}

/**
 * The bound GitHub repository, read through `crowdyStudioGitHubTree/File` and
 * written through `crowdyStudioGitHubPutFile` (Contents API, SHA-guarded).
 *
 * After every successful GitHub write the same batch is mirrored onto the
 * Studio project so a draft test or deploy compiles what the agent wrote. The
 * mirror is best-effort: GitHub already holds the truth, and a Studio revision
 * race is reported, not treated as a failed write.
 */
export class GitHubProjectStore implements ProjectStore {
  readonly kind = 'github' as const
  private shas = new Map<string, GitHubFileState>()
  private layout: GitHubLayout | undefined
  /** Last mirror failure, surfaced once by the filesystem in its next result. */
  mirrorWarning: string | undefined

  constructor(
    private readonly client: CrowdyStudioClient,
    private readonly projectId: string,
    private readonly repoLabel: string,
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  private get scope() {
    return { appId: this.client.appId, projectId: this.projectId }
  }

  async load(): Promise<ProjectSnapshot> {
    await this.client.authenticate()
    const entries = await this.client.github.tree(this.scope)
    const crowdyJson = entries.find((entry) => entry.type === 'blob' && entry.path === 'crowdy.json')
    let layout: GitHubLayout | null = null
    if (crowdyJson) {
      const file = await this.client.github.getFile({ ...this.scope, path: 'crowdy.json' })
      layout = parseCrowdyJson(file.content)
    }
    this.layout = layout ?? layoutFromTree(entries)

    const mapped: Array<{ repoPath: string; target: CrowdyTarget; path: string; sha: string | null }> = []
    for (const entry of entries) {
      if (entry.type !== 'blob') continue
      const studio = repoPathToStudioFile(this.layout, entry.path)
      if (!studio) continue
      if (!isSourcePath(studio.path)) continue
      mapped.push({ repoPath: entry.path, ...studio, sha: entry.sha })
    }

    const files: CrowdyProjectFile[] = []
    const shas = new Map<string, GitHubFileState>()
    // Small projects: fetch sequentially in modest parallel batches so a
    // fleet-wide op limit is not tripped by one listing.
    const batchSize = 4
    for (let index = 0; index < mapped.length; index += batchSize) {
      const slice = mapped.slice(index, index + batchSize)
      const loaded = await Promise.all(
        slice.map(async (entry) => {
          const file = await this.client.github.getFile({ ...this.scope, path: entry.repoPath })
          return { entry, file }
        }),
      )
      for (const { entry, file } of loaded) {
        shas.set(key(entry.target, entry.path), { sha: file.sha, repoPath: entry.repoPath })
        files.push({
          target: entry.target,
          path: entry.path,
          content: file.content,
          revision: file.sha,
          updatedAt: '',
        })
      }
    }
    this.shas = shas
    files.sort((a, b) => (a.target === b.target ? a.path.localeCompare(b.path) : a.target.localeCompare(b.target)))
    return {
      revision: revisionOf(shas),
      files,
      source: 'github',
      label: `GitHub ${this.repoLabel}`,
    }
  }

  async commit(snapshot: ProjectSnapshot, batch: ProjectBatch): Promise<ProjectSnapshot> {
    if (snapshot.revision !== revisionOf(this.shas)) {
      throw new CrowdyApiError('The repository changed since it was read.', 'GITHUB_STALE_SHA')
    }
    if (batch.deletes?.length) {
      throw new CrowdyApiError(
        'Deleting files in a GitHub-bound project is not supported here; delete it on GitHub or in Crowdy Studio.',
        'GITHUB_DELETE_UNSUPPORTED',
      )
    }
    const layout = this.layout ?? layoutFromTree([])
    for (const upsert of batch.upserts ?? []) {
      const repoPath = studioFileToRepoPath(layout, upsert.target, upsert.path)
      if (!repoPath) {
        throw new CrowdyApiError(
          `The bound repository has no ${upsert.target.toLowerCase()} root in crowdy.json, so ${upsert.path} has no place to go.`,
          'GITHUB_PATH_INVALID',
        )
      }
      const existing = this.shas.get(key(upsert.target, upsert.path))
      const written = await this.client.github.putFile({
        ...this.scope,
        path: repoPath,
        content: upsert.content,
        message: `Crowdy Studio agent: ${existing ? 'update' : 'add'} ${repoPath}`,
        ...(existing ? { sha: existing.sha } : {}),
      })
      this.shas.set(key(upsert.target, upsert.path), { sha: written.sha, repoPath })
    }

    const files = snapshot.files.map((file) => ({ ...file }))
    for (const upsert of batch.upserts ?? []) {
      const index = files.findIndex((file) => file.target === upsert.target && file.path === upsert.path)
      const state = this.shas.get(key(upsert.target, upsert.path))
      const next: CrowdyProjectFile = {
        target: upsert.target,
        path: upsert.path,
        content: upsert.content,
        revision: state?.sha ?? '',
        updatedAt: new Date().toISOString(),
      }
      if (index === -1) files.push(next)
      else files[index] = next
    }

    await this.mirrorToStudio(batch)

    return { revision: revisionOf(this.shas), files, source: 'github', label: snapshot.label }
  }

  /** Copy the batch onto the Studio project so builds see the same bytes. */
  private async mirrorToStudio(batch: ProjectBatch): Promise<void> {
    try {
      const project = await this.client.loadProject(this.projectId)
      await this.client.saveFiles({
        projectId: this.projectId,
        expectedRevision: project.revision,
        ...batch,
      })
      this.mirrorWarning = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.mirrorWarning = `Saved to GitHub, but the Crowdy Studio mirror was not updated: ${message}. Pull from GitHub in Studio before testing.`
      this.warn(this.mirrorWarning)
    }
  }
}

function key(target: CrowdyTarget, path: string): string {
  return `${target}:${path}`
}

function revisionOf(shas: Map<string, GitHubFileState>): string {
  return [...shas.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v.sha}`)
    .join(';')
}

/** Crowdy Studio stores only `Cargo.toml` and `.rs` files under `src/`. */
export function isSourcePath(path: string): boolean {
  return path === 'Cargo.toml' || (path.startsWith('src/') && path.endsWith('.rs'))
}

export interface StoreSelection {
  store: ProjectStore
  /** Why this store was chosen, for the system prompt and tool messages. */
  reason: string
}

/**
 * Choose the store for a project: GitHub when the project is bound to a
 * connected repository and the caller prefers it, otherwise Studio files.
 */
export async function selectProjectStore(
  client: CrowdyStudioClient,
  projectId: string,
  options: { githubFirst: boolean; warn?: (message: string) => void },
): Promise<StoreSelection> {
  if (options.githubFirst) {
    try {
      const status = await client.github.status({ appId: client.appId, projectId })
      if (status.configured && status.connected && status.owner && status.repo) {
        const label = `${status.owner}/${status.repo}@${status.branch ?? 'default'}`
        return {
          store: new GitHubProjectStore(client, projectId, label, options.warn),
          reason: `The project is bound to GitHub (${label}); the repository is the source of truth and Studio mirrors it.`,
        }
      }
    } catch (error) {
      options.warn?.(
        `GitHub status unavailable, falling back to Studio files: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return {
    store: new StudioProjectStore(client, projectId),
    reason: 'The project is not bound to a GitHub repository; Crowdy Studio project files are the source of truth.',
  }
}
