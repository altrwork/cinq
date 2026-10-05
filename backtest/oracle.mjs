#!/usr/bin/env node
// Backtest step 3: the oracle. No agent ever sees anything this script reads or runs.
//
//   node backtest/oracle.mjs --run backtest/work/<run>/run.json [--node <path to node 22>] [--npm-cli <npm-cli.js>]
//        [--skip-counterfactual] [--o1-at-landing]
//
// Measures these metrics against bars fixed before any run:
//   O1  each real PR's own added/changed test files, taken from upstream's merge commit, run on our final trunk
//   O2  "preserved" tests: test files that existed at base and that no commit in the window changed. Must all pass.
//   O3  upstream's full test-file set at the end of the window, run on our final trunk
//   CF  plain-git counterfactual: the real PR branches (refs/pull/N/head) merged onto base in OUR landing
//       order. Counts textual conflicts, and clean merges whose suite goes red (silent breaks).
// Tests run locally with the manifest's `local` runner config. ASSUMPTION: an npm-test-style suite
// (vitest/jest JSON report, or node --test TAP), the same assumption the lander makes (lib.mjs runSuite).
// Use --node with a Node 22 binary to match the lander's node:22 image.
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { HERE, flag, has, log, die, sh, git, mustGit, readJson, writeJson, sha256, isTestPath, runSuite, install, median, pct, api } from './lib.mjs';

const runPath = resolve(flag('run') || die('usage: node backtest/oracle.mjs --run backtest/work/<run>/run.json'));
const WORK = dirname(runPath);
const RUN = readJson(runPath);
const M = readJson(RUN.manifest.path);
{ const { hash, ...rest } = M; if (sha256(JSON.stringify(rest)) !== hash || hash !== RUN.manifest.hash) die('manifest changed since the run'); }
const EVENTS = readJson(join(WORK, 'events.json'));
const INTENTS = readJson(join(WORK, 'intents.json'));
const FINAL = join(WORK, 'final');
if (!existsSync(FINAL)) die('no final trunk clone in the run folder');
const NODE = flag('node', process.execPath);
const local = { ...M.local, npmCli: flag('npm-cli') };
const nodeVer = sh(process.cwd(), NODE, ['--version']).out.trim();
if (!/^v22\./.test(nodeVer)) log(`! oracle Node is ${nodeVer}; the lander runs node:22. Pass --node <node22> for a like-for-like run.`);
const PRS = M.prs.filter((p) => (RUN.params.only ? RUN.params.only.includes(p.number) : true));
const prOfIntent = Object.fromEntries(Object.entries(RUN.prToIntents || {}).flatMap(([pr, ids]) => ids.map((id) => [id, +pr])));
const intentById = Object.fromEntries(INTENTS.map((i) => [i.id, i]));

// ---------------------------------------------------------------- upstream clone (blobless, cached)
const UP = join(HERE, 'work', '_upstream', M.window);
if (!existsSync(UP)) { mkdirSync(dirname(UP), { recursive: true }); mustGit(dirname(UP), 'clone', '-q', '--filter=blob:none', '--no-checkout', `https://github.com/${M.repo}.git`, UP); }
mustGit(UP, 'fetch', '-q', 'origin', M.base.sha, M.end.sha, ...PRS.map((p) => p.mergeSha));
for (const p of PRS) git(UP, 'fetch', '-q', 'origin', `+refs/pull/${p.number}/head:refs/bt/pr/${p.number}`);
const show = (rev, path) => { const r = git(UP, 'show', `${rev}:${path}`); return r.ok ? r.out : null; };
const lsTests = (rev) => mustGit(UP, 'ls-tree', '-r', '--name-only', rev).split('\n').filter((p) => p && isTestPath(p));

// ---------------------------------------------------------------- oracle checkout of OUR final trunk
const OR = join(WORK, 'oracle');
rmSync(OR, { recursive: true, force: true }); mustGit(WORK, 'clone', '-q', FINAL, OR);
log(`→ installing dependencies in the oracle checkout (${JSON.stringify(local.install)})`); install(OR, local, NODE);
const reset = () => { mustGit(OR, 'checkout', '-q', '--', '.'); git(OR, 'clean', '-fdq', '-e', 'node_modules', '-e', '.yarn'); };
const overlay = (rev, adds, removes = []) => {
  for (const p of adds) { const c = show(rev, p); if (c == null) continue; mkdirSync(dirname(join(OR, p)), { recursive: true }); writeFileSync(join(OR, p), c); }
  for (const p of removes) rmSync(join(OR, p), { force: true });
};

