#!/usr/bin/env node
/**
 * Last step of build-image.sh: make the artifact something a stranger can pick
 * up and trust.
 *
 *   1. Scrub the packed VFS image. Upstream's bundler writes `//#region` markers
 *      and `patched by <file>` comments that carry the ABSOLUTE path of the
 *      machine that built it. They are inert, and they still say where and by
 *      whom a public artifact was built; every occurrence of the upstream
 *      checkout's path is rewritten to `<upstream>`.
 *   2. Refuse what must not ship: any remaining `/home/`, `/Users/` or `C:\`
 *      path, a tier API host, or the DeepSeek telemetry collector (the plugin is
 *      disabled in the profile; this proves the endpoint is not even named).
 *   3. Stamp `BUILD.json` beside `index.html`: package version, git commit of
 *      this repo, upstream tag and commit, the CrowdyJS the worker bundles, and
 *      a sha256 of every file. Consumers copying `dist/dsh-web` by hand keep
 *      the stamp with it, and the pane's status line can show what booted.
 *   4. Drop THIRD_PARTY_NOTICES.md in: upstream is MIT and so are its vendored
 *      libraries; shipping their code means shipping their notice.
 *
 *   node scripts/finish-artifact.mjs --out dist/dsh-web --upstream <checkout>
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { gunzipSync, gzipSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {
    if (fallback !== undefined) return fallback
    throw new Error(`finish-artifact: --${name} is required`)
  }
  return process.argv[index + 1]
}

const out = resolve(flag('out', join(here, 'dist/dsh-web')))
const upstream = resolve(flag('upstream'))
/** Written by bundle-sdk.mjs beside the vendored slice; says which CrowdyJS the worker carries. */
const sdkVersionFile = flag('sdk-version', join(upstream, 'packages/crowdy/crowdy-dsh/lib/vendor/crowdyjs-sdk.version.json'))
const upstreamReal = (() => {
  try {
    return execFileSync('realpath', [upstream], { encoding: 'utf8' }).trim()
  } catch {
    return upstream
  }
})()

// ── 1. scrub the VFS image ─────────────────────────────────────────────────────

const imagePath = join(out, 'preview/vfs-image.tar.gz')
if (!existsSync(imagePath)) throw new Error(`finish-artifact: ${imagePath} is missing`)

/** Rewrite text entries of a POSIX/ustar tar; binary entries pass through. */
function scrubTar(buffer, replacements) {
  const chunks = []
  let offset = 0
  let rewritten = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      chunks.push(buffer.subarray(offset))
      break
    }
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
    const typeflag = String.fromCharCode(header[156])
    const bodyStart = offset + 512
    const padded = Math.ceil(size / 512) * 512
    let body = buffer.subarray(bodyStart, bodyStart + size)
    let outHeader = header
    if ((typeflag === '0' || typeflag === '\0') && size > 0 && looksLikeText(body)) {
      let text = body.toString('utf8')
      let changed = false
      for (const [needle, replacement] of replacements) {
        if (text.includes(needle)) {
          text = text.split(needle).join(replacement)
          changed = true
        }
      }
      if (changed) {
        body = Buffer.from(text, 'utf8')
        outHeader = Buffer.from(header)
        outHeader.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
        rewriteChecksum(outHeader)
        rewritten += 1
      }
    }
    chunks.push(outHeader, body)
    const pad = Math.ceil(body.length / 512) * 512 - body.length
    if (pad > 0) chunks.push(Buffer.alloc(pad))
    offset = bodyStart + padded
  }
  return { tar: Buffer.concat(chunks), rewritten }
}

function looksLikeText(body) {
  const sample = body.subarray(0, Math.min(body.length, 4096))
  for (const byte of sample) {
    if (byte === 0) return false
  }
  return true
}

function rewriteChecksum(header) {
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
}

const replacements = [...new Set([upstream, upstreamReal])].map((path) => [path, '<upstream>'])
const original = gunzipSync(readFileSync(imagePath))
const { tar, rewritten } = scrubTar(original, replacements)
writeFileSync(imagePath, gzipSync(tar, { level: 9 }))
console.log(`finish-artifact: scrubbed ${rewritten} image entr${rewritten === 1 ? 'y' : 'ies'} of builder paths`)

