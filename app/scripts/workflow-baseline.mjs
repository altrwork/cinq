// The comparison for demo-day.mjs: the same two asks on examples/slotly, done the way most teams wire agents today.
// Each person's Claude Code builds their whole ask on a branch (one pull request). On every push a workflow starts a
// FRESH reviewer agent on the whole diff against the same house rules; a block, red tests or a merge conflict starts
// a FRESH fixer agent; then the review runs again. Up to 3 rounds, then it merges with plain git. Every session's
// tokens are recorded from Claude Code's own output. Tests run as CI does: free, outside any model.
//   node app/scripts/workflow-baseline.mjs [outDir]
import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { RULES, ASKS } from './demo-asks.mjs';

const [OUT] = process.argv.slice(2);
const ROOT = resolve(import.meta.dirname, '..', '..');
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => { try { return execFileSync('git', ['-c', 'user.name=wf', '-c', 'user.email=wf@example.invalid', ...a], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { throw Object.assign(new Error(String(e.stderr || e.message)), { out: String(e.stdout || '') }); } };
const T0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const sessions = [];
const tools = 'Read,Edit,Write,Glob,Grep,Bash(git:*),Bash(npm test:*),Bash(npm install:*),Bash(node --test:*),Bash(ls:*)';
function claude(role, who, prompt, cwd) {
  return new Promise((res) => {
    const t = Date.now(); const p = spawn('claude', ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', tools], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', () => {});
    p.on('close', () => {
      let j = {}; try { j = JSON.parse(out.slice(out.indexOf('{'))); } catch {}
      const u = j.usage || {}; const s = { role, who, input: u.input_tokens || 0, cached: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, costUsd: j.total_cost_usd ?? null, seconds: Math.round((Date.now() - t) / 1000) };
      sessions.push(s); log(`${who} ${role}: ${s.input + s.cached + s.output} tokens, ${s.seconds}s`); res(String(j.result || ''));
    });
  });
}
const tests = (dir) => { try { execFileSync('npm', ['test'], { cwd: dir, env, stdio: 'pipe' }); return { green: true }; } catch (e) { return { green: false, tail: String(e.stdout || '').slice(-1500) }; } };

const base = mkdtempSync(join(tmpdir(), 'workflow-'));
const origin = join(base, 'origin.git'); const seed = join(base, 'seed');
cpSync(join(ROOT, 'examples', 'slotly'), seed, { recursive: true, filter: (p) => !p.includes('node_modules') });
git(seed, 'init', '-q', '-b', 'main'); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'Slotly'); git(base, 'clone', '-q', '--bare', seed, origin);
const rules = RULES.map((r, i) => `${i + 1}. ${r}`).join('\n');

async function pullRequest(who) {
  const dir = join(base, who); git(base, 'clone', '-q', origin, dir); execFileSync('npm', ['install', '--silent'], { cwd: dir, env, stdio: 'ignore' });
  git(dir, 'checkout', '-q', '-b', who);
  await claude('author', who, `${ASKS[who]}\n\n(Work in this repo on the current branch. Run the tests. Commit your work when done.)`, dir);
  for (let round = 1; round <= 3; round++) {
    // CI on every push: the branch merged with the latest main, then the tests
    git(dir, 'fetch', '-q', 'origin', 'main');
    let conflict = false; try { git(dir, 'merge', '-q', '--no-edit', 'origin/main'); } catch { conflict = true; try { git(dir, 'merge', '--abort'); } catch {} }
    const ci = conflict ? { green: false } : tests(dir);
    const diff = git(dir, 'diff', 'origin/main...HEAD').slice(0, 60_000);
    let verdict = { verdict: 'block', findings: [] };
    if (!conflict && ci.green) {
      const text = await claude('reviewer', who, `You are the code-review step of a CI workflow. Review this pull request against the team's rules and the request. Reply with ONLY a JSON object {"verdict":"pass"|"block","findings":[{"file","line","rule","reason"}]}. Block only for real problems or a broken rule.\n\nTeam rules:\n${rules}\n\nRequest: ${ASKS[who]}\n\nDiff:\n${diff}`, dir);
      try { verdict = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { verdict = { verdict: 'pass', findings: [] }; }
    }
    log(`${who} round ${round}: ${conflict ? 'merge conflict' : !ci.green ? 'tests red' : verdict.verdict}`);
    if (!conflict && ci.green && verdict.verdict === 'pass') {
      try { git(dir, 'push', '-q', 'origin', `HEAD:main`); return { who, merged: true, rounds: round }; } catch { continue; } // main moved: next round
    }
    const why = conflict ? 'Merging the latest main into this branch conflicts. Merge origin/main into it, resolve every conflict keeping both sides\' intent, run the tests.'
      : !ci.green ? `The tests fail after merging the latest main:\n${ci.tail}` : `The reviewer blocked it:\n${JSON.stringify(verdict.findings, null, 1)}`;
    await claude('fixer', who, `You are fixing a pull request in a CI workflow. ${why}\n\nThe original request: ${ASKS[who]}\nTeam rules:\n${rules}\n\nFix it in this repo, run the tests, and commit.`, dir);
  }
  return { who, merged: false, rounds: 3 };
}

const results = await Promise.all(['maya', 'sam'].map(pullRequest));
const final = join(base, 'final'); git(base, 'clone', '-q', origin, final); execFileSync('npm', ['install', '--silent'], { cwd: final, env, stdio: 'ignore' });
const total = sessions.reduce((a, s) => a + s.input + s.cached + s.output, 0);
const summary = { results, mainGreen: tests(final).green, sessions: sessions.length, tokens: total, costUsd: +sessions.reduce((a, s) => a + (s.costUsd || 0), 0).toFixed(2),
  byRole: sessions.reduce((m, s) => ((m[s.role] = (m[s.role] || 0) + s.input + s.cached + s.output), m), {}), minutes: +((Date.now() - T0) / 60000).toFixed(1) };
log('summary', JSON.stringify(summary));
if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2)); writeFileSync(join(OUT, 'sessions.json'), JSON.stringify(sessions, null, 2)); }
rmSync(base, { recursive: true, force: true });
