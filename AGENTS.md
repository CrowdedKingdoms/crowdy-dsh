# AGENTS

`@crowdedkingdoms/crowdy-dsh` is the in-browser Crowdy Studio agent: DeepSeek
Harness plugins whose filesystem is a Crowdy Studio project, plus the build that
packs them with the stock harness web UI into a static artifact
(`dist/dsh-web/`) that games serve under `/dsh/` and CrowdyJS 16 embeds as the
Studio agent pane. Read `README.md` first; it is the architecture page.

## This repository is PUBLIC

Public SDK surfaces only. Nothing here may name a private repository, an
internal hostname, an app id, an operator tool, a credential, or a builder
path. `npm run check:content-policy` walks the whole tree including `dist/`
(the published artifact) and fails on a denylisted term; CI runs it after every
build and before every publish. Fixtures with fake tokens belong under
`*.test.ts` (gitleaks allowlists those paths).

## Three branches, tag-driven releases

`dev`, `test`, `prod`, and nothing else; GitHub default is `prod`; work lands
on `dev` through a pull request (direct pushes are refused by the org ruleset,
for every identity). Promotion is a merge forward `dev` -> `test` -> `prod`.

Releases are environment-prefixed tags on the branch the prefix names:
`dev/v0.2.0` -> `0.2.0-dev.N` on dist-tag `dev`; `test/v0.2.0` ->
`0.2.0-test.N` on `test`; `prod/v0.2.0` -> `0.2.0` on `latest`. `package.json`
`version` stays bare (`0.2.0`); the publish job adds the suffix and the next
free ordinal from the registry. The `guard` job (`scripts/ci/resolve-release-tier.sh`,
byte-identical to every other CK repo's copy) refuses a tag whose commit is not
contained in its tier branch. Publishing is npm Trusted Publishing (OIDC) with
provenance; the repository holds no npm token.

## Cross-repo artifacts stay on the same tier

The `@crowdedkingdoms/crowdyjs` devDependency is the SDK slice the worker
bundles, and it must match the CrowdyJS generation the page runs: `X.Y.Z-dev.N`
on `dev`, `X.Y.Z-test.N` on `test`, plain `X.Y.Z` on `prod`. When the pin is
not on the registry yet (a coordinated SDK change), CI builds CrowdyJS from the
branch named by `crowdyDsh.sdkSourceBranch` in `package.json`; drop that hint
with the next SDK bump once the pin publishes. `scripts/build-image.sh` refuses
a local SDK whose version differs from the pin.

Consumers (`the-construct` and the Crowded Kingdoms games) install this package
as a devDependency and copy `dist/dsh-web/` under `public/dsh/` at build time.
They pin the tier-matching version, never a caret.

## Where the files come from is the project's `source`, not a preference

`CrowdyStudioProject.source` (ck-api v2.0.0 / CrowdyJS 17) is `STUDIO` until
the owner binds a repository in Crowdy Studio and `GITHUB` while bound. Reads
never change: `crowdyStudioProject` returns the files either way (for a bound
project they are the server's mirror at `githubSha`). Writes follow the source
— `CrowdyProjectStore.commit` uses the files-only Studio save for STUDIO and
one `crowdyStudioGitHubPutFile` / `DeleteFile` per changed file, carrying
`expectedCommitSha`, for GITHUB. Do not mirror anything back to Studio from
here (the server does, in the same transaction as the commit), do not parse
`crowdy.json` (the API's `crowdyStudioGitHubLayout` is the grammar), and do
not add a "prefer GitHub" switch: `CROWDY_GITHUB_FIRST` was removed in 0.3.0
because the server decides. GitHub is never required of a modder. The worker
holds the player's **app token** only; the API scopes every GitHub field to
projects that token's user owns, so no identity session is needed and none may
ever cross the bridge.

## The protocol has two copies

`src/bridge/protocol.ts` is mirrored by CrowdyJS `src/crowdy-dsh/protocol.ts`
(the page side). A change to a message type, field, or
`CROWDY_DSH_PROTOCOL_VERSION` is a change to both, landed on both repos' `dev`
in the same program. Frames without the current version or the boot nonce are
dropped unread on both sides.

## Upstream is a pinned checkout, not a submodule

`upstream.json` names the DeepSeek Harness tag and commit this package builds
against (MIT; the notice ships in the artifact as `THIRD_PARTY_NOTICES.md`).
`scripts/checkout-upstream.sh` creates or verifies a sibling checkout at
`../deepseek-harness`; `scripts/build-image.sh` refuses any other commit. Bump
the pin deliberately: the plugin APIs are experimental.

## Security

`.github/workflows/security.yml` runs gitleaks (blocking), `npm audit`
(report-only until the baseline is clean) and CodeQL. Dependabot targets
`dev`, weekly, minors and patches grouped, majors and `@crowdedkingdoms/*`
ignored. A change to `src/bridge/` or `src/fs/` (where the player's app token
and the GitHub commit writes live) requests the code owner and runs the
`security-review` subagent first, with the findings in the PR body. The worker
holds the player's app token in memory only; it is never written to a seed
file or persisted to OPFS, and that is a property tests assert.

## Working here

- Fetch before you read: `git fetch origin && git rev-list --left-right --count origin/dev...HEAD`.
- Create a feature branch off `origin/dev`; commit as you go; open a PR to `dev`
  and merge it yourself with `gh api repos/CrowdedKingdoms/crowdy-dsh/pulls/<n>/merge -X PUT -f merge_method=merge`
  (`gh pr merge` refuses at preflight under the ruleset). `test` and `prod` need
  an admin to merge (same `update` lock as the other three-branch repos).
- Requires Node 22.19+ and pnpm via corepack. `bash scripts/checkout-upstream.sh`
  then `bash scripts/build-image.sh` builds, tests (82 `node:test` cases inside the
  upstream workspace), scrubs, stamps (`dist/dsh-web/BUILD.json`) and stages the
  npm package in `dist/npm/`.
- Keep a journal of what you learn; update this file and `README.md` when the
  code moves; do not add a `CHANGELOG` entry without a version bump.
