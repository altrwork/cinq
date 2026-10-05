// The lander: the only writer to trunk. Runs inside a Cloudflare Container (stock node:22 image,
// started with `node -e <this file>`), and runs unchanged under plain Node for local tests.
//
// POST /land  — gate one candidate against current trunk and, if every gate passes, push it.
// POST /env   — report git/node versions (health + cold-start probe).
// POST /seed  — create trunk content (setup and tests only).
//
// Gates (all must pass):
//   noop            the candidate changes nothing outside its own intent files
//   footprint       every changed file is in the intent's allowed paths
//   testsProtected  no existing trunk test is modified or deleted unless explicitly allowed
//   protectedDirs   the platform's own directory (.cinq/) is never touched by a candidate
//   merge           plain git merge succeeds (otherwise: conflict → re-derive)
//   tests           trunk tests run from TRUNK's copy + the intent's tests + hidden tests;
//                   0 tests ran = red; a failing file gets one re-run (flake check)
//   trunkIntact     main did not move while agent code ran (nothing pushed behind the lander's back)
// Security gates, all deterministic and recorded on the receipt; they run before any candidate code does:
//   secrets         no token-shaped string or high-entropy secret on an added line            → refuse
//   deps            every dependency / lockfile change is declared on the job (intent.deps)    → refuse
//                   a NEW package with install scripts                                         → park
//   protectedPaths  .cinq/config.json "protectedPaths" (defaults below) are never touched      → park
//   diffBudget      changed lines per job ≤ .cinq/config.json "diffBudget" (default 400)       → park ("split this job")
// Review: with requireReview, a candidate that passes every gate is not pushed until an agent that didn't
// write it has read the diff. .cinq/config.json "review": "block" (default) | "advisory" | "off". The landing
// that follows a review pins the reviewed commit (expectSha): a fork pushed to after review is refused.
// Credentials: trunk's write token never sits in a directory where agent code runs. `origin` is stored
// without credentials; the token reaches git only as an Authorization header in the environment of the one
// fetch or push that needs it. Install and every test run happen in a throwaway copy of the tree (no .git,
// fresh per run), with install scripts off unless main's .cinq/config.json opts in, and node_modules rebuilt
// from a cache keyed by the lockfile hash, so nothing a previous landing wrote can run in a later one.
// Failing tests owned only by already-landed intents → verdict "breaks-dependents"
// (the contract-change case: the caller re-derives those intents on top and lands them together).
'use strict';
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', HOME: process.env.HOME || os.tmpdir() };
delete ENV.NODE_TEST_CONTEXT; // set by an outer `node --test`; it would swallow the repo's own test output
const WORK = process.env.LANDER_WORK || path.join(os.tmpdir(), 'lander');
const PROTECTED = ['.cinq/'];
const TEST_RE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

const DEFAULT_PROTECTED_PATHS = ['.github/**', '**/auth/**', '**/wrangler.*', '**/.env', '**/.env.*', '.npmrc', 'Dockerfile'];
// The repo's own review guides: every reviewer reads them, and they are always protected, whatever a repo's
// protectedPaths say (an agent that could rewrite REVIEW.md could lower its own bar). app/cli and app/web repeat this list.
const GUIDE = /(^|\/)(REVIEW|AGENTS|CLAUDE|BUGBOT|CONTRIBUTING|ARCHITECTURE|STYLEGUIDE|CONVENTIONS)\.md$|(^|\/)docs\/(architecture|adr|decisions)[^/]*\.md$/i;
const DEFAULT_DIFF_BUDGET = 400;
const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const now = () => Date.now();
const mask = (s) => String(s).replace(/x:[^@\s]+@/g, 'x:***@').replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic ***');
function run(cwd, cmd, args, timeout = 300000, env = ENV) {
  try { return { ok: true, out: execFileSync(cmd, args, { windowsHide: true, cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 64 << 20 }) }; }
  catch (e) { return { ok: false, out: mask((e.stdout || '') + (e.stderr || '') + (e.stdout || e.stderr ? '' : e.message || '')) }; }
}
const GIT_BASE = ['-c', 'user.name=lander', '-c', 'user.email=lander@cinq.local', '-c', 'credential.helper=', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=/dev/null'];
const git = (cwd, ...a) => run(cwd, 'git', [...GIT_BASE, ...a]);
// A remote with credentials (https://x:<token>@host/...) → the bare URL plus an env that carries the token as a
// header for one git process. The token is never written to .git/config and never appears in argv.
function creds(remote) {
  const m = String(remote).match(/^(https?:\/\/)([^@/]+)@(.*)$/);
  if (!m) return { url: remote, env: ENV };
  const header = 'Authorization: Basic ' + Buffer.from(decodeURIComponent(m[2])).toString('base64');
  return { url: m[1] + m[3], env: { ...ENV, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: header } };
}
const gitAuth = (cwd, remote, ...a) => { const c = creds(remote); return run(cwd, 'git', [...GIT_BASE, ...a.map((x) => (x === '<remote>' ? c.url : x))], 300000, c.env); };
// A repo-relative path joined under dir, refusing anything that would land outside it (the engine already refuses
// "..", absolute paths and .cinq/; this is the lander's own check, since it writes these files itself).
function inside(dir, p) {
  const full = path.resolve(dir, p);
  if (!p || path.isAbsolute(p) || !full.startsWith(path.resolve(dir) + path.sep) || /(^|\/)\.(git|cinq)(\/|$)/i.test(p)) throw Object.assign(new Error(`unsafe path: ${p}`), { unsafe: p });
  return full;
}
// the owner-only harness ops (seed, apply) write .cinq/ on purpose: they only must not leave their directory
const within = (dir, p) => { const full = path.resolve(dir, p); if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error(`unsafe path: ${p}`); return full; };
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const isTest = (f) => TEST_RE.test(f);
const timer = () => { const t0 = now(); const marks = {}; return { mark: (k) => (marks[k] = now() - t0), marks }; };

// A persistent clone per trunk, reset to origin/main on every landing (fast after the first clone).
function trunkWorkspace(trunk) {
  const { url } = creds(trunk);
  fs.mkdirSync(WORK, { recursive: true, mode: 0o700 }); try { fs.chmodSync(WORK, 0o700); } catch {}
  const id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
  const dir = path.join(WORK, id);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(WORK, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    // Installed dependencies must never be committed, whatever the repo's own .gitignore says.
    fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\nnode_modules/\n');
    git(dir, 'remote', 'add', 'origin', url);
  }
  git(dir, 'remote', 'set-url', 'origin', url); // credential-free, even if the workspace was cloned with a token
  git(dir, 'merge', '--abort');
  const f = gitAuth(dir, trunk, 'fetch', '-q', 'origin', '+main:refs/remotes/origin/main');
  if (!f.ok) throw Object.assign(new Error('fetch trunk failed'), { detail: f.out.slice(0, 300) });
  git(dir, 'checkout', '-q', '-f', '-B', 'main', 'refs/remotes/origin/main');
  git(dir, 'reset', '-q', '--hard', 'refs/remotes/origin/main');
  git(dir, 'clean', '-qfdx');
  return dir;
}

// A fresh directory per run with the working tree only (no .git, so no remote and no history), its own HOME,
// and a minimal environment. Every process it starts is killed when the run ends (its process group, then everything
// the sandbox user owns, which catches one that left the group), so nothing an install script or test leaves running
// survives into the push or a later landing.
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const a = path.join(from, e.name); const b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b); else if (e.isFile()) fs.copyFileSync(a, b);
  }
}
// When the lander runs as root (in its container), agent-controlled code runs as an unprivileged user that owns
// only its sandbox: the lander's workspace (WORK, mode 0700, root's) with its .git, config, objects and the deps
// cache is out of its reach, so it can neither change what gets committed nor where the push goes.
const SANDBOX_UID = process.getuid && process.getuid() === 0 && process.env.LANDER_SANDBOX_UID !== 'off' ? +(process.env.LANDER_SANDBOX_UID || 65534) : null;
function ownSandbox(sbx) { if (SANDBOX_UID != null) spawnSync('chown', ['-R', `${SANDBOX_UID}:${SANDBOX_UID}`, sbx.root], { windowsHide: true }); }
// kill(-1) as the sandbox user signals every process that user owns: one sandbox runs at a time (spawnSync), so this
// only ever reaches what agent code left behind
function killSandboxUser() {
  if (SANDBOX_UID != null) spawnSync(process.execPath, ['-e', 'try { process.kill(-1, "SIGKILL") } catch {}'], { uid: SANDBOX_UID, gid: SANDBOX_UID, stdio: 'ignore', timeout: 10000 });
}
function sandbox(dir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinq-run-'));
  const repo = path.join(root, 'repo'); const home = path.join(root, 'home');
  copyTree(dir, repo); fs.mkdirSync(home);
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: root, LANG: 'C.UTF-8', CI: '1',
    npm_config_cache: path.join(home, '.npm'), npm_config_update_notifier: 'false', GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GCM_INTERACTIVE: 'never' }; // no machine-wide git config: code under test never reaches a credential helper
  if (process.platform === 'win32') for (const k of ['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'APPDATA']) if (process.env[k]) env[k] = process.env[k]; // what cmd and npm need on Windows
  const sbx = { root, dir: repo, env, done: () => { killSandboxUser(); fs.rmSync(root, { recursive: true, force: true }); } };
  ownSandbox(sbx);
  return sbx;
}
function sbxRun(sbx, cmd, args, timeout = 300000) {
  const as = SANDBOX_UID != null ? { uid: SANDBOX_UID, gid: SANDBOX_UID } : {};
  const shell = process.platform === 'win32' && /^(npm|npx|corepack|yarn|pnpm)$/.test(cmd); // .cmd shims on Windows need a shell (local dev only)
  const r = spawnSync(cmd, args, { cwd: sbx.dir, env: sbx.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 64 << 20, detached: process.platform !== 'win32', windowsHide: true, shell, ...as }); // detached on Windows = no console, so every child it starts opens a window
  if (r.pid) { try { process.kill(-r.pid, 'SIGKILL'); } catch {} } // anything it left running in its group
  killSandboxUser(); // and anything that left the group (setsid, a double fork)
  const out = mask((r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error.message) : ''));
  return { ok: r.status === 0 && !r.error, out };
}

