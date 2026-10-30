/**
 * The game editor's tools as the model sees them: a commit needs the
 * harness approval and then the page's confirmation, and a refusal comes
 * back in words the model can act on.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BridgeError } from '../bridge/client.js'
import { apply } from './game.js'

interface RegisteredTool {
  name: string
  timeoutMs?: number
  execute(args: unknown, exec: unknown): Promise<{ text: string }>
}

type Outcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

function harness(options: { approval?: Outcome | null; reply?: (method: string, params: unknown) => unknown } = {}) {
  const tools = new Map<string, RegisteredTool>()
  const requests: Array<{ method: string; params: unknown; timeoutMs?: number }> = []
  const approvals: Array<{ toolName: string; reason: string }> = []
  const bridge = {
    client: {
      async request(method: string, params: unknown, opts: { timeoutMs?: number } = {}) {
        requests.push({ method, params, timeoutMs: opts.timeoutMs })
        if (options.reply) return options.reply(method, params)
        return { commitSha: 'abcdef1234567', committed: ['src/game/scenes/home.ts'] }
      },
    },
  }
  const approval =
    options.approval === null
      ? undefined
      : {
          async request(req: { toolName: string; reason: string }) {
            approvals.push({ toolName: req.toolName, reason: req.reason })
            return options.approval ?? 'allowed-once'
          },
        }
  const ctx = {
    crowdyBridge: bridge,
    tools: { register: (tool: RegisteredTool) => tools.set(tool.name, tool) },
    get: (name: string) => (name === 'approval' ? approval : undefined),
  }
  return { ctx, tools, requests, approvals }
}

const exec = { agent: {}, callId: 'call-1', signal: undefined }

describe('commit_game_files', () => {
  it('asks the harness approval, then commits through the page with the message and paths', async () => {
    const { ctx, tools, requests, approvals } = harness()
    await apply(ctx as never, { commitTimeoutMs: 1_000 })
    const result = await tools.get('commit_game_files')!.execute(
      { message: 'Add a pond to the home scene.', paths: ['src/game/scenes/home.ts'] },
      exec,
    )
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0]!.toolName, 'commit_game_files')
    assert.match(approvals[0]!.reason, /Add a pond/)
    assert.deepEqual(requests, [
      {
        method: 'draft.commit',
        params: { message: 'Add a pond to the home scene.', paths: ['src/game/scenes/home.ts'] },
        timeoutMs: 1_000,
      },
    ])
    assert.match(result.text, /Committed 1 file as abcdef1/)
  })

  it('refuses without a message and never asks', async () => {
    const { ctx, tools, approvals, requests } = harness()
    await apply(ctx as never)
    await assert.rejects(tools.get('commit_game_files')!.execute({ message: '  ' }, exec), /needs a message/)
    assert.equal(approvals.length, 0)
    assert.equal(requests.length, 0)
  })

  it('refuses a path outside the repository before asking', async () => {
    const { ctx, tools, approvals } = harness()
    await apply(ctx as never)
    await assert.rejects(
      tools.get('commit_game_files')!.execute({ message: 'x', paths: ['.github/workflows/ci.yml'] }, exec),
      /not a file in the game repository/,
    )
    assert.equal(approvals.length, 0)
  })

  it('stops when the player declines the approval', async () => {
    const { ctx, tools, requests } = harness({ approval: 'rejected' })
    await apply(ctx as never)
    await assert.rejects(tools.get('commit_game_files')!.execute({ message: 'x' }, exec), /declined the commit/)
    assert.equal(requests.length, 0)
  })

  it('says so when the composition has no approval service', async () => {
    const { ctx, tools } = harness({ approval: null })
    await apply(ctx as never)
    await assert.rejects(tools.get('commit_game_files')!.execute({ message: 'x' }, exec), /approval service/)
  })

  it('turns a page decline and a conflict into instructions', async () => {
    const declined = harness({
      reply: () => {
        throw new BridgeError('The player kept the draft.', 'DRAFT_DECLINED')
      },
    })
    await apply(declined.ctx as never)
    await assert.rejects(declined.tools.get('commit_game_files')!.execute({ message: 'x' }, exec), /Do not commit again/)

    const conflict = harness({
      reply: () => {
        throw new BridgeError('src/a.ts changed on GitHub.', 'DRAFT_CONFLICT')
      },
    })
    await apply(conflict.ctx as never)
    await assert.rejects(conflict.tools.get('commit_game_files')!.execute({ message: 'x' }, exec), /Files pane/)
  })
})

describe('preview_status', () => {
  it('reports the scene and each error with its place', async () => {
    const { ctx, tools } = harness({
      reply: () => ({
        revision: 4,
        ok: false,
        scene: 'home',
        errors: [{ path: 'src/game/scenes/home.ts', line: 12, column: 3, message: 'Unexpected token' }],
      }),
    })
    await apply(ctx as never)
    const result = await tools.get('preview_status')!.execute({}, exec)
    assert.match(result.text, /did NOT take draft revision 4/)
    assert.match(result.text, /src\/game\/scenes\/home\.ts:12:3: Unexpected token/)
  })
})

describe('read_playbook', () => {
  it('refuses a page outside the playbook before asking the page', async () => {
    const { ctx, tools, requests } = harness()
    await apply(ctx as never)
    await assert.rejects(tools.get('read_playbook')!.execute({ page: '../secrets.md' }, exec), /markdown files shipped with the game/)
    await assert.rejects(tools.get('read_playbook')!.execute({ page: 'index.html' }, exec), /playbook page/)
    assert.equal(requests.length, 0)
  })

  it('returns the page text', async () => {
    const { ctx, tools } = harness({ reply: () => ({ page: 'playbook/authoring-loop.md', text: '# Loop' }) })
    await apply(ctx as never)
    const result = await tools.get('read_playbook')!.execute({ page: 'playbook/authoring-loop.md' }, exec)
    assert.equal(result.text, '# Loop')
  })
})
