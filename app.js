/* MTB Fitness 12-Week Home Programme - phone app (PWA)
 * Data lives in a private GitHub repo:  program.json, data/<person>.json, data/shared.json
 * Every record keeps a per-field timestamp map (_t) so phones and the PC sync script
 * merge field-by-field: newest edit wins, nothing else is overwritten.
 */
'use strict';
const APP_VERSION = '2.6.0';
const STRAVA_CLIENT_ID = '292465';
const INTRO_VIDEO = 'https://www.youtube.com/watch?v=lclyYasr43Y';
function introCard(full) {   // the booklet asks every new starter to watch this first
  return `<div class="card intro"><h3>▶ Start here: watch the intro video</h3>
    <p class="sub">It answers the 10 most common questions from people following the programme.</p>
    <a class="btn block" href="${INTRO_VIDEO}" target="_blank" rel="noopener">Watch on YouTube</a>
    ${full ? '' : `<button class="btn block sec small" data-introdone="1">I've watched it - hide this</button>`}</div>`;
}
const PROGRAM_VERSION = 2;   // program.json with gym plans
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* ---------------- storage ---------------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('mtb.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mtb.' + k, JSON.stringify(v)); } catch (e) { toast('Phone storage full or blocked'); } }
};
let cfg = LS.get('cfg', { owner: '', repo: 'mtb-fitness-data', token: '', me: '', api: 'https://api.github.com', restSec: 60 });
let P = LS.get('program', null);              // program definition
let D = LS.get('data', {});                   // { lynn:{...}, jarom:{...}, shared:{...} }
let shas = LS.get('shas', {});
let syncState = { busy: false, err: '', last: LS.get('lastSync', 0), dirty: LS.get('dirty', false) };

const people = () => (P?.people || ['Lynn', 'Jarom']).map(p => p.toLowerCase());
const me = () => cfg.me;
const partner = () => people().find(p => p !== cfg.me);
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const file = k => (D[k] ||= {});
const rec = (f, coll, key) => D[f]?.[coll]?.[key];
const val = (f, coll, key, field) => rec(f, coll, key)?.[field];

function setVal(f, coll, key, field, value) {
  if (value === '' || value === undefined) value = null;
  const F = file(f); const C = (F[coll] ||= {}); const R = (C[key] ||= { _t: {} });
  R._t ||= {};
  if (JSON.stringify(R[field] ?? null) === JSON.stringify(value)) return;
  R[field] = value; R._t[field] = Date.now();
  LS.set('data', D); syncState.dirty = true; LS.set('dirty', true); paintSync(); scheduleSync();
}

/* ---------------- merge ---------------- */
function mergeRec(a, b) {
  if (!a) return b; if (!b) return a;
  const out = { _t: {} }; const fields = new Set([...Object.keys(a._t || {}), ...Object.keys(b._t || {})]);
  for (const f of fields) {
    const ta = a._t?.[f] ?? -1, tb = b._t?.[f] ?? -1;
    const src = tb > ta ? b : a;
    out[f] = src[f] ?? null; out._t[f] = Math.max(ta, tb);
  }
  return out;
}
function mergeFile(A = {}, B = {}) {
  const out = {};
  for (const coll of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const a = A[coll], b = B[coll];
    if (typeof (a ?? b) !== 'object' || Array.isArray(a ?? b)) { out[coll] = b ?? a; continue; }
    out[coll] = {};
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) out[coll][k] = mergeRec(a?.[k], b?.[k]);
  }
  return out;
}
const stable = o => JSON.stringify(o, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((r, x) => (r[x] = v[x], r), {}) : v);

/* ---------------- GitHub ---------------- */
const b64enc = s => { const bytes = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));
async function gh(method, path, body) {
  const url = `${cfg.api.replace(/\/$/, '')}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
  const r = await fetch(url + (method === 'GET' ? `?t=${Date.now()}` : ''), {
    method, cache: 'no-store',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status === 404 && method === 'GET') return null;
  if (!r.ok) { const t = await r.text(); const e = new Error(`GitHub ${r.status}: ${t.slice(0, 140)}`); e.status = r.status; throw e; }
  return r.json();
}
async function ghGetJson(path) {
  const j = await gh('GET', path); if (!j) return { data: null, sha: null };
  let text;
  if (j.content) text = b64dec(j.content);
  else if (j.download_url) text = await (await fetch(j.download_url, { cache: 'no-store', headers: { Authorization: `Bearer ${cfg.token}` } })).text();
  return { data: JSON.parse(text), sha: j.sha };
}
async function ghPutJson(path, data, sha, msg) {
  const j = await gh('PUT', path, { message: msg, content: b64enc(JSON.stringify(data, null, 1)), ...(sha ? { sha } : {}) });
  return j.content.sha;
}

/* ---------------- sync ---------------- */
let syncTimer = null;
function scheduleSync(ms = 3000) { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(), ms); }
async function syncFile(key, writable) {
  const path = `data/${key}.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: remote, sha } = await ghGetJson(path);
    const local = D[key] || {};
    const merged = writable ? mergeFile(remote || {}, local) : (remote || {});
    if (writable && stable(merged) !== stable(remote || {})) {
      try {
        shas[key] = await ghPutJson(path, merged, sha, `${cap(me())} phone: update ${key}`);
      } catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
    } else shas[key] = sha;
    D[key] = merged; return;
  }
  throw new Error('Could not save after several tries (someone else was saving). Try again.');
}
async function syncNow(manual) {
  if (!configured()) { if (manual) location.hash = '#settings'; return; }
  if (syncState.busy) return;
  if (!navigator.onLine) { syncState.err = 'Offline - will sync when back online'; paintSync(); return; }
  syncState.busy = true; syncState.err = ''; paintSync();
  const before = stable(D);
  try {
    if (!P || (P.version || 1) < PROGRAM_VERSION) await loadProgram();
    await syncFile(me(), true);
    await syncFile('shared', true);
    if (partner()) await syncFile(partner(), false);
    await stravaSync();
    LS.set('data', D); LS.set('shas', shas);
    syncState.last = Date.now(); LS.set('lastSync', syncState.last);
    syncState.dirty = false; LS.set('dirty', false);
    if (manual) toast('Synced');
  } catch (e) { syncState.err = e.message; if (manual) toast(e.message); }
  syncState.busy = false; paintSync();
  if (stable(D) !== before) softRender();
}
async function loadProgram() {
  const { data } = await ghGetJson('program.json');
  if (!data) throw new Error('program.json not found in the repo. Run the PC sync script with --init first.');
  P = data; LS.set('program', P);
}
const configured = () => cfg.owner && cfg.repo && cfg.token && cfg.me;

/* ---------------- Strava ----------------
 * The phone never talks to Strava directly. It writes requests into its own data file and pokes
 * strava/kick/<me>.json; a GitHub Action in the data repo does the Strava work and reports back
 * in strava/state.json (read-only here). Garmin creates activities; the app links to them.
 */
