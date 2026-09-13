import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CrowdyApiError, type CrowdyProject, type CrowdyStudioClient } from './client.js'
import { CrowdyProjectStore, describeSource, repoPathFor, snapshotOf } from './project-store.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

function project(overrides: Partial<CrowdyProject> = {}): CrowdyProject {
  return {
    projectId: 'p',
    appId: '2',
    ownerUserId: '1',
    name: 'Mod',
    revision: '3',
    archived: false,
    updatedAt: '',
    source: 'STUDIO',
    github: null,
    files: [
      { target: 'SERVER', path: 'Cargo.toml', content: '[package]', revision: '1', updatedAt: '' },
      { target: 'SERVER', path: 'src/lib.rs', content: 'fn a() {}', revision: '1', updatedAt: '' },
      { target: 'CLIENT', path: 'src/lib.rs', content: 'fn c() {}', revision: '1', updatedAt: '' },
    ],
    ...overrides,
  }
}

/**
 * A fake CrowdyJS slice: the server's project (mirror) plus the GitHub
 * Contents mutations. A GitHub write advances the mirror commit and the
 * mirrored file, exactly as the server does; a Studio save bumps the revision.
 */
function fakeClient(initial: CrowdyProject) {
  let current = structuredClone(initial)
  let sha = initial.github?.sha ?? SHA_A
  const puts: Array<{ path: string; expectedCommitSha: string; sha?: string }> = []
  const deletes: Array<{ path: string; expectedCommitSha: string }> = []
  const saves: unknown[] = []
  const layouts: string[] = []
  const nextSha = () => (sha = sha === SHA_A ? SHA_B : SHA_C)
  const client = {
    appId: '2',
    async authenticate() {
      return 'token'
    },
    github: {
      async layout(input: { commitSha?: string }) {
        layouts.push(input.commitSha ?? '')
        return { commitSha: input.commitSha ?? sha, server: 'server', client: 'client', assets: 'assets', fromFile: true }
      },
      async putFile(input: { path: string; content: string; expectedCommitSha: string; sha?: string }) {
        if (input.expectedCommitSha !== sha) throw new CrowdyApiError('moved', 'GITHUB_STALE_SHA')
        puts.push({ path: input.path, expectedCommitSha: input.expectedCommitSha, sha: input.sha })
        const commit = nextSha()
        const [root, ...rest] = input.path.split('/')
        const target = root === 'client' ? 'CLIENT' : 'SERVER'
        const path = rest.join('/')
        const existing = current.files.find((f) => f.target === target && f.path === path)
        if (existing) existing.content = input.content
        else current.files.push({ target, path, content: input.content, revision: '1', updatedAt: '' })
        current = { ...current, revision: String(Number(current.revision) + 1), github: { ...current.github!, sha: commit } }
        return { path: input.path, content: input.content, sha: 'blob', commitSha: commit }
      },
      async deleteFile(input: { path: string; expectedCommitSha: string }) {
        if (input.expectedCommitSha !== sha) throw new CrowdyApiError('moved', 'GITHUB_STALE_SHA')
        deletes.push({ path: input.path, expectedCommitSha: input.expectedCommitSha })
        const commit = nextSha()
        const [root, ...rest] = input.path.split('/')
        const target = root === 'client' ? 'CLIENT' : 'SERVER'
        current.files = current.files.filter((f) => !(f.target === target && f.path === rest.join('/')))
        current = { ...current, revision: String(Number(current.revision) + 1), github: { ...current.github!, sha: commit } }
        return { configured: true, connected: true, owner: 'acme', repo: 'mod', branch: 'main', githubSha: commit }
      },
    },
    async loadProject() {
      return structuredClone(current)
    },
    async saveFiles(args: { expectedRevision: string; upserts?: Array<{ target: 'SERVER' | 'CLIENT'; path: string; content: string }> }) {
      if (current.source === 'GITHUB') throw new CrowdyApiError('bound', 'GITHUB_BOUND_USE_CONTENTS')
      if (args.expectedRevision !== current.revision) throw new CrowdyApiError('stale', 'CROWDY_STUDIO_REVISION_CONFLICT')
      saves.push(args)
      for (const u of args.upserts ?? []) {
        const existing = current.files.find((f) => f.target === u.target && f.path === u.path)
        if (existing) existing.content = u.content
        else current.files.push({ ...u, revision: '1', updatedAt: '' })
      }
      current = { ...current, revision: String(Number(current.revision) + 1) }
      return structuredClone(current)
    },
    /** Test hook: something else (Monaco, a push) moved the branch. */
    moveHead() {
      const commit = nextSha()
      current = { ...current, github: { ...current.github!, sha: commit } }
    },
  }
  return { client: client as unknown as CrowdyStudioClient & { moveHead(): void }, puts, deletes, saves, layouts }
}

