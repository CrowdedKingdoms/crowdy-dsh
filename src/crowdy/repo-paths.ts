/**
 * Repository paths the game filesystem lists and writes. The page's draft
 * store (CrowdyJS `crowdy-studio/draft/paths.ts`) applies the same rule and
 * is the one that decides; this copy keeps the worker from asking for paths
 * the page will refuse. Keep the two in step.
 *
 * Out: `.git`, `node_modules`, dotenv files, any path starting with a dot
 * (`.github/` included) and workflow files, which the Studio GitHub App has
 * no permission to write.
 */

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

function deniedSegment(segment: string): boolean {
  return segment === '.git' || segment === 'node_modules' || segment === '.env' || segment.startsWith('.env.')
}

/** A relative repository path the game editor may list and write. */
export function isRepoPath(path: string): boolean {
  if (typeof path !== 'string' || !SAFE_PATH.test(path) || path.includes('..') || path.endsWith('/')) return false
  if (path.split('/').some((segment) => segment === '' || deniedSegment(segment))) return false
  return !/^\.github\/workflows(\/|$)/i.test(path)
}

/** A directory inside the repository, including the root (`''`). */
export function isRepoDir(path: string): boolean {
  return path === '' || isRepoPath(path)
}
