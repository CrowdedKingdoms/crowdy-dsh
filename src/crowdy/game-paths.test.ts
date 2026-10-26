import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assertPlaybookPage, isWritableGamePath } from './game-paths.js'

describe('game paths', () => {
  it('allows scenes, the catalog and the world hub', () => {
    assert.equal(isWritableGamePath('src/scenes/holodeck.mjs'), true)
    assert.equal(isWritableGamePath('model/catalog.mjs'), true)
    assert.equal(isWritableGamePath('exec/construct/main.rs'), true)
    assert.equal(isWritableGamePath('server/src/main.rs'), false)
    assert.equal(isWritableGamePath('src/scenes/../../model/catalog.mjs'), false)
  })

  it('refuses a playbook path that leaves the shipped tree', () => {
    assert.equal(assertPlaybookPage('playbook/shipping.md'), 'playbook/shipping.md')
    assert.throws(() => assertPlaybookPage('../playbook/shipping.md'))
  })
})
