// The coordination engine for one repo. Plain JS over a SQL handle so it runs inside RepoDO
// (ctx.storage.sql) and, unchanged, in Node tests (node:sqlite). Platform pieces are injected:
//   artifacts: { trunkUrl() (write: the lander's landings only), trunkReadUrl() (checks), fork(name) → {name, url}, remove(name) }
//   lander:    { land(body), check(body), stage(body) }     (the container lander's ops)
//   now():     ms clock;  emit(event): broadcast hook (WebSockets)
//
// Model (agents decide everything; a person decides only what parks):
//   intent  = a job: goal + allowed paths + the proposing agent's tests (+ hidden tests, later from the examiner)
//   claim   = one agent working one intent on its own fork, with a lease
//   landing = one claim's fork gated and landed by the lander, one at a time
// Outcomes: landed | conflict/red/rejected/noop → re-derive job for a FRESH agent (max 2) → parked
//           breaks-dependents → stage on a fork, dependent job, both land together
//           parked (a security gate wants a person: protected path, diff budget, new package with install scripts)
//           → decide(): a person approves that exact commit past its gate, sends it back to be rebuilt, or drops it
// Asks: one long ask from a person becomes several tickets (propose_plan). The asking session builds one; the rest
// wait on the board as build tickets that crew agents claim, each on its own fork.
// House rules: the review criteria a person sets (versioned, hashed). Every review work order carries them, every
// finding cites the rule it breaks, every receipt records the version. They can also say which agents may review.
// Review: a change that passes every gate waits for a REVIEW work order, claimed by one of the user's own
// agents that neither wrote, rebuilt nor examined it. It reads the goal, the diff and the gate results and
// returns {verdict, findings}. pass → lands (findings on the receipt). block → rebuilt by a fresh agent with the
// findings as context; a second block parks it. .cinq/config.json "review": "block" | "advisory" | "off".
const DEFAULT_LEASE_MS = 20 * 60 * 1000; // configurable per deployment (LEASE_SECONDS)
const MAX_REDERIVE = 2;
const MAX_REVIEW_BLOCKS = 2;
const MAX_INFRA_RETRIES = 2; // a landing that fails for infrastructure reasons is retried this many times, free
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const AXES = ['spec', 'standards', 'lean']; // what a review finding is about
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, goal TEXT, kind TEXT, allowed TEXT, tests TEXT, hidden TEXT,
     state TEXT, author TEXT, attempts INTEGER DEFAULT 0, last_diff TEXT, last_failure TEXT, landed_sha TEXT, landed_via TEXT,
     receipt TEXT, staged_for TEXT, created INTEGER, updated INTEGER)`,
  `CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, intent TEXT, agent TEXT, kind TEXT, generation INTEGER,
     lease_until INTEGER, fork_name TEXT, fork_url TEXT, state TEXT, result TEXT, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, claim TEXT)`,
  `CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, intent TEXT, claim TEXT, agent TEXT, data TEXT)`,
  `CREATE TABLE IF NOT EXISTS asks (id TEXT PRIMARY KEY, text TEXT, agent TEXT, created INTEGER)`,
  `CREATE TABLE IF NOT EXISTS rules (version INTEGER PRIMARY KEY, body TEXT, hash TEXT, by TEXT, at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, vendor TEXT, input INTEGER, cached INTEGER, output INTEGER,
     cost REAL, since INTEGER, until INTEGER, claims TEXT, at INTEGER)`,
];
const BUILDERS = "('author', 'rederive', 'dependent', 'build')"; // claim kinds that write the job's code
const MAX_TICKETS = 12, MAX_RULES = 30;
// "codex-*" matches codex-1, codex-2 ...; a pattern is a name with * wildcards, nothing else
const nameMatch = (pattern, name) => new RegExp(`^${String(pattern).split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);
const sha256 = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const J = (s) => (s == null ? null : JSON.parse(s));
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'intent';

// Test budget: the fewest tests that prove the goal. Agents happily write dozens; on main that is noise.
const TEST_BUDGET = 5;
const testCases = (files) => Object.values(files || {}).reduce((n, c) => n + (String(c).match(/(^|[^.\w])(test|it)(\.only|\.skip)?\s*\(/g) || []).length, 0);
// Every test file must contain at least one test case: a file that doesn't load "fails on trunk" too, so without
// this placeholder text would pass the vacuity check.
const APPROVABLE = ['protectedPaths', 'diffBudget', 'deps']; // security gates a person may wave through
const noCases = (files) => { const empty = Object.entries(files || {}).filter(([, c]) => testCases({ f: c }) === 0).map(([p]) => p); if (empty.length) throw new ApiError(400, `no test cases in ${empty.join(', ')}: each test file needs at least one test(...) or it(...) that checks the goal`, { files: empty }); };
// Every path an agent names (allowed files, its tests, an examiner's hidden tests) is a plain path inside the repo:
// no "..", no absolute or Windows paths, nothing under .cinq/ or .git/ (the platform's own files). The lander writes
// registered tests itself, so a path like test/../.cinq/config.json would otherwise reach main's config.
const unsafePath = (p) => typeof p !== 'string' || !p || p.length > 300 || /[\\\0]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)
  || p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '') || /^\.(cinq|git)(\/|$)/i.test(p);
const checkPaths = (paths, what) => { const bad = paths.filter(unsafePath); if (bad.length) throw new ApiError(400, `${what} must be plain paths inside the repo (no "..", no absolute paths, nothing under .cinq/ or .git/): ${bad.join(', ')}`); };
const overBudget = (files) => { const n = testCases(files); if (n > TEST_BUDGET) throw new ApiError(422, `test budget: ${n} test cases; at most ${TEST_BUDGET} per job. Write the fewest tests that prove the goal (usually 1 to 3).`, { testCases: n, budget: TEST_BUDGET }); };

