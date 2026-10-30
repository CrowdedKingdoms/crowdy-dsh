/**
 * The game's skills reach the upstream catalog through the page: the
 * provider lists what the playbook index names and loads each body as a
 * playbook page, frontmatter stripped.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { SkillCandidate } from '@deepseek-ai/dsh-skill'

import { playbookSkillProvider } from './playbook.js'

async function listOf(provider: ReturnType<typeof playbookSkillProvider>): Promise<readonly SkillCandidate[]> {
  const listed = await provider.list({})
  assert.ok(Array.isArray(listed), 'a complete discovery returns the array shorthand')
  return listed as readonly SkillCandidate[]
}

function bridge(skills: Array<{ name: string; description: string; page: string }>, pages: Record<string, string>) {
  const requests: string[] = []
  return {
    requests,
    client: {
      async whenPagePresent() {},
      async request(method: string, params: { page?: string }) {
        requests.push(method === 'studio.readPlaybook' ? `${method} ${params.page}` : method)
        if (method === 'studio.listSkills') return { skills }
        if (method === 'studio.readPlaybook') {
          const text = pages[params.page ?? '']
          if (text === undefined) throw new Error('missing')
          return { page: params.page, text }
        }
        throw new Error(`unexpected ${method}`)
      },
    },
  }
}

describe('playbook skill provider', () => {
  it('lists the index entries as custom skills the model and the player can invoke', async () => {
    const fake = bridge(
      [
        { name: 'scene-authoring', description: 'Build and change scenes.', page: 'skills/scene-authoring.md' },
        { name: 'bad', description: 'Escapes the playbook.', page: '../outside.md' },
      ],
      {},
    )
    const provider = playbookSkillProvider(fake as never)
    const listed = await listOf(provider)
    assert.equal(listed.length, 1)
    const [skill] = listed
    assert.equal(skill!.name, 'scene-authoring')
    assert.equal(skill!.source, 'custom')
    assert.deepEqual(skill!.invocation, { modelInvocable: true, userInvocable: true })
    assert.deepEqual(skill!.locator, { page: 'skills/scene-authoring.md' })
    assert.equal(skill!.resourceBase?.kind, 'opaque')
  })

  it('loads a body through the page and strips its frontmatter', async () => {
    const fake = bridge([{ name: 'scene-authoring', description: 'Scenes.', page: 'skills/scene-authoring.md' }], {
      'skills/scene-authoring.md': '---\nname: scene-authoring\ndescription: Scenes.\n---\n\n# Scenes\n\nEdit src/game/scenes.',
    })
    const provider = playbookSkillProvider(fake as never)
    const [candidate] = await listOf(provider)
    const definition = await provider.get(candidate!, {})
    assert.equal(definition?.content, '# Scenes\n\nEdit src/game/scenes.')
    assert.deepEqual(fake.requests, ['studio.listSkills', 'studio.readPlaybook skills/scene-authoring.md'])
  })

  it('reports an incomplete discovery while the page is absent, so the empty list is not cached', async () => {
    const provider = playbookSkillProvider({
      client: {
        async whenPagePresent() {
          throw new Error('no page')
        },
        async request() {
          throw new Error('unreachable')
        },
      },
    } as never)
    assert.deepEqual(await provider.list({}), { candidates: [], complete: false })
  })
})
