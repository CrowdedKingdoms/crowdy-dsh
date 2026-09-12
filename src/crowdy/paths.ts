/**
 * Path mapping between the virtual tree the agent sees and the flat
 * `(target, path)` pairs Crowdy Studio stores.
 *
 * A Crowdy project is not a directory tree: it is two independent bags of files
 * keyed by target. We present them as two directories under one root so ordinary
 * path-shaped tools work unchanged:
 *
 *   <root>/server/src/main.rs  <->  (SERVER, "src/main.rs")
 *   <root>/client/Cargo.toml   <->  (CLIENT, "Cargo.toml")
 */

import type { CrowdyTarget } from './client.js'

export const DEFAULT_ROOT = '/crowdy'

/** Directory name presented for each target, and the reverse lookup. */
const TARGET_DIRS: Record<CrowdyTarget, string> = { SERVER: 'server', CLIENT: 'client' }
const DIR_TARGETS: Record<string, CrowdyTarget> = { server: 'SERVER', client: 'CLIENT' }

export interface CrowdyLocation {
  target: CrowdyTarget
  /** Project-relative path, e.g. `src/main.rs`. Never empty. */
  path: string
}

/**
 * Scratch directories beside the two targets. They are not project files:
 * `captures/` holds screenshots the page took, `context/` holds game
 * observations, client logs and the latest build diagnostics. Both live only
 * in memory for the life of the harness.
 */
export const SCRATCH_DIRS = ['captures', 'context'] as const
export type ScratchDir = (typeof SCRATCH_DIRS)[number]

/** What a virtual absolute path denotes. */
export type Resolved =
  | { kind: 'root' }
  | { kind: 'target'; target: CrowdyTarget }
  | { kind: 'file'; location: CrowdyLocation }
  | { kind: 'scratch-dir'; dir: ScratchDir }
  | { kind: 'scratch-file'; dir: ScratchDir; name: string }

/**
 * Collapse `.`/`..` segments and duplicate separators without touching the
 * filesystem. Crowdy paths are virtual, so `realpath` semantics do not apply and
 * traversal must be resolved textually.
 *
 * @returns an absolute path with no `.`/`..` segments.
 */
export function normalizeAbsolute(input: string): string {
  const segments = input.replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      out.pop()
      continue
    }
    out.push(segment)
  }
  return `/${out.join('/')}`
}

/** Join a possibly-relative path against a cwd, then normalize. */
export function resolveAgainst(cwd: string, input: string): string {
  return normalizeAbsolute(input.startsWith('/') ? input : `${cwd}/${input}`)
}

/**
 * Interpret an absolute virtual path relative to the configured root.
 *
 * @param absolute - normalized absolute path.
 * @param root - the virtual root the project is mounted at.
 * @returns what the path denotes, or `undefined` when it falls outside the root.
 */
export function classify(absolute: string, root = DEFAULT_ROOT): Resolved | undefined {
  const base = normalizeAbsolute(root)
  if (absolute === base) return { kind: 'root' }
  if (!absolute.startsWith(`${base}/`)) return undefined

  const rest = absolute.slice(base.length + 1)
  const slash = rest.indexOf('/')
  const dir = slash === -1 ? rest : rest.slice(0, slash)
  const target = DIR_TARGETS[dir]
  if (!target) {
    const scratch = (SCRATCH_DIRS as readonly string[]).includes(dir) ? (dir as ScratchDir) : undefined
    if (!scratch) return undefined
    if (slash === -1) return { kind: 'scratch-dir', dir: scratch }
    const name = rest.slice(slash + 1)
    if (!name) return { kind: 'scratch-dir', dir: scratch }
    return { kind: 'scratch-file', dir: scratch, name }
  }

  if (slash === -1) return { kind: 'target', target }
  const path = rest.slice(slash + 1)
  if (!path) return { kind: 'target', target }
  return { kind: 'file', location: { target, path } }
}

/** Virtual absolute path of a scratch file. */
export function toScratchPath(dir: ScratchDir, name: string, root = DEFAULT_ROOT): string {
  return `${normalizeAbsolute(root)}/${dir}/${name}`
}

/** The scratch directories in name order. */
export function scratchDirectories(root = DEFAULT_ROOT): string[] {
  const base = normalizeAbsolute(root)
  return [...SCRATCH_DIRS].sort().map((dir) => `${base}/${dir}`)
}

/** Build the virtual absolute path for a stored file. */
export function toVirtualPath(
  target: CrowdyTarget,
  path: string,
  root = DEFAULT_ROOT,
): string {
  return `${normalizeAbsolute(root)}/${TARGET_DIRS[target]}/${path}`
}

/** The two target directories in name order, used for listing the root. */
export function targetDirectories(root = DEFAULT_ROOT): string[] {
  const base = normalizeAbsolute(root)
  return Object.values(TARGET_DIRS)
    .sort()
    .map((dir) => `${base}/${dir}`)
}

/**
 * Direct children of a directory within one target, derived from the flat file
 * list. Intermediate directories exist only implicitly, so they are synthesized
 * from the path segments of the files beneath them.
 *
 * @param paths - every stored path for the target.
 * @param prefix - project-relative directory prefix, `''` for the target root.
 * @returns the direct children, each flagged as a file or directory.
 */
export function directChildren(
  paths: string[],
  prefix: string,
): Array<{ name: string; isDirectory: boolean }> {
  const scope = prefix === '' ? '' : prefix.endsWith('/') ? prefix : `${prefix}/`
  const seen = new Map<string, boolean>()

  for (const path of paths) {
    if (scope && !path.startsWith(scope)) continue
    const rest = path.slice(scope.length)
    if (!rest) continue
    const slash = rest.indexOf('/')
    if (slash === -1) {
      seen.set(rest, false)
    } else if (!seen.has(rest.slice(0, slash))) {
      seen.set(rest.slice(0, slash), true)
    }
  }

  return [...seen.entries()]
    .map(([name, isDirectory]) => ({ name, isDirectory }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Whether a project-relative path is one Crowdy Studio will accept: `Cargo.toml`
 * at the target root, or a `.rs` file below `src/`. Rejecting early gives the
 * model a precise message instead of a generic server validation failure.
 */
export function isAcceptableProjectPath(path: string): boolean {
  if (path.includes('..') || path.startsWith('/')) return false
  if (path === 'Cargo.toml') return true
  return path.startsWith('src/') && path.endsWith('.rs')
}
