/**
 * Repository layout of a GitHub-bound Crowdy Studio project.
 *
 * Mirrors `CrowdyJS/src/crowdy-studio/github/sync.ts` (the Studio panel's
 * push/pull), which is the source of truth. It is restated here rather than
 * imported because that module lives in the `crowdy-studio` entry beside the
 * Monaco editor, and the worker image must not carry the editor.
 *
 * Layout (from `crowdy.json` at the repo root, else inferred from the tree):
 *
 *   SERVER src/lib.rs  <->  <serverRoot>/src/lib.rs
 *   CLIENT src/lib.rs  <->  <clientRoot>/src/lib.rs
 *
 * @module @crowdedkingdoms/crowdy-dsh/crowdy/github-layout
 */

import type { CrowdyTarget } from './client.js'

export interface GitHubLayout {
  serverRoot: string | null
  clientRoot: string | null
}

export interface GitHubTreeEntryLike {
  path: string
  type: string
}

export const DEFAULT_FULL_STACK_CROWDY_JSON = `{
  "server": "server",
  "client": "client"
}
`

const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', '.cursor', '.github'])
const SKIP_FILES = new Set(['crowdy.json', 'readme.md', 'license', '.gitignore'])

export function trimSlash(path: string): string {
  let start = 0
  let end = path.length
  while (start < end && path.charCodeAt(start) === 47) start += 1
  while (end > start && path.charCodeAt(end - 1) === 47) end -= 1
  return start === 0 && end === path.length ? path : path.slice(start, end)
}

export function joinRepo(root: string, rel: string): string {
  const base = trimSlash(root)
  const rest = trimSlash(rel)
  if (!base || base === '.') return rest
  return rest ? `${base}/${rest}` : base
}

export function underRoot(path: string, root: string | null): string | null {
  if (root == null) return null
  const base = trimSlash(root)
  if (!base || base === '.') return path
  if (path === base) return ''
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1)
  return null
}

export function parseCrowdyJson(content: string): GitHubLayout | null {
  try {
    const parsed = JSON.parse(content) as { server?: unknown; client?: unknown }
    const server = typeof parsed.server === 'string' ? parsed.server.trim() || '.' : null
    const clientRoot = typeof parsed.client === 'string' ? parsed.client.trim() || '.' : null
    if (server == null && clientRoot == null) return null
    return { serverRoot: server, clientRoot }
  } catch {
    return null
  }
}

export function layoutFromTree(entries: ReadonlyArray<GitHubTreeEntryLike>): GitHubLayout {
  const hasDir = (name: string) => entries.some((e) => e.type === 'tree' && e.path === name)
  const hasClient = hasDir('client')
  const hasServer = hasDir('server')
  if (hasServer && hasClient) return { serverRoot: 'server', clientRoot: 'client' }
  if (hasClient) return { serverRoot: '.', clientRoot: 'client' }
  if (hasServer) return { serverRoot: 'server', clientRoot: null }
  return { serverRoot: '.', clientRoot: null }
}

export function repoPathToStudioFile(
  layout: GitHubLayout,
  repoPath: string,
): { target: CrowdyTarget; path: string } | null {
  const segments = repoPath.split('/')
  if (segments.some((s) => SKIP_DIRS.has(s))) return null
  const name = segments[segments.length - 1]?.toLowerCase() ?? ''
  if (SKIP_FILES.has(name) || SKIP_FILES.has(repoPath.toLowerCase())) return null
  const clientRel = underRoot(repoPath, layout.clientRoot)
  if (clientRel != null && clientRel !== '') return { target: 'CLIENT', path: clientRel }
  const serverRel = underRoot(repoPath, layout.serverRoot)
  if (serverRel != null && serverRel !== '') return { target: 'SERVER', path: serverRel }
  return null
}

export function studioFileToRepoPath(
  layout: GitHubLayout,
  target: CrowdyTarget,
  path: string,
): string | null {
  const root = target === 'CLIENT' ? layout.clientRoot : layout.serverRoot
  if (root == null) return null
  return joinRepo(root, path)
}
