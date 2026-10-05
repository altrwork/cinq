// Engine lifecycle against real git repos and the real lander (server.cjs), with node:sqlite standing
// in for RepoDO's ctx.storage.sql and bare repos standing in for Artifacts trunk + forks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine, ApiError } from '../src/engine.js';

process.env.LANDER_NO_LISTEN = '1';
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' }); // no credential manager windows on a dev machine
const ROOT = mkdtempSync(join(tmpdir(), 'engine-test-'));
process.env.LANDER_WORK = join(ROOT, 'work');
const { handle } = createRequire(import.meta.url)('../src/lander/server.cjs');
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const SP = join(import.meta.dirname, 'fixtures');
let n = 0;

// ctx.storage.sql look-alike over node:sqlite
function sqlAdapter() {
  const db = new DatabaseSync(':memory:');
  return { exec(query, ...args) {
    const s = db.prepare(query); const rows = /^\s*(SELECT|WITH)/i.test(query) ? s.all(...args) : (s.run(...args), []);
    return { toArray: () => rows };
  } };
}
function setup(baseDir, opts = {}) {
  const trunk = join(ROOT, `trunk-${++n}.git`); git(ROOT, 'init', '-q', '--bare', '-b', 'main', trunk);
  const w = join(ROOT, `seed-${n}`); cpSync(baseDir, w, { recursive: true });
  for (const [p, c] of Object.entries(opts.files || {})) { mkdirSync(dirname(join(w, p)), { recursive: true }); writeFileSync(join(w, p), c); }
  git(w, 'init', '-q', '-b', 'main'); git(w, 'add', '-A'); git(w, 'commit', '-qm', 'base'); git(w, 'push', '-q', trunk, 'main');
  const events = []; let clock = 1_000_000;
  const artifacts = {
    trunkUrl: () => trunk,
    fork: async (name) => { const url = join(ROOT, `${name}.git`); git(ROOT, 'clone', '-q', '--bare', trunk, url); return { name, url }; },
    remove: async (name) => rmSync(join(ROOT, `${name}.git`), { recursive: true, force: true }),
  };
  const lander = { land: (b) => handle('land', b), check: (b) => handle('check', b), stage: (b) => handle('stage', b), files: (paths) => handle('browse', { trunk, kind: 'files', path: paths }), context: (paths) => handle('browse', { trunk, kind: 'context', path: paths }) };
  const engine = new Engine({ sql: sqlAdapter(), artifacts: { ...artifacts, trunkReadUrl: () => trunk }, lander, now: () => clock, emit: (e) => events.push(e), examine: opts.examine ?? false, review: opts.review ?? false });
  return { engine, events, trunk, tick: (ms) => (clock += ms) };
}
// An agent doing its work on the fork from its work order.
function work(order, writes = {}, deletes = []) {
  const w = join(ROOT, `agent-${++n}`); git(ROOT, 'clone', '-q', order.fork.remote, w);
  for (const [p, c] of Object.entries({ ...order.intent.tests, ...writes })) { mkdirSync(dirname(join(w, p)), { recursive: true }); writeFileSync(join(w, p), c); }
  for (const p of deletes) rmSync(join(w, p), { force: true });
  git(w, 'add', '-A'); try { git(w, 'commit', '-qm', 'work'); } catch {} git(w, 'push', '-q', 'origin', 'HEAD:main');
}
const tree = (dir) => { const out = {}; const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : (out[`${pre}${e.name}`] = readFileSync(join(d, e.name), 'utf8')); }; walk(dir, ''); return out; };
const s2 = join(SP, 's2', 'fixture', 'trunk');
const negTest = readFileSync(join(SP, 's2', 'intents', 'i2-negative-money', 'frozen.test.js'), 'utf8').replace(/intent: negative amounts/, 'negative amounts');
const goodFormat = `export function formatMoney(amount) {\n  const sign = amount < 0 ? '-' : '';\n  const [whole, frac] = Math.abs(amount).toFixed(2).split('.');\n  return sign + '$' + whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + frac;\n}\n`;
const negIntent = { goal: 'formatMoney supports negative amounts', allowed: ['src/format.js'], tests: { 'test/negative-money.test.js': negTest } };

test('an agent registers its job, works on its own fork, and lands, with no approvals', async () => {
  const { engine, events } = setup(s2);
  const { intentId, validity, claim } = await engine.proposeIntent('agent-a', negIntent);
  assert.equal(validity.failsOnTrunk, true);
  assert.ok(claim.fork.remote && claim.claimId);
  work(claim, { 'src/format.js': goodFormat });
  engine.submit('agent-a', claim.claimId, claim.generation);
  await engine.processQueue();
  const it = engine.getIntent(intentId);
  assert.equal(it.state, 'landed'); assert.equal(it.landed_via, 'as-written');
  assert.deepEqual(events.map((e) => e.type), ['intent.proposed', 'claim.started', 'submit.received', 'land.started', 'land.landed', 'trunk.head']);
});

test('a vacuous intent (tests already pass on trunk) is refused', async () => {
  const { engine } = setup(s2);
  const passing = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('already true', () => assert.equal(formatMoney(2), '$2.00'));\n";
  await assert.rejects(engine.proposeIntent('agent-a', { goal: 'nothing', allowed: ['src/format.js'], tests: { 'test/vacuous.test.js': passing } }), (e) => e instanceof ApiError && e.status === 422);
});