// F0: our final trunk as landed must be green with its own tests.
log('→ F0: final trunk, its own suite');
const F0 = runSuite(OR, local, null, NODE);

// O1: each landed PR's own tests
// Intents map to PRs by author key: each PR's author ran as "bt-pr<N>-<tag>". A PR has landed if ANY of its intents landed.
const TAGRE = /^bt-pr(\d+)-/;
for (const i of INTENTS) { const m = TAGRE.exec(i.author || ''); if (m && !prOfIntent[i.id]) prOfIntent[i.id] = +m[1]; }
const intentsOfPr = (n) => INTENTS.filter((i) => prOfIntent[i.id] === n).map((i) => i.id);
const landedIntentOf = (n) => intentsOfPr(n).map((id) => intentById[id]).filter((i) => i.state === 'landed').at(-1);
const landedPr = (p) => !!landedIntentOf(p.number);
// Ghost duplicates: a PR's extra intents that never landed while a sibling did (a propose retried after a
// client-side timeout). They get their own line and are excluded from the rebuild (M8) and no-op (M11) counts.
const GHOSTS = new Set(PRS.flatMap((p) => (landedPr(p) ? intentsOfPr(p.number).filter((id) => intentById[id].state !== 'landed') : [])));
const ghostRuns = EVENTS.filter((e) => e.type === 'claim.started' && GHOSTS.has(e.intent)).length;
// O1 scores only the test CASES each PR itself added or changed. Upstream's version of a test file at the PR's
// merge commit can also hold cases added by OTHER PRs merged earlier in the window, which a partial replay never
// ran, so a whole-file score would blame this PR for them. Cases are found by diffing the file's it()/test()
// blocks between the PR's parent and its merge commit: a case is the PR's if its title is new, or its body
// changed. Duplicate titles in one file are matched by title (approximation). it.each/test.each titles with
// printf-style (%s, %d) or $name placeholders are matched as patterns. The whole-file score stays as a
// secondary column.
function testBlocks(src) {
  const out = new Map(); if (!src) return out;
  const re = /\b(?:it|test)(?:\.(?:only|skip|concurrent|todo|fails))*(?:\.each\s*(?:\x60[\s\S]*?\x60|\([\s\S]*?\)))?\s*\(\s*(['"\x60])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = re.exec(src))) {
    const title = m[2]; let i = re.lastIndex, depth = 1, q = null;
    for (; i < src.length && depth > 0; i++) { // body = rest of the call up to its matching ')'
      const c = src[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '\x60') q = c; else if (c === '(') depth++; else if (c === ')') depth--;
    }
    const body = src.slice(re.lastIndex, i).replace(/\s+/g, ' ');
    (out.get(title) || out.set(title, []).get(title)).push(body);
  }
  return out;
}
function prCases(rev, file, status) {
  const after = testBlocks(show(rev, file)); const before = status === 'added' ? new Map() : testBlocks(show(rev + '^', file));
  const titles = [];
  for (const [t, bodies] of after) { const b = before.get(t); if (!b || JSON.stringify([...b].sort()) !== JSON.stringify([...bodies].sort())) titles.push(t); }
  return titles;
}
const titleMatcher = (t) => (/%[sdifjo#%]|\$\w+/.test(t) ? new RegExp('^' + t.replace(/[.*+?^{}()|[\]\\]/g, '\\$&').replace(/%[sdifjo#]|\\\$\w+|\$\w+/g, '.*') + '$') : null);
const O1 = [];
for (const p of PRS) {
  if (!landedPr(p)) continue;
  const files = [...p.tests.added, ...p.tests.modified];
  overlay(p.mergeSha, files, p.tests.removed);
  const r = runSuite(OR, local, files, NODE); reset();
  const own = []; const unmatched = [];
  for (const f of files) {
    const status = p.tests.added.includes(f) ? 'added' : 'modified';
    const inFile = r.perTest.filter((t) => t.file.endsWith('/' + f) && ['passed', 'failed'].includes(t.status));
    for (const title of prCases(p.mergeSha, f, status)) {
      const rx = titleMatcher(title);
      const hits = inFile.filter((t) => (rx ? rx.test(t.title) : t.title === title));
      if (!hits.length) unmatched.push(`${f} › ${title}`); else own.push(...hits.map((t) => ({ ...t, file: f })));
    }
  }
  const casesPassed = own.filter((t) => t.status === 'passed').length;
  let atLanding = null;
  if (has('o1-at-landing')) {
    const sha = landedIntentOf(p.number)?.landed_sha;
    if (sha) { mustGit(OR, 'checkout', '-q', sha); overlay(p.mergeSha, files, p.tests.removed); atLanding = runSuite(OR, local, files, NODE); reset(); mustGit(OR, 'checkout', '-q', RUN.finalSha || 'HEAD'); }
  }
  O1.push({ pr: p.number, leaky: p.leakage.flagged, files,
    pass: own.length > 0 && casesPassed === own.length, cases: { passed: casesPassed, total: own.length, unmatched },
    failingCases: own.filter((t) => t.status === 'failed').map((t) => t.name),
    wholeFile: { pass: r.ok, passed: r.passed, total: r.total, failed: r.failed, failing: r.perTest.filter((t) => t.status === 'failed').map((t) => t.name).slice(0, 30) },
    atLanding: atLanding && { pass: atLanding.ok, passed: atLanding.passed, total: atLanding.total },
    classification: null /* behaviour | api-shape | internals | not-expressible */ });
  log(`  O1 #${p.number}: own cases ${casesPassed}/${own.length}${unmatched.length ? ` (${unmatched.length} unmatched)` : ''} · whole file ${r.passed}/${r.total}`);
}

// O2: preserved tests. Unchanged-in-window = existed at base and untouched by ANY commit in base..end.
const changedInWindow = new Set(mustGit(UP, 'diff', '--name-only', M.base.sha, M.end.sha).split('\n').filter(Boolean));
const preserved = lsTests(M.base.sha).filter((p) => !changedInWindow.has(p) && existsSync(join(OR, p)));
const tampered = preserved.filter((p) => show(M.base.sha, p) !== sh(OR, 'git', ['show', `HEAD:${p}`]).out);
log(`→ O2: ${preserved.length} preserved test files${tampered.length ? `, ${tampered.length} CHANGED by agents` : ''}`);
// vitest/jest: filter the F0 full-suite report to the preserved files (no long argument lists on Windows).
// node --test has no per-test file names in TAP, so it re-runs with the explicit file list instead.
const subset = (rep, set) => {
  const rel = (f) => f.replace(/\\/g, '/').replace(OR.replace(/\\/g, '/') + '/', '');
  const ts = rep.perTest.filter((t) => set.has(rel(t.file)) && ['passed', 'failed'].includes(t.status)); // skipped/todo don't count
  return { ok: ts.length > 0 && ts.every((t) => t.status !== 'failed'), total: ts.length, passed: ts.filter((t) => t.status === 'passed').length,
    failingFiles: [...new Set(ts.filter((t) => t.status === 'failed').map((t) => rel(t.file)))] };
};
const O2 = F0.perTest.length ? subset(F0, new Set(preserved)) : runSuite(OR, local, preserved, NODE);

// O3: upstream's whole test-file set at window end, overlaid on our trunk (base-only test files removed).
const endTests = lsTests(M.end.sha);
overlay(M.end.sha, endTests, lsTests(M.base.sha).filter((p) => !endTests.includes(p)));
log(`→ O3: upstream's ${endTests.length} test files at ${M.end.sha.slice(0, 10)}`);
const O3full = runSuite(OR, local, F0.perTest.length ? null : endTests, NODE); reset();
const O3 = O3full.perTest.length ? subset(O3full, new Set(endTests)) : O3full;

// ---------------------------------------------------------------- landing order and the counterfactual
const landings = EVENTS.filter((e) => e.type === 'land.landed');
const order = [...new Set(landings.flatMap((e) => (e.data?.together || [e.intent]).map((id) => prOfIntent[id]).filter(Boolean)))];
for (const p of PRS) if (!order.includes(p.number)) order.push(p.number); // never-landed PRs go last, in merge order
let CF = { order, steps: [], conflicts: 0, silentBreaks: 0, upstreamUpdateMerges: {} };
const cfCache = join(WORK, 'counterfactual.json');
const cached = existsSync(cfCache) && !has('redo-counterfactual') ? readJson(cfCache) : null;
if (cached && JSON.stringify(cached.order) === JSON.stringify(order)) { CF = cached; log(`→ counterfactual: reusing ${cfCache} (same landing order; --redo-counterfactual recomputes)`); }
else if (!has('skip-counterfactual')) {
  const CW = join(WORK, 'counterfactual');
  rmSync(CW, { recursive: true, force: true }); git(UP, 'worktree', 'prune');
  mustGit(UP, 'worktree', 'add', '-q', '--detach', CW, M.base.sha);
  log('→ counterfactual: installing dependencies at base'); install(CW, local, NODE);
  let prevGreen = runSuite(CW, local, null, NODE).ok;
  for (const n of order) {
    const m = git(CW, 'merge', '--no-edit', '-q', `refs/bt/pr/${n}`);
    if (!m.ok) { git(CW, 'merge', '--abort'); CF.conflicts++; CF.steps.push({ pr: n, result: 'textual-conflict' }); log(`  CF #${n}: CONFLICT`); continue; }
    const s = runSuite(CW, local, null, NODE);
    const silent = prevGreen && !s.ok; if (silent) CF.silentBreaks++;
    CF.steps.push({ pr: n, result: s.ok ? 'clean-and-green' : 'clean-merge-but-red', failingFiles: s.failingFiles.slice(0, 10) });
    log(`  CF #${n}: ${s.ok ? 'clean, green' : 'clean merge, RED'}`); prevGreen = s.ok;
  }
  for (const p of PRS) CF.upstreamUpdateMerges[p.number] = +(git(UP, 'rev-list', '--count', '--merges', `refs/bt/pr/${p.number}`, '--not', M.base.sha).out.trim() || 0);
  git(UP, 'worktree', 'remove', '--force', CW);
  writeJson(cfCache, CF);
}

// ---------------------------------------------------------------- E4: examiner tests vs upstream's tests
// Source: GET /api/v1/repos/<repo>/export-tests (owner key only) → per intent: the author's registered
// `tests` and the examiner's `hidden` tests, as {path: content}. Everything below runs on UPSTREAM's code,
// which is ground truth for "correct". For each landed PR, in one upstream worktree at its merge commit:
//   E4a false alarms  examiner tests that FAIL on upstream's correct implementation (per test). Bar <= 15%.
//   E4b strength      deterministic mutants of the PR's added code lines; kill rate of the examiner's tests vs
//                     upstream's own PR tests. Bar: examiner >= 0.8 x upstream. (A mini-mutator, the same
//                     design as the product's mutation gate. StrykerJS is not installed into upstream's tree.)
//   E4c catches       bad realizations = the unchanged base code ("submitted nothing") + single-hunk reverts
//                     (up to 3) + the mutants. Of those upstream's PR tests catch, the share our examiner +
//                     registered tests also catch. Bar >= 90%.
//   Reverse condition: E4a > 25% or E4c < 75% on two of the three repos.
let EXPORT = null;
try { EXPORT = (await api(`repos/${encodeURIComponent(RUN.repo)}/export-tests`)).intents; writeJson(join(WORK, 'export-tests.json'), EXPORT); }
catch (e) { if (existsSync(join(WORK, 'export-tests.json'))) EXPORT = readJson(join(WORK, 'export-tests.json')); else log(`! E4 export unavailable: ${e.message}`); }
const E4 = { prs: [], falseAlarms: 0, hiddenTests: 0, authorFalseAlarms: 0, authorTests: 0, mutants: 0, killedHidden: 0, killedUpstream: 0, bad: 0, caughtUp: 0, caughtBoth: 0 };
const MUTATORS = [[/===/, '!=='], [/!==/, '==='], [/(?<![=!<>])==(?!=)/, '!='], [/ < /, ' >= '], [/ > /, ' <= '], [/ <= /, ' > '], [/ >= /, ' < '], [/&&/, '||'], [/\|\|/, '&&'],
  [/\btrue\b/, 'false'], [/\bfalse\b/, 'true'], [/!(?=[\w(])/, ''], [/\breturn\b(?!\s*;)/, 'return undefined;//'], [/\b(\d+)\b/, (m) => String(+m + 1)], [/\bcontinue\b/, 'break']];
function mutantsFor(rev, codeFiles, cap = 8) {
  const perLine = [];
  for (const f of codeFiles) {
    const diff = git(UP, 'diff', '-U0', `${rev}^`, rev, '--', f).out; let ln = 0;
    for (const l of diff.split('\n')) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l); if (h) { ln = +h[1]; continue; }
      if (l.startsWith('+') && !l.startsWith('+++')) { const text = l.slice(1); if (!/^\s*(\/\/|\*|\/\*|import |export \{|$)/.test(text)) perLine.push({ f, ln, text }); ln++; }
    }
  }
  const out = []; // round-robin across lines, one operator per line per round: deterministic
  for (let round = 0; out.length < cap && round < MUTATORS.length; round++) for (const L of perLine) {
    if (out.length >= cap) break;
    const op = MUTATORS.filter(([re]) => re.test(L.text))[round]; if (!op) continue;
    out.push({ ...L, mutated: L.text.replace(op[0], op[1]), op: String(op[0]) });
  }
  return out;
}
if (EXPORT) {
  const EW = join(WORK, 'e4');
  rmSync(EW, { recursive: true, force: true }); git(UP, 'worktree', 'prune');
  mustGit(UP, 'worktree', 'add', '-q', '--detach', EW, M.base.sha);
  log('→ E4: installing dependencies in an upstream worktree'); install(EW, local, NODE);
  const write = (files) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(EW, p)), { recursive: true }); writeFileSync(join(EW, p), c); } };
  const fileStats = (rep, paths) => {
    const ts = rep.perTest.filter((t) => paths.some((p) => t.file.replace(/\\/g, '/').endsWith('/' + p)) && ['passed', 'failed'].includes(t.status));
    return { total: ts.length, failed: ts.filter((t) => t.status === 'failed').length };
  };
  for (const p of PRS) {
    const L = landedIntentOf(p.number); const X = L && EXPORT.find((x) => x.id === L.id);
    if (!X || !Object.keys(X.hidden || {}).length) { E4.prs.push({ pr: p.number, skipped: !L ? 'not landed' : 'no hidden tests exported' }); continue; }
    mustGit(EW, 'checkout', '-q', '--force', p.mergeSha); git(EW, 'clean', '-fdq', '-e', 'node_modules');
    write(X.hidden); write(X.tests || {});
    const hiddenP = Object.keys(X.hidden), authorP = Object.keys(X.tests || {}), upP = [...p.tests.added, ...p.tests.modified];
    const all = [...new Set([...hiddenP, ...authorP, ...upP])];
    const correct = runSuite(EW, local, all, NODE);
    const h = fileStats(correct, hiddenP), a = fileStats(correct, authorP), u0 = fileStats(correct, upP).total;
    E4.hiddenTests += h.total; E4.falseAlarms += h.failed; E4.authorTests += a.total; E4.authorFalseAlarms += a.failed;
    const row = { pr: p.number, intent: X.id, examiner: X.examiner, hidden: h, author: a, variants: [] };
    const variants = [{ kind: 'nothing (base code)', apply: () => git(EW, 'checkout', '-q', `${p.mergeSha}^`, '--', ...p.codeFiles).ok }];
    const hunks = git(UP, 'diff', `${p.mergeSha}^`, p.mergeSha, '--', ...p.codeFiles).out.split(/(?=^diff --git )/m).filter(Boolean)
      .flatMap((fd) => { const [head, ...hs] = fd.split(/(?=^@@ )/m); return hs.map((hk) => head + hk); });
    if (hunks.length > 1) for (const hk of hunks.slice(0, 3)) variants.push({ kind: 'one hunk reverted', apply: () => {
      const pf = join(EW, '.bt-hunk.patch'); writeFileSync(pf, hk.endsWith('\n') ? hk : hk + '\n'); const r = git(EW, 'apply', '-R', '.bt-hunk.patch'); rmSync(pf, { force: true }); return r.ok; } });
    for (const mu of mutantsFor(p.mergeSha, p.codeFiles)) variants.push({ kind: `mutant ${mu.op} ${mu.f}:${mu.ln}`, mutant: true, apply: () => {
      const lines = sh(EW, 'git', ['show', `${p.mergeSha}:${mu.f}`]).out.split('\n'); if (lines[mu.ln - 1] !== mu.text) return false;
      lines[mu.ln - 1] = mu.mutated; writeFileSync(join(EW, mu.f), lines.join('\n')); return true; } });
    for (const v of variants) {
      if (v.apply() === false) { row.variants.push({ kind: v.kind, invalid: 'could not apply' }); continue; }
      const r = runSuite(EW, local, all, NODE);
      const ours = fileStats(r, [...hiddenP, ...authorP]), hid = fileStats(r, hiddenP), up = fileStats(r, upP);
      mustGit(EW, 'checkout', '-q', '--force', p.mergeSha, '--', '.'); write(X.hidden); write(X.tests || {});
      if (ours.total === 0 && up.total === 0) { row.variants.push({ kind: v.kind, invalid: 'nothing ran (does not compile?)' }); continue; }
      // A suite "catches" a bad variant only if it ran on the correct code (baseline > 0) and now fails or loses
      // tests (the variant broke compilation); a suite that never ran catches nothing.
      const caught = (now, base) => base > 0 && (now.failed > 0 || now.total < base);
      const caughtHid = caught(hid, h.total), caughtUp = caught(up, u0), caughtOurs = caught(ours, h.total + a.total);
      E4.bad++; if (caughtUp) { E4.caughtUp++; if (caughtOurs) E4.caughtBoth++; }
      if (v.mutant) { E4.mutants++; if (caughtHid) E4.killedHidden++; if (caughtUp) E4.killedUpstream++; }
      row.variants.push({ kind: v.kind, caughtByOurs: caughtOurs, caughtByExaminer: caughtHid, caughtByUpstream: caughtUp });
    }
    E4.prs.push(row);
    const ok = row.variants.filter((v) => !v.invalid);
    log(`  E4 #${p.number}: examiner false alarms ${h.failed}/${h.total}; ${ok.length} bad variants: upstream caught ${ok.filter((v) => v.caughtByUpstream).length}, ours ${ok.filter((v) => v.caughtByOurs).length}`);
  }
  git(UP, 'worktree', 'remove', '--force', EW);
}
const e4a = EXPORT && E4.hiddenTests ? E4.falseAlarms / E4.hiddenTests : null;
const e4b = EXPORT && E4.mutants && E4.killedUpstream ? E4.killedHidden / E4.killedUpstream : null;
const e4c = EXPORT && E4.caughtUp ? E4.caughtBoth / E4.caughtUp : null;

