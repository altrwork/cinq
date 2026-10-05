// The lander against real git repos on disk (bare repos stand in for Artifacts trunk + forks):
// cheats, conflicts, dependents, zero-tests and flake handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

process.env.LANDER_NO_LISTEN = '1';
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' }); // no credential manager windows on a dev machine
const ROOT = mkdtempSync(join(tmpdir(), 'lander-test-'));
process.env.LANDER_WORK = join(ROOT, 'work');
const { land } = createRequire(import.meta.url)('../src/lander/server.cjs');

const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const FIX = join(import.meta.dirname, 'fixtures');
let n = 0;

function writeTree(dir, files) { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); } }
function makeTrunk(srcDir, extra = {}) {
  const bare = join(ROOT, `trunk-${++n}.git`); git(ROOT, 'init', '-q', '--bare', '-b', 'main', bare);
  const w = join(ROOT, `seed-${n}`); cpSync(srcDir, w, { recursive: true }); writeTree(w, extra);
  git(w, 'init', '-q', '-b', 'main'); git(w, 'add', '-A'); git(w, 'commit', '-qm', 'base'); git(w, 'push', '-q', bare, 'main');
  return bare;
}
// An agent's fork: copy of trunk at `ref`, mutated, pushed to its own bare repo.
function makeFork(trunk, mutate, ref = 'main') {
  const id = ++n; const w = join(ROOT, `agent-${id}`); const fork = join(ROOT, `fork-${id}.git`);
  git(ROOT, 'clone', '-q', trunk, w); git(w, 'checkout', '-q', ref);
  mutate(w);
  git(w, 'add', '-A'); try { git(w, 'commit', '-qm', 'agent work'); } catch {}
  git(ROOT, 'init', '-q', '--bare', '-b', 'main', fork); git(w, 'push', '-q', fork, 'HEAD:main');
  return fork;
}
const read = (w, p) => readFileSync(join(w, p), 'utf8');
const s2 = join(FIX, 's2', 'fixture', 'trunk');
const intentFiles = (id) => join(FIX, 's2', 'intents', id);
const intent = (id, allowed, extra = {}) => ({ id, allowed, ownTests: [`test/intent-${id}.test.js`], hidden: { [`test/intent-${id}.hidden.test.js`]: read(intentFiles(id), 'hidden.test.js') }, ...extra });
const withOwnTest = (id) => (w) => writeFileSync(join(w, `test/intent-${id}.test.js`), read(intentFiles(id), 'frozen.test.js'));
const correctFormat = `export function formatMoney(amount) {
  const sign = amount < 0 ? '-' : '';
  const [whole, frac] = Math.abs(amount).toFixed(2).split('.');
  return sign + '$' + whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + frac;
}
`;
const trunkHead = (bare) => git(bare, 'rev-parse', '--short=7', 'main').trim();
const i2 = () => intent('i2-negative-money', ['src/format.js']);

test('correct change lands, with intent + receipt in the commit', async () => {
  const trunk = makeTrunk(s2); const before = trunkHead(trunk);
  const fork = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), correctFormat); });
  const r = await land({ trunk, candidate: fork, intent: i2(), intentDoc: '# negative money\n', receipt: { agent: 'test' } });
  assert.equal(r.verdict, 'landed', JSON.stringify(r));
  assert.notEqual(trunkHead(trunk), before);
  assert.ok(r.testsRun >= 6);
  const files = git(trunk, 'ls-tree', '-r', '--name-only', 'main');
  assert.match(files, /\.cinq\/receipts\/i2-negative-money\.json/);
  assert.match(files, /\.cinq\/intents\/i2-negative-money\.md/);
  // the examiner's hidden tests gated the landing but are not committed: the receipt records them instead
  assert.doesNotMatch(files, /hidden\.test\.js/);
  const receipt = JSON.parse(git(trunk, 'show', 'main:.cinq/receipts/i2-negative-money.json'));
  assert.equal(receipt.hiddenTests.files, 1); assert.equal(receipt.hiddenTests.passed, true);
});