export class Engine {
  constructor({ sql, artifacts, lander, now = Date.now, emit = () => {}, examine = true, review = true, leaseMs = DEFAULT_LEASE_MS }) {
    Object.assign(this, { sql, artifacts, lander, now, emit, examine, review, leaseMs });
    for (const s of SCHEMA) this.sql.exec(s);
    for (const col of ['exam_state TEXT', 'examiner TEXT', 'supersedes TEXT', 'supersede_review TEXT', 'deps TEXT', 'review TEXT', 'review_blocks INTEGER DEFAULT 0', 'plan TEXT', 'approvals TEXT', 'ask TEXT']) { try { this.sql.exec(`ALTER TABLE intents ADD COLUMN ${col}`); } catch {} } // migrate older DOs
    try { this.sql.exec('ALTER TABLE queue ADD COLUMN priority INTEGER DEFAULT 0'); } catch {}
    this.busy = false;
  }
  q(query, ...args) { return this.sql.exec(query, ...args).toArray(); }
  one(query, ...args) { return this.q(query, ...args)[0] || null; }
  event(type, f = {}) {
    const ts = this.now();
    this.sql.exec('INSERT INTO events (ts, type, intent, claim, agent, data) VALUES (?, ?, ?, ?, ?, ?)', ts, type, f.intent ?? null, f.claim ?? null, f.agent ?? null, JSON.stringify(f.data ?? {}));
    const seq = this.one('SELECT max(seq) AS s FROM events').s;
    const e = { seq, ts, type, intent: f.intent, claim: f.claim, agent: f.agent, data: f.data ?? {} };
    this.emit(e);
    return e;
  }
  intent(id) { const r = this.one('SELECT * FROM intents WHERE id = ?', id); return r && { ...r, allowed: J(r.allowed), tests: J(r.tests), hidden: J(r.hidden), receipt: J(r.receipt), last_failure: J(r.last_failure), deps: J(r.deps) || [], review: J(r.review) }; }
  claimRow(id) { const r = this.one('SELECT * FROM claims WHERE id = ?', id); return r && { ...r, result: J(r.result) }; }
  setIntent(id, fields) {
    const keys = Object.keys(fields);
    this.sql.exec(`UPDATE intents SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated = ? WHERE id = ?`,
      ...keys.map((k) => (fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k])), this.now(), id);
  }

  // Which landed intent owns each test file: the dependents map for the lander.
  testOwners(exclude = []) {
    const owners = {};
    for (const r of this.q("SELECT id, tests, hidden FROM intents WHERE state = 'landed'")) {
      if (exclude.includes(r.id)) continue;
      for (const p of [...Object.keys(J(r.tests) || {}), ...Object.keys(J(r.hidden) || {})]) owners[p] = r.id;
    }
    return owners;
  }

  /** An agent registers the job it is about to do and gets a claim (fork + lease) back immediately. */
  async proposeIntent(agent, { goal, allowed, tests = {}, kind = 'change', id, supersedes = {}, deps = [], plan }, { open = false, ask = null } = {}) {
    if (!goal || !Array.isArray(allowed) || !allowed.length) throw new ApiError(400, 'goal and allowed[] are required');
    if (!['change', 'keep'].includes(kind)) throw new ApiError(400, 'kind must be "change" or "keep"');
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || !d)) throw new ApiError(400, 'deps must be a list of package names');
    checkPaths(allowed, 'allowed'); checkPaths(Object.keys(tests), 'tests'); checkPaths(Object.keys(supersedes), 'supersedes');
    if (kind === 'change' && !Object.keys(tests).length && !Object.keys(supersedes).length) throw new ApiError(400, 'a change needs at least one test that fails today (use kind:"keep" for refactors)')
    overBudget(tests); noCases(tests);
    // A legitimate behaviour change may need EXISTING tests updated. The agent declares the new full content of
    // each such file; an independent agent must approve each change before it can land (no self-approval).
    for (const p of Object.keys(supersedes)) if (!/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) throw new ApiError(400, `supersedes must name existing test files: ${p}`);
    allowed = [...new Set([...allowed, ...Object.keys(supersedes)])];
    for (const p of Object.keys(tests)) if (!/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) throw new ApiError(400, `not a test path: ${p}`);
    // Idempotent propose: an agent retrying (e.g. after a client timeout) gets its open job back instead of
    // a duplicate. Same agent + same allowed files + the same goal or the same tests + an unsubmitted active claim =
    // the same job. (A retry resends its tests; a second session sharing the key that touches the same files with
    // its own goal and tests is a second job, never folded into the first.)
    // a retried plan: the same ticket from the same asker, still waiting or being built, is the same ticket
    if (open) for (const t of this.q("SELECT id, goal, allowed FROM intents WHERE author = ? AND state IN ('open', 'building')", agent)) {
      if (JSON.stringify([...J(t.allowed)].sort()) === JSON.stringify([...allowed].sort()) && String(t.goal).trim() === goal.trim()) return { intentId: t.id, validity: { checked: false }, state: 'open', duplicateOf: t.id };
    }
    const files = JSON.stringify([...allowed].sort()), testsKey = JSON.stringify(tests);
    const same = (r) => JSON.stringify([...J(r.allowed)].sort()) === files && (String(r.goal || '').trim() === goal.trim() || (Object.keys(tests).length && r.tests === testsKey));
    for (const job of open ? [] : this.q("SELECT i.id, i.goal, i.allowed, i.tests, c.id AS claim FROM intents i JOIN claims c ON c.intent = i.id WHERE i.author = ? AND c.agent = ? AND c.kind = 'author' AND c.state = 'active'", agent, agent)) {
      if (same(job)) {
        // Same job. If the author changed its OWN tests before submitting (e.g. it spotted a wrong expected
        // value), accept the correction after re-checking that the new tests still fail on today's trunk.
        const cur = this.intent(job.id);
        if (Object.keys(tests).length && JSON.stringify(tests) !== JSON.stringify(cur.tests || {})) {
          const v = await this.check({ trunk: this.artifacts.trunkReadUrl(), tests });
          if (!v.failsOnTrunk) throw new ApiError(422, 'corrected tests already pass on current trunk, so they cannot prove the change', { validity: v });
          this.setIntent(job.id, { tests, goal });
          this.event('intent.amended', { intent: job.id, agent, data: { tests: Object.keys(tests), validity: { head: v.head, testsRun: v.testsRun, failsOnTrunk: v.failsOnTrunk } } });
          return { intentId: job.id, validity: { checked: true, failsOnTrunk: true, note: 'your open job was updated with the corrected tests' }, claim: this.workOrder(job.claim), amended: true };
        }
        this.event('intent.deduplicated', { intent: job.id, agent, data: { goal } });
        return { intentId: job.id, validity: { checked: false, note: 'you already have this job open; continuing it' }, claim: this.workOrder(job.claim), duplicateOf: job.id };
      }
    }
    // Resume: the author's own job whose lease lapsed (it went quiet while coding) and that nobody else has
    // picked up yet. Hand the same job back instead of creating a duplicate; this is not a rebuild.
    for (const mine of open ? [] : this.q("SELECT id, goal, allowed, tests FROM intents WHERE author = ? AND state = 'rederive'", agent)) {
      if (!same(mine)) continue;
      // only a lapse: a job blocked in review, denied a test change or failed at a gate goes to a fresh agent
      if (this.intent(mine.id).last_failure?.reason !== 'lease expired') continue;
      if (this.one(`SELECT 1 AS x FROM claims WHERE intent = ? AND agent != ? AND kind IN ${BUILDERS} LIMIT 1`, mine.id, agent)) continue;
      if (this.one("SELECT 1 AS x FROM claims WHERE intent = ? AND state IN ('active','queued','waiting') AND agent != ?", mine.id, agent)) continue;
      if (Object.keys(tests).length && JSON.stringify(tests) !== JSON.stringify(this.intent(mine.id).tests || {})) {
        const v = await this.check({ trunk: this.artifacts.trunkReadUrl(), tests });
        if (!v.failsOnTrunk) throw new ApiError(422, 'corrected tests already pass on current trunk, so they cannot prove the change', { validity: v });
        this.setIntent(mine.id, { tests, goal });
      }
      this.setIntent(mine.id, { attempts: Math.max(0, (this.intent(mine.id).attempts || 1) - 1) }); // a lapse isn't a failed attempt
      this.event('intent.resumed', { intent: mine.id, agent, data: { reason: 'author came back after its lease lapsed' } });
      const claim = await this.openClaim(mine.id, agent, 'author');
      return { intentId: mine.id, validity: { checked: false, note: 'your earlier job (lease lapsed) was handed back to you' }, claim, resumed: true };
    }
    // the id becomes a file name (.cinq/intents/<id>.md, .cinq/receipts/<id>.json) and a fork name: always a slug
    let intentId = this.uniqueId(slug(id || goal));
    let validity = { checked: false }; let before = {};
    if (kind === 'change') {
      const c = await this.check({ trunk: this.artifacts.trunkReadUrl(), tests, supersedes });
      if (c.missing?.length) throw new ApiError(400, `supersedes names files that are not existing tests on trunk: ${c.missing.join(', ')} (put new tests in "tests")`);
      before = c.before || {};
      validity = { checked: true, head: c.head, testsRun: c.testsRun, failsOnTrunk: c.failsOnTrunk };
      if (!c.failsOnTrunk) {
        this.event('intent.rejected', { intent: intentId, agent, data: { reason: 'vacuous', detail: 'its tests already pass on trunk, so they prove nothing' } });
        throw new ApiError(422, 'vacuous intent: these tests already pass on current trunk, so they cannot prove the change. Write a test that fails today.', { validity });
      }
    }
    const t = this.now();
    intentId = this.uniqueId(slug(id || goal)); // again, after the awaits: a concurrent propose may have taken it
    this.sql.exec('INSERT INTO intents (id, goal, kind, allowed, tests, hidden, state, author, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      intentId, goal, kind, JSON.stringify(allowed), JSON.stringify(tests), JSON.stringify({}), open ? 'open' : 'working', agent, t, t);
    if (ask) this.setIntent(intentId, { ask });
    if (deps.length) this.setIntent(intentId, { deps });
    if (typeof plan === 'string' && plan.trim()) this.setIntent(intentId, { plan: plan.trim().slice(0, 2000) });
    // who else is already changing these files: told now, before any code is written, not after a collision
    const overlaps = this.overlaps(allowed, intentId);
    if (overlaps.length) this.event('intent.overlap', { intent: intentId, agent, data: { with: overlaps } });
    if (Object.keys(supersedes).length) this.setIntent(intentId, { supersedes, supersede_review: { state: 'needed', files: Object.fromEntries(Object.keys(supersedes).map((p) => [p, { before: before[p] ?? null }])) } });
    this.event('intent.proposed', { intent: intentId, agent, data: { goal, allowed, kind, tests: Object.keys(tests), supersedes: Object.keys(supersedes), validity, ...(ask ? { ask } : {}), ...(open ? { open: true } : {}) } });
    if (this.examine) { // separation of duties: someone else writes hidden tests from the goal alone
      this.setIntent(intentId, { exam_state: 'needed' });
      this.event('examine.queued', { intent: intentId, data: { goal } });
    }
    if (open) return { intentId, validity, state: 'open', ...(overlaps.length ? { overlaps } : {}) };
    let claim;
    try { claim = await this.openClaim(intentId, agent, 'author'); }
    catch (e) { // no fork, no job: don't leave an intent that nobody holds and the board never offers
      this.sql.exec('DELETE FROM intents WHERE id = ?', intentId);
      this.event('intent.withdrawn', { intent: intentId, agent, data: { reason: 'its fork could not be created', detail: String(e.message || e).slice(0, 200) } });
      throw e;
    }
    return { intentId, validity, claim, ...(overlaps.length ? { overlaps, note: 'other open jobs already change some of these files: narrow your files, pick other work, or go ahead knowing whichever lands second is rebuilt on top' } : {}) };
  }

  /** One long ask becomes tickets. The asking agent builds the first (it knows the code best: measured, plan-only asks
   *  named the wrong files more often and cost more in rebuilds); the rest wait on the board as build tickets for
   *  lean crew sessions. build "none" sends every ticket to the crew. A ticket that fails its checks (say, tests that already pass) is
   *  reported and skipped; the others still register. */
  async proposePlan(agent, { ask, tickets, build = 'first' } = {}) {
    if (typeof ask !== 'string' || !ask.trim() || ask.length > 8000) throw new ApiError(400, 'ask is required: the request in the person\'s own words (at most 8000 characters)');
    if (!Array.isArray(tickets) || !tickets.length) throw new ApiError(400, 'tickets[] is required: one entry per independent part of the ask');
    if (tickets.length > MAX_TICKETS) throw new ApiError(400, `at most ${MAX_TICKETS} tickets per ask; split the ask`);
    if (!['first', 'none'].includes(build)) throw new ApiError(400, 'build must be "first" or "none"');
    const askId = rid('ask');
    this.sql.exec('INSERT INTO asks (id, text, agent, created) VALUES (?, ?, ?, ?)', askId, ask.trim(), agent, this.now());
    const out = []; let claim = null;
    try {
    for (const [i, t] of tickets.entries()) {
      try {
        const own = build === 'first' && !claim;
        const r = await this.proposeIntent(agent, t || {}, { open: !own, ask: askId });
        if (own) claim = r.claim;
        out.push({ ticket: i, intentId: r.intentId, state: own ? 'working' : 'open', ...(r.overlaps ? { overlaps: r.overlaps } : {}) });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        out.push({ ticket: i, error: e.message, status: e.status });
      }
    }
    } finally { // every ticket that was registered is on the board under its ask, even if a later one threw
    this.event('ask.planned', { agent, data: { ask: askId, text: ask.trim().slice(0, 2000), tickets: out.filter((x) => x.intentId).map((x) => x.intentId), refused: out.filter((x) => x.error).length } });
    }
    return { askId, tickets: out, claim,
      note: claim ? 'you build the first ticket (its claim is below); the others wait on the board for other agents to build' : 'every ticket waits on the board for other agents to build' };
  }
  asks() {
    const rows = this.q('SELECT * FROM asks ORDER BY created DESC LIMIT 200');
    return rows.map((a) => ({ ...a, tickets: this.q('SELECT id, state FROM intents WHERE ask = ? ORDER BY created', a.id) }));
  }

  /** The house rules in force: {version, hash, rules: [text], reviewers}. Version 0 = none set. */
  houseRules() {
    const r = this.one('SELECT * FROM rules ORDER BY version DESC LIMIT 1');
    if (!r) return { version: 0, hash: null, rules: [], reviewers: null };
    const b = J(r.body);
    return { version: r.version, hash: r.hash, rules: b.rules || [], reviewers: b.reviewers || null, by: r.by, at: r.at };
  }
  rulesHistory() { return this.q('SELECT version, hash, by, at FROM rules ORDER BY version DESC LIMIT 50'); }
  /** A person sets the house rules (the approval code is checked by the caller). Each save is a new version. */
  async setHouseRules(by, { rules, reviewers = null } = {}) {
    if (!Array.isArray(rules) || rules.some((x) => typeof x !== 'string')) throw new ApiError(400, 'rules must be a list of plain sentences');
    rules = rules.map((x) => x.trim()).filter(Boolean);
    if (rules.length > MAX_RULES) throw new ApiError(400, `at most ${MAX_RULES} rules`);
    if (rules.some((x) => x.length > 400)) throw new ApiError(400, 'each rule is at most 400 characters');
    if (reviewers != null && (typeof reviewers !== 'string' || !/^[A-Za-z0-9_.*-]{1,64}$/.test(reviewers.trim()))) throw new ApiError(400, 'reviewers is an agent name pattern such as codex-* (letters, digits, - _ . and *)');
    reviewers = reviewers?.trim() || null;
    const body = JSON.stringify({ rules, reviewers });
    const hash = await sha256(body);
    const cur = this.houseRules();
    if (cur.hash === hash) return { ...cur, unchanged: true };
    const version = cur.version + 1;
    this.sql.exec('INSERT INTO rules (version, body, hash, by, at) VALUES (?, ?, ?, ?, ?)', version, body, hash, by, this.now());
    this.event('rules.updated', { agent: by, data: { version, hash, rules: rules.length, reviewers } });
    return this.houseRules();
  }
  rulesDoc(hr) {
    return `# House rules (version ${hr.version})\n\nSet by a person in Cinq. Every review is held to these; each finding cites the rule it breaks.\n\n${hr.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n${hr.reviewers ? `\nReviews are done only by agents matching \`${hr.reviewers}\`.\n` : ''}\nsha256: ${hr.hash}\n`;
  }

  /** Open jobs whose allowed files intersect these, with who holds each now. */
  overlaps(allowed, exceptId) {
    const want = new Set(allowed);
    return this.q("SELECT id, goal, state, author, allowed FROM intents WHERE state NOT IN ('landed', 'satisfied', 'parked', 'rejected') AND id != ?", exceptId || '')
      .map((r) => ({ ...r, files: J(r.allowed).filter((f) => want.has(f)) })).filter((r) => r.files.length)
      .map((r) => ({ job: r.id, goal: r.goal, state: r.state, files: r.files, agent: this.holder(r.id) || r.author }));
  }
  holder(intentId) { return this.one(`SELECT agent FROM claims WHERE intent = ? AND state IN ('active', 'waiting', 'queued', 'reviewing') AND kind IN ${BUILDERS} ORDER BY created DESC LIMIT 1`, intentId)?.agent || null; }

  /** Take the next job on the board (dependent > rederive), or a specific one. */
  async claim(agent, { intentId, kind } = {}) {
    this.sweep(); // expired claims go back on the board before we hand out work
    // Board priority: dependent fix > re-derivation > review > examination.
    // separation of duties: neither the author nor anyone who built or rebuilt it may examine it
    const builtBy = (id) => !!this.one("SELECT 1 AS x FROM claims WHERE intent = ? AND agent = ? AND kind != 'examine' LIMIT 1", id, agent);
    const exam = () => this.one("SELECT id FROM intents WHERE exam_state = 'needed' AND author != ? AND state NOT IN ('landed', 'parked') AND id NOT IN (SELECT intent FROM claims WHERE agent = ? AND kind != 'examine') ORDER BY created LIMIT 1", agent, agent);
    // a reviewer is never the author, a builder (author, rebuilder, dependent fixer) or the examiner of the job
    const reviewable = () => this.q("SELECT id, author, examiner, review FROM intents WHERE state = 'awaiting-review' ORDER BY updated")
      .find((r) => J(r.review)?.state === 'needed' && this.canReview(r.id, agent)) || null;
    let job; let examining = kind === 'examine'; let reviewing = kind === 'review';
    if (intentId) { job = this.intent(intentId); if (job && !kind) reviewing = job.state === 'awaiting-review'; }
    else if (examining) job = exam();
    else if (reviewing) job = reviewable();
    else {
      job = this.one("SELECT id FROM intents WHERE state = 'dependent' ORDER BY updated LIMIT 1")
        || this.q("SELECT id FROM intents WHERE state = 'rederive' AND author != ? AND (examiner IS NULL OR examiner != ?) ORDER BY updated", agent, agent).find((r) => !this.rebuildConflict(r.id, agent)) || null;
      if (!job) { job = reviewable(); reviewing = !!job; }
      // a build ticket from someone's ask: never to the agent that wrote its tests, or one that examined it
      if (!job) job = this.q("SELECT id FROM intents WHERE state = 'open' AND author != ? AND (examiner IS NULL OR examiner != ?) ORDER BY created", agent, agent).find((r) => !this.rebuildConflict(r.id, agent)) || null;
      if (!job) { job = exam(); examining = !!job; }
    }
    if (!job) return { claim: null, note: 'no jobs on the board' };
    const it = this.intent(job.id);
    if (reviewing) {
      if (it.state !== 'awaiting-review' || it.review?.state !== 'needed') throw new ApiError(409, `intent ${it.id} does not need a reviewer`);
      const why = this.reviewConflict(it.id, agent);
      if (why) throw new ApiError(409, `separation of duties: ${why}`);
      return { claim: await this.openReview(it.id, agent) };
    }
    if (examining) {
      if (it.exam_state !== 'needed') throw new ApiError(409, `intent ${it.id} does not need an examiner`);
      if (it.author === agent) throw new ApiError(409, 'separation of duties: an author cannot examine its own intent');
      if (builtBy(it.id)) throw new ApiError(409, 'separation of duties: an agent that built this change cannot examine it');
      return { claim: await this.openExam(it.id, agent) };
    }
    if (!['rederive', 'dependent', 'open'].includes(it.state)) throw new ApiError(409, `intent ${it.id} is ${it.state}, not claimable`);
    if (it.state === 'open' && it.author === agent) throw new ApiError(409, 'separation of duties: the agent that wrote a ticket\'s tests does not build it');
    if (it.state === 'open' && it.examiner === agent) throw new ApiError(409, 'separation of duties: the examiner of a job cannot build it (it has seen the hidden tests)');
    if (it.state === 'open' && this.rebuildConflict(it.id, agent)) throw new ApiError(409, `separation of duties: ${this.rebuildConflict(it.id, agent)}`);
    if (it.state === 'rederive' && it.author === agent) throw new ApiError(409, 'separation of duties: a re-derivation must be done by a different agent than the author');
    if (it.state === 'rederive' && it.examiner === agent) throw new ApiError(409, 'separation of duties: the examiner of a job cannot rebuild it (it has seen the hidden tests)');
    if (it.state === 'rederive' && this.rebuildConflict(it.id, agent)) throw new ApiError(409, `separation of duties: ${this.rebuildConflict(it.id, agent)}`);
    return { claim: await this.openClaim(it.id, agent, it.state === 'dependent' ? 'dependent' : it.state === 'open' ? 'build' : 'rederive') };
  }

  async openClaim(intentId, agent, kind) {
    const it = this.intent(intentId);
    const claimId = rid('c');
    // Reserve the job BEFORE awaiting the fork: other requests run on this object during the await, and a second
    // claim must already see the job as taken (else two agents rebuild it and it can land twice).
    const gen = (this.one('SELECT max(generation) AS g FROM claims WHERE intent = ?', intentId)?.g || 0) + 1;
    this.sql.exec('INSERT INTO claims (id, intent, agent, kind, generation, lease_until, fork_name, fork_url, state, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      claimId, intentId, agent, kind, gen, this.now() + this.leaseMs, null, null, 'active', this.now());
    this.setIntent(intentId, { state: { author: 'working', dependent: 'dependent-working', build: 'building' }[kind] || 'rederiving' });
    // A dependent works on the staging fork (trunk + the contract change); everyone else gets a fresh fork of trunk.
    // The staging fork is owned by the contract change and removed when the pair lands, so it isn't recorded here.
    let fork;
    try { fork = kind === 'dependent' ? { name: null, url: J(it.staged_for).forkUrl } : await this.artifacts.fork(`${intentId}-${claimId}`); }
    catch (e) { this.sql.exec('DELETE FROM claims WHERE id = ?', claimId); this.setIntent(intentId, { state: it.state }); throw e; }
    this.sql.exec('UPDATE claims SET fork_name = ?, fork_url = ? WHERE id = ?', fork.name, fork.url, claimId);
    this.event('claim.started', { intent: intentId, claim: claimId, agent, data: { kind, fork: fork.name, generation: gen } });
    return this.workOrder(claimId);
  }

  /** Why this agent may not review this job (null if it may). */
  reviewConflict(intentId, agent) {
    // a dependent lands together with the contract change that broke it: the reviewer reads both, so it may have
    // built or examined neither
    const hr = this.houseRules();
    if (hr.reviewers && !nameMatch(hr.reviewers, agent)) return `the house rules say only agents matching ${hr.reviewers} review`;
    const it = this.intent(intentId); const staged = J(it.staged_for);
    for (const x of [it, staged?.forIntent && this.intent(staged.forIntent)].filter(Boolean)) {
      if (x.author === agent) return 'an author cannot review its own change';
      if (x.examiner === agent) return 'the examiner of a job cannot review it';
      if (this.one(`SELECT 1 AS x FROM claims WHERE intent = ? AND agent = ? AND kind IN ${BUILDERS} LIMIT 1`, x.id, agent)) return 'an agent that built this change cannot review it';
    }
    return null;
  }
  canReview(intentId, agent) { return !this.reviewConflict(intentId, agent); }
  /** A rebuild goes to a fresh pair of eyes: never an agent that already built this job or blocked it in review.
   *  A build that lapsed without handing anything in (its session died) built nothing, so it doesn't count. */
  rebuildConflict(intentId, agent) {
    if (this.one(`SELECT 1 AS x FROM claims WHERE intent = ? AND agent = ? AND kind IN ${BUILDERS} AND state != 'expired' LIMIT 1`, intentId, agent)) return 'an agent that already built this job cannot rebuild it';
    if (this.one("SELECT 1 AS x FROM claims WHERE intent = ? AND agent = ? AND kind = 'review' AND result LIKE '%\"verdict\":\"block\"%' LIMIT 1", intentId, agent)) return 'the reviewer that blocked this job cannot rebuild it';
    return null;
  }

  /** Reviewer claim: the goal, the diff the lander gated, and every gate result. No fork, nothing to push. */
  async openReview(intentId, agent) {
    const claimId = rid('r');
    this.sql.exec('INSERT INTO claims (id, intent, agent, kind, generation, lease_until, fork_name, fork_url, state, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      claimId, intentId, agent, 'review', 1, this.now() + this.leaseMs, null, null, 'active', this.now());
    const it = this.intent(intentId);
    const hr = this.houseRules(); // the review is held to the rules in force when it starts, and says which
    this.setIntent(intentId, { review: { ...it.review, state: 'claimed', by: agent, reviewClaim: claimId, rules: hr.version ? { version: hr.version, hash: hr.hash, count: hr.rules.length } : null } });
    this.event('claim.started', { intent: intentId, claim: claimId, agent, data: { kind: 'review' } });
    const order = this.workOrder(claimId);
    // the standards to hold it to, from the repo itself, and the code that depends on it: read once, so the reviewer
    // judges architecture fit from its work order instead of exploring the repo
    if (this.lander.context) { try { const ctx = await this.lander.context(this.intent(intentId).allowed); if (ctx && !ctx.error) Object.assign(order, { guidelines: ctx.guidelines || {}, neighbours: ctx.neighbours || {} }); } catch {} }
    return order;
  }

  /** The reviewer hands in {verdict, findings}. Validated here; MCP validates the same shape with zod. */
  async submitReview(agent, claimId, input = {}) {
    const c = this.mine(agent, claimId);
    if (c.kind !== 'review' || c.state !== 'active') throw new ApiError(409, 'not an active review claim');
    const hr0 = this.houseRules(); // the house rules may have narrowed who reviews since this review started
    if (hr0.reviewers && !nameMatch(hr0.reviewers, agent)) { this.closeClaim(c, 'released', 'the house rules no longer let this agent review'); throw new ApiError(409, `the house rules now say only agents matching ${hr0.reviewers} review; the review went back on the board`); }
    const it = this.intent(c.intent);
    const { verdict, findings = [], summary } = validateReview(input, it.review?.rules?.count || 0);
    const mode = it.review?.mode || 'block';
    const review = { ...it.review, state: verdict, verdict, findings, summary, by: agent, at: this.now() };
    if (it.review?.rules?.version) this.event('review.rules', { intent: it.id, agent, data: { version: it.review.rules.version, cited: [...new Set(findings.map((f) => f.rule).filter((n) => n > 0))] } });
    this.sql.exec("UPDATE claims SET state = 'done', result = ? WHERE id = ?", JSON.stringify({ verdict, findings: findings.length }), claimId);
    this.setIntent(it.id, { review });
    this.event(verdict === 'pass' ? 'review.passed' : 'review.blocked', { intent: it.id, claim: claimId, agent, data: { verdict, mode, findings } });
    const waiting = this.claimRow(it.review.claim);
    if (verdict === 'pass' || mode === 'advisory') { // on to landing, pinned to the commit that was reviewed
      // ahead of the queue: behind a long one, main would move on, the reviewed commit would go stale, and under
      // load jobs would cycle through rebuild and review without ever landing
      this.sql.exec("UPDATE claims SET state = 'queued' WHERE id = ?", waiting.id); this.sql.exec('INSERT INTO queue (claim, priority) VALUES (?, 1)', waiting.id);
      this.setIntent(it.id, { state: 'queued' });
      return { accepted: true, verdict, next: 'landing', queuedForLanding: true };
    }
    // block: the job goes back to be rebuilt with the findings as context (like a denied test change)
    this.sql.exec("UPDATE claims SET state = 'done' WHERE id = ?", waiting.id);
    const blocks = (it.review_blocks || 0) + 1;
    this.setIntent(it.id, { review_blocks: blocks, last_diff: it.review.diff || it.last_diff });
    await this.cleanupForks(waiting);
    const failure = { verdict: 'review-blocked', reviewer: agent, findings };
    if (blocks >= MAX_REVIEW_BLOCKS) {
      this.setIntent(it.id, { state: 'parked', last_failure: failure });
      this.event('intent.parked', { intent: it.id, agent, data: { reason: `blocked by review ${blocks} times`, gate: 'review', failure } });
      return { accepted: true, verdict, next: 'parked' };
    }
    this.toRederive(this.intent(it.id), failure, agent);
    return { accepted: true, verdict, next: this.intent(it.id).state === 'parked' ? 'parked' : 'rebuild' };
  }

  /** Examiner claim: read-only view of trunk, the goal and allowed paths. Never the author's code or tests. */
  async openExam(intentId, agent) {
    const claimId = rid('x');
    this.sql.exec('INSERT INTO claims (id, intent, agent, kind, generation, lease_until, fork_name, fork_url, state, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      claimId, intentId, agent, 'examine', 1, this.now() + this.leaseMs, null, this.artifacts.trunkReadUrl ? this.artifacts.trunkReadUrl() : null, 'active', this.now());
    this.setIntent(intentId, { exam_state: 'claimed', examiner: agent });
    this.event('claim.started', { intent: intentId, claim: claimId, agent, data: { kind: 'examine' } });
    const order = this.workOrder(claimId);
    // what the goal touches, as it is on main today: most examiners need nothing more, so they don't clone and explore
    if (this.lander.files) { try { const r = await this.lander.files(this.intent(intentId).allowed); if (r?.files) Object.assign(order, { trunkFiles: r.files, repoFiles: r.list }); } catch {} }
    return order;
  }

  /** The examiner hands in hidden tests. They must fail on today's trunk (else they prove nothing). */
  async submitTests(agent, claimId, tests = {}, supersedeVerdicts = {}) {
    const c = this.mine(agent, claimId);
    if (c.kind !== 'examine' || c.state !== 'active') throw new ApiError(409, 'not an active examiner claim');
    const it = this.intent(c.intent);
    const paths = Object.keys(tests);
    if (!paths.length) throw new ApiError(400, 'no tests');
    checkPaths(paths, 'hidden tests');
    overBudget(tests); noCases(tests);
    for (const p of paths) {
      if (!/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) throw new ApiError(400, `not a test path: ${p}`);
      if (it.tests?.[p]) throw new ApiError(409, `path collides with the author's test: ${p}`);
    }
    const sup = J(it.supersedes) || {};
    const missingVerdicts = Object.keys(sup).filter((p) => !['approve', 'deny'].includes(supersedeVerdicts?.[p]?.verdict));
    if (missingVerdicts.length) throw new ApiError(400, `review every proposed change to an existing test: give {verdict: "approve"|"deny", reason} for ${missingVerdicts.join(', ')}`);
    const v = await this.check({ trunk: this.artifacts.trunkReadUrl(), tests });
    // the check can take minutes: a lease that lapsed meanwhile may have gone to another examiner
    const now = this.one('SELECT state FROM claims WHERE id = ?', claimId);
    if (now?.state !== 'active' || this.intent(it.id).exam_state === 'done') throw new ApiError(409, 'your examination lapsed while the tests ran: another examiner has it now');
    if (!v.testsRun) { // a file the repo's runner never executes would gate nothing
      this.event('examine.rejected', { intent: it.id, claim: claimId, agent, data: { reason: 'did-not-run', tests: paths.length, validity: v } });
      throw new ApiError(422, "these tests did not run: the repo's test runner executed 0 test cases from them. Put them where the runner picks them up (see its config) and use its test API.", { validity: v });
    }
    if (it.kind === 'keep' && v.failsOnTrunk) { // a refactor's hidden tests pin today's behaviour
      this.event('examine.rejected', { intent: it.id, claim: claimId, agent, data: { reason: 'fails-today', tests: paths.length, validity: v } });
      throw new ApiError(422, "this job is a refactor that must not change behaviour, so its hidden tests must pass on today's trunk; these fail. Pin what works today.", { validity: v });
    }
    if (it.kind !== 'keep' && !v.failsOnTrunk) {
      this.event('examine.rejected', { intent: it.id, claim: claimId, agent, data: { reason: 'vacuous', tests: paths.length, validity: v } });
      throw new ApiError(422, 'these tests already pass on current trunk, so they cannot tell a correct change from no change. Test what the goal adds.', { validity: v });
    }
    this.setIntent(it.id, { hidden: tests, exam_state: 'done' });
    this.sql.exec("UPDATE claims SET state = 'done' WHERE id = ?", claimId);
    this.event('examine.done', { intent: it.id, claim: claimId, agent, data: { tests: paths.length, validity: v } });
    if (Object.keys(sup).length) {
      const review = J(it.supersede_review) || { files: {} };
      for (const p of Object.keys(sup)) review.files[p] = { ...(review.files[p] || {}), verdict: supersedeVerdicts[p].verdict, reason: supersedeVerdicts[p].reason || '', by: agent };
      const denied = Object.keys(sup).filter((p) => supersedeVerdicts[p].verdict === 'deny');
      review.state = denied.length ? 'denied' : 'approved'; review.by = agent;
      this.setIntent(it.id, { supersede_review: review });
      const reasons = Object.fromEntries(denied.map((p) => [p, supersedeVerdicts[p].reason]));
      this.event(denied.length ? 'tests.change-denied' : 'tests.change-approved', { intent: it.id, agent, data: { files: Object.keys(sup), denied, reasons } });
      if (denied.length) { // those test edits can't land; the job is rebuilt under the reviewer's reasons
        const w = this.one("SELECT id FROM claims WHERE intent = ? AND state = 'waiting'", it.id);
        if (w) this.sql.exec("UPDATE claims SET state = 'done' WHERE id = ?", w.id);
        this.toRederive(this.intent(it.id), { verdict: 'test-change-denied', denied, reasons }, agent);
        return { accepted: true, hiddenTests: paths.length, testChanges: 'denied', denied };
      }
    }
    // If the author already handed in, the work can go to landing now.
    const waiting = this.one("SELECT id FROM claims WHERE intent = ? AND state = 'waiting' ORDER BY created DESC LIMIT 1", it.id);
    if (waiting) { this.sql.exec("UPDATE claims SET state = 'queued' WHERE id = ?", waiting.id); this.sql.exec('INSERT INTO queue (claim) VALUES (?)', waiting.id); this.setIntent(it.id, { state: 'queued' }); }
    return { accepted: true, hiddenTests: paths.length, queuedForLanding: !!waiting };
  }

  /** Everything the agent needs to do the work; never includes hidden tests. */
  workOrder(claimId) {
    const c = this.claimRow(claimId); const it = this.intent(c.intent);
    if (c.kind === 'examine') return {
      claimId, generation: c.generation, kind: 'examine', leaseUntil: c.lease_until,
      intent: { id: it.id, goal: it.goal, allowed: it.allowed },
      trunk: { remote: c.fork_url, readOnly: true },
      reviewTestChanges: Object.keys(J(it.supersedes) || {}).length ? Object.entries(J(it.supersedes)).map(([path, after]) => ({ path, before: J(it.supersede_review)?.files?.[path]?.before ?? null, after })) : undefined,
      rules: ['You are the examiner: another agent is implementing this goal. You will not see its code or its tests.',
        'The work order carries the files this job may change as they are on main today (trunkFiles) and the repo\'s file list (repoFiles). Read those first; clone trunk (read-only) only if you need more. Write tests that check the GOAL from the outside, including edge cases the author may miss.',
        it.kind === 'keep' ? 'This job is a refactor that must not change behaviour: your tests must PASS on today\'s trunk and keep passing after it. Pin the behaviour callers rely on. Do not test internals.'
          : 'Your tests must FAIL on today\'s trunk and pass once the goal is correctly done. Do not test internals.',
        `Write the fewest tests that prove the goal: usually 1 to 3 cases, at most ${TEST_BUDGET}. They gate this landing and are not committed to main.`,
        'Hand them in with submit_tests as {path: content}. Use new file names under test/.',
        'If reviewTestChanges is present, the author wants to change EXISTING tests. For each file approve only if the goal genuinely requires that change; deny anything that weakens a test beyond what the goal requires. Pass supersedeVerdicts: {path: {verdict: "approve"|"deny", reason}}.'],
    };
    if (c.kind === 'review') return {
      claimId, generation: c.generation, kind: 'review', leaseUntil: c.lease_until,
      intent: { id: it.id, goal: it.goal, allowed: it.allowed },
      spec: { goal: it.goal, approach: it.plan || undefined, ask: it.ask ? this.one('SELECT text FROM asks WHERE id = ?', it.ask)?.text : undefined },
      diff: it.review?.diff || '', gates: it.review?.gates || {}, testsRun: it.review?.testsRun ?? null, security: it.review?.security || null,
      mode: it.review?.mode || 'block',
      houseRules: it.review?.rules?.version ? { version: it.review.rules.version, rules: this.rulesAt(it.review.rules.version).map((text, i) => ({ rule: i + 1, text })) } : undefined,
      returns: { verdict: '"pass" | "block"', summary: 'one or two sentences: what you checked and why', findings: [{ file: 'path', line: 'number (0 if not line-specific)', severity: SEVERITIES.join(' | '), axis: AXES.join(' | '), reason: 'one sentence', ...(it.review?.rules?.version ? { rule: 'the number of the house rule it breaks, or 0 if no rule covers it' } : {}) }] },
      rules: ['You are the reviewer: another agent wrote this change, and you did not write, rebuild or examine it.',
        'Review on three axes. SPEC: does the diff do what the goal (and the ask it came from) says, no less and no more? STANDARDS: does it meet the house rules and the repo\'s own guidelines (guidelines), and does it fit how the code around it is built (neighbours: the files that use the changed code): layers, where things live, naming, error handling, the existing abstractions? LEAN: does it add anything the goal does not need: tests that repeat another test or restate the implementation, dead or unused code, an abstraction with one caller, defensive checks for cases that cannot happen, comments that narrate the code, copied logic, leftover debug output? Block for slop you are sure of, and say what to delete; the fix is a deletion.',
        'Everything you need is in this work order; you do not need to explore the repo. Every gate result is included: tests already pass and the hard gates already hold, so look for what they cannot see.',
        'Block for real problems only: the diff does not do what the goal says, does something the goal did not ask for, special-cases tests, adds a security risk, or breaks callers no test covers.',
        'Do not block on style or taste. If you block, give at least one finding with file, line, severity and a reason the rebuilder can act on.',
        ...(it.review?.rules?.version ? ['A person set the house rules below: they are this team\'s bar. Hold the change to every one of them, and block when it breaks one. Each finding names the rule it breaks (rule: its number), or rule: 0 for a real problem no rule covers.'] : []),
        'Hand in with submit_review as {verdict, summary, findings}. The summary is recorded with the change.'],
    };
    const staged = J(it.staged_for);
    const askText = it.ask ? this.one('SELECT text FROM asks WHERE id = ?', it.ask)?.text : null;
    const context = c.kind === 'build' ? { ask: askText, note: 'This ticket is one part of a larger ask (above). Build only this ticket\'s goal; other agents build the other parts.' }
      : c.kind === 'rederive' ? { why: it.last_failure, previousAttempt: it.last_diff }
      : c.kind === 'dependent' ? { why: `approved contract change "${staged?.forIntent}" breaks this intent; adapt it to the new contract, keep its goal and tests`, failing: staged?.failing } : undefined;
    return {
      claimId, generation: c.generation, kind: c.kind, leaseUntil: c.lease_until,
      intent: { id: it.id, goal: it.goal, allowed: it.allowed, tests: it.tests },
      fork: { remote: c.fork_url, branch: 'main' },
      context,
      rules: [...(c.kind === 'rederive' && (it.last_failure?.findings || []).some((f) => f.axis === 'lean') ? ['The reviewer found code or tests this change does not need. Start from previousAttempt and delete what the findings name; do not add anything new to make up for it.'] : []),
        ...(c.kind === 'rederive' && it.last_diff && /conflict|trunk-moved/.test(it.last_failure?.verdict || '') ? ['This job clashed with newer work on main. Start from previousAttempt: apply it to the latest main and fix only what clashes, rather than rebuilding from nothing.'] : []),
        'Only edit the allowed paths.', 'Do not modify or delete existing tests, or anything under .cinq/.', 'Commit and push to your fork\'s main, then call submit.', 'Held-out tests you cannot see will also run.', `Keep tests lean: the fewest that prove the goal (usually 1 to 3 cases, at most ${TEST_BUDGET}).`],
    };
  }

  /** Any call from an agent proves it's alive: renew every lease it holds (agents rarely call while coding). */

  // A lease renews only on calls that name its claim (status, submit), never on any call from the same key: several
  // sessions can share a key, and one session's list_intents must not keep another, dead session's job alive.
  heartbeat(agent, claimId) {
    const c = this.mine(agent, claimId);
    if (c.state === 'active') this.sql.exec('UPDATE claims SET lease_until = ? WHERE id = ?', this.now() + this.leaseMs, claimId);
    return this.status(agent, claimId);
  }

  submit(agent, claimId, generation) {
    const c = this.mine(agent, claimId);
    if (c.state !== 'active') throw new ApiError(409, `claim is ${c.state}`);
    if (generation != null && generation !== c.generation) throw new ApiError(409, 'stale generation: this job was reassigned');
    if (c.kind === 'examine') throw new ApiError(400, 'examiners hand in with submit_tests');
    if (c.kind === 'review') throw new ApiError(400, 'reviewers hand in with submit_review');
    const it = this.intent(c.intent);
    if (this.examine && it.exam_state !== 'done') { // can't land until independently examined
      this.sql.exec("UPDATE claims SET state = 'waiting' WHERE id = ?", claimId);
      this.setIntent(c.intent, { state: 'awaiting-examiner' });
      this.event('submit.received', { intent: c.intent, claim: claimId, agent, data: { waitingForExaminer: true } });
      return { queued: false, waitingForExaminer: true, note: 'another agent must write hidden tests from the goal before this can land' };
    }
    this.sql.exec("UPDATE claims SET state = 'queued' WHERE id = ?", claimId);
    this.sql.exec('INSERT INTO queue (claim) VALUES (?)', claimId);
    this.setIntent(c.intent, { state: 'queued' });
    this.event('submit.received', { intent: c.intent, claim: claimId, agent });
    return { queued: true, position: this.one('SELECT count(*) AS n FROM queue').n };
  }

  release(agent, claimId, reason = 'released') {
    const c = this.mine(agent, claimId);
    if (c.state !== 'active') throw new ApiError(409, `claim is ${c.state}`);
    this.closeClaim(c, 'released', reason);
    return { released: true };
  }

  status(agent, claimId) {
    const c = this.claimRow(claimId); if (!c) throw new ApiError(404, 'no such claim');
    const it = this.intent(c.intent);
    return { claimId, claimState: c.state, intent: it.id, intentState: it.state, examState: it.exam_state, reviewState: it.review?.state, leaseUntil: c.lease_until, result: c.result,
      landedSha: it.landed_sha, landedVia: it.landed_via };
  }

  mine(agent, claimId) {
    const c = this.claimRow(claimId); if (!c) throw new ApiError(404, 'no such claim');
    if (c.agent !== agent) throw new ApiError(403, 'not your claim');
    return c;
  }

  closeClaim(c, state, reason) {
    this.sql.exec('UPDATE claims SET state = ? WHERE id = ?', state, c.id);
    if (c.kind === 'examine') { // the examination goes back on the board
      this.setIntent(c.intent, { exam_state: 'needed', examiner: null });
      this.event(`claim.${state}`, { intent: c.intent, claim: c.id, agent: c.agent, data: { reason, kind: 'examine' } });
      return;
    }
    if (c.kind === 'review') { // the review goes back on the board
      const rv = this.intent(c.intent).review;
      this.setIntent(c.intent, { review: { ...rv, state: 'needed', by: null, reviewClaim: null } });
      this.event(`claim.${state}`, { intent: c.intent, claim: c.id, agent: c.agent, data: { reason, kind: 'review' } });
      return;
    }
    const it = this.intent(c.intent);
    this.event(`claim.${state}`, { intent: c.intent, claim: c.id, agent: c.agent, data: { reason } }); // before what it causes (a rebuild, or a park)
    // The job goes back on the board for someone else.
    if (c.kind === 'dependent') this.setIntent(c.intent, { state: 'dependent' });
    else if (c.kind === 'build' && it.state === 'building') this.setIntent(c.intent, { state: 'open' }); // nobody built it yet: not a failed attempt
    else this.toRederive(it, { reason }, c.agent);
  }

  /** Lease expiry: claims whose agent went quiet go back on the board. */
  sweep() {
    for (const c of this.q("SELECT * FROM claims WHERE state = 'active' AND lease_until < ?", this.now())) this.closeClaim(this.claimRow(c.id), 'expired', 'lease expired');
  }

  toRederive(it, failure, agent) {
    // whoever still holds this job (an author that hasn't handed in yet) no longer does: one builder at a time
    this.sql.exec(`UPDATE claims SET state = 'done' WHERE intent = ? AND kind IN ${BUILDERS} AND state IN ('active', 'waiting')`, it.id);
    const attempts = (it.attempts || 0) + 1;
    if (attempts > MAX_REDERIVE) {
      this.setIntent(it.id, { state: 'parked', attempts, last_failure: failure });
      this.event('intent.parked', { intent: it.id, agent, data: { reason: 'too many failed attempts', failure } });
      return;
    }
    this.setIntent(it.id, { state: 'rederive', attempts, last_failure: failure });
    this.event('rederive.queued', { intent: it.id, agent, data: { attempt: attempts, failure } });
  }

  /** Lands queued claims in order, one at a time, at most `limit` of them; returns whether more are waiting.
   *  Safe to call repeatedly; only one loop runs. */
  async processQueue(limit = Infinity) {
    if (this.busy) return false;
    this.busy = true;
    try {
      // Recovery: a claim stuck 'queued' with no queue row means we restarted mid-landing; land it again.
      for (const c of this.q("SELECT id FROM claims WHERE state = 'queued' AND id NOT IN (SELECT claim FROM queue)")) {
        this.sql.exec('INSERT INTO queue (claim) VALUES (?)', c.id);
        this.event('land.recovered', { claim: c.id, data: { reason: 'coordinator restarted mid-landing' } });
      }
      for (let n = 0; n < limit; n++) {
        const next = this.one('SELECT seq, claim FROM queue ORDER BY priority DESC, seq LIMIT 1');
        if (!next) break;
        this.sql.exec('DELETE FROM queue WHERE seq = ?', next.seq);
        const c = this.claimRow(next.claim);
        // a landing that throws (not a verdict: a bug or an outage around the lander) parks for a person instead of
        // being recovered and re-landed forever
        try { await this.landOne(c); } catch (e) {
          const failure = { verdict: 'error', stage: 'exception', detail: String(e?.message || e).slice(0, 300) };
          this.sql.exec("UPDATE claims SET state = 'done' WHERE id = ?", c.id);
          this.setIntent(c.intent, { state: 'parked', last_failure: failure });
          this.event('intent.parked', { intent: c.intent, claim: c.id, agent: c.agent, data: { reason: 'landing failed with an error; retry it once the cause is fixed', failure } });
        }
      }
    } finally { this.busy = false; }
    return !!this.one('SELECT 1 AS x FROM queue LIMIT 1');
  }

  async landOne(c) {
    const it = this.intent(c.intent);
    // Only the job's current queued claim may land: never a stale claim of a job that already landed or moved on.
    if (c.state !== 'queued' || ['landed', 'satisfied', 'parked', 'rederive', 'rederiving', 'open'].includes(it.state)) {
      this.sql.exec("UPDATE claims SET state = 'done' WHERE id = ?", c.id);
      this.event('land.skipped', { intent: it.id, claim: c.id, agent: c.agent, data: { reason: `stale claim: the job is ${it.state}` } });
      return;
    }
    const staged = J(it.staged_for);
    // A dependent lands TOGETHER with the contract change that broke it, as one combined candidate.
    const owners = c.kind === 'dependent' ? [this.intent(staged.forIntent), it] : [it];
    const combined = {
      id: owners[0].id,
      allowed: [...new Set(owners.flatMap((o) => o.allowed))],
      ownTests: owners.flatMap((o) => Object.keys(o.tests || {})),
      tests: Object.assign({}, ...owners.map((o) => ({ ...(o.tests || {}), ...(J(o.supersede_review)?.state === 'approved' ? J(o.supersedes) || {} : {}) }))), // registered tests + APPROVED changes to existing tests, written by the lander itself
      hidden: Object.assign({}, ...owners.map((o) => o.hidden || {})),
      deps: [...new Set(owners.flatMap((o) => o.deps || []))],
      approvedSupersedes: owners.flatMap((o) => (J(o.supersede_review)?.state === 'approved' ? Object.keys(J(o.supersedes) || {}) : [])),
    };
    this.setIntent(it.id, { state: 'landing' });
    this.event('land.started', { intent: it.id, claim: c.id, agent: c.agent, data: { kind: c.kind, together: owners.map((o) => o.id) } });
    const changedTests = owners.flatMap((o) => (J(o.supersede_review)?.state === 'approved' ? Object.keys(J(o.supersedes) || {}).map((p) => ({ path: p, approvedBy: J(o.supersede_review).by, reason: J(o.supersede_review).files[p]?.reason })) : []));
    const receipt = { changedExistingTests: changedTests, intent: owners[0].id, together: owners.slice(1).map((o) => o.id), agent: c.agent, kind: c.kind, claim: c.id,
      goal: owners[0].goal, attempts: owners[0].attempts || 0, examined: Object.keys(combined.hidden).length > 0 };
    // A review handed in for THIS claim travels with the landing, pinned to the commit the reviewer read.
    const rv = it.review && it.review.claim === c.id && ['pass', 'block'].includes(it.review.state) ? it.review : null;
    if (rv) receipt.review = { by: rv.by, verdict: rv.verdict, mode: rv.mode, summary: rv.summary, findings: rv.findings, commit: rv.sha, ...(rv.rules ? { houseRules: { version: rv.rules.version, hash: rv.rules.hash } } : {}) };
    if (owners[0].ask) { const a = this.one('SELECT id, agent FROM asks WHERE id = ?', owners[0].ask); if (a) receipt.ask = { id: a.id, by: a.agent }; }
    // .cinq/rules.md is the version this landing's review was held to (the latest, when nothing reviewed it)
    const cur = this.houseRules();
    const hr = rv?.rules?.version && rv.rules.version !== cur.version ? { version: rv.rules.version, hash: rv.rules.hash, rules: this.rulesAt(rv.rules.version), reviewers: J(this.one('SELECT body FROM rules WHERE version = ?', rv.rules.version)?.body)?.reviewers || null } : cur;
    if (owners[0].plan) receipt.plan = owners[0].plan;
    if (J(it.approvals)?.length) receipt.approvedByPerson = J(it.approvals);
    const intentDoc = `# ${owners[0].id}\n\n${owners[0].goal}\n\n${owners[0].plan ? `Approach: ${owners[0].plan}\n\n` : ''}Allowed: ${owners[0].allowed.join(', ')}\n${rv?.summary ? `\nReview (${rv.verdict}, ${rv.by}): ${rv.summary}\n` : ''}`;
    // an approved commit may wait a long time for its review: fetch it with a fresh token, not the one from when it parked
    let candidate = c.fork_url;
    if (J(it.approvals)?.length && this.artifacts.refresh && c.fork_name) { try { candidate = await this.artifacts.refresh(c.fork_name); this.sql.exec('UPDATE claims SET fork_url = ? WHERE id = ?', candidate, c.id); } catch {} }
    const r = await this.lander.land({ trunk: this.artifacts.trunkUrl(), candidate, intent: combined,
      testOwners: this.testOwners(owners.map((o) => o.id)), receipt, intentDoc, rulesDoc: hr.version ? this.rulesDoc(hr) : undefined, message: `land ${owners.map((o) => o.id).join(' + ')} (${c.kind})`,
      requireReview: this.review, review: rv ? { verdict: rv.verdict, by: rv.by } : undefined, expectSha: rv?.sha,
      allowParks: (J(it.approvals) || []).map(({ gate, sha, digest }) => ({ gate, sha, digest })),
      reuse: rv?.tree ? { tree: rv.tree, testsRun: rv.testsRun, runner: rv.runner, flaky: rv.flaky, install: rv.install } : undefined });
    if (r.verdict === 'needs-review') { // every gate passed; now an agent that didn't write it reads the diff
      this.sql.exec("UPDATE claims SET state = 'reviewing' WHERE id = ?", c.id);
      this.setIntent(it.id, { state: 'awaiting-review', review: { state: 'needed', mode: r.reviewMode, claim: c.id, sha: r.candidateSha, diff: r.diff, gates: r.gates, testsRun: r.testsRun, security: r.security,
        tree: r.tree, runner: r.runner, flaky: r.flaky?.map((f) => (f in (combined.hidden || {}) ? '(hidden test)' : f)), install: r.install } });
      this.event('review.queued', { intent: it.id, claim: c.id, agent: c.agent, data: { mode: r.reviewMode, testsRun: r.testsRun } });
      return;
    }
    const sealed = (f) => (Object.keys(combined.hidden || {}).includes(f) ? '(hidden test)' : f);
    const summary = { verdict: r.verdict, gates: r.gates, testsRun: r.testsRun, failing: r.failing?.map(sealed), flaky: r.flaky?.map(sealed), after: r.after, dependents: r.dependents, security: r.security, review: receipt.review };
    this.sql.exec('UPDATE claims SET state = ?, result = ? WHERE id = ?', r.verdict === 'landed' ? 'landed' : 'done', JSON.stringify(summary), c.id);

    if (r.verdict === 'landed') {
      const via = c.kind === 'author' ? 'as-written' : c.kind === 'build' ? 'built' : c.kind === 'rederive' ? `re-derived#${it.attempts}` : `with-dependent:${it.id}`;
      for (const o of owners) this.setIntent(o.id, { state: 'landed', landed_sha: r.after, landed_via: o.id === it.id ? via : `contract-change(${staged?.forIntent})`, receipt: summary, staged_for: null });
      this.event('land.landed', { intent: it.id, claim: c.id, agent: c.agent, data: { sha: r.after, via, together: owners.map((o) => o.id), testsRun: r.testsRun, flaky: r.flaky?.map(sealed) } });
      this.event('trunk.head', { data: { sha: r.after, testsRun: r.testsRun, green: true } });
      await this.cleanupForks(c);
      if (staged?.forkName) { try { await this.artifacts.remove(staged.forkName); } catch {} }
      return;
    }
    if (r.verdict === 'breaks-dependents' && c.kind !== 'dependent' && r.dependents.length > 1) {
      // Each dependent would land paired with this change alone, so none could ever pass the others' tests.
      // A contract change that breaks several landed jobs is an exception for a person.
      const failure = { verdict: r.verdict, dependents: r.dependents, failing: r.failing, failures: r.failures };
      this.setIntent(it.id, { state: 'parked', last_failure: failure, last_diff: r.diff || it.last_diff });
      this.event('gate.failed', { intent: it.id, claim: c.id, agent: c.agent, data: failure });
      this.event('intent.parked', { intent: it.id, agent: c.agent, data: { reason: `this change breaks ${r.dependents.length} landed jobs (${r.dependents.join(', ')}); a person decides`, gate: 'dependents' } });
      return;
    }
    if (r.verdict === 'breaks-dependents' && c.kind !== 'dependent') {
      // Stage this change on a throwaway fork; post a dependent job for the broken landed intent.
      const stage = await this.artifacts.fork(`${it.id}-stage-${c.id}`);
      const s = await this.lander.stage({ trunk: this.artifacts.trunkReadUrl(), candidate: c.fork_url, target: stage.url });
      if (!s.staged) { this.toRederive(it, { verdict: 'stage-failed', detail: s.detail }, c.agent); return; }
      this.setIntent(it.id, { state: 'waiting-on-dependents' });
      for (const dep of r.dependents) {
        this.setIntent(dep, { state: 'dependent', staged_for: { forIntent: it.id, forkName: stage.name, forkUrl: stage.url, failing: r.failing } });
        this.event('dependent.detected', { intent: dep, data: { brokenBy: it.id, failing: r.failing } });
      }
      this.event('gate.failed', { intent: it.id, claim: c.id, agent: c.agent, data: { verdict: r.verdict, dependents: r.dependents, failing: r.failing, failures: r.failures } });
      return;
    }
    // A security gate wants a person (protected path, diff budget, a new package with install scripts). Rebuilding
    // would hit the same gate, so the job parks; its fork is kept for whoever looks at it.
    if (r.verdict === 'parked') {
      const failure = { verdict: 'parked', park: r.park, gates: r.gates, security: r.security, candidateSha: r.candidateSha, claim: c.id };
      this.setIntent(it.id, { state: 'parked', last_failure: failure, last_diff: r.diff || it.last_diff });
      this.event('gate.failed', { intent: it.id, claim: c.id, agent: c.agent, data: failure });
      this.event('intent.parked', { intent: it.id, agent: c.agent, data: { reason: r.park?.reason, gate: r.park?.gate } });
      return;
    }
    // Nothing to change: if the job's own tests (and hidden tests) already pass on trunk, the goal was met by
    // other work. That is "satisfied", not a failure to retry.
    // (never for a refactor: its tests pass on main by design, so an empty hand-in is just empty)
    if (r.verdict === 'noop' && c.kind !== 'dependent' && it.kind !== 'keep' && Object.keys({ ...it.tests, ...it.hidden }).length) {
      const v = await this.lander.check({ trunk: this.artifacts.trunkReadUrl(), tests: { ...it.tests, ...it.hidden } });
      if (v.testsRun > 0 && !v.failsOnTrunk) {
        this.setIntent(it.id, { state: 'satisfied', landed_via: 'already-on-trunk' });
        this.event('intent.satisfied', { intent: it.id, claim: c.id, agent: c.agent, data: { reason: "the job's tests already pass on trunk", trunk: v.head } });
        await this.cleanupForks(c);
        return;
      }
    }
    // conflict, red, rejected, noop, trunk-moved, error → a fresh agent re-derives it from the intent
    const failure = { verdict: r.verdict, reason: r.reason, gates: r.gates, failing: r.failing, failures: r.failures, detail: r.detail, security: r.security, testTail: r.testTail?.slice(-600) };
    // A hidden test's assertions and output never reach the rebuilder, the event log or get_intent: only that one failed.
    const hiddenPaths = Object.keys(combined.hidden || {});
    // The raw output tail names every test that ran, hidden ones included, so it never travels when hidden tests exist.
    // a failure entry travels only when it names a file and that file isn't hidden (node's runner names none)
    if (hiddenPaths.length) Object.assign(failure, { testTail: undefined, failures: r.failures?.filter((x) => x.file && !hiddenPaths.includes(x.file)), flaky: r.flaky?.map(sealed) });
    if (hiddenPaths.length && r.verdict === 'red' && (!r.failing?.length || r.failing.some((f) => hiddenPaths.includes(f)))) {
      Object.assign(failure, { failures: undefined, testTail: undefined, failing: (r.failing || []).map((f) => (hiddenPaths.includes(f) ? '(hidden test)' : f)),
        hidden: 'a hidden test failed; its details are sealed. Re-read the goal: the hidden tests check what it says.' });
    }
    // Not the change's fault (trunk moved under the push, a fetch or install failed, a push error): land it again,
    // without spending one of the job's attempts. Bounded, so an outage parks nothing but doesn't spin forever either.
    const infra = r.verdict === 'trunk-moved' || (r.verdict === 'error' && r.stage !== 'merge');
    const retries = c.result?.retries || 0; // c was read before this landing overwrote its result
    if (infra && retries < MAX_INFRA_RETRIES) {
      this.sql.exec("UPDATE claims SET state = 'queued', result = ? WHERE id = ?", JSON.stringify({ ...summary, retries: retries + 1 }), c.id);
      this.sql.exec('INSERT INTO queue (claim) VALUES (?)', c.id);
      this.setIntent(it.id, { state: 'queued' });
      this.event('land.retry', { intent: it.id, claim: c.id, agent: c.agent, data: { verdict: r.verdict, stage: r.stage, detail: r.detail, retry: retries + 1 } });
      return;
    }
    this.event('gate.failed', { intent: it.id, claim: c.id, agent: c.agent, data: failure });
    if (c.kind === 'dependent') {
      const attempts = (it.attempts || 0) + 1;
      if (attempts > MAX_REDERIVE) {
        this.setIntent(it.id, { state: 'parked', attempts, last_failure: failure });
        this.event('intent.parked', { intent: it.id, agent: c.agent, data: { reason: 'the fix for a contract change failed too many times', failure } });
        if (staged?.forIntent) { this.setIntent(staged.forIntent, { state: 'parked' }); this.event('intent.parked', { intent: staged.forIntent, agent: c.agent, data: { reason: `its dependent ${it.id} could not be fixed`, gate: 'dependents' } }); }
        return;
      }
      this.setIntent(it.id, { state: 'dependent', attempts, last_failure: failure }); return;
    }
    this.setIntent(it.id, { last_diff: r.diff || it.last_diff });
    this.toRederive(this.intent(it.id), failure, c.agent);
    await this.cleanupForks(c);
  }

  async cleanupForks(c) { if (c.fork_name) { try { await this.artifacts.remove(c.fork_name); } catch {} } }

  /** A person's decision on a parked job. approve: land it past the one security gate it hit, pinned to the exact
   *  commit that hit it, still reviewed by an agent; retry: a fresh agent rebuilds it with the note; drop: close it. */
  async decide(intentId, action, by, note = '') {
    const it = this.intent(intentId); if (!it) throw new ApiError(404, 'no such job');
    // a ticket nobody has started building can be dropped (a plan that went wrong); anything else must be parked
    if (!(it.state === 'parked' || (it.state === 'open' && action === 'drop'))) throw new ApiError(409, `job ${intentId} is ${it.state}, not parked`);
    note = String(note || '').slice(0, 1000);
    const f = it.last_failure || {};
    if (action === 'approve') {
      const gate = f.park?.gate;
      if (f.verdict !== 'parked' || !APPROVABLE.includes(gate) || !f.candidateSha) throw new ApiError(409, `only a job parked by a security gate (${APPROVABLE.join(', ')}) can be approved; use retry or drop`);
      const c = this.claimRow(f.claim); if (!c?.fork_url) throw new ApiError(409, 'the parked attempt is no longer available; use retry');
      if (this.artifacts.refresh && c.fork_name) { try { this.sql.exec('UPDATE claims SET fork_url = ? WHERE id = ?', await this.artifacts.refresh(c.fork_name), c.id); } catch { throw new ApiError(409, 'the parked attempt is no longer available; use retry'); } }
      const approvals = [...(J(it.approvals) || []), { gate, sha: f.candidateSha, ...(f.park?.digest ? { digest: f.park.digest } : {}), by, note, at: this.now() }];
      this.sql.exec("UPDATE claims SET state = 'queued' WHERE id = ?", c.id); this.sql.exec('INSERT INTO queue (claim) VALUES (?)', c.id);
      this.setIntent(it.id, { state: 'queued', approvals });
      this.event('intent.approved', { intent: it.id, claim: c.id, agent: by, data: { gate, commit: f.candidateSha, note } });
      return { decided: 'approve', gate, next: 'queued: it lands after an agent reviews it' };
    }
    if (action === 'retry') {
      this.setIntent(it.id, { state: 'rederive', attempts: 0, review_blocks: 0, last_failure: { verdict: 'sent-back', by, note, previous: f } });
      this.event('rederive.queued', { intent: it.id, agent: by, data: { attempt: 0, failure: { verdict: 'sent-back', note } } });
      return { decided: 'retry', next: 'a fresh agent rebuilds it from the goal' };
    }
    if (action === 'drop') {
      this.sql.exec("UPDATE claims SET state = 'done' WHERE intent = ? AND state NOT IN ('done', 'landed')", it.id);
      for (const c of this.q('SELECT * FROM claims WHERE intent = ? AND fork_name IS NOT NULL', it.id)) await this.cleanupForks(c); // nothing will land from them
      this.setIntent(it.id, { state: 'rejected' });
      this.event('intent.dropped', { intent: it.id, agent: by, data: { note } });
      return { decided: 'drop' };
    }
    throw new ApiError(400, 'action must be approve, retry or drop');
  }
  /** The tests-fail-today check. A lander that failed to answer (restarting, disconnected, install failed) says
   *  nothing about the tests: that is a retryable 503, never a verdict on the job. */
  async check(args) {
    const v = await this.lander.check({ ...args, fresh: true });
    if (v?.exists?.length) throw new ApiError(409, `these test files already exist on main: ${v.exists.join(', ')}. A new test needs a new file; to change an existing test, put it in "supersedes" (an independent agent approves the change).`, { exists: v.exists });
    if (v?.secrets?.length) throw new ApiError(422, `these tests contain what looks like a secret: ${v.secrets.map((f) => `${f.file}:${f.line} (${f.rule})`).join(', ')}. Use an obviously fake value, or build it at runtime.`, { secrets: v.secrets });
    if (!v || v.verdict === 'error' || (v.error && v.failsOnTrunk === false && !v.testsRun)) throw new ApiError(503, `the checker could not run these tests right now (${v?.detail || v?.error || 'no answer'}); try again in a moment`, { retryable: true });
    return v;
  }
  /** An agent's session reports what it spent (measured by its own CLI). The claims it held in that window are the
   *  work the tokens bought; a session's tokens are split evenly across them for the per-role view. */
  recordUsage(agent, { input = 0, cachedInput = 0, output = 0, costUsd = null, vendor = null, since, until } = {}) {
    const n = (x) => (Number.isFinite(x) && x >= 0 && x < 1e10 ? Math.round(x) : 0);
    if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) throw new ApiError(400, 'since and until (ms) are required');
    const claims = this.q('SELECT id, intent, kind FROM claims WHERE agent = ? AND created BETWEEN ? AND ?', agent, since - 5000, until);
    this.sql.exec('INSERT INTO usage (agent, vendor, input, cached, output, cost, since, until, claims, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      agent, typeof vendor === 'string' ? vendor.slice(0, 20) : null, n(input), n(cachedInput), n(output), Number.isFinite(costUsd) && costUsd >= 0 && costUsd < 10000 ? costUsd : null, since, until, JSON.stringify(claims), this.now());
    this.event('usage.recorded', { agent, data: { tokens: n(input) + n(cachedInput) + n(output), jobs: claims.length } });
    return { recorded: true, jobs: claims.length };
  }
  /** Tokens spent, by role and in total, and per landed change. Gates are code: they cost nothing. */
  usage() {
    const rows = this.q('SELECT * FROM usage ORDER BY id');
    const byRole = {}; const total = { input: 0, cached: 0, output: 0, sessions: rows.length, costUsd: 0 };
    for (const r of rows) {
      for (const k of ['input', 'cached', 'output']) total[k] += r[k];
      total.costUsd += r.cost || 0;
      const cl = J(r.claims) || []; const share = cl.length || 1;
      for (const c of cl.length ? cl : [{ kind: 'idle' }]) {
        const role = { author: 'author', build: 'builder', rederive: 'rebuilder', dependent: 'rebuilder', examine: 'examiner', review: 'reviewer' }[c.kind] || 'other';
        const b = (byRole[role] ||= { tokens: 0, jobs: 0 }); b.tokens += Math.round((r.input + r.cached + r.output) / share); b.jobs += c.kind === 'idle' ? 0 : 1;
      }
    }
    const landed = this.one("SELECT count(*) AS n FROM intents WHERE state = 'landed'").n;
    const tokens = total.input + total.cached + total.output;
    return { total: { ...total, tokens }, byRole, landed, tokensPerLanded: landed ? Math.round(tokens / landed) : null };
  }
  rulesAt(version) { return J(this.one('SELECT body FROM rules WHERE version = ?', version)?.body)?.rules || []; }
  listIntents(state) {
    return this.q(`SELECT id, goal, state, author, attempts, landed_via, landed_sha, updated, allowed, ask FROM intents ${state ? 'WHERE state = ?' : ''} ORDER BY created`, ...(state ? [state] : []))
      .map(({ allowed, ...r }) => ({ ...r, files: J(allowed) || [], holder: this.holder(r.id) }));
  }
  getIntent(id, agent) {
    const it = this.intent(id); if (!it) throw new ApiError(404, 'no such intent');
    const { hidden, staged_for, ...pub } = it;
    // the staging fork's URL carries a write token: only the dependent's own claim gets it
    const st = J(staged_for); pub.staged_for = st ? JSON.stringify({ forIntent: st.forIntent, failing: st.failing }) : null;
    // the examiner works from the goal alone: while it holds the examination it sees neither the author's tests nor code
    // and so does anyone who could still become its examiner: until the examination is done, only the job's own builders see its tests
    const builder = !agent || agent === it.author || this.one(`SELECT 1 AS x FROM claims WHERE intent = ? AND agent = ? AND kind IN ${BUILDERS}`, id, agent);
    if (agent && agent !== 'owner' && !builder && ['needed', 'claimed'].includes(it.exam_state)) {
      Object.assign(pub, { tests: undefined, last_diff: undefined, last_failure: undefined, supersedes: undefined, receipt: undefined, note: 'you are examining this job: you see its goal only' });
    }
    const ask = it.ask ? this.one('SELECT id, text, agent FROM asks WHERE id = ?', it.ask) : null;
    return { ...pub, ask, hiddenTests: Object.keys(hidden || {}).length };
  }
  events(since = 0, limit = 500, tail = 0) {
    const rows = tail ? this.q('SELECT * FROM events ORDER BY seq DESC LIMIT ?', Math.min(tail, 5000)).reverse() : this.q('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?', since, limit);
    return rows.map((e) => ({ ...e, data: J(e.data) }));
  }
  uniqueId(base) { let id = base; for (let i = 2; this.one('SELECT 1 AS x FROM intents WHERE id = ?', id); i++) id = `${base}-${i}`; return id; }
}

