/**
 * Wire-level tests for the Crowdy Studio client.
 *
 * The client is CrowdyJS underneath. These run against a real HTTP server
 * rather than a stubbed `fetch`, so they cover the parts that only break on the
 * wire: the operation names, BigInt arguments carried as strings, bearer
 * headers, the login -> mintAppToken two-step, and error-code translation from
 * the GraphQL `errors` array into `CrowdyApiError`.
 */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, describe, it } from 'node:test'

import { CrowdyApiError, CrowdyStudioClient } from './client.js'

interface Received {
  query: string
  variables: Record<string, any>
  authorization: string | undefined
}

/** A GraphQL endpoint that records requests and replies from a queue. */
async function server(responses: unknown[]): Promise<{
  url: string
  received: Received[]
  close: () => Promise<void>
}> {
  const received: Received[] = []
  const queue = [...responses]

  const instance: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const parsed = JSON.parse(body)
      received.push({
        query: parsed.query,
        variables: parsed.variables,
        authorization: req.headers.authorization,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(queue.shift() ?? { data: {} }))
    })
  })

  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')

  return {
    url: `http://127.0.0.1:${address.port}/graphql`,
    received,
    close: () => new Promise<void>((resolve) => instance.close(() => resolve())),
  }
}

const PROJECT = {
  projectId: 'proj-1',
  appId: '2',
  ownerUserId: '7',
  name: 'Test',
  revision: '3',
  archived: false,
  files: [
    {
      target: 'SERVER',
      path: 'src/main.rs',
      content: 'fn main() {}',
      revision: '1',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
  updatedAt: '2026-01-01T00:00:00Z',
}

const servers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of servers) await close()
})

async function endpoint(responses: unknown[]) {
  const started = await server(responses)
  servers.push(started.close)
  return started
}

describe('CrowdyStudioClient', () => {
  it('loads a project with a pre-minted app token', async () => {
    const api = await endpoint([{ data: { crowdyStudioProject: PROJECT } }])
    const client = new CrowdyStudioClient({ endpoint: api.url, appId: '2', appToken: 'app-token' })

    const project = await client.loadProject('proj-1')

    assert.equal(project.revision, '3')
    assert.equal(project.files[0]?.path, 'src/main.rs')

    const request = api.received[0]!
    assert.equal(request.authorization, 'Bearer app-token')
    assert.match(request.query, /crowdyStudioProject\(appId: \$appId, projectId: \$projectId\)/)
    // BigInt arguments must stay strings; a JSON number would lose precision.
    assert.deepEqual(request.variables, { appId: '2', projectId: 'proj-1' })
  })

  it('mints an app token from credentials before the first call', async () => {
    const api = await endpoint([
      { data: { login: { token: 'session-token' } } },
      { data: { mintAppToken: { token: 'minted-app-token', appId: '2', expiresAt: 'later' } } },
      { data: { crowdyStudioProject: PROJECT } },
    ])
    const client = new CrowdyStudioClient({
      endpoint: api.url,
      appId: '2',
      email: 'dev@example.com',
      password: 'hunter22',
    })

    await client.loadProject('proj-1')

    assert.equal(api.received.length, 3)
    // Login is public and must not carry a stale bearer.
    assert.equal(api.received[0]?.authorization, undefined)
    assert.match(api.received[0]!.query, /login\(loginUserInput: \$loginUserInput\)/)
    // The session token mints the app token, which then scopes the real call.
    assert.equal(api.received[1]?.authorization, 'Bearer session-token')
    assert.equal(api.received[2]?.authorization, 'Bearer minted-app-token')
  })

  it('reuses the minted token instead of logging in per request', async () => {
    const api = await endpoint([
      { data: { login: { token: 'session-token' } } },
      { data: { mintAppToken: { token: 'minted', appId: '2', expiresAt: 'later' } } },
      { data: { crowdyStudioProject: PROJECT } },
      { data: { crowdyStudioProject: PROJECT } },
    ])
    const client = new CrowdyStudioClient({
      endpoint: api.url,
      appId: '2',
      email: 'dev@example.com',
      password: 'hunter22',
    })

    await client.loadProject('proj-1')
    await client.loadProject('proj-1')

    assert.equal(api.received.length, 4)
    assert.equal(api.received[3]?.authorization, 'Bearer minted')
  })

  it('sends upserts under the expected revision', async () => {
    const api = await endpoint([{ data: { crowdyStudioProjectSaveFiles: PROJECT } }])
    const client = new CrowdyStudioClient({ endpoint: api.url, appId: '2', appToken: 'app-token' })

    await client.saveFiles({
      projectId: 'proj-1',
      expectedRevision: '3',
      upserts: [{ target: 'SERVER', path: 'src/main.rs', content: 'fn main() {}' }],
      idempotencyKey: 'key-1',
    })

    assert.deepEqual(api.received[0]?.variables.input, {
      appId: '2',
      projectId: 'proj-1',
      expectedRevision: '3',
      upserts: [{ target: 'SERVER', path: 'src/main.rs', content: 'fn main() {}' }],
      idempotencyKey: 'key-1',
    })
  })

  it('omits empty batches so the server never sees a meaningless key', async () => {
    const api = await endpoint([{ data: { crowdyStudioProjectSaveFiles: PROJECT } }])
    const client = new CrowdyStudioClient({ endpoint: api.url, appId: '2', appToken: 'app-token' })

    await client.saveFiles({ projectId: 'proj-1', expectedRevision: '3', deletes: [] })

    const input = api.received[0]?.variables.input
    assert.equal('upserts' in input, false)
    assert.equal('deletes' in input, false)
  })

  it('surfaces a revision conflict with its code intact', async () => {
    const api = await endpoint([
      {
        errors: [
          {
            message: 'CROWDY_STUDIO_REVISION_CONFLICT: expected project revision 3; current is 4.',
            extensions: {
              code: 'CROWDY_STUDIO_REVISION_CONFLICT',
              remediation: 'Refetch the private project and reapply.',
            },
          },
        ],
      },
    ])
    const client = new CrowdyStudioClient({ endpoint: api.url, appId: '2', appToken: 'app-token' })

    await assert.rejects(
      () => client.saveFiles({ projectId: 'proj-1', expectedRevision: '3', upserts: [] }),
      (error: CrowdyApiError) => {
        assert.equal(error.isRevisionConflict, true)
        assert.equal(error.code, 'CROWDY_STUDIO_REVISION_CONFLICT')
        assert.match(error.remediation ?? '', /Refetch/)
        return true
      },
    )
  })

  it('reports a missing project as a plain coded error', async () => {
    const api = await endpoint([
      {
        errors: [
          {
            message: 'CROWDY_STUDIO_PROJECT_NOT_FOUND',
            extensions: { code: 'NOT_FOUND' },
          },
        ],
      },
    ])
    const client = new CrowdyStudioClient({ endpoint: api.url, appId: '2', appToken: 'app-token' })

    await assert.rejects(
      () => client.loadProject('missing'),
      (error: CrowdyApiError) => error.code === 'NOT_FOUND' && !error.isRevisionConflict,
    )
  })

  it('refuses to run without either a token or credentials', async () => {
    const api = await endpoint([])
    const client = new CrowdyStudioClient({ endpoint: api.url, appId: '2' })

    await assert.rejects(
      () => client.loadProject('proj-1'),
      (error: CrowdyApiError) => error.code === 'CROWDY_DSH_NO_CREDENTIALS',
    )
  })

})
