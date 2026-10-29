/**
 * Filesystem plugin: mounts the backend this boot's editor needs, so exactly
 * one `ctx.fs` exists. `studioMode: 'game'` in `crowdy.json` mounts the bound
 * game repository's draft (the page owns it); anything else mounts the mod
 * crates of the open Crowdy Studio project.
 *
 * @module @crowdedkingdoms/crowdy-dsh/fs
 */

import type { Context } from '@deepseek-ai/cordis'

import { activeStudioMode } from '../crowdy/config.js'
import CrowdyFileSystem, { type Config as ModConfig } from './crowdy-file-system.js'
import GameFileSystem, { type Config as GameConfig } from './game-file-system.js'

export const name = 'crowdy-fs'

export type Config = ModConfig & GameConfig

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (activeStudioMode() === 'game') {
    await ctx.plugin(GameFileSystem, { root: config.root })
    return
  }
  await ctx.plugin(CrowdyFileSystem, config)
}

export { CrowdyFileSystem, GameFileSystem }
export default { name, apply }
