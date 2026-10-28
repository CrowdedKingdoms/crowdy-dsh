import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isRepoDir, isRepoPath } from './repo-paths.js'

describe('repository paths', () => {
  it('allows the copied game tree and refuses secrets and dependencies', () => {
    assert.equal(isRepoPath('src/main.ts'), true)
    assert.equal(isRepoPath('src/scenes/pool.mjs'), true)
    assert.equal(isRepoPath('src/game/programs.ts'), true)
    assert.equal(isRepoPath('model/catalog.mjs'), true)
    assert.equal(isRepoDir(''), true)
    assert.equal(isRepoPath('.env'), false)
    assert.equal(isRepoPath('.git/config'), false)
    assert.equal(isRepoPath('node_modules/left-pad/index.js'), false)
    assert.equal(isRepoPath('../secrets'), false)
    assert.equal(isRepoPath('/etc/passwd'), false)
  })
})