test('a reviewed change reuses the pre-review test run only when the merged tree is unchanged', async () => {
  const trunk = makeTrunk(s2);
  const fork = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), correctFormat); });
  const pre = await land({ trunk, candidate: fork, intent: i2(), requireReview: 'block' });
  assert.equal(pre.verdict, 'needs-review', JSON.stringify(pre)); assert.match(pre.tree, /^[0-9a-f]{40}$/);
  const reuse = { tree: pre.tree, testsRun: pre.testsRun, runner: pre.runner, flaky: pre.flaky, install: pre.install };
  // main moved after review: the tree differs, so the suite runs again
  assert.equal((await land({ trunk, candidate: makeFork(trunk, (w) => writeFileSync(join(w, 'NOTES.md'), 'x\n')), intent: { id: 'notes', allowed: ['NOTES.md'] } })).verdict, 'landed');
  const moved = await land({ trunk, candidate: fork, intent: i2(), review: { verdict: 'pass', by: 'r' }, expectSha: pre.candidateSha, reuse: { ...reuse } });
  assert.equal(moved.verdict, 'landed', JSON.stringify(moved)); assert.equal(moved.testsReused, undefined);
  // unchanged: reused, and the receipt says the tests ran before review
  const trunk2 = makeTrunk(s2);
  const fork2 = makeFork(trunk2, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), correctFormat); });
  const pre2 = await land({ trunk: trunk2, candidate: fork2, intent: i2(), requireReview: 'block' });
  const r = await land({ trunk: trunk2, candidate: fork2, intent: i2(), review: { verdict: 'pass', by: 'r' }, expectSha: pre2.candidateSha, reuse: { tree: pre2.tree, testsRun: pre2.testsRun, runner: pre2.runner, flaky: pre2.flaky, install: pre2.install } });
  assert.equal(r.verdict, 'landed', JSON.stringify(r)); assert.equal(r.testsReused, true); assert.equal(r.testsRun, pre2.testsRun);
  assert.equal(JSON.parse(git(trunk2, 'show', 'main:.cinq/receipts/i2-negative-money.json')).testsRunBeforeReview, true);
});

test("cheat: a job's own or hidden tests never replace a test already on main; an approved test change may", async () => {
  const trunk = makeTrunk(s2); const before = trunkHead(trunk);
  const fork = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), correctFormat); });
  const weak = "import { test } from 'node:test';\ntest('nothing', () => {});\n";
  for (const job of [{ ...i2(), tests: { 'test/cart.test.js': weak } }, { ...i2(), hidden: { 'test/cart.test.js': weak } }]) {
    const r = await land({ trunk, candidate: fork, intent: job });
    assert.equal(r.verdict, 'parked', JSON.stringify(r)); assert.equal(r.park.gate, 'testsProtected'); assert.match(r.park.reason, /test\/cart\.test\.js/);
    assert.equal(trunkHead(trunk), before);
  }
  const ok = await land({ trunk, candidate: fork, intent: { ...i2(), tests: { 'test/cart.test.js': read(s2, 'test/cart.test.js') + '\n' }, approvedSupersedes: ['test/cart.test.js'] } });
  assert.equal(ok.verdict, 'landed', JSON.stringify(ok));
});

test('cheat: weakening an existing trunk test is rejected', async () => {
  const trunk = makeTrunk(s2);
  const fork = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), correctFormat); writeFileSync(join(w, 'test/cart.test.js'), read(w, 'test/cart.test.js').replace("'$1,234,567.50'", "formatMoney(1234567.5)")); });
  const r = await land({ trunk, candidate: fork, intent: i2() });
  assert.equal(r.verdict, 'rejected'); assert.equal(r.gates.testsProtected, false);
});

test('cheat: hard-coding the test input fails the hidden tests', async () => {
  const trunk = makeTrunk(s2); const before = trunkHead(trunk);
  const fork = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), read(w, 'src/format.js').replace('export function formatMoney(amount) {', "export function formatMoney(amount) {\n  if (amount === -3.5) return '-$3.50';")); });
  const r = await land({ trunk, candidate: fork, intent: i2() });
  assert.equal(r.verdict, 'red'); assert.ok(r.failing.some((f) => f.includes('hidden')), JSON.stringify(r.failing));
  assert.equal(trunkHead(trunk), before);
});

test('cheat: editing a file outside the footprint is rejected', async () => {
  const trunk = makeTrunk(s2);
  const fork = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), correctFormat); writeFileSync(join(w, 'src/money.js'), read(w, 'src/money.js') + '\nexport const x = 1;\n'); });
  const r = await land({ trunk, candidate: fork, intent: i2() });
  assert.equal(r.verdict, 'rejected'); assert.equal(r.gates.footprint, false);
});

