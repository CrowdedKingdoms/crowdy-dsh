/**
 * Contract tests for the in-memory glob matcher, pinned to the subset of
 * ripgrep glob semantics the search tools document.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GlobSyntaxError, globMatches, globToRegExp } from './glob-match.js'

describe('globMatches', () => {
  it('a pattern with no separator matches the basename at any depth', () => {
    assert.equal(globMatches('src/main.rs', '*.rs'), true)
    assert.equal(globMatches('main.rs', '*.rs'), true)
    assert.equal(globMatches('src/deep/tree/mod.rs', 'mod.rs'), true)
    assert.equal(globMatches('src/main.rs', '*.toml'), false)
  })

  it('a pattern with a separator anchors to the whole relative path', () => {
    assert.equal(globMatches('src/main.rs', 'src/*.rs'), true)
    assert.equal(globMatches('src/deep/main.rs', 'src/*.rs'), false)
    assert.equal(globMatches('src/deep/main.rs', 'src/**/*.rs'), true)
  })

  it('`**/` also matches zero segments', () => {
    assert.equal(globMatches('main.rs', '**/*.rs'), true)
    assert.equal(globMatches('src/main.rs', '**/*.rs'), true)
    assert.equal(globMatches('src/a/b/main.rs', '**/*.rs'), true)
  })

  it('`*` never crosses a separator; `**` does', () => {
    assert.equal(globToRegExp('src/*').test('src/a/b'), false)
    assert.equal(globToRegExp('src/**').test('src/a/b'), true)
  })

  it('`?` matches exactly one non-separator character', () => {
    assert.equal(globToRegExp('m?in.rs').test('main.rs'), true)
    assert.equal(globToRegExp('m?in.rs').test('miin.rs'), true)
    assert.equal(globToRegExp('m?in.rs').test('min.rs'), false)
    assert.equal(globToRegExp('a?b').test('a/b'), false)
  })

  it('brace alternation, including nested globs', () => {
    assert.equal(globMatches('src/lib.rs', '*.{rs,toml}'), true)
    assert.equal(globMatches('Cargo.toml', '*.{rs,toml}'), true)
    assert.equal(globMatches('notes.md', '*.{rs,toml}'), false)
    assert.equal(globMatches('src/a/x.rs', '{src/**/*.rs,Cargo.toml}'), true)
  })

  it('character classes with negation', () => {
    assert.equal(globToRegExp('[ab]').test('a'), true)
    assert.equal(globToRegExp('[ab]').test('c'), false)
    assert.equal(globToRegExp('[!ab]').test('c'), true)
    assert.equal(globToRegExp('[!ab]').test('a'), false)
  })

  it('regex metacharacters in literals are inert', () => {
    assert.equal(globToRegExp('a.b').test('a.b'), true)
    assert.equal(globToRegExp('a.b').test('axb'), false)
    assert.equal(globToRegExp('a+b(c)').test('a+b(c)'), true)
  })

  it('rejects unclosed constructs', () => {
    assert.throws(() => globToRegExp('a[bc'), GlobSyntaxError)
    assert.throws(() => globToRegExp('a{b,c'), GlobSyntaxError)
  })
})
