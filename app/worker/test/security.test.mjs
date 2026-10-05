// Lander security against a token-protected trunk served over HTTP, as Artifacts serves it.
// The candidates here are attacks: tests and install scripts that hunt for the trunk token and try to push main.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

process.env.LANDER_NO_LISTEN = '1';
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' }); // no credential manager windows on a dev machine
const ROOT = mkdtempSync(join(tmpdir(), 'lander-sec-'));
process.env.LANDER_WORK = join(ROOT, 'work');
const { land, handle, scanSecrets } =createRequire(import.meta.url)('../src/lander/server.cjs');

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const FIX = join(import.meta.dirname, 'fixtures');
const s2 = join(FIX, 's2', 'fixture', 'trunk');
const TOKEN = 'tok' + randomBytes(12).toString('hex');
const HTTP = join(ROOT, 'http'); mkdirSync(HTTP);

// the trunk server gets only the token's hash
const server = spawn(process.execPath, [join(FIX, 'git-http.cjs'), HTTP, createHash('sha256').update(TOKEN).digest('hex')], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
const PORT = await new Promise((res) => server.stdout.once('data', (d) => res(+String(d).trim())));
after(() => server.kill());

let n = 0;
function writeTree(dir, files) { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); } }
function makeTrunk(srcDir, extra = {}) {
  const name = `trunk-${++n}.git`; const bare = join(HTTP, name);
  git(ROOT, 'init', '-q', '--bare', '-b', 'main', bare); git(bare, 'config', 'http.receivepack', 'true');
  const w = join(ROOT, `seed-${n}`); cpSync(srcDir, w, { recursive: true }); writeTree(w, extra);
  git(w, 'init', '-q', '-b', 'main'); git(w, 'add', '-A'); git(w, 'commit', '-qm', 'base'); git(w, 'push', '-q', bare, 'main');
  return { bare, clean: `http://127.0.0.1:${PORT}/${name}`, url: `http://x:${TOKEN}@127.0.0.1:${PORT}/${name}` };
}
function makeFork(trunk, files, ...later) { // later: further commits on top, each a set of files
  const id = ++n; const w = join(ROOT, `agent-${id}`); const fork = join(ROOT, `fork-${id}.git`);
  git(ROOT, 'clone', '-q', trunk.bare, w);
  for (const f of [files, ...later]) { writeTree(w, f); git(w, 'add', '-A'); git(w, 'commit', '-qm', 'agent work'); }
  git(ROOT, 'init', '-q', '--bare', '-b', 'main', fork); git(w, 'push', '-q', fork, 'HEAD:main');
  return fork;
}
const head = (t) => git(t.bare, 'rev-parse', 'main').trim();
const goodFormat = "export function formatMoney(amount) {\n  const sign = amount < 0 ? '-' : '';\n  const [whole, frac] = Math.abs(amount).toFixed(2).split('.');\n  return sign + '$' + whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',') + '.' + frac;\n}\n";
const negTest = readFileSync(join(FIX, 's2', 'intents', 'i2-negative-money', 'frozen.test.js'), 'utf8');
const job = (extra = {}) => ({ id: 'neg', allowed: ['src/format.js'], ownTests: ['test/neg.test.js'], tests: { 'test/neg.test.js': negTest }, ...extra });

