// "A normal day" on examples/slotly with REAL Claude Code agents: two people (maya, sam) each give their Claude Code
// one long ask, in their own checkout, at the same time. A crew builds the other tickets, examines and rebuilds;
// a reviewer-only crew reviews against the house rules. Every session's tokens are recorded on the board.
//   APPROVAL_CODE=... node app/scripts/demo-day.mjs <repo> [outDir] [maxMinutes=90]
// Uses the cinq login (~/.cinq/config.json) as the owner. Keys and codes are never printed.
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const [REPO = `slotly-${Date.now().toString(36)}`, OUT, MAXMIN = '90'] = process.argv.slice(2);
const ROOT = resolve(import.meta.dirname, '..', '..'); const CLI = join(ROOT, 'app', 'cli', 'cinq.mjs');
const { url: BASE, ownerKey: OWNER } = JSON.parse(readFileSync(join(homedir(), '.cinq', 'config.json'), 'utf8'));
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid', ...a], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const T0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, { body } = {}) {
  const r = await fetch(`${BASE}/api/v1/${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${path}: ${r.status} ${j.error || ''}`); return j;
}
const cinq = (cwd, ...a) => execFileSync('node', [CLI, ...a], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

import { RULES, ASKS } from './demo-asks.mjs';

// two checkouts of one repo, as two people's laptops
const base = mkdtempSync(join(tmpdir(), 'demo-day-'));
const seedDir = join(base, 'maya'); cpSync(join(ROOT, 'examples', 'slotly'), seedDir, { recursive: true, filter: (p) => !p.includes('node_modules') });
git(seedDir, 'init', '-q', '-b', 'main'); git(seedDir, 'add', '-A'); git(seedDir, 'commit', '-qm', 'Slotly');
const samDir = join(base, 'sam'); git(base, 'clone', '-q', seedDir, samDir);
log('init maya'); cinq(seedDir, 'init', '--repo', REPO, '--agent', 'maya');
log('init sam'); cinq(samDir, 'init', '--repo', REPO, '--agent', 'sam');
await api(`repos/${REPO}/rules`, { body: { rules: RULES, reviewers: 'reviewer-*', code: process.env.APPROVAL_CODE } }); log('house rules set');

const running = [];
const proc = (name, cmd, args, cwd) => {
  const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
  p.stdout.on('data', (d) => { out += d; if (name.startsWith('crew')) process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `  ${l.slice(0, 200)}\n`).join('')); });
  p.stderr.on('data', (d) => (out += d));
  const done = new Promise((res) => p.on('close', (code) => res({ name, code, out })));
  running.push(p); return done;
};
const crewDir = mkdtempSync(join(tmpdir(), 'crew-')); writeFileSync(join(crewDir, '.cinq.json'), JSON.stringify({ repo: REPO, url: BASE }));
const crews = [proc('crew', 'node', [CLI, 'crew', '--n', '4', '--idle', '12', '--rounds', '3'], crewDir),
  proc('crew-review', 'node', [CLI, 'crew', '--name', 'reviewer', '--only', 'review', '--n', '2', '--idle', '12', '--rounds', '4'], crewDir)];

const tools = 'mcp__cinq__propose_plan,mcp__cinq__propose_intent,mcp__cinq__house_rules,mcp__cinq__list_intents,mcp__cinq__get_intent,mcp__cinq__submit,mcp__cinq__status,mcp__cinq__claim,mcp__cinq__submit_review,mcp__cinq__submit_tests,mcp__cinq__release,mcp__cinq__get_receipt,Read,Edit,Write,Glob,Grep,Bash(git:*),Bash(npm test:*),Bash(npm install:*),Bash(node --test:*),Bash(ls:*)';
const author = (who, dir) => { const t = Date.now(); return proc(who, 'claude', ['-p', ASKS[who], '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', tools], dir).then(async (r) => {
  let j = {}; try { j = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch {}
  const u = j.usage || {};
  log(`${who} finished (${r.code}): ${String(j.result || r.out).slice(0, 400).replace(/\s+/g, ' ')}`);
  await api(`repos/${REPO}/usage-for`, { body: { agent: who, input: u.input_tokens || 0, cachedInput: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, costUsd: j.total_cost_usd ?? null, vendor: 'claude', since: t, until: Date.now() } }).catch((e) => log('usage not recorded:', e.message));
  return r; }); };
log('maya and sam ask'); const authors = [author('maya', seedDir), author('sam', samDir)];

const deadline = T0 + +MAXMIN * 60_000;
let last = '';
while (Date.now() < deadline) {
  await sleep(30_000);
  const { intents } = await api(`repos/${REPO}/intents`);
  const by = intents.reduce((m, i) => ((m[i.state] = (m[i.state] || 0) + 1), m), {});
  const line = JSON.stringify(by); if (line !== last) { log('board', line); last = line; }
  const settled = intents.length && intents.every((i) => ['landed', 'parked', 'satisfied', 'rejected'].includes(i.state));
  if (settled && (await Promise.race([Promise.all(authors).then(() => true), sleep(1000).then(() => false)]))) break;
}
await Promise.race([Promise.all(authors), sleep(60_000)]);
for (const p of running) { try { p.kill('SIGINT'); } catch {} }
await Promise.race([Promise.all(crews), sleep(30_000)]);

const [{ intents }, { events }, usage, rules, asks] = await Promise.all([api(`repos/${REPO}/intents`), api(`repos/${REPO}/events?tail=5000`), api(`repos/${REPO}/usage`), api(`repos/${REPO}/rules`), api(`repos/${REPO}/asks`)]);
const summary = { repo: REPO, minutes: +((Date.now() - T0) / 60000).toFixed(1), jobs: intents.length, landed: intents.filter((i) => i.state === 'landed').length, parked: intents.filter((i) => i.state === 'parked').map((i) => i.id), usage };
log('summary', JSON.stringify(summary));
if (OUT) { mkdirSync(OUT, { recursive: true }); for (const [f, v] of Object.entries({ 'summary.json': summary, 'jobs.json': intents, 'events.json': events, 'rules.json': rules, 'asks.json': asks.asks })) writeFileSync(join(OUT, f), JSON.stringify(v, null, 2)); log('wrote', OUT); }
rmSync(base, { recursive: true, force: true });
process.exit(0);
