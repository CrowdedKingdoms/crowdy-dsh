/**
 * The model-facing `glob` / `grep` discovery tools for a Crowdy Studio
 * project.
 *
 * The stock `tool-fs-search` spawns ripgrep on this machine's disk, which is
 * exactly the world the crowdy preset removes: the project lives behind the
 * game API, not in the launch directory. This plugin registers tools with the
 * SAME names and near-identical schemas, but matching happens in memory over
 * the Crowdy filesystem backend's project snapshot (`ctx.fs` must be
 * {@link CrowdyFileSystem}), so search, read, and write always describe the
 * same files.
 *
 * A Crowdy project is small (two targets, a handful of files, 64 KiB per
 * file), so there is no subprocess, no spill store, and no pagination beyond
 * a defensive inline cap. Returned paths are relative to the project mount,
 * which is the same base the `read` tool resolves against, so every result
 * is follow-up-readable.
 *
 * @module @crowdy/dsh-cockpit/search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  SearchFileMatches,
  SearchResultView,
  ToolCallView,
  ToolResult,
} from '@deepseek-ai/dsh-tools'

import { CrowdyFileSystem } from '../fs/crowdy-file-system.js'
import { normalizeAbsolute, resolveAgainst } from '../crowdy/paths.js'
import { globMatches, GlobSyntaxError } from './glob-match.js'

export interface Config {
  /** Max paths one `glob` call returns inline. */
  globMaxResults?: number
  /** Max matches one `grep` call returns inline. */
  grepMaxMatches?: number
  /** Max bytes retained for one matched-line preview. */
  grepMaxLineBytes?: number
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-fs-search-crowdy'

/** Services required by the Crowdy search tool suite. */
export const inject = ['tools', 'systemPrompt', 'fs']

export const Config: z<Config> = z.object({
  globMaxResults: z.number().default(100),
  grepMaxMatches: z.number().default(250),
  grepMaxLineBytes: z.number().default(2000),
}) as unknown as z<Config>

/** One file of the project snapshot the pure search core operates on. */
export interface SearchFile {
  /** Virtual absolute path, e.g. `/mnt/crowdy/server/src/main.rs`. */
  virtualPath: string
  content: string
}

/** One grep hit in the canonical output shape shared with the stock tool. */
export interface GrepMatch {
  path: string
  lineNumber: number
  line: string
}

// ── pure core ─────────────────────────────────────────────────────────────────

/**
 * Resolve the optional `path` argument against the mount root, rejecting a
 * target outside the mount so the model gets a precise message instead of a
 * silent empty result.
 */
export function resolveSearchRoot(mountRoot: string, pathArg: string | undefined): string {
  const root = normalizeAbsolute(mountRoot)
  if (pathArg === undefined) return root
  if (pathArg.trim().length === 0) throw new Error('path must be a non-empty string when given')
  const absolute = resolveAgainst(root, pathArg)
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw new Error(`path resolves to ${absolute}, outside the project mount at ${root}`)
  }
  return absolute
}

/** A file's path relative to `base`, or undefined when it lies outside. */
function relativeTo(virtualPath: string, base: string): string | undefined {
  if (virtualPath === base) return ''
  return virtualPath.startsWith(`${base}/`) ? virtualPath.slice(base.length + 1) : undefined
}

/** Rethrow a glob syntax failure as a plain argument error the registry renders. */
function compileGlob(pattern: string, label: string): void {
  try {
    globMatches('probe', pattern)
  } catch (error) {
    if (error instanceof GlobSyntaxError) throw new Error(`${label}: ${error.message}`)
    throw error
  }
}

/**
 * Discover project files matching one glob, scoped to `searchRoot`. Matching
 * follows the stock tool's rule (no `/` in the pattern = basename at any
 * depth); display paths are mount-relative and returned in path order,
 * because Crowdy files have no modification times.
 */
