/**
 * Game files the dock may commit, and playbook pages it may read.
 * CrowdyJS mirrors these checks. Keep the two in step.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export function isWritableGamePath(path: string): boolean {
  if (!SAFE_SEGMENT.test(path) || path.includes('..') || path.endsWith('/')) return false
  if (path === 'model/catalog.mjs') return true
  if (path === 'exec/construct' || path.startsWith('exec/construct/')) return true
  return path.startsWith('src/scenes/') && /\.(?:mjs|js|ts)$/.test(path)
}

export function assertPlaybookPage(page: string): string {
  const trimmed = page.trim().replace(/^\/+/, '')
  if (
    !trimmed ||
    trimmed.includes('..') ||
    trimmed.includes('\\') ||
    /[?#\0]/.test(trimmed) ||
    trimmed.startsWith('.')
  ) {
    throw new Error('Playbook pages are markdown files shipped with the game.')
  }
  if (!/^[\w./-]+\.md$/.test(trimmed)) {
    throw new Error('Name a playbook page such as playbook/authoring-loop.md.')
  }
  return trimmed
}
