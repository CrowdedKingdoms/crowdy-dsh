# `@crowdedkingdoms/crowdy-dsh`

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)
plugins whose filesystem is a **Crowdy Studio project**, plus the build that
packs them — with the stock harness web UI — into a static artifact that runs
**entirely in the player's browser**. Crowdy Studio embeds that artifact as the
agent pane; the harness edits the project through the game API exactly as the
Studio editor does, and calls the model through the tier's metered model
endpoint with the player's own app token. In **game mode** the same harness
edits a game's own repository instead, as a draft the page owns and the world
previews, and commits only when the player asks ([Game mode](#game-mode)).

Replaces the Crowdy Agent orchestrator in the CK API and the CrowdyJS agent
dock (CrowdyJS 16). The page side of the bridge lives in CrowdyJS
(`@crowdedkingdoms/crowdyjs/crowdy-dsh`); [`src/bridge/protocol.ts`](src/bridge/protocol.ts)
and its CrowdyJS mirror must stay in step.

## How it fits together

```text
game page (the-construct)                 iframe /dsh/index.html            Web Worker
┌──────────────────────────┐   postMessage  ┌──────────────────┐  tunnel   ┌─────────────────────────┐
│ CrowdyJS Studio panel    │ ─────────────► │ crowdy-boot.ts   │ ────────► │ dsh plugin tree          │
│  DshPane + bridge (page) │   boot files   │ + stock web UI   │           │  crowdy-fs  (ctx.fs)     │
│  screenshots, draft test │ ◄────────────  │                  │           │  crowdy-bridge           │
│  game observe, projects  │ BroadcastChannel ────────────────────────────►│  crowdy-tools, search    │
└──────────────────────────┘                └──────────────────┘           │  attachment-crowdy       │
            │ fetch (app token)                                             │  crowdy-persist (OPFS)   │
            ▼                                                               └──────────┬──────────────┘
      ck-api: crowdyStudio* / crowdyStudioGitHub* ◄───────────────────────────────────┘ fetch (app token)
      ck-api: POST /v1/model/chat/completions  (metered, fronts OpenRouter) ◄──────────┘
```

| Seam | Stock | Here |
|---|---|---|
| `ctx.fs` | `dsh-fs-sandbox` over the local disk | [`./fs`](src/fs/crowdy-file-system.ts): the project. Reads are always the project's files (`crowdyStudioProject`); for a project bound to GitHub those are the server's mirror of the repository at `githubSha`. Writes go by `source`: a STUDIO project through the files-only save under `expectedRevision`, a GITHUB project as one commit per changed file (`crowdyStudioGitHubPutFile` / `DeleteFile` carrying `expectedCommitSha`). Nothing is mirrored from here; the server advances the mirror with each commit, so Monaco and the agent look at one tree. Layout comes from `crowdyStudioGitHubLayout`; this package does not parse `crowdy.json`. GitHub is never required. `captures/` and `context/` are in-memory scratch dirs the page fills. In game mode the same row mounts [`GameFileSystem`](src/fs/game-file-system.ts) instead: the page's draft of the bound repository (see below). |
| `ctx.attachments` | `dsh-attachment-local` (sharp) | [`./attachments`](src/attachments/crowdy-attachment-store.ts): in-memory, header-sniffed dimensions; the browser worker has no native image codec. |
| agent preset | `standard` | [`presets/crowdy`](presets/crowdy/agent.cordis.yml): file tools, in-memory `glob`/`grep`, `sdk_lookup`, and the Studio tools below. No shell, no web, no subagents. [`presets/crowdy-game`](presets/crowdy-game/agent.cordis.yml) is the game editor's: file tools and search over the draft, the page's `screenshot` / `game_observe` / `client_logs`, the game tools, the game's skills and its `STUDIO.md`. |
| page link | — | [`./bridge-client`](src/bridge/client-service.ts): `ctx.crowdyBridgeClient`, a `BroadcastChannel` to the Studio page ([protocol](src/bridge/protocol.ts)). [`./bridge`](src/bridge/index.ts): `ctx.crowdyBridge`, the session side (boot handshake, token, scratch, change events). |
| tools | — | [`./tools`](src/tools/index.ts): `draft_test` and `deploy_live` (both confirmed by the player on the page, since a draft deploys the mod to the grid too; `deploy_live` is also approval-gated in the harness), `screenshot`, `runtime_status`, `client_logs`, `game_observe`, `project_list/open/create`, and (bridge v4) `grid_context`, `grid_program_run`, `grid_program_status` for JS grid programs in the project's grid. The page executes them with the player's authority. `only` limits the list (the game preset takes the page tools alone). [`./game-tools`](src/tools/game.ts): `commit_game_files` (approval-gated here and confirmed on the page), `preview_status`, `read_playbook`. |
| skills | `skill-filesystem` | [`./playbook-skills`](src/skills/playbook.ts): an upstream skill provider over `studio.listSkills` / `studio.readPlaybook`, so the skills are whatever the game's playbook lists. Game preset only. |
| model route | pi-ai | `llm-deepseek` (direct fetch; pi-ai is a stub in the worker) pointed at the tier model endpoint via `settings.yaml`. |
| persistence | disk | [`./persist`](src/persist/index.ts): mirrors `home/sessions`, `home/storages`, `settings.yaml` to OPFS; the page restores them as a boot overlay. |

## Boot contract (what the embedding page provides)

The iframe posts `{type:'crowdy-dsh:ready'}`; the page answers with:

```ts
iframe.contentWindow.postMessage({
  type: 'crowdy-dsh:boot',
  files: {
    'crowdy.json': JSON.stringify({ graphqlUrl, appId, projectId, bridgeChannel, bridgeNonce, root: '/dsh/workspace', persistScope, studioMode }),
    'settings.yaml': `llm-deepseek:\n  apiKeyEnv: CROWDY_APP_TOKEN\n  baseURL: ${modelBaseUrl}\n  thinking: disabled\n  models: [...]\nagent-default-model:\n  provider: deepseek-official\n  model: ${defaultModel}\n`
      + (studioMode === 'game' ? 'agent-presets:\n  default: crowdy-game\n' : ''),
  },
  nonce: bridgeNonce,    // one-time secret; every bridge frame carries it
  persistScope,          // OPFS directory, e.g. `${appId}/${userId}`
  mount: '/dsh/workspace',
}, location.origin)
```

then joins `new BroadcastChannel(bridgeChannel)` as the `page` side and answers
the requests in [`protocol.ts`](src/bridge/protocol.ts). The app token is NOT
in the seed files: the page sends it in `page.hello` and again in `page.token`
when it refreshes, the worker holds it in memory as `CROWDY_APP_TOKEN` (which
the model route reads per request), and the first project load waits up to 5 s
for it. Nothing writes it to the virtual filesystem or OPFS, and the Crowdy
filesystem backend serves only the project mount, so `read_file` cannot reach
the environment. `page.project` switches projects, `page.saved` invalidates
cached files. Both sides drop frames without the boot nonce: a
`BroadcastChannel` is reachable by every same-origin script. CrowdyJS
implements the page side in `src/crowdy-dsh/`; it also confirms a live deploy
with the player on the page before running it.

The game's own host serves the page and `/dsh/`. Crowded Kingdoms does not
host games: the developer deploys both to the game's origin, on any static
host that can set response headers.
[Host your game](https://docs.crowdedkingdoms.com/build-a-game/host-your-game)
and the Construct's
[hosting guide](https://github.com/CrowdedKingdoms/the-construct/blob/prod/docs/HOSTING.md)
have the full header set and recipes for common hosts.

Headers the host must send (verified with `crossOriginIsolated === true`):
the cross-origin isolation headers (COOP `same-origin` and a COEP) on every
response, `/dsh/*` included; game page CSP unchanged except `frame-src 'self'`;
every `/dsh/*` response carries
`script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:`,
`connect-src 'self' blob:`, `worker-src 'self' blob:`, `frame-ancestors 'self'`
(the worker compiles pre-lowered module bodies with `new Function`; the harness
document runs its own client module system). The API and model endpoints must
be same-origin or in `connect-src`.

## Game mode

A Construct-template game (the API reports its layout `kind` as
`CONSTRUCT_GAME`) is edited as its own repository, not as Studio crates. The
page decides: it boots the worker with `studioMode: 'game'` in `crowdy.json`,
a `persistScope` of its own (sessions of the two editors never mix) and
`agent-presets.default: crowdy-game` in `settings.yaml`. The worker reports
`modes: ['mod', 'game']` in `worker.ready`; a page that boots game mode on an
older worker says so instead of running the mod editor on a game.

- **The draft is the page's.** CrowdyJS keeps it (a `DraftStore`: an overlay
  over the repository at a base commit, in the browser when the game runs from
  its own deployed origin, on the dev server's checkout locally). The worker's
  filesystem is a view of it: `draft.tree` once, then every change through
  `page.draftChanged`; text by `draft.read` in batches, cached by blob id.
  Versions are git blob SHA-1s, so listing, `stat` and `read_file` agree with
  what the page shows.
- **Writes are guarded the harness's way.** A write carries the tool's intent
  (`createIfAbsent`, or `replaceIfVersion` as `ifHash`); a file the player
  changed since the model read it is a stale write (`FS_STALE_VERSION`), never
  an overwrite. `.git`, `node_modules`, `.env*` and `.github/workflows` are not
  repository files here; `captures/` and `context/` are page scratch.
- **Nothing commits on its own.** `commit_game_files {message, paths?}` asks
  the harness approval, then the page shows the files and the message and the
  player confirms; the page commits them as one commit against the draft's
  base. A conflict (the branch moved under an edited file) comes back for the
  player to settle in the Files pane.
- **The game brings its guidance.** The preset reads the game's `STUDIO.md` as
  its instructions (not `AGENTS.md`, which a repository writes for an agent
  with a shell) and lists the skills the game's playbook names in
  `skills/index.json`. Nothing in this package names a game.
- **`preview_status`** asks the page whether the running world took the latest
  draft revision, with the errors it hit by file and line.

## Building the artifact

Requires Node **22.19+** and pnpm (corepack). The upstream DeepSeek Harness is a
**sibling checkout** at the tag pinned in [`upstream.json`](upstream.json)
(`dsh-v0.1.5-rc.2`), not a submodule; this repo carries none.

```bash
nvm use 22
bash scripts/checkout-upstream.sh    # clones ../deepseek-harness at the pin, or verifies it
bash scripts/build-image.sh          # ~6 min first time (builds upstream), then ~30 s
# SKIP_UPSTREAM=1 to reuse a built upstream; UPSTREAM_DIR=... to point elsewhere
# CROWDYJS_DIST=../CrowdyJS/dist to bundle a local, not-yet-published SDK
```

CI does the same when the declared `@crowdedkingdoms/crowdyjs` pin is not on
the registry yet: it builds the SDK from the branch named by
`crowdyDsh.sdkSourceBranch` in `package.json` (falling back to a CrowdyJS
branch of the same name, then the target branch, then `dev`) and bundles that.
`build-image.sh` refuses a local SDK whose version differs from the pin
(prerelease suffix aside; `CROWDYJS_ALLOW_MISMATCH=1` for a local experiment).
Once the pin publishes, the hint is inert; drop it with the next SDK bump.

`dist/dsh-web/` is the artifact: `index.html` (the stock web client plus
`web/crowdy-boot.ts`), `assets/`, `preview/` (worker bundle + the packed
`vfs-image.tar.gz`, ~7 MB), `BUILD.json` (package version, this repo's commit,
upstream tag and commit, the CrowdyJS the worker bundles, sha256 of every file),
`LICENSE.deepseek-harness` and `THIRD_PARTY_NOTICES.md`. Serve it under
`/dsh/` of the game's own origin, with the headers above.
`preview/vfs-image.tar.gz` must reach the browser with no `Content-Encoding`
header, because the worker decompresses it itself; a host that adds
`Content-Encoding: gzip` to `.gz` files needs an exception for that file.

The build refuses an artifact that names the builder's home directory or the
upstream checkout path (`//#region` markers and `patched by` comments are
rewritten to `<upstream>`), a tier API host (the bundled SDK slice replaces the
generated `default-origin` with empty origins; the page always supplies
`graphqlUrl`), or the DeepSeek telemetry collector (the plugin is disabled in
the profile). Source maps are not shipped.

What the script does: copies this package into `<upstream>/packages/crowdy/`,
copies `presets/crowdy` into the shipped preset root, `pnpm install`, builds
and runs the tests, bundles the CrowdyJS slice
([`scripts/bundle-sdk.mjs`](scripts/bundle-sdk.mjs) — the package root would
drag Monaco and tree-sitter into the image), builds the page with
[`web/vite.crowdy.config.ts`](web/vite.crowdy.config.ts), packs `web` +
[`profile/crowdy-web.patch.yml`](profile/crowdy-web.patch.yml) with
[`scripts/pack-image.ts`](scripts/pack-image.ts), then scrubs, checks and stamps
with [`scripts/finish-artifact.mjs`](scripts/finish-artifact.mjs) and stages
the npm package in `dist/npm/` with [`scripts/stage-npm.mjs`](scripts/stage-npm.mjs).

## Shipping it

`@crowdedkingdoms/crowdy-dsh` is published to npm by
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) on an
environment-prefixed tag on one of the three long-lived branches, the
CrowdyJS convention: `dev/v0.2.0` publishes `0.2.0-dev.N` under `@dev`,
`test/v0.2.0` publishes `0.2.0-test.N` under `@test`, `prod/v0.2.0` publishes
`0.2.0` under `@latest`. The `guard` job refuses a tag whose commit is not on
the branch the prefix names (`scripts/ci/resolve-release-tier.sh`). Publishing
uses npm Trusted Publishing (OIDC) with provenance; there is no token. Every
push and pull request builds and tests ([`ci.yml`](.github/workflows/ci.yml));
only a tag publishes. The published
manifest has no runtime dependencies (the `@deepseek-ai` workspace siblings
become optional peers) because a game installs it for `dist/dsh-web/` alone:

```bash
npm i -D @crowdedkingdoms/crowdy-dsh@dev
# prebuild: copy node_modules/@crowdedkingdoms/crowdy-dsh/dist/dsh-web -> public/dsh (gitignored)
```

The CrowdyJS major the worker bundles must match the one the page runs;
`bundle-sdk.mjs` refuses otherwise. Bump the `@crowdedkingdoms/crowdyjs`
devDependency together with the game pins.

## Developing

Inside the upstream workspace (after one `build-image.sh`):

```bash
cd ../deepseek-harness/packages/crowdy/crowdy-dsh
pnpm run build && pnpm run test      # node:test, 82 tests: fs semantics, GitHub store, bridge, attachments, search
```

Developer cockpit on Node (no browser, no page tools):

```bash
cp .env.example .env && set -a && . ./.env && set +a
node lib/scripts/probe.js            # connectivity: store choice, files, guarded write with --write
dsh --profile web --patch ./profile/crowdy-node.patch.yml
```

## Known limitations

- Experimental upstream packages (`webworker-runtime`, `webworker-packer`) are
  private and may change; the tag is pinned and the build fails loud.
- Attachments are in memory: a reload keeps the session text but not the pixels.
- A multi-file write on a GitHub-bound project is one commit per file; a
  stale race part-way through leaves the earlier commits on the branch and the
  filesystem reports `FS_STALE_VERSION` for the rest. Re-read and retry.
- The developer cockpit needs a real, empty mount directory (`CROWDY_MOUNT`).