// Glob → RegExp: ** spans directories, * and ? stay inside one path segment.
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (p, globs) => globs.some((g) => globRe(g).test(p));
// Added lines of a diff with their file and line number in the new version.
function addedLines(diffText) {
  const out = []; let file = null; let ln = 0; let header = false; let prev = '';
  for (const l of diffText.split('\n')) {
    // "+++ b/<file>" names the file only in a file's header (between "diff --git" and the first hunk): an added
    // line whose text starts with "++ " must still be scanned as content
    if (l.startsWith('diff --git ')) { header = true; file = null; prev = l; continue; }
    if ((header || prev.startsWith('--- ') || !file) && l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); header = true; prev = l; continue; }
    prev = l;
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/); if (h) { header = false; ln = +h[1]; continue; }
    if (header) continue;
    if (file && l.startsWith('+')) out.push({ file, line: ln++, text: l.slice(1) });
    else if (file && !l.startsWith('-') && !l.startsWith('\\')) ln++;
  }
  return out;
}
const SECRET_RULES = [
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['stripe-key', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['ai-api-key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/],
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['credential-in-url', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{8,}@/i],
];
function entropy(s) { const f = {}; for (const c of s) f[c] = (f[c] || 0) + 1; return Object.values(f).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0); }
// A long run of base64-ish characters with high entropy and mixed character classes reads as a secret.
// Hex digests (≤ 4 bits/char) and lockfile integrity hashes are not checked.
function highEntropy(text) {
  for (const m of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const t = m[0];
    if (/^[0-9a-f]+$/i.test(t) || /(sha(1|256|384|512))-$/.test(text.slice(Math.max(0, m.index - 7), m.index))) continue;
    if (/[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t) && entropy(t) >= 4.5) return t;
  }
  return null;
}
function scanSecrets(diffText) {
  const findings = [];
  for (const a of addedLines(diffText)) {
    for (const [rule, re] of SECRET_RULES) { const m = a.text.match(re); if (m) { findings.push({ file: a.file, line: a.line, rule, preview: m[0].slice(0, 4) + '***' }); break; } }
    if (!findings.length || findings.at(-1).line !== a.line || findings.at(-1).file !== a.file) {
      if (!LOCKFILES.test(a.file)) { const t = highEntropy(a.text); if (t) findings.push({ file: a.file, line: a.line, rule: 'high-entropy', preview: t.slice(0, 4) + '***' }); }
    }
  }
  return findings;
}
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
function readJsonAt(dir, ref, p) { const r = git(dir, 'show', `${ref}:${p}`); try { return r.ok ? JSON.parse(r.out) : null; } catch { return null; } }
// What the candidate changes about dependencies, read from its package.json files and its npm lockfile.
function depChanges(dir, mb, touched) {
  const added = []; const removed = []; const changed = [];
  for (const p of touched.filter((f) => /(^|\/)package\.json$/.test(f))) {
    const a = readJsonAt(dir, mb, p) || {}; const b = readJsonAt(dir, 'refs/candidate', p) || {};
    const all = (o) => Object.assign({}, ...DEP_SECTIONS.map((k) => o[k] || {}));
    const A = all(a); const B = all(b);
    for (const n of Object.keys(B)) { if (!(n in A)) added.push(`${n}@${B[n]}`); else if (A[n] !== B[n]) changed.push(`${n}@${A[n]}→${B[n]}`); }
    for (const n of Object.keys(A)) if (!(n in B)) removed.push(n);
  }
  const lockfiles = touched.filter((f) => LOCKFILES.test(f));
  // npm lockfiles (v2/v3) mark packages with install scripts; a NEW one is a supply-chain risk a person should see.
  const withScripts = [];
  for (const p of lockfiles.filter((f) => /package-lock\.json$|npm-shrinkwrap\.json$/.test(f))) {
    const a = readJsonAt(dir, mb, p)?.packages || {}; const b = readJsonAt(dir, 'refs/candidate', p)?.packages || {};
    for (const [k, v] of Object.entries(b)) if (k && v?.hasInstallScript && !a[k]?.hasInstallScript) withScripts.push(k.replace(/^.*node_modules\//, ''));
  }
  // pnpm lockfiles mark them with `requiresBuild: true` under the package's key (lockfile v6; v9 dropped the flag).
  const pnpmBuilds = (text) => { const out = new Set(); let inPkgs = false, key = null;
    for (const l of String(text || '').split('\n')) {
      if (/^\S/.test(l)) { inPkgs = /^packages:\s*$/.test(l); key = null; continue; }
      const k = inPkgs && l.match(/^ {2}['"]?\/?([^'"\s][^'"]*?)['"]?:\s*$/); if (k) { key = k[1]; continue; }
      if (inPkgs && key && /^ {4}requiresBuild:\s*true\s*$/.test(l)) out.add(key.replace(/\(.*$/, ''));
    } return out; };
  for (const p of lockfiles.filter((f) => /pnpm-lock\.yaml$/.test(f))) {
    const a = pnpmBuilds(git(dir, 'show', `${mb}:${p}`).out); const b = pnpmBuilds(git(dir, 'show', `refs/candidate:${p}`).out);
    for (const k of b) if (!a.has(k)) withScripts.push(k);
  }
  const names = [...added.map((x) => x.replace(/@[^@]*$/, '')), ...changed.map((x) => x.replace(/@[^@]*$/, '')), ...removed];
  return { added, removed, changed, lockfiles, names, newWithInstallScripts: withScripts };
}

// node --test with the TAP reporter (ASCII summary lines). TAP names failing *tests*, not files,
// so on failure each test file is run on its own to attribute failures to files exactly.
function walk(dir, pre = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, pre), { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = pre ? `${pre}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, p)); else out.push(p);
  }
  return out;
}
function testFiles(dir) { return walk(dir).filter((p) => isTest(p) && /\.[cm]?js$/.test(p)); }
// Failing files straight from the TAP output: each failing test's YAML block carries
// `location: '<file>:<line>:<col>'`. Cheap and exact; per-file re-runs are only the fallback.
function failingFromTap(dir, out) {
  const files = new Set(); const rows = out.split('\n');
  for (let i = 0; i < rows.length; i++) {
    if (!/^\s*not ok \d+/.test(rows[i])) continue;
    for (let j = i + 1; j < Math.min(rows.length, i + 40) && !/^\s*(not )?ok \d+/.test(rows[j]); j++) {
      const m = rows[j].match(/^\s*location: '(.+?):\d+:\d+'/);
      if (m) { const loc = m[1].replace(/\\\\/g, '\\'); let rel = path.relative(dir, loc); if (rel.startsWith('..')) { try { rel = path.relative(fs.realpathSync(dir), loc); } catch {} } files.add(rel.replace(/\\/g, '/')); break; }
    }
  }
  return [...files].filter((f) => !f.startsWith('..'));
}
// Detected from package.json (vitest | jest | node --test), overridable in .cinq/config.json:
//   { "test": { "runner": "vitest", "args": ["--exclude", "slow/**"] }, "install": "npm ci", "installScripts": false }
// The config is always read from main's committed copy (HEAD of the trunk workspace), never from the candidate.
function repoConfig(dir) {
  const r = git(dir, 'show', 'HEAD:.cinq/config.json');
  try { return r.ok ? JSON.parse(r.out) : {}; } catch { return {}; }
}
function detectRunner(dir, config = {}) {
  const cfg = config.test || {};
  if (cfg.runner) return cfg.runner;
  let pkg = {}; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vitest) return 'vitest';
  if (deps.jest) return 'jest';
  return 'node';
}
// Install dependencies in the sandbox. node_modules comes from a cache keyed by the hash of the lockfile,
// package.json and the install command, built by a fresh install from scratch whenever that hash changes.
// The sandbox gets a copy, so a test that tampers with node_modules changes nothing a later run sees.
// Install scripts are off (--ignore-scripts) unless main's .cinq/config.json says "installScripts": true.
function installCommand(lock, cfg) {
  if (cfg.install) return ['sh', '-c', cfg.install];
  const off = cfg.installScripts === true ? [] : ['--ignore-scripts'];
  return lock === 'yarn.lock' ? ['corepack', 'yarn', 'install', '--frozen-lockfile', ...off]
    : lock === 'pnpm-lock.yaml' ? ['corepack', 'pnpm', 'install', '--frozen-lockfile', ...off]
    : lock ? ['npm', 'ci', '--no-audit', '--no-fund', ...off] : ['npm', 'install', '--no-audit', '--no-fund', ...off];
}
function ensureDeps(sbx, cfg = {}) {
  const dir = sbx.dir;
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true }); // never trust a committed node_modules
  if (!fs.existsSync(path.join(dir, 'package.json'))) return { skipped: true };
  let pkg = {}; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
  if (!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length && !cfg.install) return { skipped: true, reason: 'no dependencies' };
  const lock = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'].find((f) => fs.existsSync(path.join(dir, f)));
  const cmd = installCommand(lock, cfg);
  const h = crypto.createHash('sha256').update(JSON.stringify(cmd)).update('\0').update(fs.readFileSync(path.join(dir, 'package.json')));
  if (lock) h.update('\0').update(fs.readFileSync(path.join(dir, lock)));
  const hash = h.digest('hex').slice(0, 24);
  const cache = path.join(WORK, 'deps', hash);
  const scripts = cfg.install ? 'custom' : cfg.installScripts === true ? 'on' : 'off';
  if (fs.existsSync(path.join(cache, 'node_modules'))) {
    fs.cpSync(path.join(cache, 'node_modules'), path.join(dir, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    ownSandbox(sbx);
    return { cached: true, hash, scripts };
  }
  const r = sbxRun(sbx, cmd[0], cmd.slice(1), 900000);
  if (r.ok && fs.existsSync(path.join(dir, 'node_modules'))) {
    const tmp = `${cache}.tmp-${crypto.randomBytes(3).toString('hex')}`;
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    fs.cpSync(path.join(dir, 'node_modules'), path.join(tmp, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    fs.rmSync(cache, { recursive: true, force: true }); fs.renameSync(tmp, cache);
  }
  return { installed: r.ok, hash, scripts, cmd: cmd.join(' '), detail: r.ok ? undefined : r.out.slice(-600) };
}
// vitest and jest both write a jest-style JSON report: per-file status + exact counts.
function runJsonRunner(sbx, runner, files, cfg = {}) {
  const dir = sbx.dir;
  const out = path.join(sbx.root, `report-${crypto.randomBytes(4).toString('hex')}.json`);
  const extra = (cfg.test || {}).args || [];
  const args = runner === 'vitest' ? ['vitest', 'run', '--reporter=json', `--outputFile=${out}`, ...extra, ...(files || [])]
    : ['jest', '--json', `--outputFile=${out}`, '--ci', ...extra, ...(files || [])];
  const r = sbxRun(sbx, 'npx', ['--no-install', ...args], 900000);
  let rep = null; try { rep = JSON.parse(fs.readFileSync(out, 'utf8')); fs.rmSync(out, { force: true }); } catch {}
  if (!rep) return { ok: false, count: 0, failingFiles: [], tail: r.out.slice(-800) };
  const count = rep.numTotalTests || 0;
  const failingFiles = (rep.testResults || []).filter((t) => t.status === 'failed').map((t) => path.relative(dir, t.name).replace(/\\/g, '/'));
  const failures = (rep.testResults || []).flatMap((t) => (t.assertionResults || []).filter((a) => a.status === 'failed')
    .map((a) => ({ file: path.relative(dir, t.name).replace(/\\/g, '/'), test: a.fullName || a.title, message: String((a.failureMessages || [])[0] || '').split('\n')[0].slice(0, 300) }))).slice(0, 8);
  return { ok: r.ok && count > 0 && rep.numFailedTests === 0 && !failingFiles.length, count, failingFiles, failures, tail: r.out.slice(-800) };
}
// The failing test's name and what it expected vs got, e.g. "expected 26.59, got 25.01".
function tapFailures(out) {
  const rows = out.split('\n'); const res = [];
  for (let i = 0; i < rows.length && res.length < 8; i++) {
    const m = rows[i].match(/^\s*not ok \d+ - (.+)$/); if (!m) continue;
    let expected, actual, error;
    for (let j = i + 1; j < Math.min(rows.length, i + 40) && !/^\s*(not )?ok \d+/.test(rows[j]); j++) {
      const e = rows[j].match(/^\s*expected: (.+)$/); if (e) expected = e[1];
      const a = rows[j].match(/^\s*actual: (.+)$/); if (a) actual = a[1];
      const er = rows[j].match(/^\s*error: (.+)$/); if (er) error = er[1].replace(/^['|>-]\s*/, '');
    }
    if (expected === undefined && actual === undefined && /^'?test failed'?$|subtestsFailed/.test(error || '')) continue; // file-level wrapper
    res.push({ test: m[1], expected, actual, message: (error || '').slice(0, 300) });
  }
  return res;
}
function runTests(sbx, files, cfg = {}) {
  const dir = sbx.dir;
  const runner = detectRunner(dir, cfg);
  if (runner === 'vitest' || runner === 'jest') return runJsonRunner(sbx, runner, files, cfg);
  const r = sbxRun(sbx, process.execPath, ['--test', '--test-reporter=tap', ...(files || [])]);
  const count = +((r.out.match(/^# tests (\d+)/m) || [0, 0])[1]);
  const ok = r.ok && count > 0;
  let failingFiles = [];
  if (!ok && count > 0 && !files) {
    failingFiles = failingFromTap(dir, r.out);
    if (!failingFiles.length) failingFiles = testFiles(dir).filter((f) => !sbxRun(sbx, process.execPath, ['--test', '--test-reporter=tap', f]).ok);
  }
  return { ok, count, failingFiles, failures: ok ? [] : tapFailures(r.out), tail: r.out.slice(-800) };
}

// The diff a reviewer (and a rebuilder) reads: the code first, lockfiles summarised, the job's registered tests as the
// lander will write them, and an explicit marker if anything was cut. A silently truncated diff could hide code.
const DIFF_CAP = 40000;
function reviewDiff(dir, mb, changed, intent) {
  const code = changed.filter((p) => !LOCKFILES.test(p)); const locks = changed.filter((p) => LOCKFILES.test(p));
  let d = code.length ? git(dir, 'diff', '--text', mb, 'refs/candidate', '--', ...code).out : '';
  for (const [p, c] of Object.entries(intent.tests || {})) d += `\n### registered test, written by the lander: ${p}\n${c}\n`;
  if (locks.length) d += `\n### lockfiles changed (not shown): ${locks.join(', ')}\n`;
  if (d.length > DIFF_CAP) d = d.slice(0, DIFF_CAP) + `\n### TRUNCATED: ${d.length - DIFF_CAP} more characters not shown; do not pass a change you could not read in full\n`;
  return d;
}

async function land(b) {
  const T = timer();
  const intent = b.intent || {};
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(intent.id || ''))) return { verdict: 'rejected', reason: `bad intent id: ${intent.id}`, gates: {} };
  const bad = [...Object.keys(intent.tests || {}), ...Object.keys(intent.hidden || {})].filter((p) => { try { inside('/x', p); return false; } catch { return true; } });
  if (bad.length) return { verdict: 'rejected', reason: `unsafe test paths: ${bad.join(', ')}`, gates: {} };
  const allowed = new Set(intent.allowed || []);
  const own = new Set([...(intent.ownTests || []), ...Object.keys(intent.hidden || {}), `.cinq/intents/${intent.id}.md`]);
  const owners = b.testOwners || {}; // test file → landed intent id
  const dir = trunkWorkspace(b.trunk); T.mark('workspace');
  const before = git(dir, 'rev-parse', 'HEAD').out.trim();

  const f = gitAuth(dir, b.candidate, 'fetch', '-q', '<remote>', `+${b.candidateRef || 'main'}:refs/candidate`); T.mark('fetch');
  if (!f.ok) return { verdict: 'error', stage: 'fetch-candidate', detail: f.out.slice(0, 300), ms: T.marks };
  // Idempotent landing: if this candidate is already in trunk (landed, but the reply was lost), say so.
  // Exact id match ("land <id> (" or "land <id> + ..."), never a prefix of another intent's id.
  const landedThis = b.intent?.id && lines(git(dir, 'log', '--format=%s').out).some((s) => s.startsWith(`land ${b.intent.id} `));
  if (landedThis && git(dir, 'merge-base', '--is-ancestor', 'refs/candidate', 'HEAD').ok && git(dir, 'rev-parse', 'refs/candidate').out.trim() !== git(dir, 'rev-parse', 'HEAD').out.trim()) {
    return { verdict: 'landed', after: before.slice(0, 7), already: true, gates: {}, testsRun: null, ms: T.marks };
  }
  const mb = git(dir, 'merge-base', 'HEAD', 'refs/candidate').out.trim();
  const touched = lines(git(dir, 'diff', '--name-only', mb, 'refs/candidate').out);
  const changed = touched.filter((p) => !own.has(p));
  const trunkFiles = new Set(lines(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').out));
  // The lander writes the job's tests itself, so they must not replace a test already on main: only an approved test
  // change may (approvedSupersedes), or the same bytes. A hidden test never may: it would also be committed to main.
  const approvedTests = new Set(intent.approvedSupersedes || []);
  const overwrites = [...Object.keys(intent.hidden || {}).filter((p) => trunkFiles.has(p)),
    ...Object.keys(intent.tests || {}).filter((p) => trunkFiles.has(p) && !approvedTests.has(p) && git(dir, 'show', `HEAD:${p}`).out !== intent.tests[p])];
  if (overwrites.length) return { verdict: 'parked', park: { gate: 'testsProtected', reason: `its tests would replace tests already on main: ${overwrites.join(', ')}` }, gates: { testsProtected: false }, ms: T.marks };

  const cfg = repoConfig(dir); // main's config, never the candidate's
  const gates = {
    noop: changed.length > 0,
    footprint: changed.every((p) => allowed.has(p)),
    // an existing test changes only through an approved test change, which the lander writes itself (intent.tests);
    // listing it in allowed is not enough
    testsProtected: !changed.some((p) => isTest(p) && trunkFiles.has(p) && !(p in (intent.tests || {}))),
    protectedDirs: !touched.some((p) => PROTECTED.some((d) => p.startsWith(d)) && !own.has(p)),
  };
  // The candidate's own diff (capped) travels back so a re-derivation (and the reviewer) knows what was attempted.
  const diff = reviewDiff(dir, mb, changed, intent);
  const candidateSha = git(dir, 'rev-parse', 'refs/candidate').out.trim();
  const base = { before: before.slice(0, 7), changed, gates, diff, candidateSha, ms: T.marks };
  if (b.expectSha && b.expectSha !== candidateSha) { gates.reviewedCommit = false; return { verdict: 'rejected', reason: `the fork changed after review (reviewed ${b.expectSha.slice(0, 7)}, got ${candidateSha.slice(0, 7)})`, ...base }; }
  if (b.expectSha) gates.reviewedCommit = true;
  if (!gates.noop) return { verdict: 'noop', ...base };
  if (!gates.footprint || !gates.testsProtected || !gates.protectedDirs) return { verdict: 'rejected', ...base };

  // Security gates: deterministic, before any candidate code runs. Refusals are rebuilt; parks wait for a person.
  // every commit the landing brings into main's history (the candidate is its second parent), not just the net diff:
  // a secret added in one commit and removed in the next still lands in history
  const fullDiff = git(dir, 'log', '-p', '--text', '-U0', '--format=', '--diff-merges=separate', `${mb}..refs/candidate`).out; // merge commits too, against each parent
  // (the registered and hidden tests the lander writes itself were scanned when they were handed in: check())
  const secrets = cfg.secrets === 'off' ? [] : scanSecrets(fullDiff);
  const deps = depChanges(dir, mb, touched);
  const declared = new Set(intent.deps || []);
  const undeclared = deps.names.filter((n) => !declared.has(n));
  const depsChanged = deps.names.length > 0 || deps.lockfiles.length > 0;
  const protectedGlobs = Array.isArray(cfg.protectedPaths) ? cfg.protectedPaths : DEFAULT_PROTECTED_PATHS;
  const protectedHit = touched.filter((p) => !own.has(p) && (matchesAny(p, protectedGlobs) || GUIDE.test(p)));
  const budget = cfg.diffBudget === false || cfg.diffBudget === 0 ? Infinity : +cfg.diffBudget || DEFAULT_DIFF_BUDGET;
  const counted = changed.filter((p) => !LOCKFILES.test(p));
  const diffLines = counted.length ? lines(git(dir, 'diff', '--numstat', mb, 'refs/candidate', '--', ...counted).out).reduce((n, l) => { const [a, d] = l.split('\t'); return n + (+a || 0) + (+d || 0); }, 0) : 0;
  Object.assign(gates, {
    secrets: !secrets.length,
    deps: !(depsChanged && (!declared.size || undeclared.length)) && !deps.newWithInstallScripts.length,
    protectedPaths: !protectedHit.length,
    diffBudget: diffLines <= budget,
  });
  const security = { secrets, deps: { added: deps.added, removed: deps.removed, changed: deps.changed, lockfiles: deps.lockfiles, declared: [...declared], undeclared: depsChanged && !declared.size ? (deps.names.length ? deps.names : deps.lockfiles) : undeclared, newWithInstallScripts: deps.newWithInstallScripts },
    protectedPaths: protectedHit, diffLines, diffBudget: budget === Infinity ? null : budget };
  base.security = security;
  if (!gates.secrets) return { verdict: 'rejected', reason: `possible secret on an added line: ${secrets.map((f) => `${f.file}:${f.line} (${f.rule})`).join(', ')}`, ...base };
  if (depsChanged && (!declared.size || undeclared.length)) return { verdict: 'rejected', reason: `undeclared dependency change: ${security.deps.undeclared.join(', ')}; declare it on the job (deps)`, ...base };
  // a person may wave a parked gate through, for this exact commit only; a protected-path approval also holds for a
  // rebuild whose protected files are byte-for-byte the ones the person approved (the digest of their contents)
  const protectedDigest = protectedHit.length ? crypto.createHash('sha256').update(protectedHit.slice().sort().map((p) => `${p}:${git(dir, 'rev-parse', `refs/candidate:${p}`).out.trim() || 'deleted'}`).join('\n')).digest('hex') : null;
  const waved = (gate) => (b.allowParks || []).some((a) => a.gate === gate && (a.sha === candidateSha || (gate === 'protectedPaths' && a.digest && a.digest === protectedDigest)));
  if (deps.newWithInstallScripts.length && !waved('deps')) return { verdict: 'parked', park: { gate: 'deps', reason: `new package with install scripts: ${deps.newWithInstallScripts.join(', ')}` }, ...base };
  if (protectedHit.length && !waved('protectedPaths')) return { verdict: 'parked', park: { gate: 'protectedPaths', reason: `touches protected paths: ${protectedHit.join(', ')}`, digest: protectedDigest }, ...base };
  if (!gates.diffBudget && !waved('diffBudget')) return { verdict: 'parked', park: { gate: 'diffBudget', reason: `split this job: ${diffLines} changed lines, over the budget of ${budget}` }, ...base };

  const m = git(dir, 'merge', '--no-ff', '--no-commit', 'refs/candidate'); T.mark('merge');
  if (!m.ok && /CONFLICT|Automatic merge failed/.test(m.out)) { git(dir, 'merge', '--abort'); return { verdict: 'conflict', ...base }; }
  if (!m.ok && !/Already up to date/.test(m.out)) { git(dir, 'merge', '--abort'); return { verdict: 'error', stage: 'merge', detail: m.out.slice(0, 300), ...base }; }
  gates.merge = true;

  // Trunk's tests always come from trunk's own copy, whatever the candidate did to them.
  const trunkTests = [...trunkFiles].filter((p) => isTest(p) && !(p in (intent.tests || {})) && !own.has(p));
  if (trunkTests.length) git(dir, 'checkout', 'HEAD', '--', ...trunkTests);
  // The tests the agent REGISTERED (and hidden tests) are written by the platform from its own copy:
  // the candidate cannot omit, weaken or swap them. Whatever the fork contains at those paths is ignored.
  for (const [p, content] of Object.entries({ ...(intent.tests || {}), ...(intent.hidden || {}) })) { const f = inside(dir, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); }

  // What will be committed is fixed NOW, before any agent code runs: the merge result with the platform's own test
  // files. The landing commit is built from this tree (plus the receipt), never from whatever is on disk afterwards,
  // and the workspace's git config must be unchanged, so nothing the tests do to the workspace can reach main.
  git(dir, 'add', '-A');
  const tree = git(dir, 'write-tree').out.trim();
  const gitState = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, '.git', 'config'))).update(fs.existsSync(path.join(dir, '.git', 'hooks')) ? fs.readdirSync(path.join(dir, '.git', 'hooks')).join('\0') : '').digest('hex');
  const gitBefore = gitState();

  // Flake policy: every failure gets exactly one re-run before it counts.
  //   files that failed on their own are re-run once more; a pass then = flaky, not red.
  //   if nothing failed on its own, the whole suite is re-run once.
  // Agent-controlled code (install scripts, tests, the candidate) runs only in a throwaway copy.
  // A reviewed change whose merged tree is byte-identical to the one tested before review (same main, same
  // commit, same platform-written tests) gives the same result: reuse it instead of running the suite again.
  const reuse = b.reuse && b.reuse.tree === tree && b.reuse.testsRun > 0 ? b.reuse : null;
  let t; const flaky = []; let inst; let runner;
  if (reuse) { t = { ok: true, count: reuse.testsRun, failingFiles: [] }; flaky.push(...(reuse.flaky || [])); inst = reuse.install || {}; runner = reuse.runner; T.mark('reused'); }
  else {
  const sbx = sandbox(dir); T.mark('sandbox');
  runner = detectRunner(sbx.dir, cfg);
  try {
    inst = ensureDeps(sbx, cfg); T.mark('deps');
    if (inst.installed === false) { git(dir, 'merge', '--abort'); git(dir, 'reset', '-q', '--hard', 'HEAD'); return { verdict: 'error', stage: 'install', detail: inst.detail, ...base }; } // infrastructure, never the change's fault
    t = runTests(sbx, undefined, cfg); T.mark('tests');
    if (!t.ok && t.count > 0) {
      if (t.failingFiles.length) {
        const still = [];
        for (const file of t.failingFiles) (runTests(sbx, [file], cfg).ok ? flaky : still).push(file);
        t = still.length ? { ...t, failingFiles: still } : { ...t, ok: true, failingFiles: [] };
      } else {
        const again = runTests(sbx, undefined, cfg);
        if (again.ok) { flaky.push('(whole suite: failed once, passed on re-run)'); t = { ...again, failingFiles: [] }; }
      }
      T.mark('rerun');
    }
  } finally { sbx.done(); }
  }
  gates.tests = t.ok;
  // Nothing may have moved main while agent code ran. If it did, something pushed behind the lander's back.
  const remoteHead = (lines(gitAuth(dir, b.trunk, 'ls-remote', '<remote>', 'refs/heads/main').out)[0] || '').split(/\s+/)[0];
  gates.trunkIntact = (!remoteHead || remoteHead === before) && gitState() === gitBefore;
  const result = { ...base, gates, runner, tree, testsRun: t.count, failing: t.failingFiles, flaky, install: { scripts: inst.scripts || 'off', cached: !!inst.cached }, ...(reuse ? { testsReused: true } : {}) };
  if (!gates.trunkIntact) { git(dir, 'merge', '--abort'); git(dir, 'reset', '-q', '--hard', 'HEAD'); return { verdict: 'rejected', stage: 'trunk-integrity', detail: remoteHead && remoteHead !== before ? `main moved from ${before.slice(0, 7)} to ${remoteHead.slice(0, 7)} while this candidate's code ran` : "the lander's own git config changed while this candidate's code ran", ...result }; }

  if (!t.ok) {
    const foreign = t.failingFiles.filter((p) => owners[p] && owners[p] !== intent.id && !own.has(p));
    const dependents = t.count > 0 && foreign.length && foreign.length === t.failingFiles.length ? [...new Set(foreign.map((p) => owners[p]))] : [];
    git(dir, 'merge', '--abort'); git(dir, 'reset', '-q', '--hard', 'HEAD');
    return { verdict: dependents.length ? 'breaks-dependents' : 'red', dependents, failures: t.failures, testTail: t.tail, ...result };
  }
  const reviewMode = ['block', 'advisory', 'off'].includes(cfg.review) ? cfg.review : 'block';
  if (b.requireReview && reviewMode !== 'off' && !b.review) { git(dir, 'merge', '--abort'); git(dir, 'reset', '-q', '--hard', 'HEAD'); return { verdict: 'needs-review', reviewMode, ...result }; }
  if (b.push === false) { git(dir, 'merge', '--abort'); git(dir, 'reset', '-q', '--hard', 'HEAD'); return { verdict: 'green', ...result }; }

  // Provenance travels with the code: intent + receipt in the landing commit, added to the tree fixed above.
  // The examiner's hidden tests gated this landing; they are not committed (no test bloat on main). The receipt
  // records how many ran and a hash of their content, so the check stays auditable; the platform keeps the copy.
  const hiddenPaths = Object.keys(intent.hidden || {});
  const hidden = hiddenPaths.length ? { files: hiddenPaths.length, passed: true, sha256: crypto.createHash('sha256').update(hiddenPaths.sort().map((p) => p + '\0' + intent.hidden[p]).join('\0')).digest('hex').slice(0, 16) } : null;
  const receiptJson = JSON.stringify({ ...(b.receipt || {}), gates, testsRun: t.count, ...(reuse ? { testsRunBeforeReview: true } : {}), hiddenTests: hidden, flaky: flaky.map((f) => (hiddenPaths.includes(f) ? '(hidden test)' : f)), security, install: result.install }, null, 2) + '\n';
  const idx = path.join(dir, '.git', `land-index-${crypto.randomBytes(4).toString('hex')}`);
  const gi = (...a) => run(dir, 'git', [...GIT_BASE, ...a], 300000, { ...ENV, GIT_INDEX_FILE: idx });
  const blob = (content) => { const f = path.join(dir, '.git', `land-blob-${crypto.randomBytes(4).toString('hex')}`); fs.writeFileSync(f, content); const h = git(dir, 'hash-object', '-w', f).out.trim(); fs.rmSync(f, { force: true }); return h; };
  // Signed by Cinq: with the deployment's signing key the landing commit carries an SSH signature, and main lists the
  // public key in .cinq/allowed_signers so `git log --show-signature` verifies it. The key is on disk only for this
  // one command, in a root-only folder, after every agent process has been stopped.
  let commit; let keyDir = null; const sign = [];
  if (b.signingKey) {
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-')); try { fs.chmodSync(keyDir, 0o700); } catch {}
    const kf = path.join(keyDir, 'key'); fs.writeFileSync(kf, String(b.signingKey).replace(/\r/g, '').trim() + '\n', { mode: 0o600 });
    sign.push('-c', 'gpg.format=ssh', '-c', `user.signingkey=${kf}`);
  }
  try {
    gi('read-tree', tree);
    if (b.signingPublic) gi('update-index', '--add', '--cacheinfo', `100644,${blob(`lander@cinq.local namespaces="git" ${String(b.signingPublic).trim()}\n`)},.cinq/allowed_signers`);
    for (const p of hiddenPaths) if (!trunkFiles.has(p)) gi('update-index', '--force-remove', p);
    if (b.intentDoc) gi('update-index', '--add', '--cacheinfo', `100644,${blob(b.intentDoc)},.cinq/intents/${intent.id}.md`);
    gi('update-index', '--add', '--cacheinfo', `100644,${blob(receiptJson)},.cinq/receipts/${intent.id}.json`);
    if (b.rulesDoc) gi('update-index', '--add', '--cacheinfo', `100644,${blob(b.rulesDoc)},.cinq/rules.md`); // the house rules this landing was held to
    const landTree = gi('write-tree').out.trim();
    const c = run(dir, 'git', [...GIT_BASE, ...sign, 'commit-tree', landTree, ...(sign.length ? ['-S'] : []), '-p', before, '-p', candidateSha, '-m', b.message || `land ${intent.id}`]);
    commit = c.out.trim();
    if (sign.length && !c.ok) { git(dir, 'merge', '--abort'); git(dir, 'reset', '-q', '--hard', 'HEAD'); return { verdict: 'error', stage: 'sign', detail: c.out.slice(0, 300), ...result }; } // never land unsigned once signing is on
  } finally { fs.rmSync(idx, { force: true }); if (keyDir) fs.rmSync(keyDir, { recursive: true, force: true }); }
  git(dir, 'merge', '--abort'); git(dir, 'reset', '-q', '--hard', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(commit || '')) return { verdict: 'error', stage: 'commit', detail: 'could not build the landing commit', ...result };
  const p = gitAuth(dir, b.trunk, 'push', '-q', '<remote>', `${commit}:refs/heads/main`); T.mark('push'); // the token exists only in this process's env
  if (!p.ok) { git(dir, 'reset', '-q', '--hard', 'refs/remotes/origin/main'); return { verdict: /non-fast-forward|rejected|fetch first/.test(p.out) ? 'trunk-moved' : 'error', stage: 'push', detail: p.out.slice(0, 300), ...result }; }
  git(dir, 'reset', '-q', '--hard', commit);
  return { verdict: 'landed', after: commit.slice(0, 7), ...result };
}

const ops = {
  async env() { return { version: process.env.LANDER_VERSION || null, git: run('/', 'git', ['--version']).out.trim(), node: process.version, cpus: os.cpus().length }; },
  async seed({ remote, files }) { // trusted: platform-written files only
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
    git(d, 'init', '-q', '-b', 'main');
    for (const [p, c] of Object.entries(files)) { const f = within(d, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); }
    git(d, 'add', '-A'); git(d, 'commit', '-qm', 'seed');
    const r = gitAuth(d, remote, 'push', '-q', '<remote>', 'main');
    fs.rmSync(d, { recursive: true, force: true });
    return { pushed: r.ok, detail: r.ok ? undefined : r.out.slice(0, 300) };
  },
  // Validity: an intent's new tests must FAIL on current trunk, or they prove nothing (vacuous).
  // `supersedes` = proposed new contents of EXISTING tests: we record their current content (for the
  // independent reviewer) and refuse paths that aren't existing tests on trunk.
  async check({ trunk, tests = {}, supersedes = {}, fresh = false }) {
    const dir = trunkWorkspace(trunk);
    const before = {}; const missing = [];
    // tests handed in (fresh) go in new files: an existing test changes only through supersedes
    const exists = fresh ? Object.keys(tests).filter((p) => git(dir, 'cat-file', '-e', `HEAD:${p}`).ok) : [];
    if (exists.length) return { exists, failsOnTrunk: false };
    for (const p of Object.keys(supersedes)) { const r = git(dir, 'show', `HEAD:${p}`); if (r.ok) before[p] = r.out.slice(0, 200000); else missing.push(p); }
    if (missing.length) return { missing, failsOnTrunk: false };
    const all = { ...tests, ...supersedes };
    const files = Object.keys(all);
    const cfg = repoConfig(dir);
    // tests the platform will write into main are scanned here, when they are handed in, so a match is the test
    // writer's to fix, never a rebuilder's (who can't change them) and never named later in a landing's failure
    if (cfg.secrets !== 'off') {
      const asDiff = Object.entries(all).map(([p, c]) => `diff --git a/${p} b/${p}\n+++ b/${p}\n@@ -0,0 +1 @@\n${String(c).split('\n').map((l) => '+' + l).join('\n')}`).join('\n');
      const secrets = scanSecrets(asDiff);
      if (secrets.length) return { secrets, failsOnTrunk: false };
    }
    const head = git(dir, 'rev-parse', '--short=7', 'HEAD').out.trim();
    const sbx = sandbox(dir); let r;
    try {
      for (const [p, c] of Object.entries(all)) { const f = inside(sbx.dir, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); }
      ownSandbox(sbx);
      const deps = ensureDeps(sbx, cfg);
      if (deps.installed === false) return { error: 'install failed', detail: deps.detail, failsOnTrunk: false };
      r = files.length ? runTests(sbx, files, cfg) : { ok: false, count: 0 };
    } finally { sbx.done(); }
    // zero tests run proves nothing either way (a cold start, a test file that did not load): never call that "already passes"
    return { head, testsRun: r.count, failsOnTrunk: !r.ok || !r.count, before };
  },
  // Contract change: put trunk + candidate on a throwaway staging fork, so dependents can be
  // re-derived on top of the new contract and land together with it.
  async stage({ trunk, candidate, target }) {
    const dir = trunkWorkspace(trunk);
    const f = gitAuth(dir, candidate, 'fetch', '-q', '<remote>', '+main:refs/candidate');
    if (!f.ok) return { staged: false, detail: f.out.slice(0, 300) };
    const m = git(dir, 'merge', '--no-ff', '-qm', 'stage contract change', 'refs/candidate');
    if (!m.ok) { git(dir, 'merge', '--abort'); return { staged: false, detail: 'merge failed' }; }
    const p = gitAuth(dir, target, 'push', '-q', '-f', '<remote>', 'HEAD:main'); // force only ever targets our own staging fork
    git(dir, 'reset', '-q', '--hard', 'refs/remotes/origin/main');
    return { staged: p.ok, detail: p.ok ? undefined : p.out.slice(0, 300) };
  },
  // Read-only browsing of trunk for the web home: file tree, a file, history, and per-line provenance.
  // Every landing commit is "land <intent>…", so blame maps each line to the intent that put it there.
  async browse({ trunk, kind, path: p }) {
    const dir = trunkWorkspace(trunk);
    if (typeof p === 'string' && p && (p.includes('..') || path.isAbsolute(p))) return { error: 'bad path' };
    if (kind === 'tree') {
      // last trunk commit per path (one log walk), for GitHub-style rows
      const last = {}; let cur = null;
      for (const l of git(dir, 'log', '--first-parent', '-m', '--name-only', '--format=\x1e%h\x1f%at\x1f%s').out.split('\n')) {
        if (l.startsWith('\x1e')) { const [sha, at, subject] = l.slice(1).split('\x1f'); cur = { sha, at: +at * 1000, subject, intent: (subject.match(/^land (\S+)/) || [])[1] || null }; }
        else if (l.trim() && cur && !last[l.trim()]) last[l.trim()] = cur;
      }
      const files = lines(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').out);
      return { head: git(dir, 'rev-parse', '--short=7', 'HEAD').out.trim(), files, last: Object.fromEntries(files.map((f) => [f, last[f] || null])) };
    }
    if (kind === 'file') { const r = git(dir, 'show', `HEAD:${p}`); return r.ok ? { path: p, content: r.out.slice(0, 400000) } : { error: 'not found' }; }
    // several files at once (an examiner's work order): what exists of them today, within a budget, plus the file list
    if (kind === 'files') {
      const out = {}; let budget = 120000;
      for (const f of (Array.isArray(p) ? p : []).slice(0, 40)) {
        if (typeof f !== 'string' || f.includes('..') || path.isAbsolute(f)) continue;
        const r = git(dir, 'show', `HEAD:${f}`); if (!r.ok) continue;
        const c = r.out.slice(0, Math.min(30000, budget)); budget -= c.length; out[f] = c; if (budget <= 0) break;
      }
      return { files: out, list: lines(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').out).slice(0, 2000) };
    }
    // a reviewer's context, read from main: the repo's own guideline files (nearest to the changed files first, like
    // Bugbot's nested rules) and the files that import the changed ones, so architecture fit is judged without exploring
    if (kind === 'context') {
      const changed = (Array.isArray(p) ? p : []).filter((f) => typeof f === 'string' && !f.includes('..') && !path.isAbsolute(f)).slice(0, 30);
      const all = lines(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').out);
      const dirs = new Set(changed.flatMap((f) => { const parts = f.split('/'); return parts.map((_, i) => parts.slice(0, i).join('/')); }));
      const guides = all.filter((f) => GUIDE.test(f) && (dirs.has(f.split('/').slice(0, -1).join('/')) || dirs.has(f.split('/').slice(0, -1).filter((x) => x !== '.cursor').join('/')) || /^docs\//.test(f)))
        .sort((a, b) => b.split('/').length - a.split('/').length).slice(0, 8);
      const stems = [...new Set(changed.filter((f) => /\.[cm]?[jt]sx?$/.test(f)).map((f) => path.basename(f).replace(/\.[cm]?[jt]sx?$/, '')))].filter((s) => s.length > 2 && s !== 'index');
      const users = new Set();
      for (const s of stems.slice(0, 10)) {
        const r = git(dir, 'grep', '-l', '-E', `(from|require\\().*['"][^'"]*/${s}(\\.[cm]?[jt]sx?)?['"]`, 'HEAD', '--');
        for (const l of lines(r.out)) { const f = l.replace(/^HEAD:/, ''); if (!changed.includes(f)) users.add(f); }
      }
      // Cinq's own agent instructions (the cinq:start block init adds) are not the repo's conventions
      const read = (list, budget) => { const o = {}; for (const f of list) { const r = git(dir, 'show', `HEAD:${f}`); if (!r.ok) continue; const c = r.out.replace(/<!-- cinq:start -->[\s\S]*?<!-- cinq:end -->\n?/, '').slice(0, Math.min(12000, budget)); budget -= c.length; o[f] = c; if (budget <= 0) break; } return o; };
      return { guidelines: read(guides, 30000), neighbours: read([...users].slice(0, 8), 40000) };
    }
    if (kind === 'log') {
      const out = git(dir, 'log', '--first-parent', '-n', '200', '--format=%h%x1f%an%x1f%at%x1f%s', ...(p ? ['--', p] : [])).out;
      return { commits: lines(out).map((l) => { const [sha, author, at, subject] = l.split('\x1f'); return { sha, author, at: +at * 1000, subject, intent: (subject.match(/^land (\S+)/) || [])[1] || null }; }) };
    }
    if (kind === 'blame') {
      const r = git(dir, 'blame', '--line-porcelain', 'HEAD', '--', p);
      if (!r.ok) return { error: 'not found' };
      // Attribute each line to the landing (merge) commit that brought it into trunk's first-parent history.
      // trunk's own history, oldest first; a line belongs to the first trunk commit that contains it
      const landings = lines(git(dir, 'log', '--first-parent', '--reverse', '--format=%H%x1f%s').out).map((l) => l.split('\x1f'));
      const landingOf = (sha) => landings.find(([h]) => h === sha || git(dir, 'merge-base', '--is-ancestor', sha, h).ok) || [sha, ''];
      const cache = {}; const out = []; let cur = null;
      for (const line of r.out.split('\n')) {
        const head = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
        if (head) { cur = { sha: head[1], line: +head[2] }; continue; }
        if (cur && line.startsWith('summary ')) cur.summary = line.slice(8);
        if (cur && line.startsWith('\t')) {
          const L = cache[cur.sha] || (cache[cur.sha] = landingOf(cur.sha));
          out.push({ n: cur.line, text: line.slice(1), commit: cur.sha.slice(0, 7), landedIn: L[0].slice(0, 7), intent: (L[1].match(/^land (\S+)/) || [])[1] || null });
          cur = null;
        }
      }
      return { path: p, lines: out };
    }
    return { error: 'unknown kind' };
  },
  // Test/dev only: play an agent on its own fork (clone, write/delete files, commit, push).
  async apply({ remote, writes = {}, deletes = [], message }) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'));
    const c = gitAuth(os.tmpdir(), remote, 'clone', '-q', '<remote>', d);
    if (!c.ok) return { pushed: false, detail: c.out.slice(0, 300) };
    for (const [p, content] of Object.entries(writes)) { const f = within(d, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); }
    for (const p of deletes) fs.rmSync(within(d, p), { force: true });
    git(d, 'add', '-A'); git(d, 'commit', '-qm', message || 'agent work');
    const r = gitAuth(d, remote, 'push', '-q', '<remote>', 'HEAD:main');
    fs.rmSync(d, { recursive: true, force: true });
    return { pushed: r.ok, detail: r.ok ? undefined : r.out.slice(0, 300) };
  },
  land,
};

// One landing at a time per process: the lander is trunk's single writer.
let chain = Promise.resolve();
async function handle(op, body) {
  if (!ops[op]) throw new Error('unknown op ' + op);
  const job = chain.then(() => ops[op](body || {}));
  chain = job.catch(() => {});
  return job;
}

function listen(port) {
  return http.createServer(async (req, res) => {
    if (req.url === '/ping') return res.end('ok');
    let body = ''; for await (const c of req) body += c;
    try {
      const out = await handle(req.url.slice(1), body ? JSON.parse(body) : {});
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ verdict: 'error', error: mask(e.message), detail: e.detail })); }
  }).listen(port);
}

if (typeof module !== 'undefined' && module.exports) module.exports = { handle, land, scanSecrets };
// The lander runs as PID 1 in its container, where Linux applies no default signal handling: without these,
// SIGTERM is ignored and the container keeps running (and billing) after a stop.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
if (process.env.LANDER_NO_LISTEN !== '1') listen(+process.env.PORT || 8080);