describe('repoPathFor', () => {
  it('joins project paths under the API-resolved roots and refuses a target with no root', () => {
    assert.equal(repoPathFor({ server: 'server', client: 'client' }, 'SERVER', 'src/lib.rs'), 'server/src/lib.rs')
    assert.equal(repoPathFor({ server: '.', client: null }, 'SERVER', 'Cargo.toml'), 'Cargo.toml')
    assert.throws(
      () => repoPathFor({ server: '.', client: null }, 'CLIENT', 'src/lib.rs'),
      (error: unknown) => error instanceof CrowdyApiError && error.code === 'GITHUB_PATH_INVALID',
    )
  })
})

describe('CrowdyProjectStore on a STUDIO project', () => {
  it('reads the project files and writes through the files-only save under the revision', async () => {
    const fake = fakeClient(project())
    const store = new CrowdyProjectStore(fake.client, 'p')
    const snapshot = await store.load()
    assert.equal(snapshot.source, 'studio')
    assert.equal(snapshot.revision, '3')
    assert.match(describeSource(snapshot), /not bound/)
    const next = await store.commit(snapshot, { upserts: [{ target: 'SERVER', path: 'src/lib.rs', content: 'fn b() {}' }] })
    assert.equal(fake.saves.length, 1)
    assert.equal(next.revision, '4')
    assert.equal(fake.puts.length, 0, 'a STUDIO project never touches GitHub')
    await assert.rejects(
      store.commit(snapshot, { upserts: [{ target: 'SERVER', path: 'src/lib.rs', content: 'x' }] }),
      (error: unknown) => error instanceof CrowdyApiError && error.isRevisionConflict,
    )
  })
})

describe('CrowdyProjectStore on a GITHUB project', () => {
  const bound = () => project({ source: 'GITHUB', github: { owner: 'acme', repo: 'mod', branch: 'main', sha: SHA_A } })

  it('reads the mirror (no per-file GitHub reads) and commits each changed file carrying the previous commit', async () => {
    const fake = fakeClient(bound())
    const store = new CrowdyProjectStore(fake.client, 'p')
    const snapshot = await store.load()
    assert.equal(snapshot.source, 'github')
    assert.equal(snapshot.revision, SHA_A, 'the commit is the version')
    assert.equal(snapshot.label, 'GitHub acme/mod@main')
    assert.match(describeSource(snapshot), /acme\/mod@main.*every write is a commit/)

    const next = await store.commit(snapshot, {
      upserts: [
        { target: 'SERVER', path: 'src/lib.rs', content: 'fn a() { changed() }' },
        { target: 'CLIENT', path: 'src/new.rs', content: 'fn n() {}' },
      ],
      deletes: [{ target: 'SERVER', path: 'Cargo.toml' }],
    })
    assert.deepEqual(
      fake.puts.map((p) => [p.path, p.expectedCommitSha]),
      [
        ['server/src/lib.rs', SHA_A],
        ['client/src/new.rs', SHA_B],
      ],
      'each commit carries the one before it',
    )
    assert.ok(fake.puts.every((p) => p.sha === undefined), 'the server resolves blob shas from expectedCommitSha')
    assert.deepEqual(fake.deletes, [{ path: 'server/Cargo.toml', expectedCommitSha: SHA_C }])
    assert.deepEqual(fake.layouts, [SHA_A], 'layout is read once, at the commit being written to')
    assert.equal(fake.saves.length, 0, 'nothing is mirrored back to Studio from here')
    assert.equal(next.files.find((f) => f.path === 'src/new.rs')?.content, 'fn n() {}')
    assert.equal(next.files.some((f) => f.path === 'Cargo.toml'), false)
    assert.notEqual(next.revision, snapshot.revision)
  })

  it('a stale snapshot (Monaco or a push moved the branch) loses in the shared vocabulary', async () => {
    const fake = fakeClient(bound())
    const store = new CrowdyProjectStore(fake.client, 'p')
    const snapshot = await store.load()
    fake.client.moveHead()
    await assert.rejects(
      store.commit(snapshot, { upserts: [{ target: 'SERVER', path: 'src/lib.rs', content: 'x' }] }),
      (error: unknown) => error instanceof CrowdyApiError && error.isRevisionConflict,
    )
    assert.equal(fake.puts.length, 0)
  })

  it('refuses to write a bound project that has no mirror commit yet', async () => {
    const fake = fakeClient(project({ source: 'GITHUB', github: { owner: 'acme', repo: 'mod', branch: 'main', sha: null } }))
    const store = new CrowdyProjectStore(fake.client, 'p')
    const snapshot = await store.load()
    await assert.rejects(
      store.commit(snapshot, { upserts: [{ target: 'SERVER', path: 'src/lib.rs', content: 'x' }] }),
      (error: unknown) => error instanceof CrowdyApiError && error.code === 'GITHUB_NOT_BOUND',
    )
  })
})

describe('snapshotOf', () => {
  it('decides the version by source', () => {
    assert.equal(snapshotOf(project()).revision, '3')
    assert.equal(snapshotOf(project({ source: 'GITHUB', github: { owner: 'a', repo: 'b', branch: 'c', sha: SHA_B } })).revision, SHA_B)
  })
})
