/**
 * Game editor tools, registered by the `crowdy-game` preset. File edits go
 * through the game filesystem into the page's draft; these tools publish the
 * draft, ask whether the world took it, and read the game's playbook.
 *
 * @module @crowdedkingdoms/crowdy-dsh/game-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'

import type { CrowdyBridge } from '../bridge/index.js'
import { BridgeError } from '../bridge/client.js'
import { DRAFT_ERROR_CODES } from '../bridge/protocol.js'
import { assertPlaybookPage } from '../crowdy/playbook.js'
import { isRepoPath } from '../crowdy/repo-paths.js'

export interface Config {
  /** Deadline for a commit, the player's confirmation included, in milliseconds. */
  commitTimeoutMs?: number
}

export const name = 'crowdy-game-tools'
export const inject = ['tools', 'crowdyBridge']

export const Config: z<Config> = z.object({
  commitTimeoutMs: z.number().default(180_000),
}) as unknown as z<Config>

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args: unknown, value: { text: string }): ContentBlock[] => [{ type: 'text', text: value.text }],
} as const

/** A page refusal in words the model can act on. */
function bridgeFailure(error: unknown): never {
  if (error instanceof BridgeError) {
    switch (error.code) {
      case DRAFT_ERROR_CODES.declined:
        throw new Error(`${error.message} Do not commit again until the player asks.`)
      case DRAFT_ERROR_CODES.conflict:
        throw new Error(
          `${error.message} The player settles each conflict in Crowdy Studio's Files pane (keep the draft or take GitHub's version); wait for them, then commit again if they ask.`,
        )
      default:
        throw new Error(error.message)
    }
  }
  throw error instanceof Error ? error : new Error(String(error))
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const bridge: CrowdyBridge = ctx.crowdyBridge
  const commitTimeout = config.commitTimeoutMs ?? 180_000

  ctx.tools.register(
    defineTool({
      name: 'commit_game_files',
      description:
        'Commit the draft to the game repository on GitHub as ONE commit with your message. Only when the player asks to commit. ' +
        'The player approves here and confirms again on the page, seeing the files and the message. ' +
        'Omit paths to commit every changed file; name paths to commit some of them. Writes alone never reach GitHub.',
      parameters: {
        message: {
          type: 'string',
          required: true,
          description: 'Commit message: what changed and why, in one or two sentences (GitHub shows it).',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Repository paths to commit. Omit for every changed file.',
        },
      },
      output: TEXT_OUTPUT,
      timeoutMs: commitTimeout + 10_000,
      async execute(args, exec) {
        const message = String(args.message ?? '').trim()
        if (!message) throw new Error('A commit needs a message that says what changed.')
        const paths = Array.isArray(args.paths) ? args.paths.map(String) : undefined
        for (const path of paths ?? []) {
          if (!isRepoPath(path)) throw new Error(`${path} is not a file in the game repository.`)
        }
        const approval = ctx.get('approval')
        if (!approval || !exec.agent) {
          throw new Error('Commits need the approval service, which this composition does not mount. Ask the player to commit from the Files pane.')
        }
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: 'commit_game_files',
          callId: exec.callId,
          reason: `Commit ${paths ? paths.join(', ') : 'every changed file'} to GitHub: ${message}`,
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          throw new Error(
            outcome === 'rejected'
              ? 'The player declined the commit. The draft is unchanged; do not commit again until they ask.'
              : outcome === 'cancelled'
                ? 'The commit approval was cancelled.'
                : 'No one could approve the commit right now; the player can commit from the Files pane.',
          )
        }
        try {
          const result = await bridge.client.request(
            'draft.commit',
            { message, ...(paths && paths.length > 0 ? { paths } : {}) },
            { signal: exec.signal, timeoutMs: commitTimeout },
          )
          return {
            text: `Committed ${result.committed.length} file${result.committed.length === 1 ? '' : 's'} as ${result.commitSha.slice(0, 7)}: ${result.committed.join(', ')}. The draft now builds on that commit.`,
          }
        } catch (error) {
          bridgeFailure(error)
        }
      },
      presentCall: (args): ToolCallView => ({
        card: 'generic',
        title: 'Commit to GitHub',
        kind: 'execute',
        rawInput: String(args.message ?? ''),
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'preview_status',
      description:
        'Whether the running world took your latest draft writes: the scene it shows and any load or mount errors with their file and line. ' +
        'Call it after changing a scene, the catalog or the content registry, before telling the player it works.',
      parameters: {
        timeoutSeconds: { type: 'number', description: 'How long to wait for the world to reload (default 10, at most 60).' },
      },
      output: TEXT_OUTPUT,
      timeoutMs: 70_000,
      async execute(args, exec) {
        const wait = Math.min(Math.max(Number(args.timeoutSeconds) || 10, 1), 60) * 1_000
        try {
          const status = await bridge.client.request('preview.status', { timeoutMs: wait }, { signal: exec.signal, timeoutMs: wait + 5_000 })
          const lines = [
            status.ok ? `The world took draft revision ${status.revision}.` : `The world did NOT take draft revision ${status.revision}.`,
            ...(status.scene ? [`Scene: ${status.scene}.`] : []),
            ...status.errors.map(
              (e) => `- ${e.path ?? '(page)'}${e.line ? `:${e.line}${e.column ? `:${e.column}` : ''}` : ''}: ${e.message}`,
            ),
            ...(status.note ? [status.note] : []),
          ]
          return { text: lines.join('\n') }
        } catch (error) {
          bridgeFailure(error)
        }
      },
      presentCall: (): ToolCallView => ({ card: 'generic', title: 'Preview status', kind: 'read' }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'read_playbook',
      description:
        "Read one page of the game's playbook (markdown shipped with the game), such as a page a skill names. page is a relative path like playbook/authoring-loop.md.",
      parameters: {
        page: { type: 'string', required: true, description: 'Relative markdown path under the playbook.' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const page = assertPlaybookPage(String(args.page ?? ''))
        try {
          const result = await bridge.client.request('studio.readPlaybook', { page }, { signal: exec.signal, timeoutMs: 15_000 })
          return { text: result.text }
        } catch (error) {
          bridgeFailure(error)
        }
      },
      presentCall: (args): ToolCallView => ({ card: 'generic', title: `Playbook ${String(args.page ?? '')}`, kind: 'read' }),
    }),
  )
}

export default { name, inject, Config, apply }
