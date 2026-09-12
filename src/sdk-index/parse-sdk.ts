/**
 * Pull public `pub fn` entries out of `crowdy-compute-sdk` source.
 *
 * The crate is one file. Crate-root helpers (`log`, `state_get`, …) live
 * above `pub mod api`; typed host wrappers live inside it. `impl` methods
 * (Predicate::new) are skipped — they are not callable as `crowdy::api::*`.
 *
 * @module @crowdy/dsh-cockpit/sdk-index
 */

export type SdkModule = 'crate' | 'api'

export interface SdkEntry {
  name: string
  module: SdkModule
  /** Compact `fn name(...) -> Type` line, whitespace folded. */
  signature: string
  /** First `///` line above the function, if any. */
  doc: string
}

function foldWs(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

function firstDocLine(source: string, fnIndex: number): string {
  const before = source.slice(0, fnIndex)
  const lines = before.split('\n')
  const docs: string[] = []
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? ''
    if (/^\s*$/u.test(line) || /^\s*#\[/u.test(line)) continue
    const doc = line.match(/^\s*\/\/\/\s?(.*)$/u)
    if (doc) {
      docs.unshift((doc[1] ?? '').trim())
      continue
    }
    break
  }
  return docs[0] ?? ''
}

function sliceSignature(source: string, start: number): string | null {
  const open = source.indexOf('(', start)
  if (open < 0) return null
  let depth = 0
  let i = open
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) break
    }
  }
  if (depth !== 0) return null
  const after = source.slice(i + 1)
  const ret = after.match(/^\s*(->\s*[^={]+)?/u)
  const retText = ret?.[1] ? ` ${foldWs(ret[1])}` : ''
  const head = foldWs(source.slice(start, i + 1))
  return `${head}${retText}`
}

/**
 * Parse crate-root and `pub mod api` functions from one `lib.rs`.
 */
export function parseCrowdyComputeSdk(source: string): SdkEntry[] {
  const apiMatch = source.match(/^pub mod api \{/mu)
  const apiStart = apiMatch?.index ?? source.length
  const afterApi = source.slice(apiStart)
  const apiOpen = afterApi.indexOf('{')
  let apiEnd = source.length
  if (apiOpen >= 0) {
    let depth = 0
    for (let i = apiStart + apiOpen; i < source.length; i += 1) {
      const ch = source[i]
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          apiEnd = i
          break
        }
      }
    }
  }

  const crateRegion = source.slice(0, apiStart)
  const apiRegion = unwrapModBody(source.slice(apiStart, apiEnd))
  return [
    ...collectFns(crateRegion, 'crate'),
    ...collectFns(apiRegion, 'api'),
  ]
}

/** Drop the outer `pub mod api { ... }` so nested fns sit at depth 0. */
function unwrapModBody(region: string): string {
  const open = region.indexOf('{')
  if (open < 0) return region
  const close = region.lastIndexOf('}')
  return region.slice(open + 1, close >= 0 ? close : undefined)
}

function collectFns(region: string, module: SdkModule): SdkEntry[] {
  const entries: SdkEntry[] = []
  const seen = new Set<string>()
  const lines = region.split('\n')
  let offset = 0
  let depth = 0
  let implAt: number | null = null
  for (const line of lines) {
    if (implAt === null && /^\s*impl\b/u.test(line)) implAt = depth
    const fn = line.match(/^\s*pub fn ([A-Za-z_][A-Za-z0-9_]*)\s*\(/u)
    if (fn && implAt === null && depth === 0) {
      const name = fn[1]
      if (name && !seen.has(name)) {
        const local = region.indexOf(line, offset)
        const sig = sliceSignature(region, local)
        if (sig) {
          seen.add(name)
          entries.push({
            name,
            module,
            signature: sig.replace(/^pub\s+/u, ''),
            doc: firstDocLine(region, local),
          })
        }
      }
    }
    depth += (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length
    if (implAt !== null && depth <= implAt) implAt = null
    offset += line.length + 1
  }
  return entries
}

/** Path used when rustc / the seed names a function. */
export function qualifiedName(entry: SdkEntry): string {
  return entry.module === 'api' ? `crowdy::api::${entry.name}` : `crowdy::${entry.name}`
}