/** {verdict: "pass"|"block", findings: [{file, line, severity, reason}]}; a block needs at least one finding. */
function validateReview(input, ruleCount = 0) {
  const bad = (m) => { throw new ApiError(400, `review: ${m}`); };
  const { verdict, findings = [], summary } = input || {};
  if (!['pass', 'block'].includes(verdict)) bad('verdict must be "pass" or "block"');
  if (summary != null && (typeof summary !== 'string' || summary.length > 1000)) bad('summary must be a string of at most 1000 characters');
  if (!Array.isArray(findings)) bad('findings must be a list');
  if (findings.length > 50) bad('at most 50 findings');
  const clean = findings.map((f, i) => {
    if (!f || typeof f !== 'object') bad(`finding ${i} must be an object`);
    if (typeof f.file !== 'string' || !f.file) bad(`finding ${i}: file is required`);
    if (!Number.isInteger(f.line) || f.line < 0) bad(`finding ${i}: line must be a whole number (0 if not line-specific)`);
    if (!SEVERITIES.includes(f.severity)) bad(`finding ${i}: severity must be one of ${SEVERITIES.join(', ')}`);
    if (typeof f.reason !== 'string' || !f.reason.trim()) bad(`finding ${i}: reason is required`);
    if (ruleCount && !(Number.isInteger(f.rule) && f.rule >= 0 && f.rule <= ruleCount)) bad(`finding ${i}: rule must be the number of the house rule it breaks (1 to ${ruleCount}), or 0 if no rule covers it`);
    if (f.axis != null && !AXES.includes(f.axis)) bad(`finding ${i}: axis must be one of ${AXES.join(', ')}`);
    return { file: f.file, line: f.line, severity: f.severity, reason: f.reason.slice(0, 1000), ...(ruleCount ? { rule: f.rule } : {}), ...(f.axis ? { axis: f.axis } : {}) };
  });
  if (verdict === 'block' && !clean.length) bad('a block needs at least one finding the rebuilder can act on');
  return { verdict, findings: clean, ...(summary?.trim() ? { summary: summary.trim() } : {}) };
}

export class ApiError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
