/**
 * Cordis plugin: inject the closed-world crowdy-compute-sdk index and a
 * `sdk_lookup` tool.
 *
 * The Studio project does not contain the SDK crate, so grep/read cannot
 * discover `crowdy::api::*`. This plugin is the swappable source of truth:
 * disable the row and the agent loses the index; point `sdkSourcePath` at a
 * newer `lib.rs` and the prompt rebuilds without a Studio seed change.
 *
 * @module @crowdy/dsh-cockpit/sdk-index
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolResult } from '@deepseek-ai/dsh-tools'

import { formatLookup, formatSdkPrompt, lookupSdkName } from './catalog.js'
import { parseCrowdyComputeSdk, type SdkEntry } from './parse-sdk.js'
import { SDK_SNAPSHOT, SDK_SNAPSHOT_VERSION } from './snapshot.js'

export interface Config {
  /**
   * Optional path to `crowdy-compute-sdk/src/lib.rs`. When set, the prompt
   * and lookup tool parse that file instead of the vendored 0.1.5 snapshot.
   */
  sdkSourcePath?: string
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'sdk-index-crowdy'

export const inject = ['tools', 'systemPrompt']

export const Config: z<Config> = z
  .object({
    sdkSourcePath: z.string(),
  })
  .default({ sdkSourcePath: '' }) as unknown as z<Config>

interface SystemPromptLike {
  section(entry: { name: string; order: number; text: string }): void
}

async function loadCatalog(config: Config): Promise<{
  catalog: readonly SdkEntry[]
  source: string
}> {
  const path = config.sdkSourcePath?.trim()
  if (!path) {
    return { catalog: SDK_SNAPSHOT, source: `snapshot ${SDK_SNAPSHOT_VERSION}` }
  }
  const text = await readFile(path, 'utf8')
  const catalog = parseCrowdyComputeSdk(text)
  if (catalog.length === 0) {
    throw new Error(`sdk-index-crowdy: parsed no pub fn entries from ${path}`)
  }
  return { catalog, source: path }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const { catalog, source } = await loadCatalog(config ?? {})
  const systemPrompt = (ctx as unknown as { systemPrompt: SystemPromptLike }).systemPrompt

  systemPrompt.section({
    name: 'sdk-index',
    order: 90,
    text: `${formatSdkPrompt(catalog)}\n\n(index source: ${source})`,
  })

  const lookup = defineTool({
    name: 'sdk_lookup',
    description:
      'Look up a crowdy / crowdy::api function name in the closed-world SDK ' +
      'index. Use this when rustc says cannot find function X, or before ' +
      'writing a new host call. Returns the real signature or the nearest ' +
      'listed functions — never invent a name. Omit `name` to dump the index.',
    parameters: {
      name: {
        type: 'string',
        description:
          'Function name rustc could not find, with or without a crowdy:: / ' +
          'crowdy::api:: prefix (e.g. "emit", "voxel_set"). Empty dumps the index.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const query = typeof args.name === 'string' ? args.name.trim() : ''
      if (!query) {
        return { text: formatSdkPrompt(catalog) }
      }
      return { text: formatLookup(lookupSdkName(catalog, query)) }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: args.name ? `SDK lookup ${args.name}` : 'SDK index',
      kind: 'search',
      rawInput: typeof args.name === 'string' ? args.name : '',
    }),
    presentResult: (_args, result: ToolResult) => {
      if (result.isError) return undefined
      return undefined
    },
  })
  ctx.tools.register(lookup)
}
