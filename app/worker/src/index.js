// Product Worker: routes + auth. One service layer (RepoDO) behind three adapters:
//   /mcp           agents (bearer agent key), stateless createMcpHandler
//   /api/v1/...    CLI + web home (owner key for admin; agent key for agent actions; reads may be public)
//   /ws/:repo      live events for the web home (hibernating WebSocket on RepoDO)
//   /dev/scenario  owner-only lander regression harness (DEV_SCENARIOS=1 deployments only: cinq deploy --dev-scenarios)
import { Container } from '@cloudflare/containers';
import { createMcpHandler } from 'agents/mcp/server';
import LANDER_SRC from './lander/server.cjs';
let lh = 0; for (const ch of LANDER_SRC) lh = (lh * 31 + ch.charCodeAt(0)) >>> 0;
const LANDER_VERSION = lh.toString(36);
import { createServer } from './mcp.js';
import { scenario } from './dev-scenario.js';
export { RepoDO } from './repo-do.js';
export { AccountDO } from './account-do.js';

export class Lander extends Container {
  defaultPort = 8080;
  sleepAfter = '1m'; // idle landers sleep fast: container time is billed while awake
  entrypoint = ['node', '-e', LANDER_SRC];
  envVars = { LANDER_VERSION }; // the lander reports this, so a running container from an older deploy is detected
}

const json = (data, status = 200) => Response.json(data, { status });
const fromRpc = (r) => json(r, r.ok ? 200 : r.status || 500);
const account = (env) => env.ACCOUNT.get(env.ACCOUNT.idFromName('account'));
const repo = (env, name) => env.REPO.get(env.REPO.idFromName(name));

// constant-time comparison, so response timing says nothing about how much of a key matched
function same(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length; for (let i = 0; i < y.length; i++) d |= (x[i] ?? 0) ^ y[i];
  return d === 0;
}
// The approval code: shown once at deploy, stored only as its SHA-256 (APPROVE_HASH). Fails closed when unset.
async function needCode(env, body, what) {
  if (!env.APPROVE_HASH) return json({ ok: false, error: `${what} needs an approval code, and this deployment has none yet: run npx cinq-git approval-code` }, 403);
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(body.code || '').trim().toUpperCase())))].map((x) => x.toString(16).padStart(2, '0')).join('');
  return same(h, env.APPROVE_HASH) ? null : json({ ok: false, error: `${what} needs your approval code (shown when you deployed; new one: npx cinq-git approval-code)` }, 403);
}
// the same rules cinq init applies
const REPO_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/, AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
async function identify(req, env) {
  const auth = req.headers.get('authorization') || '';
  // Browsers can't set headers on a WebSocket, so /ws takes the key as a subprotocol ("cinq", "k.<key>"): a header,
  // never the URL, so it stays out of request logs.
  const wsKey = new URL(req.url).pathname.startsWith('/ws/') ? (req.headers.get('sec-websocket-protocol') || '').split(',').map((s) => s.trim()).find((s) => s.startsWith('k.'))?.slice(2) : null;
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : wsKey || '';
  if (!key) return { role: 'anonymous' };
  if (env.OWNER_KEY && same(key, env.OWNER_KEY)) return { role: 'owner', agent: 'owner' };
  const v = await account(env).verify(key);
  return v ? { role: 'agent', agent: v.agent, repo: v.repo } : { role: 'anonymous' };
}

export default {
  async fetch(req, env, ctx) {
    try { return await route(req, env, ctx); }
    catch (e) { if (e instanceof URIError) return json({ ok: false, error: 'malformed URL' }, 400); throw e; } // e.g. /api/v1/repos/%
  },
};

