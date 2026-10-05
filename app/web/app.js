// Project home: read-only web view of one repo. Plain JS module, no build step.
// Route: /r/<repo>[/tree/<dir> | /blob/<path> | /why[/<path>] | /live | /jobs[/<id>]]
// Data: /api/v1/repos/<repo>/... plus the live event stream on /ws/<repo>.


/* ---------------- tiny helpers ---------------- */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const out = (v) => v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(out).join('') : esc(v);
function html(strings, ...vals) {
  let o = '';
  strings.forEach((s, i) => { o += s; if (i < vals.length) o += out(vals[i]); });
  return raw(o);
}
const icon = (id, s = 16) => raw(`<svg width="${s}" height="${s}" aria-hidden="true"><use href="#i-${id}"/></svg>`);
const $ = (s, el = document) => el.querySelector(s);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const short = (sha) => (sha || '').slice(0, 7);

function clock(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
function day(ts) { return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function stamp(ts) { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); }
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) return stamp(ts);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return day(ts);
}
function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60 ? (s % 60) + ' s' : ''}`.trim();
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

/* ---------------- repo, key, api ---------------- */
const parts = location.pathname.split('/').filter(Boolean);
const REPO = parts[0] === 'r' && parts[1] ? decodeURIComponent(parts[1]) : '';
const BASE = `/r/${encodeURIComponent(REPO)}`;
const KEY_SLOT = 'gl.key';
let KEY = null;
(function readKey() {
  const m = location.hash.match(/(?:^#|&)k=([^&]+)/);
  if (m) {
    KEY = decodeURIComponent(m[1]);
    try { sessionStorage.setItem(KEY_SLOT, KEY); } catch {}
    const rest = location.hash.replace(/(?:^#|&)k=[^&]+/, '').replace(/^#?&?/, '');
    history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
  } else {
    try { KEY = sessionStorage.getItem(KEY_SLOT); } catch {}
  }
})();

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(path) {
  let r;
  try {
    r = await fetch(`/api/v1/repos/${encodeURIComponent(REPO)}/${path}`, { headers: KEY ? { Authorization: `Bearer ${KEY}` } : {} });
  } catch (e) { throw new ApiError(0, 'The server could not be reached.'); }
  let j = null;
  try { j = await r.json(); } catch {}
  if (r.status === 401 || r.status === 403 || (j && /unauthori[sz]ed|forbidden/i.test(j.error || ''))) throw new ApiError(401, 'unauthorised');
  if (!r.ok || !j || j.ok === false) throw new ApiError(r.status, (j && j.error) || `The server answered ${r.status}.`);
  // The git-backed endpoints can answer ok:true with verdict:"error" when the repo's worker is busy.
  if (j.verdict === 'error') throw new ApiError(503, 'The repo storage is busy right now.');
  return j;
}

async function apiPost(path, body) {
  const r = await fetch(`/api/v1/repos/${encodeURIComponent(REPO)}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.ok === false) throw new ApiError(r.status, (j && j.error) || `The server answered ${r.status}.`);
  return j;
}

/* ---------------- state ---------------- */
const S = {
  tree: null, log: null, intents: [], events: [], lastSeq: 0, booted: false, bootSeq: 0,
  files: new Map(), blame: new Map(), detail: new Map(), receipts: new Map(),
  conn: 'connecting', view: null, arrived: new Map(), usage: null, rules: null, drafts: {}, // drafts: what a person is typing, kept across live re-renders
};
// Entrance animation for things that arrived live: returns a style that resumes the animation across re-renders.
const ENTER_MS = 1600;
function enter(key) {
  const t = S.arrived.get(key); if (!t) return null;
  const el = Date.now() - t; return el < ENTER_MS ? `animation-delay:-${el}ms` : null;
}
const intentById = (id) => S.intents.find((i) => i.id === id);

