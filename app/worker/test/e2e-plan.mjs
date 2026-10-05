// End-to-end against the DEPLOYED Worker: one ask becomes tickets, another agent builds one, house rules decide who
// reviews and every finding cites a rule; the rules land on main next to the receipts.
// Usage: APPROVAL_CODE=... node test/e2e-plan.mjs <worker-url> [repo-name]   (the code is read from the environment only)
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import assert from 'node:assert/strict';

const BASE = process.argv[2]; const REPO = process.argv[3] || `plan-${Date.now().toString(36)}`;
const OWNER = process.env.OWNER_KEY || JSON.parse(readFileSync(join(homedir(), '.cinq', 'config.json'), 'utf8')).ownerKey;
const CODE = process.env.APPROVAL_CODE || '';
const SP = join(import.meta.dirname, 'fixtures');
const tree = (dir) => { const out = {}; const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : (out[`${pre}${e.name}`] = readFileSync(join(d, e.name), 'utf8')); }; walk(dir, ''); return out; };
const t0 = Date.now(); const log = (m, d) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`, d === undefined ? '' : JSON.stringify(d).slice(0, 300));
async function api(path, { key, body, method, soft } = {}) {
  const r = await fetch(`${BASE}/api/v1/${path}`, { method: method || (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok && !soft) throw new Error(`${path}: ${r.status} ${j.error}`);
  return { ...j, status: r.status };
}
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@e2e', '-c', 'credential.helper=', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const keyFor = async (agent) => (await api('keys', { key: OWNER, body: { agent, repo: REPO } })).key;
const push = (remote, files, msg) => { const w = mkdtempSync(join(tmpdir(), 'e2e-plan-')); git(tmpdir(), 'clone', '-q', remote, w); for (const [p, c] of Object.entries(files)) writeFileSync(join(w, p), c); git(w, 'add', '-A'); git(w, 'commit', '-qm', msg); git(w, 'push', '-q', 'origin', 'HEAD:main'); };

await api('repos', { key: OWNER, body: { name: REPO, seed: tree(join(SP, 's2', 'fixture', 'trunk')) } }); log('repo', REPO);
// house rules: without the approval code they are refused; with it they are version 1
assert.equal((await api(`repos/${REPO}/rules`, { key: OWNER, body: { rules: ['x'] }, soft: true })).status, 403);
const hr = await api(`repos/${REPO}/rules`, { key: OWNER, body: { rules: ['Money is formatted in one place.', 'Every new export has a test.'], reviewers: 'codex-*', code: CODE } });
assert.equal(hr.version, 1); log('house rules', { version: hr.version, reviewers: hr.reviewers });

const maya = await keyFor('maya');
const neg = readFileSync(join(SP, 's2', 'intents', 'i2-negative-money', 'frozen.test.js'), 'utf8');
const count = readFileSync(join(SP, 's2', 'intents', 'i3-item-count', 'frozen.test.js'), 'utf8');
const plan = await api(`repos/${REPO}/plan`, { key: maya, body: { ask: 'Refunds show as negative money, and the cart needs an item count.', tickets: [
  { goal: 'formatMoney supports negative amounts', allowed: ['src/format.js'], tests: { 'test/negative-money.test.js': neg } },
  { goal: 'itemCount sums qty across cart lines', allowed: ['src/cart.js'], tests: { 'test/item-count.test.js': count } }] } });
log('plan', plan.tickets); assert.deepEqual(plan.tickets.map((t) => t.state), ['working', 'open']);
const [negId, countId] = plan.tickets.map((t) => t.intentId);

push(plan.claim.fork.remote, { 'test/negative-money.test.js': neg, 'src/format.js': "export function formatMoney(amount) {\n  const sign = amount < 0 ? '-' : '';\n  const [whole, frac] = Math.abs(amount).toFixed(2).split('.');\n  return sign + '$' + whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + frac;\n}\n" }, 'negative money');
await api(`repos/${REPO}/submit`, { key: maya, body: { claimId: plan.claim.claimId } });

const crew = await keyFor('crew-1');
const { claim: b } = await api(`repos/${REPO}/claim`, { key: crew, body: { intentId: countId } });
assert.equal(b.kind, 'build'); assert.match(b.context.ask, /item count/); log('crew-1 builds', { kind: b.kind });
const cart = readFileSync(join(SP, 's2', 'fixture', 'trunk', 'src', 'cart.js'), 'utf8') + '\nexport function itemCount(items) {\n  return items.reduce((n, i) => n + i.qty, 0);\n}\n';
push(b.fork.remote, { 'test/item-count.test.js': count, 'src/cart.js': cart }, 'item count');
await api(`repos/${REPO}/submit`, { key: crew, body: { claimId: b.claimId } });

const ex = await keyFor('crew-2');
const hidden = {
  [negId]: { 'test/neg-hidden.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('negative thousands', () => assert.equal(formatMoney(-1234.5), '-$1,234.50'));\n" },
  [countId]: { 'test/count-hidden.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { itemCount } from '../src/cart.js';\ntest('empty cart', () => assert.equal(itemCount([]), 0));\n" } };
for (const id of [negId, countId]) { const { claim } = await api(`repos/${REPO}/claim`, { key: ex, body: { intentId: id, kind: 'examine' } }); await api(`repos/${REPO}/submit-tests`, { key: ex, body: { claimId: claim.claimId, tests: hidden[id] } }); }
log('examined both');

const until = async (pred, what) => { for (let i = 0; i < 60; i++) { const { intents } = await api(`repos/${REPO}/intents`, { key: OWNER }); if (pred(intents)) return intents; await new Promise((r) => setTimeout(r, 3000)); } throw new Error(`timed out waiting for ${what}`); };
await until((its) => its.filter((i) => i.state === 'awaiting-review').length === 2, 'both to await review');
// the house rules say only codex-* review
const claude = await keyFor('claude-r');
assert.equal((await api(`repos/${REPO}/claim`, { key: claude, body: { kind: 'review' } })).claim, null);
const codex = await keyFor('codex-1');
for (const id of [negId, countId]) {
  const { claim } = await api(`repos/${REPO}/claim`, { key: codex, body: { intentId: id, kind: 'review' } });
  assert.equal(claim.houseRules.version, 1);
  assert.equal((await api(`repos/${REPO}/submit-review`, { key: codex, body: { claimId: claim.claimId, verdict: 'pass', findings: [{ file: 'src/cart.js', line: 0, severity: 'low', reason: 'no rule broken' }] }, soft: true })).status, 400); // a finding must cite a rule
  await api(`repos/${REPO}/submit-review`, { key: codex, body: { claimId: claim.claimId, verdict: 'pass', summary: 'Meets both house rules.', findings: [{ file: claim.intent.allowed[0], line: 0, severity: 'low', reason: 'fine', rule: 2 }] } });
}
log('codex passed both');
const done = await until((its) => its.filter((i) => [negId, countId].includes(i.id) && i.state === 'landed').length === 2, 'both to land');
log('landed', done.map((i) => [i.id, i.landed_via]));
assert.equal(done.find((i) => i.id === countId).landed_via, 'built');
const rc = await api(`repos/${REPO}/receipts/${countId}`, { key: OWNER });
assert.equal(rc.receipt.review.houseRules.version, 1); assert.equal(rc.receipt.ask.by, 'maya');
const rulesMd = await api(`repos/${REPO}/file?path=${encodeURIComponent('.cinq/rules.md')}`, { key: OWNER });
assert.match(rulesMd.content, /Money is formatted in one place/);
await api(`repos/${REPO}/usage`, { key: crew, body: { input: 1200, cachedInput: 30000, output: 900, since: t0, until: Date.now(), vendor: 'claude' } });
const u = await api(`repos/${REPO}/usage`, { key: OWNER });
assert.ok(u.total.tokens > 0 && u.landed >= 2); log('usage', { perLanded: u.tokensPerLanded, byRole: u.byRole });
assert.equal((await api(`repos/${REPO}/asks`, { key: OWNER })).asks[0].tickets.length, 2);
console.log(`\nPASS e2e-plan on ${REPO} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