export function globProjectPaths(
  files: readonly SearchFile[],
  mountRoot: string,
  searchRoot: string,
  pattern: string,
): string[] {
  if (pattern.trim().length === 0) throw new Error('pattern must be a non-empty string')
  compileGlob(pattern, 'pattern rejected')
  const out: string[] = []
  for (const file of files) {
    const scoped = relativeTo(file.virtualPath, searchRoot)
    if (scoped === undefined || scoped === '') continue
    if (!globMatches(scoped, pattern)) continue
    out.push(relativeTo(file.virtualPath, normalizeAbsolute(mountRoot)) ?? file.virtualPath)
  }
  return out.sort()
}

/** Bound one matched-line preview to `maxBytes`, preserving UTF-8 boundaries. */
export function previewLine(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return line
  let kept = line
  while (kept.length > 0 && Buffer.byteLength(kept, 'utf8') > maxBytes) {
    kept = kept.slice(0, -1)
  }
  return `${kept} (line truncated)`
}

/**
 * Search project file contents with a regular expression, scoped to
 * `searchRoot` (a directory or a single file) and optionally filtered by one
 * `include` glob. Lines are 1-based; a file's trailing newline does not
 * produce a phantom empty line.
 */
export function grepProjectFiles(
  files: readonly SearchFile[],
  mountRoot: string,
  searchRoot: string,
  pattern: string,
  include: string | undefined,
  maxLineBytes: number,
): GrepMatch[] {
  if (pattern.length === 0) throw new Error('pattern must be a non-empty string')
  if (include !== undefined) {
    if (include.trim().length === 0) throw new Error('include must be a non-empty glob when given')
    if (include.startsWith('!')) {
      throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported')
    }
    compileGlob(include, 'include rejected')
  }
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (error) {
    throw new Error(`pattern is not a valid regular expression: ${(error as Error).message}`)
  }

  const root = normalizeAbsolute(mountRoot)
  const matches: GrepMatch[] = []
  for (const file of files) {
    const scoped = relativeTo(file.virtualPath, searchRoot)
    if (scoped === undefined) continue
    // `scoped === ''` means searchRoot IS this file; include filters still
    // apply to a directory search only.
    if (scoped !== '' && include !== undefined && !globMatches(scoped, include)) continue
    const display = relativeTo(file.virtualPath, root) ?? file.virtualPath
    const lines = file.content.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    for (let i = 0; i < lines.length; i += 1) {
      const line = (lines[i] ?? '').replace(/\r$/, '')
      if (!regex.test(line)) continue
      matches.push({ path: display, lineNumber: i + 1, line: previewLine(line, maxLineBytes) })
    }
  }
  return matches
}

/** `match` / `matches` for a count. */
function matchNoun(count: number): string {
  return count === 1 ? 'match' : 'matches'
}