function title(id) {
  const g = intentById(id)?.goal || S.events.find((e) => e.intent === id && e.type === 'intent.proposed')?.data?.goal || '';
  const m = g.match(/^([^:.]{3,60}):\s/);
  if (m) return m[1].trim().replace(/^./, (c) => c.toUpperCase());
  if (g) {
    // the first sentence: a full stop before a capital, never inside "e.g." or "i.e."; an aside in brackets is dropped
    let first = g.split(/(?<!\b(?:e\.g|i\.e|etc|vs))(?<=\.)\s+(?=[A-Z`])/)[0].replace(/\s*\((?:e\.g|i\.e)\.?[^)]*\)?/g, '').trim();
    return first.length > 72 ? first.slice(0, 70).trimEnd() + '…' : first.replace(/\.$/, '');
  }
  return id;
}
function agentLabel(a) {
  if (!a) return 'An agent';
  if (/^claude-/.test(a)) return 'Claude Code session';
  if (/^crew-/.test(a)) return 'Crew agent';
  if (/^codex-/.test(a)) return 'Codex session';
  if (/^cursor-/.test(a)) return 'Cursor session';
  return 'Agent';
}
const STATE = {
  'working': ['Being written', 'work'], 'awaiting-examiner': ['Waiting for hidden tests', 'eye'], 'awaiting-review': ['Waiting for a reviewer to read the diff', 'eye'],
  'queued': ['Waiting to land', 'ring'], 'landing': ['Landing now', 'ring'], 'landed': ['On main', 'ok'],
  'rederive': ['Waiting for a fresh agent', 'hold'], 'rederiving': ['Being rebuilt by a fresh agent', 'work'],
  'dependent': ['Needs rebuilding to fit a change', 'hold'], 'dependent-working': ['Being rebuilt to fit a change', 'work'],
  'waiting-on-dependents': ['Held until the code it affects is rebuilt', 'hold'], 'parked': ['Parked: needs a person', 'hold'],
  'rejected': ['Turned away', 'x'], 'open': ['Waiting for an agent to build it', 'ring'], 'building': ['Being built', 'work'],
};
const stateText = (s) => (STATE[s] || [s || 'Unknown'])[0];
function stateIcon(it) {
  if (it.state === 'landed') return viaIcon(it.landed_via);
  return (STATE[it.state] || [0, 'ring'])[1];
}
// the engine's landed_via: as-written | re-derived#N | with-dependent:<id> (rebuilt to fit a contract change) | contract-change(<id>)
const TOGETHER = /^(with-dependent|contract-change)/;
function viaIcon(via) { return /^re-derived/.test(via || '') ? 'rebuilt' : TOGETHER.test(via || '') ? 'pair' : 'ok'; }
function viaText(via) {
  if (!via || via === 'as-written') return 'Landed as written';
  if (via === 'built') return 'Built by another agent, then landed';
  let m = via.match(/^re-derived#(\d+)/);
  if (m) return m[1] === '1' ? 'Rebuilt by a fresh agent, then landed' : `Rebuilt by a fresh agent (attempt ${m[1]}), then landed`;
  if (/^with-dependent/.test(via)) return 'Rebuilt to fit a contract change, then landed together with it';
  if (/^contract-change/.test(via)) return 'Landed together with the jobs rebuilt to fit it';
  return via;
}
function reasonText(r) {
  if (!r) return '';
  const s = typeof r === 'string' ? r : r.reason || r.verdict || JSON.stringify(r);
  if (/lease expired/i.test(s)) return 'its agent stopped responding';
  if (/review-blocked/i.test(s)) return 'its reviewer blocked it';
  if (/^parked$/i.test(s)) return 'a check needs a person to look at it';
  if (/conflict/i.test(s)) return 'it clashed with newer work';
  if (/noop|empty/i.test(s)) return 'it was handed in empty';
  if (/too many failed attempts/i.test(s)) return 'two attempts failed, so a person decides';
  if (/red|fail/i.test(s)) return 'its tests failed on top of the latest main';
  return s;
}
const GATE = {
  noop: 'Handed in real changes', footprint: 'Changed only files it was allowed to', testsProtected: "Didn't edit tests it doesn't own",
  protectedDirs: 'Left protected folders alone', merge: 'Fit cleanly on top of the latest main', tests: 'All tests pass, hidden ones included',
  secrets: 'No secrets in the change', deps: 'Declared every dependency change', protectedPaths: 'Stayed out of protected paths',
  diffBudget: 'Small enough to check', trunkIntact: 'Main was untouched while its code ran',
  reviewedCommit: 'Landed the exact commit its reviewer read',
};
const VERDICT = {
  conflict: 'clashed with newer work', red: 'failed tests on top of the latest main', rejected: 'broke a rule',
  noop: 'was handed in empty', 'breaks-dependents': 'would have broken code that already landed', parked: 'needs a person',
  'review-blocked': 'was blocked by its reviewer',
};

/* ---------------- derived model from events ---------------- */
function model() {
  const agents = new Map(), forks = [], byIntent = new Map();
  let head = null;
  const A = (id) => { if (!agents.has(id)) agents.set(id, { id, current: null, last: 0, trail: [], note: null }); return agents.get(id); };
  for (const e of S.events) {
    if (e.intent) { if (!byIntent.has(e.intent)) byIntent.set(e.intent, []); byIntent.get(e.intent).push(e); }
    if (e.type === 'trunk.head') head = { ...e.data, ts: e.ts };
    if (e.type === 'claim.started' && e.data?.fork) forks.push({ fork: e.data.fork, kind: e.data.kind, intent: e.intent, agent: e.agent, ts: e.ts });
    if (!e.agent) continue;
    const a = A(e.agent); a.last = Math.max(a.last, e.ts);
    const addTrail = (kind) => { if (e.intent && !a.trail.some((t) => t.intent === e.intent && t.kind === kind)) a.trail.push({ intent: e.intent, kind }); };
    switch (e.type) {
      case 'intent.proposed': addTrail('proposed'); break;
      case 'claim.started': a.current = { intent: e.intent, kind: e.data?.kind, since: e.ts, claim: e.claim }; a.note = null; addTrail(e.data?.kind || 'author'); break;
      case 'claim.expired': if (!a.current || a.current.claim === e.claim) a.current = null; a.note = { text: `Stopped responding while on ${title(e.intent)}`, ts: e.ts, intent: e.intent }; break;
      case 'claim.released': if (!a.current || a.current.claim === e.claim) a.current = null; break;
      case 'submit.received': if (a.current && a.current.claim === e.claim) a.current = null; a.note = { text: `Handed in ${title(e.intent)}`, ts: e.ts, intent: e.intent }; break;
      case 'review.passed': case 'review.blocked': if (a.current && a.current.claim === e.claim) a.current = null; a.note = { text: `${e.type === 'review.passed' ? 'Passed' : 'Blocked'} ${title(e.intent)} in review`, ts: e.ts, intent: e.intent }; break;
      case 'examine.done': if (a.current && a.current.claim === e.claim) a.current = null; a.note = { text: `Wrote hidden tests for ${title(e.intent)}`, ts: e.ts, intent: e.intent }; break;
      case 'land.landed': if (a.current && a.current.claim === e.claim) a.current = null; break;
    }
  }
  return { agents: [...agents.values()], forks, byIntent, head };
}

/* ---------------- plain-English events ---------------- */
const jobLink = (id) => html`<a class="link" href="${BASE}/jobs/${encodeURIComponent(id)}"><b>${title(id)}</b></a>`;
function evText(e) {
  const d = e.data || {}, J = e.intent ? jobLink(e.intent) : '', who = agentLabel(e.agent);
  switch (e.type) {
    case 'repo.ready': return d.created ? { h: html`The project was connected` } : null;
    case 'intent.proposed': return { h: html`${who} registered a job: ${J}`, why: d.validity?.failsOnTrunk ? `Its tests fail on main today, as they should` : '' };
    case 'intent.rejected': return { h: html`A job was turned away${e.intent ? html`: ${J}` : ''}`, why: reasonText(d.reason), attn: 1 };
    case 'intent.parked': return { h: html`${J} was parked. It needs a person.`, attn: 1 };
    case 'intent.overlap': return { h: html`${who} was told another job already changes the same files: ${J}`, why: (d.with || []).map((o) => title(o.job)).join(', ') };
    case 'intent.approved': return { h: html`A person approved ${J} past a check`, why: 'for that exact commit; an agent still reviews it' };
    case 'intent.dropped': return { h: html`A person dropped ${J}` };
    case 'examine.queued': return { h: html`An examiner was asked for hidden tests for ${J}` };
    case 'review.queued': return { h: html`Every check passed. ${J} now waits for a reviewer to read the diff`, why: d.mode === 'advisory' ? 'Advisory review: findings are recorded, a block does not stop it' : 'An agent that did not write it must pass it' };
    case 'review.passed': return { h: html`${who} reviewed ${J} and passed it`, why: (d.findings || []).length ? plural(d.findings.length, 'note') + ' on the receipt' : '' };
    case 'review.blocked': return { h: html`${who} reviewed ${J} and blocked it`, why: (d.findings || []).slice(0, 2).map((f) => `${f.rule ? `rule ${f.rule}: ` : ''}${f.file}${f.line ? ':' + f.line : ''} (${f.severity}): ${f.reason}`).join(' · '), attn: 1 };
    case 'examine.done': return { h: html`The examiner wrote ${plural(d.tests ?? 0, 'hidden test file')} for ${J}`, why: 'Written from the goal alone, without seeing any code' };
    case 'claim.started': {
      const k = d.kind;
      if (k === 'examine') return { h: html`${who} started writing hidden tests for ${J}` };
      if (k === 'review') return { h: html`${who} started reviewing the diff of ${J}`, why: 'It did not write, rebuild or examine this job' };
      if (k === 'rederive') return { h: html`A fresh agent started rebuilding ${J} from its goal`, why: who, attn: 1 };
      if (k === 'build') return { h: html`${who} picked up ${J} to build`, why: 'one ticket of a larger ask, in its own copy of the repo' };
      if (k === 'dependent') return { h: html`An agent started rebuilding ${J} to fit a newer change`, why: who, attn: 1 };
      return { h: html`${who} started work on ${J}`, why: 'in its own copy of the repo' };
    }
    case 'claim.expired': return { h: html`${who} stopped responding while working on ${J}`, why: 'Its claim lapsed. Nothing half-done reached main.', attn: 1 };
    case 'claim.released': return { h: html`${who} let go of ${J}` };
    case 'submit.received': return { h: html`${J} was handed in`, why: d.waitingForExaminer ? "Waiting for the examiner's hidden tests" : '' };
    case 'land.started': return { h: html`Checking ${J} on top of the latest main`, why: (d.together || []).length > 1 ? `Together with ${d.together.filter((x) => x !== e.intent).map(title).join(', ')}` : '' };
    case 'land.landed': return { h: html`${J} landed on main`, why: `${short(d.sha)} · ${plural(d.testsRun ?? 0, 'test')} pass · ${viaText(d.via).toLowerCase()}` };
    case 'gate.failed': return { h: html`${J} ${VERDICT[d.verdict] || 'was held back'}`, why: (d.failing || []).length ? `Failing: ${d.failing.join(', ')}` : (d.dependents || []).length ? `Affects ${d.dependents.map(title).join(', ')}` : '', attn: 1 };
    case 'rederive.queued': return { h: html`${J} will be rebuilt by a fresh agent`, why: reasonText(d.failure).replace(/^./, (c) => c.toUpperCase()), attn: 1 };
    case 'dependent.detected': return { h: html`${J} needs rebuilding to fit ${d.brokenBy ? title(d.brokenBy) : 'a newer change'}`, attn: 1 };
    case 'ask.planned': return { h: html`${who} turned an ask into ${plural((d.tickets || []).length, 'ticket')}`, why: `“${String(d.text || '').slice(0, 140)}${String(d.text || '').length > 140 ? '…' : ''}”` };
    case 'rules.updated': return { h: html`A person set the house rules (version ${d.version})`, why: `${plural(d.rules ?? 0, 'rule')}${d.reviewers ? ` · reviewed only by ${d.reviewers}` : ''}` };
    case 'trunk.head': return { h: d.green === false ? html`main is failing at <span class="mono">${short(d.sha)}</span>` : html`main is healthy at <span class="mono">${short(d.sha)}</span>`, why: d.testsRun != null ? `${plural(d.testsRun, 'test')} pass` : '', quiet: 1, attn: d.green === false };
    default: return null;
  }
}
// Same-millisecond events read better cause-first (the session lapsed, then the rebuild was queued).
const PRIO = { 'claim.expired': 0, 'gate.failed': 0, 'dependent.detected': 1, 'rederive.queued': 2 };
const byStory = (a, b) => a.ts - b.ts || (PRIO[a.type] ?? 1) - (PRIO[b.type] ?? 1) || a.seq - b.seq;
const visibleEvents = () => [...S.events].sort(byStory).map((e) => ({ e, t: evText(e) })).filter((x) => x.t);

/* ---------------- render shell ---------------- */
const view = $('#view');
function setConn(c) {
  S.conn = c;
  const el = $('#conn'); el.className = 'conn' + (c === 'on' ? ' on' : c === 'warn' || c === 'poll' ? ' warn' : '');
  $('#conn-t').textContent = { on: 'Live', warn: 'Reconnecting', poll: 'Updating every 5 s', connecting: 'Connecting', off: 'Offline' }[c] || c;
}
function shell() {
  $('#repo-name').textContent = REPO || 'Project';
  $('#repo-name').href = BASE;
  document.querySelectorAll('[data-route]').forEach((a) => { a.href = BASE + (a.dataset.route ? '/' + a.dataset.route : ''); });
  document.title = REPO ? `${REPO} · Project home` : 'Project home';
}
function setTab(t) { document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === t)); }
function paint(x) {
  // carry what's being typed in the approval-code fields (never kept anywhere else) and the focus across the re-render
  const keep = ['hr-code', 'decide-code'].map((id) => [id, document.getElementById(id)?.value]).filter(([, v]) => v);
  const focus = document.activeElement?.id;
  view.innerHTML = out(x);
  for (const [id, v] of keep) { const el = document.getElementById(id); if (el) el.value = v; }
  if (focus) { const el = document.getElementById(focus); if (el && el.focus) { el.focus(); if (typeof el.value === 'string' && el.setSelectionRange) try { el.setSelectionRange(el.value.length, el.value.length); } catch {} } }
}

function stateView(h1, ps, extra = '') {
  $('#tabs').hidden = true;
  paint(html`<section class="state">${h1 ? html`<h1>${h1}</h1>` : ''}${ps.map((p) => html`<p>${p}</p>`)}${extra}</section>`);
}
function showUnauthorised() {
  setConn('off');
  stateView('Sign in from your terminal', [
    html`Run <code>npx cinq-git open</code> on the machine where you deployed Cinq. It opens this page already signed in.`,
    html`<span class="faint">The sign-in lasts until you close this tab, so a bookmark won't sign you in. To come back, run <code>npx cinq-git open</code> again.</span>`,
  ]);
}
function showError(err) {
  stateView(`Couldn't load ${REPO}`, [err.status === 404 ? 'There is no project with this name, or it has been removed.' : err.message],
    html`<button class="btn" type="button" onclick="location.reload()">Try again</button>`);
}

/* ---------------- routing ---------------- */
function routeParts() { return location.pathname.split('/').filter(Boolean).slice(2).map(decodeURIComponent); }
function go(path, replace) {
  const url = BASE + (path ? '/' + path.split('/').map(encodeURIComponent).join('/') : '');
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  route();
}
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[href]');
  if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return;
  const href = a.getAttribute('href');
  if (href && (href === BASE || href.startsWith(BASE + '/'))) { ev.preventDefault(); history.pushState(null, '', href); route(); window.scrollTo(0, 0); }
});
addEventListener('popstate', route);

