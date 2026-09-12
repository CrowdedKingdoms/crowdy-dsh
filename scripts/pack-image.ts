/**
 * Pack the Crowdy VFS image: compose the shipped `web` profile with the Crowdy
 * overlay, then hand the composed tree to upstream's packer library.
 *
 * Upstream's `dsh-pack-vfs-image` composes with `--dump-default-config`, which
 * deliberately refuses `--patch`. The Crowdy image is the stock profile plus one
 * overlay, so this driver composes with `--dump-config` against a throwaway
 * Harness home (no user layers can leak in) and packs the result.
 *
 * Run from the upstream checkout with tsx:
 *   node --import tsx/esm packages/crowdy/crowdy-dsh/scripts/pack-image.ts \
 *     --repo . --patch <overlay.yml> --out apps/web/dist/preview/vfs-image.tar.gz
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {
    if (fallback !== undefined) return fallback
    throw new Error(`pack-image: --${name} is required`)
  }
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`pack-image: --${name} needs a value`)
  return value
}

const repoRoot = resolve(flag('repo', process.cwd()))
const patch = resolve(flag('patch'))
const out = flag('out')
const outputFile = isAbsolute(out) ? out : resolve(process.cwd(), out)
const profile = flag('profile', 'web')

// apps/web depends on the packer; the repository root does not.
const require = createRequire(join(repoRoot, 'apps/web/package.json'))
const packer = require('@deepseek-ai/dsh-experimental-webworker-packer') as typeof import('@deepseek-ai/dsh-experimental-webworker-packer')

/** Compose `profile` + overlay through the real CLI against an empty home. */
function composeWithPatch(): string {
  const home = mkdtempSync(join(tmpdir(), 'crowdy-pack-home-'))
  try {
    return execFileSync(
      process.execPath,
      ['--import', 'tsx/esm', join(repoRoot, 'apps/cli/src/bin.ts'), '--profile', profile, '--patch', patch, '--dump-config'],
      { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, DSH_HOME: home } },
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const config = composeWithPatch()
const result = packer.packVfsImage({
  config,
  profile: `${profile}+crowdy`,
  root: '/dsh',
  workspaces: packer.indexWorkspacePackages(repoRoot),
  resolveFrom: repoRoot,
  configTrees: packer.configTrees(repoRoot),
})

if (result.missing.length > 0) {
  throw new Error(`pack-image: ${String(result.missing.length)} dependencies did not resolve:\n  ${result.missing.join('\n  ')}`)
}

mkdirSync(dirname(outputFile), { recursive: true })
writeFileSync(outputFile, result.image)
process.stdout.write(packer.describePack(result, repoRoot, outputFile).join('\n'))
