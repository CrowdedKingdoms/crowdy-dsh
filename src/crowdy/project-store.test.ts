import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CrowdyApiError, type CrowdyStudioClient } from './client.js'
import { GitHubProjectStore, selectProjectStore } from './project-store.js'
import { layoutFromTree, parseCrowdyJson, repoPathToStudioFile, studioFileToRepoPath } from './github-layout.js'

/** A fake CrowdyJS slice: a bound repository plus a Studio mirror. */
function fakeClient(options: { bound: boolean; tree?: Array<{ path: string; type: 'blob' | 'tree'; sha: string }>; files?: Record<string, string> }) {
  const files = { ...(options.files ?? {}) }
  const shas = new Map(Object.keys(files).map((path) => [path, `sha-${path}`]))
  const mirror: unknown[] = []
  const puts: Array<{ path: string; sha?: string; message: string }> = []
  const client = {
    appId: '2',
    async authenticate() {
      return 'token'
    },
    github: {
      async status() {
        return options.bound
          ? { configured: true, connected: true, owner: 'acme', repo: 'mod', branch: 'main', accountLogin: 'a', accountType: 'User', autosave: false, installUrl: null }
          : { configured: true, connected: false, owner: null, repo: null, branch: null, accountLogin: null, accountType: null, autosave: false, installUrl: null }
      },
      async tree() {
        return options.tree ?? Object.keys(files).map((path) => ({ path, type: 'blob' as const, sha: shas.get(path)!, size: files[path]!.length }))
      },
      async getFile({ path }: { path: string }) {
        if (!(path in files)) throw new CrowdyApiError('missing', 'GITHUB_FILE_NOT_FOUND')
        return { path, content: files[path]!, sha: shas.get(path)! }
      },
      async putFile(input: { path: string; content: string; sha?: string; message: string }) {
        const current = shas.get(input.path)
        if (current && input.sha !== current) throw new CrowdyApiError('stale', 'GITHUB_STALE_SHA')
        files[input.path] = input.content
        const sha = `sha-${input.path}-${input.content.length}`
        shas.set(input.path, sha)
        puts.push({ path: input.path, sha: input.sha, message: input.message })
        return { path: input.path, content: input.content, sha }
      },
    },
    async loadProject() {
      return { projectId: 'p', appId: '2', ownerUserId: '1', name: 'Mod', revision: '3', archived: false, updatedAt: '', files: [] }
    },
    async saveFiles(args: unknown) {
      mirror.push(args)
      return { projectId: 'p', appId: '2', ownerUserId: '1', name: 'Mod', revision: '4', archived: false, updatedAt: '', files: [] }
    },
  }
  return { client: client as unknown as CrowdyStudioClient, puts, mirror, files }
}

describe('github layout', () => {
  it('maps repository paths onto Studio targets both ways', () => {
    const layout = parseCrowdyJson('{"server":"server","client":"client"}')!
    assert.deepEqual(repoPathToStudioFile(layout, 'server/src/lib.rs'), { target: 'SERVER', path: 'src/lib.rs' })
    assert.deepEqual(repoPathToStudioFile(layout, 'client/Cargo.toml'), { target: 'CLIENT', path: 'Cargo.toml' })
    assert.equal(repoPathToStudioFile(layout, 'README.md'), null)
    assert.equal(studioFileToRepoPath(layout, 'CLIENT', 'src/lib.rs'), 'client/src/lib.rs')
    assert.deepEqual(layoutFromTree([{ path: 'server', type: 'tree' }]), { serverRoot: 'server', clientRoot: null })
    assert.deepEqual(layoutFromTree([]), { serverRoot: '.', clientRoot: null })
  })
})

describe('selectProjectStore', () => {
  it('prefers the bound repository and falls back to Studio files', async () => {
    const bound = await selectProjectStore(fakeClient({ bound: true }).client, 'p', { githubFirst: true })
    assert.equal(bound.store.kind, 'github')
    assert.match(bound.reason, /acme\/mod@main/)
    const unbound = await selectProjectStore(fakeClient({ bound: false }).client, 'p', { githubFirst: true })
    assert.equal(unbound.store.kind, 'studio')
    const disabled = await selectProjectStore(fakeClient({ bound: true }).client, 'p', { githubFirst: false })
    assert.equal(disabled.store.kind, 'studio')
  })
})

describe('GitHubProjectStore', () => {
  it('loads mapped source files, commits with SHA guards, and mirrors to Studio', async () => {
    const fake = fakeClient({
      bound: true,
      files: {
        'crowdy.json': '{"server":"server","client":"client"}',
        'server/src/lib.rs': 'fn a() {}',
        'server/Cargo.toml': '[package]',
        'client/src/lib.rs': 'fn c() {}',
        'server/notes.txt': 'ignored: not a source path',
        'README.md': 'ignored',
      },
    })
    const store = new GitHubProjectStore(fake.client, 'p', 'acme/mod@main')
    const snapshot = await store.load()
    assert.equal(snapshot.source, 'github')
    assert.deepEqual(
      snapshot.files.map((file) => `${file.target}:${file.path}`),
      ['CLIENT:src/lib.rs', 'SERVER:Cargo.toml', 'SERVER:src/lib.rs'],
    )

    const next = await store.commit(snapshot, { upserts: [{ target: 'SERVER', path: 'src/lib.rs', content: 'fn a() { changed() }' }, { target: 'SERVER', path: 'src/new.rs', content: 'fn n() {}' }] })
    assert.deepEqual(fake.puts.map((put) => [put.path, put.sha === undefined ? 'create' : 'guarded']), [
      ['server/src/lib.rs', 'guarded'],
      ['server/src/new.rs', 'create'],
    ])
    assert.equal(fake.mirror.length, 1, 'the Studio mirror received the batch')
    assert.equal(next.files.find((file) => file.path === 'src/new.rs')?.content, 'fn n() {}')
    assert.notEqual(next.revision, snapshot.revision)

    // A stale snapshot loses the race in the shared vocabulary.
    await assert.rejects(
      store.commit(snapshot, { upserts: [{ target: 'SERVER', path: 'src/lib.rs', content: 'x' }] }),
      (error: unknown) => error instanceof CrowdyApiError && error.isRevisionConflict,
    )
    // Deletes are not offered for GitHub-bound projects.
    await assert.rejects(
      store.commit(next, { deletes: [{ target: 'SERVER', path: 'src/new.rs' }] }),
      (error: unknown) => error instanceof CrowdyApiError && error.code === 'GITHUB_DELETE_UNSUPPORTED',
    )
  })
})