// ---------------------------------------------------------------- metrics vs pre-registered bars
const byType = (t) => EVENTS.filter((e) => e.type === t);
const expressible = PRS.filter((p) => intentsOfPr(p.number).length > 0);
const landedPrs = PRS.filter(landedPr);
const firstTs = (type, id) => EVENTS.find((e) => e.type === type && e.intent === id)?.ts;
const landTs = (id) => landings.find((e) => e.intent === id || (e.data?.together || []).includes(id))?.ts;
const submitToLand = INTENTS.filter((i) => i.state === 'landed').map((i) => (landTs(i.id) - (firstTs('submit.received', i.id) ?? firstTs('intent.proposed', i.id))) / 60000).filter((x) => x >= 0);
const proposeToLand = INTENTS.filter((i) => i.state === 'landed').map((i) => (landTs(i.id) - firstTs('intent.proposed', i.id)) / 60000).filter((x) => x >= 0);
const upstreamOpenToMerge = PRS.map((p) => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3_600_000);
const rederived = INTENTS.filter((i) => !GHOSTS.has(i.id) && EVENTS.some((e) => e.type === 'rederive.queued' && e.intent === i.id));
const rederiveFirstGreen = rederived.filter((i) => i.state === 'landed' && i.landed_via === 're-derived#1').length;
const noops = byType('gate.failed').filter((e) => e.data?.verdict === 'noop' && !GHOSTS.has(e.intent)).length + RUN.sessions.filter((s) => !intentsOfPr(s.pr).length).length;
const agentRuns = RUN.sessions.length + byType('claim.started').filter((e) => e.data?.kind !== 'author' && !GHOSTS.has(e.intent)).length;
const forks = byType('claim.started').filter((e) => e.data?.fork).length + byType('dependent.detected').length;
const authorMin = RUN.sessions.reduce((n, s) => n + s.ms, 0) / 60000;
const crewMin = RUN.crewWaves.reduce((n, w) => n + (w.ended ? (Date.parse(w.ended) - Date.parse(w.started)) / 60000 : 0), 0) * RUN.params.N_CREW;
const ratio = (a, b) => (b ? a / b : null);
const o1Rate = ratio(O1.filter((x) => x.pass).length, O1.length);
const o1Clean = O1.filter((x) => !x.leaky); const o1CleanRate = ratio(o1Clean.filter((x) => x.pass).length, o1Clean.length);
const beforeBilling = Date.parse(RUN.ended || RUN.started) < Date.parse('2026-10-14T00:00:00-07:00');

