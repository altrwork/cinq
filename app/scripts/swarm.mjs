// Scale run with SCRIPTED agents (no LLM): N authors each register one small job on one shared repo, all in the
// same file, so they collide constantly. Scripted crew agents then work the board the way Claude crew agents do:
// they examine jobs (hidden tests written from the goal alone) and rebuild clashed jobs on fresh forks.
// Every agent has its own key, its own Artifacts fork, and goes through the same gates as a real agent.
//   node app/scripts/swarm.mjs <repo> [authors=200] [crew=12] [parallel=24] [maxMinutes=40]
// Uses the cinq login (~/.cinq/config.json) as the owner. Keys and repo names are never printed.
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const [REPO = 'swarm', N = '200', CREW = '12', PAR = '24', MAXMIN = '40'] = process.argv.slice(2);
const { url: BASE, ownerKey: OWNER } = JSON.parse(readFileSync(join(homedir(), '.cinq', 'config.json'), 'utf8'));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'credential.helper=', '-c', 'core.autocrlf=false', '-c', 'user.name=swarm', '-c', 'user.email=swarm@example.invalid', ...a], { windowsHide: true, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const T0 = Date.now(); const el = () => `${((Date.now() - T0) / 1000).toFixed(0)}s`;
const log = (...a) => console.log(`[${el()}]`, ...a);
const deadline = T0 + +MAXMIN * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, { key = OWNER, body, method } = {}) {
  for (let i = 0; ; i++) {
    const r = await fetch(`${BASE}/api/v1/${path}`, { method: method || (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    if (r.status >= 500 && i < 3) { await sleep(1000 * (i + 1)); continue; }
    throw Object.assign(new Error(`${path}: ${r.status} ${j.error || ''}`), { status: r.status });
  }
}
const pool = async (items, n, fn) => { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); };
const tally = { proposed: 0, handedIn: 0, examined: 0, rebuilt: 0, reviewed: 0, errors: 0 };

// ---- the app: a plugin registry. Every job adds one plugin to the SAME array in the SAME file. ----
const id = (i) => `p${String(i).padStart(3, '0')}`;
// 40 anchor lines: jobs that share an anchor (i % 40) really clash; the rest merge cleanly, like a busy file does
const SLOTS = 40, slot = (i) => `  // group ${String(i % SLOTS).padStart(2, '0')}\n`;
const registryWith = (src, i) => src.replace(slot(i), `${slot(i)}  { name: '${id(i)}', run: (x) => x + ${i} },\n`);
const testFor = (i, hidden) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { plugins } from '../src/registry.js';\n` +
  (hidden ? `test('${id(i)} is registered once and adds ${i}', () => { const p = plugins.filter((q) => q.name === '${id(i)}'); assert.equal(p.length, 1); assert.equal(p[0].run(1), ${i + 1}); });\n`
          : `test('${id(i)} adds ${i}', () => assert.equal(plugins.find((p) => p.name === '${id(i)}')?.run(0), ${i}));\n`);
const goalFor = (i) => `Register plugin ${id(i)} in src/registry.js: run(x) returns x + ${i}`;
const numOf = (goal) => +(/plugin p(\d{3})/.exec(goal) || [])[1];

// ---- 1. the repo (seeded like cinq init: create, then push history to its import remote) ----
const seedDir = mkdtempSync(join(tmpdir(), 'swarm-seed-'));
mkdirSync(join(seedDir, 'src')); mkdirSync(join(seedDir, 'test'));
writeFileSync(join(seedDir, 'package.json'), JSON.stringify({ name: 'swarm', type: 'module', scripts: { test: 'node --test' } }, null, 2));
writeFileSync(join(seedDir, 'src/registry.js'), "export const plugins = [\n  { name: 'identity', run: (x) => x },\n" + Array.from({ length: SLOTS }, (_, k) => slot(k)).join('') + "];\n");
writeFileSync(join(seedDir, 'test/registry.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { plugins } from '../src/registry.js';\ntest('names are unique', () => assert.equal(new Set(plugins.map((p) => p.name)).size, plugins.length));\n");
git(seedDir, 'init', '-q', '-b', 'main'); git(seedDir, 'add', '-A'); git(seedDir, 'commit', '-qm', 'plugin registry');
await api('repos', { body: { name: REPO } });
const { remote } = await api(`repos/${REPO}/import-remote`, { body: {} });
git(seedDir, 'push', '-q', remote, 'HEAD:main');
rmSync(seedDir, { recursive: true, force: true });
log(`repo ${REPO} ready on Cloudflare Artifacts; ${N} authors, ${CREW} crew`);

// ---- 2. authors: propose → own fork → edit → push → hand in (then they're done; the board does the rest) ----
const mkKey = async (agent) => (await api('keys', { body: { agent, repo: REPO } })).key;
async function work(fork, i) {
  const w = mkdtempSync(join(tmpdir(), 'swarm-w-'));
  try {
    git(tmpdir(), 'clone', '-q', fork, w);
    writeFileSync(join(w, 'src/registry.js'), registryWith(readFileSync(join(w, 'src/registry.js'), 'utf8'), i));
    git(w, 'commit', '-qam', `register ${id(i)}`); git(w, 'push', '-q', 'origin', 'HEAD:main');
  } finally { rmSync(w, { recursive: true, force: true }); }
}
let authorsDone = false, stop = false; // crew keeps working the board until the run ends
const authors = (async () => {
  await pool(Array.from({ length: +N }, (_, k) => k + 1), +PAR, async (i) => {
    if (Date.now() > deadline) return;
    try {
      const key = await mkKey(`bot-${id(i)}`);
      const p = await api(`repos/${REPO}/propose`, { key, body: { goal: goalFor(i), allowed: ['src/registry.js'], tests: { [`test/${id(i)}.test.js`]: testFor(i, false) } } });
      tally.proposed++;
      await work(p.claim.fork.remote, i);
      await api(`repos/${REPO}/submit`, { key, body: { claimId: p.claim.claimId, generation: p.claim.generation } });
      tally.handedIn++;
    } catch (e) { tally.errors++; if (tally.errors <= 5) log('author error', id(i), e.message.slice(0, 120)); }
  });
  authorsDone = true; log('all authors have handed in');
})();

// ---- 3. scripted crew: claim the next board job; examine (hidden test from the goal alone) or rebuild ----
async function crew(n) {
  const key = await mkKey(`crew-bot-${n}`); let idle = 0;
  while (Date.now() < deadline) {
    let c;
    try { c = (await api(`repos/${REPO}/claim`, { key, body: {} })).claim; } catch (e) { await sleep(2000); continue; }
    if (!c) { if (stop) return; await sleep(3000); continue; }
    idle = 0;
    const i = numOf(c.intent?.goal || '');
    try {
      if (c.kind === 'examine') {
        await api(`repos/${REPO}/submit-tests`, { key, body: { claimId: c.claimId, tests: { [`test/${id(i)}.exam.test.js`]: testFor(i, true) } } });
        tally.examined++;
      } else if (c.kind === 'review') { // a scripted reviewer: pass a diff that stays in the registry file, block anything else
        const files = [...(c.diff || '').matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
        const ok = files.length > 0 && files.every((f) => f === 'src/registry.js' || f.startsWith('test/'));
        await api(`repos/${REPO}/submit-review`, { key, body: { claimId: c.claimId, verdict: ok ? 'pass' : 'block', summary: ok ? 'Adds one plugin entry to the registry, nothing else.' : 'Changes files outside the registry.',
          findings: ok ? [] : [{ file: files.find((f) => f !== 'src/registry.js') || 'src/registry.js', line: 0, severity: 'medium', reason: 'outside the job' }] } });
        tally.reviewed++;
      } else {
        await work(c.fork.remote, i);
        await api(`repos/${REPO}/submit`, { key, body: { claimId: c.claimId, generation: c.generation } });
        tally.rebuilt++;
      }
    } catch (e) { tally.errors++; if (tally.errors <= 10) log(`crew-bot-${n} error`, c.kind, id(i), e.message.slice(0, 120));
      await api(`repos/${REPO}/release`, { key, body: { claimId: c.claimId, reason: 'scripted crew error' } }).catch(() => {}); }
  }
}
const crews = Promise.all(Array.from({ length: +CREW }, (_, k) => crew(k + 1)));

// ---- 4. progress from the board itself, every 30 s ----
const board = async () => { const j = await api(`repos/${REPO}/intents`); const L = j.intents || j; const by = {}; for (const x of L) by[x.state] = (by[x.state] || 0) + 1; return { total: L.length, by }; };
let last = '';
while (Date.now() < deadline) {
  await sleep(30_000);
  const b = await board().catch(() => null); if (!b) continue;
  const line = `board ${JSON.stringify(b.by)} · ${JSON.stringify(tally)}`; if (line !== last) log(line); last = line;
  if (authorsDone && b.total && (b.by.landed || 0) + (b.by.satisfied || 0) + (b.by.parked || 0) >= b.total) break;
}
stop = true; await Promise.race([crews, sleep(8000)]);
const ev = await api(`repos/${REPO}/events?tail=5000`).then((j) => j.events || j).catch(() => []);
const count = (t) => ev.filter((e) => e.type === t).length;
const landed = ev.filter((e) => e.type === 'land.landed');
const first = new Map(); for (const e of ev) if (e.type === 'intent.proposed' && !first.has(e.intent)) first.set(e.intent, e.ts);
const ttl = landed.map((e) => (e.ts - first.get(e.intent)) / 60000).filter((x) => x >= 0).sort((a, b) => a - b);
const summary = { minutes: +((Date.now() - T0) / 60000).toFixed(1), board: (await board()).by, landed: landed.length, conflicts: ev.filter((e) => e.type === 'gate.failed' && e.data?.verdict === 'conflict').length,
  rederivesQueued: count('rederive.queued'), examinations: count('examine.done'), trunkHeads: count('trunk.head'), medianMinToLand: ttl.length ? +ttl[Math.floor(ttl.length / 2)].toFixed(1) : null, tally };
log('SUMMARY', JSON.stringify(summary));
writeFileSync(join(process.cwd(), `swarm-${REPO}-summary.json`), JSON.stringify(summary, null, 2));
process.exit(0);
