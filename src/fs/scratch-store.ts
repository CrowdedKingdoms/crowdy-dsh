/**
 * In-memory files beside the project trees: screenshots under `captures/`,
 * game observations / client logs / diagnostics under `context/`.
 *
 * These are not project files and never reach the game API. They exist so the
 * stock `read` / `read_image` tools can open what the Studio page shared,
 * through the same paths the model already knows.
 *
 * @module @crowdedkingdoms/crowdy-dsh/fs/scratch-store
 */

import type { ScratchDir } from '../crowdy/paths.js'

export interface ScratchFile {
  bytes: Uint8Array
  /** Decoded text when the file is UTF-8 text; absent for binary content. */
  text?: string
  version: string
  updatedAt: number
}

const MAX_FILES_PER_DIR = 40

export class ScratchStore {
  private readonly dirs = new Map<ScratchDir, Map<string, ScratchFile>>()
  private counter = 0

  putText(dir: ScratchDir, name: string, text: string): ScratchFile {
    const bytes = new TextEncoder().encode(text)
    return this.put(dir, name, bytes, text)
  }

  putBytes(dir: ScratchDir, name: string, bytes: Uint8Array): ScratchFile {
    return this.put(dir, name, bytes, undefined)
  }

  get(dir: ScratchDir, name: string): ScratchFile | undefined {
    return this.dirs.get(dir)?.get(name)
  }

  list(dir: ScratchDir): Array<{ name: string; file: ScratchFile }> {
    const files = this.dirs.get(dir)
    if (!files) return []
    return [...files.entries()]
      .map(([name, file]) => ({ name, file }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  private put(dir: ScratchDir, name: string, bytes: Uint8Array, text: string | undefined): ScratchFile {
    let files = this.dirs.get(dir)
    if (!files) {
      files = new Map()
      this.dirs.set(dir, files)
    }
    // Keep the bag bounded: drop the oldest entries first.
    while (files.size >= MAX_FILES_PER_DIR && !files.has(name)) {
      let oldest: [string, ScratchFile] | undefined
      for (const entry of files) {
        if (!oldest || entry[1].updatedAt < oldest[1].updatedAt) oldest = entry
      }
      if (!oldest) break
      files.delete(oldest[0])
    }
    this.counter += 1
    const file: ScratchFile = {
      bytes,
      version: `scratch:${this.counter}`,
      updatedAt: Date.now(),
      ...(text === undefined ? {} : { text }),
    }
    files.set(name, file)
    return file
  }
}
