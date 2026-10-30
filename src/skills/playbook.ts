/**
 * The game's skills, as an upstream skill provider registered by the
 * `crowdy-game` preset. The page lists them from the game's playbook
 * (`studio.listSkills` reads `<playbookBase>skills/index.json`) and serves
 * each body as a playbook page (`studio.readPlaybook`), so the harness names
 * no game and fetches nothing itself: a game that ships no playbook simply
 * has no skills here.
 *
 * @module @crowdedkingdoms/crowdy-dsh/playbook-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderObservation } from '@deepseek-ai/dsh-skill'

import type { CrowdyBridge } from '../bridge/index.js'
import type { SkillSummary } from '../bridge/protocol.js'
import { assertPlaybookPage, splitFrontmatter } from '../crowdy/playbook.js'

export const name = 'crowdy-playbook-skills'
export const inject = ['skills', 'crowdyBridge']

/** Between a project's own skills (100-200) and runtime registrations (250). */
const PLAYBOOK_RANK = 220
const PROVIDER = 'crowdy-playbook'

/** The provider; exported for tests. */
export function playbookSkillProvider(bridge: Pick<CrowdyBridge, 'client'>): SkillProvider {
  return {
    name: PROVIDER,
    async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
      let result: { skills: SkillSummary[] }
      try {
        await bridge.client.whenPagePresent(10_000)
        result = await bridge.client.request('studio.listSkills', {}, { timeoutMs: 15_000, signal: options?.signal })
      } catch {
        // No page yet, or it could not read the index: not cached, asked again next lookup.
        return { candidates: [], complete: false }
      }
      const candidates: SkillCandidate[] = []
      for (const skill of result.skills ?? []) {
        let page: string
        try {
          page = assertPlaybookPage(skill.page)
        } catch {
          continue
        }
        candidates.push({
          name: skill.name,
          description: skill.description,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'custom',
          provider: PROVIDER,
          resourceBase: {
            kind: 'opaque',
            description: "Pages of the game's playbook; read the ones a skill names with read_playbook.",
          },
          rank: PLAYBOOK_RANK,
          locator: { page } satisfies Pick<SkillSummary, 'page'>,
        })
      }
      return candidates
    },
    async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      const page = (candidate.locator as { page?: string } | undefined)?.page
      if (!page) return undefined
      const result = await bridge.client.request('studio.readPlaybook', { page }, { timeoutMs: 15_000, signal: options?.signal })
      const { body } = splitFrontmatter(result.text)
      if (!body) return undefined
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        source: candidate.source,
        provider: candidate.provider,
        ...(candidate.resourceBase ? { resourceBase: candidate.resourceBase } : {}),
        content: body,
      }
    },
  }
}

export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => playbookSkillProvider(ctx.crowdyBridge))
}

export default { name, inject, apply }
