/**
 * Game-mode tools commit the draft. They do not register the mod build tools.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply } from './game.js'

interface RegisteredTool {
  name: string
  description: string
  execute(args: unknown, exec: unknown): Promise<unknown>
}

function harness() {
  const tools = new Map<string, RegisteredTool>()
  const requests: Array<{ method: string; params: unknown }> = []
  const bridge = {
    client: {
      async request(method: string, params: unknown) {
        requests.push({ method, params })
        if (method === 'studio.listDirty') return { paths: ['src/main.ts'] }
        if (method === 'studio.commitGameFile') return { commitSha: 'abc123' }
        if (method === 'studio.readPlaybook') return { text: '# playbook' }
        return {}
      },
    },
  }
  const ctx = {
    crowdyBridge: bridge,
    tools: { register: (tool: RegisteredTool) => tools.set(tool.name, tool) },
  }
  return { ctx, tools, requests }
}

describe('game tools', () => {
  it('does not register while the boot is the mod pair', async () => {
    const { ctx, tools } = harness()
    await apply(ctx as never)
    assert.equal(tools.size, 0)
  })

  it('commits one drafted file and does not register draft_test', async () => {
    const previous = process.env.CROWDY_STUDIO_MODE
    process.env.CROWDY_STUDIO_MODE = 'game'
    try {
      const { ctx, tools, requests } = harness()
      await apply(ctx as never)
      assert.equal(tools.has('draft_test'), false)
      assert.equal(tools.has('deploy_live'), false)
      const commit = tools.get('commit_game_file')
      assert.ok(commit)
      const result = await commit.execute({ path: 'src/main.ts' }, { signal: undefined })
      assert.match((result as { text: string }).text, /Committed src\/main.ts at abc123/)
      assert.deepEqual(requests.map((call) => call.method), ['studio.commitGameFile'])
      const all = await commit.execute({}, { signal: undefined })
      assert.match((all as { text: string }).text, /src\/main.ts at abc123/)
      assert.deepEqual(requests.map((call) => call.method), [
        'studio.commitGameFile',
        'studio.listDirty',
        'studio.commitGameFile',
      ])
    } finally {
      if (previous === undefined) delete process.env.CROWDY_STUDIO_MODE
      else process.env.CROWDY_STUDIO_MODE = previous
    }
  })
})
