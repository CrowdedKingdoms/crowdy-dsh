#!/usr/bin/env node
/**
 * Assemble what `npm publish` uploads, in `dist/npm/`.
 *
 * The package leads two lives. Inside the deepseek-harness pnpm workspace it is
 * a plugin package whose `dependencies` are `workspace:*` siblings; that is how
 * it builds and how its tests run. On npm it is the ARTIFACT package a game
 * installs to copy `dist/dsh-web/` into its `public/dsh/`: nothing imports the
 * plugin code from there, and the `@deepseek-ai/dsh-*` siblings are not all on
 * the registry at the workspace's version, so a manifest that kept them as
 * `dependencies` would make `npm install` fail for every consumer.
 *
 * So the published manifest lists them as OPTIONAL peer dependencies (npm does
 * not install those), keeps the plugin `exports` for anyone who does compose
 * the harness themselves, and ships the built `lib/`, presets, profile, the
 * stamped `dist/dsh-web/`, the upstream pin and both licences.
 *
 *   node scripts/stage-npm.mjs --lib <built lib dir> [--out dist/npm]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {
    if (fallback !== undefined) return fallback
    throw new Error(`stage-npm: --${name} is required`)
  }
  return process.argv[index + 1]
}

const lib = resolve(flag('lib'))
const out = resolve(flag('out', join(here, 'dist/npm')))
const artifact = join(here, 'dist/dsh-web')

for (const [label, path] of [
  ['built lib', join(lib, 'index.js')],
  ['artifact', join(artifact, 'index.html')],
  ['artifact stamp', join(artifact, 'BUILD.json')],
  ['upstream notices', join(artifact, 'THIRD_PARTY_NOTICES.md')],
  ['licence', join(here, 'LICENSE')],
]) {
  if (!existsSync(path)) throw new Error(`stage-npm: ${label} missing at ${path}; run scripts/build-image.sh first`)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const manifest = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const workspaceDeps = Object.keys(manifest.dependencies ?? {})
const staged = {
  ...manifest,
  private: false,
  scripts: undefined,
  dependencies: undefined,
  devDependencies: undefined,
  peerDependencies: Object.fromEntries(workspaceDeps.map((name) => [name, '*'])),
  peerDependenciesMeta: Object.fromEntries(workspaceDeps.map((name) => [name, { optional: true }])),
  files: undefined,
  // What the artifact was built from, so `npm view` answers the question.
  crowdyDsh: {
    build: JSON.parse(readFileSync(join(artifact, 'BUILD.json'), 'utf8')),
  },
}
delete staged.scripts
delete staged.dependencies
delete staged.devDependencies
delete staged.files
writeFileSync(join(out, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`)

const copy = (from, to) => cpSync(from, join(out, to), { recursive: true, filter: (src) => !/\.(test|spec)\.(js|d\.ts|js\.map)$/.test(src) })
copy(lib, 'lib')
copy(join(here, 'presets'), 'presets')
copy(join(here, 'profile'), 'profile')
copy(artifact, 'dist/dsh-web')
copy(join(here, 'upstream.json'), 'upstream.json')
copy(join(here, 'LICENSE'), 'LICENSE')
copy(join(here, 'README.md'), 'README.md')
copy(join(artifact, 'THIRD_PARTY_NOTICES.md'), 'THIRD_PARTY_NOTICES.md')

console.log(`stage-npm: ${staged.name}@${staged.version} staged in ${out} (${workspaceDeps.length} workspace deps -> optional peers)`)
