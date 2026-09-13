/**
 * Crowdy Studio project-file access for the cockpit, on top of CrowdyJS.
 *
 * The cockpit is a client of the platform exactly like a browser running Studio:
 * it signs in as the modder with the public SDK, mints an app-scoped token for
 * the target app, and reads / writes project files through the same GraphQL
 * operations Studio uses. There is no private wire, no second endpoint, and no
 * server-side component that knows this process exists.
 *
 * Only the operations a filesystem backend needs are exposed: authenticate,
 * load a project with its files, save a batch of upserts / deletes under an
 * expected project revision, and (for the setup script) create a project.
 */

import {
  createCrowdyClient,
  CrowdyGraphQLError,
  CrowdyStudioProjectCreateDocument,
  CrowdyStudioProjectDocument,
  type CrowdyClient,
  type GeneratedTarget,
} from '../vendor/crowdyjs-sdk.js'

/** Project targets are two independent file trees with separate quotas. */
export type CrowdyTarget = 'SERVER' | 'CLIENT'

export interface CrowdyProjectFile {
  target: CrowdyTarget
  path: string
  content: string
  /** Per-file counter, incremented on every successful upsert of this target/path. */
  revision: string
  updatedAt: string
}

/**
 * Where a project's files are authored. Every project starts as `STUDIO`; its
 * owner may bind a GitHub repository in Crowdy Studio, after which the
 * repository is the working tree and `files` is the server's mirror of it at
 * `github.sha`. GitHub is never required.
 */
export type CrowdyProjectSource = 'STUDIO' | 'GITHUB'

export interface CrowdyProjectGitHub {
  owner: string
  repo: string
  branch: string
  /** Commit the mirror is at; every bound write presents it as `expectedCommitSha`. */
  sha: string | null
}

export interface CrowdyProject {
  projectId: string
  appId: string
  ownerUserId: string
  name: string
  /** Project-wide counter guarding every STUDIO mutation; `expectedRevision` must equal it. */
  revision: string
  archived: boolean
  files: CrowdyProjectFile[]
  source: CrowdyProjectSource
  github: CrowdyProjectGitHub | null
  updatedAt: string
}

export interface CrowdyFileUpsert {
  target: CrowdyTarget
  path: string
  content: string
}

export interface CrowdyFileDelete {
  target: CrowdyTarget
  path: string
}

/**
 * A GraphQL error surfaced with the server's error code intact so callers can
 * branch on it. Revision conflicts in particular need distinct handling.
 */
export class CrowdyApiError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly remediation?: string,
  ) {
    super(message)
    this.name = 'CrowdyApiError'
  }

  /** True when the write lost an optimistic-concurrency race and must be replayed. */
  get isRevisionConflict(): boolean {
    return this.code === 'CROWDY_STUDIO_REVISION_CONFLICT' || this.code === 'GITHUB_STALE_SHA'
  }

  /** True when the bearer is missing, expired, or not app-scoped. */
  get isAuthFailure(): boolean {
    return (
      this.code === 'UNAUTHENTICATED' ||
      this.code === 'UNAUTHORIZED' ||
      this.code === 'TOKEN_EXPIRED' ||
      this.code === 'SCOPE_MISSING'
    )
  }
}

export interface CrowdyClientOptions {
  /** Absolute GraphQL endpoint, e.g. `http://localhost:3000/graphql`. */
  endpoint: string
  /** Numeric app id, carried as a string because it is a GraphQL BigInt. */
  appId: string
  /** Pre-minted app-scoped token; when absent, supply `email`/`password` to mint one. */
  appToken?: string
  email?: string
  password?: string
}

/** The subset of the generated project payload the filesystem consumes. */
interface ProjectDto {
  projectId: string
  appId: string
  ownerUserId: string
  name: string
  revision: string
  archived: boolean
  updatedAt: string
  source?: string | null
  githubOwner?: string | null
  githubRepo?: string | null
  githubBranch?: string | null
  githubSha?: string | null
  files: Array<{
    target: GeneratedTarget
    path: string
    content: string
    revision: string
    updatedAt: string
  }>
}