async function route(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    const who = await identify(req, env);
    // an agent key reads only the repo it was made for (writes are checked the same way below)
    const pathRepo = p.startsWith('/ws/') ? decodeURIComponent(p.slice(4).split('/')[0]) : p.startsWith('/api/v1/repos/') ? decodeURIComponent(p.slice(14).split('/')[0]) : null;
    // a name that can't be a repo never reaches a Durable Object (each name would create one)
    if (pathRepo !== null && !REPO_NAME.test(pathRepo)) return json({ ok: false, error: 'no such repo' }, 404);
    const otherRepo = who.role === 'agent' && who.repo && pathRepo && pathRepo !== who.repo;
    const canRead = (who.role !== 'anonymous' && !otherRepo) || env.PUBLIC_READ === '1';
    const needOwner = () => (who.role === 'owner' ? null : json({ ok: false, error: 'owner key required' }, 403));
    const needAgent = () => (who.role === 'agent' || who.role === 'owner' ? null : json({ ok: false, error: 'agent key required' }, 401));

    if (p === '/mcp' || p.startsWith('/mcp/')) {
      const deny = needAgent(); if (deny) return deny;
      return createMcpHandler(() => createServer({ agent: who.agent, env, defaultRepo: who.repo }), { route: '/mcp' })(req, env, ctx);
    }

    // the lander test harness runs code in a container on your account: only on deployments made for testing
    if (p === '/dev/scenario' && req.method === 'POST' && env.DEV_SCENARIOS === '1') { const deny = needOwner(); if (deny) return deny; return json(await scenario(env, await req.json())); }

    if (p.startsWith('/ws/')) {
      if (!canRead) return json({ ok: false, error: 'unauthorised' }, 401);
      return repo(env, pathRepo).fetch(req);
    }

    // Web home: /r/<repo> and its static files come from app/web (single-page app).
    if (!p.startsWith('/api/v1/')) return env.ASSETS ? env.ASSETS.fetch(p.startsWith('/r/') ? new Request(new URL('/', url), req) : req) : new Response('not found', { status: 404 });
    const parts = p.slice(8).split('/').filter(Boolean).map(decodeURIComponent);
    const body = ['POST', 'DELETE'].includes(req.method) ? await req.json().catch(() => ({})) : {};

    if (parts[0] === 'keys') { const deny = needOwner(); if (deny) return deny;
      // every agent key is bound to one repo: an unbound key would read and write them all
      if (req.method === 'POST' && (!body.agent || !body.repo)) return json({ ok: false, error: 'agent and repo are required' }, 400);
      // "owner" and "anonymous" are roles: an agent named either would be mistaken for one
      if (req.method === 'POST' && (!AGENT_NAME.test(body.agent) || ['owner', 'anonymous'].includes(body.agent))) return json({ ok: false, error: 'agent name: lowercase letters, digits and dashes, not "owner" or "anonymous"' }, 400);
      return req.method === 'POST' ? json({ ok: true, ...(await account(env).createKey(body.agent, body.repo)) }) : json({ ok: true, keys: await account(env).listKeys() }); }
    if (parts[0] === 'stop' && req.method === 'POST') { const deny = needOwner(); if (deny) return deny; return json({ ok: true, ...(await account(env).stopAll()) }); }
    if (parts[0] === 'repos' && parts.length === 1) {
      // a name that held a main before takes the approval code to come back (a seed would otherwise rewrite it)
      if (req.method === 'POST') { if (!REPO_NAME.test(body.name || '')) return json({ ok: false, error: 'repo name: lowercase letters, digits and dashes, up to 40' }, 400);
        const deny = needOwner() || ((await account(env).wasDeleted(body.name)) && (await needCode(env, body, 're-creating a deleted repo'))); if (deny) return deny;
        const r = await repo(env, body.name).init(body.name, { seed: body.seed }); if (r.ok) await account(env).addRepo(body.name); return fromRpc(r); }
      if (!canRead) return json({ ok: false, error: 'unauthorised' }, 401);
      const repos = await account(env).listRepos();
      return json({ ok: true, repos: who.role === 'agent' ? repos.filter((r) => r.name === who.repo) : repos });
    }

    if (parts[0] === 'repos' && parts[1]) {
      const r = repo(env, parts[1]); const [, , what, id] = parts;
      if (req.method === 'GET') {
        if (!canRead) return json({ ok: false, error: 'unauthorised' }, 401);
        // the owner sees everything; an agent or an anonymous public reader is not the job's builder unless it is
        if (what === 'intents' && id) return fromRpc(await r.getIntent(id, who.role === 'owner' ? undefined : who.role === 'agent' ? who.agent : 'anonymous'));
        if (what === 'intents') return fromRpc(await r.listIntents(url.searchParams.get('state')));
        if (what === 'receipts' && id) return fromRpc(await r.getReceipt(id));
        if (what === 'asks') return fromRpc(await r.asks());
        if (what === 'usage') return fromRpc(await r.usage());
        if (what === 'rules') return fromRpc(await r.houseRules());
        if (what === 'events') return fromRpc(await r.events(+url.searchParams.get('since') || 0, +url.searchParams.get('tail') || 0));
        if (['tree', 'file', 'log', 'blame'].includes(what)) return fromRpc(await r.browse(what, url.searchParams.get('path')));
      }
      if (req.method === 'GET' && what === 'export-tests') { const deny = needOwner(); if (deny) return deny; return fromRpc(await r.exportTests()); } // never reachable by agents
      // deleting a repo and re-importing it would rewrite main, so it takes the approval code like an approval does
      if (req.method === 'DELETE' && !what) { const deny = needOwner() || (await needCode(env, body, 'deleting a repo')); if (deny) return deny; const d = await r.destroy(); if (d.ok) await account(env).removeRepo(parts[1]); return fromRpc(d); }
      if (req.method === 'POST' && what === 'intents' && id && parts[4] === 'decide') { const deny = needOwner(); if (deny) return deny;
        // Approving lets a change past a security gate, so it takes the approval code, which isn't stored on the owner's
        // machine: an agent holding only the owner key can't approve. (Code running as the owner can also reach their
        // Cloudflare login and redeploy; that is outside what a key check can stop.)
        if (body.action === 'approve') { const deny = await needCode(env, body, 'approving'); if (deny) return deny; }
        return fromRpc(await r.decide(id, body.action, 'owner', body.note)); }
      // the house rules are the bar every review is held to: setting them takes the approval code, like an approval
      if (req.method === 'POST' && what === 'rules') { const deny = needOwner() || (await needCode(env, body, 'changing the house rules')); if (deny) return deny;
        return fromRpc(await r.setHouseRules('owner', { rules: body.rules, reviewers: body.reviewers })); }
      // a person's own Claude Code session reports through the owner (e.g. a Stop hook): what that agent spent
      if (req.method === 'POST' && what === 'usage-for') { const deny = needOwner(); if (deny) return deny;
        if (typeof body.agent !== 'string' || !body.agent) return json({ ok: false, error: 'agent is required' }, 400);
        return fromRpc(await r.recordUsage(body.agent, body)); }
      // a name that held a main before (deleted, now re-created) takes the approval code to import again
      if (req.method === 'POST' && what === 'import-remote') { const deny = needOwner() || ((await account(env).wasDeleted(parts[1])) && (await needCode(env, body, 're-importing a deleted repo'))); if (deny) return deny; return fromRpc(await r.importRemote()); }
      if (req.method === 'POST') {
        const deny = needAgent(); if (deny) return deny;
        // an agent key works only on the repo it was created for
        if (who.role === 'agent' && who.repo && who.repo !== parts[1]) return json({ ok: false, error: `this agent key is for repo ${who.repo}` }, 403);
        if (what === 'propose') return fromRpc(await r.proposeIntent(who.agent, body));
        if (what === 'usage') return fromRpc(await r.recordUsage(who.agent, body));
        if (what === 'plan') return fromRpc(await r.proposePlan(who.agent, body));
        if (what === 'claim') return fromRpc(await r.claim(who.agent, body));
        if (what === 'submit') return fromRpc(await r.submit(who.agent, body.claimId, body.generation));
        if (what === 'status') return fromRpc(await r.status(who.agent, body.claimId, body.waitSeconds || 0));
        if (what === 'release') return fromRpc(await r.release(who.agent, body.claimId, body.reason));
        if (what === 'submit-review') return fromRpc(await r.submitReview(who.agent, body.claimId, { verdict: body.verdict, findings: body.findings, summary: body.summary }));
        if (what === 'submit-tests') return fromRpc(await r.submitTests(who.agent, body.claimId, body.tests, body.supersedeVerdicts));
        if (what === 'read-remote') return fromRpc(await r.readRemote());
      }
    }
    return json({ ok: false, error: 'not found' }, 404);
}