function route() {
  if (!S.booted) return;
  const [kind, ...rest] = routeParts();
  const p = rest.join('/');
  $('#tabs').hidden = false;
  if (!kind || kind === 'tree') { S.view = { name: 'code', dir: kind ? p : '' }; setTab('code'); renderCode(); }
  else if (kind === 'blob') { S.view = { name: 'file', path: p, mode: 'code' }; setTab('code'); renderFile(); }
  else if (kind === 'why') { S.view = { name: 'file', path: p || defaultWhyFile(), mode: 'why' }; setTab('why'); renderFile(); }
  else if (kind === 'live') { S.view = { name: 'live' }; setTab('live'); renderLive(); }
  else if (kind === 'rules') { S.view = { name: 'rules' }; setTab('rules'); renderRules(); }
  else if (kind === 'jobs') { S.view = { name: 'job', id: p || latestIntentId() }; setTab('jobs'); renderJob(); }
  else { S.view = { name: 'code', dir: '' }; setTab('code'); renderCode(); }
}
function latestIntentId() { return [...S.intents].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0]?.id || ''; }
function defaultWhyFile() {
  const files = S.tree?.files || [];
  const landed = [...S.intents].filter((i) => i.state === 'landed').sort((a, b) => (b.updated || 0) - (a.updated || 0));
  for (const it of landed) {
    const ev = S.events.find((e) => e.intent === it.id && e.type === 'intent.proposed');
    const f = (ev?.data?.allowed || []).find((x) => !S.tree || files.includes(x));
    if (f) return f;
  }
  return files.find((f) => /^src\//.test(f)) || files.find((f) => !f.startsWith('.')) || files[0] || '';
}

/* ---------------- 1. Code ---------------- */
function health(M) {
  const h = M.head;
  if (!h) return html`<span class="health"><span class="dot idle"></span>Nothing has landed yet</span>`;
  return h.green === false
    ? html`<span class="health"><span class="dot bad"></span>main is failing at <span class="mono">${short(h.sha)}</span></span>`
    : html`<span class="health"><span class="dot"></span>main is healthy · ${plural(h.testsRun ?? 0, 'test')} pass</span>`;
}
function dirEntries(dir) {
  const files = S.tree?.files || [], pre = dir ? dir + '/' : '', seen = new Map();
  for (const f of files) {
    if (!f.startsWith(pre)) continue;
    const restp = f.slice(pre.length), seg = restp.split('/')[0], isDir = restp.includes('/');
    const key = pre + seg;
    if (!seen.has(key)) seen.set(key, { path: key, name: seg, dir: isDir, count: 0 });
    if (isDir) seen.get(key).count++;
  }
  return [...seen.values()].sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
}
function entryNote(en) {
  if (en.path === '.cinq') return 'Goals and receipts, one per job';
  if (/^\.cinq\/intents$/.test(en.path)) return 'One file per job: goal, allowed files, tests';
  if (/^\.cinq\/receipts$/.test(en.path)) return 'What happened to each job';
  if (en.dir) return plural(en.count, 'file');
  const m = en.path.match(/^\.cinq\/(intents|receipts)\/(.+)\.(md|json)$/);
  if (m) { const it = intentById(m[2]); return it ? `${title(m[2])} · ${stateText(it.state).toLowerCase()}` : title(m[2]); }
  return '';
}
function platformNote(M) {
  const its = S.intents;
  if (!its.length) return html`
    <h2>No agent has worked here yet.</h2>
    <p>When an agent registers its first job, it appears here: what it set out to do, who did it, what was checked and how it reached main.</p>
    <p>Keep working in Claude Code as usual. Before anything can land, start the agents that examine, review and rebuild jobs, in a terminal in this repo: <code>npx cinq-git crew</code>.</p>`;
  const landed = its.filter((i) => i.state === 'landed'), parked = its.filter((i) => i.state === 'parked');
  const inflight = its.length - landed.length - parked.length;
  const asWritten = landed.filter((i) => !i.landed_via || i.landed_via === 'as-written').length;
  const rebuilt = landed.filter((i) => /^re-derived/.test(i.landed_via || ''));
  const together = landed.filter((i) => TOGETHER.test(i.landed_via || ''));
  const examined = new Set(S.events.filter((e) => e.type === 'examine.done').map((e) => e.intent)).size;
  const agents = M.agents.length;
  const notes = [];
  for (const it of rebuilt) {
    const q = S.events.filter((e) => e.intent === it.id && e.type === 'rederive.queued').pop();
    notes.push(html`<li>${jobLink(it.id)} was rebuilt by a fresh agent from its goal${q ? html` after ${reasonText(q.data?.failure)}` : ''}.</li>`);
  }
  for (const it of together) notes.push(html`<li>${jobLink(it.id)}: ${viaText(it.landed_via).toLowerCase()}.</li>`);
  for (const it of parked) notes.push(html`<li>${jobLink(it.id)} is parked and waiting for you: open it to approve, send back or drop it.</li>`);
  // examinations, reviews and rebuilds wait for crew agents; say so when they've waited a while
  const waiting = its.filter((i) => ['awaiting-examiner', 'awaiting-review', 'rederive', 'dependent', 'open'].includes(i.state) && Date.now() - (i.updated || 0) > 5 * 60_000);
  if (waiting.length) notes.push(html`<li>${plural(waiting.length, 'job')} ${waiting.length === 1 ? 'has' : 'have'} waited over 5 minutes for a builder, an examiner, a reviewer or a rebuilder. If no crew is running, start one in this repo: <code>npx cinq-git crew</code>.</li>`);
  const healthy = M.head && M.head.green !== false;
  return html`
    <h2>${healthy ? 'Agents build this, check each other, and keep main working.' : 'Agents build this and check each other before anything reaches main.'}</h2>
    <p><b>${plural(its.length, 'job')}</b> so far, from ${plural(agents, 'agent')}: <b>${landed.length}</b> on main${inflight ? html`, <b>${inflight}</b> in progress` : ''}${parked.length ? html`, <b>${parked.length}</b> parked` : ''}.
      ${landed.length ? html`${asWritten} landed as written${rebuilt.length + together.length ? html`, and ${rebuilt.length + together.length} ${rebuilt.length + together.length === 1 ? 'was' : 'were'} fixed by other agents on the way` : ''}.` : ''}
      ${parked.length ? '' : html` <b>Nothing has needed a person.</b>`}</p>
    ${examined ? html`<p>An examiner agent wrote hidden tests for ${plural(examined, 'job')}, from the goal alone. The agents doing the work never saw them.</p>` : ''}
    ${notes.length ? html`<ul class="notes">${notes}</ul>` : ''}
    <dl class="where">
      <dt>.cinq/intents/</dt><dd>One file per job: the goal, the files it may change, and the tests that prove it.</dd>
      <dt>.cinq/receipts/</dt><dd>What happened to each job: which agent, what was checked, how it landed.</dd>
    </dl>
    <p style="margin:20px 0 0"><a class="link" href="${BASE}/why">See why any line is here</a> &nbsp;·&nbsp; <a class="link" href="${BASE}/live">Watch agents work</a></p>`;
}
function mdRender(src) {
  const lines = src.replace(/\r/g, '').split('\n'); let o = '', inCode = false, code = [], list = false, para = [];
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const flush = () => { if (para.length) { o += `<p>${inline(para.join(' '))}</p>`; para = []; } if (list) { o += '</ul>'; list = false; } };
  for (const l of lines) {
    if (/^```/.test(l)) { if (inCode) { o += `<pre>${esc(code.join('\n'))}</pre>`; code = []; inCode = false; } else { flush(); inCode = true; } continue; }
    if (inCode) { code.push(l); continue; }
    const h = l.match(/^(#{1,3})\s+(.*)/);
    if (h) { flush(); o += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
    const li = l.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (para.length) { o += `<p>${inline(para.join(' '))}</p>`; para = []; } if (!list) { o += '<ul>'; list = true; } o += `<li>${inline(li[1])}</li>`; continue; }
    if (!l.trim()) { flush(); continue; }
    para.push(l.trim());
  }
  if (inCode) o += `<pre>${esc(code.join('\n'))}</pre>`;
  flush();
  return raw(o);
}
function activityList(n) {
  const v = visibleEvents().filter((x) => !x.t.quiet).slice(-n).reverse();
  if (!v.length) return html`<div class="faint" style="font-size:13.5px">No activity yet.</div>`;
  return html`<ol class="act">${v.map(({ e, t }) => html`<li><span class="t" title="${stamp(e.ts)}">${ago(e.ts)}</span><span>${t.h}</span></li>`)}</ol>`;
}
async function renderCode() {
  const M = model(), dir = S.view.dir || '';
  const commits = S.log?.commits || [], last = commits[0];
  const entries = dirEntries(dir);
  const busy = M.agents.filter((a) => a.current).length;
  const lastTs = S.events.length ? S.events[S.events.length - 1].ts : null;
  const crumbs = dir ? html`<div class="dircrumbs"><a href="${BASE}">${REPO}</a>${dir.split('/').map((seg, i, arr) => html`<span class="faint">/</span>${i === arr.length - 1 ? html`<b>${seg}</b>` : html`<a href="${BASE}/tree/${arr.slice(0, i + 1).join('/')}">${seg}</a>`}`)}</div>` : '';
  const hasReadme = !dir && (S.tree?.files || []).find((f) => /^readme\.md$/i.test(f));
  paint(html`
  <div class="home">
    <div style="min-width:0">
      ${crumbs}
      <div class="bar">
        <span class="btn" role="img" aria-label="Branch main">${icon('branch')}main</span>
        <a class="stat" href="${BASE}/live">${icon('copy')}<b>${M.forks.length}</b> agent ${M.forks.length === 1 ? 'copy' : 'copies'}</a>
        ${S.log ? html`<span class="stat">${icon('history')}<b>${commits.length}</b> commits</span>` : ''}
        <span class="right">${health(M)}</span>
      </div>
      <section class="box" aria-label="Files">
        ${!S.tree ? html`<div class="empty">${icon('hold', 14)} ${S.gitDown ? "Files can't be shown right now because the repo storage is busy. Trying again every 15 seconds." : 'Reading main… it follows any landing in progress.'} Jobs and live activity already work.</div>` : ''}
        ${last ? html`<div class="latest">
          <span class="glyph">${icon(last.intent ? 'term' : 'history', 14)}</span>
          <span class="msg">${last.intent ? html`<b>An agent landed <a class="link" href="${BASE}/jobs/${encodeURIComponent(last.intent)}">${title(last.intent)}</a></b>` : html`<b>${last.author}</b> <span class="muted">· ${last.subject}</span>`}</span>
          <span class="mono faint" title="${stamp(last.at)}">${short(last.sha)} · ${ago(last.at)}</span></div>` : ''}
        ${entries.length ? entries.map((en) => html`<a class="frow" href="${BASE}/${en.dir ? 'tree' : 'blob'}/${en.path}">${icon(en.dir ? 'folder' : 'file')}<span class="nm">${en.name}</span><span class="cm">${entryNote(en)}</span><span class="tm"></span></a>`)
          : S.tree ? html`<div class="empty">This folder is empty.</div>` : ''}
      </section>
      ${!dir ? html`<section class="box readme" aria-label="How agents work here">
        <div class="hd">${icon('file')}<b style="font-weight:600">How agents work here</b><span class="tag">Written by the platform</span>${hasReadme ? '' : html`<span class="faint" style="margin-left:auto;font-size:12.5px">This repo has no README.md yet</span>`}</div>
        <div class="bd">${platformNote(M)}</div></section>
        ${hasReadme ? html`<section class="box readme"><div class="hd">${icon('file')}<b style="font-weight:600">${hasReadme}</b></div><div class="bd md" id="readme-body"><div class="skel" style="width:60%"></div><div class="skel"></div></div></section>` : ''}` : ''}
    </div>
    <aside class="side">
      <div>
        <h3>About</h3>
        <p>${REPO}, hosted on Cloudflare Artifacts.</p>
        <ul class="facts">
          ${M.head ? html`<li>${icon('shield', 14)}${plural(M.head.testsRun ?? 0, 'test')}, ${M.head.green === false ? 'some failing' : 'all passing'}</li>` : ''}
          ${S.tree ? html`<li>${icon('receipt', 14)}${plural((S.tree?.files || []).filter((f) => /^\.cinq\/receipts\//.test(f)).length, 'receipt')}, one per landed job</li>` : ''}
          <li>${icon('term', 14)}${plural(M.agents.length, 'agent')} have worked here</li>
          ${S.tree?.head ? html`<li>${icon('branch', 14)}main at <span class="mono">${short(S.tree.head)}</span></li>` : ''}
        </ul>
      </div>
      <div>
        <h3>Agent activity <a class="more" href="${BASE}/live">Watch</a></h3>
        <div class="replaynote"><span class="dot ${busy ? '' : 'idle'}"></span>${busy ? `${plural(busy, 'agent')} working now` : lastTs ? `Nobody is working right now. Last activity ${ago(lastTs)}.` : 'Nobody has worked here yet.'}</div>
        ${activityList(5)}
      </div>
      ${M.forks.length ? html`<div>
        <h3>Agent copies <span class="more">${M.forks.length}</span></h3>
        <ul class="copies">${[...M.forks].reverse().slice(0, 6).map((f) => html`<li><span class="mono" title="${f.fork}">${f.fork}</span><span class="faint">${{ author: 'first attempt', rederive: 'rebuild', dependent: 'rebuild to fit' }[f.kind] || f.kind}</span></li>`)}
        ${M.forks.length > 6 ? html`<li><span class="faint">and ${M.forks.length - 6} more</span></li>` : ''}</ul></div>` : ''}
    </aside>
  </div>`);
  if (hasReadme) {
    try { const f = await getFile(hasReadme); const el = $('#readme-body'); if (el) el.innerHTML = out(mdRender(f.content)); }
    catch { const el = $('#readme-body'); if (el) el.innerHTML = '<p class="faint">The README could not be loaded.</p>'; }
  }
}

/* ---------------- 2. Live ---------------- */
const KIND_VERB = { build: 'Building', author: 'Writing', rederive: 'Rebuilding from the goal:', dependent: 'Rebuilding to fit a change:', examine: 'Writing hidden tests for' };
function rulesBox() {
  const ev = S.events;
  const count = (f) => ev.filter(f).length;
  const rows = [
    ['Don\'t hand in nothing', count((e) => e.type === 'gate.failed' && e.data?.verdict === 'noop')],
    ["Don't break anything that already works", count((e) => (e.type === 'gate.failed' && e.data?.verdict === 'breaks-dependents') || e.type === 'dependent.detected')],
    ["Don't edit tests you didn't write", count((e) => e.type === 'gate.failed' && e.data?.gates && e.data.gates.testsProtected === false)],
    ["Don't touch files outside your job", count((e) => e.type === 'gate.failed' && e.data?.gates && e.data.gates.footprint === false)],
  ];
  return html`<section class="rules"><h2 class="sectionh">Rules no agent can talk its way past</h2><div class="box">${rows.map(([r, n]) => html`
    <div class="rule">${icon(n ? 'hold' : 'shield', 18)}<div><b>${r}</b><p>${n ? `Enforced ${plural(n, 'time')} in this project.` : 'No agent has needed stopping here yet.'}</p></div><span class="src"></span></div>`)}
    <div class="rule">${icon('eye', 18)}<div><b>No agent grades its own work</b><p>${count((e) => e.type === 'examine.done') ? `An examiner agent wrote hidden tests for ${plural(new Set(ev.filter((e) => e.type === 'examine.done').map((e) => e.intent)).size, 'job')} without seeing the code.` : 'Hidden tests come from an examiner agent that never sees the code.'}</p></div><span class="src"></span></div>
  </div></section>`;
}
function feedList() {
  const v = visibleEvents().reverse();
  if (!v.length) return html`<li><span></span><span class="faint">Nothing has happened yet. Agents' work shows up here as it happens.</span></li>`;
  let lastDay = null; const rows = [];
  for (const { e, t } of v) {
    const d = day(e.ts);
    if (d !== lastDay) { rows.push(html`<li style="background:var(--rail);padding-block:5px"><span></span><span class="label">${d}</span></li>`); lastDay = d; }
    const st = enter(e.seq);
    rows.push(html`<li class="${t.attn ? 'attn' : ''} ${st ? 'new' : ''}" style="${st || ''}"><span class="t" title="${stamp(e.ts)}">${clock(e.ts)}</span><span>${t.h}${t.why ? html`<span class="why">${t.why}</span>` : ''}</span></li>`);
  }
  return rows;
}
function renderLive() {
  const M = model();
  const its = S.intents;
  const working = its.filter((i) => !['landed', 'queued', 'landing', 'parked', 'rejected'].includes(i.state));
  const waiting = its.filter((i) => ['queued', 'landing'].includes(i.state));
  const landed = its.filter((i) => i.state === 'landed').sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const parked = its.filter((i) => i.state === 'parked');
  const agents = [...M.agents].sort((a, b) => (!!b.current - !!a.current) || b.last - a.last);
  const now = Date.now();
  const head = M.head;
  const card = (i) => html`<a class="card ${['parked', 'waiting-on-dependents', 'dependent', 'rederive'].includes(i.state) ? 'attn' : ''} ${enter('i:' + i.id) ? 'new' : ''}" style="${enter('i:' + i.id) || ''}" href="${BASE}/jobs/${encodeURIComponent(i.id)}"><div class="t">${title(i.id)}</div><div class="s">${i.state === 'landed' ? viaText(i.landed_via) : stateText(i.state)}</div></a>`;
  const col = (name, ic, list, empty) => html`<section><h2 class="sectionh">${icon(ic, 14)}${name} <span class="n">${list.length}</span></h2>${list.length ? list.map(card) : html`<div class="faint" style="font-size:13px;padding:6px 2px">${empty}</div>`}</section>`;
  paint(html`
  <div class="livehead">
    <h1>Agents at work</h1>
    <div class="now"><b>${plural(agents.filter((a) => a.current).length, 'agent')} working</b> · ${waiting.length} waiting to land · ${landed.length} of ${its.length} jobs on main &nbsp;·&nbsp; ${head ? (head.green === false ? html`main is failing at <span class="mono">${short(head.sha)}</span>` : html`main is healthy at <span class="mono">${short(head.sha)}</span> · ${plural(head.testsRun ?? 0, 'test')} pass`) : 'nothing has landed yet'}</div>
  </div>
  <div class="livegrid">
    <div style="min-width:0">
      ${asksBox()}
      <h2 class="sectionh" style="${S.events.some((e) => e.type === 'ask.planned') ? 'margin-top:28px' : ''}">Agents <span class="n">${agents.length}</span></h2>
      <div class="lanes">${agents.length ? agents.filter((a, k) => a.current || k < 12).map((a) => html`
        <div class="lane ${a.current ? 'busy' : ''} ${a.current && ['rederive', 'dependent'].includes(a.current.kind) ? 'attn' : ''}">
          <div class="who"><span class="glyph">${icon('term', 14)}</span><div style="min-width:0"><b>${agentLabel(a.id)}</b><div class="sub mono" title="${a.id}">${a.id}</div></div></div>
          <div style="min-width:0">
            ${a.current ? html`<div class="doing"><span class="dot" style="display:inline-block;margin-right:8px;vertical-align:1px"></span>${KIND_VERB[a.current.kind] || 'Working on'} <a class="link" href="${BASE}/jobs/${encodeURIComponent(a.current.intent)}"><b>${title(a.current.intent)}</b></a><div class="s">for ${dur(now - a.current.since)} · in its own copy of the repo</div></div>`
              : html`<div class="doing muted">Not working right now<div class="s">${a.note ? html`${a.note.text} · ${ago(a.note.ts)}` : `Last seen ${ago(a.last)}`}</div></div>`}
            ${a.trail.length ? html`<div class="trail">${a.trail.slice(-6).map((t) => html`<a href="${BASE}/jobs/${encodeURIComponent(t.intent)}">${icon({ proposed: 'ring', author: 'term', build: 'term', rederive: 'rebuilt', dependent: 'rebuilt', examine: 'eye', review: 'eye' }[t.kind] || 'ring', 12)}${{ proposed: 'Registered', author: 'Wrote', build: 'Built', rederive: 'Rebuilt', dependent: 'Rebuilt', examine: 'Examined', review: 'Reviewed' }[t.kind] || ''} ${title(t.intent)}</a>`)}</div>` : ''}
          </div>
        </div>`).concat(agents.filter((a, k) => !a.current && k >= 12).length ? [html`<div class="faint" style="font-size:13px;padding:6px 2px">and ${plural(agents.filter((a, k) => !a.current && k >= 12).length, 'more agent')} not working right now</div>`] : []) : html`<div class="box empty">No agents have connected yet. When your agent registers a job, it shows up here.</div>`}
      </div>
      <div class="statelanes">
        ${col('In progress', 'work', [...parked, ...working], 'Nothing in progress')}
        ${col('Waiting to land', 'ring', waiting, 'Nothing waiting')}
        ${col('On main', 'ok', landed, 'Nothing has landed yet')}
      </div>
      ${filesInPlay()}
      ${spendBox()}
      ${rulesBox()}
    </div>
    <section class="feed" aria-label="What happened">
      <div class="hd"><b style="font-weight:600">What happened</b><span class="faint" style="margin-left:auto;font-size:12.5px">newest first</span></div>
      <ol>${feedList()}</ol>
    </section>
  </div>`);
}

// Each ask a person gave their agent, and the tickets it became: who asked, and how far along it is.
function asksBox() {
  const asks = S.events.filter((e) => e.type === 'ask.planned').slice(-6).reverse();
  if (!asks.length) return '';
  return html`<section><h2 class="sectionh">${icon('jobs', 14)}Asks <span class="n">${S.events.filter((e) => e.type === 'ask.planned').length}</span></h2>
    <div class="asks">${asks.map((a) => { const ids = a.data?.tickets || []; const its = ids.map(intentById).filter(Boolean); const on = its.filter((i) => i.state === 'landed').length;
      const waiting = its.filter((i) => i.state === 'parked');
      return html`<div class="ask box ${waiting.length ? 'attn' : ''}"><div class="q">“${String(a.data?.text || '').slice(0, 220)}${String(a.data?.text || '').length > 220 ? '…' : ''}”</div>
        <div class="by faint">asked by <span class="mono">${a.agent}</span> · ${ago(a.ts)} · <b>${on} of ${ids.length}</b> on main${waiting.length ? html` · <b>${waiting.length} parked for a person</b>` : ''}</div>
        <div class="tix">${ids.map((id) => { const i = intentById(id); return html`<a href="${BASE}/jobs/${encodeURIComponent(id)}" title="${i ? stateText(i.state) : ''}">${icon(i ? stateIcon(i) : 'ring', 13)}${title(id)}</a>`; })}</div></div>`; })}</div></section>`;
}
// What the agents spent, measured by their own CLIs. The gates are code, so they spend nothing.
const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
function spendBox() {
  const u = S.usage; if (!u || !u.total?.sessions) return '';
  const roles = Object.entries(u.byRole || {}).filter(([r]) => r !== 'other').sort((a, b) => b[1].tokens - a[1].tokens);
  const label = { author: 'Writing', builder: 'Building tickets', rebuilder: 'Rebuilding', examiner: 'Hidden tests', reviewer: 'Reviews' };
  const max = Math.max(1, ...roles.map(([, v]) => v.tokens));
  return html`<section style="margin-top:28px"><h2 class="sectionh">${icon('receipt', 14)}What the agents spent</h2><div class="box spend">
    <div class="big"><b>${u.tokensPerLanded != null ? kTok(u.tokensPerLanded) : '—'}</b><span>tokens per change on main</span></div>
    <div class="big"><b>${kTok(u.total.tokens)}</b><span>tokens in ${plural(u.total.sessions, 'agent session')}${u.total.costUsd ? ` · $${u.total.costUsd.toFixed(2)}` : ''}</span></div>
    <ul>${roles.map(([r, v]) => html`<li><span>${label[r] || r}</span><span class="bar"><i style="width:${Math.max(2, (v.tokens / max) * 100)}%"></i></span><span class="mono">${kTok(v.tokens)}</span></li>`)}
      <li><span>Checks and landing</span><span class="bar"></span><span class="mono">0</span></li></ul>
    <p class="faint">Agents start a session only when the board has work for them, and the checks are code, not a model. Measured by each agent's own CLI.</p></div></section>`;
}
// Which open jobs change which files: two jobs on one file means whichever lands second is rebuilt on top.
function filesInPlay() {
  const open = S.intents.filter((i) => !['landed', 'rejected', 'satisfied', 'parked'].includes(i.state)); // as the server's overlaps()
  const byFile = new Map();
  for (const it of open) for (const f of it.files || []) { if (!byFile.has(f)) byFile.set(f, []); byFile.get(f).push(it); }
  const rows = [...byFile].sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0])).slice(0, 12);
  if (!rows.length) return '';
  return html`<section style="margin-top:28px"><h2 class="sectionh">${icon('ring', 14)}Files in play <span class="n">${byFile.size}</span></h2>
    <ul class="inplay">${rows.map(([f, jobs]) => html`<li class="${jobs.length > 1 ? 'attn' : ''}"><span class="mono">${f}</span><span>${jobs.length > 1 ? html`<b>${jobs.length} open jobs</b> <span class="faint">· whichever lands later is rebuilt on top</span><br>` : ''}${jobs.slice(0, 3).map((it, k) => html`${k ? ', ' : ''}<a class="link" href="${BASE}/jobs/${encodeURIComponent(it.id)}">${title(it.id)}</a>${it.holder ? html` <span class="faint mono">${it.holder}</span>` : ''}`)}${jobs.length > 3 ? html`<span class="faint">, and ${jobs.length - 3} more</span>` : ''}</span></li>`)}</ul></section>`;
}