/** Group flat matches by file into the model-facing body. */
export function formatGrepMatches(matches: readonly GrepMatch[]): string {
  const byFile = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group) group.push(match)
    else byFile.set(match.path, [match])
  }
  const sections: string[] = []
  for (const [path, group] of byFile) {
    sections.push(`${path}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
  }
  return sections.join('\n\n')
}

/** Format the model-facing `grep` result, with the inline cap applied. */
export function renderGrepResult(matches: readonly GrepMatch[], maxMatches: number): string {
  if (matches.length === 0) return 'No matches found'
  if (matches.length <= maxMatches) {
    return `Found ${matches.length} ${matchNoun(matches.length)}\n\n${formatGrepMatches(matches)}`
  }
  const kept = matches.slice(0, maxMatches)
  return (
    `Found ${kept.length} of ${matches.length} matches\n\n${formatGrepMatches(kept)}` +
    `\n\n(Narrow pattern, path, or include to see the rest.)`
  )
}

/** Format the model-facing `glob` result, with the inline cap applied. */
export function renderGlobResult(paths: readonly string[], maxResults: number): string {
  if (paths.length === 0) return 'No files found'
  if (paths.length <= maxResults) return paths.join('\n')
  return (
    `${paths.slice(0, maxResults).join('\n')}` +
    `\n\n(Showing ${maxResults} of ${paths.length} paths; narrow pattern or path to see the rest.)`
  )
}

// ── presentation ──────────────────────────────────────────────────────────────

/** Narrow opaque result meta back to a search card view; malformed meta falls back. */
function searchViewFromMeta(meta: unknown): SearchResultView | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  const { truncated, total } = record
  if (typeof truncated !== 'boolean' || typeof total !== 'number') return undefined
  if (record.shape === 'paths') {
    const paths = record.paths
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return undefined
    return { card: 'search', shape: 'paths', paths, truncated, total }
  }
  if (record.shape === 'matches') {
    const files = record.files
    if (!Array.isArray(files) || !files.every(isFileMatches)) return undefined
    return { card: 'search', shape: 'matches', files, truncated, total }
  }
  return undefined
}

/** Whether `value` is one valid by-file match group (defensive meta narrowing). */
function isFileMatches(value: unknown): value is SearchFileMatches {
  if (typeof value !== 'object' || value === null) return false
  const { path, matches } = value as Record<string, unknown>
  if (typeof path !== 'string' || !Array.isArray(matches)) return false
  return matches.every((match) => {
    if (typeof match !== 'object' || match === null) return false
    const { lineNumber, line } = match as Record<string, unknown>
    return typeof lineNumber === 'number' && typeof line === 'string'
  })
}

/** Group retained matches by file for the search card's `meta`. */
function grepMeta(matches: readonly GrepMatch[], maxMatches: number) {
  const kept = matches.slice(0, maxMatches)
  const byFile = new Map<string, Array<{ lineNumber: number; line: string }>>()
  for (const match of kept) {
    const entry = { lineNumber: match.lineNumber, line: match.line }
    const group = byFile.get(match.path)
    if (group) group.push(entry)
    else byFile.set(match.path, [entry])
  }
  return {
    shape: 'matches' as const,
    files: Array.from(byFile, ([path, fileMatches]) => ({ path, matches: fileMatches })),
    truncated: matches.length > maxMatches,
    total: matches.length,
  }
}

// ── plugin ────────────────────────────────────────────────────────────────────

/** The prompt-section registrar every dsh composition provides. */
interface SystemPromptLike {
  section(entry: { name: string; order: number; text: string }): void
}

/** The mounted Crowdy filesystem backend, or a clear miscomposition error. */
function requireCrowdyFs(ctx: Context): CrowdyFileSystem {
  const fs: unknown = ctx.fs
  if (fs instanceof CrowdyFileSystem) return fs
  throw new Error(
    'the Crowdy search tools require the Crowdy Studio filesystem backend ' +
      '(@crowdy/dsh-cockpit) mounted as ctx.fs',
  )
}

/**
 * Register the Crowdy-backed `glob` / `grep` tool suite and its system-prompt
 * guidance.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const globMaxResults = config.globMaxResults ?? 100
  const grepMaxMatches = config.grepMaxMatches ?? 250
  const grepMaxLineBytes = config.grepMaxLineBytes ?? 2000
  for (const [key, value] of Object.entries({ globMaxResults, grepMaxMatches, grepMaxLineBytes })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`tool-fs-search-crowdy: ${key} must be a positive integer`)
    }
  }
  const systemPrompt = (ctx as unknown as { systemPrompt: SystemPromptLike }).systemPrompt

  systemPrompt.section({
    name: 'tool:glob',
    order: 103,
    text:
      'Use the glob tool to discover project files by path pattern. A pattern ' +
      'with no "/" matches basenames at any depth, so "*.rs" finds every Rust ' +
      'file in both targets. Paths come back relative to the project mount, in ' +
      'path order, and are directly readable with the read tool.',
  })
  systemPrompt.section({
    name: 'tool:grep',
    order: 104,
    text:
      'Use the grep tool to search project file contents with a regular ' +
      'expression. It searches the live Crowdy Studio project, the same files ' +
      'read and write operate on. Use read on a matched file when you need ' +
      'surrounding context.',
  })

  const glob = defineTool({
    name: 'glob',
    description:
      'Find Crowdy Studio project files whose paths match a glob pattern. ' +
      'Returns matching file paths relative to the project mount, in path ' +
      `order, up to ${globMaxResults} inline. A pattern with no "/" matches ` +
      'the basename at any depth. This searches the live project, not this ' +
      "machine's disk.",
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description:
          'Glob pattern to match file paths against (e.g. "**/*.rs", ' +
          '"server/src/*.rs", "*.{rs,toml}"). A pattern with no "/" matches ' +
          'the basename at any depth.',
      },
      path: {
        type: 'string',
        description:
          'Directory to search in, relative to the project mount (e.g. ' +
          '"server" or "client/src"). Defaults to the whole project.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: renderGlobResult(value.paths, globMaxResults) },
      ],
      presentationMeta: (_args, value) => ({
        shape: 'paths',
        paths: value.paths.slice(0, globMaxResults),
        truncated: value.paths.length > globMaxResults,
        total: value.paths.length,
      }),
    },
    async execute(args) {
      const snapshot = await requireCrowdyFs(ctx).searchSnapshot()
      const searchRoot = resolveSearchRoot(snapshot.root, args.path)
      const paths = globProjectPaths(snapshot.files, snapshot.root, searchRoot, args.pattern)
      return { root: args.path === undefined ? '.' : args.path, paths }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title: `Glob ${args.pattern}${args.path !== undefined ? ` in ${args.path}` : ''}`,
      kind: 'search',
      rawInput: args.pattern,
    }),
    presentResult: (_args, result: ToolResult) => {
      if (result.isError) return undefined
      const view = searchViewFromMeta(result.meta)
      return view !== undefined && view.shape === 'paths' ? view : undefined
    },
  })
  ctx.tools.register(glob)

  const grep = defineTool({
    name: 'grep',
    description:
      'Search Crowdy Studio project file contents with a regular expression ' +
      '(JavaScript syntax, matched per line). Returns matching lines with ' +
      `line numbers, grouped by file, up to ${grepMaxMatches} inline. This ` +
      "searches the live project, not this machine's disk. Use read on a " +
      'matched file for surrounding context.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Regular expression to search for, matched against each line.',
      },
      path: {
        type: 'string',
        description:
          'File or directory to search, relative to the project mount (e.g. ' +
          '"server/src" or "client/Cargo.toml"). Defaults to the whole project.',
      },
      include: {
        type: 'string',
        description:
          'One glob filter for which files to search (e.g. "*.rs", ' +
          '"*.{rs,toml}"). Not a list; negation is not supported.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                lineNumber: { type: 'integer', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: renderGrepResult(value.matches, grepMaxMatches) },
      ],
      presentationMeta: (_args, value) => grepMeta(value.matches, grepMaxMatches),
    },
    async execute(args) {
      const snapshot = await requireCrowdyFs(ctx).searchSnapshot()
      const searchRoot = resolveSearchRoot(snapshot.root, args.path)
      const matches = grepProjectFiles(
        snapshot.files,
        snapshot.root,
        searchRoot,
        args.pattern,
        args.include,
        grepMaxLineBytes,
      )
      return { matches }
    },
    presentCall: (args): ToolCallView => ({
      card: 'generic',
      title:
        `Grep ${args.pattern}` +
        (args.path !== undefined ? ` in ${args.path}` : '') +
        (args.include !== undefined ? ` (${args.include})` : ''),
      kind: 'search',
      rawInput: args.pattern,
    }),
    presentResult: (_args, result: ToolResult) => {
      if (result.isError) return undefined
      const view = searchViewFromMeta(result.meta)
      return view !== undefined && view.shape === 'matches' ? view : undefined
    },
  })
  ctx.tools.register(grep)
}