let SV = LS.get('strava', null);
const sv = () => SV || {};
const stravaAthlete = (who = me()) => sv().athletes?.[who] || null;
const usesGarmin = (who = me()) => val(who, 'settings', 'main', 'garmin') ?? true;
const tOf = (f, coll, key, field) => rec(f, coll, key)?._t?.[field] || 0;
const stravaConnecting = () => { const t = tOf(me(), 'settings', 'main', 'stravaCode'); return t && t > (sv().handled?.[me()]?.code || 0); };
const stravaDisconnecting = () => { const t = tOf(me(), 'settings', 'main', 'stravaDisconnect'); return val(me(), 'settings', 'main', 'stravaDisconnect') && t > (sv().handled?.[me()]?.disconnect || 0); };
const sState = sid => sv().sessions?.[me()]?.[sid] || null;
const reqPending = sid => { const t = tOf(me(), 'stravaReq', sid, 'action'); return val(me(), 'stravaReq', sid, 'action') && t > (sState(sid)?.reqT || 0); };
function stravaKick(why) { LS.set('kick', why); scheduleSync(800); }
function stravaReq(sid, action) { setVal(me(), 'stravaReq', sid, 'action', null); setVal(me(), 'stravaReq', sid, 'action', action); stravaKick(action); }
async function stravaSync() {
  try { const { data } = await ghGetJson('strava/state.json'); if (data) { SV = data; LS.set('strava', SV); } } catch { }
  const why = LS.get('kick', ''); if (!why) return;
  try {
    const path = `strava/kick/${me()}.json`; const cur = await gh('GET', path);
    await ghPutJson(path, { t: Date.now(), why }, cur?.sha, `${cap(me())} phone: Strava ${why}`);
    LS.set('kick', '');
  } catch (e) { if (!(e.status === 409 || e.status === 422)) throw e; }
}
function stravaAuthUrl() {
  const redirect = location.origin + location.pathname;
  return `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&response_type=code&approval_prompt=auto&scope=read,activity:read_all,activity:write&redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(me() || 'x')}`;
}
function stravaAcceptCode(code, scope) {   // code from Strava's redirect (or pasted by hand)
  if (!/activity:write/.test(scope || '') || !/activity:read_all/.test(scope || '')) {
    toast('Please leave all the Strava permission boxes ticked'); return false;
  }
  setVal(me(), 'settings', 'main', 'stravaCode', `${code}|${scope}`); stravaKick('connect'); toast('Connecting to Strava… about a minute'); return true;
}
function handleStravaReturn() {   // runs once at start-up: did Strava just send us back here?
  const q = new URLSearchParams(location.search); if (!q.has('code') && !q.has('error')) return false;
  const code = q.get('code'), scope = q.get('scope') || '', err = q.get('error');
  history.replaceState(null, '', location.pathname + '#settings');
  if (err) { setTimeout(() => toast('Strava connection cancelled'), 300); return false; }
  if (configured()) { stravaAcceptCode(code, scope); return false; }
  // iPhone home-screen apps can come back in a separate Safari window that has no settings - hand the code over by copy/paste
  view().innerHTML = `<h1>Almost connected</h1><div class="card"><p>Strava sent this window back without your app settings (this happens on iPhone).</p>
    <p><b>1.</b> Copy this code: <input id="sc" readonly value="${esc(code + '|' + scope)}"></p><button class="btn block" id="scCopy">Copy code</button>
    <p class="mt"><b>2.</b> Close this window, open <b>MTB 12</b> from your home screen, go to ⚙ → Strava → <b>Paste a code</b>.</p></div>`;
  $('#scCopy').onclick = () => { $('#sc').select(); navigator.clipboard?.writeText($('#sc').value).then(() => toast('Copied'), () => toast('Select the code and copy it')); };
  return true;
}
const stravaLink = id => `<a href="https://www.strava.com/activities/${id}" target="_blank" rel="noopener">View on Strava</a>`;
function stravaStatus(sid) {   // the Strava line on a finished session
  if (!stravaAthlete() || !['Done', 'Partial'].includes(status(me(), sid))) return '';
  const st = sState(sid); const btns = (post = 'Post to Strava') => `<div class="grid2 mt"><button class="btn small strava" data-spost="${sid}">${post}</button><button class="btn small sec" data-sskip="${sid}">Skip</button></div>`;
  let body;
  if (reqPending(sid)) body = `<span class="sub">Sending to Strava… (about a minute)</span>`;
  else if (st?.state === 'linked') body = `✓ On Strava, added to your Garmin activity <b>${esc(st.name || '')}</b> · ${stravaLink(st.id)}`;
  else if (st?.state === 'posted') body = `✓ Posted to Strava · ${stravaLink(st.id)}`;
  else if (st?.state === 'skipped') body = `<span class="sub">Not on Strava (skipped).</span><div class="mt"><button class="btn small sec" data-spost="${sid}">Post to Strava anyway</button></div>`;
  else if (usesGarmin() && st?.state === 'waiting') body = `<span class="sub">Waiting for your Garmin to upload this to Strava - it's checked every hour. Only post it yourself if you didn't record it on the watch.</span>` + btns('Post it myself');
  else body = `<span class="sub">Not on Strava yet.</span>` + btns();
  return `<div class="card stravabox"><h3>Strava</h3><div class="mt">${body}</div></div>`;
}
function stravaPrompts() {   // Today: sessions that still need a Post / Skip decision
  if (!stravaAthlete()) return '';
  const out = [];
  for (const [sid, st] of Object.entries(sv().sessions?.[me()] || {})) {
    if (!['waiting', 'nomatch'].includes(st.state) || reqPending(sid) || !P._sess[sid]) continue;
    if (usesGarmin() && st.state === 'waiting' && Date.now() - (st.waitingSince || 0) < 864e5) continue;   // give the Garmin 24 h
    const s = P._sess[sid];
    out.push(`<div class="card stravabox"><h3>📤 ${s.type === 'HIIT' ? 'HIIT ' + s.n : 'Strength ' + s.n} (week ${s.week}) isn't on Strava</h3>
      <div class="sub">${usesGarmin() ? 'No Garmin activity turned up for ' + fmt(myDate(me(), sid)) + '.' : 'Done ' + fmt(myDate(me(), sid)) + '.'}</div>
      <div class="grid2 mt"><button class="btn small strava" data-spost="${sid}">Post to Strava</button><button class="btn small sec" data-sskip="${sid}">Skip</button></div></div>`);
  }
  return out.join('');
}
function stravaSettings() {
  const a = stravaAthlete(); const err = sv().errors?.[me()];
  let html = `<div class="card"><h3>Strava</h3>`;
  if (stravaDisconnecting()) html += `<p class="sub">Disconnecting… about a minute.</p>`;
  else if (stravaConnecting()) html += `<p class="sub">Connecting… about a minute. This updates on the next sync.</p>`;
  else if (a && !a.needsReconnect) html += `<p>Connected as <b>${esc(a.name || 'Strava athlete')}</b></p>`;
  else html += `<p class="sub">${a?.needsReconnect ? 'Strava access stopped working - connect again.' : 'Connect your own Strava account. Finished workouts are matched to your Garmin uploads (or posted when you tap Post), and outdoor rides are brought into Rides.'}</p>
    <a class="btn block strava" href="${esc(stravaAuthUrl())}">Connect with Strava</a>`;
  if (err) html += `<div class="warnbox">${esc(err)}</div>`;
  html += `<label class="row mt"><input type="checkbox" id="sGarmin" style="width:auto" ${usesGarmin() ? 'checked' : ''}><span>I record workouts on a Garmin (or another watch that uploads to Strava)</span></label>
    <div class="sub">On: the app waits for your watch's upload and adds the details to it. Off: you get a Post to Strava button straight away.</div>`;
  if (a && !stravaDisconnecting()) html += `<button class="btn block sec small" id="sStravaOff">Disconnect Strava</button>`;
  html += `<details class="mt"><summary class="sub">Paste a code (iPhone)</summary><input id="sCode" placeholder="code from the Almost connected page" autocapitalize="off" autocorrect="off"><button class="btn block sec small" id="sCodeGo">Use code</button></details>`;
  if (sv().updated) html += `<p class="sub mt">Strava last checked ${ago(sv().updated).replace('Synced', 'just now')}.</p>`;
  return html + `</div>`;
}

function paintSync() {
  const dot = $('#syncDot'), txt = $('#syncTxt');
  dot.className = syncState.busy ? 'busy' : syncState.err ? 'err' : syncState.dirty ? 'dirty' : syncState.last ? 'ok' : '';
  txt.textContent = syncState.busy ? 'Syncing' : syncState.err ? (syncState.err.startsWith('Offline') ? 'Offline' : 'Retry') : syncState.dirty ? 'Unsaved' : syncState.last ? ago(syncState.last) : 'Sync';
  $('#syncBtn').title = syncState.err || (syncState.last ? 'Last sync ' + new Date(syncState.last).toLocaleString() : 'Sync now');
}
const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'Synced' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };

/* ---------------- dates & program helpers ---------------- */
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const todayISO = () => iso(new Date());
const fmt = (s, o = { weekday: 'short', month: 'short', day: 'numeric' }) => s ? parseISO(s).toLocaleDateString(undefined, o) : '';
/* Each person has their own schedule (2.6): a start Monday plus weeks pushed back.
 * settings.main.startDate (any date - snapped to its Monday) and settings.main.push2..push12 = extra weeks inserted before that week. */