/* ---------------- 3. File + why ---------------- */
async function getFile(path) {
  if (!S.files.has(path)) S.files.set(path, api(`file?path=${encodeURIComponent(path)}`).catch((e) => { S.files.delete(path); throw e; }));
  return S.files.get(path);
}
async function getBlame(path) {
  if (!S.blame.has(path)) S.blame.set(path, api(`blame?path=${encodeURIComponent(path)}`).catch((e) => { S.blame.delete(path); throw e; }));
  return S.blame.get(path);
}
async function getDetail(id) {
  if (!S.detail.has(id)) S.detail.set(id, api(`intents/${encodeURIComponent(id)}`).then((j) => j.intent).catch((e) => { S.detail.delete(id); throw e; }));
  return S.detail.get(id);
}
async function getReceipt(id) {
  if (!S.receipts.has(id)) S.receipts.set(id, api(`receipts/${encodeURIComponent(id)}`).catch(() => null));
  return S.receipts.get(id);
}
function hl(s, path) {
  if (!/\.(m?js|cjs|ts|tsx|jsx|json)$/.test(path)) return esc(s);
  let o = '', last = 0, m;
  const re = /(\/\/.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(import|from|export|function|const|let|var|return|if|else|for|of|in|throw|new|continue|break|typeof|async|await|class|extends|default|true|false|null|undefined)\b/g;
  while ((m = re.exec(s))) { o += esc(s.slice(last, m.index)) + `<span class="tk-${m[1] ? 'c' : m[2] ? 's' : 'k'}">${esc(m[0])}</span>`; last = re.lastIndex; }
  return o + esc(s.slice(last));
}
function treeNav(current) {
  const files = S.tree?.files || [], groups = new Map();
  for (const f of files) { const i = f.lastIndexOf('/'); const d = i < 0 ? '' : f.slice(0, i); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(f); }
  const dirs = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : (a.startsWith('.') - b.startsWith('.')) || a.localeCompare(b)));
  const mode = S.view.mode === 'why' ? 'why' : 'blob';
  return html`<nav class="tree" aria-label="Files">${dirs.map((d) => html`
    ${d ? html`<div class="dir">${icon('folder')}${d}</div>` : ''}
    ${groups.get(d).map((f) => html`<a class="${f === current ? 'on' : ''}" style="padding-left:${d ? 26 : 8}px" href="${BASE}/${mode}/${f}" title="${f}">${icon('file', 14)}${f.slice(d ? d.length + 1 : 0)}</a>`)}`)}</nav>`;
}
function groupKey(l) { return l.intent ? 'i:' + l.intent : 'c:' + (l.landedIn || l.commit); }
function groupLabel(l) {
  if (l.intent) { const it = intentById(l.intent); return { text: title(l.intent), ic: it ? viaIcon(it.landed_via) : 'ok' }; }
  return { text: 'Original code', ic: 'ring' };
}
async function renderFile() {
  const { path, mode } = S.view;
  if (!path) { paint(html`<div class="box empty">This project has no files yet.</div>`); return; }
  if (S.tree && !S.tree.files.includes(path)) { paint(html`<section class="state" style="margin-top:24px"><h1>No file at ${path}</h1><p>It may have been moved or removed. <a class="link" href="${BASE}">Back to the project</a></p></section>`); return; }
  const segs = path.split('/');
  const crumbs = html`<div class="crumbs"><a href="${BASE}">${REPO}</a>${segs.map((s, i) => html`<span class="faint">/</span>${i === segs.length - 1 ? html`<b>${s}</b>` : html`<a href="${BASE}/tree/${segs.slice(0, i + 1).join('/')}">${s}</a>`}`)}</div>`;
  const why = mode === 'why';
  const frame = (meta, body, panel) => html`${crumbs}
    <div class="fileview ${why ? '' : 'nopanel'}">
      ${treeNav(path)}
      <section class="box codebox" style="min-width:0">
        <div class="hd">
          <div class="seg" role="group" aria-label="View"><a class="${why ? 'on' : ''}" href="${BASE}/why/${path}">Why each line is here</a><a class="${why ? '' : 'on'}" href="${BASE}/blob/${path}">Code</a></div>
          <span class="faint" style="font-size:13px">${meta}</span>
          ${why ? html`<span class="faint" style="margin-left:auto;font-size:12.5px">Click a line to see the job behind it</span>` : ''}
        </div>
        <div class="code ${why ? '' : 'plain'}" id="code">${body}</div>
      </section>
      ${why ? html`<aside class="box panel" aria-live="polite"><div class="hd"><b style="font-weight:600">Why is this here?</b><span class="faint mono" id="p-lines" style="margin-left:auto"></span></div><div class="bd" id="why-panel">${panel || ''}</div></aside>` : ''}
    </div>`;
  const skel = html`<div style="padding:14px 16px">${[70, 90, 55, 80].map((w) => html`<div class="skel" style="width:${w}%"></div>`)}</div>`;
  paint(frame('Loading…', skel, skel));
  const token = S.view;
  let lines;
  try {
    if (why) lines = (await getBlame(path)).lines;
    else lines = (await getFile(path)).content.replace(/\r/g, '').split('\n').map((text, i) => ({ n: i + 1, text })).filter((l, i, a) => !(i === a.length - 1 && l.text === ''));
  } catch (e) {
    if (e.status === 401) return showUnauthorised();
    if (S.view !== token) return;
    paint(frame('', html`<div class="empty">This file couldn't be loaded. ${e.message}${e.status === 503 ? ' Try again in a minute.' : ''}</div>`, ''));
    return;
  }
  if (S.view !== token) return;
  const jobs = new Set(lines.filter((l) => l.intent).map((l) => l.intent));
  const meta = `${plural(lines.length, 'line')}${why ? ` · ${jobs.size ? 'shaped by ' + plural(jobs.size, 'job') : 'all original code'}` : ''}`;
  const rows = lines.map((l, i) => {
    const first = why && (i === 0 || groupKey(lines[i - 1]) !== groupKey(l));
    const g = why ? groupLabel(l) : null;
    return html`<div class="ln ${first ? 'first' : ''}" data-g="${why ? groupKey(l) : ''}" data-i="${i}"><span class="why">${first ? html`${icon(g.ic, 12)}${g.text}` : ''}</span><span class="no">${l.n}</span><span class="src">${raw(hl(l.text, path) || ' ')}</span></div>`;
  });
  paint(frame(meta, rows, ''));
  if (!why) return;
  const code = $('#code');
  const select = (key) => {
    const nums = [];
    code.querySelectorAll('.ln').forEach((r) => { const on = r.dataset.g === key; r.classList.toggle('sel', on); if (on) nums.push(+r.querySelector('.no').textContent); });
    $('#p-lines').textContent = nums.length ? (nums.length > 1 ? 'lines ' : 'line ') + ranges(nums) : '';
    const sample = lines.find((l) => groupKey(l) === key);
    whyPanel(sample, token);
  };
  code.addEventListener('click', (ev) => { const r = ev.target.closest('.ln'); if (r) select(r.dataset.g); });
  select(groupKey(lines.find((l) => l.intent) || lines[0]));
}
function ranges(a) { const o = []; let s = a[0], p = a[0]; for (let i = 1; i <= a.length; i++) { if (a[i] === p + 1) { p = a[i]; continue; } o.push(s === p ? s : `${s}–${p}`); s = p = a[i]; } return o.join(', '); }
async function whyPanel(l, token) {
  const el = $('#why-panel'); if (!el || !l) return;
  if (!l.intent) {
    const c = (S.log?.commits || []).find((x) => x.sha && l.landedIn && (x.sha.startsWith(l.landedIn) || l.landedIn.startsWith(x.sha)));
    el.innerHTML = out(html`<span class="pill plain" style="align-self:flex-start">${icon('ring', 12)}Original code</span>
      <h3>These lines were here before agents worked on them</h3>
      <dl class="kv">${c ? html`<dt>Commit</dt><dd>${c.subject}</dd><dt>By</dt><dd>${c.author}</dd><dt>When</dt><dd>${stamp(c.at)}</dd>` : ''}<dt>Sha</dt><dd class="mono">${short(l.landedIn || l.commit)}</dd></dl>
      <p class="faint" style="margin:0;font-size:13px">No job or receipt is attached, because a person or an import wrote them, not an agent working through this platform.</p>`);
    return;
  }
  el.innerHTML = out(html`<div class="skel" style="width:50%"></div><div class="skel"></div><div class="skel" style="width:80%"></div>`);
  let d = null;
  try { d = await getDetail(l.intent); } catch (e) { if (e.status === 401) return showUnauthorised(); }
  if (S.view !== token || !$('#why-panel')) return;
  const it = d || intentById(l.intent) || { id: l.intent };
  const evs = S.events.filter((e) => e.intent === l.intent);
  const landEv = evs.filter((e) => e.type === 'land.landed').pop();
  const claim = landEv && evs.find((e) => e.type === 'claim.started' && e.claim === landEv.claim);
  const gates = d?.receipt?.gates || {};
  const passed = Object.keys(GATE).filter((k) => gates[k] === true).length;
  $('#why-panel').innerHTML = out(html`
    <span class="pill ok" style="align-self:flex-start">${icon(viaIcon(it.landed_via), 12)}${it.state === 'landed' ? viaText(it.landed_via) : stateText(it.state)}</span>
    <h3>${title(l.intent)}</h3>
    ${it.goal ? html`<p class="goal">${it.goal}</p>` : ''}
    <dl class="kv">
      <dt>Job</dt><dd class="mono">${l.intent}</dd>
      <dt>Written by</dt><dd>${landEv ? html`${agentLabel(landEv.agent)} <span class="mono faint">${landEv.agent}</span>` : agentLabel(it.author)}</dd>
      ${it.author && landEv && landEv.agent !== it.author ? html`<dt>Asked by</dt><dd>${agentLabel(it.author)} <span class="mono faint">${it.author}</span></dd>` : ''}
      ${claim?.data?.fork ? html`<dt>Copy</dt><dd class="mono">${claim.data.fork}</dd>` : ''}
      ${claim && landEv ? html`<dt>Work</dt><dd>${dur(landEv.ts - claim.ts)} from start to main</dd>` : ''}
      <dt>Landed</dt><dd><span class="mono">${short(l.landedIn)}</span>${landEv ? html` · ${stamp(landEv.ts)}` : ''}</dd>
      ${passed ? html`<dt>Checks</dt><dd>${passed} of ${Object.keys(GATE).filter((k) => k in gates).length} passed${d?.receipt?.testsRun ? ` · ${d.receipt.testsRun} tests` : ''}</dd>` : ''}
      ${d?.hiddenTests ? html`<dt>Hidden tests</dt><dd>${plural(d.hiddenTests, 'file')} from the examiner</dd>` : ''}
      <dt>Receipt</dt><dd class="mono">.cinq/receipts/${l.intent}.json</dd>
    </dl>
    <a class="btn" href="${BASE}/jobs/${encodeURIComponent(l.intent)}" style="align-self:flex-start">Read what happened</a>`);
}