test('a conflict goes back on the board; the author may not re-derive it; a fresh agent lands it', async () => {
  const { engine } = setup(s2);
  const a = await engine.proposeIntent('agent-a', negIntent);
  const b = await engine.proposeIntent('agent-b', { goal: 'formatMoney accepts a currency symbol', allowed: ['src/format.js'],
    tests: { 'test/symbol.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('euro', () => assert.equal(formatMoney(3.5, { symbol: '€' }), '€3.50'));\n" } });
  work(b.claim, { 'src/format.js': "export function formatMoney(amount, { symbol = '$' } = {}) {\n  const [whole, frac] = amount.toFixed(2).split('.');\n  return symbol + whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + frac;\n}\n" });
  work(a.claim, { 'src/format.js': goodFormat }); // written against the same old trunk → textual conflict
  engine.submit('agent-b', b.claim.claimId); engine.submit('agent-a', a.claim.claimId);
  assert.equal(await engine.processQueue(1), true); // one landing per call; the other is still waiting
  assert.equal(engine.getIntent(b.intentId).state, 'landed');
  assert.equal(await engine.processQueue(1), false);
  assert.equal(engine.getIntent(a.intentId).state, 'rederive');
  await assert.rejects(engine.claim('agent-a', { intentId: a.intentId }), /separation of duties/);
  const { claim } = await engine.claim('agent-c');
  assert.equal(claim.kind, 'rederive'); assert.ok(claim.context.previousAttempt.includes('sign'));
  work(claim, { 'src/format.js': "export function formatMoney(amount, { symbol = '$' } = {}) {\n  const sign = amount < 0 ? '-' : '';\n  const [whole, frac] = Math.abs(amount).toFixed(2).split('.');\n  return sign + symbol + whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + frac;\n}\n" });
  engine.submit('agent-c', claim.claimId); await engine.processQueue();
  const it = engine.getIntent(a.intentId);
  assert.equal(it.state, 'landed'); assert.equal(it.landed_via, 're-derived#1');
});

test('a cheat is rejected and re-derived by someone else', async () => {
  const { engine } = setup(s2);
  const a = await engine.proposeIntent('agent-a', negIntent);
  work(a.claim, { 'src/format.js': goodFormat }, ['test/cart.test.js']);
  engine.submit('agent-a', a.claim.claimId); await engine.processQueue();
  const it = engine.getIntent(a.intentId);
  assert.equal(it.state, 'rederive'); assert.equal(it.last_failure.verdict, 'rejected');
});

test('contract change breaks a landed intent → dependent re-derived on top → both land together', async () => {
  const day2 = join(SP, 's3-relay', 'base-day2');
  const { intents } = await import(new URL(`file:///${join(SP, 's3-relay', 'intents-day2.mjs').replace(/\\/g, '/')}`));
  const by = Object.fromEntries(intents.map((i) => [i.id, i]));
  const { engine, events } = setup(day2, { examine: true });
  // an examiner (agent-x) writes hidden tests for each job and rules on any change to an existing test
  const examine = async (verdicts = {}) => { const { claim: x } = await engine.claim('agent-x', { kind: 'examine' }); const id = x.intent.id;
    await engine.submitTests('agent-x', x.claimId, { [`test/exam-${id}.test.js`]: id === 'checkout' ? by.checkout.hidden : tp.hidden }, verdicts); };
  const tp = by['tax-percent'];
  const co = await engine.proposeIntent('agent-a', { id: 'checkout', goal: by.checkout.goal, allowed: ['src/checkout.js'], tests: { 'test/intent-checkout.test.js': by.checkout.frozen } });
  await examine();
  work(co.claim, { 'src/checkout.js': "import { total } from './cart.js';\nimport { withTax } from './tax.js';\nimport { shipping } from './shipping.js';\nexport const checkout = (items, taxRate) => Math.round((withTax(total(items), taxRate) + shipping(items)) * 100) / 100;\n" });
  engine.submit('agent-a', co.claim.claimId); await engine.processQueue();
  assert.equal(engine.getIntent('checkout').state, 'landed');

  // the contract change rewrites two EXISTING tests: only through supersedes, approved by the examiner
  const tax = await engine.proposeIntent('agent-b', { id: 'tax-percent', goal: tp.goal, allowed: ['src/tax.js'], tests: { 'test/intent-tax-percent.test.js': tp.frozen },
    supersedes: { 'test/intent-tax.test.js': tp.frozen, 'test/intent-tax.hidden.test.js': tp.hidden } });
  const t = tree(day2)['src/tax.js'].replace('withTax(amount, rate)', 'withTax(amount, ratePercent)').replace('rate < 0', 'ratePercent < 0').replace('(1 + rate)', '(1 + ratePercent / 100)');
  work(tax.claim, { 'src/tax.js': t });
  engine.submit('agent-b', tax.claim.claimId);
  await examine({ 'test/intent-tax.test.js': { verdict: 'approve', reason: 'rate becomes a percentage' }, 'test/intent-tax.hidden.test.js': { verdict: 'approve', reason: 'same' } });
  await engine.processQueue();
  assert.equal(engine.getIntent('tax-percent').state, 'waiting-on-dependents');
  assert.equal(engine.getIntent('checkout').state, 'dependent');
  // the staging fork's URL carries a write token: it never leaves the engine
  assert.doesNotMatch(String(engine.getIntent('checkout', 'agent-z').staged_for), /forkUrl|x:/);

  const { claim } = await engine.claim('agent-c');
  assert.equal(claim.kind, 'dependent'); assert.match(claim.context.why, /tax-percent/);
  work(claim, { 'src/checkout.js': "import { total } from './cart.js';\nimport { withTax } from './tax.js';\nimport { shipping } from './shipping.js';\nexport const checkout = (items, taxRate) => Math.round((withTax(total(items), taxRate * 100) + shipping(items)) * 100) / 100;\n" });
  engine.submit('agent-c', claim.claimId); await engine.processQueue();
  assert.equal(engine.getIntent('tax-percent').state, 'landed');
  assert.equal(engine.getIntent('checkout').state, 'landed');
  assert.ok(events.some((e) => e.type === 'dependent.detected' && e.intent === 'checkout'));
  assert.deepEqual(events.filter((e) => e.type === 'land.landed').at(-1).data.together, ['tax-percent', 'checkout']);
});

test('registered tests always run: an agent cannot drop them from its fork', async () => {
  const { engine } = setup(s2);
  const a = await engine.proposeIntent('agent-a', negIntent);
  // hand in a token change WITHOUT the registered test and without doing the work
  const w = join(ROOT, `agent-${++n}`); git(ROOT, 'clone', '-q', a.claim.fork.remote, w);
  writeFileSync(join(w, 'src/format.js'), readFileSync(join(w, 'src/format.js'), 'utf8') + '// touched\n');
  git(w, 'commit', '-qam', 'token change'); git(w, 'push', '-q', 'origin', 'HEAD:main');
  engine.submit('agent-a', a.claim.claimId); await engine.processQueue();
  const it = engine.getIntent(a.intentId);
  assert.equal(it.state, 'rederive'); assert.equal(it.last_failure.verdict, 'red');
  assert.ok(it.last_failure.failing.includes('test/negative-money.test.js'));
});

test('examiner: a different agent writes hidden tests blind; the author waits; landing uses them', async () => {
  const { engine, events } = setup(s2, { examine: true });
  const a = await engine.proposeIntent('agent-a', negIntent);
  // the author can't examine itself, and gets nothing to examine
  assert.equal((await engine.claim('agent-a', { kind: 'examine' })).claim, null);
  work(a.claim, { 'src/format.js': goodFormat });
  const sub = engine.submit('agent-a', a.claim.claimId);
  assert.equal(sub.waitingForExaminer, true);
  assert.equal(engine.getIntent(a.intentId).state, 'awaiting-examiner');

  const { claim: x } = await engine.claim('agent-x'); // next job on the board is the examination
  assert.equal(x.kind, 'examine'); assert.equal(x.intent.tests, undefined); // never sees the author's tests
  const passing = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('positive', () => assert.equal(formatMoney(2), '$2.00'));\n";
  await assert.rejects(engine.submitTests('agent-x', x.claimId, { 'test/exam-neg.test.js': passing }), /already pass/);
  const hidden = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('negative thousands', () => assert.equal(formatMoney(-1234.5), '-$1,234.50'));\ntest('tiny negative', () => assert.equal(formatMoney(-0.05), '-$0.05'));\n";
  const r = await engine.submitTests('agent-x', x.claimId, { 'test/exam-neg.test.js': hidden });
  assert.equal(r.queuedForLanding, true);
  await engine.processQueue();
  const it = engine.getIntent(a.intentId);
  assert.equal(it.state, 'landed'); assert.equal(it.hiddenTests, 1);
  assert.ok(events.some((e) => e.type === 'examine.done'));
});

test('examiner catches an author whose code passes its own test but not the goal, and the failure stays sealed', async () => {
  const { engine } = setup(s2, { examine: true });
  const a = await engine.proposeIntent('agent-a', negIntent);
  // passes the author's single test (-3.5) but drops thousands separators for negatives
  work(a.claim, { 'src/format.js': "export function formatMoney(amount) {\n  if (amount < 0) return '-$' + Math.abs(amount).toFixed(2);\n  const [whole, frac] = amount.toFixed(2).split('.');\n  return '$' + whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + frac;\n}\n" });
  engine.submit('agent-a', a.claim.claimId);
  const { claim: x } = await engine.claim('agent-x');
  await engine.submitTests('agent-x', x.claimId, { 'test/exam-neg.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('negative thousands', () => assert.equal(formatMoney(-1234.5), '-$1,234.50'));\n" });
  await engine.processQueue();
  const it = engine.getIntent(a.intentId);
  assert.equal(it.state, 'rederive');
  // the rebuilder learns that a hidden test failed, never which assertion or what it printed
  assert.ok(it.last_failure.failing.includes('(hidden test)')); assert.match(it.last_failure.hidden, /sealed/);
  const seen = JSON.stringify(it);
  assert.doesNotMatch(seen, /negative thousands|1,234\.50|exam-neg/);
});

test('a coordinator restart mid-landing recovers the job, and re-landing is idempotent', async () => {
  const { engine, events } = setup(s2);
  engine.artifacts.remove = async () => {}; // a real restart-after-push happens before fork cleanup, so the fork still exists
  const a = await engine.proposeIntent('agent-a', negIntent);
  work(a.claim, { 'src/format.js': goodFormat });
  engine.submit('agent-a', a.claim.claimId);
  // land it, then simulate a restart that lost the reply: the claim is queued again with no queue row
  await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'landed');
  engine.sql.exec("UPDATE claims SET state = 'queued' WHERE id = ?", a.claim.claimId);
  engine.setIntent(a.intentId, { state: 'landing' });
  await engine.processQueue();
  assert.ok(events.some((e) => e.type === 'land.recovered'));
  assert.equal(engine.getIntent(a.intentId).state, 'landed'); // not noop → rebuild
});

test('a retried propose returns the open job, not a duplicate', async () => {
  const { engine } = setup(s2);
  const a = await engine.proposeIntent('agent-a', negIntent);
  const again = await engine.proposeIntent('agent-a', { ...negIntent, goal: 'negative amounts, reworded on retry' });
  assert.equal(again.intentId, a.intentId); assert.equal(again.claim.claimId, a.claim.claimId);
  assert.equal(engine.listIntents().length, 1);
});

test('a rebuild that finds the goal already met is "satisfied", not retried and parked', async () => {
  const { engine, events } = setup(s2);
  const dup = await engine.proposeIntent('agent-a', negIntent);           // first job, abandoned
  const real = await engine.proposeIntent('agent-b', { ...negIntent, allowed: ['src/format.js', 'src/money.js'] }); // same goal, lands
  work(real.claim, { 'src/format.js': goodFormat });
  engine.submit('agent-b', real.claim.claimId); await engine.processQueue();
  engine.release('agent-a', dup.claim.claimId, 'session ended');          // → back on the board as a rebuild
  const { claim } = await engine.claim('agent-c');
  work(claim, {});                                                         // nothing left to do
  engine.submit('agent-c', claim.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(dup.intentId).state, 'satisfied');
  assert.ok(events.some((e) => e.type === 'intent.satisfied'));
});

// A real behaviour change that existing trunk tests pin.
const thousandsOff = "export function formatMoney(amount) {\n  return '$' + amount.toFixed(2);\n}\n";
const cartTestNoThousands = () => readFileSync(join(s2, 'test', 'cart.test.js'), 'utf8').replace("test('formatMoney thousands', () => assert.equal(formatMoney(1234567.5), '$1,234,567.50'));", () => "test('formatMoney plain', () => assert.equal(formatMoney(1234567.5), '$1234567.50'));");
const plainIntent = () => ({ goal: 'formatMoney drops thousands separators (plain digits)', allowed: ['src/format.js'], supersedes: { 'test/cart.test.js': cartTestNoThousands() } });

test('contract change: existing tests updated only after an independent reviewer approves', async () => {
  const { engine, events } = setup(s2, { examine: true });
  const a = await engine.proposeIntent('agent-a', plainIntent());
  assert.ok(a.claim.intent.allowed.includes('test/cart.test.js'));
  work(a.claim, { 'src/format.js': thousandsOff }); // note: the author does NOT edit cart.test.js in its fork
  engine.submit('agent-a', a.claim.claimId);
  const { claim: x } = await engine.claim('agent-x');
  assert.equal(x.reviewTestChanges[0].path, 'test/cart.test.js');
  assert.match(x.reviewTestChanges[0].before, /1,234,567\.50/); assert.match(x.reviewTestChanges[0].after, /1234567\.50/);
  const hidden = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('plain big number', () => assert.equal(formatMoney(1000), '$1000.00'));\n";
  await assert.rejects(engine.submitTests('agent-x', x.claimId, { 'test/exam-plain.test.js': hidden }), /review every proposed change/);
  await engine.submitTests('agent-x', x.claimId, { 'test/exam-plain.test.js': hidden }, { 'test/cart.test.js': { verdict: 'approve', reason: 'the goal removes separators; only that expectation changed' } });
  await engine.processQueue();
  const it = engine.getIntent(a.intentId);
  assert.equal(it.state, 'landed', JSON.stringify(it.last_failure));
  assert.ok(events.some((e) => e.type === 'tests.change-approved'));
});

test('contract change: a denied test change never lands', async () => {
  const { engine, events } = setup(s2, { examine: true });
  const a = await engine.proposeIntent('agent-a', plainIntent());
  work(a.claim, { 'src/format.js': thousandsOff });
  engine.submit('agent-a', a.claim.claimId);
  const { claim: x } = await engine.claim('agent-x');
  const hidden = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('plain big number', () => assert.equal(formatMoney(1000), '$1000.00'));\n";
  const r = await engine.submitTests('agent-x', x.claimId, { 'test/exam-plain.test.js': hidden }, { 'test/cart.test.js': { verdict: 'deny', reason: 'removing separators is not what the product wants' } });
  assert.equal(r.testChanges, 'denied');
  await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'rederive');
  assert.ok(events.some((e) => e.type === 'tests.change-denied'));
});

test('an author whose lease lapsed gets its own job back, not a duplicate', async () => {
  const { engine, tick } = setup(s2);
  const a = await engine.proposeIntent('agent-a', negIntent);
  tick(21 * 60 * 1000); engine.sweep();                       // went quiet while coding
  assert.equal(engine.getIntent(a.intentId).state, 'rederive');
  const back = await engine.proposeIntent('agent-a', negIntent); // comes back and re-registers
  assert.equal(back.intentId, a.intentId); assert.equal(back.resumed, true);
  assert.equal(engine.listIntents().length, 1);
  work(back.claim, { 'src/format.js': goodFormat });
  engine.submit('agent-a', back.claim.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'landed');
});

test('a silent agent loses its lease and the job goes back on the board', async () => {
  const { engine, tick } = setup(s2);
  const a = await engine.proposeIntent('agent-a', negIntent);
  tick(21 * 60 * 1000); engine.sweep();
  assert.equal(engine.getIntent(a.intentId).state, 'rederive');
  assert.equal(engine.status('agent-a', a.claim.claimId).claimState, 'expired');
  await assert.rejects(async () => engine.submit('agent-a', a.claim.claimId), /claim is expired/);
});

test('test budget: a job with more than 5 test cases is refused, for authors and examiners alike', async () => {
  const { engine } = setup(s2, { examine: true });
  const many = "import { test } from 'node:test';\n" + Array.from({ length: 6 }, (_, i) => `test('case ${i}', () => {});\n`).join('');
  await assert.rejects(engine.proposeIntent('agent-a', { ...negIntent, tests: { 'test/many.test.js': many } }), /test budget: 6 test cases/);
  const a = await engine.proposeIntent('agent-a', negIntent);
  const { claim: x } = await engine.claim('agent-x', { kind: 'examine' });
  await assert.rejects(engine.submitTests('agent-x', x.claimId, { 'test/exam-many.test.js': many }), /test budget/);
  assert.equal(engine.getIntent(a.intentId).exam_state, 'claimed');
});

test('the examiner of a job never rebuilds it (it has seen the hidden tests)', async () => {
  const { engine, tick } = setup(s2, { examine: true });
  const a = await engine.proposeIntent('agent-a', negIntent);
  const { claim: x } = await engine.claim('agent-x', { kind: 'examine' });
  const hidden = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('negative', () => assert.equal(formatMoney(-2), '-$2.00'));\n";
  await engine.submitTests('agent-x', x.claimId, { 'test/exam-neg.test.js': hidden });
  tick(21 * 60 * 1000); engine.sweep(); // the author goes silent; the job goes back on the board
  assert.equal(engine.getIntent(a.intentId).state, 'rederive');
  assert.equal((await engine.claim('agent-x')).claim, null);
  await assert.rejects(engine.claim('agent-x', { intentId: a.intentId }), /examiner of a job cannot rebuild it/);
  assert.equal((await engine.claim('agent-y')).claim.kind, 'rederive');
});

test('a security gate that wants a person parks the job instead of rebuilding it', async () => {
  const { engine, events } = setup(s2);
  const a = await engine.proposeIntent('agent-a', { ...negIntent, allowed: ['src/format.js', '.github/workflows/ci.yml'] });
  work(a.claim, { 'src/format.js': goodFormat, '.github/workflows/ci.yml': 'on: push\n' });
  engine.submit('agent-a', a.claim.claimId); await engine.processQueue();
  const it = engine.getIntent(a.intentId);
  assert.equal(it.state, 'parked'); assert.equal(it.last_failure.park.gate, 'protectedPaths');
  assert.equal((await engine.claim('agent-b')).claim, null); // nothing to rebuild
  assert.match(events.find((e) => e.type === 'intent.parked').data.reason, /\.github\/workflows\/ci\.yml/);
});

test('dependency changes declared on the job travel to the lander', async () => {
  const { engine } = setup(s2);
  await assert.rejects(engine.proposeIntent('agent-a', { ...negIntent, deps: [1] }), /deps must be a list/);
  const pkg = { 'package.json': JSON.stringify({ name: 's2', type: 'module', dependencies: { tiny: 'file:./vendor/tiny' } }), 'vendor/tiny/package.json': JSON.stringify({ name: 'tiny', version: '1.0.0' }), 'vendor/tiny/index.js': 'module.exports = 1;\n' };
  const a = await engine.proposeIntent('agent-a', { ...negIntent, allowed: ['src/format.js', ...Object.keys(pkg)], deps: ['tiny'] });
  work(a.claim, { 'src/format.js': goodFormat, ...pkg });
  engine.submit('agent-a', a.claim.claimId); await engine.processQueue();
  const it = engine.getIntent(a.intentId);
  assert.equal(it.state, 'landed', JSON.stringify(it.last_failure)); assert.deepEqual(it.receipt.security.deps.added, ['tiny@file:./vendor/tiny']);
});

// ---- review ----
const finding = (o = {}) => ({ file: 'src/format.js', line: 3, severity: 'high', reason: 'drops the thousands separator for negatives', ...o });
async function toReview(engine, agent = 'agent-a', code = goodFormat) {
  const a = await engine.proposeIntent(agent, negIntent);
  work(a.claim, { 'src/format.js': code });
  engine.submit(agent, a.claim.claimId); await engine.processQueue();
  return a;
}

test('review: a change that passes every gate waits for a reviewer, then lands with the verdict on the receipt', async () => {
  const { engine, events, trunk } = setup(s2, { review: true });
  const a = await toReview(engine);
  assert.equal(engine.getIntent(a.intentId).state, 'awaiting-review');
  assert.equal(engine.status('agent-a', a.claim.claimId).claimState, 'reviewing');
  assert.equal((await engine.claim('agent-a', { kind: 'review' })).claim, null); // never its own
  const { claim: r } = await engine.claim('agent-r'); // review is on the board for anyone else
  assert.equal(r.kind, 'review'); assert.match(r.diff, /Math\.abs/); assert.equal(r.gates.tests, true); assert.equal(r.gates.secrets, true);
  assert.equal(r.fork, undefined); assert.equal(r.intent.tests, undefined);
  const out = await engine.submitReview('agent-r', r.claimId, { verdict: 'pass', findings: [finding({ severity: 'low', reason: 'fine; consider a test for -0' })] });
  assert.equal(out.next, 'landing');
  await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'landed');
  const receipt = JSON.parse(git(trunk, 'show', `main:.cinq/receipts/${a.intentId}.json`));
  assert.equal(receipt.review.by, 'agent-r'); assert.equal(receipt.review.verdict, 'pass'); assert.equal(receipt.review.findings[0].severity, 'low');
  assert.equal(receipt.gates.reviewedCommit, true);
  assert.ok(['review.queued', 'review.passed'].every((t) => events.some((e) => e.type === t)));
});

test('review: never the author, a rebuilder or the examiner of the job', async () => {
  const { engine, tick } = setup(s2, { review: true, examine: true });
  const a = await engine.proposeIntent('agent-a', negIntent);
  const { claim: x } = await engine.claim('agent-x', { kind: 'examine' });
  await engine.submitTests('agent-x', x.claimId, { 'test/exam-neg.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('negative', () => assert.equal(formatMoney(-2), '-$2.00'));\n" });
  tick(21 * 60 * 1000); engine.sweep(); // the author goes quiet; agent-b rebuilds it
  const { claim: b } = await engine.claim('agent-b');
  assert.equal(b.kind, 'rederive');
  work(b, { 'src/format.js': goodFormat }); engine.submit('agent-b', b.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'awaiting-review');
  for (const [who, why] of [['agent-a', /author/], ['agent-b', /built this change/], ['agent-x', /examiner/]]) {
    assert.equal((await engine.claim(who, { kind: 'review' })).claim, null);
    await assert.rejects(engine.claim(who, { intentId: a.intentId, kind: 'review' }), why);
  }
  assert.equal((await engine.claim('agent-r')).claim.kind, 'review');
});

test('review: block → rebuilt with the findings as context → a second block parks it', async () => {
  const { engine, events } = setup(s2, { review: true });
  const a = await toReview(engine);
  const { claim: r1 } = await engine.claim('agent-r');
  assert.equal((await engine.submitReview('agent-r', r1.claimId, { verdict: 'block', findings: [finding()] })).next, 'rebuild');
  assert.equal(engine.getIntent(a.intentId).state, 'rederive');
  await assert.rejects(engine.claim('agent-r', { intentId: a.intentId }), /separation of duties|cannot rebuild/); // the blocking reviewer can't rebuild it
  assert.equal((await engine.claim('agent-r')).claim?.kind === 'rederive', false);
  const { claim: b } = await engine.claim('agent-b');
  assert.equal(b.kind, 'rederive'); assert.equal(b.context.why.verdict, 'review-blocked');
  assert.equal(b.context.why.findings[0].reason, finding().reason); assert.match(b.context.previousAttempt, /Math\.abs/);
  work(b, { 'src/format.js': goodFormat }); engine.submit('agent-b', b.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'awaiting-review');
  assert.equal((await engine.claim('agent-b', { kind: 'review' })).claim, null); // the rebuilder can't review it
  const { claim: r2 } = await engine.claim('agent-s');
  assert.equal((await engine.submitReview('agent-s', r2.claimId, { verdict: 'block', findings: [finding({ line: 0, reason: 'still wrong' })] })).next, 'parked');
  assert.equal(engine.getIntent(a.intentId).state, 'parked');
  assert.match(events.filter((e) => e.type === 'intent.parked').at(-1).data.reason, /blocked by review 2 times/);
});

test('review: advisory mode records a block on the receipt but lands; off skips review', async () => {
  const adv = setup(s2, { review: true, files: { '.cinq/config.json': JSON.stringify({ review: 'advisory' }) } });
  const a = await toReview(adv.engine);
  const { claim: r } = await adv.engine.claim('agent-r');
  await adv.engine.submitReview('agent-r', r.claimId, { verdict: 'block', findings: [finding()] });
  await adv.engine.processQueue();
  assert.equal(adv.engine.getIntent(a.intentId).state, 'landed');
  const receipt = JSON.parse(git(adv.trunk, 'show', `main:.cinq/receipts/${a.intentId}.json`));
  assert.equal(receipt.review.verdict, 'block'); assert.equal(receipt.review.mode, 'advisory');
  const off = setup(s2, { review: true, files: { '.cinq/config.json': JSON.stringify({ review: 'off' }) } });
  const b = await toReview(off.engine);
  assert.equal(off.engine.getIntent(b.intentId).state, 'landed');
});

test('review: a fork pushed to after its review is refused (the landing is pinned to the reviewed commit)', async () => {
  const { engine } = setup(s2, { review: true });
  const a = await toReview(engine);
  const { claim: r } = await engine.claim('agent-r');
  work({ ...a.claim, intent: { ...a.claim.intent, tests: {} } }, { 'src/format.js': goodFormat + '// sneaked in after review\n' });
  await engine.submitReview('agent-r', r.claimId, { verdict: 'pass' });
  await engine.processQueue();
  const it = engine.getIntent(a.intentId);
  assert.equal(it.state, 'rederive'); assert.match(it.last_failure.reason, /changed after review/);
});

test('paths that climb out of the repo, or into .cinq/ or .git/, are refused; ids are always slugs', async () => {
  const { engine } = setup(s2);
  await assert.rejects(engine.proposeIntent('agent-a', { ...negIntent, tests: { 'test/../.cinq/config.json': negTest } }), /plain paths inside the repo/);
  await assert.rejects(engine.proposeIntent('agent-a', { ...negIntent, allowed: ['../outside.js'] }), /plain paths inside the repo/);
  await assert.rejects(engine.proposeIntent('agent-a', { ...negIntent, allowed: ['.cinq/config.json'] }), /plain paths inside the repo/);
  const a = await engine.proposeIntent('agent-a', { ...negIntent, id: '../../package' });
  assert.equal(a.intentId, 'package');
});

test('two agents claiming the same rebuild at once: exactly one gets it', async () => {
  const { engine } = setup(s2);
  const a = await engine.proposeIntent('agent-a', negIntent);
  work(a.claim, { 'src/format.js': "export const formatMoney = () => 'nope';\n" });
  engine.submit('agent-a', a.claim.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'rederive');
  const [x, y] = await Promise.allSettled([engine.claim('agent-b'), engine.claim('agent-c')]);
  const got = [x, y].filter((r) => r.status === 'fulfilled' && r.value.claim);
  assert.equal(got.length, 1, JSON.stringify([x, y].map((r) => r.status === 'fulfilled' ? r.value.note || r.value.claim?.kind : String(r.reason))));
});

test('an infrastructure failure at landing is retried without spending an attempt', async () => {
  const { engine, events } = setup(s2);
  const real = engine.lander.land; let fails = 1;
  engine.lander = { ...engine.lander, land: async (b) => (fails-- > 0 ? { verdict: 'error', stage: 'fetch-candidate', detail: 'artifacts unavailable', gates: {} } : real(b)) };
  const a = await engine.proposeIntent('agent-a', negIntent);
  work(a.claim, { 'src/format.js': goodFormat });
  engine.submit('agent-a', a.claim.claimId); await engine.processQueue();
  const it = engine.getIntent(a.intentId);
  assert.equal(it.state, 'landed'); assert.equal(it.attempts || 0, 0);
  assert.ok(events.some((e) => e.type === 'land.retry'));
});

test('a contract change that breaks two landed jobs parks for a person instead of looping', async () => {
  const { engine, events } = setup(s2);
  engine.lander = { ...engine.lander, land: async () => ({ verdict: 'breaks-dependents', dependents: ['one', 'two'], failing: ['test/one.test.js', 'test/two.test.js'], gates: {} }) };
  const a = await engine.proposeIntent('agent-a', negIntent);
  work(a.claim, { 'src/format.js': goodFormat });
  engine.submit('agent-a', a.claim.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'parked');
  assert.ok(events.some((e) => e.type === 'intent.parked' && /breaks 2 landed jobs/.test(e.data.reason)));
});

test('an agent proposing a job is told who else is already changing the same files', async () => {
  const { engine, events } = setup(s2);
  const a = await engine.proposeIntent('agent-a', negIntent);
  const b = await engine.proposeIntent('agent-b', { goal: 'formatMoney rounds half up', allowed: ['src/format.js'], tests: { 'test/round.test.js': negTest.replace(/negative amounts/g, 'rounding') } });
  assert.equal(b.overlaps.length, 1);
  assert.deepEqual(b.overlaps[0].files, ['src/format.js']); assert.equal(b.overlaps[0].job, a.intentId); assert.equal(b.overlaps[0].agent, 'agent-a');
  assert.ok(events.some((e) => e.type === 'intent.overlap'));
  const listed = engine.listIntents().find((i) => i.id === a.intentId);
  assert.deepEqual(listed.files, ['src/format.js']); assert.equal(listed.holder, 'agent-a');
});

test("hidden tests that the repo's runner never executes are refused", async () => {
  const { engine } = setup(s2, { examine: true });
  const a = await engine.proposeIntent('agent-a', negIntent);
  const { claim: x } = await engine.claim('agent-x');
  // e.g. a vitest repo whose config only picks up src/**/*.test.ts: the file loads nowhere, so 0 cases run
  const real = engine.lander.check; engine.lander = { ...engine.lander, check: async (b) => ({ ...(await real(b)), testsRun: 0, failsOnTrunk: true }) };
  await assert.rejects(engine.submitTests('agent-x', x.claimId, { 'test/exam-neg.test.js': negTest }), /did not run/);
  assert.equal(engine.getIntent(a.intentId).exam_state, 'claimed');
});

test('a person decides a parked job: approve lands that exact commit past the one gate; retry and drop', async () => {
  const { engine, events, trunk } = setup(s2);
  const a = await engine.proposeIntent('agent-a', { ...negIntent, allowed: ['src/format.js', '.github/workflows/ci.yml'] });
  work(a.claim, { 'src/format.js': goodFormat, '.github/workflows/ci.yml': 'on: push\n' });
  engine.submit('agent-a', a.claim.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'parked');
  await assert.rejects(engine.decide(a.intentId, 'land-it', 'owner'), /approve, retry or drop/);
  const d = await engine.decide(a.intentId, 'approve', 'owner', 'CI change is fine');
  assert.equal(d.gate, 'protectedPaths');
  await engine.processQueue();
  const it = engine.getIntent(a.intentId);
  assert.equal(it.state, 'landed', JSON.stringify(it.last_failure));
  const receipt = JSON.parse(git(trunk, 'show', `main:.cinq/receipts/${a.intentId}.json`));
  assert.equal(receipt.approvedByPerson[0].gate, 'protectedPaths'); assert.equal(receipt.approvedByPerson[0].by, 'owner');
  assert.ok(events.some((e) => e.type === 'intent.approved'));
  await assert.rejects(engine.decide(a.intentId, 'approve', 'owner'), /not parked/);

  // a job parked for failing twice can't be waved through, only sent back or dropped
  const { engine: e2 } = setup(s2);
  const b = await e2.proposeIntent('agent-a', negIntent);
  e2.setIntent(b.intentId, { state: 'parked', last_failure: { verdict: 'red' } });
  await assert.rejects(e2.decide(b.intentId, 'approve', 'owner'), /only a job parked by a security gate/);
  assert.equal((await e2.decide(b.intentId, 'retry', 'owner', 'use whole cents')).decided, 'retry');
  assert.equal(e2.getIntent(b.intentId).state, 'rederive'); assert.equal(e2.getIntent(b.intentId).attempts, 0);
  e2.setIntent(b.intentId, { state: 'parked' });
  assert.equal((await e2.decide(b.intentId, 'drop', 'owner')).decided, 'drop');
  assert.equal(e2.getIntent(b.intentId).state, 'rejected');
});

test('an approval is pinned to the commit a person saw: a different commit parks again', async () => {
  const { engine } = setup(s2);
  const a = await engine.proposeIntent('agent-a', { ...negIntent, allowed: ['src/format.js', '.github/workflows/ci.yml'] });
  work(a.claim, { 'src/format.js': goodFormat, '.github/workflows/ci.yml': 'on: push\n' });
  engine.submit('agent-a', a.claim.claimId); await engine.processQueue();
  await engine.decide(a.intentId, 'approve', 'owner');
  work(a.claim, { '.github/workflows/ci.yml': 'on: push\njobs: {}\n' }); // the fork moves after approval
  await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'parked');
});

test('a keep (refactor) job: the examiner pins today\'s behaviour with tests that pass now, and sees the goal only', async () => {
  const { engine } = setup(s2, { examine: true });
  const keep = await engine.proposeIntent('agent-a', { goal: 'formatMoney is split into whole and fraction helpers, same output', allowed: ['src/format.js'], kind: 'keep' });
  const { claim: x } = await engine.claim('agent-x');
  assert.equal(x.kind, 'examine'); assert.match(x.rules.join(' '), /must PASS on today/);
  const seen = engine.getIntent(keep.intentId, 'agent-x');
  assert.equal(seen.tests, undefined); assert.match(seen.note, /goal only/);
  assert.ok(engine.getIntent(keep.intentId).tests); // the owner and everyone else still see them
  const passingToday = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatMoney } from '../src/format.js';\ntest('thousands', () => assert.equal(formatMoney(1234.5), '$1,234.50'));\n";
  await assert.rejects(engine.submitTests('agent-x', x.claimId, { 'test/keep.exam.test.js': negTest }), /must pass on today/);
  await engine.submitTests('agent-x', x.claimId, { 'test/keep.exam.test.js': passingToday });
  assert.equal(engine.getIntent(keep.intentId).exam_state, 'done');
});

test('tests that carry a secret are refused when they are handed in, never at landing', async () => {
  const { engine } = setup(s2);
  const AWS = 'AKIA' + 'Q3EXAMPLE7H2K9LZ';
  await assert.rejects(engine.proposeIntent('agent-a', { ...negIntent, tests: { 'test/negative-money.test.js': negTest + `\n// ${AWS}\n` } }), (e) => e.status === 422 && /looks like a secret/.test(e.message));
  await assert.rejects(engine.proposeIntent('agent-a', { ...negIntent, kind: 'other' }), /kind must be/);
});

const countTest = readFileSync(join(SP, 's2', 'intents', 'i3-item-count', 'frozen.test.js'), 'utf8');
const countIntent = { goal: 'itemCount sums qty across lines', allowed: ['src/cart.js'], tests: { 'test/item-count.test.js': countTest } };
const goodCart = readFileSync(join(s2, 'src', 'cart.js'), 'utf8') + '\nexport function itemCount(items) {\n  return items.reduce((n, i) => n + i.qty, 0);\n}\n';

test('one ask becomes tickets: the asker builds the first, other agents build the rest, a ticket that proves nothing is reported', async () => {
  const { engine, events, tick } = setup(s2);
  const vacuous = { goal: 'total adds lines', allowed: ['src/cart.js'], tests: { 'test/total-again.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/cart.js';\ntest('total', () => assert.equal(total([{ price: 1, qty: 2 }]), 2));\n" } };
  const p = await engine.proposePlan('maya', { ask: 'Money should handle refunds, and the cart needs an item count.', tickets: [negIntent, countIntent, vacuous] });
  assert.equal(p.tickets.length, 3);
  assert.equal(p.tickets[0].state, 'working'); assert.equal(p.claim.kind, 'author');
  assert.equal(p.tickets[1].state, 'open');
  assert.match(p.tickets[2].error, /already pass/);
  const count = p.tickets[1].intentId;
  assert.equal(engine.getIntent(count).ask.text, 'Money should handle refunds, and the cart needs an item count.');
  // the asker wrote the ticket's tests, so it doesn't build it; another agent does, with the whole ask as context
  assert.equal((await engine.claim('maya')).claim, null);
  await assert.rejects(engine.claim('maya', { intentId: count }), /separation of duties/);
  const { claim: b } = await engine.claim('crew-1');
  assert.equal(b.kind, 'build'); assert.equal(b.intent.id, count); assert.match(b.context.ask, /item count/);
  assert.equal(engine.getIntent(count).state, 'building');
  // a builder that goes quiet hands the ticket back as it was: nobody built it, so no attempt is spent
  tick(10 * 60_000); engine.heartbeat('maya', p.claim.claimId); tick(11 * 60_000); engine.sweep(); // maya is still working on hers
  assert.equal(engine.getIntent(count).state, 'open'); assert.equal(engine.getIntent(count).attempts, 0);
  const { claim: b2 } = await engine.claim('crew-2');
  assert.equal(b2.kind, 'build');
  work(b2, { 'src/cart.js': goodCart }); engine.submit('crew-2', b2.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(count).state, 'landed'); assert.equal(engine.getIntent(count).landed_via, 'built');
  work(p.claim, { 'src/format.js': goodFormat }); engine.submit('maya', p.claim.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(p.tickets[0].intentId).state, 'landed');
  assert.deepEqual(engine.asks()[0].tickets.map((t) => t.state), ['landed', 'landed']);
  assert.equal(events.find((e) => e.type === 'ask.planned').data.refused, 1);
  await assert.rejects(engine.proposePlan('maya', { ask: 'x', tickets: [] }), /tickets/);
});

test('house rules: each save is a version; reviews are held to them, cite them, and only matching agents review', async () => {
  const { engine, trunk } = setup(s2, { review: true });
  await assert.rejects(engine.setHouseRules('owner', { rules: ['ok'], reviewers: 'codex; rm' }), /pattern/);
  const v1 = await engine.setHouseRules('owner', { rules: ['Money is integer cents, never floats.', 'Every new branch has a test.'], reviewers: 'codex-*' });
  assert.equal(v1.version, 1); assert.match(v1.hash, /^[0-9a-f]{64}$/);
  assert.equal((await engine.setHouseRules('owner', { rules: ['Money is integer cents, never floats.', 'Every new branch has a test.'], reviewers: 'codex-*' })).unchanged, true);
  const a = await engine.proposeIntent('maya', negIntent);
  work(a.claim, { 'src/format.js': goodFormat }); engine.submit('maya', a.claim.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'awaiting-review');
  // only agents the house rules name may review
  assert.equal((await engine.claim('claude-1', { kind: 'review' })).claim, null);
  await assert.rejects(engine.claim('claude-1', { intentId: a.intentId }), /house rules say only agents matching codex-\*/);
  const { claim: r } = await engine.claim('codex-1', { kind: 'review' });
  assert.equal(r.houseRules.version, 1); assert.equal(r.houseRules.rules[1].text, 'Every new branch has a test.');
  // a finding names the rule it breaks, or 0
  await assert.rejects(engine.submitReview('codex-1', r.claimId, { verdict: 'pass', findings: [finding()] }), /rule must be/);
  await assert.rejects(engine.submitReview('codex-1', r.claimId, { verdict: 'pass', findings: [finding({ rule: 3 })] }), /rule must be/);
  // rules changed mid-review: this review stays held to the version it started with
  await engine.setHouseRules('owner', { rules: ['Only one rule now.'], reviewers: 'codex-*' });
  await engine.submitReview('codex-1', r.claimId, { verdict: 'pass', findings: [finding({ severity: 'low', rule: 2 })], summary: 'Sign handled once; rule 2 nit noted.' });
  await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'landed');
  const receipt = JSON.parse(git(ROOT, '--git-dir', trunk, 'show', `main:.cinq/receipts/${a.intentId}.json`));
  assert.equal(receipt.review.houseRules.version, 1); assert.equal(receipt.review.findings[0].rule, 2);
  const doc = git(ROOT, '--git-dir', trunk, 'show', 'main:.cinq/rules.md');
  assert.match(doc, /version 1/); assert.match(doc, /2\. Every new branch has a test\./); assert.match(doc, /codex-\*/); // the version its review was held to
  assert.equal(engine.rulesHistory().length, 2);
});

test('token usage: a session reports what it spent; the board shows it by role and per landed change', async () => {
  const { engine, tick } = setup(s2);
  const t0 = 1_000_000;
  const a = await engine.proposeIntent('maya', negIntent);
  work(a.claim, { 'src/format.js': goodFormat }); engine.submit('maya', a.claim.claimId); await engine.processQueue();
  tick(60_000);
  assert.equal(engine.recordUsage('maya', { input: 1000, cachedInput: 9000, output: 500, since: t0, until: t0 + 60_000, vendor: 'claude' }).jobs, 1);
  engine.recordUsage('crew-1', { input: 100, output: 10, since: t0, until: t0 + 60_000 }); // a session that found nothing to do
  const u = engine.usage();
  assert.equal(u.landed, 1); assert.equal(u.total.tokens, 10610); assert.equal(u.tokensPerLanded, 10610);
  assert.equal(u.byRole.author.tokens, 10500); assert.equal(u.byRole.other.tokens, 110);
  assert.throws(() => engine.recordUsage('maya', { input: 1 }), /since and until/);
});

test('a retried plan does not duplicate tickets; a ticket nobody started can be dropped', async () => {
  const { engine } = setup(s2);
  const ask = { ask: 'refunds and an item count', tickets: [negIntent, countIntent], build: 'none' };
  const a = await engine.proposePlan('maya', ask);
  const b = await engine.proposePlan('maya', ask);
  assert.deepEqual(b.tickets.map((t) => t.intentId), a.tickets.map((t) => t.intentId));
  assert.equal(engine.listIntents().length, 2);
  await assert.rejects(engine.decide(a.tickets[0].intentId, 'approve', 'owner'), /not parked/);
  assert.equal((await engine.decide(a.tickets[0].intentId, 'drop', 'owner')).decided, 'drop');
  assert.equal(engine.getIntent(a.tickets[0].intentId).state, 'rejected');
});

test('an author whose change was blocked in review cannot take it back by proposing it again', async () => {
  const { engine } = setup(s2, { review: true });
  const a = await toReview(engine);
  const { claim: r } = await engine.claim('agent-r');
  await engine.submitReview('agent-r', r.claimId, { verdict: 'block', findings: [finding()] });
  assert.equal(engine.getIntent(a.intentId).state, 'rederive');
  const again = await engine.proposeIntent('agent-a', negIntent);
  assert.notEqual(again.intentId, a.intentId); // a new job, not the blocked one handed back to its author
  assert.equal(engine.getIntent(a.intentId).state, 'rederive');
});

test("a reviewer's work order carries the spec, the repo's guidelines and the code that uses the change", async () => {
  const { engine } = setup(s2, { review: true, files: { 'AGENTS.md': '# Conventions\nMoney is cents.\n' } });
  const a = await toReview(engine);
  const { claim: r } = await engine.claim('agent-r', { kind: 'review' });
  assert.equal(r.spec.goal, engine.getIntent(a.intentId).goal);
  assert.match(r.guidelines['AGENTS.md'], /Money is cents/);
  assert.ok(Object.keys(r.neighbours).some((f) => f !== 'src/format.js'), JSON.stringify(Object.keys(r.neighbours)));
  assert.match(r.rules.join(' '), /three axes/);
});

test('an approval holds for a rebuild whose protected files are exactly the ones the person approved', async () => {
  const { engine, events, trunk } = setup(s2);
  const ci = 'on: push\n';
  const a = await engine.proposeIntent('agent-a', { ...negIntent, allowed: ['src/format.js', '.github/workflows/ci.yml'] });
  work(a.claim, { 'src/format.js': goodFormat, '.github/workflows/ci.yml': ci });
  engine.submit('agent-a', a.claim.claimId); await engine.processQueue();
  await engine.decide(a.intentId, 'approve', 'owner');
  // main moves under it before it lands: the approved commit no longer merges
  const w = join(ROOT, `mover-${++n}`); git(ROOT, 'clone', '-q', trunk, w);
  writeFileSync(join(w, 'src/format.js'), readFileSync(join(w, 'src/format.js'), 'utf8').replace("const [whole, frac] = amount.toFixed(2).split('.');", "const [whole, frac] = Number(amount).toFixed(2).split('.');"));
  git(w, 'commit', '-qam', 'note'); git(w, 'push', '-q', 'origin', 'HEAD:main');
  await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'rederive');
  // a different agent rebuilds it: other code, the same CI file, so the person's approval still stands
  const { claim: b } = await engine.claim('agent-b');
  work(b, { 'src/format.js': goodFormat, '.github/workflows/ci.yml': ci });
  engine.submit('agent-b', b.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(a.intentId).state, 'landed', JSON.stringify(engine.getIntent(a.intentId).last_failure));
  assert.equal(events.filter((e) => e.type === 'intent.parked').length, 1);
  // and a rebuild that changes a protected file comes back to the person
  const c = await engine.proposeIntent('agent-a', { ...countIntent, allowed: ['src/cart.js', '.github/workflows/ci.yml'] });
  work(c.claim, { 'src/cart.js': goodCart, '.github/workflows/ci.yml': 'on: [push, pull_request]\n' });
  engine.submit('agent-a', c.claim.claimId); await engine.processQueue();
  await engine.decide(c.intentId, 'approve', 'owner');
  // main moves again under it, so it clashes and is rebuilt
  const w2 = join(ROOT, `mover-${++n}`); git(ROOT, 'clone', '-q', trunk, w2);
  writeFileSync(join(w2, 'src/cart.js'), readFileSync(join(w2, 'src/cart.js'), 'utf8') + '\nexport const itemCountLabel = (n) => `${n} items`;\n');
  git(w2, 'commit', '-qam', 'label'); git(w2, 'push', '-q', 'origin', 'HEAD:main');
  await engine.processQueue();
  assert.equal(engine.getIntent(c.intentId).state, 'rederive');
  const { claim: d } = await engine.claim('agent-c');
  work(d, { 'src/cart.js': goodCart + '\nexport const itemCountLabel = (n) => `${n} items`;\n', '.github/workflows/ci.yml': 'on: [push, pull_request]\njobs: {}\n' });
  engine.submit('agent-c', d.claimId); await engine.processQueue();
  assert.equal(engine.getIntent(c.intentId).state, 'parked', JSON.stringify(events.filter((e) => e.intent === c.intentId).map((e) => [e.type, e.data?.verdict, e.data?.gate, e.data?.kind])));
});