const metrics = [
  { id: 'M1', name: 'expressible rate', value: ratio(expressible.length, PRS.length), bar: 'report', verdict: 'REPORT' },
  { id: 'M2', name: 'land rate (0 human touches)', value: ratio(landedPrs.length, expressible.length), bar: '>= 0.85', ok: (v) => v >= 0.85 },
  { id: 'M3', name: 'main always green', value: landings.every((e) => (e.data?.testsRun || 0) > 0) && F0.ok, bar: 'true (else run FAILS)', ok: (v) => v === true, fatal: true },
  { id: 'M4', name: 'preserved behaviour (O2)', value: O2.total ? O2.passed / O2.total : null, extra: { files: preserved.length, tampered }, bar: '= 1.0 (else run FAILS)', ok: (v) => v === 1 && !tampered.length, fatal: true },
  { id: 'M5', name: 'PR oracle: own cases all pass (O1)', value: o1Rate, extra: { nonLeakySubset: o1CleanRate, n: O1.length, nonLeakyN: o1Clean.length, casesPassed: O1.reduce((n, x) => n + x.cases.passed, 0), casesTotal: O1.reduce((n, x) => n + x.cases.total, 0), wholeFileRate: ratio(O1.filter((x) => x.wholeFile.pass).length, O1.length) }, bar: '>= 0.70', ok: (v) => v >= 0.7 },
  { id: 'M6', name: 'end-of-window agreement (O3, tests)', value: O3.total ? O3.passed / O3.total : null, extra: { passed: O3.passed, total: O3.total }, bar: '>= 0.95', ok: (v) => v >= 0.95 },
  { id: 'M7', name: 'counterfactual conflicts + silent breaks', value: CF.steps.length ? CF.conflicts + CF.silentBreaks : null, extra: { conflicts: CF.conflicts, silentBreaks: CF.silentBreaks }, bar: 'report; window INVALID if 0', ok: (v) => v > 0, invalidIfFalse: true },
  { id: 'M8', name: 'rebuilds green on first attempt', value: ratio(rederiveFirstGreen, rederived.length), extra: { rebuildsNeeded: rederived.length }, bar: '>= 0.75', ok: (v) => v >= 0.75 },
  { id: 'M9', name: 'median submit→main (min)', value: median(submitToLand), extra: { p90: pct(submitToLand, 90), proposeToLandMedian: median(proposeToLand), upstreamOpenToMergeMedianHours: median(upstreamOpenToMerge) }, bar: '<= 10', ok: (v) => v <= 10 },
  { id: 'M10', name: 'agent-minutes per landed PR', value: ratio(authorMin + crewMin, landedPrs.length), extra: { authorMin, crewMinUpperBound: crewMin }, bar: 'report', verdict: 'REPORT' },
  { id: 'M11', name: 'silent no-op rate', value: ratio(noops, agentRuns), extra: { noops, agentRuns }, bar: '<= 0.05', ok: (v) => v <= 0.05 },
  { id: 'M12', name: 'Cloudflare spend', value: beforeBilling ? 0 : null, extra: { forks, note: beforeBilling ? 'run before Artifacts billing (Oct 14): $0 for Artifacts ops; check the dashboard for Workers/DO/Containers' : 'after Oct 14: read the billed delta from the dashboard and enter it here' }, bar: '$0 before Oct 14; <= $5 after', ok: (v) => v === 0 || (v != null && v <= 5) },
  { id: 'DUP', name: 'duplicate intents', value: GHOSTS.size, extra: { intents: [...GHOSTS], agentRunsSpent: ghostRuns }, bar: 'report (not counted in M8/M11)', verdict: 'REPORT' },
  { id: 'E4a', name: 'examiner false alarms on upstream code', value: e4a, extra: { failed: E4.falseAlarms, tests: E4.hiddenTests, authorRegisteredFalseAlarms: `${E4.authorFalseAlarms}/${E4.authorTests}` }, bar: '<= 0.15', ok: (v) => v <= 0.15 },
  { id: 'E4b', name: 'examiner mutant kills / upstream kills', value: e4b, extra: { mutants: E4.mutants, killedByExaminer: E4.killedHidden, killedByUpstream: E4.killedUpstream }, bar: '>= 0.8', ok: (v) => v >= 0.8 },
  { id: 'E4c', name: 'bad variants caught vs upstream PR tests', value: e4c, extra: { badVariants: E4.bad, caughtByUpstream: E4.caughtUp, caughtByBoth: E4.caughtBoth }, bar: '>= 0.90', ok: (v) => v >= 0.9 },
];
for (const m of metrics) if (!m.verdict) m.verdict = m.value == null ? 'N/A' : m.ok(m.value) ? 'PASS' : m.fatal ? 'FAIL-RUN' : m.invalidIfFalse ? 'WINDOW-INVALID' : 'FAIL';
for (const m of metrics) delete m.ok;

