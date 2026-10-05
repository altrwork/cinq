// Shared helpers for the backtest (select / run / oracle). Node >= 20, no dependencies.
// Login: the owner key comes from the cinq login (~/.cinq/config.json) at runtime and is kept in memory.
// Nothing here writes a secret to disk, except the per-session MCP config that an agent needs to
// connect (an agent key, never the owner key). It goes to an OS temp dir and is deleted afterwards.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..'); // the repo root
// the deployment to run against: GL_URL, else the cinq login (npx cinq-git deploy)
export const DEPLOYMENT = process.env.GL_URL || (() => { try { return JSON.parse(readFileSync(join(homedir(), '.cinq', 'config.json'), 'utf8')).url; } catch { return ''; } })();
export const GL = join(ROOT, 'app', 'cli', 'cinq.mjs');
export const MCP_NAME = 'cinq'; // must match the MCP server name cinq init registers

export const argv = process.argv.slice(2);
export const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
export const has = (k) => argv.includes(`--${k}`);
export const log = (...a) => console.log(...a);
export const die = (s) => { console.error(`✖ ${s}`); process.exit(1); };
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const mask = (s) => String(s).replace(/x:[^@\s]+@/g, 'x:***@').replace(/(glk|glo|art_v\d)_[A-Za-z0-9_]+/g, '$1_***').replace(/Bearer [^\s"']+/g, 'Bearer ***');

export const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '' };
export function sh(cwd, cmd, args, { env = GIT_ENV, timeout = 0, input } = {}) {
  try { return { ok: true, out: execFileSync(cmd, args, { cwd, env, encoding: 'utf8', timeout, input, maxBuffer: 256 * 1024 * 1024, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
}
export const git = (cwd, ...a) => sh(cwd, 'git', ['-c', 'user.name=backtest', '-c', 'user.email=backtest@cinq.local', ...a]);
export function mustGit(cwd, ...a) { const r = git(cwd, ...a); if (!r.ok) die(`git ${a.join(' ')}: ${mask(r.out).slice(0, 800)}`); return r.out.trim(); }

// ---------------------------------------------------------------- login and product API
const LOGIN_FILE = join(homedir(), '.cinq', 'config.json');
let LOGIN = null;
const login = () => (LOGIN ??= existsSync(LOGIN_FILE) ? JSON.parse(readFileSync(LOGIN_FILE, 'utf8')) : die('not logged in: run  npx cinq-git deploy  (or  cinq login --url <deployment> --owner-key <key>)'));
export const ownerKey = () => login().ownerKey;
/** The CLI and the backtest must talk to the same deployment. */
export function checkGlLogin() {
  const c = login();
  if (c.url?.replace(/\/$/, '') !== DEPLOYMENT) return { ok: false, why: `cinq is logged in to ${c.url}, not ${DEPLOYMENT}` };
  return { ok: true };
}
export async function api(path, { body, key } = {}) {
  const r = await fetch(`${DEPLOYMENT}/api/v1/${path}`, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${key || ownerKey()}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(`${path}: ${j.error}`);
  return j;
}
/** All events since seq 0, paged (the API returns at most 500 per call). */
export async function allEvents(repo) {
  const out = []; let since = 0;
  for (;;) { const { events } = await api(`repos/${encodeURIComponent(repo)}/events?since=${since}`); if (!events.length) break; out.push(...events); since = events.at(-1).seq; if (events.length < 500) break; }
  return out;
}

// ---------------------------------------------------------------- GitHub REST (unauthenticated by default)
// Unauthenticated: 60 requests/hour, search 10/minute. Every response is cached under backtest/cache/
// so re-running select.mjs costs nothing. --gh-token reads `gh auth token` at runtime (kept in memory).
let GH_TOKEN = process.env.GITHUB_TOKEN || null;
export function useGhCliToken() { const r = sh(process.cwd(), 'gh', ['auth', 'token']); if (r.ok) GH_TOKEN = r.out.trim(); else die('gh auth token failed'); }
export async function gh(path, { cache = true } = {}) {
  const cdir = join(HERE, 'cache'); mkdirSync(cdir, { recursive: true });
  const cfile = join(cdir, sha256(path).slice(0, 24) + '.json');
  if (cache && existsSync(cfile)) return JSON.parse(readFileSync(cfile, 'utf8'));
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`https://api.github.com${path}`, { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
      'user-agent': 'cinq-backtest', ...(GH_TOKEN ? { authorization: `Bearer ${GH_TOKEN}` } : {}) } });
    const left = +r.headers.get('x-ratelimit-remaining'); const reset = +r.headers.get('x-ratelimit-reset') * 1000;
    if ((r.status === 403 || r.status === 429) && left === 0) {
      const wait = Math.max(0, reset - Date.now()) + 1000;
      if (wait > 10 * 60_000 || attempt > 2) die(`GitHub rate limit exhausted (resets ${new Date(reset).toLocaleTimeString()}). Re-run later (cached calls are free) or pass --gh-token.`);
      log(`  … GitHub rate limit; waiting ${Math.round(wait / 1000)} s`); await sleep(wait); continue;
    }
    if (!r.ok) throw new Error(`GitHub ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (cache) writeFileSync(cfile, JSON.stringify(j));
    if (left && left < 5) log(`  ! only ${left} GitHub requests left this hour`);
    return j;
  }
}

// ---------------------------------------------------------------- tests on a checkout (oracle side)
export const TEST_RE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
export function isTestPath(p) { return TEST_RE.test(p); }

/** Run tests in `dir` with the manifest's local runner config. ASSUMPTION (same as the product lander,
 *  app/worker/src/lander/server.cjs): vitest/jest give a jest-style JSON report; node --test gives TAP.
 *  Returns per-test pass/fail counts and failing files. */
// npm/npx run as `node <npm-cli.js>`: avoids Windows .cmd shims and works with a Node binary that ships without npm.
const hostNpmDir = () => join(dirname(process.execPath), 'node_modules', 'npm', 'bin');
export const npmCli = (local) => local.npmCli || join(hostNpmDir(), 'npm-cli.js');
export const npxCli = (local) => local.npxCli || join(hostNpmDir(), 'npx-cli.js');
export function runSuite(dir, local, files = null, nodeBin = process.execPath) {
  const runner = local.test.runner;
  if (runner === 'vitest' || runner === 'jest') {
    const out = join(dir, `.bt-report-${Date.now()}.json`);
    const args = runner === 'vitest' ? ['vitest', 'run', '--reporter=json', `--outputFile=${out}`, ...(local.test.args || []), ...(files || [])]
      : ['jest', '--json', `--outputFile=${out}`, '--ci', ...(local.test.args || []), ...(files || [])];
    const r = sh(dir, nodeBin, [npxCli(local), '--no-install', ...args], { env: { ...process.env, ...(local.install?.env || {}) }, timeout: 30 * 60_000 });
    let rep = null; try { rep = JSON.parse(readFileSync(out, 'utf8')); } catch {}
    rmSync(out, { force: true });
    if (!rep) return { ok: false, total: 0, passed: 0, failed: 0, failingFiles: [], perTest: [], tail: r.out.slice(-1500) };
    const perTest = (rep.testResults || []).flatMap((f) => (f.assertionResults || []).map((a) => ({ file: f.name.replace(/\\/g, '/'), name: a.fullName || a.title, title: a.title, status: a.status })));
    const failingFiles = (rep.testResults || []).filter((t) => t.status === 'failed').map((t) => t.name.replace(/\\/g, '/'));
    return { ok: rep.numFailedTests === 0 && rep.numTotalTests > 0 && !failingFiles.length, total: rep.numTotalTests, passed: rep.numPassedTests,
      failed: rep.numFailedTests, failingFiles, perTest, tail: r.out.slice(-800) };
  }
  // node --test (TAP). ASSUMPTION: the repo's tests are discoverable by node --test's default patterns,
  // or `files` lists them. Excludes are not supported by node --test (fastify needs test/build/** excluded).
  const r = sh(dir, nodeBin, ['--test', '--test-reporter=tap', ...(files || [])], { env: (() => { const e = { ...process.env, ...(local.install?.env || {}) }; delete e.NODE_TEST_CONTEXT; return e; })(), timeout: 30 * 60_000 });
  const num = (k) => +((r.out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [0, 0])[1]);
  const total = num('tests'); const passed = num('pass'); const failed = num('fail') + num('cancelled');
  return { ok: r.ok && total > 0, total, passed, failed, failingFiles: [], perTest: [], tail: r.out.slice(-800) };
}
export function install(dir, local, nodeBin = process.execPath) {
  const { cmd, args = [], env = {} } = local.install;
  const [c, a] = cmd === 'node' ? [nodeBin, args] : cmd === 'npm' ? [nodeBin, [npmCli(local), ...args]] : [cmd, args];
  const r = sh(dir, c, a, { env: { ...process.env, ...env }, timeout: 30 * 60_000 });
  if (!r.ok) die(`install failed in ${dir}: ${r.out.slice(-1200)}`);
}

export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
export const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };
export function readJson(f) { return JSON.parse(readFileSync(f, 'utf8')); }
export function writeJson(f, j) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(j, null, 2) + '\n'); }
