/**
 * Game mode registers the two dock skills from the shipped playbook copy.
 * Mod mode registers nothing, and a page that is not one of those skills is ignored.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply, parseSkillPage } from './dock.js'

const scenePage = `---
name: mmo-dock-scene
description: Add or change a scene. This session has no shell.
---

Read playbook/scenes-and-the-adapter.md with read_playbook.
`
const rulesPage = `---
name: mmo-dock-rules
description: Change a cheat-sensitive rule. This session cannot deploy the hub.
---

Read playbook/rules-and-the-model.md with read_playbook.
`

function harness() {
  const registered: Array<{ name: string; description: string; content: string }> = []
  const warnings: string[] = []
  const ctx = {
    skills: { register: (skill: { name: string; description: string; content: string }) => registered.push(skill) },
    logger: { warn: (message: string) => warnings.push(message) },
  }
  return { ctx, registered, warnings }
}

describe('dock skills', () => {
  it('parses a playbook skill page and refuses a swapped name', () => {
    const parsed = parseSkillPage(scenePage, 'mmo-dock-scene')
    assert.equal(parsed?.name, 'mmo-dock-scene')
    assert.match(parsed?.description ?? '', /no shell/)
    assert.match(parsed?.content ?? '', /read_playbook/)
    assert.equal(parseSkillPage(scenePage, 'mmo-dock-rules'), null)
    assert.equal(parseSkillPage('no frontmatter', 'mmo-dock-scene'), null)
  })

  it('does not register while the boot is the mod pair', async () => {
    let loaded = 0
    const { ctx, registered } = harness()
    await apply(ctx as never, {
      load: async () => {
        loaded += 1
        return scenePage
      },
    })
    assert.equal(loaded, 0)
    assert.equal(registered.length, 0)
  })

  it('registers the two dock pages and skips a missing one', async () => {
    const previous = process.env.CROWDY_STUDIO_MODE
    process.env.CROWDY_STUDIO_MODE = 'game'
    try {
      const { ctx, registered, warnings } = harness()
      await apply(ctx as never, {
        load: async (page) => (page === 'mmo-dock-scene' ? scenePage : page === 'mmo-dock-rules' ? rulesPage : null),
      })
      assert.deepEqual(registered.map((skill) => skill.name), ['mmo-dock-scene', 'mmo-dock-rules'])
      assert.equal(warnings.length, 0)

      const missing = harness()
      await apply(missing.ctx as never, { load: async () => null })
      assert.equal(missing.registered.length, 0)
      assert.equal(missing.warnings.length, 3)
    } finally {
      if (previous === undefined) delete process.env.CROWDY_STUDIO_MODE
      else process.env.CROWDY_STUDIO_MODE = previous
    }
  })
})