// ── 2. refuse what must not ship ───────────────────────────────────────────────

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Upstream's own docs mention `/home/me/` and `/Users/dev/` as examples, so the
// path check names THIS machine: the builder's home and the checkout it built
// from (which the scrub above should already have rewritten).
const forbidden = [
  [new RegExp(escape(homedir())), 'the builder home directory'],
  ...[...new Set([upstream, upstreamReal])].map((path) => [new RegExp(escape(path)), 'the upstream checkout path']),
  [/ck\.(dev|test|prod)\.crowdedkingdoms\.com/, 'a tier API host (the image must be tier-neutral)'],
  [/harness-telemetry\.deepseeksvc\.com/, 'the DeepSeek telemetry collector'],
]

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

const problems = []
function scan(label, text) {
  for (const [pattern, what] of forbidden) {
    const match = pattern.exec(text)
    if (match) problems.push(`${label}: ${what} (${match[0]})`)
  }
}
for (const file of walk(out)) {
  const rel = relative(out, file)
  if (rel === 'preview/vfs-image.tar.gz') {
    const image = gunzipSync(readFileSync(file))
    // Scan the raw tar as latin1 so byte offsets map to text without decoding errors.
    scan(rel, image.toString('latin1'))
  } else if (!/\.(png|ico|woff2?|ttf|wasm)$/.test(rel)) {
    scan(rel, readFileSync(file, 'latin1'))
  }
}
if (problems.length > 0) {
  throw new Error(`finish-artifact: the artifact names things it must not ship:\n  ${problems.join('\n  ')}`)
}
console.log('finish-artifact: no builder paths, tier hosts or telemetry endpoints in the artifact')

// ── 3. stamp ───────────────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const pin = JSON.parse(readFileSync(join(here, 'upstream.json'), 'utf8'))
const git = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
const files = {}
for (const file of walk(out)) {
  const rel = relative(out, file)
  if (rel === 'BUILD.json') continue
  files[rel] = `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`
}
const stamp = {
  package: pkg.name,
  version: pkg.version,
  builtAt: new Date().toISOString(),
  source: {
    repository: 'CrowdedKingdoms/crowdy-dsh',
    commit: git(['rev-parse', 'HEAD'], here),
    dirty: (git(['status', '--porcelain', '--', '.'], here) ?? '') !== '',
  },
  upstream: {
    repository: pin.repository,
    tag: pin.tag,
    commit: git(['rev-parse', 'HEAD'], upstream) ?? pin.commit,
    license: pin.license,
  },
  crowdyjs: existsSync(sdkVersionFile)
    ? JSON.parse(readFileSync(sdkVersionFile, 'utf8'))
    : { name: '@crowdedkingdoms/crowdyjs', version: pkg.devDependencies['@crowdedkingdoms/crowdyjs'], source: 'declared' },
  files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
}
if (stamp.upstream.commit !== pin.commit) {
  throw new Error(`finish-artifact: upstream checkout is at ${stamp.upstream.commit}, upstream.json pins ${pin.commit}`)
}
writeFileSync(join(out, 'BUILD.json'), `${JSON.stringify(stamp, null, 2)}\n`)
console.log(`finish-artifact: BUILD.json ${pkg.version} @ ${stamp.source.commit ?? 'no-git'} on ${pin.tag}, ${Object.keys(files).length} files`)

// ── 4. notices ─────────────────────────────────────────────────────────────────

const notices = join(upstream, 'THIRD_PARTY_NOTICES.md')
const license = join(upstream, 'LICENSE')
if (!existsSync(license)) throw new Error(`finish-artifact: ${license} is missing`)
copyFileSync(license, join(out, 'LICENSE.deepseek-harness'))
if (existsSync(notices)) copyFileSync(notices, join(out, 'THIRD_PARTY_NOTICES.md'))
console.log('finish-artifact: MIT licence and third-party notices copied beside index.html')
console.log(`finish-artifact: ${Math.round(statSync(imagePath).size / 1024)} KiB image`)