/* ---------------- House rules ---------------- */
// The bar every review is held to. A person writes it; agents cite it; receipts record which version applied.
async function renderRules() {
  const token = S.view;
  if (!S.rules) { paint(html`<article class="rulespage"><h1>House rules</h1><div class="skel" style="width:50%"></div><div class="skel"></div></article>`);
    try { S.rules = await api('rules'); } catch (e) { if (e.status === 401) return showUnauthorised(); if (S.view !== token) return; paint(html`<section class="state"><h1>House rules</h1><p>${e.message}</p></section>`); return; } }
  // this repo's own protected paths, from .cinq/config.json on main (they replace the defaults, as the lander reads them)
  if (S.repoCfg === undefined) { try { S.repoCfg = JSON.parse((await getFile('.cinq/config.json')).content); } catch { S.repoCfg = null; } }
  if (S.view !== token) return;
  const hr = S.rules;
  const own = Array.isArray(S.repoCfg?.protectedPaths) ? S.repoCfg.protectedPaths : null;
  // the files the reviewer reads as the repo's own guidelines (GUIDE in app/worker/src/lander/server.cjs)
  const guides = (S.tree?.files || []).filter((f) => /(^|\/)(REVIEW|AGENTS|CLAUDE|BUGBOT|CONTRIBUTING|ARCHITECTURE|STYLEGUIDE|CONVENTIONS)\.md$|(^|\/)docs\/(architecture|adr|decisions)[^/]*\.md$/i.test(f));
  const cited = S.events.filter((e) => e.type === 'review.rules').reduce((m, e) => { for (const n of e.data?.cited || []) if (e.data.version === hr.version) m[n] = (m[n] || 0) + 1; return m; }, {});
  const blocks = S.events.filter((e) => e.type === 'review.blocked').length, passes = S.events.filter((e) => e.type === 'review.passed').length;
  paint(html`<article class="rulespage">
    <h1>House rules</h1>
    <p class="lede">You set the bar; agents hold every change to it. A reviewer that didn't write the change reads its diff against these rules, cites the rule a problem breaks, and blocks it. A different agent then rebuilds it. You only see what you said should come to you.</p>
    ${hr.version ? html`<div class="faint" style="font-size:13px;margin:-4px 0 14px">Version ${hr.version} · set ${hr.at ? ago(hr.at) : ''} · <span class="mono" title="${hr.hash}">sha256 ${String(hr.hash).slice(0, 12)}</span> · ${plural(passes, 'review')} passed, ${blocks} blocked so far</div>` : ''}
    <ol class="hrules box">${hr.rules.length ? hr.rules.map((r, i) => html`<li><span class="num">${i + 1}</span><span>${r}</span><span class="faint">${cited[i + 1] ? `cited ${plural(cited[i + 1], 'time')}` : ''}</span></li>`)
      : html`<li class="faint" style="display:block">No rules yet: reviewers use their own judgement. Write the few things your team always checks for.</li>`}</ol>
    <div class="hrmeta">
      <div class="box"><b>Who reviews</b><p>${hr.reviewers ? html`Only agents matching <span class="mono">${hr.reviewers}</span>. Other agents build, examine and rebuild.` : 'Any agent that didn\'t write, rebuild or examine the change.'}</p></div>
      <div class="box"><b>Every review also checks</b><p><b>Spec</b>: it does what was asked, no less and no more. <b>Standards</b>: it meets your house rules, fits the code around it and your review guides below. <b>Lean</b>: no redundant tests, dead code, one-caller abstractions or narrating comments; a block there is fixed by deleting.</p></div>
      <div class="box"><b>What comes to you</b><p>Changes to protected paths (${own ? html`this repo's: ${own.map((g, i) => html`${i ? ', ' : ''}<span class="mono">${g}</span>`)}, from <span class="mono">.cinq/config.json</span>` : html`<span class="mono">.github/**</span>, <span class="mono">**/auth/**</span>, <span class="mono">.env*</span>, deploy config, or your own in <span class="mono">.cinq/config.json</span>`}), your review guides, jobs over the diff budget, new packages with install scripts, and anything blocked twice.</p></div>
    </div>
    <div class="box" id="guides" style="padding:12px 16px;margin-bottom:16px"><b>Your review guides</b>${guides.length
      ? html`<p>Every reviewer reads these on main, next to the house rules (nearest to the change first, about 30,000 characters in all):</p><ul>${guides.map((f) => html`<li><a class="mono" href="${BASE}/blob/${f}">${f}</a></li>`)}</ul>`
      : ''}<p>${guides.some((f) => /(^|\/)REVIEW\.md$/i.test(f)) ? 'Only a person can change them: an agent that does parks for you.' : html`Already have a code-review prompt? Commit it as <span class="mono">REVIEW.md</span> at the root of your repo. Every reviewer reads it next to these rules, and only a person can change it.`}</p></div>
    <details class="more box" id="rules-edit" ${hr.version && !S.drafts['hr-text'] ? '' : 'open'}><summary style="padding:12px 16px">${icon('chev', 12)}Change the house rules</summary><div class="in" style="padding:0 16px 16px">
      <label class="label" for="hr-text">One rule per line</label>
      <textarea id="hr-text" rows="${Math.max(5, hr.rules.length + 2)}" placeholder="Money is integer cents, never floats.&#10;Every new endpoint has a test for its error path.&#10;No new dependency without a one-line reason in the approach.">${S.drafts['hr-text'] ?? hr.rules.join('\n')}</textarea>
      <label class="label" for="hr-rev">Who reviews (an agent name pattern; empty for any agent)</label>
      <input id="hr-rev" value="${S.drafts['hr-rev'] ?? (hr.reviewers || '')}" placeholder="reviewer-*" autocomplete="off">
      <input id="hr-code" type="password" autocomplete="off" placeholder="Approval code (from when you deployed; lost it? npx cinq-git approval-code)">
      <div class="btns"><button class="btn" id="hr-save" type="button">Save as version ${hr.version + 1}</button></div>
      <p class="faint" id="hr-msg">Reviews that start after you save are held to the new version. Same from a terminal: <code>npx cinq-git rules edit</code></p>
    </div></details>
  </article>`);
}
// The page re-renders as events arrive; what a person is typing survives it (never the approval code: it is not kept)
document.addEventListener('input', (ev) => { const id = ev.target?.id; if (['hr-text', 'hr-rev', 'decide-note'].includes(id)) S.drafts[id] = ev.target.value; });
document.addEventListener('click', async (ev) => {
  if (!ev.target.closest?.('#hr-save')) return;
  const msg = document.getElementById('hr-msg'), btn = document.getElementById('hr-save');
  const rules = document.getElementById('hr-text').value.split('\n').map((l) => l.trim().replace(/^(\d+[.)]|[-*])\s*/, '')).filter(Boolean);
  const reviewers = document.getElementById('hr-rev').value.trim() || null, code = document.getElementById('hr-code').value.trim();
  if (!code) { msg.textContent = 'Enter your approval code to save.'; return; }
  btn.disabled = true;
  try { S.rules = await apiPost('rules', { rules, reviewers, code }); delete S.drafts['hr-text']; delete S.drafts['hr-rev']; renderRules(); }
  catch (e) { msg.textContent = e.status === 401 ? 'Only the owner can change the house rules.' : e.message; btn.disabled = false; }
});

/* ---------------- 4. Job story ---------------- */
function storyStep(e, d, given) {
  const x = e.data || {}, who = agentLabel(e.agent);
  const T = (h, p, ic, more) => ({ e, h, p, ic, more });
  switch (e.type) {
    case 'intent.proposed': return T('The job was registered',
      html`${who} set the goal, the files it may change, and ${plural((x.tests || []).length, 'test file')}.${x.validity?.failsOnTrunk ? html` The platform checked that <b>these tests fail on main today</b>, so passing them proves something.` : ''}`, 'ring',
      d ? html`<div class="faint" style="font-size:13px">May change: ${(d.allowed || x.allowed || []).map((f, i) => html`${i ? ', ' : ''}<span class="mono">${f}</span>`)}</div>${Object.entries(d.tests || {}).map(([p, c]) => html`<pre><span class="h">${p}</span>\n${c.trimEnd()}</pre>`)}` : '');
    case 'examine.queued': return T('An examiner was asked for hidden tests', 'A separate agent writes extra tests from the goal alone. It never sees the code.', 'eye');
    case 'claim.started':
      if (x.kind === 'examine') return T('The examiner started', html`${who} <span class="mono faint">${e.agent}</span>`, 'eye');
      if (x.kind === 'review') return T('A reviewer started reading the diff', html`${who} <span class="mono faint">${e.agent}</span> did not write, rebuild or examine this job.`, 'eye');
      if (x.kind === 'rederive') return T('A fresh agent started over from the goal', html`${who} <span class="mono faint">${e.agent}</span> got the goal and the tests, but not the first attempt's work.`, 'rebuilt', x.fork ? html`<div class="faint mono">copy ${x.fork}</div>` : '');
      if (x.kind === 'build') return T('Another agent picked it up to build', html`${who} <span class="mono faint">${e.agent}</span> got the ticket, its tests and the whole ask it came from.`, 'term', x.fork ? html`<div class="faint mono">copy ${x.fork}</div>` : '');
      if (x.kind === 'dependent') return T('An agent started rebuilding it to fit a newer change', html`${who} <span class="mono faint">${e.agent}</span>`, 'rebuilt', x.fork ? html`<div class="faint mono">copy ${x.fork}</div>` : '');
      return T('An agent started work in its own copy', html`${who} <span class="mono faint">${e.agent}</span>`, 'term', x.fork ? html`<div class="faint mono">copy ${x.fork}</div>` : '');
    case 'review.queued': return T('Every check passed; it waited for a review', x.mode === 'advisory' ? 'Advisory: the reviewer\'s findings are recorded but cannot stop it.' : 'An agent that did not write it had to read the diff and pass it.', 'eye');
    case 'review.passed': return T('The reviewer passed it', (x.findings || []).length ? `${plural(x.findings.length, 'note')}, kept on the receipt.` : 'No findings.', 'ok');
    case 'review.blocked': return T('The reviewer blocked it', x.mode === 'advisory' ? 'Advisory review, so it went on to land anyway.' : 'It went back to be rebuilt with the findings.', 'hold',
      (x.findings || []).length ? html`<ul class="checks">${x.findings.map((f) => html`<li><span><span class="mono">${f.file}${f.line ? ':' + f.line : ''}</span> · ${f.severity} · ${f.reason}</span></li>`)}</ul>` : '');
    case 'examine.done': return T(`The examiner wrote ${plural(x.tests ?? 0, 'hidden test file')}`, "The agent doing the work never sees them. They run when the work is checked.", 'eye');
    case 'claim.expired': return T('The agent stopped responding', 'Its session went quiet, so its claim lapsed. Nothing it had half-done reached main.', 'hold');
    case 'claim.released': return T('The agent gave the job back', x.reason && x.reason !== 'released' ? html`<span class="mono faint">${e.agent}</span>: ${String(x.reason).replace(/^./, (c) => c.toUpperCase())}` : '', 'ring');
    case 'rederive.queued': return T('It was queued for a fresh agent', html`Because ${reasonText(x.failure)}. Nobody had to step in.`, 'hold');
    case 'submit.received': return T('The work was handed in', x.waitingForExaminer ? "It waited for the examiner's hidden tests before being checked." : '', 'ring');
    case 'land.started': return T('It was checked on top of the latest main', (x.together || []).length > 1 ? `Together with ${x.together.filter((t) => t !== e.intent).map(title).join(', ')}.` : 'All tests, hidden ones included, ran against main plus this change.', 'shield');
    case 'gate.failed': return T(`It ${VERDICT[x.verdict] || 'was held back'}`, html`${(x.failing || []).length ? html`Failing: ${x.failing.map((f, i) => html`${i ? ', ' : ''}<span class="mono">${f}</span>`)}. ` : ''}main was never touched.`, x.verdict === 'breaks-dependents' ? 'hold' : 'x',
      x.gates ? html`<ul class="checks">${Object.entries(x.gates).map(([k, v]) => html`<li>${icon(v ? 'ok' : 'x')}<span>${GATE[k] || k}</span></li>`)}</ul>` : '');
    case 'dependent.detected': return T(`It would have broken ${x.brokenBy ? title(x.brokenBy) : 'code that already landed'}`, (x.failing || []).length ? `Failing: ${x.failing.join(', ')}` : '', 'hold');
    case 'land.landed': {
      const gates = d?.receipt?.gates || {};
      return T('It landed on main', html`<span class="mono">${short(x.sha)}</span> · ${plural(x.testsRun ?? 0, 'test')} pass${(x.together || []).length > 1 ? html` · together with ${x.together.filter((t) => t !== e.intent).map(title).join(', ')}` : ''}.`, viaIcon(x.via),
        Object.keys(gates).length ? html`<ul class="checks">${Object.entries(gates).map(([k, v]) => html`<li>${icon(v ? 'ok' : 'x')}<span>${GATE[k] || k}</span></li>`)}</ul>` : '');
    }
    case 'intent.parked': { if (given?.has(x.failure?.reason)) return T('It was parked for a person', 'The agents could not build it honestly; the agent that gave it back says why.', 'hold');
      const why = x.failure?.reason && typeof x.failure.reason === 'string' ? x.failure.reason : x.reason; return T('It was parked for a person', why ? `${String(why).replace(/^./, (c) => c.toUpperCase()).replace(/\.?$/, '.')}` : 'Agents could not sort this out between themselves.', 'hold'); }
    case 'intent.overlap': return T('It was told about overlapping work', html`Other open jobs already change the same files: ${(x.with || []).map((o, i) => html`${i ? ', ' : ''}${title(o.job)} <span class="faint">(${(o.files || []).join(', ')})</span>`)}. Whichever lands second is rebuilt on top.`, 'ring');
    case 'intent.approved': return T('A person approved this commit', html`Past the ${GATE_TEXT[x.gate] ? GATE_TEXT[x.gate].replace(/^it /, '') : x.gate} check, for commit <span class="mono">${short(x.commit || '')}</span> only. An agent still reviews it.${x.note ? html` Note: “${x.note}”` : ''}`, 'ok');
    case 'intent.dropped': return T('A person dropped the job', x.note || 'Nothing from it reaches main.', 'x');
    case 'intent.rejected': return T('The job was turned away', reasonText(x.reason), 'x');
    default: return null;
  }
}
function storySummary(it, d, evs) {
  const ps = [];
  if (it.state === 'landed') {
    const landEv = evs.filter((e) => e.type === 'land.landed').pop();
    const via = it.landed_via || 'as-written';
    let s = `It landed on main ${landEv ? ago(landEv.ts) : ''} as ${short(it.landed_sha)}. `;
    if (/^re-derived/.test(via)) {
      const q = evs.filter((e) => e.type === 'rederive.queued').pop();
      s += `Its first attempt didn't make it${q ? `: ${reasonText(q.data?.failure)}` : ''}. A fresh agent rebuilt it from the goal, and that version landed.`;
    } else if (/^contract-change/.test(via)) {
      s += 'It changed a contract that landed code relied on, so that code was rebuilt by another agent to fit, and both landed together.';
    } else if (/^with-dependent/.test(via)) {
      s += 'A contract change it relied on would have broken it, so another agent rebuilt it to fit, and both landed together.';
    } else if (evs.some((e) => e.type === 'intent.approved')) s += 'It was parked at a security check, approved by a person for that exact commit, then reviewed by an agent and landed.';
    else if (via === 'built') s += 'It was one ticket of a larger ask; another agent built it, and every check passed.';
    else s += 'It went in as written. Every check passed the first time.';
    if (landEv?.data?.testsRun) s += ` ${landEv.data.testsRun} tests passed.`;
    ps.push(s);
  } else ps.push(`Right now it is ${stateText(it.state).toLowerCase()}.`);
  if (d?.hiddenTests) ps.push(`An examiner agent wrote ${plural(d.hiddenTests, 'hidden test file')} for it without seeing the code, so the agent that wrote it didn't grade its own work.`);
  const approved = evs.find((e) => e.type === 'intent.approved');
  const reviewedAfter = approved && evs.some((e) => e.type === 'review.passed' && e.seq > approved.seq);
  if (approved) ps.push(`A person approved it past one check (${GATE_TEXT[approved.data?.gate]?.replace(/^it /, '') || approved.data?.gate}), for that exact code; ${reviewedAfter ? 'an agent then reviewed it.' : 'an agent reviews it before it can land.'}`);
  else if (it.state !== 'parked') ps.push('Nobody had to step in.');
  return ps;
}
// A parked job waits for a person: approve (that exact commit, past the one gate it hit; an agent still reviews it),
// send it back to be rebuilt with a note, or drop it.
const GATE_TEXT = { protectedPaths: 'it changes a protected path', diffBudget: 'it is bigger than the diff budget', deps: 'it adds a package with install scripts' };
function decideBox(it) {
  const f = it.last_failure || {}, gate = f.verdict === 'parked' ? f.park?.gate : null, canApprove = !!GATE_TEXT[gate];
  const why = canApprove ? `It was parked because ${GATE_TEXT[gate]}${f.park?.reason ? ` (${f.park.reason})` : ''}.` : `It was parked because ${reasonText(f) || 'it could not land on its own'}.`;
  return html`<section class="decide box"><b>This job needs you</b><p>${why}</p>
    <textarea id="decide-note" rows="2" placeholder="A note for the agent that rebuilds it (optional)">${S.drafts['decide-note'] || ''}</textarea>
    ${canApprove ? html`<input id="decide-code" type="password" autocomplete="off" placeholder="Approval code, to approve (from when you deployed; lost it? npx cinq-git approval-code)">` : ''}
    <div class="btns">${canApprove ? html`<button class="btn" data-decide="approve" title="Land the commit that was parked; an agent still reviews it">Approve this commit</button>` : ''}
      <button class="btn" data-decide="retry">Send back to be rebuilt</button><button class="btn quiet" data-decide="drop">Drop the job</button></div>
    <p class="faint" id="decide-msg">Same from a terminal: <code>npx cinq-git decide ${it.id} ${canApprove ? 'approve|' : ''}retry|drop</code></p></section>`;
}
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest?.('[data-decide]'); if (!b || !S.view?.id) return;
  const action = b.dataset.decide, msg = document.getElementById('decide-msg');
  if (action === 'drop' && !confirm('Drop this job? Its work is not landed.')) return;
  document.querySelectorAll('[data-decide]').forEach((x) => (x.disabled = true));
  // approving needs the approval code, which only the person has (it is never stored on their machine)
  const code = action === 'approve' ? (document.getElementById('decide-code')?.value || '').trim() : '';
  if (action === 'approve' && !code) { msg.textContent = 'Enter your approval code to approve.'; document.querySelectorAll('[data-decide]').forEach((x) => (x.disabled = false)); return; }
  try {
    await apiPost(`intents/${encodeURIComponent(S.view.id)}/decide`, { action, note: document.getElementById('decide-note')?.value || '', code });
    S.detail.delete(S.view.id);
    const it = intentById(S.view.id); if (it) it.state = { approve: 'queued', retry: 'rederive', drop: 'rejected' }[action];
    renderJob();
  } catch (e) { msg.textContent = e.status === 401 ? 'Only the owner can decide a parked job.' : e.message; document.querySelectorAll('[data-decide]').forEach((x) => (x.disabled = false)); }
});

