/**
 * Where a project's files live, and how a batch of edits reaches them.
 *
 * Both sources present the same versioned bag of `(target, path, content)` so
 * the filesystem backend never learns which one it is talking to:
 *
 *  - a STUDIO project is read and written through the Crowdy Studio project
 *    API under its revision counter;
 *  - a GITHUB project is READ the same way — its `files` are the server's
 *    mirror of the bound repository at `github.sha` — and WRITTEN as commits:
 *    one `crowdyStudioGitHubPutFile` / `DeleteFile` per changed file, each
 *    carrying `expectedCommitSha` (the commit the previous one produced). The
 *    server advances the mirror with every commit, so nothing is mirrored from
 *    here; the harness and Monaco are always looking at one tree.
 *
 * A lost race is {@link CrowdyApiError} with `isRevisionConflict` either way
 * (`CROWDY_STUDIO_REVISION_CONFLICT` or `GITHUB_STALE_SHA`); the filesystem
 * reports `FS_STALE_VERSION` and the agent re-reads.
 *
 * Layout comes from the API (`crowdyStudioGitHubLayout`) at the commit being
 * written to. This module does not parse `crowdy.json`; the API is the only
 * grammar.
 *
 * @module @crowdedkingdoms/crowdy-dsh/crowdy/project-store
 */

import { CrowdyApiError, CrowdyStudioClient } from './client.js'
import type { CrowdyFileDelete, CrowdyFileUpsert, CrowdyProject, CrowdyProjectFile, CrowdyTarget } from './client.js'

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
  load(): Promise<ProjectSnapshot>
  /**
   * Apply a batch against `snapshot`. A lost race throws {@link CrowdyApiError}
   * with `isRevisionConflict`; the caller re-reads and retries or reports.
   */
  commit(snapshot: ProjectSnapshot, batch: ProjectBatch): Promise<ProjectSnapshot>
}

interface ApiLayout {
  commitSha: string
  server: string
  client: string | null
}

/**
 * The one store. Which path a commit takes is decided by the snapshot it is
 * applied to, which is decided by the project's `source` at load time.
 */
export class CrowdyProjectStore implements ProjectStore {
  /** Layout per commit; commits are immutable so this never goes stale. */
  private readonly layouts = new Map<string, ApiLayout>()

  constructor(
    private readonly client: CrowdyStudioClient,
    private readonly projectId: string,
  ) {}

  async load(): Promise<ProjectSnapshot> {
    const project = await this.client.loadProject(this.projectId)
    return snapshotOf(project)
  }

  async commit(snapshot: ProjectSnapshot, batch: ProjectBatch): Promise<ProjectSnapshot> {
    if (snapshot.source === 'github') return this.commitToGitHub(snapshot, batch)
    const project = await this.client.saveFiles({
      projectId: this.projectId,
      expectedRevision: snapshot.revision,
      ...batch,
    })
    return snapshotOf(project)
  }

  private async commitToGitHub(snapshot: ProjectSnapshot, batch: ProjectBatch): Promise<ProjectSnapshot> {
    const scope = { appId: this.client.appId, projectId: this.projectId }
    let sha = snapshot.revision
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new CrowdyApiError(
        'The bound project has no mirror commit yet; refresh it from GitHub in Crowdy Studio.',
        'GITHUB_NOT_BOUND',
      )
    }
    const layout = await this.layoutAt(scope, sha)
    for (const upsert of batch.upserts ?? []) {
      const repoPath = repoPathFor(layout, upsert.target, upsert.path)
      const written = await this.client.github.putFile({
        ...scope,
        path: repoPath,
        content: upsert.content,
        message: `Crowdy Studio agent: update ${repoPath}`,
        expectedCommitSha: sha,
      })
      sha = written.commitSha ?? sha
    }
    for (const del of batch.deletes ?? []) {
      const repoPath = repoPathFor(layout, del.target, del.path)
      const status = await this.client.github.deleteFile({
        ...scope,
        path: repoPath,
        message: `Crowdy Studio agent: delete ${repoPath}`,
        expectedCommitSha: sha,
      })
      sha = status.githubSha ?? sha
    }
    // The server advanced the mirror with each commit; read it back rather
    // than guessing at the shape it produced.
    return snapshotOf(await this.client.loadProject(this.projectId))
  }

  private async layoutAt(scope: { appId: string; projectId: string }, commitSha: string): Promise<ApiLayout> {
    const cached = this.layouts.get(commitSha)
    if (cached) return cached
    const layout = await this.client.github.layout({ ...scope, commitSha })
    if (this.layouts.size > 32) {
      const [oldest] = this.layouts.keys()
      if (oldest !== undefined) this.layouts.delete(oldest)
    }
    this.layouts.set(commitSha, layout)
    return layout
  }
}

/** Repository path of a project file under the API-resolved layout. */
export function repoPathFor(layout: Pick<ApiLayout, 'server' | 'client'>, target: CrowdyTarget, path: string): string {
  const root = target === 'SERVER' ? layout.server : layout.client
  if (root == null) {
    throw new CrowdyApiError(
      `The bound repository's crowdy.json has no ${target.toLowerCase()} directory, so ${path} has nowhere to go.`,
      'GITHUB_PATH_INVALID',
      'Add a "client" directory to crowdy.json on the bound branch.',
    )
  }
  const base = root.replace(/^\/+|\/+$/g, '')
  const rel = path.replace(/^\/+/, '')
  if (!base || base === '.') return rel
  return `${base}/${rel}`
}

export function snapshotOf(project: CrowdyProject): ProjectSnapshot {
  if (project.source === 'GITHUB' && project.github) {
    const label = `${project.github.owner}/${project.github.repo}@${project.github.branch}`
    return {
      revision: project.github.sha ?? '',
      files: project.files,
      source: 'github',
      label: `GitHub ${label}`,
    }
  }
  return {
    revision: project.revision,
    files: project.files,
    source: 'studio',
    label: `Crowdy Studio project "${project.name}"`,
  }
}

/** Crowdy Studio stores only `Cargo.toml` and `.rs` files under `src/`. */
export function isSourcePath(path: string): boolean {
  return path === 'Cargo.toml' || (path.startsWith('src/') && path.endsWith('.rs'))
}

/** Why a snapshot's files live where they do, for the system prompt and tool messages. */
export function describeSource(snapshot: ProjectSnapshot): string {
  return snapshot.source === 'github'
    ? `The project is bound to ${snapshot.label.replace(/^GitHub /, '')}; the repository is the working tree and every write is a commit on it. Monaco in Crowdy Studio sees the same commit.`
    : 'The project is not bound to a GitHub repository; Crowdy Studio project files are the working tree.'
}