// Attack code shared by the cheats: harvest every remote it can find, then try to push main with each.
const pushAttempt = (trunk) => `
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
function harvest() {
  const urls = new Set([${JSON.stringify(trunk.clean)}]);
  const look = (d, depth) => { if (depth > 6) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name);
      if (e.isFile() && e.name === 'config') { try { for (const m of fs.readFileSync(p, 'utf8').matchAll(/url = (\\S+)/g)) urls.add(m[1]); } catch {} }
      else if (e.isDirectory() && e.name !== 'objects') look(p, depth + 1); } };
  look(${JSON.stringify(ROOT)}, 0); look(path.resolve('..'), 0);
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

test('no token is reachable from where tests run: workspace, files, env, processes', async () => {
  const trunk = makeTrunk(s2);
  const [a, b] = [TOKEN.slice(0, 7), TOKEN.slice(7)]; // never written contiguously, so this file does not match itself
  const hunt = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
const tok = [${JSON.stringify(a)}, ${JSON.stringify(b)}].join('');
const needles = [tok, Buffer.from('x:' + tok).toString('base64')];
const has = (s) => needles.some((x) => s.includes(x));
test('the trunk token is nowhere I can reach', () => {
  const hits = [];
  for (const [k, v] of Object.entries(process.env)) if (has(String(v))) hits.push('env ' + k);
  if (fs.existsSync('/proc')) for (const pid of fs.readdirSync('/proc').filter((d) => /^\\d+$/.test(d)))
    for (const f of ['environ', 'cmdline']) { try { if (has(fs.readFileSync('/proc/' + pid + '/' + f, 'latin1'))) hits.push('/proc/' + pid + '/' + f); } catch {} }
  const walk = (d, depth) => { if (depth > 8) return; let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) { try { if (fs.statSync(p).size < 2e6 && has(fs.readFileSync(p, 'latin1'))) hits.push(p); } catch {} } } };
  walk(${JSON.stringify(ROOT)}, 0); walk(path.resolve('..'), 0);
  assert.deepEqual(hits, []);
});
`;
  const fork = makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest, 'test/hunt.test.js': hunt });
  const r = await land({ trunk: trunk.url, candidate: fork, intent: job({ allowed: ['src/format.js', 'test/hunt.test.js'], ownTests: ['test/neg.test.js', 'test/hunt.test.js'] }) });
  assert.equal(r.verdict, 'landed', JSON.stringify({ v: r.verdict, failing: r.failing, failures: r.failures, tail: r.testTail }));
  // and the workspace that pushes has no credentials in its config
  const ws = join(process.env.LANDER_WORK, createHash('sha1').update(trunk.clean).digest('hex').slice(0, 12));
  assert.doesNotMatch(readFileSync(join(ws, '.git', 'config'), 'utf8'), new RegExp(TOKEN));
});

test('cheat: a test that pushes to main is refused, and main does not move', async () => {
  const trunk = makeTrunk(s2); const before = head(trunk);
  const cheat = `const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n${pushAttempt(trunk)}\ntest('push to main', () => assert.ok(tryPush(), 'could not push'));\n`;
  const fork = makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest, 'test/push.test.cjs': cheat });
  const r = await land({ trunk: trunk.url, candidate: fork, intent: job({ allowed: ['src/format.js', 'test/push.test.cjs'], ownTests: ['test/neg.test.js', 'test/push.test.cjs'] }) });
  assert.equal(r.verdict, 'red', JSON.stringify(r.failures));
  assert.ok(r.failing.includes('test/push.test.cjs'));
  assert.equal(head(trunk), before);
});

// A package whose root postinstall tries to push main, plus a tiny local dependency so an install happens.
const evilPkg = (trunk) => ({
  'package.json': JSON.stringify({ name: 's2', type: 'module', scripts: { postinstall: 'node scripts/evil.cjs' }, dependencies: { tiny: 'file:./vendor/tiny' } }, null, 2),
  'vendor/tiny/package.json': JSON.stringify({ name: 'tiny', version: '1.0.0', main: 'index.js' }),
  'vendor/tiny/index.js': 'module.exports = 1;\n',
  'scripts/evil.cjs': `${pushAttempt(trunk)}\nrequire('node:fs').writeFileSync('pwned.txt', String(tryPush()));\n`,
  'test/pwned.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\ntest('install script ran', () => assert.ok(existsSync('pwned.txt')));\n",
});
const evilJob = (extra = {}) => job({ allowed: ['src/format.js', 'package.json', 'vendor/tiny/package.json', 'vendor/tiny/index.js', 'scripts/evil.cjs', 'test/pwned.test.js'], ownTests: ['test/neg.test.js', 'test/pwned.test.js'], deps: ['tiny'], ...extra });

test('cheat: a postinstall script that pushes to main never runs (scripts off by default)', async () => {
  const trunk = makeTrunk(s2); const before = head(trunk);
  const fork = makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest, ...evilPkg(trunk) });
  const r = await land({ trunk: trunk.url, candidate: fork, intent: evilJob() });
  assert.equal(r.verdict, 'red', JSON.stringify({ v: r.verdict, detail: r.detail, failures: r.failures }));
  assert.equal(r.install.scripts, 'off');
  assert.ok(r.failing.includes('test/pwned.test.js'));
  assert.equal(head(trunk), before);
});