const report = { run: RUN.runId, window: M.window, repo: M.repo, base: M.base.sha, end: M.end.sha, manifestHash: M.hash, arm: RUN.arm, aborted: RUN.aborted,
  oracleNode: nodeVer, prs: PRS.length, metrics, F0: { ok: F0.ok, total: F0.total }, O1, O2: { ok: O2.ok, passed: O2.passed, total: O2.total, failingFiles: O2.failingFiles }, O3: { passed: O3.passed, total: O3.total, failingFiles: O3.failingFiles.slice(0, 50) },
  counterfactual: CF, e4: E4, caveats: [
    'E4 uses a deterministic mini-mutator (<= 8 mutants per PR on added lines), not StrykerJS; variants that do not compile are excluded.',
    'O3 includes effects of PRs merged in the window that the selection rule excluded (docs/deps/untested).',
    'M5 is reported raw; failures still need the two-reviewer classification (behaviour | api-shape | internals | not-expressible).',
    'M10 crew minutes are an upper bound (crew wave wall time × crew size).',
    'Leakage-flagged PRs (request text shares >= 40 chars with the real added code) are reported separately in M5.extra.nonLeakySubset.',
  ] };
writeJson(join(WORK, 'report.json'), report);

const fmt = (v) => (v == null ? '—' : typeof v === 'number' ? (v <= 1 && v >= 0 && !Number.isInteger(v) ? `${(v * 100).toFixed(1)}%` : String(+v.toFixed(2))) : String(v));
log(`\nBACKTEST ${M.repo} ${M.from.slice(0, 10)}..${M.to.slice(0, 10)}  run ${RUN.runId}  arm ${RUN.arm}${RUN.aborted ? `  (ABORTED: ${RUN.aborted})` : ''}`);
for (const m of metrics) log(`  ${m.id.padEnd(4)} ${m.name.padEnd(42)} ${fmt(m.value).padStart(8)}   bar ${m.bar.padEnd(34)} ${m.verdict}`);
const fatal = metrics.some((m) => m.verdict === 'FAIL-RUN'); const invalid = metrics.some((m) => m.verdict === 'WINDOW-INVALID');
log(`\n${fatal ? '✖ RUN FAILS a fatal bar (M3/M4): main broke or preserved behaviour regressed.' : invalid ? '! window invalid: plain git would not have hit any conflict or break.' : '✔ no fatal bar tripped'}  → ${join(WORK, 'report.json')}`);
