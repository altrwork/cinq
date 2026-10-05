#!/usr/bin/env node
// Backtest step 2: replay the window through the REAL product (your deployed Cinq Worker).
//
//   node backtest/run.mjs --manifest backtest/manifests/hono.json [--arm claude|codex-authors]
//        [--authors 6] [--crew 2] [--crew-rounds 3] [--session-min 45] [--deadline-min 180]
//        [--max-forks 80] [--only 5244,5280] [--full-history] [--dry-run]
//
// What happens:
//   1. Snapshot the repo at the window's base commit. By default this is ONE orphan commit of the base
//      tree, to keep Artifacts storage and ops small. --full-history
//      pushes the real history instead.
//   2. A prep commit adds .cinq/config.json, telling the lander how to install and test this repo.
//   3. `cinq init` (app/cli/cinq.mjs) creates the repo on the platform, pushes it into Artifacts, mints a
//      key and installs the agent instructions (CLAUDE.md / AGENTS.md). --no-mcp is used because each
//      author gets its own key through a per-session MCP config (separate identities, so "author ≠
//      examiner ≠ rebuilder" is enforced per PR, not per machine).
//   4. One author session per PR, concurrently, each in its own clone, given ONLY the PR's title, body
//      and linked-issue text as a plain request. No mention of the platform: the installed instructions
//      do the rest, as in a real user's session.
//   5. `cinq crew` agents (headless Claude Code on your Claude plan) work the board: examinations,
//      rebuilds, dependent fixes. They are restarted in waves while the board has work.
//   6. Wait until every intent is landed or parked (or the deadline passes), then save events, intents
//      and receipts, and clone the final trunk from Artifacts.
// Nothing here gates or grades. That is oracle.mjs, which no agent ever sees.
//
// Login: the cinq login (~/.cinq/config.json) supplies the deployment and owner key; it is never written here.
// Agent keys go only into per-session MCP config files in an OS temp dir, deleted on exit.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HERE, ROOT, DEPLOYMENT, GL, MCP_NAME, flag, has, log, die, sh, git, mustGit, mask, sleep, api, allEvents,
  ownerKey, checkGlLogin, readJson, writeJson, sha256 } from './lib.mjs';

const manifestPath = resolve(flag('manifest') || die('usage: node backtest/run.mjs --manifest backtest/manifests/<window>.json [--dry-run]'));
const M = readJson(manifestPath);
{ const { hash, ...rest } = M; if (sha256(JSON.stringify(rest)) !== hash) die(`manifest hash mismatch: ${manifestPath} was edited after it was frozen`); }
const ARM = flag('arm', 'claude'); if (!['claude', 'codex-authors'].includes(ARM)) die('--arm is claude (arm A) or codex-authors (arm B: Codex authors, Claude crew)');
const N_AUTHORS = +flag('authors', 6), N_CREW = +flag('crew', 2), CREW_ROUNDS = +flag('crew-rounds', 3);
const SESSION_MS = +flag('session-min', 45) * 60_000, DEADLINE_MS = +flag('deadline-min', 180) * 60_000, MAX_FORKS = +flag('max-forks', 80);
const ONLY = flag('only')?.split(',').map(Number);
const PRS = ONLY ? M.prs.filter((p) => ONLY.includes(p.number)) : M.prs;
const TAG = Date.now().toString(36);
const REPO = `bt-${M.window}-${TAG}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
const WORK = join(HERE, 'work', REPO);
const SHELL = process.platform === 'win32';
const q = (a) => (SHELL ? a.map((x) => (/[\s"()&|<>^,*]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)) : a); // Windows .cmd shims need a shell

// Tools an author session may use without a permission prompt (a headless session can't answer one).
// Package-manager commands are allowed so agents can install and run the repo's tests in their fork.
const MCP_TOOLS = ['propose_intent', 'claim', 'submit_tests', 'submit', 'status', 'release', 'list_intents', 'get_intent', 'get_receipt'].map((t) => `mcp__${MCP_NAME}__${t}`);
const AUTHOR_TOOLS = [...MCP_TOOLS, 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git:*)', 'Bash(node:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(yarn:*)', 'Bash(corepack:*)', 'Bash(ls:*)'].join(',');

// ---------------------------------------------------------------- plan / preflight
log(`backtest ${REPO}`);
log(`  manifest  ${manifestPath} (hash ${M.hash.slice(0, 16)}, frozen ${M.frozenAt})`);
log(`  window    ${M.repo} ${M.from} .. ${M.to}, base ${M.base.sha.slice(0, 10)}, ${PRS.length} PRs`);
log(`  arm       ${ARM === 'claude' ? 'A: Claude Code authors + Claude crew' : 'B: Codex authors + Claude crew (examiners/rebuilders on a different vendor)'}`);
log(`  agents    ${N_AUTHORS} authors at once, crew ${N_CREW} × ${CREW_ROUNDS} jobs per wave; session cap ${SESSION_MS / 60000} min; deadline ${DEADLINE_MS / 60000} min`);
log(`  deploy    ${DEPLOYMENT}`);
log(`  lander    .cinq/config.json = ${JSON.stringify(M.lander)}`);
const login = checkGlLogin(); if (!login.ok) die(login.why);
for (const [bin, need] of [['claude', true], ['codex', ARM === 'codex-authors']]) if (need && !sh(process.cwd(), SHELL ? 'where' : 'which', [bin]).ok) die(`${bin} not on PATH`);
const reach = await api('repos').catch((e) => die(`platform unreachable: ${e.message}`));
log(`  preflight ok: cinq login matches the deployment, platform reachable (${reach.repos.length} repos)`);
if (has('dry-run')) {
  log('\n--dry-run: nothing created. Requests the authors would get:');
  for (const p of PRS) log(`  #${p.number}  ${p.title}\n      ${p.request.length} chars${p.issues.length ? `, issues ${p.issues.map((i) => '#' + i.number).join(',')}` : ''}${p.leakage.flagged ? `, LEAKAGE ${p.leakage.maxMatch} chars` : ''}`);
  process.exit(0);
}