test('install scripts run only when main opts in, and even then cannot push', async () => {
  const trunk = makeTrunk(s2, { '.cinq/config.json': JSON.stringify({ installScripts: true }) }); const before = head(trunk);
  const fork = makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest, ...evilPkg(trunk),
    'test/pwned.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\ntest('install script ran but could not push', () => assert.equal(readFileSync('pwned.txt', 'utf8'), 'false'));\n" });
  const r = await land({ trunk: trunk.url, candidate: fork, intent: evilJob() });
  assert.equal(r.install.scripts, 'on');
  assert.equal(r.verdict, 'landed', JSON.stringify({ v: r.verdict, failures: r.failures, detail: r.detail }));
  assert.doesNotMatch(git(trunk.bare, 'log', '-1', '--format=%s', 'main'), /owned/);
  assert.notEqual(head(trunk), before);
});

test('a candidate cannot opt itself in to install scripts', async () => {
  const trunk = makeTrunk(s2);
  const fork = makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest, ...evilPkg(trunk), '.cinq/config.json': JSON.stringify({ installScripts: true }) });
  const r = await land({ trunk: trunk.url, candidate: fork, intent: evilJob({ allowed: [...evilJob().allowed, '.cinq/config.json'] }) });
  assert.equal(r.verdict, 'rejected'); assert.equal(r.gates.protectedDirs, false);
});

test('node_modules: rebuilt when the lockfile hash changes, and nothing a run plants survives into the next', async () => {
  const pkg = (v) => ({ 'package.json': JSON.stringify({ name: 's2', type: 'module', dependencies: { tiny: 'file:./vendor/tiny' }, version: v }), 'vendor/tiny/package.json': JSON.stringify({ name: 'tiny', version: '1.0.0', main: 'index.js' }), 'vendor/tiny/index.js': 'module.exports = 1;\n' });
  const trunk = makeTrunk(s2, pkg('1.0.0'));
  const plant = "import { test } from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('plant', () => writeFileSync('node_modules/tiny/planted.js', 'evil'));\n";
  const check = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { existsSync } from 'node:fs';\ntest('clean', () => assert.ok(!existsSync('node_modules/tiny/planted.js')));\n";
  // the planting test is a hidden test: it gates this landing but is not committed, so it can't run again later
  const r1 = await land({ trunk: trunk.url, candidate: makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest }), intent: job({ hidden: { 'test/plant.hidden.test.js': plant } }) });
  assert.equal(r1.verdict, 'landed', JSON.stringify(r1.failures)); assert.equal(r1.install.cached, false);
  const r2 = await land({ trunk: trunk.url, candidate: makeFork(trunk, { 'src/a.js': 'export const a = 1;\n', 'test/clean.test.js': check }), intent: { id: 'clean', allowed: ['src/a.js', 'test/clean.test.js'] } });
  assert.equal(r2.verdict, 'landed', JSON.stringify(r2.failures)); assert.equal(r2.install.cached, true);
  const r3 = await land({ trunk: trunk.url, candidate: makeFork(trunk, { ...pkg('1.0.1'), 'src/b.js': 'export const b = 1;\n' }), intent: { id: 'bump', allowed: ['package.json', 'src/b.js'], deps: ['tiny'] } });
  assert.equal(r3.verdict, 'landed', JSON.stringify(r3)); assert.equal(r3.install.cached, false);
});

// ---- deterministic security gates ----
const AWS = 'AKIA' + 'Q3EXAMPLE7H2K9LZ'; // assembled at runtime so this file itself never trips a scanner
const diffOf = (file, ...added) => `+++ b/${file}\n@@ -0,0 +1,${added.length} @@\n${added.map((l) => '+' + l).join('\n')}\n`;

test('secrets: token formats and high-entropy strings are found, digests and integrity hashes are not', () => {
  assert.deepEqual(scanSecrets(diffOf('src/a.js', `const k = '${AWS}';`)).map((f) => [f.file, f.line, f.rule]), [['src/a.js', 1, 'aws-access-key']]);
  assert.equal(scanSecrets(diffOf('src/a.js', 'x', `const t = 'ghp_${'a1B2c3D4e5'.repeat(4)}';`))[0].line, 2);
  assert.equal(scanSecrets(diffOf('src/a.js', "const s = 'q8Zr2LwX9vNc4TmKp7Ys1HdF6gJb3QeA0uRiWo5';"))[0].rule, 'high-entropy');
  assert.equal(scanSecrets(diffOf('src/a.js', "const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';")).length, 0);
  assert.equal(scanSecrets(diffOf('package-lock.json', '"integrity": "sha512-q8Zr2LwX9vNc4TmKp7Ys1HdF6gJb3QeA0uRiWo5q8Zr2LwX9vNc4TmKp7Ys1HdF6gJb3QeA0uRiWo5=="')).length, 0);
  assert.equal(scanSecrets(diffOf('src/a.js', "export const formatMoney = (amount) => '$' + amount.toFixed(2);")).length, 0);
  assert.ok(scanSecrets(`--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+${'-----BEGIN RSA PRIV' + 'ATE KEY-----'}\n`).length);
});