async function renderJob() {
  const id = S.view.id;
  const list = [...S.intents].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const joblist = html`<nav class="joblist" aria-label="Jobs"><div class="label" style="padding:0 10px 8px">${plural(list.length, 'job')} · newest first</div>
    ${list.map((i) => html`<a class="${i.id === id ? 'on' : ''}" href="${BASE}/jobs/${encodeURIComponent(i.id)}">${icon(stateIcon(i), 14)}<span>${title(i.id)}</span></a>`)}</nav>`;
  if (!id) { paint(html`<div class="jobview">${joblist}<section class="state" style="margin:0"><h1>No jobs yet</h1><p>When an agent registers a job, its story appears here: the goal, who worked on it, what was checked and how it landed.</p></section></div>`); return; }
  const token = S.view;
  const it0 = intentById(id);
  paint(html`<div class="jobview">${joblist}<article class="story"><h1>${it0 ? title(id) : id}</h1><div class="skel" style="width:40%"></div><div class="skel"></div><div class="skel" style="width:70%"></div></article></div>`);
  let d = null, rc = null;
  try { [d, rc] = await Promise.all([getDetail(id), getReceipt(id)]); }
  catch (e) {
    if (e.status === 401) return showUnauthorised();
    if (S.view !== token) return;
    paint(html`<div class="jobview">${joblist}<section class="state" style="margin:0"><h1>No job called ${id}</h1><p>${e.status === 404 ? 'It may have been removed.' : e.message}</p></section></div>`);
    return;
  }
  if (S.view !== token) return;
  const it = { ...(it0 || {}), ...d };
  const evs = S.events.filter((e) => e.intent === id).sort(byStory);
  const given = new Set(evs.filter((e) => e.type === 'claim.released').map((e) => e.data?.reason)); // reasons an agent already gave, shown once
  const steps = evs.map((e) => storyStep(e, d, given)).filter(Boolean);
  const claims = evs.filter((e) => e.type === 'claim.started');
  const role = { build: 'Agent that built it', author: 'Agent that wrote it', rederive: 'Agent that rebuilt it from the goal', dependent: 'Agent that rebuilt it to fit', examine: 'Examiner that wrote hidden tests', review: 'Reviewer that read the diff' };
  const people = claims.map((c) => {
    const end = evs.find((e) => e.claim === c.claim && ['submit.received', 'claim.expired', 'claim.released', 'examine.done', 'review.passed', 'review.blocked'].includes(e.type));
    const outcome = !end ? 'still working' : end.type === 'claim.expired' ? 'stopped responding' : end.type === 'examine.done' ? 'done' : end.type === 'review.passed' ? 'passed it' : end.type === 'review.blocked' ? 'blocked it' : end.type === 'submit.received' ? 'handed in' : 'let go';
    return html`<div class="whobox"><span class="glyph">${icon(['examine', 'review'].includes(c.data?.kind) ? 'eye' : 'term', 14)}</span><div style="min-width:0"><b>${role[c.data?.kind] || 'Agent'}</b><div class="sub">${agentLabel(c.agent)} · <span class="mono">${c.agent}</span></div><div class="sub">${outcome}${end ? ` after ${dur(end.ts - c.ts)}` : ''}</div></div></div>`;
  });
  const first = evs[0], landEv = evs.filter((e) => e.type === 'land.landed').pop();
  const pill = it.state === 'landed' ? html`<span class="pill ok">${icon(viaIcon(it.landed_via), 14)}${viaText(it.landed_via)}</span>`
    : it.state === 'parked' ? html`<span class="pill amber">${icon('hold', 14)}${stateText(it.state)}</span>` : html`<span class="pill plain">${icon(stateIcon(it), 14)}${stateText(it.state)}</span>`;
  const diff = it.last_diff ? html`<details class="more"><summary>${icon('chev', 12)}The last change handed in</summary><div class="in"><pre>${raw(String(it.last_diff).split('\n').map((l) => `<span class="${/^\+(?!\+\+)/.test(l) ? 'add' : /^-(?!--)/.test(l) ? 'del' : /^(@@|diff |index )/.test(l) ? 'h' : ''}">${esc(l)}</span>`).join('\n'))}</pre></div></details>` : '';
  paint(html`<div class="jobview">${joblist}
    <article class="story">
      ${pill}
      <h1>${title(id)}</h1>
      <div class="meta"><span class="mono">${id}</span>${it.landed_sha ? html`<span>·</span><span class="mono">${short(it.landed_sha)}</span>` : ''}${landEv ? html`<span>·</span><span>landed ${stamp(landEv.ts)}</span>` : ''}${first && landEv ? html`<span>·</span><span>${dur(landEv.ts - first.ts)} from start to main</span>` : ''}</div>
      <div class="summary">
        ${it.goal ? html`<p><span class="faint">Goal:</span> ${it.goal}</p>` : ''}
        ${d?.ask ? html`<p><span class="faint">Part of an ask by <span class="mono">${d.ask.agent}</span>:</span> “${d.ask.text.length > 400 ? d.ask.text.slice(0, 400) + '…' : d.ask.text}” <a class="link" href="${BASE}/live">See every ticket</a></p>` : ''}
        ${storySummary(it, d, evs).map((p) => html`<p>${p}</p>`)}
      </div>
      ${it.state === 'parked' ? decideBox(it) : ''}
      ${people.length ? html`<div class="people">${people}</div>` : ''}
      ${steps.length ? html`<ol class="steps">${steps.map((s) => html`<li>
        <span class="tm" title="${stamp(s.e.ts)}">${clock(s.e.ts)}</span><span class="ic">${icon(s.ic, 18)}</span>
        <div><h3>${s.h}</h3>${s.p ? html`<p>${s.p}</p>` : ''}
          ${s.more ? html`<details class="more"><summary>${icon('chev', 12)}Details</summary><div class="in">${s.more}</div></details>` : ''}</div></li>`)}</ol>`
        : html`<p class="faint" style="margin-top:28px">No events have been recorded for this job yet.</p>`}
      ${diff}
      ${reviewBlock(rc?.receipt?.review || d?.review)}
      <section class="receipt">
        <h2>Receipt</h2>
        ${rc?.receipt ? html`<div class="faint" style="margin-bottom:10px;font-size:13px">Kept in the repo at <span class="mono">.cinq/receipts/${id}.json</span></div>
          <details class="more"><summary>${icon('chev', 12)}Show the full receipt</summary><div class="in"><pre>${JSON.stringify(rc.receipt, null, 2)}</pre>${rc.engine ? html`<div class="label">What the checker recorded</div><pre>${JSON.stringify(rc.engine, null, 2)}</pre>` : ''}</div></details>`
          : html`<div class="faint" style="font-size:13px">A receipt is written into the repo when the job lands.</div>`}
      </section>
    </article></div>`);
}

