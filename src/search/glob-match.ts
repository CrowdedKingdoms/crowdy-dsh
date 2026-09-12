/**
 * Minimal glob matching for the Crowdy search tools.
 *
 * The stock `glob`/`grep` tools hand patterns to ripgrep; the Crowdy project
 * lives behind a GraphQL API, so matching happens in memory instead. This
 * module implements the subset of rg's glob syntax the tools document:
 * `*` (within a segment), `?`, `**` (across segments), `[...]` classes, and
 * `{a,b}` alternation. Following rg, a pattern with no `/` matches the
 * BASENAME at any depth, and a pattern with a separator anchors to the whole
 * relative path.
 *
 * @module @crowdy/dsh-cockpit/search/glob-match
 */

const REGEX_SPECIALS = new Set(['.', '+', '^', '$', '(', ')', '|', '\\'])

/** Thrown for a pattern the converter cannot interpret (e.g. unclosed brace). */
export class GlobSyntaxError extends Error {}

/**
 * Translate one glob into a regex source fragment (no anchors).
 * Recursion only happens for `{...}` alternation branches.
 */
function toRegexSource(pattern: string): string {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const char = pattern.charAt(i)
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` may match zero segments, so `**/*.rs` also matches `main.rs`.
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 3
        } else {
          out += '.*'
          i += 2
        }
      } else {
        out += '[^/]*'
        i += 1
      }
    } else if (char === '?') {
      out += '[^/]'
      i += 1
    } else if (char === '[') {
      const close = pattern.indexOf(']', i + 2) // a class is never empty
      if (close === -1) throw new GlobSyntaxError(`unclosed "[" in glob: ${pattern}`)
      let body = pattern.slice(i + 1, close)
      if (body.startsWith('!') || body.startsWith('^')) body = `^${body.slice(1)}`
      // Escape only what could break out of a character class.
      body = body.replace(/[\\\]]/g, (m) => `\\${m}`)
      out += `[${body}]`
      i = close + 1
    } else if (char === '{') {
      let depth = 1
      let j = i + 1
      const branches: string[] = []
      let start = j
      while (j < pattern.length && depth > 0) {
        const c = pattern[j]
        if (c === '{') depth += 1
        else if (c === '}') {
          depth -= 1
          if (depth === 0) branches.push(pattern.slice(start, j))
        } else if (c === ',' && depth === 1) {
          branches.push(pattern.slice(start, j))
          start = j + 1
        }
        j += 1
      }
      if (depth !== 0) throw new GlobSyntaxError(`unclosed "{" in glob: ${pattern}`)
      out += `(?:${branches.map(toRegexSource).join('|')})`
      i = j
    } else {
      out += REGEX_SPECIALS.has(char) ? `\\${char}` : char
      i += 1
    }
  }
  return out
}

/**
 * Compile one glob to an anchored RegExp over a `/`-separated relative path.
 * @throws {GlobSyntaxError} for an uninterpretable pattern.
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${toRegexSource(pattern)}$`)
}

/**
 * Whether a project-relative path matches one glob, following rg's rule: a
 * pattern with no `/` tests the basename at any depth; a pattern with a
 * separator tests the whole relative path.
 *
 * @param relativePath - `/`-separated path relative to the search root.
 * @param pattern - the glob to test.
 */
export function globMatches(relativePath: string, pattern: string): boolean {
  const anchored = pattern.includes('/')
  const subject = anchored
    ? relativePath
    : relativePath.slice(relativePath.lastIndexOf('/') + 1)
  return globToRegExp(pattern).test(subject)
}