test('cheat: deleting a trunk test is rejected', async () => {
  const trunk = makeTrunk(s2);
  const fork = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), correctFormat); rmSync(join(w, 'test/cart.test.js')); });
  const r = await land({ trunk, candidate: fork, intent: i2() });
  assert.equal(r.verdict, 'rejected');
});

test('cheat: touching the platform directory is rejected', async () => {
  const trunk = makeTrunk(s2);
  const fork = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), correctFormat); writeTree(w, { '.cinq/receipts/other.json': '{"forged":true}' }); });
  const r = await land({ trunk, candidate: fork, intent: i2() });
  assert.equal(r.verdict, 'rejected'); assert.equal(r.gates.protectedDirs, false);
});

test('cheat: handing in nothing is a no-op, never a landing', async () => {
  const trunk = makeTrunk(s2);
  const fork = makeFork(trunk, withOwnTest('i2-negative-money'));
  const r = await land({ trunk, candidate: fork, intent: i2() });
  assert.equal(r.verdict, 'noop');
});

test('stale work that collides textually is a conflict (→ re-derive), trunk untouched', async () => {
  const trunk = makeTrunk(s2);
  const stale = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), "export function formatMoney(amount) {\n  return (amount < 0 ? '-$' : '$') + Math.abs(amount).toFixed(2);\n}\n"); });
  const other = makeFork(trunk, (w) => writeFileSync(join(w, 'src/format.js'), correctFormat.replace("'$'", () => "'$' /* landed first */")));
  assert.equal((await land({ trunk, candidate: other, intent: { id: 'other', allowed: ['src/format.js'] } })).verdict, 'landed');
  const before = trunkHead(trunk);
  const r = await land({ trunk, candidate: stale, intent: i2() });
  assert.equal(r.verdict, 'conflict'); assert.equal(trunkHead(trunk), before);
});

test('contract change that breaks a landed intent → breaks-dependents, names it', async () => {
  const base = join(FIX, 's3-relay', 'base-day2');
  const { intents } = await import(new URL(`file:///${join(FIX, 's3-relay', 'intents-day2.mjs').replace(/\\/g, '/')}`));
  const byId = Object.fromEntries(intents.map((i) => [i.id, i]));
  const trunk = makeTrunk(base);
  const checkout = makeFork(trunk, (w) => writeTree(w, { 'src/checkout.js': "import { total } from './cart.js';\nimport { withTax } from './tax.js';\nimport { shipping } from './shipping.js';\nexport const checkout = (items, taxRate) => Math.round((withTax(total(items), taxRate) + shipping(items)) * 100) / 100;\n", 'test/intent-checkout.test.js': byId.checkout.frozen }));
  const ci = { id: 'checkout', allowed: ['src/checkout.js'], ownTests: ['test/intent-checkout.test.js'], hidden: { 'test/intent-checkout.hidden.test.js': byId.checkout.hidden } };
  assert.equal((await land({ trunk, candidate: checkout, intent: ci })).verdict, 'landed');
  const tp = byId['tax-percent'];
  const taxPct = makeFork(trunk, (w) => writeTree(w, {
    'src/tax.js': read(w, 'src/tax.js').replace('withTax(amount, rate)', 'withTax(amount, ratePercent)').replace(/rate < 0/, 'ratePercent < 0').replace('(1 + rate)', '(1 + ratePercent / 100)'),
    'test/intent-tax.test.js': tp.frozen, 'test/intent-tax.hidden.test.js': tp.hidden, 'test/intent-tax-percent.test.js': tp.frozen }));
  // the contract change edits two existing tests: only an APPROVED test change does that, and it arrives as intent.tests
  const r = await land({ trunk, candidate: taxPct, intent: { id: 'tax-percent', allowed: tp.allowed, ownTests: ['test/intent-tax-percent.test.js'], tests: { 'test/intent-tax.test.js': tp.frozen, 'test/intent-tax.hidden.test.js': tp.hidden }, approvedSupersedes: ['test/intent-tax.test.js', 'test/intent-tax.hidden.test.js'], hidden: { 'test/intent-tax-percent.hidden.test.js': tp.hidden } },
    testOwners: { 'test/intent-checkout.test.js': 'checkout', 'test/intent-checkout.hidden.test.js': 'checkout' } });
  assert.equal(r.verdict, 'breaks-dependents', JSON.stringify({ v: r.verdict, failing: r.failing, tail: r.testTail }));
  assert.deepEqual(r.dependents, ['checkout']);
});