// The reviewer's verdict and findings: from the receipt once landed, from the job while it's in review.
function reviewBlock(rv) {
  if (!rv || !rv.verdict) return rv?.state === 'needed' || rv?.state === 'claimed' ? html`<section class="receipt review"><h2>Review</h2><div class="faint" style="font-size:13px">Every check passed. ${rv.state === 'claimed' ? html`${agentLabel(rv.by)} is reading the diff.` : 'Waiting for an agent that did not write it to read the diff.'}</div></section>` : '';
  const f = rv.findings || [];
  return html`<section class="receipt review">
    <h2>Review</h2>
    <p style="margin:4px 0 10px">${rv.verdict === 'pass' ? html`<span class="pill ok">${icon('ok', 14)}Passed</span>` : html`<span class="pill amber">${icon('x', 14)}Blocked</span>`}
      <span class="faint" style="font-size:13px"> by ${agentLabel(rv.by)} · <span class="mono">${rv.by}</span>${(rv.houseRules || rv.rules)?.version ? html` · held to <a class="link" href="${BASE}/rules">house rules v${(rv.houseRules || rv.rules).version}</a>` : ''}${rv.mode === 'advisory' ? ' · advisory' : ''}${rv.commit || rv.sha ? html` · read <span class="mono">${short(rv.commit || rv.sha)}</span>` : ''}</span></p>
    ${f.length ? html`<ul class="checks">${f.map((x) => html`<li>${icon(['high', 'critical'].includes(x.severity) ? 'x' : 'eye', 14)}<span>${x.axis ? html`<b>${{ spec: 'Spec', standards: 'Standards', lean: 'Lean' }[x.axis]}</b> · ` : ''}${x.rule ? html`<b>Rule ${x.rule}</b> · ` : ''}<span class="mono">${x.file}${x.line ? ':' + x.line : ''}</span> · ${x.severity} · ${x.reason}</span></li>`)}</ul>` : html`<div class="faint" style="font-size:13px">No findings.</div>`}
  </section>`;
}

