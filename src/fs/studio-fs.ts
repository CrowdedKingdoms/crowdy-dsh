/**
 * What the bridge, the search tools and the Studio tools need from whichever
 * filesystem backend this boot mounted: the mod crates
 * (`CrowdyFileSystem`) or the game draft (`GameFileSystem`).
 */

import type { CrowdyBootConfig } from '../crowdy/config.js'
import type { DraftChangedPayload } from '../bridge/protocol.js'
import type { ScratchStore } from './scratch-store.js'

export interface StudioFileSystem {
  /** Which editor this backend serves. */
  readonly studioMode: 'mod' | 'game'
  readonly boot: CrowdyBootConfig
  readonly scratch: ScratchStore
  /** Virtual root the project or repository is mounted at. */
  readonly mountRoot: string
  /** Where files come from, for the page's status line; undefined until known. */
  readonly storeReason: string | undefined
  /** The page switched projects. */
  setProject(projectId: string): void
  /** The page handed over (or refreshed) the app token. */
  setToken(token: string | undefined): void
  /** Cached content may be behind the page; reload on next use. */
  invalidate(): void
  /** Game editor: the page's draft changed. The mod backend ignores it. */
  applyDraftChange(change: DraftChangedPayload): void
  onChange(listener: (change: { target: 'SERVER' | 'CLIENT'; path: string }) => void): () => void
  onWarning(listener: (message: string) => void): () => void
  drainWarnings(): string[]
  /** Every text file the in-memory glob/grep may search. */
  searchSnapshot(): Promise<{ root: string; files: Array<{ virtualPath: string; content: string }> }>
}

export function isStudioFileSystem(value: unknown): value is StudioFileSystem {
  const fs = value as Partial<StudioFileSystem> | null | undefined
  return (
    !!fs &&
    (fs.studioMode === 'mod' || fs.studioMode === 'game') &&
    typeof fs.mountRoot === 'string' &&
    typeof fs.searchSnapshot === 'function' &&
    typeof fs.applyDraftChange === 'function'
  )
}