const monday = d => { const x = parseISO(d); return iso(addDays(x, -((x.getDay() + 6) % 7))); };
const startISO = (who = me()) => monday(val(who, 'settings', 'main', 'startDate') || val('shared', 'settings', 'main', 'startDate') || P.start_date);
const pushAt = (who, w) => +(val(who, 'settings', 'main', 'push' + w) || 0);
const pushedBefore = (who, w) => { let n = 0; for (let k = 2; k <= w; k++) n += pushAt(who, k); return n; };
const weekStart = (w, who = me()) => iso(addDays(parseISO(startISO(who)), (w - 1 + pushedBefore(who, w)) * 7));
const sessDate = (s, who = me()) => iso(addDays(parseISO(weekStart(s.week, who)), s.day_offset));
const progEnd = (who = me()) => iso(addDays(parseISO(weekStart(12, who)), 6));
// 0 = not started, 13 = finished; during a pushed-back (break) week it returns the upcoming week, with brk = true
function weekInfo(who = me(), d = todayISO()) {
  if (d < weekStart(1, who)) return { w: 0 };
  if (d > progEnd(who)) return { w: 13 };
  let w = 1; while (w < 12 && weekStart(w + 1, who) <= d) w++;
  return d > iso(addDays(parseISO(weekStart(w, who)), 6)) ? { w: w + 1, brk: true } : { w };
}
const curWeek = (who = me()) => weekInfo(who).w;
const clampW = w => Math.min(12, Math.max(1, w));
const exById = id => P._ex?.[id];
const plan = id => P._plans?.[id];
const interval = w => P.intervals.find(i => i.week === w);
function prep() {
  if (!P || P._ex) return;
  P._ex = Object.fromEntries(P.exercises.map(e => [e.id, e]));
  P._plans = Object.fromEntries(P.plans.map(p => [p.id, p]));
  P._sess = Object.fromEntries(P.sessions.map(s => [s.id, s]));
}
const isStr = s => s.type === 'Strength' || s.type === 'Bodyweight';
const defTrack = who => val(who, 'settings', 'main', 'defaultTrack') || 'Home';
const where = (who, s) => val(who, 'sessions', s.id, 'where') || defTrack(who);
const COLL = t => t === 'Gym' ? 'gsets' : 'sets';
const tIcon = t => t === 'Gym' ? '🏋️' : '🏠';
const setId = (s, pe, n, t) => t === 'Gym' ? `${s.id}-G-${pe.order}-S${n}` : `${s.id}-${pe.order}-S${n}`;
function setsFor(s, t = 'Home') {
  const out = []; const pl = plan(t === 'Gym' ? s.gym_plan_id : s.plan_id); if (!pl) return out;
  for (const pe of pl.exercises) for (let n = 1; n <= pe.sets; n++) out.push({ id: setId(s, pe, n, t), pe, n });
  return out;
}
const status = (who, sid) => val(who, 'sessions', sid, 'status');
// Each person has their own Date Done / Duration (v2.1). Older data kept one shared value - used only as a fallback.
const myDate = (who, sid) => val(who, 'sessions', sid, 'dateDone') ?? val('shared', 'sessions', sid, 'dateDone') ?? '';
function partnerDateNote(sid) {
  const pt = partner(); if (!pt) return '';
  const d = val(pt, 'sessions', sid, 'dateDone'); const st = status(pt, sid);
  if (!d && !st) return '';
  return `<div class="sub mt">${cap(pt)}: ${st ? esc(st) : 'in progress'}${d ? ' · ' + fmt(d) : ''}</div>`;
}
function chip(who, sid) {
  const st = status(who, sid) || '—'; const s = P._sess[sid];
  return `<span class="chip ${esc(st)} ${who === me() ? 'me' : ''}">${s && isStr(s) ? tIcon(where(who, s)) + ' ' : ''}${esc(cap(who))}: ${esc(st)}</span>`;
}
function setsDone(who, s, t = where(who, s)) { return setsFor(s, t).filter(x => val(who, COLL(t), x.id, 'done')).length; }
function lastTime(who, exid, cur) {   // most recent earlier gym session where this exercise was logged
  const idx = P.sessions.indexOf(cur);
  for (let i = idx - 1; i >= 0; i--) {
    const s = P.sessions[i]; if (!isStr(s)) continue;
    let best = null;
    for (const x of setsFor(s, 'Gym')) {
      if (x.pe.exercise_id !== exid) continue;
      const r = rec(who, 'gsets', x.id); if (!r || (r.weight == null && r.reps == null && r.secs == null)) continue;
      if (!best || (r.weight ?? -1) > (best.weight ?? -1)) best = r;
    }
    if (best) return `${best.weight != null ? best.weight + ' lb' : 'BW'}${best.reps != null ? ' × ' + best.reps : best.secs != null ? ' × ' + best.secs + 's' : ''} <span class="sub">(Wk ${s.week} ${s.suggested_day})</span>`;
  }
  return null;
}
const restTxt = s => !s ? '0 (superset)' : (s >= 60 ? Math.floor(s / 60) + 'm' : '') + (s % 60 ? ' ' + (s % 60) + 's' : '');

/* ---------------- views ---------------- */
const view = () => $('#view');
function header() {
  if (!P) { $('#weekInfo').innerHTML = ''; return; }
  const { w, brk } = weekInfo(); const s = P.sessions.find(x => x.week === clampW(w));
  $('#weekInfo').innerHTML = w === 0 ? `<b>${cap(me())}</b>` : w > 12 ? `<b>Programme complete</b><br>${cap(me())}` :
    brk ? `<b>Break week</b><br>Week ${w} next · ${cap(me())}` : `<b>Week ${w}</b> · ${esc(s.phase)}<br>${esc(s.block)} · ${cap(me())}`;
}
function render() {
  prep(); header(); paintSync();
  const [r, a] = (location.hash.slice(1) || 'today').split('/');
  document.querySelectorAll('#tabs a').forEach(x => x.classList.toggle('on', x.dataset.tab === r || (r === 'session' || r === 'hiit') && x.dataset.tab === 'week'));
  if (!configured() || !P) { if (r !== 'settings') return vSetup(); }
  const v = { today: vToday, week: vWeek, session: vSession, hiit: vHiit, stretch: vStretch, rides: vRides, ride: vRide, progress: vProgress, settings: vSettings }[r] || vToday;
  v(a);
}
function softRender() {
  const ae = document.activeElement;
  if (ae && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)) return; // never yank the field you're typing in
  const y = scrollY; render(); scrollTo(0, y);
}

function vSetup() {
  view().innerHTML = `<h1>Welcome 👋</h1>
  <div class="card"><p>This app logs the MTB Fitness 12-week programme (home or gym) for <b>Lynn</b> and <b>Jarom</b> and keeps both phones and the Excel tracker in sync through your private GitHub repo.</p>
  <p class="sub">See <b>SETUP.md</b> in the MTB Fitness folder for the one-time steps (create the repo, run the PC sync with --init, make a token).</p>
  <a class="btn block" href="#settings">Set up this phone</a></div>`;
}