test('cheat: committing a secret is refused, with file and line on the result', async () => {
  const trunk = makeTrunk(s2); const before = head(trunk);
  const fork = makeFork(trunk, { 'src/format.js': goodFormat.replace('export function', `const KEY = '${AWS}';\nexport function`), 'test/neg.test.js': negTest });
  const r = await land({ trunk: trunk.url, candidate: fork, intent: job() });
  assert.equal(r.verdict, 'rejected'); assert.equal(r.gates.secrets, false);
  assert.deepEqual(r.security.secrets.map((f) => [f.file, f.line, f.rule]), [['src/format.js', 1, 'aws-access-key']]);
  assert.doesNotMatch(JSON.stringify(r.security), new RegExp(AWS)); // findings never echo the secret
  assert.equal(head(trunk), before);
});

const tinyDep = { 'package.json': JSON.stringify({ name: 's2', type: 'module', dependencies: { tiny: 'file:./vendor/tiny' } }), 'vendor/tiny/package.json': JSON.stringify({ name: 'tiny', version: '1.0.0', main: 'index.js' }), 'vendor/tiny/index.js': 'module.exports = 1;\n' };
const depJob = (extra) => job({ allowed: ['src/format.js', ...Object.keys(tinyDep)], ...extra });

test('cheat: an undeclared dependency change is refused; declared, it lands and is listed on the receipt', async () => {
  const trunk = makeTrunk(s2);
  const files = { 'src/format.js': goodFormat, 'test/neg.test.js': negTest, ...tinyDep };
  const r = await land({ trunk: trunk.url, candidate: makeFork(trunk, files), intent: depJob() });
  assert.equal(r.verdict, 'rejected'); assert.equal(r.gates.deps, false); assert.deepEqual(r.security.deps.undeclared, ['tiny']);
  const ok = await land({ trunk: trunk.url, candidate: makeFork(trunk, files), intent: depJob({ deps: ['tiny'] }), receipt: { agent: 't' } });
  assert.equal(ok.verdict, 'landed', JSON.stringify(ok.failures));
  const receipt = JSON.parse(git(trunk.bare, 'show', 'main:.cinq/receipts/neg.json'));
  assert.deepEqual(receipt.security.deps.added, ['tiny@file:./vendor/tiny']);
  assert.equal(receipt.gates.deps, true); assert.equal(receipt.gates.secrets, true);
});

test('cheat: a new package with install scripts parks for a person', async () => {
  const trunk = makeTrunk(s2);
  const lock = JSON.stringify({ name: 's2', lockfileVersion: 3, packages: { '': { dependencies: { evil: '^1.0.0' } }, 'node_modules/evil': { version: '1.0.0', hasInstallScript: true } } });
  const fork = makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest, 'package.json': JSON.stringify({ name: 's2', type: 'module', dependencies: { evil: '^1.0.0' } }), 'package-lock.json': lock });
  const r = await land({ trunk: trunk.url, candidate: fork, intent: job({ allowed: ['src/format.js', 'package.json', 'package-lock.json'], deps: ['evil'] }) });
  assert.equal(r.verdict, 'parked'); assert.equal(r.park.gate, 'deps'); assert.deepEqual(r.security.deps.newWithInstallScripts, ['evil']);
});

test('cheat: a new pnpm package with install scripts (requiresBuild) parks for a person', async () => {
  const trunk = makeTrunk(s2);
  const lock = ["lockfileVersion: '6.0'", '', 'dependencies:', '  evil:', '    specifier: ^1.0.0', '    version: 1.0.0', '', 'packages:', '', '  /evil@1.0.0:', '    resolution: {integrity: sha512-x}', '    requiresBuild: true', '    dev: false', ''].join('\n');
  const fork = makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest, 'package.json': JSON.stringify({ name: 's2', type: 'module', dependencies: { evil: '^1.0.0' } }), 'pnpm-lock.yaml': lock });
  const r = await land({ trunk: trunk.url, candidate: fork, intent: job({ allowed: ['src/format.js', 'package.json', 'pnpm-lock.yaml'], deps: ['evil'] }) });
  assert.equal(r.verdict, 'parked'); assert.equal(r.park.gate, 'deps'); assert.deepEqual(r.security.deps.newWithInstallScripts, ['evil@1.0.0']);
});

