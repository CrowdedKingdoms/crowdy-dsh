/**
 * Game filesystem plugin. Mounts the bound repository unless this boot is the
 * mod pair.
 */

import type { Context } from '@deepseek-ai/cordis'

import { activeStudioMode } from '../crowdy/config.js'
import GameFileSystem, { type Config } from './game-file-system.js'

export const name = 'crowdy-fs-game'

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (activeStudioMode() !== 'game') return
  await ctx.plugin(GameFileSystem, config)
}

export default { name, apply }
