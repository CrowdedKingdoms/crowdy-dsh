/**
 * Behavioral tests for the Crowdy search core: scoping, glob discovery, grep
 * matching, and the model-facing formatting, exercised over an in-memory
 * project snapshot — the same shape `CrowdyFileSystem.searchSnapshot()`
 * produces.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  globProjectPaths,
  grepProjectFiles,
  previewLine,
  renderGlobResult,
  renderGrepResult,
  resolveSearchRoot,
} from './search-tools.js'
import type { SearchFile } from './search-tools.js'

const ROOT = '/mnt/crowdy'

const FILES: SearchFile[] = [
  { virtualPath: `${ROOT}/server/Cargo.toml`, content: '[package]\nname = "server"\n' },
  {
    virtualPath: `${ROOT}/server/src/main.rs`,
    content: 'fn main() {\n    spawn_player();\n}\n',
  },
  {
    virtualPath: `${ROOT}/server/src/player.rs`,
    content: 'pub fn spawn_player() {\n    // spawn\n}\n',
  },
  { virtualPath: `${ROOT}/client/Cargo.toml`, content: '[package]\nname = "client"\n' },
  {
    virtualPath: `${ROOT}/client/src/main.rs`,
    content: 'fn main() {\n    render();\n}\n',
  },
]

describe('resolveSearchRoot', () => {
  it('defaults to the mount root', () => {
    assert.equal(resolveSearchRoot(ROOT, undefined), ROOT)
  })

  it('resolves a relative path against the mount', () => {
    assert.equal(resolveSearchRoot(ROOT, 'server/src'), `${ROOT}/server/src`)
    assert.equal(resolveSearchRoot(ROOT, `${ROOT}/client`), `${ROOT}/client`)
  })

  it('rejects escapes from the mount', () => {
    assert.throws(() => resolveSearchRoot(ROOT, '../elsewhere'), /outside the project mount/)
    assert.throws(() => resolveSearchRoot(ROOT, '/etc'), /outside the project mount/)
  })
})

describe('globProjectPaths', () => {
  it('finds basenames at any depth for a separator-free pattern', () => {
    assert.deepEqual(globProjectPaths(FILES, ROOT, ROOT, '*.rs'), [
      'client/src/main.rs',
      'server/src/main.rs',
      'server/src/player.rs',
    ])
  })

  it('anchors a pattern with separators to the search root', () => {
    assert.deepEqual(globProjectPaths(FILES, ROOT, ROOT, 'server/**/*.rs'), [
      'server/src/main.rs',
      'server/src/player.rs',
    ])
  })

  it('scopes to a subdirectory while displaying mount-relative paths', () => {
    assert.deepEqual(globProjectPaths(FILES, ROOT, `${ROOT}/client`, '**/*'), [
      'client/Cargo.toml',
      'client/src/main.rs',
    ])
  })

  it('supports brace alternation', () => {
    assert.deepEqual(globProjectPaths(FILES, ROOT, `${ROOT}/server`, '*.{rs,toml}'), [
      'server/Cargo.toml',
      'server/src/main.rs',
      'server/src/player.rs',
    ])
  })

  it('rejects a blank or malformed pattern', () => {
    assert.throws(() => globProjectPaths(FILES, ROOT, ROOT, '  '), /non-empty/)
    assert.throws(() => globProjectPaths(FILES, ROOT, ROOT, 'a{b'), /pattern rejected/)
  })
})

describe('grepProjectFiles', () => {
  it('returns line-numbered matches with mount-relative paths', () => {
    const matches = grepProjectFiles(FILES, ROOT, ROOT, 'spawn_player', undefined, 2000)
    assert.deepEqual(matches, [
      { path: 'server/src/main.rs', lineNumber: 2, line: '    spawn_player();' },
      { path: 'server/src/player.rs', lineNumber: 1, line: 'pub fn spawn_player() {' },
    ])
  })

  it('scopes to a directory and applies one include glob', () => {
    const matches = grepProjectFiles(FILES, ROOT, `${ROOT}/server`, 'name', '*.toml', 2000)
    assert.deepEqual(matches, [
      { path: 'server/Cargo.toml', lineNumber: 2, line: 'name = "server"' },
    ])
  })

  it('greps a single file when the path names one', () => {
    const matches = grepProjectFiles(
      FILES,
      ROOT,
      `${ROOT}/client/src/main.rs`,
      'render',
      undefined,
      2000,
    )
    assert.deepEqual(matches, [
      { path: 'client/src/main.rs', lineNumber: 2, line: '    render();' },
    ])
  })

  it('does not report a phantom line after the trailing newline', () => {
    const matches = grepProjectFiles(FILES, ROOT, ROOT, '^$', undefined, 2000)
    assert.deepEqual(matches, [])
  })

  it('rejects an invalid regex and a negated include', () => {
    assert.throws(
      () => grepProjectFiles(FILES, ROOT, ROOT, '(unclosed', undefined, 2000),
      /not a valid regular expression/,
    )
    assert.throws(
      () => grepProjectFiles(FILES, ROOT, ROOT, 'x', '!*.rs', 2000),
      /positive glob/,
    )
  })

  it('previews over-budget lines on UTF-8 boundaries', () => {
    assert.equal(previewLine('abcdef', 4), 'abcd (line truncated)')
    // Multi-byte characters are dropped whole, never split.
    const preview = previewLine('ééééé', 5)
    assert.equal(preview, 'éé (line truncated)')
  })
})

describe('rendering', () => {
  it('formats grep output grouped by file with a count header', () => {
    const matches = grepProjectFiles(FILES, ROOT, ROOT, 'fn main', undefined, 2000)
    const text = renderGrepResult(matches, 250)
    assert.match(text, /^Found 2 matches\n\n/)
    assert.match(text, /server\/src\/main\.rs\nLine 1: fn main\(\) \{/)
    assert.match(text, /client\/src\/main\.rs\nLine 1: fn main\(\) \{/)
  })

  it('reports zero results in the stock vocabulary', () => {
    assert.equal(renderGrepResult([], 250), 'No matches found')
    assert.equal(renderGlobResult([], 100), 'No files found')
  })

  it('caps inline results and says so', () => {
    const paths = Array.from({ length: 5 }, (_, i) => `server/src/f${i}.rs`)
    assert.match(renderGlobResult(paths, 3), /Showing 3 of 5 paths/)
    const matches = Array.from({ length: 5 }, (_, i) => ({
      path: 'server/src/main.rs',
      lineNumber: i + 1,
      line: 'x',
    }))
    assert.match(renderGrepResult(matches, 3), /Found 3 of 5 matches/)
  })
})
