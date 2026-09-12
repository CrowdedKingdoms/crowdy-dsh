#!/usr/bin/env bash
# Build the in-browser Crowdy Studio harness: the stock DeepSeek Harness web
# page plus a packed VFS image whose plugin tree is `web` + profile/crowdy-web.
#
# Requires Node 22.19+ and pnpm (corepack). The upstream checkout is a build
# input, not a source of truth: this script copies the package into its
# workspace, installs, builds, packs, scrubs and stamps the artifact.
#
#   UPSTREAM_DIR   deepseek-harness checkout at the tag in upstream.json
#                  (default: ../deepseek-harness, a sibling of this repo;
#                  scripts/checkout-upstream.sh creates it -- not a submodule)
#   SKIP_UPSTREAM  set to 1 when upstream `pnpm run build` already ran
#   OUT_DIR        where dist/dsh-web lands (default: ./dist/dsh-web)
#   CROWDYJS_DIST  a local CrowdyJS dist/ to bundle instead of the declared
#                  devDependency (coordinated SDK changes before they publish)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
upstream="${UPSTREAM_DIR:-$here/../deepseek-harness}"
out="${OUT_DIR:-$here/dist/dsh-web}"
target="$upstream/packages/crowdy/crowdy-dsh"

if [ ! -f "$upstream/package.json" ]; then
  echo "build-image: no deepseek-harness checkout at $upstream (run scripts/checkout-upstream.sh, or set UPSTREAM_DIR)" >&2
  exit 1
fi
pinned="$(node -p "JSON.parse(require('fs').readFileSync('$here/upstream.json','utf8')).commit")"
actual="$(git -C "$upstream" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$actual" != "$pinned" ]; then
  echo "build-image: $upstream is at $actual but upstream.json pins $pinned (run scripts/checkout-upstream.sh)" >&2
  exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 22 ]; then
  echo "build-image: Node 22.19+ required (have $(node -v)); nvm use 22" >&2
  exit 1
fi

# Quiet on success, but the full log on failure: a swallowed pnpm error is a
# CI red with nothing to read.
log="$(mktemp)"
quiet() { if ! "$@" >"$log" 2>&1; then cat "$log" >&2; echo "build-image: '$*' failed" >&2; exit 1; fi; }

# The upstream build runs BEFORE this package enters the workspace. Its host
# tsdown pass builds every packages/*/* and expects lib/types/{index,...}.js
# from each; ours is a tsc project with no such entry, and the copy a previous
# build left behind would be built (or fail) as if it were upstream's. Built
# this way the upstream output is a pure function of the pinned commit, which
# is what the CI cache key assumes.
if [ "${SKIP_UPSTREAM:-0}" != "1" ]; then
  rm -rf "$target"
  cd "$upstream"
  echo "build-image: pnpm install (upstream)"
  quiet pnpm install --no-frozen-lockfile --reporter=append-only
  echo "build-image: building deepseek-harness (this takes a few minutes)"
  quiet pnpm run build
  cd "$here"
fi

echo "build-image: syncing package into $target"
mkdir -p "$target"
# --delete does not reach into the excluded lib/, so a stale emit from an
# earlier build (a renamed module, say) would otherwise ride into the package.
rm -rf "$target/lib"
rsync -a --delete \
  --exclude node_modules --exclude lib --exclude dist --exclude upstream --exclude .git \
  "$here/" "$target/"

# The shipped preset root is the only one the worker mounts; our preset rides in it.
preset_root="$upstream/packages/preset/agent-presets/presets/crowdy"
rm -rf "$preset_root"
cp -R "$here/presets/crowdy" "$preset_root"

# The page bootstrap and its Vite config live beside the stock ones.
cp "$here/web/crowdy-boot.ts" "$upstream/apps/web/src/crowdy-boot.ts"
cp "$here/web/vite.crowdy.config.ts" "$upstream/apps/web/vite.crowdy.config.ts"

