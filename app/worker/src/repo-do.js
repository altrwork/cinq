// RepoDO: one per repo, the single source of truth. Wraps the Engine with Cloudflare pieces:
//   ctx.storage.sql      → engine state (intents, claims, queue, events)
//   env.ARTIFACTS        → trunk + one fork per claim (≤ 3 fork creations in flight, retried)
//   env.LANDER containers → per repo, the lander (writes main) and a reader (checks, browsing)
//   alarms               → landing loop + lease sweep
//   hibernating WebSockets → live events for the web home (replay from ?since=seq)
// Every RPC method returns { ok, ...result } or { ok:false, status, error } so errors survive RPC.
import { DurableObject } from 'cloudflare:workers';
import { getContainer } from '@cloudflare/containers';
import { Engine, ApiError } from './engine.js';
import LANDER_SRC from './lander/server.cjs';

let h = 0; for (const ch of LANDER_SRC) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
const LANDER_VERSION = h.toString(36);
const LANDER = 'lander', READER = 'reader';
const authed = (remote, token) => remote.replace('https://', `https://x:${token.split('?')[0]}@`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK_MS = 30_000;
const IDLE_STOP_MS = 60_000;

export class RepoDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.repo = null; this.trunkToken = null; this.forksInFlight = 0; this.waiters = new Set();
    ctx.blockConcurrencyWhile(async () => { this.repo = (await ctx.storage.get('repo')) || null; });
    this.makeEngine();
  }

  // The engine creates its tables on construction; destroy() wipes storage, so it is rebuilt there too.
  makeEngine() {
    const { ctx, env } = this;
    this.engine = new Engine({
      sql: ctx.storage.sql,
      leaseMs: (+env.LEASE_SECONDS || 1200) * 1000,
      now: () => Date.now(),
      emit: (e) => this.broadcast(e),
      artifacts: { trunkUrl: () => this.trunkUrl, trunkReadUrl: () => this.trunkReadUrl, fork: (name) => this.fork(name), remove: (name) => env.ARTIFACTS.delete(name),
        // a fresh read token for a fork that already exists (an approval can come long after the job parked)
        refresh: async (name) => { const r = await env.ARTIFACTS.get(name); const t = await r.createToken('read', 3600); const info = await r.info().catch(() => ({}));
          return authed(info.remote || `https://${env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${env.NAMESPACE}/${name}.git`, t.plaintext); } },
      // landing commits are signed with the deployment's key, when it has one
      lander: { land: (b) => this.lander('land', { ...b, signingKey: env.LANDER_SIGNING_KEY, signingPublic: env.LANDER_SIGNING_PUB }), check: (b) => this.lander('check', b, READER), stage: (b) => this.lander('stage', b),
        files: (paths) => this.lander('browse', { trunk: this.trunkReadUrl, kind: 'files', path: paths }, READER),
        context: (paths) => this.lander('browse', { trunk: this.trunkReadUrl, kind: 'context', path: paths }, READER) },
    });
  }

  get trunkName() { return `${this.repo}-trunk`; }
  get trunkUrl() { return this.trunkToken; } // refreshed by ensureTrunkToken() before any engine call
  async ensureTrunkToken() {
    const now = Date.now();
    if (this.trunkToken && this.trunkTokenUntil > now + 5 * 60_000) return;
    const repo = await this.env.ARTIFACTS.get(this.trunkName);
    const tok = await repo.createToken('write', 3600);
    const read = await repo.createToken('read', 3600); // examiners and agents only ever get read access to trunk
    const info = await repo.info().catch(() => ({}));
    // Documented remote pattern, used if info() doesn't carry it.
    const remote = info.remote || `https://${this.env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${this.env.NAMESPACE}/${this.trunkName}.git`;
    this.trunkToken = authed(remote, tok.plaintext);
    this.trunkReadUrl = authed(remote, read.plaintext);
    this.trunkTokenUntil = now + 3600_000;
  }
  async fork(name) {
    while (this.forksInFlight >= 3) await sleep(200); // Artifacts: at most 3 fork creations at once
    this.forksInFlight++;
    try {
      for (let i = 0; ; i++) {
        try {
          const trunk = await this.env.ARTIFACTS.get(this.trunkName);
          const f = await trunk.fork(name.slice(0, 90), { defaultBranchOnly: true });
          return { name: f.name, url: authed(f.remote, f.token) };
        } catch (e) { if (i >= 5) throw e; await sleep(500 * 2 ** i + Math.random() * 250); }
      }
    } finally { this.forksInFlight--; }
  }
  // Two containers per repo: the lander (the only writer to main, one landing at a time) and a reader for the
  // tests-fail-today check and browsing, so neither waits behind a landing. The reader holds no write path to main.
  // If the account's container limit leaves no room for a reader, its work falls back to the lander.
  // Calls in flight keep both containers up: the idle stop and a version restart wait until none are running
  // (a check before a job has a claim can take minutes). Counted in memory: if the object goes, its calls go with it.
  async lander(op, body, role = LANDER) {
    this.inFlight = (this.inFlight || 0) + 1;
    try { return await this.callContainer(op, body, role); } finally { this.inFlight--; this.lastLanderUse = Date.now(); }
  }
  async callContainer(op, body, role) {
    const stub = getContainer(this.env.LANDER, role === READER ? `repo-${this.repo}-read` : `repo-${this.repo}`);
    this.lastLanderUse = Date.now();
    this.landerChecked ||= new Set();
    if (!this.landerChecked.has(role) && op !== 'env' && this.inFlight <= 1) { // never restart under another call
      this.landerChecked.add(role);
      try {
        const r = await stub.fetch(new Request('http://lander/env', { method: 'POST', body: '{}' }));
        const v = r.ok ? (await r.json()).version : null;
        if (v && v !== LANDER_VERSION) { await stub.destroy(); this.engine.event('lander.restarted', { data: { from: v, to: LANDER_VERSION } }); }
      } catch {}
    }
    if (op !== 'env') await this.armSweep(); // the alarm loop owns the idle stop; keep it running while the lander is in use
    for (let attempt = 0; ; attempt++) { // a new instance answers 503 (or throws) for ~20 s while provisioning
      let r;
      try { r = await stub.fetch(new Request(`http://lander/${op}`, { method: 'POST', body: JSON.stringify(body) })); }
      catch (e) { if (attempt < 15) { await sleep(3000); continue; } throw e; }
      const text = await r.text();
      // 503 while provisioning; 500 "Maximum number of running container instances exceeded" while old versions drain
      const full = r.status === 500 && /Maximum number of running container instances/.test(text);
      if (full && role === READER && attempt >= 2) return this.callContainer(op, body, LANDER);
      if ((r.status === 503 || full) && attempt < 30) { await sleep(3000); continue; }
      try { return JSON.parse(text); } catch { return { verdict: 'error', detail: text.slice(0, 300) }; }
    }
  }

  async call(fn, agent) {
    try {
      if (!this.repo) throw new ApiError(404, 'repo not initialised');
      await this.ensureTrunkToken();
      return { ok: true, ...(await fn()) };
    } catch (e) { return { ok: false, status: e.status || 500, error: e.message, ...(e.extra || {}) }; }
  }
  /** Create the trunk repo (optionally seeded) and remember which repo this DO is. */
  async init(repo, { seed } = {}) {
    try {
      this.repo = repo; await this.ctx.storage.put('repo', repo);
      let exists = true;
      try { await this.env.ARTIFACTS.get(this.trunkName); } catch { exists = false; }
      if (!exists) await this.env.ARTIFACTS.create(this.trunkName);
      await this.ensureTrunkToken();
      if (seed && !exists) { const r = await this.lander('seed', { remote: this.trunkUrl, files: seed }); if (!r.pushed) throw new Error('seed failed: ' + r.detail); }
      this.engine.event('repo.ready', { data: { repo, trunk: this.trunkName, created: !exists } });
      return { ok: true, repo, trunk: this.trunkName, created: !exists };
    } catch (e) { return { ok: false, status: 500, error: String(e.message || e) }; }
  }
  // Owner-only: a write remote for trunk, so `init` can push the repo's real history. A write token for main exists only to import a repo's history at `cinq init`: never once anything has landed,
  // and only within 30 minutes of the first one. After that, main is written by the lander alone, owner included.
  async importRemote() {
    return this.call(async () => {
      // closed as soon as any work is handed in, not just landed: a token must never outlive the window
      if (this.engine.one("SELECT 1 AS x FROM events WHERE type IN ('submit.received', 'land.landed', 'trunk.head') LIMIT 1")) throw new ApiError(409, 'main is already on Artifacts and only the lander writes it now; use `npx cinq-git sync` to pull it');
      const first = (await this.ctx.storage.get('importOpenedAt')) || Date.now();
      const left = Math.floor((first + 30 * 60_000 - Date.now()) / 1000);
      if (left < 60) throw new ApiError(410, 'the import window (30 minutes after the first import) has closed; delete and re-create the repo to import again');
      await this.ctx.storage.put('importOpenedAt', first);
      const repo = await this.env.ARTIFACTS.get(this.trunkName);
      const ttl = Math.min(900, left);
      const tok = await repo.createToken('write', ttl);
      const remote = `https://${this.env.ACCOUNT_ID}.artifacts.cloudflare.net/git/${this.env.NAMESPACE}/${this.trunkName}.git`;
      this.engine.event('repo.import-token', { data: { ttlSeconds: ttl } });
      return { remote: authed(remote, tok.plaintext), ttlSeconds: ttl };
    });
  }
  // Any open claim needs the sweep alarm running, or a session that dies before submitting holds its job forever.
  async armSweep() { if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS); }
  async proposeIntent(agent, input) { const r = await this.call(() => this.engine.proposeIntent(agent, input), agent); if (r.ok) await this.armSweep(); return r; }
  async proposePlan(agent, input) { const r = await this.call(() => this.engine.proposePlan(agent, input), agent); if (r.ok) await this.armSweep(); return r; }
  recordUsage(agent, body) { return this.call(() => this.engine.recordUsage(agent, body), agent); }
  usage() { return this.call(() => this.engine.usage()); }
  asks() { return this.call(() => ({ asks: this.engine.asks() })); }
  houseRules() { return this.call(() => ({ ...this.engine.houseRules(), history: this.engine.rulesHistory() })); }
  setHouseRules(by, input) { return this.call(() => this.engine.setHouseRules(by, input), by); }
  async claim(agent, input) { const r = await this.call(() => this.engine.claim(agent, input), agent); if (r.ok && r.claim) await this.armSweep(); return r; }
  async submit(agent, claimId, generation) {
    const r = await this.call(() => this.engine.submit(agent, claimId, generation), agent);
    if (r.ok) await this.ctx.storage.setAlarm(Date.now() + 10);
    return r;
  }
  /** A reviewer hands in {verdict, findings}; a pass (or an advisory block) goes straight to landing. */
  async decide(intentId, action, by, note) { const r = await this.call(() => this.engine.decide(intentId, action, by, note), by); if (r.ok && action === 'approve') await this.ctx.storage.setAlarm(Date.now() + 10); return r; }
  async submitReview(agent, claimId, review) {
    const r = await this.call(() => this.engine.submitReview(agent, claimId, review), agent);
    if (r.ok && r.queuedForLanding) await this.ctx.storage.setAlarm(Date.now() + 10);
    return r;
  }
  submitTests(agent, claimId, tests, supersedeVerdicts) { return this.call(() => this.engine.submitTests(agent, claimId, tests, supersedeVerdicts), agent).then(async (r) => { if (r.ok && r.queuedForLanding) await this.ctx.storage.setAlarm(Date.now() + 10); return r; }); }
  /** Owner-only export of finished jobs' registered and hidden tests (for the backtest oracle). An open job's
   *  hidden tests stay sealed from everyone, owner key included. */
  exportTests() {
    return this.call(() => ({ intents: this.engine.q("SELECT id, author, examiner, exam_state, state, goal, allowed, tests, hidden FROM intents WHERE state IN ('landed', 'satisfied', 'parked', 'rejected') ORDER BY created")
      .map((r) => ({ id: r.id, author: r.author, examiner: r.examiner, examState: r.exam_state, state: r.state, goal: r.goal, allowed: JSON.parse(r.allowed || '[]'), tests: JSON.parse(r.tests || '{}'), hidden: JSON.parse(r.hidden || '{}') })) }));
  }

  /** Owner-only (and the approval code, checked in index.js): delete trunk, every fork, and all state. */
  async destroy() {
    try {
      const forks = this.engine.q('SELECT DISTINCT fork_name FROM claims WHERE fork_name IS NOT NULL').map((r) => r.fork_name);
      const staged = this.engine.q("SELECT staged_for FROM intents WHERE staged_for IS NOT NULL").map((r) => { try { return JSON.parse(r.staged_for).forkName; } catch { return null; } }).filter(Boolean);
      let deleted = 0;
      for (const name of [...new Set([...forks, ...staged, this.trunkName])]) { try { if (await this.env.ARTIFACTS.delete(name)) deleted++; } catch {} }
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(1001, 'repo deleted'); } catch {} }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      const repo = this.repo; this.repo = null; this.trunkToken = null; this.makeEngine();
      return { ok: true, repo, artifactsReposDeleted: deleted };
    } catch (e) { return { ok: false, status: 500, error: String(e.message || e) }; }
  }
  /** Web home reads: tree | file | log | blame, served from the reader's checkout of trunk. */
  // Main only changes with these events, so a read is kept until the next one: browsing the web home wakes a container
  // once per version of main, not on every page view (containers bill for their memory while awake).
  browse(kind, path) { return this.call(async () => {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS browse_cache (key TEXT PRIMARY KEY, gen INTEGER, body TEXT)');
    const gen = this.engine.one("SELECT max(seq) AS s FROM events WHERE type IN ('repo.ready', 'land.landed', 'land.recovered', 'trunk.head')").s || 0;
    const key = `${kind}:${path || ''}`;
    const hit = sql.exec('SELECT body FROM browse_cache WHERE key = ? AND gen = ?', key, gen).toArray()[0];
    if (hit) return JSON.parse(hit.body);
    const r = await this.lander('browse', { trunk: this.trunkReadUrl, kind, path }, READER);
    if (r.verdict === 'error') throw new ApiError(503, 'lander busy, retry shortly'); if (r.error) throw new ApiError(404, r.error);
    const body = JSON.stringify(r);
    if (body.length < 1_000_000) { sql.exec('DELETE FROM browse_cache WHERE gen != ?', gen); sql.exec('INSERT OR REPLACE INTO browse_cache (key, gen, body) VALUES (?, ?, ?)', key, gen, body); }
    return r;
  }); }
  /** Read-only trunk remote (for `cinq sync` and anyone who just needs to look). */
  readRemote() { return this.call(() => ({ remote: this.trunkReadUrl })); }
  release(agent, claimId, reason) { return this.call(() => this.engine.release(agent, claimId, reason), agent); }
  /** Long-poll: returns as soon as the claim's state changes, or after waitSeconds (≤ 55). Renews the lease. */
  async status(agent, claimId, waitSeconds = 0) {
    const first = await this.call(() => this.engine.heartbeat(agent, claimId), agent);
    if (!first.ok || !waitSeconds) return first;
    const key = (s) => `${s.claimState}/${s.intentState}`;
    const until = Date.now() + Math.min(waitSeconds, 55) * 1000;
    while (Date.now() < until) {
      await new Promise((res) => { const w = () => { this.waiters.delete(w); res(); }; this.waiters.add(w); setTimeout(w, Math.min(5000, until - Date.now())); });
      const now = await this.call(() => this.engine.status(agent, claimId));
      if (!now.ok || key(now) !== key(first)) return now;
    }
    return this.call(() => this.engine.status(agent, claimId));
  }
  listIntents(state, agent) { return this.call(() => ({ intents: this.engine.listIntents(state) }), agent); }
  getIntent(id, agent) { return this.call(() => ({ intent: this.engine.getIntent(id, agent) }), agent); }
  events(since = 0, tail = 0) { return this.call(() => ({ events: this.engine.events(since, 500, tail) })); }
  async getReceipt(id) {
    return this.call(async () => {
      const repo = await this.env.ARTIFACTS.get(this.trunkName);
      const file = await repo.readFile({ ref: 'main', path: `.cinq/receipts/${id}.json` }).catch(() => null);
      return { receipt: file ? JSON.parse(typeof file === 'string' ? file : await new Response(file).text()) : null, engine: this.engine.getIntent(id).receipt };
    });
  }

  async alarm() {
    if (!this.repo) return;
    await this.ensureTrunkToken();
    this.engine.sweep();
    // One landing per alarm, so a long queue never runs into the alarm's time limit; the next alarm follows at once.
    if (await this.engine.processQueue(1)) return void (await this.ctx.storage.setAlarm(Date.now() + 10));
    const busy = this.engine.one("SELECT count(*) AS n FROM claims WHERE state IN ('active','queued')").n;
    // Containers bill while awake: stop ours 1 min after last use when nothing is queued, not just via sleepAfter.
    const idleMs = Date.now() - (this.lastLanderUse || 0);
    if (!busy && !this.inFlight && this.lastLanderUse && idleMs > IDLE_STOP_MS) {
      try { await getContainer(this.env.LANDER, `repo-${this.repo}-read`).destroy(); } catch {}
      try { await getContainer(this.env.LANDER, `repo-${this.repo}`).destroy(); this.engine.event('lander.stopped', { data: { idleSeconds: Math.round(idleMs / 1000) } }); } catch {}
      this.lastLanderUse = 0;
    }
    if (busy || this.lastLanderUse) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const since = +new URL(req.url).searchParams.get('since') || 0;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    for (const e of this.engine.events(since)) server.send(JSON.stringify(e));
    // a browser that offered the "cinq" subprotocol (its key rides alongside) needs it echoed back
    const proto = (req.headers.get('sec-websocket-protocol') || '').split(',').map((s) => s.trim()).includes('cinq');
    return new Response(null, { status: 101, webSocket: client, ...(proto ? { headers: { 'Sec-WebSocket-Protocol': 'cinq' } } : {}) });
  }
  broadcast(e) {
    const msg = JSON.stringify(e);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch {} }
    for (const w of [...this.waiters]) w();
  }
  webSocketMessage() {}
  webSocketClose(ws, code) { try { ws.close(code); } catch {} }
}
