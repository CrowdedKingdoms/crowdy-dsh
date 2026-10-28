/**
 * The build tools as the model sees them: a draft test deploys the project's mod to the grid
 * (ck-exec has no private draft), so the tool says so and waits long enough for the page to ask
 * the player before it builds.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply } from './index.js'

interface RegisteredTool {
  name: string
  description: string
  timeoutMs?: number
  execute(args: unknown, exec: unknown): Promise<unknown>
}

function harness() {
  const tools = new Map<string, RegisteredTool>()
  const requests: Array<{ method: string; timeoutMs?: number }> = []
  const bridge = {
    client: {
      async request(method: string, params: unknown, options: { timeoutMs?: number }) {
        requests.push({ method, timeoutMs: options.timeoutMs })
        if (method === 'studio.putGameFile') return { path: (params as { path: string }).path }
        if (method === 'studio.commitGameFile') return { commitSha: 'abc123' }
        return { ok: true, mode: 'draft', summary: 'ok', diagnostics: [], buildLog: '', runtime: [] }
      },
    },
    fs: { mountRoot: '/mnt/crowdy', invalidate() {} },
    putContext() {},
    putCapture: () => ({ path: '/captures/x.png' }),
  }
  const ctx = {
    crowdyBridge: bridge,
    tools: { register: (tool: RegisteredTool) => tools.set(tool.name, tool) },
    get: () => undefined,
  }
  return { ctx, tools, requests }
}

describe('draft_test', () => {
  it('tells the model a draft reaches the grid and that the page asks the player first', async () => {
    const { ctx, tools } = harness()
    await apply(ctx as never, { buildTimeoutMs: 1_000, autoScreenshot: false })
    const draft = tools.get('draft_test')
    assert.ok(draft)
    assert.match(draft.description, /deploys the project's mod to the grid/)
    assert.match(draft.description, /page asks the player first/)
    assert.doesNotMatch(draft.description, /Nothing here is visible to other players/)
  })

  it('gives the page a minute to ask the player before the build counts against the deadline', async () => {
    const { ctx, tools, requests } = harness()
    await apply(ctx as never, { buildTimeoutMs: 1_000, autoScreenshot: false })
    await tools.get('draft_test')!.execute({}, { signal: undefined })
    assert.deepEqual(requests, [{ method: 'studio.draftTest', timeoutMs: 61_000 }])
    assert.ok((tools.get('draft_test')!.timeoutMs ?? 0) > 61_000)
  })
})

describe('mod mode', () => {
  it('does not register the repository commit tool', async () => {
    const { ctx, tools } = harness()
    await apply(ctx as never, { buildTimeoutMs: 1_000, autoScreenshot: false })
    assert.equal(tools.has('draft_test'), true)
    assert.equal(tools.has('commit_game_file'), false)
    assert.equal(tools.has('write_game_file'), false)
  })

  it('mounts nothing when the boot is the game pair', async () => {
    const previous = process.env.CROWDY_STUDIO_MODE
    process.env.CROWDY_STUDIO_MODE = 'game'
    try {
      const { ctx, tools } = harness()
      await apply(ctx as never, { buildTimeoutMs: 1_000, autoScreenshot: false })
      assert.equal(tools.has('draft_test'), false)
    } finally {
      if (previous === undefined) delete process.env.CROWDY_STUDIO_MODE
      else process.env.CROWDY_STUDIO_MODE = previous
    }
  })
})
