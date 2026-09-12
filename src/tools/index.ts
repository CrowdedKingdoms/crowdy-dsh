/**
 * Crowdy Studio tools: what the model can do beyond editing files.
 *
 * Every tool here either reads the project through the filesystem backend or
 * asks the Studio page (over `ctx.crowdyBridge`) to do something only the page
 * can: compile and run a draft, deploy live, take a screenshot of the game,
 * switch projects, observe the world. The model never receives a token, a
 * shell, or the network; the page keeps the same authority it has for a human.
 *
 * @module @crowdedkingdoms/crowdy-dsh/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-user-approval'

import type { CrowdyBridge } from '../bridge/index.js'
import { BridgeError } from '../bridge/client.js'
import type { BuildResult, ScreenshotResult, StudioDiagnostic } from '../bridge/protocol.js'

export interface Config {
  /** Deadline for a draft test or live deploy, in milliseconds. */
  buildTimeoutMs?: number
  /** Deadline for a screenshot, in milliseconds. */
  screenshotTimeoutMs?: number
  /** Take a screenshot automatically after a draft test that started the client target. */
  autoScreenshot?: boolean
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'crowdy-tools'

export const inject = ['tools', 'fs', 'crowdyBridge']

export const Config: z<Config> = z.object({
  buildTimeoutMs: z.number().default(180_000),
  screenshotTimeoutMs: z.number().default(15_000),
  autoScreenshot: z.boolean().default(true),
}) as unknown as z<Config>

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

function formatDiagnostics(diagnostics: StudioDiagnostic[]): string {
  if (diagnostics.length === 0) return 'No diagnostics.'
  return diagnostics
    .slice(0, 40)
    .map((d) => {
      const where = `${d.target.toLowerCase()}/${d.path}${d.line ? `:${d.line}${d.column ? `:${d.column}` : ''}` : ''}`
      return `${d.severity.toUpperCase()} ${where} — ${d.message}`
    })
    .join('\n')
}