function sessionCard(s, opts = {}) {
  const d = sessDate(s); const isT = d === todayISO();
  const href = s.type === 'HIIT' ? `#hiit/${s.id}` : `#session/${s.id}`;
  let extra = '';
  const mt = isStr(s) ? where(me(), s) : null;
  if (mt) { const tot = setsFor(s, mt).length; extra = `<span class="sub"> · ${setsDone(me(), s)}/${tot} sets</span>`; }
  else { const iv = interval(s.week); extra = `<span class="sub"> · ${iv.reps}× ${iv.work_sec}s/${iv.rest_sec}s</span>`; }
  return `<a class="card sess ${isT ? 'today' : ''}" href="${href}">
    <div class="day d-${s.suggested_day}">${s.suggested_day}<small>${fmt(d, { month: 'numeric', day: 'numeric' })}</small></div>
    <div class="grow"><h3>${s.type === 'HIIT' ? 'HIIT ' + s.n + ' · ' + esc(interval(s.week).focus) : tIcon(mt) + ' Strength ' + s.n + ' of 3'}</h3>
    <div class="sub">${esc(s.type === 'HIIT' ? 'Gym bike / elliptical' : mt === 'Gym' ? s.gym_label : s.label)}${extra}</div>
    <div>${chip(me(), s.id)}${partner() ? chip(partner(), s.id) : ''}</div></div></a>`;
}
function vToday() {
  const t = todayISO(); const { w, brk } = weekInfo();
  const todays = P.sessions.filter(s => sessDate(s) === t);
  const dow = DAYS[(new Date().getDay() + 6) % 7];
  let html = `<h1>${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h1>`;
  if (!val(me(), 'settings', 'main', 'introWatched')) html += introCard(false);
  html += stravaPrompts();
  if (w === 0) html += `<div class="card">Your programme starts <b>${fmt(startISO(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</b> (${Math.ceil((parseISO(startISO()) - parseISO(t)) / 864e5)} days). Preview week 1 below.
    <div class="mt"><a href="#settings/schedule">Change my start date</a></div></div>`;
  if (brk) html += `<div class="card"><h3>Break week 🌴</h3><div class="sub">You pushed your schedule back. Week ${w} starts ${fmt(weekStart(w), { weekday: 'long', month: 'short', day: 'numeric' })}.</div></div>`;
  if (w > 12) html += `<div class="card">🎉 12 weeks done. Check <a href="#progress">Progress</a>.</div>`;
  if (todays.length) html += `<h2>Today's workout</h2>` + todays.map(s => sessionCard(s)).join('');
  else if (w >= 1 && w <= 12 && !brk) html += `<div class="card"><h3>${dow === 'Thu' || dow === 'Sun' ? 'Rest day 😴' : 'No session scheduled'}</h3><div class="sub">Catch up on a missed session from this week if needed.</div></div>`;
  if (dow === 'Sat' && w >= 1 && w <= 12 && !brk) html += rideCard(t);   // Saturday = MTB ride day (plus Strength 3)
  // stretches today
  const sd = t;
  html += `<h2>Daily stretches</h2>${stretchSummary(sd)}`;
  const wk = clampW(w || 1);
  html += `<h2>Week ${wk}</h2>` + P.sessions.filter(s => s.week === wk && !todays.includes(s)).map(s => sessionCard(s)).join('');
  view().innerHTML = html;
}
function stretchSummary(d) {
  const n = who => (val(who, 'stretch', d, 's') || []).filter(Boolean).length;
  return `<a class="card sess" href="#stretch/${d}"><div class="day d-${DAYS[(parseISO(d).getDay() + 6) % 7]}">🧘<small>${fmt(d, { month: 'numeric', day: 'numeric' })}</small></div>
   <div class="grow"><h3>9 correctives · 1×10 each</h3><div><span class="chip ${n(me()) === 9 ? 'Done' : ''} me">${cap(me())}: ${n(me())}/9</span>${partner() ? `<span class="chip ${n(partner()) === 9 ? 'Done' : ''}">${cap(partner())}: ${n(partner())}/9</span>` : ''}</div></div></a>`;
}
function vWeek(a) {
  const w = clampW(+a || curWeek() || 1);
  const s0 = P.sessions.find(s => s.week === w);
  view().innerHTML = `<div class="row"><a class="btn sec small" href="#week/${w - 1}" ${w <= 1 ? 'style="visibility:hidden"' : ''}>‹</a>
    <div class="grow center"><h1>Week ${w}</h1><div class="sub">${fmt(weekStart(w))} – ${fmt(iso(addDays(parseISO(weekStart(w)), 6)))} · ${esc(s0.phase)} · ${esc(s0.block)}</div></div>
    <a class="btn sec small" href="#week/${w + 1}" ${w >= 12 ? 'style="visibility:hidden"' : ''}>›</a></div>` +
    weekPlan(w);
}
// Week layout: Mon Str1 · Tue HIIT1 · Wed Str2 · Thu Rest · Fri HIIT2 · Sat Str3 + MTB ride · Sun Rest
const restCard = d => `<div class="card sess"><div class="day d-${DAYS[(parseISO(d).getDay() + 6) % 7]}">${DAYS[(parseISO(d).getDay() + 6) % 7]}<small>${fmt(d, { month: 'numeric', day: 'numeric' })}</small></div><div class="grow"><h3>Rest</h3></div></div>`;
const rideCard = d => `<a class="card sess" href="#ride/new"><div class="day d-Sat">Sat<small>${fmt(d, { month: 'numeric', day: 'numeric' })}</small></div><div class="grow"><h3>🚵 MTB ride</h3><div class="sub">Tap to log your ride</div></div></a>`;
function weekPlan(w) {
  const day = off => iso(addDays(parseISO(weekStart(w)), off));
  const ss = P.sessions.filter(s => s.week === w);
  const at = off => ss.filter(s => s.day_offset === off).map(s => sessionCard(s)).join('');
  return at(0) + at(1) + at(2) + restCard(day(3)) + at(4) + at(5) + rideCard(day(5)) + restCard(day(6));
}

