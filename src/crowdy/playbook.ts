/**
 * Playbook pages: markdown the game ships under its playbook base, read
 * through the page (`studio.readPlaybook`). The page applies the same check
 * (CrowdyJS `crowdy-dsh/game-paths.ts`); this copy refuses a bad name before
 * it crosses the bridge.
 */

export function assertPlaybookPage(page: string): string {
  const trimmed = String(page ?? '').trim().replace(/^\/+/, '')
  if (!trimmed || trimmed.includes('..') || trimmed.includes('\\') || /[?#\0]/.test(trimmed) || trimmed.startsWith('.')) {
    throw new Error('Playbook pages are markdown files shipped with the game.')
  }
  if (!/^[\w./-]+\.md$/.test(trimmed)) {
    throw new Error('Name a playbook page such as playbook/authoring-loop.md.')
  }
  return trimmed
}

/** Split `---` frontmatter off a skill page; returns the body (trimmed) and the raw frontmatter. */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, '').trimStart())
  if (!match) return { frontmatter: null, body: text.trim() }
  return { frontmatter: match[1] ?? null, body: (match[2] ?? '').trim() }
}