function formatBuild(result: BuildResult, root: string): string {
  const lines = [
    `${result.mode === 'draft' ? 'Draft test' : 'Live deploy'}: ${result.ok ? 'OK' : 'FAILED'} — ${result.summary}`,
    '',
    'Diagnostics:',
    formatDiagnostics(result.diagnostics),
  ]
  if (result.runtime.length > 0) {
    lines.push('', 'Runtime:')
    for (const status of result.runtime) {
      lines.push(
        `- ${status.target}: ${status.phase}${status.moduleName ? ` (${status.moduleName})` : ''}${status.message ? ` — ${status.message}` : ''}`,
      )
    }
  }
  if (result.buildLog.trim()) {
    lines.push('', 'Build log (tail):', result.buildLog.trim().split('\n').slice(-60).join('\n'))
  }
  lines.push(
    '',
    `Diagnostics were also written to ${root}/context/diagnostics.json. Fix errors in the files they name (server/ or client/ under ${root}), then run draft_test again.`,
  )
  return lines.join('\n')
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const bridge: CrowdyBridge = ctx.crowdyBridge
  const fs = bridge.fs
  const buildTimeout = config.buildTimeoutMs ?? 180_000
  const screenshotTimeout = config.screenshotTimeoutMs ?? 15_000
  const autoScreenshot = config.autoScreenshot ?? true

  /** Persist a capture under `captures/` and turn it into an image block when a store exists. */
  async function attachCapture(shot: ScreenshotResult): Promise<{ path: string; blocks: ContentBlock[]; note: string }> {
    const { path } = bridge.putCapture(shot)
    const attachments = ctx.get('attachments')
    if (!attachments) {
      return { path, blocks: [], note: `Saved to ${path}; read it with read_image.` }
    }
    try {
      const ref = await attachments.saveImage({
        data: new Uint8Array(shot.bytes),
        mediaType: shot.mediaType,
        name: path.slice(path.lastIndexOf('/') + 1),
      })
      return {
        path,
        blocks: [{ type: 'image', attachment: ref }],
        note: `Screenshot ${ref.width}x${ref.height} attached (also at ${path}).${shot.caption ? ` ${shot.caption}` : ''}`,
      }
    } catch (error) {
      return {
        path,
        blocks: [],
        note: `Saved to ${path} but it could not be attached: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  async function runBuild(mode: 'draft' | 'live', exec: ToolRunContext): Promise<{ text: string; imagePath?: string }> {
    let result: BuildResult
    try {
      result = await bridge.client.request(
        mode === 'draft' ? 'studio.draftTest' : 'studio.deployLive',
        {},
        { signal: exec.signal, timeoutMs: buildTimeout },
      )
    } catch (error) {
      bridgeFailure(error)
    }
    bridge.putContext({ diagnostics: result.diagnostics, runtime: result.runtime })
    fs.invalidate()
    let text = formatBuild(result, fs.mountRoot)
    let imagePath: string | undefined
    const clientRan = result.ok && result.runtime.some((status) => status.target === 'CLIENT' && /run|live|draft/i.test(status.phase))
    const shot = result.screenshot ?? (autoScreenshot && clientRan ? await tryScreenshot(exec, 'after draft test') : undefined)
    if (shot) {
      const saved = bridge.putCapture(shot)
      imagePath = saved.path
      text += `\n\nA screenshot of the game after the run is at ${imagePath}; call read_image on it to see the result.`
    }
    return imagePath ? { text, imagePath } : { text }
  }

  async function tryScreenshot(exec: ToolRunContext, label: string): Promise<ScreenshotResult | undefined> {
    try {
      return await bridge.client.request('studio.screenshot', { label }, { signal: exec.signal, timeoutMs: screenshotTimeout })
    } catch {
      return undefined
    }
  }

  const buildOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', required: true }, imagePath: { type: 'string' } },
    },
    render: (_args: unknown, value: { text: string; imagePath?: string }): ContentBlock[] => [{ type: 'text', text: value.text }],
  } as const

  ctx.tools.register(
    defineTool({
      name: 'draft_test',
      description:
        'Compile the current Crowdy Studio project and run it as a DRAFT on the player\'s own grid (server target) and browser (client target). ' +
        'Returns compiler diagnostics, the build log tail and runtime status; a screenshot of the game is captured when the client target ran. ' +
        'Use this after every meaningful edit. Nothing here is visible to other players.',
      parameters: {},
      output: buildOutput,
      timeoutMs: buildTimeout + 5_000,
      execute: (_args, exec) => runBuild('draft', exec),
      presentCall: (): ToolCallView => ({ card: 'generic', title: 'Draft test', kind: 'execute' }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'deploy_live',
      description:
        'Deploy the current project LIVE so other players on the grid run it. Requires the player\'s explicit approval every time; ' +
        'run draft_test first and only deploy when it passed and the player asked for a live deploy.',
      parameters: {
        reason: { type: 'string', required: true, description: 'One sentence the player will read when asked to approve the deploy.' },
      },
      output: buildOutput,
      timeoutMs: buildTimeout + 60_000,
      async execute(args, exec) {
        const approval = ctx.get('approval')
        if (!approval || !exec.agent) {
          throw new Error('Live deploys need the approval service, which this composition does not mount. Ask the player to deploy from the Studio panel.')
        }
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: 'deploy_live',
          callId: exec.callId,
          reason: `Deploy the project live for other players: ${args.reason}`,
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          throw new Error(
            outcome === 'rejected'
              ? 'The player declined the live deploy. Keep working in draft mode.'
              : outcome === 'cancelled'
                ? 'The deploy approval was cancelled.'
                : 'No one could approve the deploy right now; ask the player to deploy from the Studio panel.',
          )
        }
        return runBuild('live', exec)
      },
      presentCall: (args): ToolCallView => ({ card: 'generic', title: 'Deploy live', kind: 'execute', rawInput: args.reason }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'screenshot',
      description:
        'Capture what the player currently sees in the game (the 3D view, HUD text and any overlay a CLIENT mod drew) and attach it as an image. ' +
        'Use it to check a visual change, or when the player refers to something on screen. Requires a model that accepts images.',
      parameters: {
        label: { type: 'string', description: 'Short note on why the capture was taken; stored beside the image.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            note: { type: 'string', required: true },
            attachment: { type: 'json' },
          },
        },
        render: (_args, value) => {
          const blocks: ContentBlock[] = [{ type: 'text', text: value.note }]
          if (value.attachment && typeof value.attachment === 'object') {
            blocks.push({ type: 'image', attachment: value.attachment as never })
          }
          return blocks
        },
        presentationMeta: (_args, value) => ({ path: value.path }),
      },
      timeoutMs: screenshotTimeout + 5_000,
      async execute(args, exec) {
        let shot: ScreenshotResult
        try {
          shot = await bridge.client.request('studio.screenshot', { label: args.label }, { signal: exec.signal, timeoutMs: screenshotTimeout })
        } catch (error) {
          bridgeFailure(error)
        }
        const saved = await attachCapture(shot)
        const attachment = saved.blocks.find((block) => block.type === 'image')
        return {
          path: saved.path,
          note: saved.note,
          ...(attachment && attachment.type === 'image' ? { attachment: JSON.parse(JSON.stringify(attachment.attachment)) as JsonValue } : {}),
        }
      },
      presentCall: (args): ToolCallView => ({ card: 'generic', title: 'Screenshot', kind: 'read', rawInput: args.label ?? '' }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'runtime_status',
      description: 'Current status of the project\'s SERVER and CLIENT modules: saved vs running revision, phase, and the latest runtime logs.',
      parameters: {
        log_lines: { type: 'integer', description: 'How many recent runtime log lines to include (default 40).' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        try {
          const [status, logs] = await Promise.all([
            bridge.client.request('studio.runtimeStatus', {}, { signal: exec.signal }),
            bridge.client.request('studio.runtimeLogs', { limit: args.log_lines ?? 40 }, { signal: exec.signal }),
          ])
          bridge.putContext({ runtime: status.runtime })
          const lines = status.runtime.map(
            (s) =>
              `- ${s.target}: ${s.phase}${s.moduleName ? ` (${s.moduleName})` : ''}${s.runningRevision ? ` running r${s.runningRevision}` : ''}${s.savedRevision ? ` saved r${s.savedRevision}` : ''}${s.message ? ` — ${s.message}` : ''}`,
          )
          return {
            text: `Runtime:\n${lines.join('\n') || '- (nothing running)'}\n\nRecent logs${logs.truncated ? ' (truncated)' : ''}:\n${logs.lines.join('\n') || '(none)'}`,
          }
        } catch (error) {
          bridgeFailure(error)
        }
      },
      presentCall: (): ToolCallView => ({ card: 'generic', title: 'Runtime status', kind: 'read' }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'client_logs',
      description: 'Recent `crowdy::log` output from the CLIENT module running in the player\'s browser, plus browser-side runtime errors.',
      parameters: {
        limit: { type: 'integer', description: 'Maximum lines (default 80).' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        try {
          const logs = await bridge.client.request('studio.clientLogs', { limit: args.limit ?? 80 }, { signal: exec.signal })
          bridge.putContext({ clientLogs: logs.lines })
          return { text: logs.lines.length ? logs.lines.join('\n') : 'No client log lines yet.' }
        } catch (error) {
          bridgeFailure(error)
        }
      },
      presentCall: (): ToolCallView => ({ card: 'generic', title: 'Client logs', kind: 'read' }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'game_observe',
      description:
        'A structured snapshot of the player\'s surroundings from the game: position, grid and chunk, nearby actors and blocks, as the game reports them. ' +
        'Cheaper than a screenshot and exact; use it to ground world coordinates before writing code that touches voxels or actors.',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute(_args, exec) {
        try {
          const result = await bridge.client.request('game.observe', {}, { signal: exec.signal })
          bridge.putContext({ observation: result.observation })
          return { text: `Observed at ${result.capturedAt}:\n${JSON.stringify(result.observation, null, 2).slice(0, 12_000)}` }
        } catch (error) {
          bridgeFailure(error)
        }
      },
      presentCall: (): ToolCallView => ({ card: 'generic', title: 'Observe game', kind: 'read' }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'project_list',
      description: 'List the player\'s Crowdy Studio projects in this app and which one is open in the editor (and mounted here).',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute(_args, exec) {
        try {
          const result = await bridge.client.request('studio.projectList', {}, { signal: exec.signal })
          const lines = result.projects.map(
            (p) =>
              `- ${p.projectId === result.currentProjectId ? '* ' : ''}${p.name} [${p.kind}] id=${p.projectId}${p.github ? ` github=${p.github}` : ''} updated ${p.updatedAt}`,
          )
          return { text: lines.length ? `Projects (* = open):\n${lines.join('\n')}` : 'No projects yet; use project_create.' }
        } catch (error) {
          bridgeFailure(error)
        }
      },
      presentCall: (): ToolCallView => ({ card: 'generic', title: 'List projects', kind: 'read' }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'project_open',
      description: 'Open another of the player\'s projects in Crowdy Studio and mount it here; subsequent file tools read and write that project.',
      parameters: {
        project_id: { type: 'string', required: true, description: 'Project id from project_list.' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        try {
          const result = await bridge.client.request('studio.projectOpen', { projectId: args.project_id }, { signal: exec.signal })
          fs.setProject(result.project.projectId)
          return { text: `Opened "${result.project.name}" (${result.project.projectId}). The mount at ${fs.mountRoot} now shows its files.` }
        } catch (error) {
          bridgeFailure(error)
        }
      },
      presentCall: (args): ToolCallView => ({ card: 'generic', title: `Open project ${args.project_id}`, kind: 'other' }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'project_create',
      description:
        'Create a new Crowdy Studio project from a starter template, open it in the editor and mount it here. ' +
        'Templates come from the Studio starter catalog; omit `template` for the blank full-stack project.',
      parameters: {
        name: { type: 'string', required: true, description: 'Project name shown in Studio.' },
        template: { type: 'string', description: 'Starter template id, e.g. "blank", "hello-voxel".' },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        try {
          const result = await bridge.client.request(
            'studio.projectCreate',
            { name: args.name, ...(args.template ? { template: args.template } : {}) },
            { signal: exec.signal, timeoutMs: 60_000 },
          )
          fs.setProject(result.project.projectId)
          return { text: `Created "${result.project.name}" (${result.project.projectId}) and mounted it at ${fs.mountRoot}. List the directory to see the starter files.` }
        } catch (error) {
          bridgeFailure(error)
        }
      },
      presentCall: (args): ToolCallView => ({ card: 'generic', title: `Create project "${args.name}"`, kind: 'other' }),
    }),
  )
}