mkdirSync(WORK, { recursive: true });
const RUN = { runId: REPO, repo: REPO, deployment: DEPLOYMENT, manifest: { path: manifestPath, hash: M.hash }, arm: ARM,
  params: { N_AUTHORS, N_CREW, CREW_ROUNDS, SESSION_MS, DEADLINE_MS, MAX_FORKS, only: ONLY || null, fullHistory: has('full-history') },
  started: new Date().toISOString(), sessions: [], crewWaves: [], aborted: null };
const save = () => writeJson(join(WORK, 'run.json'), RUN);
const tmpFiles = [];
const children = new Set();
process.on('exit', () => { for (const f of tmpFiles) rmSync(f, { recursive: true, force: true }); });
const abort = (why) => { RUN.aborted = why; save(); for (const c of children) try { c.kill(); } catch {} };

// ---------------------------------------------------------------- 1–3: base snapshot, prep, cinq init
const BASE = join(WORK, 'base');
const upstreamUrl = `https://github.com/${M.repo}.git`;
if (has('full-history')) {
  mustGit(WORK, 'clone', '-q', upstreamUrl, BASE); mustGit(BASE, 'checkout', '-q', '-B', 'main', M.base.sha);
} else {
  mustGit(WORK, 'init', '-q', '-b', 'main', BASE);
  mustGit(BASE, 'fetch', '-q', '--depth', '1', upstreamUrl, M.base.sha); // GitHub serves any reachable sha
  mustGit(BASE, 'checkout', '-q', 'FETCH_HEAD', '--', '.');
  mustGit(BASE, 'add', '-A');
  mustGit(BASE, 'commit', '-qm', `upstream ${M.repo}@${M.base.sha.slice(0, 10)} (snapshot at window base; history not replayed)`);
  // Drop the shallow fetch so the push sends just this one root commit.
  sh(BASE, 'git', ['update-ref', '-d', 'FETCH_HEAD']); rmSync(join(BASE, '.git', 'shallow'), { force: true });
}
// The lander honours .cinq/config.json:
//   { test: { runner: "vitest"|"jest"|"node", args: [...] }, install: "<shell command>" }
// It installs dependencies itself (npm ci, or the install override) and runs the repo's own runner with
// per-file results (app/worker/src/lander/server.cjs repoConfig / ensureDeps / runJsonRunner).
// Upstream's own scripts.test is NOT used: it often chains lint, tsc or multiple runtimes.
mkdirSync(join(BASE, '.cinq'), { recursive: true });
writeFileSync(join(BASE, '.cinq', 'config.json'), JSON.stringify(M.lander, null, 2) + '\n');
writeFileSync(join(BASE, '.cinq', 'backtest.json'), JSON.stringify({ upstream: M.repo, base: M.base.sha, window: [M.from, M.to], manifest: M.hash }, null, 2) + '\n');
mustGit(BASE, 'add', '.cinq'); mustGit(BASE, 'commit', '-qm', 'backtest prep: lander config for this repo (not part of upstream)');
RUN.baseCommit = mustGit(BASE, 'rev-parse', 'HEAD'); save();

