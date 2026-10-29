/**
 * The token the page sends is what the model route reads, in either mode.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { APP_TOKEN_ENV, publishAppToken } from './token.js'

describe('publishAppToken', () => {
  it('publishes a token for the model route and ignores an empty one', () => {
    const previous = process.env[APP_TOKEN_ENV]
    try {
      delete process.env[APP_TOKEN_ENV]
      publishAppToken('page-token')
      assert.equal(process.env[APP_TOKEN_ENV], 'page-token')
      publishAppToken(undefined)
      publishAppToken('')
      assert.equal(process.env[APP_TOKEN_ENV], 'page-token', 'an empty token never clears a good one')
    } finally {
      if (previous === undefined) delete process.env[APP_TOKEN_ENV]
      else process.env[APP_TOKEN_ENV] = previous
    }
  })
})
