#!/usr/bin/env node
// Replace lib/vendor/crowdyjs-sdk.js (a tsc re-export) with a self-contained
// esbuild bundle of the CrowdyJS slice the plugins use. See src/vendor/crowdyjs-sdk.ts.
//
// The bundle is built from CrowdyJS's internal modules, not its package root:
// the root barrel re-exports the Studio editor, whose Monaco imports carry CSS,
// fonts and tree-sitter wasm that have no place in a harness image. The three
// files named below are the whole surface this package touches.
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const outfile = join(here, 'lib/vendor/crowdyjs-sdk.js')

// `exports` hides the package root and only names an `import` condition, so
// resolve the ESM entry and walk to the package directory from there.
// CROWDYJS_DIST points at a local CrowdyJS `dist/` for builds against an
// unpublished SDK (a coordinated change); CI leaves it unset and gets the
// declared devDependency.
const packageDir = process.env.CROWDYJS_DIST
  ? dirname(realpathSync(process.env.CROWDYJS_DIST))
  : dirname(dirname(realpathSync(fileURLToPath(import.meta.resolve('@crowdedkingdoms/crowdyjs', pathToFileURL(join(here, 'package.json')).href)))))
const dist = join(packageDir, 'dist')
const sdkManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const declared = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).devDependencies['@crowdedkingdoms/crowdyjs']
const declaredVersion = /^\d/.test(declared) ? declared : undefined // `link:` while building against a local SDK
if (!process.env.CROWDYJS_DIST && declaredVersion && sdkManifest.version !== declaredVersion) {
  throw new Error(`bundle-sdk: resolved @crowdedkingdoms/crowdyjs ${sdkManifest.version} but package.json declares ${declaredVersion}`)
}
if (declaredVersion && sdkManifest.version.split('.')[0] !== declaredVersion.split('.')[0]) {
  throw new Error(`bundle-sdk: CrowdyJS ${sdkManifest.version} is a different major from the declared ${declaredVersion}; the page and the worker must agree`)
}

const scratch = mkdtempSync(join(tmpdir(), 'crowdy-dsh-sdk-'))
const entry = join(scratch, 'entry.mjs')
writeFileSync(
  entry,
  [
    `export { createCrowdyClient } from ${JSON.stringify(join(dist, 'crowdy-client.js'))}`,
    `export { CrowdyGraphQLError } from ${JSON.stringify(join(dist, 'errors.js'))}`,
    `export { CrowdyStudioProjectCreateDocument, CrowdyStudioProjectDocument } from ${JSON.stringify(join(dist, 'generated/graphql.js'))}`,
    '',
  ].join('\n'),
)

// The SDK's generated `default-origin.js` names ONE tier's public API host,
// which is right for a game pinned to that tier and wrong for this image: the
// same artifact serves every tier, and the worker always receives its
// `graphqlUrl` from the page in `crowdy.json`. Bundling the tier default would
// bake `ck.<tier>.crowdedkingdoms.com` into a tier-neutral artifact, so the
// module is replaced with empty origins. A boot without `graphqlUrl` then
// fails on a visibly relative URL instead of quietly dialling another tier.
const tierNeutralOrigin = {
  name: 'crowdyjs-tier-neutral-origin',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /(^|\/)default-origin\.js$/ }, (args) => ({
      path: args.path,
      namespace: 'crowdy-dsh-origin',
    }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'crowdy-dsh-origin' }, () => ({
      contents: [
        '// Replaced by @crowdedkingdoms/crowdy-dsh scripts/bundle-sdk.mjs: the harness',
        '// image is tier-neutral and always receives graphqlUrl from the page.',
        "export const CROWDY_DEFAULT_TIER = 'none';",
        "export const CROWDY_DEFAULT_HTTP_ORIGIN = '';",
        "export const CROWDY_DEFAULT_WS_ORIGIN = '';",
        "export const CROWDY_DEFAULT_HOST = '';",
        '',
      ].join('\n'),
      loader: 'js',
    }))
  },
}

try {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    treeShaking: true,
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    external: ['@deepseek-ai/*', 'node:*'],
    plugins: [tierNeutralOrigin],
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// esbuild labels every module with `// <path relative to the outfile>`. When
// the SDK sits outside the workspace (CROWDYJS_DIST) that label climbs to the
// filesystem root and spells out the builder's layout, so the labels go.
let bundled = readFileSync(outfile, 'utf8').replace(/^\/\/ (?:\.\.?\/|\/|[\w@][\w@.-]*\/)\S*\.[cm]?js\n/gm, '')
if (/ck\.(dev|test|prod)\.crowdedkingdoms\.com/.test(bundled)) {
  throw new Error('bundle-sdk: a tier API host survived into the tier-neutral SDK slice')
}
if (bundled.includes(dist) || /^\/\/ (?:\.\.\/|\/)/m.test(bundled)) {
  throw new Error('bundle-sdk: a builder path survived into the SDK slice')
}
writeFileSync(outfile, bundled)

writeFileSync(
  join(dirname(outfile), 'crowdyjs-sdk.version.json'),
  `${JSON.stringify({ name: sdkManifest.name, version: sdkManifest.version, source: process.env.CROWDYJS_DIST ? 'CROWDYJS_DIST' : 'node_modules' }, null, 2)}\n`,
)
const size = statSync(outfile).size
if (size > 2_500_000) {
  throw new Error(`bundle-sdk: ${outfile} is ${size} bytes; the CrowdyJS slice grew past the editor boundary`)
}
console.log(`bundle-sdk: ${outfile} ${(size / 1024).toFixed(0)} KiB from ${sdkManifest.name}@${sdkManifest.version}`)