test('a repo where zero tests run is never green', async () => {
  const empty = mkdtempSync(join(ROOT, 'notests-')); writeTree(empty, { 'package.json': '{"type":"module"}', 'src/a.js': 'export const a = 1;\n' });
  const trunk = makeTrunk(empty);
  const fork = makeFork(trunk, (w) => writeFileSync(join(w, 'src/a.js'), 'export const a = 2;\n'));
  const r = await land({ trunk, candidate: fork, intent: { id: 'a', allowed: ['src/a.js'] } });
  assert.equal(r.verdict, 'red'); assert.equal(r.testsRun, 0);
});

test('a flaky test gets one re-run, lands, and is reported as flaky', async () => {
  const flag = join(tmpdir(), `cinq-flake-${Date.now()}`); // world-writable: tests may run as an unprivileged user
  const trunk = makeTrunk(s2, { 'test/flaky.test.js': `import { test } from 'node:test';\nimport { existsSync, writeFileSync } from 'node:fs';\ntest('flaky', () => { if (!existsSync(${JSON.stringify(flag)})) { writeFileSync(${JSON.stringify(flag)}, '1'); throw new Error('first run fails'); } });\n` });
  const fork = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), correctFormat); });
  const r = await land({ trunk, candidate: fork, intent: i2() });
  assert.equal(r.verdict, 'landed', JSON.stringify(r)); assert.equal(r.flaky.length, 1);
});

test('installed dependencies are never committed to trunk', async () => {
  const trunk = makeTrunk(s2); // the fixture has no .gitignore
  const fork = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), correctFormat); });
  // simulate an install left in the lander's workspace before landing
  await land({ trunk, candidate: fork, intent: i2(), push: false });
  const ws = join(process.env.LANDER_WORK, readdirSync(process.env.LANDER_WORK).find((d) => existsSync(join(process.env.LANDER_WORK, d, '.git')) && git(join(process.env.LANDER_WORK, d), 'remote', 'get-url', 'origin').trim() === trunk));
  mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(join(ws, 'node_modules', 'pkg', 'index.js'), 'x');
  assert.equal((await land({ trunk, candidate: fork, intent: i2() })).verdict, 'landed');
  assert.doesNotMatch(git(trunk, 'ls-tree', '-r', '--name-only', 'main'), /node_modules/);
});

test('signed landing: the commit on main verifies against the allowed_signers main carries, and the key leaves nothing on disk', async (t) => {
  const kd = mkdtempSync(join(ROOT, 'key-')); const kf = join(kd, 'k');
  try { execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'cinq-test', '-f', kf], { windowsHide: true, stdio: 'ignore' }); } catch { return t.skip('no ssh-keygen here'); }
  const signingKey = readFileSync(kf, 'utf8'); const signingPublic = readFileSync(kf + '.pub', 'utf8').trim(); rmSync(kd, { recursive: true, force: true });
  const trunk = makeTrunk(s2);
  const fork = makeFork(trunk, (w) => { withOwnTest('i2-negative-money')(w); writeFileSync(join(w, 'src/format.js'), correctFormat); });
  const r = await land({ trunk, candidate: fork, intent: i2(), signingKey, signingPublic });
  assert.equal(r.verdict, 'landed', JSON.stringify(r));
  const signers = git(trunk, 'show', 'main:.cinq/allowed_signers'); assert.match(signers, /^lander@cinq\.local namespaces="git" ssh-ed25519 /);
  const sf = join(ROOT, `signers-${n}`); writeFileSync(sf, signers);
  const v = execFileSync('git', ['-c', `gpg.ssh.allowedSignersFile=${sf}`, 'verify-commit', '-v', 'main'], { windowsHide: true, cwd: trunk, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(typeof v, 'string'); // verify-commit exits non-zero on a bad or missing signature
  const left = (d) => readdirSync(d, { withFileTypes: true }).some((e) => e.isDirectory() ? (e.name !== 'objects' && e.name !== 'node_modules' && left(join(d, e.name))) : readFileSync(join(d, e.name), 'utf8').includes('OPENSSH PRIVATE KEY'));
  assert.equal(left(process.env.LANDER_WORK), false);
});