if [ -n "${CROWDYJS_DIST:-}" ]; then
  # A coordinated SDK change: bundle the local build and do not ask the
  # registry for a version that is not published yet. The synced copy's
  # manifest is a build input; the repo's package.json keeps the declared pin.
  CROWDYJS_DIST="$(cd "$CROWDYJS_DIST" && pwd)"   # bundle-sdk.mjs runs from another cwd
  export CROWDYJS_DIST
  sdk_dir="$(dirname "$CROWDYJS_DIST")"
  # The local SDK must be the pinned release, prerelease suffix aside: a
  # source checkout says 16.0.0 where the pin says 16.0.0-dev.1.
  declared="$(node -p "require('$here/package.json').devDependencies['@crowdedkingdoms/crowdyjs']")"
  have="$(node -p "require('$sdk_dir/package.json').version")"
  if [ "${declared%%-*}" != "${have%%-*}" ] && [ "${CROWDYJS_ALLOW_MISMATCH:-0}" != "1" ]; then
    echo "build-image: $sdk_dir is CrowdyJS $have but package.json pins $declared (CROWDYJS_ALLOW_MISMATCH=1 to build anyway)" >&2
    exit 1
  fi
  echo "build-image: linking CrowdyJS $have from $sdk_dir instead of the declared devDependency ($declared)"
  node -e '
    const fs = require("fs"); const [p, dir] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m.devDependencies["@crowdedkingdoms/crowdyjs"] = `link:${dir}`;
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  ' "$target/package.json" "$sdk_dir"
fi

cd "$upstream"
if [ -z "${CROWDYJS_DIST:-}" ]; then
  # pnpm 11 waits a day before it will resolve a fresh release
  # (minimumReleaseAge); a dev prerelease of the SDK is usually minutes old
  # when this runs. The declared pin is a reviewed input, so name it in the
  # exclusion list the upstream workspace already keeps for such cases.
  declared="$(node -p "require('$here/package.json').devDependencies['@crowdedkingdoms/crowdyjs']")"
  if ! grep -qF "'@crowdedkingdoms/crowdyjs@$declared'" pnpm-workspace.yaml; then
    node -e '
      const fs = require("fs"); const [p, spec] = process.argv.slice(1);
      const src = fs.readFileSync(p, "utf8");
      const key = /^minimumReleaseAgeExclude:\s*$/m;
      if (!key.test(src)) throw new Error("pnpm-workspace.yaml has no minimumReleaseAgeExclude list");
      fs.writeFileSync(p, src.replace(key, (m) => `${m}\n  - ${JSON.stringify(spec).replace(/"/g, "\x27")}`));
    ' pnpm-workspace.yaml "@crowdedkingdoms/crowdyjs@$declared"
    echo "build-image: excluded @crowdedkingdoms/crowdyjs@$declared from pnpm's minimum release age"
  fi
fi
# Not frozen: this package's devDependencies are not in upstream's lockfile.
echo "build-image: pnpm install (with @crowdedkingdoms/crowdy-dsh in the workspace)"
quiet pnpm install --no-frozen-lockfile --reporter=append-only

echo "build-image: building @crowdedkingdoms/crowdy-dsh"
pnpm --filter @crowdedkingdoms/crowdy-dsh run build
echo "build-image: running the package tests"
quiet pnpm --filter @crowdedkingdoms/crowdy-dsh run test

echo "build-image: building the web page (index + crowdy.html)"
quiet pnpm --filter @deepseek-ai/dsh-experimental-webworker-runtime exec tsdown
quiet pnpm --filter @deepseek-ai/dsh-experimental-webworker-packer exec tsdown
(cd apps/web && DSH_CLIENT_TITLE="Crowdy Studio Agent" quiet pnpm exec vite build -c vite.crowdy.config.ts)

# Builds are done; the manifest that gets packed into the image is the repo's
# own (never a `link:` to a builder path).
cp "$here/package.json" "$target/package.json"

echo "build-image: packing the Crowdy VFS image"
node --import tsx/esm "$target/scripts/pack-image.ts" \
  --repo "$upstream" \
  --patch "$target/profile/crowdy-web.patch.yml" \
  --out "$upstream/apps/web/dist/preview/vfs-image.tar.gz"

echo "build-image: copying artifact to $out"
rm -rf "$out"
mkdir -p "$out"
# No source maps: they carry the builder's absolute paths and double the size.
rsync -a --exclude '*.map' --exclude 'fixtures' --exclude 'preview-fixtures.json' \
  "$upstream/apps/web/dist/" "$out/"
rm -f "$out/index.html" "$out/preview.html"
cp "$upstream/apps/web/dist/crowdy.html" "$out/index.html"

echo "build-image: scrubbing, checking and stamping the artifact"
node "$here/scripts/finish-artifact.mjs" --out "$out" --upstream "$upstream" \
  --sdk-version "$target/lib/vendor/crowdyjs-sdk.version.json"
du -sh "$out" | sed 's/^/build-image: artifact /'

echo "build-image: staging the npm package"
node "$here/scripts/stage-npm.mjs" --lib "$target/lib" --out "$here/dist/npm"
echo "build-image: done — $out serves under /dsh/; 'npm publish $here/dist/npm' ships it"