function toProject(dto: ProjectDto): CrowdyProject {
  const bound = dto.source === 'GITHUB' && dto.githubOwner && dto.githubRepo && dto.githubBranch
  return {
    projectId: dto.projectId,
    appId: String(dto.appId),
    ownerUserId: String(dto.ownerUserId),
    name: dto.name,
    revision: String(dto.revision),
    archived: dto.archived,
    updatedAt: dto.updatedAt,
    source: bound ? 'GITHUB' : 'STUDIO',
    github: bound
      ? { owner: dto.githubOwner!, repo: dto.githubRepo!, branch: dto.githubBranch!, sha: dto.githubSha ?? null }
      : null,
    files: dto.files.map((file) => ({
      target: file.target as CrowdyTarget,
      path: file.path,
      content: file.content,
      revision: String(file.revision),
      updatedAt: file.updatedAt,
    })),
  }
}

/**
 * Translate CrowdyJS's error into the cockpit's, keeping `extensions.code` and
 * `extensions.remediation` so the filesystem can map conflicts and denials.
 */
function toApiError(error: unknown): CrowdyApiError {
  if (error instanceof CrowdyApiError) return error
  if (error instanceof CrowdyGraphQLError) {
    const first = error.graphqlErrors[0]
    const extensions = (first?.extensions ?? {}) as {
      code?: unknown
      remediation?: unknown
    }
    return new CrowdyApiError(
      first?.message ?? error.message,
      typeof extensions.code === 'string' ? extensions.code : undefined,
      typeof extensions.remediation === 'string' ? extensions.remediation : undefined,
    )
  }
  if (error instanceof Error) {
    return new CrowdyApiError(error.message, 'CROWDY_DSH_TRANSPORT')
  }
  return new CrowdyApiError(String(error), 'CROWDY_DSH_TRANSPORT')
}

/**
 * Project-file client. One instance per configured `(endpoint, appId)`; the
 * bearer is resolved lazily on the first call and held in memory only.
 */
export class CrowdyStudioClient {
  private readonly sdk: CrowdyClient
  private appToken: string | undefined
  private authenticating: Promise<string> | undefined

  constructor(private readonly options: CrowdyClientOptions) {
    // The SDK expects an origin; the cockpit is configured with the endpoint.
    this.sdk = createCrowdyClient({ graphqlEndpoint: options.endpoint })
    this.appToken = options.appToken
    if (this.appToken) this.sdk.setToken(this.appToken)
  }

  /** The app id every call is scoped to. */
  get appId(): string {
    return this.options.appId
  }

  /**
   * Replace the bearer, e.g. when the Studio page refreshes the app token over
   * the bridge. An empty token falls back to the credential mint path.
   */
  setToken(token: string | undefined): void {
    this.appToken = token || undefined
    this.sdk.setToken(this.appToken ?? null)
  }

  /** GitHub loop of the bound repository; every call carries `(appId, projectId)`. */
  get github(): CrowdyClient['crowdyStudioGitHub'] {
    return this.sdk.crowdyStudioGitHub
  }

  /** Projects the caller owns in this app. */
  async listProjects(): Promise<
    Array<{ projectId: string; name: string; kind: string; updatedAt: string }>
  > {
    await this.authenticate()
    try {
      // The SDK scope type also names a grid, but the query is app-wide; the grid
      // is irrelevant to listing and is passed empty.
      const projects = await this.sdk.crowdyStudio.listProjects({ appId: this.options.appId, gridId: '' })
      return projects.map((project) => ({
        projectId: project.projectId,
        name: project.name,
        kind: String(project.kind),
        updatedAt: project.updatedAt,
      }))
    } catch (error) {
      throw toApiError(error)
    }
  }

