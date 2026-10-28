/**
 * Mod filesystem plugin. Mounts the server/client crates unless this boot is
 * the game pair.
 */

import type { Context } from '@deepseek-ai/cordis'

import { activeStudioMode } from '../crowdy/config.js'
import CrowdyFileSystem from './crowdy-file-system.js'
import type { Config } from './crowdy-file-system.js'

export const name = 'crowdy-fs-mod'

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (activeStudioMode() === 'game') return
  await ctx.plugin(CrowdyFileSystem, config)
}

export default { name, apply }
