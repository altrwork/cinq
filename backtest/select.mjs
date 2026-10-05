#!/usr/bin/env node
// Backtest step 1: freeze the window. Fetches the merged PRs of one real repo window from the GitHub
// REST API and writes a FROZEN manifest (manifests/<key>.json, content-hashed). run.mjs and oracle.mjs
// refuse a manifest whose hash doesn't match, so the selection can't drift after we've seen results.
//
//   node backtest/select.mjs --window hono [--gh-token] [--force]
//
// Selection rule, fixed in advance:
//   included = merged in [from, to], not a bot, changes at least one non-test source file, AND
//              adds or changes at least one test file (otherwise there is no PR oracle, O1)
//   excluded, with a reason recorded = bot | no-code (docs/CI only) | deps (package.json / lockfiles) | no-tests
// What the author agent will see: `request` = title + body + linked issue text, cleaned (HTML comments,
// PR-template checklists and diff-like code blocks are removed). Never the diff, the commits or the tests.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, flag, has, log, die, gh, useGhCliToken, isTestPath, sha256, writeJson, readJson } from './lib.mjs';

const key = flag('window') || die('usage: node backtest/select.mjs --window <hono|es-toolkit|fastify> [--gh-token] [--force]');
const W = readJson(join(HERE, 'windows.json'))[key] || die(`no window "${key}" in windows.json`);
if (has('gh-token')) useGhCliToken();
const out = join(HERE, 'manifests', `${key}.json`);
if (existsSync(out) && !has('force')) die(`${out} is frozen. Pass --force only if no run has used it yet (run.mjs records the hash it used).`);
const [owner, name] = W.repo.split('/');
let requests = 0; const get = (p) => { requests++; return gh(p); };

const isBot = (u) => u?.type === 'Bot' || /\[bot\]|dependabot|renovate|github-actions|pullfrog/i.test(u?.login || '');
const isDeps = (p) => /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(p);
const isNonCode = (p) => /(^|\/)(docs?|\.github|benchmarks?|perf-measures)\/|\.(md|mdx|txt|ya?ml)$|(^|\/)(LICENSE|CHANGELOG)/i.test(p);