  /**
   * Resolve the app-scoped bearer. A pre-minted `appToken` wins; otherwise sign
   * in as the modder (first-party, no browser Origin — the same path
   * CrowdyCPP and the load tests use) and mint a token for `appId`.
   */
  async authenticate(): Promise<string> {
    if (this.appToken) return this.appToken
    if (this.authenticating) return this.authenticating

    const { email, password, appId } = this.options
    if (!email || !password) {
      throw new CrowdyApiError(
        'No appToken supplied and no email/password available to mint one.',
        'CROWDY_DSH_NO_CREDENTIALS',
        'Set CROWDY_APP_TOKEN, or set CROWDY_EMAIL and CROWDY_PASSWORD.',
      )
    }

    this.authenticating = (async () => {
      try {
        await this.sdk.auth.login({ email, password })
        const minted = await this.sdk.portal.mintAppToken(appId)
        this.appToken = minted.token
        this.sdk.setToken(this.appToken)
        return this.appToken
      } catch (error) {
        throw toApiError(error)
      } finally {
        this.authenticating = undefined
      }
    })()
    return this.authenticating
  }

  /** Load a project and the full text of every file it contains. */
  async loadProject(projectId: string): Promise<CrowdyProject> {
    await this.authenticate()
    try {
      const data = await this.sdk.graphql.request(CrowdyStudioProjectDocument, {
        appId: this.options.appId,
        projectId,
      })
      return toProject(data.crowdyStudioProject)
    } catch (error) {
      throw toApiError(error)
    }
  }

  /**
   * Apply upserts and deletes in one transaction guarded by `expectedRevision`.
   * A stale revision throws {@link CrowdyApiError} with `isRevisionConflict`.
   *
   * Studio's own editor goes through `crowdyStudioProjectSave` with the whole
   * file list; a filesystem needs the files-only twin so a single `write`
   * cannot disturb metadata it never read.
   *
   * @returns the project as it exists after the write, with its new revision.
   */
  async saveFiles(args: {
    projectId: string
    expectedRevision: string
    upserts?: CrowdyFileUpsert[]
    deletes?: CrowdyFileDelete[]
    idempotencyKey?: string
  }): Promise<CrowdyProject> {
    await this.authenticate()
    try {
      const data = await this.sdk.graphql.query<{ crowdyStudioProjectSaveFiles: ProjectDto }>(
        SAVE_FILES,
        {
          input: {
            appId: this.options.appId,
            projectId: args.projectId,
            expectedRevision: args.expectedRevision,
            ...(args.upserts?.length ? { upserts: args.upserts } : {}),
            ...(args.deletes?.length ? { deletes: args.deletes } : {}),
            ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
          },
        },
      )
      return toProject(data.crowdyStudioProjectSaveFiles)
    } catch (error) {
      throw toApiError(error)
    }
  }

  /** Create a project, used by the setup script to produce a scratch target. */
  async createProject(args: {
    name: string
    description?: string
    initialFiles?: CrowdyFileUpsert[]
  }): Promise<CrowdyProject> {
    await this.authenticate()
    try {
      const data = await this.sdk.graphql.request(CrowdyStudioProjectCreateDocument, {
        input: {
          appId: this.options.appId,
          name: args.name,
          ...(args.description ? { description: args.description } : {}),
          ...(args.initialFiles?.length
            ? { initialFiles: args.initialFiles.map((f) => ({ ...f, target: f.target as GeneratedTarget })) }
            : {}),
        },
      })
      return toProject(data.crowdyStudioProjectCreate)
    } catch (error) {
      throw toApiError(error)
    }
  }
}

const PROJECT_FIELDS = `
  projectId
  appId
  ownerUserId
  name
  revision
  archived
  updatedAt
  source
  githubOwner
  githubRepo
  githubBranch
  githubSha
  files {
    target
    path
    content
    revision
    updatedAt
  }
`

/**
 * The files-only save is not in CrowdyJS's generated document set (Studio's
 * editor saves whole projects), so it is carried here as a named operation
 * against the same public schema.
 */
const SAVE_FILES = `
  mutation CrowdyDshSaveFiles($input: SaveCrowdyStudioProjectFilesInput!) {
    crowdyStudioProjectSaveFiles(input: $input) { ${PROJECT_FIELDS} }
  }
`