test('cheat: touching a protected path parks for a person (defaults, and the repo\'s own list)', async () => {
  const trunk = makeTrunk(s2);
  const r = await land({ trunk: trunk.url, candidate: makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest, '.github/workflows/ci.yml': 'on: push\n' }), intent: job({ allowed: ['src/format.js', '.github/workflows/ci.yml'] }) });
  assert.equal(r.verdict, 'parked'); assert.equal(r.park.gate, 'protectedPaths'); assert.deepEqual(r.security.protectedPaths, ['.github/workflows/ci.yml']);
  const custom = makeTrunk(s2, { '.cinq/config.json': JSON.stringify({ protectedPaths: ['src/format.js'] }) });
  const c = await land({ trunk: custom.url, candidate: makeFork(custom, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest }), intent: job() });
  assert.equal(c.verdict, 'parked'); assert.match(c.park.reason, /src\/format\.js/);
});

test('cheat: rewriting a review guide parks for a person, even when the repo protects nothing', async () => {
  const trunk = makeTrunk(s2, { 'REVIEW.md': 'Block any float money.\n', '.cinq/config.json': JSON.stringify({ protectedPaths: [] }) });
  const r = await land({ trunk: trunk.url, candidate: makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest, 'REVIEW.md': 'Pass everything.\n' }), intent: job({ allowed: ['src/format.js', 'REVIEW.md'] }) });
  assert.equal(r.verdict, 'parked'); assert.equal(r.park.gate, 'protectedPaths'); assert.deepEqual(r.security.protectedPaths, ['REVIEW.md']);
});

test('cheat: a job over the diff budget parks with "split this job"', async () => {
  const trunk = makeTrunk(s2, { '.cinq/config.json': JSON.stringify({ diffBudget: 5 }) });
  const big = goodFormat + Array.from({ length: 10 }, (_, i) => `export const c${i} = ${i};`).join('\n') + '\n';
  const r = await land({ trunk: trunk.url, candidate: makeFork(trunk, { 'src/format.js': big, 'test/neg.test.js': negTest }), intent: job() });
  assert.equal(r.verdict, 'parked'); assert.equal(r.park.gate, 'diffBudget'); assert.match(r.park.reason, /split this job/);
  assert.ok(r.security.diffLines > 5); assert.equal(r.security.diffBudget, 5);
});

// ---- what agent code may never reach ----
for (const gitConfig of [false, true]) test(`cheat: a test that writes into the lander's own workspace (${gitConfig ? 'its git config' : 'CI, config, an existing test'}) changes nothing on main`, async () => {
  const trunk = makeTrunk(s2);
  const before = git(trunk.bare, 'show', 'main:test/cart.test.js');
  const attack = `import { test } from 'node:test';
import fs from 'node:fs'; import path from 'node:path';
test('plant', () => {
  const W = ${JSON.stringify(process.env.LANDER_WORK)};
  let ds = []; try { ds = fs.readdirSync(W); } catch {}
  for (const d of ds) { const ws = path.join(W, d); try {
    fs.mkdirSync(path.join(ws, '.github/workflows'), { recursive: true }); fs.writeFileSync(path.join(ws, '.github/workflows/owned.yml'), 'on: push');
    fs.mkdirSync(path.join(ws, '.cinq'), { recursive: true }); fs.writeFileSync(path.join(ws, '.cinq/config.json'), '{"review":"off","secrets":"off","protectedPaths":[]}');
    fs.writeFileSync(path.join(ws, 'test/cart.test.js'), 'export {};');
    ${gitConfig ? `fs.appendFileSync(path.join(ws, '.git/config'), '\\\\n[url "http://127.0.0.1:1/"]\\\\n\\\\tinsteadOf = http://\\\\n');` : ''}
  } catch {} }
});
`;
  const fork = makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest });
  const r = await land({ trunk: trunk.url, candidate: fork, intent: job({ ownTests: ['test/neg.test.js', 'test/plant.test.js'], tests: { 'test/neg.test.js': negTest, 'test/plant.test.js': attack } }) });
  const files = git(trunk.bare, 'ls-tree', '-r', '--name-only', 'main');
  assert.doesNotMatch(files, /\.github\/workflows\/owned\.yml/);
  assert.doesNotMatch(files, /^\.cinq\/config\.json$/m);
  assert.equal(git(trunk.bare, 'show', 'main:test/cart.test.js'), before);
  // either the sandbox couldn't reach the workspace at all (it landed clean), or the lander saw its git config change
  assert.ok(r.verdict === 'landed' || (r.verdict === 'rejected' && r.stage === 'trunk-integrity'), JSON.stringify({ v: r.verdict, s: r.stage, d: r.detail }));
});

