// Owner-only lander regression harness: seed a throwaway trunk, fork, play agents,
// land, report per-step results, delete everything. Used by test/cloud-scenarios.mjs.
//   steps: { fork: "a" } | { apply: "a", writes, deletes } | { land: "a", intent, testOwners } | { head: true } (trunk's main)
import { getContainer } from '@cloudflare/containers';
import LANDER_SRC from './lander/server.cjs';

let h = 0; for (const ch of LANDER_SRC) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
const LANDER_VERSION = h.toString(36);
const INSTANCE = 'dev-scenario'; // stable name, so deploys don't orphan running containers
const authed = (remote, token) => remote.replace('https://', `https://x:${token.split('?')[0]}@`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// After a deploy the stable instance may still run the previous lander: check once per isolate, restart if stale.
let checked = false;
async function ensureCurrent(env, stub) {
  if (checked) return; checked = true;
  try {
    const r = await stub.fetch(new Request('http://lander/env', { method: 'POST', body: '{}' }));
    const v = r.ok ? (await r.json()).version : null;
    if (v && v !== LANDER_VERSION) { await stub.destroy(); await sleep(2000); }
  } catch {}
}
async function callLander(env, op, body) {
  const stub = getContainer(env.LANDER, INSTANCE);
  await ensureCurrent(env, stub);
  for (let attempt = 0; ; attempt++) {
    const r = await stub.fetch(new Request(`http://lander/${op}`, { method: 'POST', body: JSON.stringify(body ?? {}) }));
    const text = await r.text();
    if ((r.status === 503 || (r.status === 500 && /Maximum number of running container instances/.test(text))) && attempt < 30) { await sleep(3000); continue; }
    try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, raw: text.slice(0, 300) }; }
  }
}
async function forkWithRetry(env, source, name) {
  for (let i = 0; i < 6; i++) {
    try { const repo = await env.ARTIFACTS.get(source); return await repo.fork(name, { defaultBranchOnly: true }); }
    catch (e) { if (i === 5) throw e; await sleep(500 * 2 ** i); }
  }
}

export async function scenario(env, { seed, steps }) {
  const run = `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const created = []; const forks = {}; const results = [];
  try {
    const t0 = Date.now();
    const trunk = await env.ARTIFACTS.create(`${run}-trunk`); created.push(`${run}-trunk`);
    const trunkUrl = authed(trunk.remote, trunk.token);
    results.push({ step: 'seed', ...(await callLander(env, 'seed', { remote: trunkUrl, files: seed.files })), ms: Date.now() - t0 });
    for (const s of steps) {
      const t = Date.now();
      if (s.fork) {
        const f = await forkWithRetry(env, `${run}-trunk`, `${run}-${s.fork}`); created.push(`${run}-${s.fork}`);
        forks[s.fork] = authed(f.remote, f.token);
        results.push({ step: `fork ${s.fork}`, ms: Date.now() - t });
      } else if (s.apply) {
        results.push({ step: `apply ${s.apply}`, ...(await callLander(env, 'apply', { remote: forks[s.apply], writes: s.writes, deletes: s.deletes })), ms: Date.now() - t });
      } else if (s.land) {
        const r = await callLander(env, 'land', { trunk: trunkUrl, candidate: forks[s.land], intent: s.intent, testOwners: s.testOwners, intentDoc: s.intentDoc, receipt: { scenario: s.name } });
        results.push({ step: `land ${s.land}`, name: s.name, ...r, roundTripMs: Date.now() - t });
      } else if (s.head) {
        const r = await callLander(env, 'browse', { trunk: trunkUrl, kind: 'tree' });
        results.push({ step: 'head', head: r.head, ms: Date.now() - t });
      }
    }
    return { ok: true, instance: INSTANCE, results };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 400), results };
  } finally {
    for (const n of created) { try { await env.ARTIFACTS.delete(n); } catch {} }
  }
}
