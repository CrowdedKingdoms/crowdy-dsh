// Public content policy: this repository and the package it publishes are
// public. Nothing in either may name a private repository, internal
// infrastructure, or a builder machine. CI fails if a denylisted term appears
// anywhere in the corpus below.
//
// WHY THIS WALKS THE TREE INSTEAD OF ASKING GIT. `dist/` is gitignored and is
// also what npm ships (`dist/npm/` is the staged package, `dist/dsh-web/` the
// artifact inside it), so a gate whose corpus is "what git tracks" polices the
// input and not the artifact. CrowdyJS learned this the expensive way: a private
// repo name rode a generated file into 69 published versions. So: walk from a
// named root, skip directories by name with a reason beside each, never read an
// ignore file, and print the corpus size on every run so a reader can tell a
// clean tree from an unopened one.
//
// Usage:
//   node scripts/check-content-policy.mjs              # the repository root (dist/ included when present)
//   node scripts/check-content-policy.mjs <dir>        # another root, e.g. a downloaded staged package
//   node scripts/check-content-policy.mjs --self-test  # prove the gate refuses a planted reference
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

// Private repositories on this GitHub organization and the privileged wrapper,
// plus the realtime service's internals. `the-construct`, `CrowdyJS`, `CrowdyCPP`,
// `cks-docs` and `cks-loadtest` are public and may be named.
const DENYLIST = [
  'cks-udp-api',
  'cks-michael-root',
  'cks-project-root',
  'cks-game-api',
  'cks-management-ui',
  'cks-platform-core',
  'infra-control-plane',
  'crowd-altar',
  'Crowdy-Games',
  'MessageType.hpp',
  'wire-protocol-reference',
  'P2P_SECRET',
  'P2P_TOKEN',
  'CHANNEL_MUTATION',
  'port 9081',
  ':9081',
  'buddydev',
  'BUDDY_BUILDER',
  'dev-run-buddy',
  '/home/ubuntu/',
  'tailscale',
  '.ts.net',
];

// Skipped by NAME, never by an ignore file, with the reason each one is skipped.
// `dist` is deliberately absent: it is the published artifact and therefore the
// most important directory in the corpus.
const SKIP_DIRS = new Map([
  ['node_modules', 'third-party dependencies; not our text to police'],
  ['.git', 'object store; contains every historical revision by construction'],
  ['coverage', 'test-run output, regenerated per run'],
  ['.audit', 'security.yml scratch manifest'],
]);

// `.git` is a directory in a clone and a file in a worktree (holding a path that
// names the checkout's ancestors); skipped in both forms.
const SKIP_ANY = new Set(['.git']);

// Binary payloads have no reviewable prose. Listed by extension so the
// exclusion is a decision rather than a heuristic over file contents.
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.woff', '.woff2', '.ttf', '.otf',
  '.tgz', '.zip', '.gz', '.wasm',
]);

// This file quotes every denylisted term above, so scanning it would always fail.
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (SKIP_ANY.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (SKIP_EXT.has(extname(entry.name).toLowerCase())) continue;
      out.push(full);
    }
  }
  return out;
}

export function scan(root) {
  const files = walk(root, []);
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    const rel = relative(root, file);
    if (root === ROOT && rel === SELF) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // unreadable is not a pass: it is counted out of `scanned` below
    }
    if (text.includes('\u0000')) continue;
    scanned += 1;
    const lines = text.split('\n');
    for (const term of DENYLIST) {
      lines.forEach((line, i) => {
        if (line.includes(term)) findings.push({ term, file: rel, line: i + 1, text: line.trim().slice(0, 160) });
      });
    }
  }
  return { corpus: files.length, scanned, findings, distPresent: files.some((f) => relative(root, f).startsWith('dist')) };
}

function report(root, label) {
  const { corpus, scanned, findings, distPresent } = scan(root);
  console.log(`[content-policy] ${label}: corpus ${corpus} files, ${scanned} scanned as text, ${DENYLIST.length} terms`);
  if (root === ROOT) {
    console.log(
      distPresent
        ? '[content-policy] dist/ present and INCLUDED -- the published artifact was checked'
        : '[content-policy] dist/ absent: source checked, PUBLISHED ARTIFACT NOT CHECKED (run after scripts/build-image.sh to cover it)',
    );
  }
  for (const f of findings) console.error(`  DENYLISTED '${f.term}'  ${f.file}:${f.line}: ${f.text}`);
  if (findings.length) {
    console.error(`[content-policy] FAILED: ${findings.length} reference(s) to private repositories or internal infrastructure.`);
    return 1;
  }
  console.log('[content-policy] passed.');
  return 0;
}

// A gate that has never been observed refusing is unproven. Plant the exact
// shape of the historical leak -- a generated file under dist/ -- and assert refusal.
function selfTest() {
  const fixture = mkdtempSync(join(tmpdir(), 'content-policy-'));
  let failures = 0;
  const check = (name, got, want) => {
    const ok = got === want;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) failures += 1;
  };
  try {
    mkdirSync(join(fixture, 'dist', 'dsh-web'), { recursive: true });
    writeFileSync(join(fixture, 'README.md'), '# clean\n');
    const clean = scan(fixture);
    check('a clean tree passes', clean.findings.length, 0);
    writeFileSync(join(fixture, 'dist', 'dsh-web', 'index.js'), `// see ${DENYLIST[2]}/docs\n`);
    const planted = scan(fixture);
    check('a reference in dist/ (the published artifact) is refused', planted.findings.length > 0 ? 1 : 0, 1);
    check('dist/ is reported as covered when present', planted.distPresent ? 0 : 1, 0);
    writeFileSync(join(fixture, 'dist', 'dsh-web', 'image.tar.gz'), `${DENYLIST[2]}\n`);
    check('a .gz payload is not scanned as prose', scan(fixture).findings.length, planted.findings.length);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  if (failures) {
    console.error(`[content-policy] self-test FAILED: ${failures} case(s)`);
    return 1;
  }
  console.log('[content-policy] self-test passed.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (arg === '--self-test') process.exit(selfTest());
  const root = arg ? resolve(arg) : ROOT;
  const self = selfTest();
  process.exit(self || report(root, arg ? `crowdy-dsh (${arg})` : 'crowdy-dsh'));
}
