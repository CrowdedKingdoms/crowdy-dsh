/**
 * Game-mode skills. Registered only when the boot is `studioMode: game`.
 *
 * The bodies are the dock pages in the MMO Anything copy the game ships at
 * `/mmo/skills/`. The harness skill catalog (`tool-skill`) lists them. The
 * Cursor skills in that same copy are not registered: they assume a shell.
 */

import type { Context } from '@deepseek-ai/cordis'

import { activeStudioMode } from '../crowdy/config.js'

export const name = 'crowdy-skills-game'
export const inject = ['skills']

/** Pages this boot registers. Anything else in the playbook copy stays unregistered. */
export const DOCK_SKILL_PAGES = ['mmo-dock-scene', 'mmo-dock-rules'] as const

export interface ParsedSkill {
  name: string
  description: string
  content: string
}

export interface Config {
  /** Test double. The image fetches `/mmo/skills/<name>/SKILL.md`. */
  load?(page: string): Promise<string | null>
}

interface SkillRegistryLike {
  register(skill: ParsedSkill & { source: 'bundled' }): void
}

/** Frontmatter the playbook copy uses. The name must be the page that was requested. */
export function parseSkillPage(text: string, expectedName: string): ParsedSkill | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text.trimStart())
  const front = match?.[1]
  const body = match?.[2]?.trim()
  if (!front || !body) return null
  let parsedName = ''
  let description = ''
  for (const line of front.split(/\r?\n/)) {
    const nameMatch = /^name:\s*(\S+)\s*$/.exec(line)
    const descriptionMatch = /^description:\s*(.+?)\s*$/.exec(line)
    if (nameMatch?.[1]) parsedName = nameMatch[1]
    if (descriptionMatch?.[1]) description = descriptionMatch[1]
  }
  if (parsedName !== expectedName || description.length === 0) return null
  return { name: parsedName, description, content: body }
}

export async function loadShippedSkill(page: string): Promise<string | null> {
  try {
    const response = await fetch(`/mmo/skills/${page}/SKILL.md`)
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (activeStudioMode() !== 'game') return
  const skills = (ctx as unknown as { skills: SkillRegistryLike }).skills
  const load = config.load ?? loadShippedSkill
  const logger = (ctx as unknown as { logger?: { warn(message: string): void } }).logger
  let registered = 0
  for (const page of DOCK_SKILL_PAGES) {
    const text = await load(page)
    const skill = text ? parseSkillPage(text, page) : null
    if (!skill) {
      logger?.warn(`crowdy-skills-game: no dock skill at /mmo/skills/${page}/SKILL.md`)
      continue
    }
    skills.register({ ...skill, source: 'bundled' })
    registered += 1
  }
  if (registered === 0) {
    logger?.warn('crowdy-skills-game: the MMO Anything copy shipped no dock skills')
  }
}
