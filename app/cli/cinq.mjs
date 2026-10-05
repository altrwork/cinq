#!/usr/bin/env node
// cinq: the CLI. Talks to the same /api/v1 the web home uses. Commands and flags: HELP, at the end of this file.
process.noDeprecation = true; // hides the Windows shell-spawn deprecation notice
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';

const CFG_DIR = join(homedir(), '.cinq'); const CFG = join(CFG_DIR, 'config.json');
const MCP_NAME = 'cinq';
const REPO_FILE = '.cinq.json';
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(`--${k}`);
const say = (s = '') => process.stdout.write(s + '\n');
const die = (s, code = 1) => { process.stderr.write(`✖ ${s}\n`); process.exit(code); };
const cfg = () => (existsSync(CFG) ? JSON.parse(readFileSync(CFG, 'utf8')) : die('not set up: run `npx cinq-git deploy` (or `cinq login --url <deployment> --owner-key <key>`)'));
const git = (...a) => execFileSync('git', ['-c', 'credential.helper=', ...a], { windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const mask = (s) => String(s).replace(/x:[^@\s]+@/g, 'x:***@').replace(/glk_[a-f0-9]+/g, 'glk_***').replace(/\b[0-9a-f]{32}(?=\.artifacts\.cloudflare\.net)/g, '<account>');

async function api(path, { body, key, method, soft } = {}) {
  const c = cfg();
  const r = await fetch(`${c.url}/api/v1/${path}`, { method: method || (body ? 'POST' : 'GET'), headers: { authorization: `Bearer ${key || c.ownerKey}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok && /repo not initialised/.test(j.error || '')) j.error = `no repo "${decodeURIComponent(path.split('/')[1] || '')}" on ${c.url}; run \`npx cinq-git init\` in it, or pass --repo <name>`;
  if (!j.ok && !soft) die(/^no repo /.test(j.error) ? j.error : `${path}: ${j.error}`);
  return { ...j, status: r.status };
}
// .cinq.json sits in the checkout, where agents can edit it: a repo name is checked before it goes into an owner-key URL
const REPO_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const repoName = () => {
  const r = flag('repo') || (existsSync(REPO_FILE) ? JSON.parse(readFileSync(REPO_FILE, 'utf8')).repo : null) || die('no repo here: run this inside the folder where you ran `npx cinq-git init` (or pass --repo <name>)');
  return REPO_NAME.test(r) ? r : die(`"${r}" isn't a repo name (lowercase letters, digits and dashes)`);
};
// Windows: Claude Code's own executable, not its claude.cmd shim. Through cmd.exe a multi-line system prompt (or a quote
// in any argument) is mangled, and the session exits without a word.
let _claudeExe;
const claudeExe = () => {
  if (process.platform !== 'win32') return null;
  if (_claudeExe !== undefined) return _claudeExe;
  const where = (n) => (spawnSync('where', [n], { encoding: 'utf8', windowsHide: true }).stdout || '').split(/\r?\n/).find(Boolean);
  const cmd = where('claude.cmd'); const viaNpm = cmd && join(cmd, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return (_claudeExe = (viaNpm && existsSync(viaNpm) ? viaNpm : where('claude.exe')) || null);
};
// Windows runs npx and other .cmd shims through a shell, so arguments with spaces must be quoted.
const shellArgs = (a) => (process.platform === 'win32' ? a.map((x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)) : a);
// An agent's report, readable in a terminal: no markdown emphasis, no blank lines, wrapped on words under its prefix.
const tidy = (text, prefix, width = (process.stdout.columns || 100) - 1) => text.replace(/\*\*|__|`/g, '').split('\n').filter((l) => l.trim()).flatMap((l) => {
  const out = []; let line = ''; const max = Math.max(40, width - prefix.length);
  for (const w of l.split(/ +/)) { if (line && (line + ' ' + w).length > max) { out.push(line); line = w; } else line = line ? line + ' ' + w : w; }
  return [...out, line];
}).map((l) => prefix + l).join('\n');
const words = (s) => String(s).replace(/re-?deriv(ation|ing|ed|e)/g, (_, e) => ({ e: 'rebuild', ed: 'rebuilt', ing: 'rebuilding', ation: 'rebuild' })[e]).replace(/^intent\./, 'job.').replace(/awaiting-/, 'waiting for ').replace(/^with-dependent:.*/, 'rebuilt to fit a contract change').replace(/^contract-change\(.*\)$/, 'landed with the jobs rebuilt to fit it');
const mcpLine = (url, key) => ['mcp', 'add', '--transport', 'http', MCP_NAME, `${url}/mcp`, '--header', `Authorization: Bearer ${key}`];

const INSTRUCTIONS = `<!-- cinq:start -->
## Shared repo: coordinate through Cinq

Several AI agents work on this codebase at the same time. Main lives on Cloudflare Artifacts and only
accepts changes through the \`${MCP_NAME}\` MCP tools, which check every change before it lands. For every
change you make, without waiting to be told:

1. \`house_rules\`: the review criteria a person set for this repo. Your change is reviewed against them.
   \`list_intents\`: see what other agents are doing and which files their open jobs change. Don't duplicate it.
2. If the ask has more than one part that could land on its own (most real asks do), use \`propose_plan\`: the
   ask in the person's words, and a few tickets (usually 2 to 4: keep parts that touch the same files together),
   each shaped like a \`propose_intent\` job, naming every file each ticket will need. You build the first ticket;
   crew agents build the rest. Otherwise \`propose_intent\`: a one-line goal, the exact files you will change (\`allowed\`), and new test files
   that FAIL on today's code: the fewest that prove the goal, usually 1 to 3 cases (more than 5 is refused).
   Use kind "keep" for refactors, where existing tests must keep passing. Add a one-sentence \`plan\` (your
   approach); it is recorded with the change. If the reply lists \`overlaps\`, narrow your files or pick other work.
3. While you work, call \`status\` on your claim every few minutes: that keeps your lease (it lapses after 20
   quiet minutes and the job goes to someone else). Clone the fork remote you get back with ONE plain command: \`git clone <remote> ../<intent-id>\`.
   Then work in that folder and use \`git -C ../<intent-id> ...\` for add, commit and
   \`push origin HEAD:main\`. Don't chain commands with \`cd ... &&\`.
4. \`submit\`, and you're done with that job: don't wait for it to land. The platform examines, reviews and lands
   it, or another agent rebuilds it, and the person sees it on the board. Tell the person what you handed in.
   Don't resubmit the same diff; another agent may rebuild it from your goal. If you spot a mistake in your OWN registered
   tests before you submit, call \`propose_intent\` again with the same goal, \`allowed\` and the corrected
   \`tests\`. Your open job is updated; it isn't duplicated.
5. When you're idle, \`claim\` picks up jobs other agents need: building a ticket from someone's ask, reviewing someone else's diff (pass or
   block it with findings, then \`submit_review\`), examining someone else's goal (write hidden tests
   without seeing their code, then \`submit_tests\`), rebuilding a change that clashed or was blocked, or
   adapting a landed change to a contract change.
6. If your change adds, removes or upgrades a dependency, list the package names in \`propose_intent\`'s
   \`deps\`. Never commit secrets. Jobs that touch protected paths or are very large wait for a person.

Never push to main directly. Never edit existing tests or anything under \`.cinq/\`. If the goal genuinely
changes behaviour that existing tests pin, don't edit them in your fork: pass their full new content in
\`propose_intent\`'s \`supersedes\`. Another agent reviews each change, and only approved changes land.
<!-- cinq:end -->
`;
function installInstructions(file) {
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const re = /<!-- cinq:start -->[\s\S]*?<!-- cinq:end -->\n?/;
  const next = re.test(cur) ? cur.replace(re, INSTRUCTIONS) : (cur ? cur.replace(/\n*$/, '\n\n') : '') + INSTRUCTIONS;
  if (next !== cur) writeFileSync(file, next);
  return next !== cur;
}

// Claude Code loads CLAUDE.md from every ancestor dir and ~/.claude; exclude them so headless agents see only the repo's own.
function agentSettings(repoDir) {
  const ex = [join(homedir(), '.claude', 'CLAUDE.md')];
  for (let d = dirname(resolve(repoDir)); ; d = dirname(d)) { ex.push(join(d, 'CLAUDE.md'), join(d, '.claude', 'CLAUDE.md')); if (dirname(d) === d) break; }
  const file = join(CFG_DIR, `agent-settings-${Buffer.from(resolve(repoDir)).toString('hex').slice(-24)}.json`);
  mkdirSync(CFG_DIR, { recursive: true });
  // the crew never reads or touches the owner key (~/.cinq), which can import history and mint keys
  const cinqDir = CFG_DIR.replace(/\\/g, '/');
  const deny = ['Read', 'Edit'].map((t) => `${t}(${cinqDir}/**)`).concat(['Bash(cat:*)', 'Bash(curl:*)', 'Bash(wget:*)']);
  writeFileSync(file, JSON.stringify({ claudeMdExcludes: [...new Set(ex.map((p) => p.replace(/\\/g, '/')))], permissions: { deny } }, null, 2));
  return file;
}

const PKG = fileURLToPath(new URL('../..', import.meta.url));
const wrangler = (a, opts = {}) => spawnSync('npx', shellArgs(['--yes', 'wrangler', ...a]), { windowsHide: true, cwd: join(PKG, 'app', 'worker'), encoding: 'utf8', shell: process.platform === 'win32', ...opts });

// Asked for, never stored: an agent with your owner key still can't use it.
async function askCode(why) {
  if (!process.stdin.isTTY) die(`${why} needs your approval code, typed in a terminal (it is never read from files, flags or pipes)`);
  const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question(`Approval code, for ${why} (shown when you deployed): `)).trim(); rl.close();
  return code;
}
// The approval code lets a person approve a parked job. It never touches disk: only its SHA-256 goes to the
// deployment, as the APPROVE_HASH secret.
async function setApprovalCode(target) { // target: wrangler args naming the Worker (-c <config> or --name <worker>)
  const { randomBytes, createHash } = await import('node:crypto');
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', b = randomBytes(16);
  const code = Array.from({ length: 4 }, (_, g) => Array.from({ length: 4 }, (_, k) => A[b[g * 4 + k] % A.length]).join('')).join('-');
  const s = wrangler(['secret', 'put', 'APPROVE_HASH', ...target], { input: createHash('sha256').update(code).digest('hex') });
  if (s.status !== 0) die(`setting the approval code failed:\n${(s.stdout + s.stderr).slice(-800)}`);
  return code;
}
// The lander's signing key: every landing commit is signed with it, and main lists its public half in
// .cinq/allowed_signers. Made here with ssh-keygen; only the deployment keeps the private half (a secret).
async function setSigningKey(target) {
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os');
  const d = mkdtempSync(join(tmpdir(), 'cinq-sign-')); const f = join(d, 'key');
  try {
    const k = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'cinq-lander', '-f', f], { windowsHide: true, stdio: 'ignore' });
    if (k.status !== 0) return say('  (no ssh-keygen here, so landings stay unsigned; add a key later with: npx cinq-git signing-key)'), null;
    for (const [secret, file] of [['LANDER_SIGNING_KEY', f], ['LANDER_SIGNING_PUB', f + '.pub']]) {
      const s = wrangler(['secret', 'put', secret, ...target], { input: readFileSync(file, 'utf8') });
      if (s.status !== 0) die(`setting ${secret} failed:\n${(s.stdout + s.stderr).slice(-800)}`);
    }
    return readFileSync(f + '.pub', 'utf8').trim();
  } finally { rmSync(d, { recursive: true, force: true }); }
}
// House rules as text: one rule per line ("1. ..." or "- ..." or plain), "reviewers: codex-*" names who may review,
// lines starting with # are notes.
const rulesText = (repo, hr) => `# House rules for ${repo}${hr.version ? ` (version ${hr.version})` : ''}. One rule per line: every review is held to them,
# and every finding cites the rule it breaks. Lines starting with # are ignored. Saving takes your approval code.
# reviewers: <agent name pattern> lets only matching agents review, e.g. reviewers: codex-*
${hr.reviewers ? `reviewers: ${hr.reviewers}\n` : ''}${hr.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`;
const parseRules = (text) => {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const rv = lines.find((l) => /^reviewers\s*:/i.test(l));
  return { reviewers: rv ? rv.replace(/^reviewers\s*:/i, '').trim() || null : null,
    rules: lines.filter((l) => l !== rv).map((l) => l.replace(/^(\d+[.)]|[-*])\s*/, '')).filter(Boolean) };
};
// The final reply and token usage from one headless session's output: Claude Code's --output-format json (one object)
// or Codex's --json (JSONL events; usage on turn.completed).
function sessionResult(vendor, out) {
  try {
    if (vendor === 'claude') {
      const j = JSON.parse(out); const u = j.usage || {};
      return { text: j.result || '', usage: { input: u.input_tokens || 0, cachedInput: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, costUsd: j.total_cost_usd ?? null } };
    }
    const evs = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const text = evs.filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message').map((e) => e.item.text).pop() || '';
    const u = evs.filter((e) => e.type === 'turn.completed' && e.usage).reduce((a, e) => ({ input: a.input + (e.usage.input_tokens || 0) - (e.usage.cached_input_tokens || 0), cachedInput: a.cachedInput + (e.usage.cached_input_tokens || 0), output: a.output + (e.usage.output_tokens || 0) }), { input: 0, cachedInput: 0, output: 0 });
    return { text, usage: { ...u, costUsd: null } };
  } catch { return { text: out, usage: null }; }
}
const commands = {
  // Needs the Workers Paid plan: Artifacts and Containers are Paid-only.
  async deploy() {
    const name = (flag('name') || 'cinq').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    let who = wrangler(['whoami']);
    if (/not authenticated|You are not logged in/i.test(who.stdout + who.stderr)) { say('→ logging in to Cloudflare (a browser window opens)'); wrangler(['login'], { stdio: 'inherit' }); who = wrangler(['whoami']); }
    const ids = [...new Set((who.stdout + who.stderr).match(/\b[0-9a-f]{32}\b/g) || [])];
    const accountId = flag('account-id') || (ids.length === 1 ? ids[0] : die(ids.length ? `several Cloudflare accounts: pass --account-id (one of ${ids.join(', ')})` : 'could not read your Cloudflare account id: run \`npx wrangler login\`'));
    say(`→ deploying "${name}" to Cloudflare account ${accountId.slice(0, 6)}…`);
    const conf = {
      name, main: 'src/index.js', compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'],
      artifacts: [{ binding: 'ARTIFACTS', namespace: name }],
      containers: [{ class_name: 'Lander', image: 'docker.io/library/node:22', max_instances: +(flag('max-landers') || 6), instance_type: flag('lander-size') || 'basic' }],
      durable_objects: { bindings: [{ name: 'LANDER', class_name: 'Lander' }, { name: 'REPO', class_name: 'RepoDO' }, { name: 'ACCOUNT', class_name: 'AccountDO' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Lander'] }, { tag: 'v2', new_sqlite_classes: ['RepoDO', 'AccountDO'] }],
      vars: { ACCOUNT_ID: accountId, NAMESPACE: name, PUBLIC_READ: '0', ...(has('dev-scenarios') ? { DEV_SCENARIOS: '1' } : {}), ...(flag('lease-seconds') ? { LEASE_SECONDS: String(+flag('lease-seconds')) } : {}) },
      assets: { directory: '../web', binding: 'ASSETS', run_worker_first: true, not_found_handling: 'single-page-application' },
      rules: [{ type: 'Text', globs: ['**/lander/*.cjs'], fallthrough: false }], observability: { enabled: true },
    };
    const cfgFile = join(PKG, 'app', 'worker', `.cinq-deploy-${name}.json`); writeFileSync(cfgFile, JSON.stringify(conf, null, 2));
    const d = wrangler(['deploy', '-c', cfgFile]);
    const url = ((d.stdout + d.stderr).match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0];
    if (d.status !== 0 || !url) die(`deploy failed. The usual causes: the account isn't on Workers Paid ($5/month), or it has no workers.dev subdomain yet (Cloudflare dashboard → Workers & Pages opens one). wrangler said:\n${(d.stdout + d.stderr).slice(-1500)}`);
    // Deploying again upgrades in place: the keys stay (a new signing key would stop older landings verifying) unless --rotate
    const l = wrangler(['secret', 'list', '-c', cfgFile, '--format', 'json']);
    const secrets = (() => { try { return JSON.parse(l.stdout.slice(l.stdout.indexOf('['))).map((x) => x.name); } catch { return []; } })();
    const keep = (k) => !has('rotate') && secrets.includes(k);
    const prev = existsSync(CFG) ? JSON.parse(readFileSync(CFG, 'utf8')) : null;
    let ownerKey = prev?.url === url && keep('OWNER_KEY') ? prev.ownerKey : null;
    if (!ownerKey) {
      ownerKey = (await import('node:crypto')).randomBytes(24).toString('hex');
      const s = wrangler(['secret', 'put', 'OWNER_KEY', '-c', cfgFile], { input: ownerKey });
      if (s.status !== 0) die(`setting the owner key failed:\n${(s.stdout + s.stderr).slice(-800)}`);
    }
    mkdirSync(CFG_DIR, { recursive: true }); writeFileSync(CFG, JSON.stringify({ url, ownerKey }, null, 2), { mode: 0o600 });
    const code = keep('APPROVE_HASH') ? null : await setApprovalCode(['-c', cfgFile]);
    const signed = keep('LANDER_SIGNING_KEY') || (await setSigningKey(['-c', cfgFile]));
    say(`✔ Cinq is running in your Cloudflare account: ${url}`);
    if (signed) say('✔ every landing commit is signed by Cinq (verify: git log --show-signature, with .cinq/allowed_signers)');
    say('✔ logged in (owner key saved to ~/.cinq/config.json; never commit it)');
    if (!code) return say('✔ your approval code and signing key are unchanged (new ones: npx cinq-git deploy --rotate)');
    say(`\nYour approval code: ${code}\n  You type it to approve a parked job, change your house rules or delete a repo. It is shown only now and stored nowhere (only its hash, in Cloudflare),\n  so an agent that gets hold of your owner key still can't approve for you. (Code that runs as you can also reach your\n  Cloudflare login; run agents as a separate OS user if that matters.) Keep it in a password manager. Lost it? npx cinq-git approval-code`);
    say('\nNext: cd into a git repo and run npx cinq-git init. Then npx cinq-git open shows its dashboard.');
  },

  // A new approval code for an existing deployment (the old one stops working).
  async 'approval-code'() {
    // by Worker name (the one you are logged in to, or --name), so it works from any machine logged in to the account
    const name = (flag('name') || new URL(cfg().url).hostname.split('.')[0]).toLowerCase();
    say(`Your new approval code: ${await setApprovalCode(['--name', name])}\n  Shown only now; keep it in your password manager.`);
  },
  // A signing key for an existing deployment (landings from now on are signed with it).
  async 'signing-key'() {
    const name = (flag('name') || new URL(cfg().url).hostname.split('.')[0]).toLowerCase();
    const pub = await setSigningKey(['--name', name]);
    if (pub) say(`✔ landings on ${name} are signed from now on\n  public key (also written to .cinq/allowed_signers on main at the next landing):\n  ${pub}`);
  },
  // the settings file for a headless Claude Code agent in a given checkout (used by backtest/run.mjs)
  async 'agent-settings'() { say(agentSettings(flag('dir') || process.cwd())); },

  async login() {
    const url = (flag('url') || die('--url required')).replace(/\/$/, ''); const ownerKey = flag('owner-key') || die('--owner-key required');
    mkdirSync(CFG_DIR, { recursive: true }); writeFileSync(CFG, JSON.stringify({ url, ownerKey }, null, 2), { mode: 0o600 });
    const r = await api('repos'); say(`✔ logged in to ${url} (${r.repos.length} repos)`);
  },

  async init() {
    const c = cfg();
    try { git('rev-parse', '--show-toplevel'); } catch { die('run npx cinq-git init inside a git repository (git init, then commit something first)'); }
    try { git('rev-parse', '--verify', 'HEAD'); } catch { die('this repo has no commits yet: commit something first, then run npx cinq-git init'); }
    try { git('config', 'user.email'); } catch { die('git doesn\'t know who you are yet: run git config --global user.name "Your Name" and git config --global user.email you@example.com, then npx cinq-git init'); }
    const name = (flag('repo') || basename(git('rev-parse', '--show-toplevel'))).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 40);
    if (!REPO_NAME.test(name)) die(`"${name}" can't be a repo name: pass --repo with lowercase letters, digits and dashes`);
    say(`→ connecting ${name} (branch ${git('rev-parse', '--abbrev-ref', 'HEAD')}, which becomes main) to ${c.url}`);

    // The agent instructions go into main with the import, so your checkout and main agree from the start; the
    // local files (.cinq.json, Claude Code's local settings) never get committed.
    // never sweep the user's own unsaved edits into this commit
    const dirty = ['CLAUDE.md', 'AGENTS.md'].filter((f) => existsSync(f) && git('status', '--porcelain', '--', f));
    const changed = ['CLAUDE.md', 'AGENTS.md'].filter(installInstructions);
    const exclude = join(git('rev-parse', '--git-dir'), 'info', 'exclude'); mkdirSync(join(exclude, '..'), { recursive: true });
    let ex = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    for (const l of ['.cinq.json', '.claude/settings.local.json']) if (!ex.split('\n').includes(l)) ex = ex.replace(/\n?$/, '\n') + l + '\n';
    writeFileSync(exclude, ex);
    const toCommit = changed.filter((f) => !dirty.includes(f));
    if (toCommit.length) {
      try { git('add', '--', ...toCommit); git('commit', '-q', '-m', 'Add Cinq agent instructions', '--', ...toCommit); }
      catch (e) { die(`couldn't commit the agent instructions: ${String(e.stderr || e.message).trim().split('\n').pop()}\n  (set git user.name and user.email, then run npx cinq-git init again)`); }
    }
    say(`✔ agent instructions ${toCommit.length ? `committed to ${toCommit.join(', ')}` : changed.length ? 'added' : 'already present'}${dirty.some((f) => changed.includes(f)) ? `; ${dirty.filter((f) => changed.includes(f)).join(', ')} had your own uncommitted edits, so commit ${dirty.length === 1 ? 'it' : 'them'} yourself` : ''}`);

    // a name that held a main before (deleted) takes the approval code to come back
    let made = await api('repos', { body: { name }, soft: true });
    if (made.status === 403 && /approval code/.test(made.error || '')) made = await api('repos', { body: { name, code: await askCode(`re-creating ${name}, a name that was deleted`) }, soft: true });
    if (!made.ok) die(`repos: ${made.error}`);
    // a repo someone already imported (a teammate, another machine, a re-run): connect to it, never push over it
    let imp = await api(`repos/${name}/import-remote`, { body: {}, soft: true });
    if (imp.status === 403 && /approval code/.test(imp.error || '')) imp = await api(`repos/${name}/import-remote`, { body: { code: await askCode(`re-importing ${name}, a name that was deleted`) }, soft: true });
    if (imp.ok) {
      try { git('push', '-q', imp.remote, 'HEAD:main'); } catch (e) {
        const msg = mask(e.stderr || e.message);
        if (!/non-fast-forward|rejected|fetch first/.test(msg)) die(`push to Artifacts failed: ${msg}`);
        // someone (another machine) imported first: connect to theirs, and take back our own instructions commit
        if (toCommit.length) git('reset', '-q', '--mixed', 'HEAD~1');
        say(`✔ ${name} was just imported from another checkout; connecting to it (npx cinq-git sync brings its main here)`);
        imp.ok = false; imp.status = 0;
      }
    }
    if (imp.ok) {
      const nCommits = +git('rev-list', '--count', 'HEAD');
      say(`✔ main is on Cloudflare Artifacts at ${git('rev-parse', '--short', 'HEAD')} (${nCommits} commit${nCommits === 1 ? '' : 's'} pushed)`);
    } else if (imp.status === 409) say(`✔ ${name} is already on Artifacts; connecting to it (npx cinq-git sync brings its main here)`);
    else if (imp.status !== 0) die(`import-remote: ${imp.error}`);

    const pkg = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : {};
    const testScript = pkg.scripts?.test || '';
    const runner = /vitest/.test(testScript) ? 'vitest' : /jest/.test(testScript) ? 'jest' : /node\s+--test/.test(testScript) || !testScript ? 'node --test' : null;
    say(runner ? `✔ tests: ${runner}` : `! test script is "${testScript}": Cinq runs node --test, vitest or jest; set one in .cinq/config.json before init, e.g. {"test":{"runner":"vitest","args":["run"]}}`);
    // the same files the reviewer reads (GUIDE in app/worker/src/lander/server.cjs): a team's own code-review prompt goes in REVIEW.md
    const guides = git('ls-files').split('\n').filter((f) => /(^|\/)(REVIEW|AGENTS|CLAUDE|BUGBOT|CONTRIBUTING|ARCHITECTURE|STYLEGUIDE|CONVENTIONS)\.md$|(^|\/)docs\/(architecture|adr|decisions)[^/]*\.md$/i.test(f));
    if (guides.some((f) => /(^|\/)REVIEW\.md$/i.test(f))) say(`✔ review guides every reviewer reads: ${guides.slice(0, 6).join(', ')}${guides.length > 6 ? ', …' : ''}`);
    else say(`· have a code-review prompt you already use? Put it in REVIEW.md: every reviewer reads it next to your house rules${guides.length ? ` (and ${guides.slice(0, 4).join(', ')})` : ''}`);

    // local scope: the key is never written into the repo
    const agent = flag('agent') || `claude-${hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}`;
    const { key } = await api('keys', { body: { agent, repo: name } });
    if (!has('no-mcp')) {
      spawnSync('claude', ['mcp', 'remove', MCP_NAME, '-s', 'local'], { windowsHide: true, stdio: 'ignore', shell: process.platform === 'win32' });
      const r = spawnSync('claude', shellArgs(mcpLine(c.url, key)), { windowsHide: true, encoding: 'utf8', shell: process.platform === 'win32' });
      if (r.status === 0) say(`✔ Claude Code connected as "${agent}" (MCP server "${MCP_NAME}", local scope)`);
      else say(`! couldn't run claude; add it yourself:\n  claude ${mcpLine(c.url, '<key>').map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}\n  key: ${key}`);
    }

    // Claude Code in this repo may not read the owner key (local settings, never committed)
    { const f = join('.claude', 'settings.local.json'); let s = {}; try { s = JSON.parse(readFileSync(f, 'utf8')); } catch {}
      const deny = new Set([...(s.permissions?.deny || []).filter((r) => !r.startsWith('Write(')), ...['Read', 'Edit'].map((t) => `${t}(${CFG_DIR.replace(/\\/g, '/')}/**)`)]);
      mkdirSync('.claude', { recursive: true }); writeFileSync(f, JSON.stringify({ ...s, permissions: { ...(s.permissions || {}), deny: [...deny] } }, null, 2) + '\n');
      say('✔ Claude Code here may not read ~/.cinq (your owner key)'); }
    // opt-in: a Stop hook reports what each Claude Code session here spent, so the board can show tokens per change
    if (has('track-tokens')) { const f = join('.claude', 'settings.local.json'); const s = JSON.parse(readFileSync(f, 'utf8'));
      const cmd = `node "${join(PKG, 'app', 'cli', 'cinq.mjs').replace(/\\/g, '/')}" usage-hook`;
      const stop = (s.hooks?.Stop || []).filter((h) => !JSON.stringify(h).includes('usage-hook'));
      writeFileSync(f, JSON.stringify({ ...s, hooks: { ...(s.hooks || {}), Stop: [...stop, { hooks: [{ type: 'command', command: cmd }] }] } }, null, 2) + '\n');
      say('✔ token tracking on: each Claude Code session here reports what it spent (in .claude/settings.local.json)'); }
    writeFileSync('.cinq.json', JSON.stringify({ repo: name, url: c.url }, null, 2) + '\n');
    { const f = join(CFG_DIR, 'checkouts.json'); let m = {}; try { m = JSON.parse(readFileSync(f, 'utf8')); } catch {} m[process.cwd()] = { repo: name, agent }; writeFileSync(f, JSON.stringify(m, null, 2), { mode: 0o600 }); }
    say(`\nDone. Next:`);
    say(`  1. In a second terminal, in this folder: npx cinq-git crew   (the agents that examine, review and rebuild; nothing lands without them)`);
    say(`  2. Start Claude Code here (restart it if it was open) and ask for something, as you do today.`);
    say(`  3. Watch it: npx cinq-git open   (the dashboard, signed in for that browser tab; run it again to get back in)`);
    say(`  Parked jobs wait for you on the dashboard; approving takes the approval code from deploy.`);
  },

  // Claude Code Stop hook (cinq init --track-tokens): sums the session's usage from its transcript and reports what is
  // new since the last report. Never fails the session: any error is swallowed.
  async 'usage-hook'() {
    try {
      const input = JSON.parse(readFileSync(0, 'utf8') || '{}'); if (!input.transcript_path || !existsSync(join(input.cwd || '.', REPO_FILE))) return;
      // the agent name comes from ~/.cinq (written by init), not from the repo, which the agent itself can edit
      const { repo } = JSON.parse(readFileSync(join(input.cwd || '.', REPO_FILE), 'utf8')); if (!REPO_NAME.test(repo || '')) return;
      const agent = (JSON.parse(readFileSync(join(CFG_DIR, 'checkouts.json'), 'utf8'))[input.cwd || process.cwd()] || {}).agent; if (!agent) return;
      const seen = new Set(); const t = { input: 0, cachedInput: 0, output: 0 }; let first = null;
      for (const line of readFileSync(input.transcript_path, 'utf8').split('\n')) {
        let e; try { e = JSON.parse(line); } catch { continue; }
        const u = e.message?.usage; if (e.type !== 'assistant' || !u || seen.has(e.message.id)) continue;
        seen.add(e.message.id); first ??= Date.parse(e.timestamp) || null;
        t.input += u.input_tokens || 0; t.cachedInput += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); t.output += u.output_tokens || 0;
      }
      const mark = join(CFG_DIR, `usage-${String(input.session_id || 'x').replace(/[^\w-]/g, '')}.json`);
      const prev = existsSync(mark) ? JSON.parse(readFileSync(mark, 'utf8')) : { input: 0, cachedInput: 0, output: 0, until: first || Date.now() };
      const d = { input: t.input - prev.input, cachedInput: t.cachedInput - prev.cachedInput, output: t.output - prev.output };
      if (d.input + d.cachedInput + d.output <= 0) return;
      const now = Date.now();
      const r = await api(`repos/${repo}/usage-for`, { soft: true, body: { agent, ...d, vendor: 'claude', since: prev.until, until: now } });
      if (r.ok) writeFileSync(mark, JSON.stringify({ ...t, until: now }));
    } catch {}
  },

  async status() {
    const repo = repoName();
    const { intents } = await api(`repos/${repo}/intents`);
    const { events } = await api(`repos/${repo}/events`);
    const mark = { 'awaiting-review': '◎', landed: '●', rederive: '◐', rederiving: '◐', open: '○', building: '·', parked: '▬', working: '·', queued: '·', landing: '·', dependent: '◐', 'waiting-on-dependents': '◐' };
    say(`${repo}: ${intents.filter((i) => i.state === 'landed').length} jobs landed · ${intents.filter((i) => !['landed', 'parked'].includes(i.state)).length} in flight · ${intents.filter((i) => i.state === 'parked').length} parked`);
    for (const i of intents.slice(-15)) say(`  ${mark[i.state] || '·'} ${i.id.padEnd(34)} ${words(i.state).padEnd(22)} ${words(i.landed_via || '')}${i.holder && i.state !== 'landed' ? `  (${i.holder})` : ''}`);
    say(`  last event: ${words(events.at(-1)?.type || '—')}`);
    const hr = await api(`repos/${repo}/rules`, { soft: true });
    if (hr.ok) say(hr.version ? `  house rules: version ${hr.version}, ${hr.rules.length} rule${hr.rules.length === 1 ? '' : 's'}${hr.reviewers ? `, reviewed only by ${hr.reviewers}` : ''}  (npx cinq-git rules)` : '  house rules: none yet; reviewers use their own judgement  (npx cinq-git rules edit)');
    // what, if anything, is waiting on you
    const n = (st) => intents.filter((i) => st.includes(i.state)).length;
    const parked = intents.filter((i) => i.state === 'parked');
    if (parked.length) say(`\n${parked.length} parked, waiting for you: npx cinq-git decide <job> approve|retry|drop  (or the web home: npx cinq-git open)\n${parked.map((i) => `  ${i.id}`).join('\n')}`);
    const crewWork = n(['awaiting-examiner', 'awaiting-review', 'rederive', 'dependent', 'open']);
    if (crewWork) say(`\n${crewWork} waiting for a builder, an examiner, a reviewer or a rebuilder. If no crew is running: npx cinq-git crew`);
  },

  async rules() {
    const repo = repoName(); const hr = await api(`repos/${repo}/rules`);
    if (args[1] !== 'edit' && args[1] !== 'set') {
      if (!hr.version) return say(`${repo} has no house rules yet: reviewers use their own judgement.\n  npx cinq-git rules edit   (or the House rules page in the web home)`);
      say(`${repo} house rules, version ${hr.version}${hr.reviewers ? ` · reviewed only by agents matching ${hr.reviewers}` : ''}`);
      hr.rules.forEach((r, i) => say(`  ${i + 1}. ${r}`));
      return say(`  sha256 ${hr.hash.slice(0, 16)}…  ·  every receipt records the version its review was held to`);
    }
    let text;
    if (args[1] === 'set') text = readFileSync(flag('file') || die('usage: npx cinq-git rules set --file <rules.txt>'), 'utf8');
    else {
      const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os');
      const file = join(mkdtempSync(join(tmpdir(), 'cinq-rules-')), 'house-rules.md'); writeFileSync(file, rulesText(repo, hr));
      const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
      const r = spawnSync(editor, [file], { stdio: 'inherit', shell: true }); if (r.status !== 0) die('editor exited without saving');
      text = readFileSync(file, 'utf8');
    }
    const next = parseRules(text);
    if (JSON.stringify(next) === JSON.stringify({ reviewers: hr.reviewers, rules: hr.rules })) return say('no change');
    const saved = await api(`repos/${repo}/rules`, { body: { ...next, code: await askCode('changing the house rules') } });
    say(`✔ house rules version ${saved.version}: ${saved.rules.length} rule${saved.rules.length === 1 ? '' : 's'}${saved.reviewers ? `, reviewed only by ${saved.reviewers}` : ''}. Reviews that start from now are held to them.`);
  },

  // A person's call on a parked job: approve (that exact commit, past the gate it hit; still reviewed), retry, drop
  async decide() {
    const [, job, action] = args;
    if (!job || !['approve', 'retry', 'drop'].includes(action)) die('usage: npx cinq-git decide <job> approve|retry|drop [--note "for the rebuilder"]');
    const code = action === 'approve' ? await askCode('approving this job') : undefined;
    const r = await api(`repos/${repoName()}/intents/${encodeURIComponent(job)}/decide`, { body: { action, note: flag('note') || '', code } });
    say({ approve: `✔ approved past ${r.gate}; it lands after an agent reviews it`, retry: '✔ sent back; a fresh agent will rebuild it from the goal', drop: '✔ dropped' }[action]);
  },

  async watch() {
    const c = cfg(); const repo = repoName();
    const ws = new WebSocket(`${c.url.replace(/^http/, 'ws')}/ws/${encodeURIComponent(repo)}?since=${flag('since', 0)}`, { headers: { authorization: `Bearer ${c.ownerKey}` } });
    ws.onmessage = (m) => { const e = JSON.parse(m.data); say(`${new Date(e.ts).toLocaleTimeString()}  ${words(e.type).padEnd(18)} ${(e.intent || '').padEnd(30)} ${e.agent || ''}`); };
    ws.onclose = () => die('stream closed', 0);
  },

  async key() {
    if (args[1] !== 'create' || !args[2]) die('usage: npx cinq-git key create <agent-name>');
    // every agent key is bound to one repo: an unbound key could read and write them all
    const c = cfg(); const { key } = await api('keys', { body: { agent: args[2], repo: repoName() } });
    say(`agent "${args[2]}": ${key}\n  claude ${mcpLine(c.url, key).map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`);
  },

  // The key travels in the URL fragment, which is never sent to the server; it is printed only if no browser opens.
  async open() {
    const c = cfg();
    // outside a repo folder: your only repo, or the list to pick from
    let repo = flag('repo') || (existsSync(REPO_FILE) ? repoName() : null);
    if (!repo) {
      const names = (await api('repos')).repos.map((r) => r.name);
      if (names.length !== 1) die(names.length ? `which repo? npx cinq-git open --repo <name>, one of: ${names.join(', ')}` : 'no repos yet: run npx cinq-git init in a git repo first');
      repo = names[0];
    }
    if (!REPO_NAME.test(repo)) die(`"${repo}" isn't a repo name`);
    const page = `${c.url}/r/${encodeURIComponent(repo)}`, link = `${page}#k=${c.ownerKey}`;
    const [bin, ...pre] = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open'];
    const r = spawnSync(bin, [...pre, link], { windowsHide: true, stdio: 'ignore' });
    if (r.status === 0) say(`✔ opened ${page} in your browser, signed in for that tab (run npx cinq-git open again to get back in)`);
    else say(`! no browser here; this link carries your owner key, so treat it like the key:\n  ${link}`);
  },

  async delete() {
    const repo = flag('repo') || die('usage: npx cinq-git delete --repo <name> --yes'); if (!has('yes')) die(`this permanently deletes ${repo} on Artifacts; re-run with --yes`);
    const r = await api(`repos/${encodeURIComponent(repo)}`, { method: 'DELETE', body: { code: await askCode(`deleting ${repo}`) } }); say(`✔ deleted ${repo} (${r.artifactsReposDeleted} Artifacts repos)`);
  },

  async stop() { const r = await api('stop', { body: {} }); say(`✔ stopped: ${r.revoked} agent keys revoked; running agents can no longer claim, push or submit`); },

  async sync() {
    const repo = repoName();
    const { remote } = await api(`repos/${repo}/read-remote`, { body: {} });
    // --branch <name>: move that branch to main without touching your checkout (fast-forward only), e.g. a branch
    // your existing CI or deploy watches. On the checked-out branch it's the plain sync below.
    const branch = flag('branch');
    if (branch && branch !== git('rev-parse', '--abbrev-ref', 'HEAD')) {
      try { git('check-ref-format', '--branch', branch); } catch { die(`not a valid branch name: ${branch}`); }
      let before = ''; try { before = git('rev-parse', '-q', '--verify', `refs/heads/${branch}`); } catch {}
      try { git('fetch', '-q', remote, 'main'); } catch (e) { die(`fetch failed: ${mask(e.stderr || e.message)}`); }
      const after = git('rev-parse', 'FETCH_HEAD');
      if (before === after) return say(`✔ ${branch} is already up to date with main`);
      if (before) { try { git('merge-base', '--is-ancestor', before, after); } catch { die(`${branch} has commits that aren't on main; sync never rewrites a branch (bring them in as a job, or use a new branch)`); } }
      git('update-ref', `refs/heads/${branch}`, after, before || '0'.repeat(40)); // fails if the branch moved meanwhile
      const n = before ? git('rev-list', '--count', `${before}..${after}`) : git('rev-list', '--count', after);
      return say(`✔ ${before ? 'fast-forwarded' : 'created'} ${branch}: ${n} commit${+n === 1 ? '' : 's'} from main · push it with: git push origin ${branch}`);
    }
    try { git('fetch', '-q', remote, 'main'); } catch (e) { die(`fetch failed: ${mask(e.stderr || e.message)}`); }
    const behind = git('rev-list', '--count', 'HEAD..FETCH_HEAD');
    if (behind === '0') return say('✔ already up to date with main');
    try { git('merge', '--ff-only', '-q', 'FETCH_HEAD'); } catch { die('your checkout has diverged from main; commit or stash, then retry (sync never rewrites your work)'); }
    say(`✔ fast-forwarded ${behind} commit${+behind === 1 ? "" : "s"} from main`);
  },

  async crew() {
    const vendor = flag('agent', 'claude'); if (!['claude', 'codex'].includes(vendor)) die('--agent is claude or codex');
    const only = flag('only'); if (only && !['review', 'examine'].includes(only)) die('--only is review or examine');
    const c = cfg(); const repo = repoName(); const n = +flag('n', 4); const rounds = +flag('rounds', 3); const sessions = +flag('sessions', Infinity); const idleMin = +flag('idle', 30); const first = +flag('start', 1);
    // Wait until the board has something a crew agent can take (an empty board is just early: keep waiting);
    // false after idleMin minutes with nothing.
    // seen: the board as it was when this agent's last session ended. A job this agent may not take (it built or
    // examined it) stays on the board, so the same board never starts another session: only a change does.
    // An unchanged board gets one more try after RETRY_MS anyway: the last session may have stopped at --rounds, or
    // failed to start (a rate limit), with work it could take still waiting. Errors reading the board are retried.
    const RETRY_MS = 5 * 60_000;
    // what this crew can take: a reviewer-only crew wakes for reviews alone
    const wants = (d) => (only === 'review' ? d.review?.state === 'needed' : only === 'examine' ? d.exam_state === 'needed'
      : ['rederive', 'dependent', 'open'].includes(d.state) || d.exam_state === 'needed' || d.review?.state === 'needed');
    const waitForWork = async (r, seen, seenAt = 0, maxMs = idleMin * 60_000) => {
      const until = Date.now() + maxMs;
      for (; Date.now() < until; await new Promise((res) => setTimeout(res, 15_000))) {
        const list = await api(`repos/${r}/intents`, { soft: true }); if (!list.ok) continue;
        const intents = list.intents;
        const open = intents.filter((x) => !['landed', 'parked', 'satisfied', 'rejected'].includes(x.state));
        if (open.length && open.some((x) => ['rederive', 'dependent', 'open', 'awaiting-review', 'awaiting-examiner', 'working', 'building', 'queued'].includes(x.state))) {
          const detail = (await Promise.all(open.map((x) => api(`repos/${r}/intents/${encodeURIComponent(x.id)}`, { soft: true }).then((d) => d.intent)))).filter(Boolean);
          const wanted = detail.filter(wants);
          const sig = JSON.stringify(wanted.map((d) => [d.id, d.state, d.exam_state, d.review?.state, d.attempts]));
          if (wanted.length && (sig !== seen || Date.now() - seenAt > RETRY_MS)) return sig;
        }
      }
      return null;
    };
    const boardNow = async (r) => { // the same signature waitForWork computes, taken right after a session
      const list = await api(`repos/${r}/intents`, { soft: true }); if (!list.ok) return null;
      const open = list.intents.filter((x) => !['landed', 'parked', 'satisfied', 'rejected'].includes(x.state));
      const detail = (await Promise.all(open.map((x) => api(`repos/${r}/intents/${encodeURIComponent(x.id)}`, { soft: true }).then((d) => d.intent)))).filter(Boolean);
      return JSON.stringify(detail.filter(wants).map((d) => [d.id, d.state, d.exam_state, d.review?.state, d.attempts]));
    };
    const base = flag('name', vendor === 'codex' ? 'codex' : 'crew'); // agent names are identities: a new name is a new agent
    const mcp = (...t) => t.map((x) => `mcp__crew__${x}`).join(',');
    const SHARED = `You are one agent on Cinq, a Git platform where agents check each other's work. Your job and everything you need for it are in the work order the user gives you. Be brief: no commentary, no summaries beyond one line per job. Never touch .cinq/ or existing tests.`;
    const ROLES = {
      review: { tools: '', allowed: mcp('submit_review', 'get_intent'),
        system: `${SHARED} You are the REVIEWER: another agent wrote this change. Review it on three axes. SPEC: does the diff do what the goal (and the ask it came from) says, no less and no more? STANDARDS: does it meet the house rules and the repo's own guidelines, and does it fit how the neighbouring code is built (layers, where things live, naming, error handling, existing abstractions)? LEAN: does it add anything the goal does not need (tests that repeat another test or restate the implementation, dead or unused code, an abstraction with one caller, defensive checks for impossible cases, comments that narrate the code, copied logic, debug output)? Block for a broken house rule, a spec gap, special-cased tests, a security risk, code that fights the architecture, or slop you are sure of (say what to delete); never for taste. Hand in with submit_review: verdict, a one-sentence summary, and findings [{file, line, severity, axis, reason, rule}] (axis: spec | standards | lean) where rule is the house rule's number (0 if none covers it; omit when there are no house rules).` },
      examine: { tools: 'Bash,Read,Glob,Grep', allowed: mcp('submit_tests', 'get_intent') + ',Read,Glob,Grep,Bash(git clone:*),Bash(ls:*)',
        system: `${SHARED} You are the EXAMINER: another agent is building this goal and you never see its code. Write the fewest hidden tests that check the goal from the outside, using the repo's test style (trunkFiles shows the code as it is today; clone the read-only remote only if you need more). Hand them in with submit_tests as {path: content}; write nothing to disk and run nothing: the lander runs them, sealed, against the build. Your report says what the tests check, never that you could not run them.` },
      rederive: { tools: 'Bash,Read,Edit,Write,Glob,Grep', allowed: mcp('submit', 'status', 'house_rules', 'get_intent', 'release') + ',Read,Edit,Write,Glob,Grep,Bash(git:*),Bash(node --test:*),Bash(npm test:*),Bash(npm install:*),Bash(npm ci:*),Bash(npm --prefix:*),Bash(npx vitest:*),Bash(npx jest:*),Bash(ls:*)',
        system: `${SHARED} You are a BUILDER: build the work order's goal on your own fork, and nothing more: the fewest tests that prove it, no dead code, no abstraction with one caller, no comments that narrate the code. Clone it with one plain command (git clone <remote> <folder>), work there, meet the house rules, install with npm --prefix <folder> ci (never cd), run the tests with npm --prefix <folder> test. Before you push, run git -C <folder> diff --name-only origin/main: every file must be in the work order's allowed list (changing any other file is refused). If the goal truly needs a file outside it, call release with the reason instead. Then git -C <folder> add/commit/push origin HEAD:main (never chain commands with cd and &&) and call submit. Do not wait for it to land.` },
    };
    ROLES.build = ROLES.dependent = ROLES.rederive;
    const claimCall = only ? `claim with kind "${only}"` : 'claim (no arguments)';
    const prompt = `You are a crew agent on a shared repo named ${repo}. Use the crew MCP tools. Call ${claimCall} to take the next job on the board. Follow its work order exactly: for a review, read the goal, the diff, the gate results and the house rules in the work order (there is nothing to clone), then hand in submit_review with verdict "pass" or "block", a one-sentence summary of what you checked, and findings [{file, line, severity, reason, rule}] where rule is the number of the house rule it breaks (0 if none covers it; leave rule out when the work order has no house rules); block when the change breaks a house rule or has a real problem (the diff doesn't do the goal, does more than the goal, special-cases tests, adds a security risk), never for style. For an examination, clone the read-only main with one plain command (git clone <remote> <folder>), then write hidden tests for the goal and hand them in with submit_tests. For a build, a rebuild or a dependent fix, clone your fork with one plain command (git clone <remote> <folder>), do the work there (meet the house rules: house_rules lists them), use git -C <folder> for add/commit/push origin HEAD:main (never chain commands with cd and &&), submit (don't wait for it to land: the platform takes it from there). Then claim again. Stop when claim says there are no jobs, or after ${rounds} jobs. Reply with one line per job you did.`;
    const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os');
    // Separation of duties: a reviewer may not have written, examined or rebuilt the job, so a rebuilt job needs an
    // author, an examiner, a rebuilder and a reviewer who are all different: fewer than 4 crew can leave it stuck.
    // Codex's workspace-write sandbox can read the whole disk, ~/.cinq included (Claude Code crews are denied it)
    if (vendor === 'codex') say('! Codex agents run with read access to your home folder, including ~/.cinq (your owner key). Run a Codex crew as a separate OS user if that matters to you.');
    if (n < 4 && !only) say(`! with ${n} crew agents a rebuilt job may find no eligible reviewer; 4 or more is safe`);
    say(`→ ${n} crew agent(s) on ${repo}, waiting for work. They start a Claude Code session only when a job needs them, and stop after ${idleMin} idle minutes (--idle). Ctrl-C to stop now.`);
    await Promise.all(Array.from({ length: n }, async (_, i) => {
      const me = `${base}-${first + i}`; const { key } = await api('keys', { body: { agent: me, repo } });
      const dir = mkdtempSync(join(tmpdir(), `${me}-`));
      const cfgFile = join(dir, 'mcp.json');
      writeFileSync(cfgFile, JSON.stringify({ mcpServers: { crew: { type: 'http', url: `${c.url}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }));
      const { spawn } = await import('node:child_process');
      // Reviews and rebuilds appear only after landings run, so an empty board isn't the end while jobs are in flight.
      // a Claude Code session starts only when there is work for it, so an idle crew costs nothing
      let seen = null, seenAt = 0;
      for (let session = 0; session < sessions; session++) {
        if (!(await waitForWork(repo, seen, seenAt))) { say(`[${me}] nothing to do for ${idleMin} minutes; stopping`); break; }
        // Claim before starting a session: a session starts only with a job in hand, so two agents never wake for one job
        // and a job this agent may not take (it built or examined it) never costs a session.
        const startedAt = Date.now();
        const pre = await api(`repos/${repo}/claim`, { key, soft: true, body: only ? { kind: only } : {} });
        if (!pre.ok || !pre.claim) { seen = await boardNow(repo).catch(() => null); seenAt = Date.now(); session--; continue; }
        say(`[${me}] took ${pre.claim.kind} ${pre.claim.intent?.id || ''}; starting a session`);
        // the work order carries a fork remote with a token: it goes in on stdin, never on the command line
        // Claude Code sessions are lean: one job each, a short system prompt for its role, and only the tools that role
        // needs (a reviewer has its whole job in the work order and needs none). Codex keeps the general prompt.
        const role = ROLES[pre.claim.kind] || ROLES.rederive;
        const input = vendor === 'codex' ? `${prompt}\n\nYou already hold your first job: its work order is below (claimId ${pre.claim.claimId}). Do it first, exactly as it says; then claim again as above.\n\n${JSON.stringify(pre.claim, null, 1)}`
          : `Your job on ${repo} (claimId ${pre.claim.claimId}). Do it exactly as the work order says, hand it in, then stop.\n\n${JSON.stringify(pre.claim, null, 1)}`;
        await new Promise((res) => {
          // Codex reaches the same MCP server over HTTP; its key comes from the environment, never its config files
          const [bin, argv] = vendor === 'codex'
            ? ['codex', ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-c', `mcp_servers.crew.url="${c.url}/mcp"`, '-c', 'mcp_servers.crew.bearer_token_env_var="CINQ_CREW_KEY"', '-']]
            : [claudeExe() || 'claude', ['-p', '--output-format', 'json', '--mcp-config', cfgFile, '--strict-mcp-config', '--settings', agentSettings(dir), '--setting-sources', '',
              '--system-prompt', role.system, '--tools', role.tools, '--permission-mode', 'acceptEdits', '--allowedTools', role.allowed]];
          const work = mkdtempSync(join(dir, 'job-')); // a fresh folder per job: no leftover clone from an earlier one
          const viaShell = process.platform === 'win32' && !/\.exe$/i.test(bin); // a .cmd shim needs a shell; an .exe never does
          const p = spawn(bin, viaShell ? shellArgs(argv) : argv, { windowsHide: true, cwd: work, shell: viaShell, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...(vendor === 'codex' ? { CINQ_CREW_KEY: key } : {}) } });
          let err = ''; p.stderr?.on('data', (d) => (err += d));
          p.stdin.on('error', () => {}); p.stdin.end(input);
          let out = ''; p.stdout.on('data', (d) => (out += d));
          let ended = false; const end = () => { if (!ended) { ended = true; res(); } };
          p.on('error', (e) => { say(`[${me}] could not start ${bin}: ${e.message}`); end(); });
          p.on('close', async () => {
            const { text, usage } = sessionResult(vendor, out);
            say(tidy(mask(text.trim() || (err.trim() ? `the session ended without a report: ${err.trim().split('\n').slice(-3).join(' ')}` : 'the session ended without a report')), `[${me}] `));
            // what the session spent, measured by the agent's own CLI: the board shows tokens per landed change
            if (usage) await api(`repos/${repo}/usage`, { key, soft: true, body: { ...usage, vendor, since: startedAt, until: Date.now() } });
            end();
          });
        });
        seen = await boardNow(repo).catch(() => null); seenAt = Date.now();
      }
    }));
  },
};

const HELP = `cinq: a Git platform where your agents check each other's work, on your Cloudflare account

Start
  npx cinq-git deploy [--name cinq]            put Cinq on your Cloudflare account and log in (shows your approval code once)
                      [--lander-size basic]    the test containers' size: basic (1 GiB, default) or standard-1 (4 GiB)
                      [--max-landers 6]        how many test containers may run at once
                      [--account-id <id>]      which Cloudflare account, if you have several
                      [--rotate]               deploying again keeps your keys; this makes new ones
  npx cinq-git init                            in a git repo: put it on Cinq and connect Claude Code
                      [--repo <name>] [--agent <name>]  the repo's name on Cinq, your agent's name
                      [--track-tokens]         each Claude Code session reports its tokens to the board
                      [--no-mcp]               don't register the MCP server with Claude Code
  npx cinq-git crew [--n 4]                    in a second terminal: agents that build, examine, review and rebuild
                      [--only review|examine]  a crew with one role
                      [--agent claude|codex]   which coding agent (Codex is experimental)
                      [--name crew]            the agents' name prefix (crew-1, crew-2, …)
                      [--idle 30]              minutes with nothing to do before the crew stops

Every day
  npx cinq-git status | watch | open           the board, live events, the web home
  npx cinq-git decide <job> approve|retry|drop [--note ..]  your call on a parked job (approve takes the approval code)
  npx cinq-git rules [edit] [set --file f]     your house rules: what every review is held to
  npx cinq-git sync [--branch <name>]          bring main to your checkout, or move a branch to main

Keys and repos
  npx cinq-git login --url <url> --owner-key <key>  use a deployment from another machine
  npx cinq-git approval-code [--name cinq]     a new approval code (the old one stops working)
  npx cinq-git signing-key [--name cinq]       sign every landing commit from now on (made at deploy)
  npx cinq-git key create <agent>              another agent key
  npx cinq-git stop                            revoke every agent key
  npx cinq-git delete --repo <name> --yes      delete a repo (takes the approval code)

Docs: https://github.com/altrwork/cinq`;
const cmd = commands[args[0]];
if (!cmd) {
  if (args[0] && !['help', '--help', '-h'].includes(args[0])) process.stderr.write(`✖ unknown command: ${args[0]}\n\n`);
  say(HELP); process.exit(args[0] && !['help', '--help', '-h'].includes(args[0]) ? 1 : 0);
}
await cmd();