/* ----- strength session (home or gym) ----- */
function vSession(id) {
  const s = P._sess[id]; if (!s) return vToday();
  const t = where(me(), s), gym = t === 'Gym', coll = COLL(t);
  const pl = plan(gym ? s.gym_plan_id : s.plan_id); const pt = partner(); const ptSame = pt && where(pt, s) === t;
  let html = `<a href="#week/${s.week}" class="sub">‹ Week ${s.week}</a>
  <h1>Strength ${s.n} of 3</h1><div class="sub">${esc(gym ? s.gym_label : s.label)} · suggested ${fmt(sessDate(s))}</div>
  <div class="seg mt"><button data-where="${id}|Home" class="${gym ? '' : 'on'}">🏠 Home</button><button data-where="${id}|Gym" class="${gym ? 'on' : ''}">🏋️ Gym</button></div>
  ${pt && !ptSame ? `<div class="sub mt">${cap(pt)} is doing this one at ${where(pt, s) === 'Gym' ? 'the gym' : 'home'}.</div>` : ''}
  <div class="card grid2">
    <div><label class="f">My date done</label><input type="date" data-f="${me()}|sessions|${id}|dateDone" value="${esc(myDate(me(), id))}"></div>
    <div><label class="f">My status</label>${selectHtml(`${me()}|sessions|${id}|status`, P.status_options, status(me(), id))}</div>
  </div>${partnerDateNote(id)}`;
  for (const pe of pl.exercises) {
    const ex = exById(pe.exercise_id); const secs = pe.target_type === 'seconds';
    const nm = ex.video_url ? `<a href="${esc(ex.video_url)}" target="_blank" rel="noopener">${esc(ex.name)}</a>` : esc(ex.name);
    html += `<div class="card ex"><h3><span class="sub">${pe.order}</span> ${nm}</h3>
      <div class="meta">${pe.sets} sets × <b>${esc(pe.target)}</b>${pe.per_side ? ' ' + esc(pe.per_side) : ''} · book rest ${restTxt(pe.rest_sec)}${ex.equipment !== 'Bodyweight' ? ' · ' + esc(ex.equipment) : ''}
      ${pe.drop_set ? '<br><b>Triple drop set:</b> log the starting weight and first-drop reps' : ''}
      ${secs && !pe.sprint ? `<button class="timerbtn" data-hold="${pe.target_max || 0}">⏱ ${pe.target_max ? pe.target_max + 's timer' : 'stopwatch'}</button>` : ''}</div>`;
    if (gym) { const lt = lastTime(me(), pe.exercise_id, s); if (lt) html += `<div class="last">Last time: ${lt}</div>`; }
    if (pe.sprint) {
      const box = `sp-${id}-${pe.order}`; const rest = cfg.restSec || 60;
      TCFG[box] = { reps: pe.sets, work: pe.target_max, rest, label: 'Sprint',
        onWork: i => { const lid = setId(s, pe, i, 'Gym'); setVal(me(), 'gsets', lid, 'secs', pe.target_max); setVal(me(), 'gsets', lid, 'done', true); autoDate(id); markSet('gsets', lid); } };
      html += `<div class="sub">${pe.sets} × ${pe.target_max}s all-out sprint, ${rest}s easy spin between (change in ⚙ rest timer).</div>` + timerBox(box, pe.sets, pe.target_max);
    }
    for (let n = 1; n <= pe.sets; n++) {
      const lid = setId(s, pe, n, t); const k = `${me()}|${coll}|${lid}`; const r = rec(me(), coll, lid) || {};
      const num = (f, ph) => `<input inputmode="${f === 'weight' ? 'decimal' : 'numeric'}" placeholder="${ph}" data-f="${k}|${f}" data-num value="${esc(r[f] ?? '')}">`;
      let inputs;
      if (gym) inputs = secs ? `<div class="span2">${num('secs', 'secs')}</div>` : num('weight', 'lb') + num('reps', 'reps');
      else inputs = num(secs ? 'secs' : 'reps', secs ? 'secs' : 'reps') + selectHtml(`${k}|band`, P.band_options, r.band, 'band');
      html += `<div class="set"><div class="n">${n}</div>${inputs}<button class="done ${r.done ? 'on' : ''}" data-done="${coll}|${lid}">✓</button>`;
      if (ptSame) {
        const q = rec(pt, coll, lid);
        if (q && (q.reps != null || q.secs != null || q.done || q.band || q.weight != null))
          html += `<div class="partner ${pt}">${cap(pt)}: ${q.weight != null ? q.weight + ' lb × ' : ''}${q.reps ?? (q.secs != null ? q.secs + 's' : '–')}${q.band ? ' · ' + esc(q.band) : ''}${q.done ? ' ✓' : ''}</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  html += `<div class="card"><div class="grid2">
    <div><label class="f">My duration (min)</label><input inputmode="numeric" data-num data-f="${me()}|sessions|${id}|duration" value="${esc(val(me(), 'sessions', id, 'duration') ?? val('shared', 'sessions', id, 'duration') ?? '')}"></div>
    <div><label class="f">My RPE (1-10)</label>${selectHtml(`${me()}|sessions|${id}|rpe`, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], val(me(), 'sessions', id, 'rpe'))}</div></div>
    <label class="f">Session notes (shared)</label><textarea data-f="shared|sessions|${id}|notes">${esc(val('shared', 'sessions', id, 'notes') || '')}</textarea>
    <button class="btn block" data-finish="${id}">Finish workout ✓</button></div>${stravaStatus(id)}`;
  view().innerHTML = html; paintT();
}
function markSet(coll, lid) { const b = document.querySelector(`[data-done="${coll}|${lid}"]`); if (b) b.classList.add('on'); const i = document.querySelector(`[data-f="${me()}|${coll}|${lid}|secs"]`); if (i) i.value = val(me(), coll, lid, 'secs') ?? ''; }
function selectHtml(key, opts, cur, ph) {
  return `<select data-f="${key}"><option value="">${ph || '–'}</option>${opts.map(o => `<option ${String(o) === String(cur ?? '') ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
}

/* ----- HIIT ----- */
function vHiit(id) {
  const s = P._sess[id]; if (!s) return vToday();
  const iv = interval(s.week); const k = `${me()}|hiit|${id}`; const v = f => esc(val(me(), 'hiit', id, f) ?? '');
  const pt = partner(); const pr = pt && rec(pt, 'hiit', id);
  view().innerHTML = `<a href="#week/${s.week}" class="sub">‹ Week ${s.week}</a>
  <h1>HIIT ${s.n} · ${esc(iv.focus)}</h1><div class="sub">Week ${s.week} · suggested ${fmt(sessDate(s))}</div>
  <div class="card"><b>${iv.reps} × ${iv.work_sec}s work / ${iv.rest_sec}s rest</b> · target ${esc(iv.target_rpm)} (bike)<div class="sub mt">${esc(iv.how_to)}</div>
  <div class="sub">On the elliptical, match the effort and track the resistance level.</div></div>
  ${timerBox('hbox-' + id, iv.reps, iv.work_sec)}
  <div class="card">
   <div class="grid2"><div><label class="f">My date done</label><input type="date" data-f="${me()}|sessions|${id}|dateDone" value="${esc(myDate(me(), id))}"></div>
   <div><label class="f">My status</label>${selectHtml(`${me()}|sessions|${id}|status`, P.status_options, status(me(), id))}</div></div>
   <div class="grid2"><div><label class="f">Machine</label>${selectHtml(`${k}|machine`, P.machine_options, val(me(), 'hiit', id, 'machine'))}</div>
   <div><label class="f">Intervals completed</label><input inputmode="numeric" data-num id="hcomp" data-f="${k}|intervals" value="${v('intervals')}"></div></div>
   <div class="grid3"><div><label class="f">Work resist.</label><input inputmode="decimal" data-num data-f="${k}|workRes" value="${v('workRes')}"></div>
   <div><label class="f">Rest resist.</label><input inputmode="decimal" data-num data-f="${k}|restRes" value="${v('restRes')}"></div>
   <div><label class="f">Avg RPM/SPM</label><input inputmode="numeric" data-num data-f="${k}|avgRpm" value="${v('avgRpm')}"></div></div>
   <div class="grid3"><div><label class="f">Avg HR</label><input inputmode="numeric" data-num data-f="${k}|avgHr" value="${v('avgHr')}"></div>
   <div><label class="f">Max HR</label><input inputmode="numeric" data-num data-f="${k}|maxHr" value="${v('maxHr')}"></div>
   <div><label class="f">RPE</label>${selectHtml(`${k}|rpe`, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], val(me(), 'hiit', id, 'rpe'))}</div></div>
   <label class="f">My total time (min)</label><input inputmode="numeric" data-num data-f="${k}|totalTime" value="${esc(val(me(), 'hiit', id, 'totalTime') ?? val('shared', 'hiit', id, 'totalTime') ?? '')}">
   <label class="f">Notes (shared)</label><textarea data-f="shared|hiit|${id}|notes">${esc(val('shared', 'hiit', id, 'notes') || '')}</textarea>
   ${pr ? `<div class="partner ${pt} mt">${cap(pt)}: ${esc(pr.machine || '')} ${pr.intervals != null ? pr.intervals + '/' + iv.reps + ' intervals' : ''} ${pr.avgHr ? '· avg HR ' + pr.avgHr : ''}</div>` : ''}
   <button class="btn block" data-finish="${id}">Finish HIIT ✓</button></div>${stravaStatus(id)}`;
  TCFG['hbox-' + id] = { reps: iv.reps, work: iv.work_sec, rest: iv.rest_sec,
    onEnd: done => { const cur = val(me(), 'hiit', id, 'intervals'); if (done && (cur == null || cur < done)) setVal(me(), 'hiit', id, 'intervals', done); const c = $('#hcomp'); if (c) c.value = val(me(), 'hiit', id, 'intervals') ?? ''; } };
  paintT();
}
const clock = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };

/* ----- interval timer (HIIT + gym bike sprints) -----
 * Clock-based: phases end at absolute times, so the timer stays correct even if the phone
 * sleeps or the browser throttles it - when you come back it catches up to the right phase. */
const TCFG = {};   // box id -> {reps, work, rest, onWork(i), onEnd(completed)}
let T = null;
function timerBox(box, reps, work) {
  return `<div class="hiitbox" id="${box}"><div class="phase">READY</div><div class="big">${clock(work)}</div>
   <div class="center sub rep">Interval 0 of ${reps}</div>
   <div class="grid3 mt"><button class="btn" data-tstart="${box}">Start</button><button class="btn sec" data-tpause="${box}">Pause</button><button class="btn sec" data-tstop="${box}">Stop</button></div></div>`;
}
function startT(box) {
  const c = TCFG[box]; if (!c) return;
  if (T && !T.done) { if (T.box !== box) toast('Another timer is running'); return; }
  T = { box, ...c, rep: 1, phase: 'WORK', end: Date.now() + c.work * 1000, paused: 0, done: false, completed: 0, lastBeep: -1 };
  beep(880, .25); vib(300); wake(true);
  T.iv = setInterval(tickT, 200); paintT();
}
function tickT() {
  if (!T || T.done || T.paused) return;
  while (Date.now() >= T.end && !T.done) {
    if (T.phase === 'WORK') {
      T.completed = T.rep; T.onWork?.(T.rep);
      if (T.rep >= T.reps) { endT(false); return; }
      T.phase = 'REST'; T.end += T.rest * 1000; beep(440, .4); vib([200, 100, 200]);
    } else { T.rep++; T.phase = 'WORK'; T.end += T.work * 1000; beep(880, .4); vib(400); }
    T.lastBeep = -1;
  }
  const sec = Math.ceil((T.end - Date.now()) / 1000);
  if (sec <= 3 && sec > 0 && sec !== T.lastBeep) { T.lastBeep = sec; beep(660, .08); }
  paintT();
}
function pauseT(box) {
  if (!T || T.done || T.box !== box) return;
  if (T.paused) { T.end = Date.now() + T.paused; T.paused = 0; } else T.paused = Math.max(1, T.end - Date.now());
  paintT();
}
function endT(stopped) {
  if (!T || T.done) return; clearInterval(T.iv); T.done = true; T.phase = stopped ? 'STOPPED' : 'DONE'; wake(false);
  if (!stopped) { beep(1000, .6); vib([300, 100, 300, 100, 600]); }
  T.onEnd?.(T.completed); paintT();
}
function paintT() {
  if (!T) return; const box = document.getElementById(T.box); if (!box) return;
  const left = T.done ? 0 : T.paused ? T.paused / 1000 : (T.end - Date.now()) / 1000;
  box.className = 'hiitbox ' + T.phase;
  const ph = box.querySelector('.phase'); ph.className = 'phase ' + T.phase; ph.textContent = T.phase === 'DONE' ? 'DONE 🎉' : T.paused ? 'PAUSED' : T.phase;
  box.querySelector('.big').textContent = clock(left);
  box.querySelector('.rep').textContent = `Interval ${T.done ? T.completed : T.rep} of ${T.reps}`;
  box.querySelector('[data-tpause]').textContent = T.paused ? 'Resume' : 'Pause';
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tickT(); });

/* ----- stretches ----- */
function vStretch(d) {
  const w = curWeek();
  d = d || todayISO();   // stretches are logged on the day you actually do them
  const arr = val(me(), 'stretch', d, 's') || Array(9).fill(false);
  const parr = partner() ? (val(partner(), 'stretch', d, 's') || []) : [];
  const ids = P.stretches.exercise_ids;
  view().innerHTML = `<div class="row"><a class="btn sec small" href="#stretch/${iso(addDays(parseISO(d), -1))}">‹</a>
   <div class="grow center"><h1>Stretches</h1><div class="sub">${d === todayISO() ? 'Today · ' : ''}${fmt(d, { weekday: 'long', month: 'short', day: 'numeric' })}${d !== todayISO() ? ` · <a href="#stretch/${todayISO()}">Back to today</a>` : ''}</div></div>
   <a class="btn sec small" href="#stretch/${iso(addDays(parseISO(d), 1))}" ${d >= todayISO() ? 'style="visibility:hidden"' : ''}>›</a></div>
   <div class="card">${ids.map((id, i) => `<div class="stretch"><a href="${esc(exById(id).video_url)}" target="_blank" rel="noopener">${esc(P.stretches.names[i])}<div class="sub">1 × 10${parr[i] ? ` · <span style="color:var(--jarom)">${cap(partner())} ✓</span>` : ''}</div></a>
     <button class="done ${arr[i] ? 'on' : ''}" style="width:52px" data-stretch="${d}|${i}">✓</button></div>`).join('')}
   <button class="btn block sec" data-stretchall="${d}">Mark all 9 done</button>
   <label class="f">Notes (shared)</label><textarea data-f="shared|stretchNotes|${d}|notes">${esc(val('shared', 'stretchNotes', d, 'notes') || '')}</textarea></div>`;
}

/* ----- rides ----- */
function rides() { return Object.entries(D.shared?.rides || {}).filter(([, r]) => !r.deleted && r.date).sort((a, b) => b[1].date.localeCompare(a[1].date)); }
function vRides() {
  const list = rides();
  view().innerHTML = `<h1>MTB Rides</h1><a class="btn block" href="#ride/new">+ Log a ride</a>
   ${list.length ? list.map(([id, r]) => `<a class="card sess" href="#ride/${id}"><div class="day d-Sun">${fmt(r.date, { month: 'numeric', day: 'numeric' })}</div>
     <div class="grow"><h3>${esc(r.route || 'Ride')}</h3><div class="sub">${esc(r.rider || '')} · ${r.miles ?? '–'} mi · ${r.elev ?? '–'} ft · ${r.time ?? '–'} min${r.stravaIds ? ' · <span class="stag">Strava</span>' : ''}</div></div></a>`).join('') : '<p class="sub center mt">No rides logged yet.</p>'}`;
}
// A new ride is only a draft until you type something - backing out leaves nothing behind (2.5.1)
let rideDraft = null;   // { id, date, rider } defaults shown on the form but not saved yet
function saveRideDraft(id) {
  if (!rideDraft || rideDraft.id !== id || rec('shared', 'rides', id)) return;
  const d = rideDraft; rideDraft = null;
  setVal('shared', 'rides', id, 'date', d.date); setVal('shared', 'rides', id, 'rider', d.rider);
}
function vRide(id) {
  if (id === 'new') { id = `R-${Date.now().toString(36)}-${me()}`; rideDraft = { id, date: todayISO(), rider: cap(me()) }; history.replaceState(null, '', '#ride/' + id); }
  const draft = rideDraft?.id === id && !rec('shared', 'rides', id) ? rideDraft : null;
  const rv_ = f => val('shared', 'rides', id, f) ?? (draft ? draft[f] : undefined);
  const k = `shared|rides|${id}`; const v = f => esc(rv_(f) ?? '');
  view().innerHTML = `<a href="#rides" class="sub">‹ Rides</a><h1>Ride</h1><div class="card">
   <div class="grid2"><div><label class="f">Date</label><input type="date" data-f="${k}|date" value="${v('date')}"></div>
   <div><label class="f">Rider</label>${selectHtml(`${k}|rider`, ['Lynn', 'Jarom', 'Both'], rv_('rider'))}</div></div>
   <label class="f">Trail / route</label><input data-f="${k}|route" value="${v('route')}">
   <div class="grid3"><div><label class="f">Miles</label><input inputmode="decimal" data-num data-f="${k}|miles" value="${v('miles')}"></div>
   <div><label class="f">Elev gain ft</label><input inputmode="numeric" data-num data-f="${k}|elev" value="${v('elev')}"></div>
   <div><label class="f">Moving min</label><input inputmode="numeric" data-num data-f="${k}|time" value="${v('time')}"></div></div>
   <div class="grid3"><div><label class="f">Avg HR</label><input inputmode="numeric" data-num data-f="${k}|avgHr" value="${v('avgHr')}"></div>
   <div><label class="f">Max HR</label><input inputmode="numeric" data-num data-f="${k}|maxHr" value="${v('maxHr')}"></div>
   <div><label class="f">RPE</label>${selectHtml(`${k}|rpe`, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], val('shared', 'rides', id, 'rpe'))}</div></div>
   <label class="f">Notes</label><textarea data-f="${k}|notes">${v('notes')}</textarea>
   ${val('shared', 'rides', id, 'stravaIds') ? `<div class="sub mt">Imported from Strava · ${String(val('shared', 'rides', id, 'stravaIds')).split(',').map(stravaLink).join(' · ')}</div>` : ''}
   <a class="btn block" href="#rides">Save</a><button class="btn block danger" data-delride="${id}">Delete ride</button></div>`;
}

/* ----- progress ----- */
function weekStats(who, w) {
  const ss = P.sessions.filter(s => s.week === w);
  const bw = ss.filter(isStr), hi = ss.filter(s => s.type === 'HIIT');
  const planned = bw.reduce((a, s) => a + setsFor(s, where(who, s)).length, 0), done = bw.reduce((a, s) => a + setsDone(who, s), 0);
  let st = 0; for (let i = 0; i < 7; i++) { const d = iso(addDays(parseISO(weekStart(w, who)), i)); if ((val(who, 'stretch', d, 's') || []).filter(Boolean).length === 9) st++; }
  const rideN = rides().filter(([, r]) => { const dd = Math.floor((parseISO(r.date) - parseISO(weekStart(w, who))) / 864e5); return dd >= 0 && dd < 7 && (r.rider === 'Both' || (r.rider || '').toLowerCase() === who); }).length;
  return { bw: bw.filter(s => status(who, s.id) === 'Done').length, hi: hi.filter(s => status(who, s.id) === 'Done').length, pct: planned ? Math.round(done / planned * 100) : 0, st, rides: rideN };
}
function vProgress() {
  const ws = [...Array(12)].map((_, i) => i + 1); const pt = partner();
  const cell = (v, full, cls) => `<td class="${cls} ${v >= full ? 'full' : ''}">${v}</td>`;
  view().innerHTML = `<h1>Progress</h1><div class="sub">Strength /3 · HIIT /2 · sets % · stretch days /7 · rides. <span style="color:var(--acc2)">${cap(me())}</span>${pt ? ` vs <span style="color:var(--jarom)">${cap(pt)}</span>` : ''}</div>
  <div class="card"><table class="prog"><tr><th>Wk</th><th>Str</th><th>HIIT</th><th>Sets</th><th>🧘</th><th>Ride</th>${pt ? '<th>Str</th><th>HIIT</th><th>Sets</th><th>🧘</th><th>Ride</th>' : ''}</tr>
  ${ws.map(w => { const a = weekStats(me(), w), b = pt && weekStats(pt, w);
    return `<tr><td><a href="#week/${w}">${w}</a></td>${cell(a.bw, 3, 'me')}${cell(a.hi, 2, 'me')}${cell(a.pct, 100, 'me')}${cell(a.st, 7, 'me')}${cell(a.rides, 99, 'me')}
    ${b ? cell(b.bw, 3, 'pt') + cell(b.hi, 2, 'pt') + cell(b.pct, 100, 'pt') + cell(b.st, 7, 'pt') + cell(b.rides, 99, 'pt') : ''}</tr>`; }).join('')}</table></div>`;
}

/* ----- settings ----- */
function scheduleCard() {
  const L = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
  const { w } = weekInfo();
  const doneIn = wk => P.sessions.some(x => x.week === wk && ['Done', 'Partial'].includes(status(me(), x.id)));
  const def = Math.min(12, Math.max(2, w >= 1 && w <= 12 ? (doneIn(w) ? w + 1 : w) : 2));
  const pushes = []; for (let k = 2; k <= 12; k++) if (pushAt(me(), k)) pushes.push(k);
  return `<div class="card" id="schedCard"><h3>My schedule</h3>
   <label class="f">My start date (Monday of week 1)</label><input type="date" id="sStart" value="${startISO()}">
   <div class="sub">Week 1 starts ${fmt(startISO(), L)} · finishes ${fmt(progEnd(), L)}. Any date you pick moves to that week's Monday. Only your own dates change.</div>
   ${pushes.map(k => `<div class="row mt"><div class="grow">⏸ ${pushAt(me(), k)} week${pushAt(me(), k) > 1 ? 's' : ''} pushed back before week ${k} <span class="sub">(week ${k} now starts ${fmt(weekStart(k))})</span></div><button class="btn small sec" data-unpush="${k}">Undo</button></div>`).join('')}
   <label class="f mt">Missed a week? Push back 1 week, starting from</label>
   <div class="grid2"><select id="sPushW">${[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(k => `<option value="${k}" ${k === def ? 'selected' : ''}>Week ${k} (${fmt(weekStart(k), { month: 'short', day: 'numeric' })})</option>`).join('')}</select>
   <button class="btn small sec" id="sPush">Push back 1 week</button></div>
   <div class="sub">That week and everything after it move one week later, keeping the Mon–Sun layout. Sessions you've already done keep their dates. To move week 1, change your start date.</div></div>`;
}
function vSettings(a) {
  view().innerHTML = `<h1>Settings</h1><div class="card">
   <label class="f">Who is using this phone?</label><select id="sMe"><option value="">Choose…</option>${['lynn', 'jarom'].map(p => `<option value="${p}" ${cfg.me === p ? 'selected' : ''}>${cap(p)}</option>`).join('')}</select>
   <label class="f">My default track for strength sessions</label><select id="sTrack">${['Home', 'Gym'].map(x => `<option ${(cfg.me ? defTrack(cfg.me) : 'Home') === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
   <div class="sub">You can still switch Home/Gym on any session.</div>
   <label class="f">GitHub username (repo owner)</label><input id="sOwner" autocapitalize="off" autocorrect="off" value="${esc(cfg.owner)}">
   <label class="f">Private data repo name</label><input id="sRepo" autocapitalize="off" autocorrect="off" value="${esc(cfg.repo)}">
   <label class="f">GitHub token (fine-grained, Contents: read & write on that repo only)</label><input id="sTok" type="password" autocomplete="off" value="${esc(cfg.token)}">
   <label class="f">Default rest timer between sets (seconds)</label><input id="sRest" inputmode="numeric" value="${esc(cfg.restSec)}">
   <details class="mt"><summary class="sub">Advanced</summary><label class="f">API base URL</label><input id="sApi" autocapitalize="off" value="${esc(cfg.api)}"></details>
   <button class="btn block" id="sSave">Save & sync</button></div>
   ${configured() && P ? stravaSettings() : ''}
   ${configured() && P ? scheduleCard() : ''}
   <div class="card"><h3>Programme</h3>
   <p class="sub">Intro video: 10 common questions from people following the programme.</p>
   <a class="btn block sec" href="${INTRO_VIDEO}" target="_blank" rel="noopener">▶ Watch the intro video</a></div>
   <div class="card"><h3>Data</h3>
   <div class="sub">Last sync: ${syncState.last ? new Date(syncState.last).toLocaleString() : 'never'}${syncState.err ? `<br><span style="color:var(--bad)">${esc(syncState.err)}</span>` : ''}</div>
   <button class="btn block sec" id="sProg">Reload programme from repo</button>
   <button class="btn block sec" id="sExport">Download backup (JSON)</button>
   <button class="btn block danger" id="sReset">Clear data on this phone</button>
   <p class="sub mt">The Excel tracker updates when the PC runs <b>Sync Tracker.bat</b>. App v${APP_VERSION}</p></div>`;
  $('#sSave').onclick = async () => {
    cfg = { ...cfg, me: $('#sMe').value, owner: $('#sOwner').value.trim(), repo: $('#sRepo').value.trim(), token: $('#sTok').value.trim(), api: ($('#sApi').value.trim() || 'https://api.github.com'), restSec: +$('#sRest').value || 60 };
    LS.set('cfg', cfg);
    if (!configured()) return toast('Fill in all fields');
    if (defTrack(cfg.me) !== $('#sTrack').value || !val(cfg.me, 'settings', 'main', 'defaultTrack')) setVal(cfg.me, 'settings', 'main', 'defaultTrack', $('#sTrack').value);
    try { await loadProgram(); prep(); await syncNow(true); location.hash = '#today'; render(); } catch (e) { toast(e.message); syncState.err = e.message; paintSync(); }
  };
  if ($('#sStart')) $('#sStart').onchange = e => { if (e.target.value) { setVal(me(), 'settings', 'main', 'startDate', monday(e.target.value)); toast('Start date: ' + fmt(monday(e.target.value))); render(); } };
  if ($('#sPush')) $('#sPush').onclick = () => { const k = +$('#sPushW').value; setVal(me(), 'settings', 'main', 'push' + k, pushAt(me(), k) + 1); toast(`Week ${k} onward pushed back a week`); render(); };
  if (a === 'schedule') setTimeout(() => $('#schedCard')?.scrollIntoView({ block: 'start' }), 50);
  if ($('#sGarmin')) $('#sGarmin').onchange = e => setVal(me(), 'settings', 'main', 'garmin', e.target.checked);
  if ($('#sStravaOff')) $('#sStravaOff').onclick = () => { if (confirm('Disconnect Strava? Activities already on Strava stay there.')) { setVal(me(), 'settings', 'main', 'stravaDisconnect', Date.now()); stravaKick('disconnect'); render(); } };
  if ($('#sCodeGo')) $('#sCodeGo').onclick = () => {
    let t = $('#sCode').value.trim(); if (!t) return;
    if (t.includes('code=')) { const u = new URLSearchParams(t.slice(t.indexOf('?') + 1)); t = u.get('code') + '|' + (u.get('scope') || ''); }
    const [c, sc] = t.split('|'); if (stravaAcceptCode(c, sc)) render();
  };
  $('#sProg').onclick = async () => { try { await loadProgram(); prep(); toast('Programme reloaded'); render(); } catch (e) { toast(e.message); } };
  $('#sExport').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ exported: new Date().toISOString(), data: D }, null, 1)], { type: 'application/json' })); a.download = `mtb-backup-${todayISO()}.json`; a.click(); };
  $('#sReset').onclick = () => { if (confirm('Remove all data stored on this phone? (Data already synced to GitHub stays there.)')) { localStorage.removeItem('mtb.data'); localStorage.removeItem('mtb.shas'); D = {}; shas = {}; toast('Cleared - syncing'); syncNow(); } };
}

/* ---------------- events ---------------- */
document.addEventListener('change', e => {
  const el = e.target; const f = el.dataset?.f; if (!f) return;
  const [file_, coll, key, field] = f.split('|');
  let v = el.value.trim();
  if (el.hasAttribute('data-num') && v !== '') { const n = Number(v.replace(',', '.')); v = isNaN(n) ? v : n; }
  if (field === 'rpe' && v !== '') v = Number(v);
  if (coll === 'rides') saveRideDraft(key);   // first entry on a new ride saves its date + rider too
  setVal(file_, coll, key, field, v === '' ? null : v);
  if ((coll === 'sets' || coll === 'gsets') && v !== '' && v !== null && field !== 'band') autoDate(key.split('-').slice(0, 2).join('-'));
  if (field === 'status' && v === 'Done') autoDate(key);
});
document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.done) {
    const [coll, lid] = t.dataset.done.split('|'); const on = !val(me(), coll, lid, 'done');
    setVal(me(), coll, lid, 'done', on ? true : null); t.classList.toggle('on', on);
    if (on) { autoDate(lid.split('-').slice(0, 2).join('-')); startRest(cfg.restSec || 60); vib(40); }
  } else if (t.dataset.where) {
    const [sid, tr] = t.dataset.where.split('|'); setVal(me(), 'sessions', sid, 'where', tr); render();
  } else if (t.dataset.tstart) { startT(t.dataset.tstart);
  } else if (t.dataset.tpause) { pauseT(t.dataset.tpause);
  } else if (t.dataset.tstop) { if (T && T.box === t.dataset.tstop) endT(true);
  } else if (t.dataset.introdone) {
    setVal(me(), 'settings', 'main', 'introWatched', true); render();
  } else if (t.dataset.finish) {
    const id = t.dataset.finish; setVal(me(), 'sessions', id, 'status', 'Done'); autoDate(id); toast('Nice work! 💪');
    if (stravaAthlete()) stravaKick('finish');
    location.hash = '#today';
  } else if (t.dataset.unpush) {
    const k = +t.dataset.unpush; setVal(me(), 'settings', 'main', 'push' + k, pushAt(me(), k) - 1 || null); render();
  } else if (t.dataset.spost) {
    stravaReq(t.dataset.spost, 'post'); toast('Sending to Strava…'); softRender();
  } else if (t.dataset.sskip) {
    stravaReq(t.dataset.sskip, 'skip'); softRender();
  } else if (t.dataset.stretch) {
    const [d, i] = t.dataset.stretch.split('|'); const arr = [...(val(me(), 'stretch', d, 's') || Array(9).fill(false))];
    arr[+i] = !arr[+i]; setVal(me(), 'stretch', d, 's', arr); t.classList.toggle('on', arr[+i]);
  } else if (t.dataset.stretchall) {
    setVal(me(), 'stretch', t.dataset.stretchall, 's', Array(9).fill(true)); render();
  } else if (t.dataset.delride) {
    const id = t.dataset.delride;
    if (!rec('shared', 'rides', id)) { rideDraft = null; location.hash = '#rides'; }   // never saved - nothing to delete
    else if (confirm('Delete this ride?')) { setVal('shared', 'rides', id, 'deleted', true); location.hash = '#rides'; }
  } else if (t.dataset.rest) {
    if (t.dataset.rest === 'skip') stopRest(); else if (rest) rest.end += 15000;
  } else if (t.dataset.hold !== undefined) {
    holdTimer(t, +t.dataset.hold);
  }
});
function autoDate(sid) {   // first thing you log in a session stamps YOUR date (not your partner's)
  if (!P._sess[sid] || val(me(), 'sessions', sid, 'dateDone')) return;
  const d = val('shared', 'sessions', sid, 'dateDone') && !val(partner(), 'sessions', sid, 'dateDone') ? val('shared', 'sessions', sid, 'dateDone') : todayISO();
  setVal(me(), 'sessions', sid, 'dateDone', d);
  const i = document.querySelector(`[data-f="${me()}|sessions|${sid}|dateDone"]`); if (i) i.value = d;
}
$('#syncBtn').onclick = () => syncNow(true);
addEventListener('hashchange', () => { scrollTo(0, 0); render(); });
addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(300); });
setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 120000);
setInterval(paintSync, 30000);

/* ---------------- timers, sound, misc ---------------- */
let rest = null;
function startRest(sec) {
  stopRest(); rest = { end: Date.now() + sec * 1000, total: sec * 1000 }; $('#restBar').hidden = false;
  $('#restTime').textContent = clock(sec); $('#restProg').style.width = '0%';
  rest.iv = setInterval(() => {
    const left = rest.end - Date.now();
    $('#restTime').textContent = clock(Math.max(0, left / 1000)); $('#restProg').style.width = Math.min(100, 100 * (1 - left / rest.total)) + '%';
    if (left <= 0) { beep(880, .3); vib([200, 80, 200]); stopRest(); }
  }, 250);
}
function stopRest() { if (rest) clearInterval(rest.iv); rest = null; $('#restBar').hidden = true; }
function holdTimer(btn, sec) {
  if (btn._iv) { clearInterval(btn._iv); btn._iv = null; btn.textContent = `⏱ ${sec ? sec + 's timer' : 'stopwatch'}`; wake(false); return; }
  const t0 = Date.now(); wake(true); beep(880, .15);
  btn._iv = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    if (sec) { const left = sec - el; btn.textContent = `■ ${Math.ceil(Math.max(0, left))}s`; if (left <= 0) { clearInterval(btn._iv); btn._iv = null; beep(1000, .5); vib([300, 100, 300]); btn.textContent = `⏱ ${sec}s timer`; wake(false); } }
    else btn.textContent = `■ ${Math.floor(el)}s (tap to stop)`;
  }, 250);
}
let actx = null;
function beep(freq = 880, dur = .2) {
  try { actx ||= new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = freq; o.connect(g); g.connect(actx.destination); g.gain.setValueAtTime(.25, actx.currentTime); g.gain.exponentialRampToValueAtTime(.001, actx.currentTime + dur); o.start(); o.stop(actx.currentTime + dur); } catch { }
}
const vib = p => { try { navigator.vibrate?.(p); } catch { } };
let wl = null;
async function wake(on) { try { if (on && 'wakeLock' in navigator) wl = await navigator.wakeLock.request('screen'); else if (!on && wl) { await wl.release(); wl = null; } } catch { } }
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // when a new version takes over, reload once so the new screens appear straight away
  const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => { });
}
if (!handleStravaReturn()) render();
if (configured()) syncNow();