// Remove what would leak the implementation or is just template noise; keep prose and behaviour examples.
function clean(text = '') {
  let t = String(text || '').replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/```([^\n]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const lines = code.split('\n').filter((l) => l.trim());
    const diffy = /^diff$/i.test(lang.trim()) || (lines.length && lines.filter((l) => /^[+-@]/.test(l)).length / lines.length > 0.5);
    return diffy ? '[diff-like code block removed]' : m;
  });
  t = t.split('\n').filter((l) => !/^\s*-\s*\[[ xX]\]\s/.test(l)).join('\n'); // PR-template checklists
  return t.replace(/\n{3,}/g, '\n\n').trim();
}
const linkedIssueNumbers = (body = '') => [...String(body || '').matchAll(new RegExp(`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s+(?:(?:https://github\\.com/)?${owner}/${name}(?:/issues/|#)|#)(\\d+)`, 'gi'))].map((m) => +m[1]);

// Leakage: the longest stretch of the kept request text that also appears in the PR's added lines.
function leakage(request, addedText) {
  const norm = (s) => s.replace(/\s+/g, ' ').toLowerCase();
  const a = norm(request), b = norm(addedText); const K = 40;
  if (a.length < K || b.length < K) return { maxMatch: 0, flagged: false };
  const grams = new Set(); for (let i = 0; i + K <= b.length; i++) grams.add(b.slice(i, i + K));
  let best = 0;
  for (let i = 0; i + K <= a.length; i++) {
    if (!grams.has(a.slice(i, i + K))) continue;
    let len = K; while (i + len < a.length && b.includes(a.slice(i, i + len + 1))) len++;
    best = Math.max(best, len); i += len - K;
  }
  return { maxMatch: best, flagged: best >= K };
}

log(`→ ${W.repo}: merged PRs ${W.from} .. ${W.to}`);
const q = encodeURIComponent(`repo:${W.repo} is:pr is:merged merged:${W.from.slice(0, 10)}..${W.to.slice(0, 10)}`);
const found = []; for (let page = 1; ; page++) { const s = await get(`/search/issues?q=${q}&per_page=100&page=${page}`); found.push(...s.items); if (found.length >= s.total_count || !s.items.length) break; }
log(`  ${found.length} merged PRs in the search window`);

const prs = []; const excluded = [];
for (const item of found) {
  const pr = await get(`/repos/${W.repo}/pulls/${item.number}`);
  const mergedAt = pr.merged_at;
  if (!mergedAt || mergedAt < W.from || mergedAt > W.to) { excluded.push({ number: pr.number, title: pr.title, reason: 'outside window (UTC)' }); continue; }
  if (isBot(pr.user)) { excluded.push({ number: pr.number, title: pr.title, reason: 'bot' }); continue; }
  const files = []; for (let page = 1; ; page++) { const f = await get(`/repos/${W.repo}/pulls/${pr.number}/files?per_page=100&page=${page}`); files.push(...f); if (f.length < 100) break; }
  const fl = files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, previous: f.previous_filename, test: isTestPath(f.filename) }));
  const codeFiles = fl.filter((f) => !f.test && !isNonCode(f.path) && !isDeps(f.path)).map((f) => f.path);
  const tests = { added: fl.filter((f) => f.test && f.status === 'added').map((f) => f.path),
    modified: fl.filter((f) => f.test && ['modified', 'renamed', 'changed'].includes(f.status)).map((f) => f.path),
    removed: fl.filter((f) => f.test && f.status === 'removed').map((f) => f.path) };
  const reason = fl.some((f) => isDeps(f.path)) ? 'deps' : !codeFiles.length ? 'no-code' : !(tests.added.length + tests.modified.length) ? 'no-tests (no PR oracle)' : null;
  if (reason) { excluded.push({ number: pr.number, title: pr.title, author: pr.user.login, reason }); continue; }
  const issues = [];
  for (const n of [...new Set(linkedIssueNumbers(pr.body))]) {
    try { const i = await get(`/repos/${W.repo}/issues/${n}`); if (!i.pull_request) issues.push({ number: n, title: i.title, body: clean(i.body).slice(0, 4000) }); } catch (e) { log(`  ! issue #${n}: ${e.message}`); }
  }
  const request = [pr.title, clean(pr.body), ...issues.map((i) => `Related issue #${i.number}: ${i.title}\n\n${i.body}`)].filter(Boolean).join('\n\n');
  const added = files.map((f) => (f.patch || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n')).join('\n');
  prs.push({ number: pr.number, url: pr.html_url, title: pr.title, author: pr.user.login, createdAt: pr.created_at, mergedAt,
    mergeSha: pr.merge_commit_sha, headSha: pr.head.sha, prBaseSha: pr.base.sha, files: fl, codeFiles, tests, issues,
    request, leakage: leakage(clean(pr.body) + '\n' + issues.map((i) => i.body).join('\n'), added) });
  log(`  + #${pr.number} ${pr.title.slice(0, 60)}  (${codeFiles.length} code, ${tests.added.length}+${tests.modified.length} test files${issues.length ? `, issues ${issues.map((i) => '#' + i.number).join(',')}` : ''})`);
}
prs.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
if (!prs.length) die('no PRs selected');

// Base = parent of the first selected merge in the window; end = the last merge in the window.
// Assumes squash/rebase merges onto main (true for these repos), so each merge commit has one parent on main.
const first = await get(`/repos/${W.repo}/commits/${prs[0].mergeSha}`);
const base = { sha: first.parents[0].sha, note: `parent of #${prs[0].number}'s merge commit` };
const baseCommit = await get(`/repos/${W.repo}/commits/${base.sha}`); base.date = baseCommit.commit.committer.date;
const end = { sha: prs.at(-1).mergeSha, note: `merge commit of #${prs.at(-1).number}` };
// Caveat: excluded PRs merged inside the window (docs, deps, untested) also moved upstream main, so
// upstream's end-of-window suite (O3) can include their effects. oracle.mjs reports O3 with that caveat.
const overlaps = Object.entries(prs.reduce((m, p) => { for (const f of p.codeFiles) (m[f] ||= []).push(p.number); return m; }, {}))
  .filter(([, n]) => n.length > 1).map(([file, nums]) => ({ file, prs: nums }));

// Sanity: pinned files that the lander config relies on must exist at base (e.g. the yarn release).
const pinned = [...JSON.stringify(W.lander).matchAll(/\.yarn\/releases\/[\w.-]+\.cjs/g)].map((m) => m[0]);
for (const p of pinned) { try { await get(`/repos/${W.repo}/contents/${p}?ref=${base.sha}`); } catch { die(`lander config needs ${p}, which does not exist at base ${base.sha.slice(0, 8)}`); } }

const manifest = { schema: 1, window: key, repo: W.repo, from: W.from, to: W.to, why: W.why, frozenAt: new Date().toISOString(),
  base, end, lander: W.lander, local: W.local, notes: W.notes || [], selectionRule: 'merged in window; not bot; >=1 non-test source file; >=1 added/changed test file; no deps changes',
  prs, excluded, overlaps, githubRequests: requests };
manifest.hash = sha256(JSON.stringify(manifest));
writeJson(out, manifest);
log(`\n✔ frozen ${out}`);
log(`  base ${base.sha.slice(0, 10)} (${base.date})  end ${end.sha.slice(0, 10)}`);
log(`  ${prs.length} PRs selected, ${excluded.length} excluded (${[...new Set(excluded.map((e) => e.reason))].join('; ') || 'none'})`);
log(`  same-file overlaps: ${overlaps.map((o) => `${o.file} ×${o.prs.length}`).join(', ') || 'NONE (window would prove nothing: M7 invalid)'}`);
const leaky = prs.filter((p) => p.leakage.flagged);
log(`  leakage flags (request text shares >= 40 chars with added code): ${leaky.length ? leaky.map((p) => `#${p.number} (${p.leakage.maxMatch})`).join(', ') : 'none'}`);
log(`  hash ${manifest.hash.slice(0, 16)}  ·  GitHub requests used: ${requests} (cached calls are not counted)`);
