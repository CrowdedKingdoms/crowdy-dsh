/**
 * Paths the game filesystem will list and write.
 *
 * The bound repository is the working tree. `.git`, dotenv files and
 * `node_modules` stay out. The mod crates are a different plugin.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

function denied(path: string): boolean {
  return path.split('/').some((segment) => {
    return segment === '.git' || segment === 'node_modules' || segment === '.env' || segment.startsWith('.env.')
  })
}

/** A relative repository path the game dock may read and write. */
export function isRepoPath(path: string): boolean {
  if (!SAFE_SEGMENT.test(path) || path.includes('..') || path.endsWith('/')) return false
  return !denied(path)
}

/** A directory inside the repository, including the root (`''`). */
export function isRepoDir(path: string): boolean {
  if (path === '') return true
  return isRepoPath(path)
}
