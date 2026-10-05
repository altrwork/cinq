// End-to-end against the DEPLOYED Worker, exactly as an agent would use it over HTTP:
// owner creates repo + agent key → agent proposes a job → clones its fork → pushes → submits →
// waits for the result → reads trunk events and the receipt.
// Usage: node test/e2e-api.mjs <worker-url> [repo-name]
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const BASE = process.argv[2] || JSON.parse(readFileSync(join(homedir(), '.cinq', 'config.json'), 'utf8')).url; // default: the deployment you're logged in to
const REPO = process.argv[3] || `e2e-${Date.now().toString(36)}`;
const OWNER = process.env.OWNER_KEY || JSON.parse(readFileSync(join(homedir(), '.cinq', 'config.json'), 'utf8')).ownerKey;
const SP = join(import.meta.dirname, 'fixtures');
const tree = (dir) => { const out = {}; const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : (out[`${pre}${e.name}`] = readFileSync(join(d, e.name), 'utf8')); }; walk(dir, ''); return out; };
const t0 = Date.now(); const log = (m, d) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`, d === undefined ? '' : JSON.stringify(d).slice(0, 400));
async function api(path, { key, body, method } = {}) {
  const r = await fetch(`${BASE}/api/v1/${path}`, { method: method || (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(`${path}: ${r.status} ${j.error}`);
  return j;
}
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@e2e', '-c', 'credential.helper=', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

log('create repo', (await api('repos', { key: OWNER, body: { name: REPO, seed: tree(join(SP, 's2', 'fixture', 'trunk')) } })));
const { key } = await api('keys', { key: OWNER, body: { agent: 'claude-e2e', repo: REPO } }); log('agent key minted');

const test = readFileSync(join(SP, 's2', 'intents', 'i2-negative-money', 'frozen.test.js'), 'utf8');
const p = await api(`repos/${REPO}/propose`, { key, body: { goal: 'formatMoney supports negative amounts with the minus before the $', allowed: ['src/format.js'], tests: { 'test/negative-money.test.js': test } } });
log('proposed', { intentId: p.intentId, validity: p.validity, kind: p.claim.kind });

const w = mkdtempSync(join(tmpdir(), 'e2e-agent-'));
git(tmpdir(), 'clone', '-q', p.claim.fork.remote, w); log('cloned fork');
writeFileSync(join(w, 'test/negative-money.test.js'), test);
writeFileSync(join(w, 'src/format.js'), "export function formatMoney(amount) {\n  const sign = amount < 0 ? '-' : '';\n  const [whole, frac] = Math.abs(amount).toFixed(2).split('.');\n  return sign + '$' + whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + frac;\n}\n");
git(w, 'add', '-A'); git(w, 'commit', '-qm', 'negative money'); git(w, 'push', '-q', 'origin', 'HEAD:main'); log('pushed to fork');

log('submitted', await api(`repos/${REPO}/submit`, { key, body: { claimId: p.claim.claimId, generation: p.claim.generation } }));

// The deployment examines and reviews every job (separation of duties), so this script also plays the examiner
// and the reviewers, each with its own key: none of them wrote the change.
const keyFor = async (agent) => (await api('keys', { key: OWNER, body: { agent, repo: REPO } })).key;
const examinerKey = await keyFor('e2e-examiner');
const hiddenNeg = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('negative thousands', () => assert.equal(formatMoney(-1234.5), '-$1,234.50'));\n";
async function examine(intentId, tests) {
  const { claim } = await api(`repos/${REPO}/claim`, { key: examinerKey, body: { intentId, kind: 'examine' } });
  log('examined', await api(`repos/${REPO}/submit-tests`, { key: examinerKey, body: { claimId: claim.claimId, tests } }));
}
async function waitFor(k, claimId, done) {
  let s;
  for (let i = 0; i < 10; i++) {
    s = await api(`repos/${REPO}/status`, { key: k, body: { claimId, waitSeconds: 50 } });
    log('status', { claim: s.claimState, intent: s.intentState, review: s.reviewState, via: s.landedVia, sha: s.landedSha });
    if (done(s)) break;
  }
  return s;
}
async function review(agent, intentId, verdict, findings = [], summary) {
  const k = await keyFor(agent);
  const { claim } = await api(`repos/${REPO}/claim`, { key: k, body: { intentId, kind: 'review' } });
  log(`${agent} reviews`, { kind: claim.kind, diffLines: claim.diff.split('\n').length, gates: claim.gates });
  log(`${agent} hands in ${verdict}`, await api(`repos/${REPO}/submit-review`, { key: k, body: { claimId: claim.claimId, verdict, findings, summary } }));
}
const ended = (s) => ['landed', 'done', 'expired', 'released'].includes(s.claimState);
await examine(p.intentId, { 'test/exam-neg.test.js': hiddenNeg });
let s = await waitFor(key, p.claim.claimId, (x) => ended(x) || x.intentState === 'awaiting-review');
if (s.intentState === 'awaiting-review') { await review('e2e-reviewer-1', p.intentId, 'pass'); s = await waitFor(key, p.claim.claimId, ended); }
const ev = await api(`repos/${REPO}/events`, { key: OWNER });
log('events', ev.events.map((e) => e.type));
const rc = await api(`repos/${REPO}/receipts/${p.intentId}`, { key: OWNER }).catch((e) => ({ error: e.message }));
log('receipt from the repo', rc.receipt || rc.error);
if (s.claimState !== 'landed') { console.log(`\nFAIL: ${JSON.stringify(s)}`); process.exit(1); }
log(`PASS 1/2: landed ${s.landedSha}`);

// One blocked-then-fixed job end to end. The author's code passes every test but mutates its input;
// reviewer 1 blocks it, a different agent rebuilds it from the goal and the findings, reviewer 2 passes it.
const rateTest = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyRate } from '../src/format.js';\ntest('applies a rate to each line', () => assert.deepEqual(applyRate([{ amount: 10 }], 0.5), [{ amount: 5 }]));\n";
const base = git(w, 'show', 'HEAD:src/format.js');
const p2 = await api(`repos/${REPO}/propose`, { key, body: { goal: 'applyRate(lines, rate) returns new lines with each amount multiplied by rate, leaving the input untouched', allowed: ['src/format.js'], tests: { 'test/apply-rate.test.js': rateTest }, plan: 'Add applyRate next to formatMoney; map to new objects.' } });
log('proposed 2', { intentId: p2.intentId });
// A second job on the same file is warned before it starts, and the board says who holds what.
const otherKey = await keyFor('e2e-other');
const p3 = await api(`repos/${REPO}/propose`, { key: otherKey, body: { goal: 'formatMoney can leave out the cents', allowed: ['src/format.js'], tests: { 'test/no-cents.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('no cents', () => assert.equal(formatMoney(12, { cents: false }), '$12'));\n" } } });
const board = (await api(`repos/${REPO}/intents`, { key: OWNER })).intents.find((i) => i.id === p2.intentId);
log('overlap warning', { overlaps: p3.overlaps?.map((o) => o.job), board: { files: board?.files, holder: board?.holder } });
if (!p3.overlaps?.some((o) => o.job === p2.intentId) || board?.holder !== 'claude-e2e') { console.log('\nFAIL: no overlap warning'); process.exit(1); }
await api(`repos/${REPO}/release`, { key: otherKey, body: { claimId: p3.claim.claimId, reason: 'overlaps another open job' } });
const w2 = mkdtempSync(join(tmpdir(), 'e2e-agent-')); git(tmpdir(), 'clone', '-q', p2.claim.fork.remote, w2);
writeFileSync(join(w2, 'test/apply-rate.test.js'), rateTest);
writeFileSync(join(w2, 'src/format.js'), base + "\nexport function applyRate(lines, rate) {\n  for (const l of lines) l.amount = l.amount * rate;\n  return lines;\n}\n");
git(w2, 'add', '-A'); git(w2, 'commit', '-qm', 'apply rate'); git(w2, 'push', '-q', 'origin', 'HEAD:main');
await api(`repos/${REPO}/submit`, { key, body: { claimId: p2.claim.claimId } });
await examine(p2.intentId, { 'test/exam-rate.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyRate } from '../src/format.js';\ntest('zero rate', () => assert.deepEqual(applyRate([{ amount: 3 }], 0), [{ amount: 0 }]));\n" });
s = await waitFor(key, p2.claim.claimId, (x) => ended(x) || x.intentState === 'awaiting-review');
await review('e2e-reviewer-1', p2.intentId, 'block', [{ file: 'src/format.js', line: 7, severity: 'high', reason: 'applyRate mutates the caller\'s lines; the goal says the input stays untouched' }]);
const rebuilderKey = await keyFor('e2e-rebuilder');
const { claim: rb } = await api(`repos/${REPO}/claim`, { key: rebuilderKey, body: { intentId: p2.intentId } });
log('rebuild work order', { kind: rb.kind, why: rb.context?.why?.verdict, findings: rb.context?.why?.findings?.length });
if (rb.kind !== 'rederive' || rb.context?.why?.verdict !== 'review-blocked') { console.log('\nFAIL: the block did not come back as a rebuild with findings'); process.exit(1); }
const w3 = mkdtempSync(join(tmpdir(), 'e2e-agent-')); git(tmpdir(), 'clone', '-q', rb.fork.remote, w3);
for (const [f, c] of Object.entries(rb.intent.tests)) writeFileSync(join(w3, f), c);
writeFileSync(join(w3, 'src/format.js'), base + "\nexport function applyRate(lines, rate) {\n  return lines.map((l) => ({ ...l, amount: l.amount * rate }));\n}\n");
git(w3, 'add', '-A'); git(w3, 'commit', '-qm', 'apply rate without mutating'); git(w3, 'push', '-q', 'origin', 'HEAD:main');
await api(`repos/${REPO}/submit`, { key: rebuilderKey, body: { claimId: rb.claimId } });
s = await waitFor(rebuilderKey, rb.claimId, (x) => ended(x) || x.intentState === 'awaiting-review');
await review('e2e-reviewer-2', p2.intentId, 'pass', [], 'Returns new objects; the input is untouched.');
s = await waitFor(rebuilderKey, rb.claimId, ended);
const rc2 = await api(`repos/${REPO}/receipts/${p2.intentId}`, { key: OWNER }).catch((e) => ({ error: e.message }));
log('receipt review', { review: rc2.receipt?.review || rc2.error, plan: rc2.receipt?.plan, testsRunBeforeReview: rc2.receipt?.testsRunBeforeReview });
const ok = s.claimState === 'landed' && rc2.receipt?.review?.verdict === 'pass' && rc2.receipt?.review?.summary && rc2.receipt?.plan && s.landedVia === 're-derived#1';
console.log(ok ? `\nPASS 2/2: blocked by review, rebuilt, passed, landed ${s.landedSha} in ${((Date.now() - t0) / 1000).toFixed(1)}s` : `\nFAIL: ${JSON.stringify(s)}`);
process.exit(ok ? 0 : 1);