const glRun = (args, cwd = BASE) => new Promise((done) => {
  const p = spawn(process.execPath, [GL, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  children.add(p); let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => { children.delete(p); done({ code, out: mask(out) }); });
});
log('\n→ cinq init');
const init = await glRun(['init', '--repo', REPO, '--agent', `bt-owner-${TAG}`, '--no-mcp']);
log(init.out.trim().split('\n').map((l) => '  ' + l).join('\n'));
if (init.code !== 0) { abort('cinq init failed'); die('cinq init failed'); }
RUN.glInit = init.out; save();
const INSTALLED = ['CLAUDE.md', 'AGENTS.md', '.cinq.json'].filter((f) => existsSync(join(BASE, f)));

// ---------------------------------------------------------------- 4: author sessions
async function authorDir(pr) {
  const d = join(WORK, `author-pr${pr.number}`);
  mustGit(WORK, 'clone', '-q', BASE, d);
  sh(d, 'git', ['remote', 'remove', 'origin']); // the only remote an agent should use is the fork the platform hands it
  for (const f of INSTALLED) copyFileSync(join(BASE, f), join(d, f)); // cinq init's instructions are uncommitted, as in a user's checkout
  return d;
}
function mcpConfigFor(key) {
  const dir = mkdtempSync(join(tmpdir(), 'bt-mcp-')); tmpFiles.push(dir);
  const f = join(dir, 'mcp.json');
  writeFileSync(f, JSON.stringify({ mcpServers: { [MCP_NAME]: { type: 'http', url: `${DEPLOYMENT}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }), { mode: 0o600 });
  return f;
}
function runSession(pr, cwd, key) {
  return new Promise((done) => {
    const t0 = Date.now(); let cmd, args, env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }; const last = join(tmpdir(), `bt-last-${TAG}-${pr.number}.txt`); tmpFiles.push(last);
    if (ARM === 'claude') {
      cmd = 'claude'; args = ['-p', '--output-format', 'json', '--mcp-config', mcpConfigFor(key), '--strict-mcp-config', '--settings', sh(process.cwd(), process.execPath, [GL, 'agent-settings', '--dir', cwd]).out.trim(), '--permission-mode', 'acceptEdits', '--allowedTools', AUTHOR_TOOLS];
    } else {
      // Codex reads AGENTS.md (installed by cinq init). MCP server passed with -c so the user's
      // ~/.codex/config.toml is untouched; the key is in this process's env only.
      cmd = 'codex'; env.BT_AGENT_KEY = key;
      args = ['exec', '-C', cwd, '-s', 'workspace-write', '--json', '-o', last, '-c', `mcp_servers.${MCP_NAME}.url="${DEPLOYMENT}/mcp"`, '-c', `mcp_servers.${MCP_NAME}.bearer_token_env_var="BT_AGENT_KEY"`, '-'];
    }
    const p = spawn(cmd, q(args), { cwd, env, shell: SHELL, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(p); p.stdin.end(pr.request); // the request is ONLY the PR's title + body + linked issue text
    let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    const kill = setTimeout(() => p.kill(), SESSION_MS);
    p.on('close', (code) => {
      clearTimeout(kill); children.delete(p);
      let m = {}; if (ARM === 'claude') { try { m = JSON.parse(out); } catch { m = { is_error: true }; } }
      const said = ARM === 'claude' ? String(m.result ?? '') : (existsSync(last) ? readFileSync(last, 'utf8') : '');
      done({ pr: pr.number, ms: Date.now() - t0, exit: code, timedOut: Date.now() - t0 >= SESSION_MS, turns: m.num_turns ?? null,
        models: Object.keys(m.modelUsage || {}), error: ARM === 'claude' ? !!m.is_error : code !== 0, said: mask(said).slice(0, 600), stderrTail: mask(err).slice(-400) });
    });
  });
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); })); }

// ---------------------------------------------------------------- 5: crew waves + watchdog
let crewRunning = null; let authorsDone = false; const t0 = Date.now();
const terminal = (s) => ['landed', 'parked'].includes(s);
async function boardState() {
  const { intents } = await api(`repos/${REPO}/intents`);
  const events = await allEvents(REPO);
  const examQueued = new Set(events.filter((e) => e.type === 'examine.queued').map((e) => e.intent));
  for (const e of events) if (e.type === 'examine.done') examQueued.delete(e.intent);
  const forks = events.filter((e) => e.type === 'claim.started' && e.data?.fork).length;
  const needsCrew = intents.some((i) => ['awaiting-examiner', 'rederive', 'dependent'].includes(i.state)) || [...examQueued].some((id) => !terminal(intents.find((i) => i.id === id)?.state));
  return { intents, events, forks, needsCrew, lastEventTs: events.at(-1)?.ts || 0 };
}
async function watchdog() {
  for (;;) {
    await sleep(60_000);
    let b; try { b = await boardState(); } catch (e) { log(`  ! board read failed: ${e.message}`); continue; }
    const states = b.intents.reduce((m, i) => ((m[i.state] = (m[i.state] || 0) + 1), m), {});
    log(`  [${Math.round((Date.now() - t0) / 60000)} min] ${b.intents.length} intents ${JSON.stringify(states)} · forks ${b.forks}${crewRunning ? ' · crew working' : ''}`);
    if (b.forks > MAX_FORKS) { abort(`Cloudflare guard: ${b.forks} forks > --max-forks ${MAX_FORKS}`); return; }
    if (b.needsCrew && !crewRunning) {
      const wave = { started: new Date().toISOString() }; RUN.crewWaves.push(wave); save();
      crewRunning = glRun(['crew', '--repo', REPO, '--n', String(N_CREW), '--rounds', String(CREW_ROUNDS)]).then((r) => { wave.ended = new Date().toISOString(); wave.out = r.out.slice(-4000); save(); crewRunning = null; });
    }
    const allTerminal = b.intents.length > 0 && b.intents.every((i) => terminal(i.state));
    if (authorsDone && allTerminal && !crewRunning) return;
    if (Date.now() - t0 > DEADLINE_MS) { abort('deadline reached'); return; }
    if (authorsDone && !crewRunning && !b.needsCrew && Date.now() - b.lastEventTs > 25 * 60_000) { abort('stalled: no events for 25 min and nothing for the crew'); return; }
  }
}

log(`\n→ ${PRS.length} author sessions (${N_AUTHORS} at a time) + crew watchdog`);
const dog = watchdog();
await pool(PRS, N_AUTHORS, async (pr) => {
  if (RUN.aborted) return;
  const dir = await authorDir(pr);
  const { key } = await api('keys', { body: { agent: `bt-pr${pr.number}-${TAG}`, repo: REPO } });
  log(`  ▶ #${pr.number} ${pr.title.slice(0, 60)}`);
  const s = await runSession(pr, dir, key);
  s.agent = `bt-pr${pr.number}-${TAG}`; RUN.sessions.push(s); save();
  log(`  ■ #${pr.number} ${(s.ms / 60000).toFixed(1)} min, exit ${s.exit}${s.timedOut ? ' (TIMED OUT)' : ''}${s.turns ? `, ${s.turns} turns` : ''}: ${s.said.split('\n')[0].slice(0, 100)}`);
});
authorsDone = true; log('  all author sessions finished; waiting for the board to settle');
await dog; if (crewRunning) await crewRunning;

// ---------------------------------------------------------------- 6: collect
log('\n→ collecting events, intents, receipts and final trunk');
const { intents } = await api(`repos/${REPO}/intents`);
const detail = [];
for (const i of intents) {
  const d = await api(`repos/${REPO}/intents/${encodeURIComponent(i.id)}`).catch((e) => ({ error: e.message }));
  const r = i.state === 'landed' ? await api(`repos/${REPO}/receipts/${encodeURIComponent(i.id)}`).catch(() => null) : null;
  detail.push({ ...i, detail: d.intent || d, receipt: r?.receipt || r });
}
writeJson(join(WORK, 'intents.json'), detail);
writeJson(join(WORK, 'events.json'), await allEvents(REPO));
// PR ↔ intent: each author ran under its own key "bt-pr<N>-<tag>", and the intent's author is that key's agent.
RUN.prToIntents = Object.fromEntries(PRS.map((p) => [p.number, intents.filter((i) => i.author === `bt-pr${p.number}-${TAG}`).map((i) => i.id)]));
const { remote } = await api(`repos/${REPO}/read-remote`, { body: {} });
const FINAL = join(WORK, 'final');
const c = git(WORK, 'clone', '-q', remote, FINAL);
if (!c.ok) log(`  ! final clone failed: ${mask(c.out).slice(0, 300)}`);
else { sh(FINAL, 'git', ['remote', 'remove', 'origin']); RUN.finalSha = mustGit(FINAL, 'rev-parse', 'HEAD'); } // drop the token-bearing remote
RUN.ended = new Date().toISOString(); save();
log(`\n✔ run ${REPO} ${RUN.aborted ? `ABORTED (${RUN.aborted})` : 'complete'}`);
log(`  ${intents.filter((i) => i.state === 'landed').length}/${intents.length} intents landed · final trunk ${RUN.finalSha?.slice(0, 10) || '—'}`);
log(`  next: node backtest/oracle.mjs --run ${join(WORK, 'run.json')}`);
log(`  note: the Artifacts repo ${REPO} is left in place (the API has no repo delete yet); it's one small snapshot plus landings.`);
process.exit(0);