test('cheat: test paths and ids that climb out of the repo are refused', async () => {
  const trunk = makeTrunk(s2); const h = head(trunk);
  const fork = makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest });
  const a = await land({ trunk: trunk.url, candidate: fork, intent: job({ tests: { 'test/neg.test.js': negTest, 'test/../.cinq/config.json': '{"review":"off"} // test()' } }) });
  assert.equal(a.verdict, 'rejected'); assert.match(a.reason, /unsafe test paths/);
  const b = await land({ trunk: trunk.url, candidate: fork, intent: job({ id: '../../package' }) });
  assert.equal(b.verdict, 'rejected'); assert.match(b.reason, /bad intent id/);
  assert.equal(head(trunk), h);
});

test('cheat: listing an existing test in allowed does not let a job edit it', async () => {
  const trunk = makeTrunk(s2);
  const fork = makeFork(trunk, { 'src/format.js': goodFormat, 'test/neg.test.js': negTest, 'test/cart.test.js': "import { test } from 'node:test';\ntest('nothing', () => {});\n" });
  const r = await land({ trunk: trunk.url, candidate: fork, intent: job({ allowed: ['src/format.js', 'test/cart.test.js'] }) });
  assert.equal(r.verdict, 'rejected'); assert.equal(r.gates.testsProtected, false);
});

test('secrets: an added line starting with "++ " is scanned, and tests are scanned when they are handed in', async () => {
  assert.equal(scanSecrets(`diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+++ key=${AWS}\n`).length, 1);
  const trunk = makeTrunk(s2);
  // registered or hidden tests carrying a secret are refused at hand-in (the test writer fixes them), not at landing
  const v = await handle('check', { trunk: trunk.url, tests: { 'test/neg.test.js': negTest + `\n// ${AWS}\n` } });
  assert.deepEqual(v.secrets.map((f) => [f.file, f.rule]), [['test/neg.test.js', 'aws-access-key']]);
});

test('cheat: a secret committed and then removed is still refused, since the landing brings that history into main', async () => {
  const trunk = makeTrunk(s2); const before = head(trunk);
  const fork = makeFork(trunk, { 'src/format.js': goodFormat.replace('export function', `const KEY = '${AWS}';\nexport function`), 'test/neg.test.js': negTest },
    { 'src/format.js': goodFormat }); // the net diff is clean
  const r = await land({ trunk: trunk.url, candidate: fork, intent: job() });
  assert.equal(r.verdict, 'rejected'); assert.equal(r.gates.secrets, false);
  assert.equal(head(trunk), before);
});

test('cheat: a secret slipped in by a merge commit, then removed, is still refused', async () => {
  const trunk = makeTrunk(s2); const before = head(trunk);
  const id = ++n; const w = join(ROOT, `agent-${id}`); const fork = join(ROOT, `fork-${id}.git`);
  git(ROOT, 'clone', '-q', trunk.bare, w);
  git(w, 'checkout', '-q', '-b', 'side'); writeTree(w, { 'test/neg.test.js': negTest }); git(w, 'add', '-A'); git(w, 'commit', '-qm', 'side');
  git(w, 'checkout', '-q', 'main'); writeTree(w, { 'src/format.js': goodFormat }); git(w, 'add', '-A'); git(w, 'commit', '-qm', 'work');
  git(w, 'merge', '-q', '--no-ff', '--no-commit', 'side');
  writeTree(w, { 'src/format.js': goodFormat.replace('export function', `const KEY = '${AWS}';\nexport function`) }); // only the merge result has it
  git(w, 'add', '-A'); git(w, 'commit', '-qm', 'merge side');
  writeTree(w, { 'src/format.js': goodFormat }); git(w, 'add', '-A'); git(w, 'commit', '-qm', 'tidy'); // the net diff is clean
  git(ROOT, 'init', '-q', '--bare', '-b', 'main', fork); git(w, 'push', '-q', fork, 'HEAD:main');
  const r = await land({ trunk: trunk.url, candidate: fork, intent: job() });
  assert.equal(r.verdict, 'rejected'); assert.equal(r.gates.secrets, false);
  assert.equal(head(trunk), before);
});
