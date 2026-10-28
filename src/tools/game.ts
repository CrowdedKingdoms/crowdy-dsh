/**
 * Game-mode tools. Registered only when the boot is `studioMode: game`.
 * File edits go through the repository filesystem. This plugin commits and
 * reads the playbook. It does not draft-test or deploy a mod.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'

import type { CrowdyBridge } from '../bridge/index.js'
import { BridgeError } from '../bridge/client.js'
import { activeStudioMode } from '../crowdy/config.js'
import { assertPlaybookPage } from '../crowdy/game-paths.js'
import { isRepoPath } from '../crowdy/repo-paths.js'

export const name = 'crowdy-tools-game'
export const inject = ['tools', 'crowdyBridge']

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: { text: string }): ContentBlock[] => [{ type: 'text', text: value.text }],
} as const

function bridgeFailure(error: unknown): never {
  if (error instanceof BridgeError) throw new Error(error.message)
  throw error instanceof Error ? error : new Error(String(error))
}

export async function apply(ctx: Context): Promise<void> {
  if (activeStudioMode() !== 'game') return
  const bridge: CrowdyBridge = ctx.crowdyBridge

  ctx.tools.register(
    defineTool({
      name: 'read_playbook',
      description:
        'Read one page of the MMO Anything playbook shipped with this game. ' +
        'page is a relative markdown path such as playbook/authoring-loop.md or skills/mmo-scene/SKILL.md. ' +
        'Only those shipped pages are readable.',
      parameters: {
        page: { type: 'string', required: true, description: 'Relative markdown path under the shipped playbook.' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const page = assertPlaybookPage(args.page)
        try {
          const result = await bridge.client.request('studio.readPlaybook', { page }, { signal: exec.signal, timeoutMs: 15_000 })
          return { text: result.text }
        } catch (error) {
          bridgeFailure(error)
        }
      },
      presentCall: (args): ToolCallView => ({ card: 'generic', title: `Playbook ${args.page}`, kind: 'read' }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'commit_game_file',
      description:
        'Commit drafted repository files to the bound GitHub branch. Pass path to commit one file. ' +
        'Omit path to commit every file the draft has changed. Call this only when the player asks to commit. ' +
        'Edits themselves are not commits: write the file, then the local game updates from the draft.',
      parameters: {
        path: { type: 'string', description: 'Repository path to commit. Omit to commit every dirty draft file.' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        try {
          const paths = args.path
            ? [args.path]
            : (
                await bridge.client.request('studio.listDirty', {}, { signal: exec.signal, timeoutMs: 15_000 })
              ).paths
          if (paths.length === 0) return { text: 'No drafted files to commit.' }
          const shas: string[] = []
          for (const path of paths) {
            if (!isRepoPath(path)) throw new Error(`${path} is not a file in the bound repository.`)
            const result = await bridge.client.request(
              'studio.commitGameFile',
              { path },
              { signal: exec.signal, timeoutMs: 30_000 },
            )
            shas.push(`${path} at ${result.commitSha}`)
          }
          return { text: `Committed ${shas.join('; ')}.` }
        } catch (error) {
          bridgeFailure(error)
        }
      },
      presentCall: (args): ToolCallView => ({
        card: 'generic',
        title: args.path ? `Commit ${args.path}` : 'Commit drafted files',
        kind: 'edit',
      }),
    }),
  )
}