/* ---------------- live updates ---------------- */
let ws = null, wsFails = 0, pollTimer = null, refreshTimer = null;
function addEvents(list) {
  let added = false, touched = new Set(), headMoved = false;
  for (const e of list) {
    if (!e || typeof e.seq !== 'number' || e.seq <= S.lastSeq) continue;
    S.events.push(e); S.lastSeq = e.seq; added = true;
    S.arrived.set(e.seq, Date.now());
    if (e.intent) S.arrived.set('i:' + e.intent, Date.now());
    dispatchEvent(new CustomEvent('gl:event', { detail: e }));
    if (e.intent) touched.add(e.intent);
    if (e.type === 'trunk.head' || e.type === 'land.landed') headMoved = true;
  }
  if (!added) return;
  touched.forEach((id) => { S.detail.delete(id); S.receipts.delete(id); });
  if (headMoved) { S.blame.clear(); S.files.clear(); }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      const jobs = [api('intents')];
      if (headMoved) jobs.push(api('tree'), api('log'));
      if (headMoved || list.some((e) => e.type === 'usage.recorded')) api('usage').then((u) => { S.usage = u; if (S.view?.name === 'live') renderLive(); }).catch(() => {});
      if (list.some((e) => e.type === 'rules.updated')) S.rules = null;
      const [i, t, l] = await Promise.all(jobs);
      S.intents = i.intents || []; if (t) S.tree = t; if (l) S.log = l;
    } catch {}
    $('#n-jobs').textContent = S.intents.length || '';
    const v = S.view?.name;
    if (v === 'live' || v === 'code') route();
    else if (v === 'job' && touched.has(S.view.id)) route();
  }, 400);
  if (S.view?.name === 'live') renderLive();
}
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let u = `${proto}://${location.host}/ws/${encodeURIComponent(REPO)}?since=${S.lastSeq}`;
  // the key goes as a subprotocol (a header), never in the URL
  try { ws = KEY ? new WebSocket(u, ['cinq', `k.${KEY}`]) : new WebSocket(u); } catch { return startPolling(); }
  ws.onopen = () => { wsFails = 0; setConn('on'); stopPolling(); };
  ws.onmessage = (m) => {
    let d; try { d = JSON.parse(m.data); } catch { return; }
    const list = Array.isArray(d) ? d : Array.isArray(d.events) ? d.events : d.event ? [d.event] : [d];
    addEvents(list);
  };
  ws.onclose = () => {
    ws = null; wsFails++;
    if (wsFails >= 3) { startPolling(); setTimeout(connect, 30000); return; }
    setConn('warn'); setTimeout(connect, 1000 * 2 ** wsFails);
  };
  ws.onerror = () => {};
}
function startPolling() {
  if (pollTimer) return;
  setConn('poll');
  pollTimer = setInterval(async () => {
    try { const j = await api(`events?since=${S.lastSeq}`); addEvents(j.events || []); }
    catch (e) { if (e.status === 401) { stopPolling(); showUnauthorised(); } else setConn('off'); }
  }, 5000);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

/* ---------------- theme ---------------- */
(function theme() {
  const root = document.documentElement;
  try { const t = localStorage.getItem('gl.theme'); if (t) root.dataset.theme = t; } catch {}
  $('#theme').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('gl.theme', root.dataset.theme); } catch {}
  });
})();

/* ---------------- boot ---------------- */
// The most recent events only: the log grows without bound, and the live view needs the recent past.
async function loadAllEvents() { return (await api('events?tail=3000')).events || []; }
function retryGit() {
  setTimeout(async () => {
    try {
      const [t, l] = await Promise.all([api('tree'), api('log')]);
      S.tree = t; S.log = l; S.gitDown = false; S.files.clear(); S.blame.clear(); route();
    } catch (e) { if (e.status !== 401) retryGit(); }
  }, 15000);
}
async function boot() {
  shell();
  if (!REPO) { stateView('Open a project', [html`Run <code>npx cinq-git open</code> in your terminal: it opens your project's dashboard here, signed in.`, html`<span class="faint">No project yet? Run <code>npx cinq-git init</code> in a git repo first.</span>`]); setConn('off'); return; }
  try {
    // The board comes first; main's files are read by the lander, which may be busy landing, so they follow.
    const [intents, events] = await Promise.all([api('intents'), loadAllEvents()]);
    S.intents = intents.intents || [];
    S.events = events.sort((a, b) => a.seq - b.seq); S.lastSeq = S.events.length ? S.events[S.events.length - 1].seq : 0; S.bootSeq = S.lastSeq;
  } catch (e) {
    if (e.status === 401) return showUnauthorised();
    setConn('off');
    return showError(e);
  }
  S.booted = true;
  $('#n-jobs').textContent = S.intents.length || '';
  route();
  connect();
  api('usage').then((u) => { S.usage = u; if (S.view?.name === 'live') renderLive(); }).catch(() => {});
  Promise.all([api('tree'), api('log')]).then(([t, l]) => { S.tree = t; S.log = l; route(); })
    .catch((e) => { if (e.status === 401) return showUnauthorised(); S.gitDown = true; retryGit(); });
  setInterval(() => { if (S.view?.name === 'live') renderLive(); }, 30000); // keep "for 2 min" fresh
}
boot();
