/* MTB Fitness 12-Week Home Programme - phone app (PWA)
 * Data lives in a private GitHub repo:  program.json, data/<person>.json, data/shared.json
 * Every record keeps a per-field timestamp map (_t) so phones and the PC sync script
 * merge field-by-field: newest edit wins, nothing else is overwritten.
 */
'use strict';
const APP_VERSION = '1.0.0';
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
    if (!P) await loadProgram();
    await syncFile(me(), true);
    await syncFile('shared', true);
    if (partner()) await syncFile(partner(), false);
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
const startISO = () => val('shared', 'settings', 'main', 'startDate') || P.start_date;
const weekStart = w => iso(addDays(parseISO(startISO()), (w - 1) * 7));
const sessDate = s => iso(addDays(parseISO(startISO()), (s.week - 1) * 7 + s.day_offset));
function curWeek() { const d = Math.floor((parseISO(todayISO()) - parseISO(startISO())) / 864e5); return d < 0 ? 0 : d >= 84 ? 13 : Math.floor(d / 7) + 1; }
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
function setsFor(s) {
  const out = [];
  for (const pe of plan(s.plan_id).exercises) for (let n = 1; n <= pe.sets; n++) out.push({ id: `${s.id}-${pe.order}-S${n}`, pe, n });
  return out;
}
const status = (who, sid) => val(who, 'sessions', sid, 'status');
function chip(who, sid) {
  const st = status(who, sid) || '—';
  return `<span class="chip ${esc(st)} ${who === me() ? 'me' : ''}">${esc(cap(who))}: ${esc(st)}</span>`;
}
function setsDone(who, s) { return setsFor(s).filter(x => val(who, 'sets', x.id, 'done')).length; }
const restTxt = s => !s ? '0 (superset)' : (s >= 60 ? Math.floor(s / 60) + 'm' : '') + (s % 60 ? ' ' + (s % 60) + 's' : '');

/* ---------------- views ---------------- */
const view = () => $('#view');
function header() {
  if (!P) { $('#weekInfo').innerHTML = ''; return; }
  const w = curWeek(); const s = P.sessions.find(x => x.week === clampW(w));
  $('#weekInfo').innerHTML = w === 0 ? `Starts <b>${fmt(startISO())}</b><br>${cap(me())}` :
    w > 12 ? `<b>Programme complete</b><br>${cap(me())}` : `<b>Week ${w}</b> · ${esc(s.phase)}<br>${esc(s.block)} · ${cap(me())}`;
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
  <div class="card"><p>This app logs the MTB Fitness 12-week home programme for <b>Lynn</b> and <b>Jarom</b> and keeps both phones and the Excel tracker in sync through your private GitHub repo.</p>
  <p class="sub">See <b>SETUP.md</b> in the MTB Fitness folder for the one-time steps (create the repo, run the PC sync with --init, make a token).</p>
  <a class="btn block" href="#settings">Set up this phone</a></div>`;
}

function sessionCard(s, opts = {}) {
  const d = sessDate(s); const isT = d === todayISO();
  const href = s.type === 'HIIT' ? `#hiit/${s.id}` : `#session/${s.id}`;
  let extra = '';
  if (s.type === 'Bodyweight') { const tot = setsFor(s).length; extra = `<span class="sub"> · ${setsDone(me(), s)}/${tot} sets</span>`; }
  else { const iv = interval(s.week); extra = `<span class="sub"> · ${iv.reps}× ${iv.work_sec}s/${iv.rest_sec}s</span>`; }
  return `<a class="card sess ${isT ? 'today' : ''}" href="${href}">
    <div class="day d-${s.suggested_day}">${s.suggested_day}<small>${fmt(d, { month: 'numeric', day: 'numeric' })}</small></div>
    <div class="grow"><h3>${s.type === 'HIIT' ? 'HIIT ' + s.n + ' · ' + esc(interval(s.week).focus) : 'Bodyweight ' + s.n + ' of 3'}</h3>
    <div class="sub">${esc(s.type === 'HIIT' ? 'Gym bike / elliptical' : s.label)}${extra}</div>
    <div>${chip(me(), s.id)}${partner() ? chip(partner(), s.id) : ''}</div></div></a>`;
}
function vToday() {
  const t = todayISO(); const w = curWeek();
  const todays = P.sessions.filter(s => sessDate(s) === t);
  const dow = DAYS[(new Date().getDay() + 6) % 7];
  let html = `<h1>${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h1>`;
  if (w === 0) html += `<div class="card">Programme starts <b>${fmt(startISO(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</b> (${Math.ceil((parseISO(startISO()) - parseISO(t)) / 864e5)} days). Preview week 1 below.</div>`;
  if (w > 12) html += `<div class="card">🎉 12 weeks done. Check <a href="#progress">Progress</a>.</div>`;
  if (todays.length) html += `<h2>Today's workout</h2>` + todays.map(s => sessionCard(s)).join('');
  else if (w >= 1 && w <= 12) html += `<div class="card"><h3>${dow === 'Thu' ? 'Rest day 😴' : dow === 'Sun' ? 'MTB ride day 🚵' : 'No session scheduled'}</h3><div class="sub">${dow === 'Sun' ? '<a href="#ride/new">Log a ride</a>' : 'Catch up on a missed session from this week if needed.'}</div></div>`;
  // stretches today
  const sd = (w >= 1 && w <= 12) ? t : startISO();
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
    P.sessions.filter(s => s.week === w).map(s => sessionCard(s)).join('') +
    `<div class="card sess"><div class="day d-Thu">Thu</div><div class="grow"><h3>Rest</h3></div></div>
     <a class="card sess" href="#rides"><div class="day d-Sun">Sun</div><div class="grow"><h3>MTB ride</h3><div class="sub">Log rides on the Rides tab</div></div></a>`;
}

/* ----- bodyweight session ----- */
function vSession(id) {
  const s = P._sess[id]; if (!s) return vToday();
  const pl = plan(s.plan_id); const pt = partner();
  let html = `<a href="#week/${s.week}" class="sub">‹ Week ${s.week}</a>
  <h1>Bodyweight ${s.n} of 3</h1><div class="sub">${esc(s.label)} · suggested ${fmt(sessDate(s))}</div>
  <div class="card grid2">
    <div><label class="f">Date done (shared)</label><input type="date" data-f="shared|sessions|${id}|dateDone" value="${esc(val('shared', 'sessions', id, 'dateDone') || '')}"></div>
    <div><label class="f">My status</label>${selectHtml(`${me()}|sessions|${id}|status`, P.status_options, status(me(), id))}</div>
  </div>`;
  for (const pe of pl.exercises) {
    const ex = exById(pe.exercise_id); const secs = pe.target_type === 'seconds';
    html += `<div class="card ex"><h3><span class="sub">${pe.order}</span> <a href="${esc(ex.video_url)}" target="_blank" rel="noopener">${esc(ex.name)}</a></h3>
      <div class="meta">${pe.sets} sets × <b>${esc(pe.target)}</b>${pe.per_side ? ' ' + esc(pe.per_side) : ''} · book rest ${restTxt(pe.rest_sec)}${ex.equipment !== 'Bodyweight' ? ' · ' + esc(ex.equipment) : ''}
      ${secs ? `<button class="timerbtn" data-hold="${pe.target_max || 0}">⏱ ${pe.target_max ? pe.target_max + 's timer' : 'stopwatch'}</button>` : ''}</div>`;
    for (let n = 1; n <= pe.sets; n++) {
      const lid = `${id}-${pe.order}-S${n}`; const k = `${me()}|sets|${lid}`;
      const done = !!val(me(), 'sets', lid, 'done');
      html += `<div class="set"><div class="n">${n}</div>
        <input inputmode="numeric" placeholder="${secs ? 'secs' : 'reps'}" data-f="${k}|${secs ? 'secs' : 'reps'}" data-num value="${esc(val(me(), 'sets', lid, secs ? 'secs' : 'reps') ?? '')}">
        ${selectHtml(`${k}|band`, P.band_options, val(me(), 'sets', lid, 'band'), 'band')}
        <button class="done ${done ? 'on' : ''}" data-done="${lid}" data-rest="${pe.rest_sec}">✓</button>`;
      if (pt) {
        const r = rec(pt, 'sets', lid);
        if (r && (r.reps != null || r.secs != null || r.done || r.band)) html += `<div class="partner ${pt}">${cap(pt)}: ${r.reps ?? r.secs ?? '–'}${r.secs != null ? 's' : ''}${r.band ? ' · ' + esc(r.band) : ''}${r.done ? ' ✓' : ''}</div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  html += `<div class="card"><div class="grid2">
    <div><label class="f">Duration min (shared)</label><input inputmode="numeric" data-num data-f="shared|sessions|${id}|duration" value="${esc(val('shared', 'sessions', id, 'duration') ?? '')}"></div>
    <div><label class="f">My RPE (1-10)</label>${selectHtml(`${me()}|sessions|${id}|rpe`, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], val(me(), 'sessions', id, 'rpe'))}</div></div>
    <label class="f">Session notes (shared)</label><textarea data-f="shared|sessions|${id}|notes">${esc(val('shared', 'sessions', id, 'notes') || '')}</textarea>
    <button class="btn block" data-finish="${id}">Finish workout ✓</button></div>`;
  view().innerHTML = html;
}
function selectHtml(key, opts, cur, ph) {
  return `<select data-f="${key}"><option value="">${ph || '–'}</option>${opts.map(o => `<option ${String(o) === String(cur ?? '') ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
}

/* ----- HIIT ----- */
let H = null; // running interval timer
function vHiit(id) {
  const s = P._sess[id]; if (!s) return vToday();
  const iv = interval(s.week); const k = `${me()}|hiit|${id}`; const v = f => esc(val(me(), 'hiit', id, f) ?? '');
  const pt = partner(); const pr = pt && rec(pt, 'hiit', id);
  view().innerHTML = `<a href="#week/${s.week}" class="sub">‹ Week ${s.week}</a>
  <h1>HIIT ${s.n} · ${esc(iv.focus)}</h1><div class="sub">Week ${s.week} · suggested ${fmt(sessDate(s))}</div>
  <div class="card"><b>${iv.reps} × ${iv.work_sec}s work / ${iv.rest_sec}s rest</b> · target ${esc(iv.target_rpm)} (bike)<div class="sub mt">${esc(iv.how_to)}</div>
  <div class="sub">On the elliptical, match the effort and track the resistance level.</div></div>
  <div class="hiitbox" id="hbox"><div class="phase" id="hphase">READY</div><div class="big" id="htime">${clock(iv.work_sec)}</div>
   <div class="center sub" id="hrep">Interval 0 of ${iv.reps}</div>
   <div class="grid3 mt"><button class="btn" id="hstart">Start</button><button class="btn sec" id="hpause">Pause</button><button class="btn sec" id="hstop">Stop</button></div></div>
  <div class="card">
   <div class="grid2"><div><label class="f">Date done (shared)</label><input type="date" data-f="shared|sessions|${id}|dateDone" value="${esc(val('shared', 'sessions', id, 'dateDone') || '')}"></div>
   <div><label class="f">My status</label>${selectHtml(`${me()}|sessions|${id}|status`, P.status_options, status(me(), id))}</div></div>
   <div class="grid2"><div><label class="f">Machine</label>${selectHtml(`${k}|machine`, P.machine_options, val(me(), 'hiit', id, 'machine'))}</div>
   <div><label class="f">Intervals completed</label><input inputmode="numeric" data-num id="hcomp" data-f="${k}|intervals" value="${v('intervals')}"></div></div>
   <div class="grid3"><div><label class="f">Work resist.</label><input inputmode="decimal" data-num data-f="${k}|workRes" value="${v('workRes')}"></div>
   <div><label class="f">Rest resist.</label><input inputmode="decimal" data-num data-f="${k}|restRes" value="${v('restRes')}"></div>
   <div><label class="f">Avg RPM/SPM</label><input inputmode="numeric" data-num data-f="${k}|avgRpm" value="${v('avgRpm')}"></div></div>
   <div class="grid3"><div><label class="f">Avg HR</label><input inputmode="numeric" data-num data-f="${k}|avgHr" value="${v('avgHr')}"></div>
   <div><label class="f">Max HR</label><input inputmode="numeric" data-num data-f="${k}|maxHr" value="${v('maxHr')}"></div>
   <div><label class="f">RPE</label>${selectHtml(`${k}|rpe`, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], val(me(), 'hiit', id, 'rpe'))}</div></div>
   <label class="f">Total time min (shared)</label><input inputmode="numeric" data-num data-f="shared|hiit|${id}|totalTime" value="${esc(val('shared', 'hiit', id, 'totalTime') ?? '')}">
   <label class="f">Notes (shared)</label><textarea data-f="shared|hiit|${id}|notes">${esc(val('shared', 'hiit', id, 'notes') || '')}</textarea>
   ${pr ? `<div class="partner ${pt} mt">${cap(pt)}: ${esc(pr.machine || '')} ${pr.intervals != null ? pr.intervals + '/' + iv.reps + ' intervals' : ''} ${pr.avgHr ? '· avg HR ' + pr.avgHr : ''}</div>` : ''}
   <button class="btn block" data-finish="${id}">Finish HIIT ✓</button></div>`;
  const st = $('#hstart'), pa = $('#hpause'), sp = $('#hstop');
  st.onclick = () => hiitStart(id, iv); pa.onclick = () => { if (H) { H.paused = !H.paused; pa.textContent = H.paused ? 'Resume' : 'Pause'; } };
  sp.onclick = () => hiitEnd(true);
  if (H && H.id === id) paintHiit();
}
const clock = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
function hiitStart(id, iv) {
  if (H && !H.done) return;
  H = { id, iv, rep: 1, phase: 'WORK', left: iv.work_sec, paused: false, done: false, completed: 0 };
  beep(880, .25); vib(300); wake(true);
  H.tick = setInterval(() => {
    if (H.paused || H.done) return;
    H.left -= 1;
    if (H.left <= 3 && H.left > 0) beep(660, .08);
    if (H.left <= 0) {
      if (H.phase === 'WORK') { H.completed = H.rep; if (H.rep >= iv.reps) return hiitEnd(false); H.phase = 'REST'; H.left = iv.rest_sec; beep(440, .4); vib([200, 100, 200]); }
      else { H.rep++; H.phase = 'WORK'; H.left = iv.work_sec; beep(880, .4); vib(400); }
    }
    paintHiit();
  }, 1000);
  paintHiit();
}
function hiitEnd(stopped) {
  if (!H) return; clearInterval(H.tick); H.done = true; H.phase = stopped ? 'STOPPED' : 'DONE'; wake(false);
  if (!stopped) { beep(1000, .6); vib([300, 100, 300, 100, 600]); }
  const cur = val(me(), 'hiit', H.id, 'intervals');
  if (H.completed && (cur == null || cur < H.completed)) setVal(me(), 'hiit', H.id, 'intervals', H.completed);
  paintHiit(); const c = $('#hcomp'); if (c) c.value = val(me(), 'hiit', H.id, 'intervals') ?? '';
}
function paintHiit() {
  const box = $('#hbox'); if (!box || !H) return;
  box.className = 'hiitbox ' + H.phase; $('#hphase').className = 'phase ' + H.phase;
  $('#hphase').textContent = H.phase === 'DONE' ? 'DONE 🎉' : H.phase;
  $('#htime').textContent = clock(H.done ? 0 : H.left);
  $('#hrep').textContent = `Interval ${H.done ? H.completed : H.rep} of ${H.iv.reps}`;
}

/* ----- stretches ----- */
function vStretch(d) {
  const w = curWeek();
  d = d || ((w >= 1 && w <= 12) ? todayISO() : startISO());
  const arr = val(me(), 'stretch', d, 's') || Array(9).fill(false);
  const parr = partner() ? (val(partner(), 'stretch', d, 's') || []) : [];
  const ids = P.stretches.exercise_ids;
  view().innerHTML = `<div class="row"><a class="btn sec small" href="#stretch/${iso(addDays(parseISO(d), -1))}">‹</a>
   <div class="grow center"><h1>Stretches</h1><div class="sub">${fmt(d, { weekday: 'long', month: 'short', day: 'numeric' })}</div></div>
   <a class="btn sec small" href="#stretch/${iso(addDays(parseISO(d), 1))}">›</a></div>
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
     <div class="grow"><h3>${esc(r.route || 'Ride')}</h3><div class="sub">${esc(r.rider || '')} · ${r.miles ?? '–'} mi · ${r.elev ?? '–'} ft · ${r.time ?? '–'} min</div></div></a>`).join('') : '<p class="sub center mt">No rides logged yet.</p>'}`;
}
function vRide(id) {
  if (id === 'new') { id = `R-${Date.now().toString(36)}-${me()}`; setVal('shared', 'rides', id, 'date', todayISO()); setVal('shared', 'rides', id, 'rider', cap(me())); history.replaceState(null, '', '#ride/' + id); }
  const k = `shared|rides|${id}`; const v = f => esc(val('shared', 'rides', id, f) ?? '');
  view().innerHTML = `<a href="#rides" class="sub">‹ Rides</a><h1>Ride</h1><div class="card">
   <div class="grid2"><div><label class="f">Date</label><input type="date" data-f="${k}|date" value="${v('date')}"></div>
   <div><label class="f">Rider</label>${selectHtml(`${k}|rider`, ['Lynn', 'Jarom', 'Both'], val('shared', 'rides', id, 'rider'))}</div></div>
   <label class="f">Trail / route</label><input data-f="${k}|route" value="${v('route')}">
   <div class="grid3"><div><label class="f">Miles</label><input inputmode="decimal" data-num data-f="${k}|miles" value="${v('miles')}"></div>
   <div><label class="f">Elev gain ft</label><input inputmode="numeric" data-num data-f="${k}|elev" value="${v('elev')}"></div>
   <div><label class="f">Moving min</label><input inputmode="numeric" data-num data-f="${k}|time" value="${v('time')}"></div></div>
   <div class="grid3"><div><label class="f">Avg HR</label><input inputmode="numeric" data-num data-f="${k}|avgHr" value="${v('avgHr')}"></div>
   <div><label class="f">Max HR</label><input inputmode="numeric" data-num data-f="${k}|maxHr" value="${v('maxHr')}"></div>
   <div><label class="f">RPE</label>${selectHtml(`${k}|rpe`, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], val('shared', 'rides', id, 'rpe'))}</div></div>
   <label class="f">Notes</label><textarea data-f="${k}|notes">${v('notes')}</textarea>
   <a class="btn block" href="#rides">Save</a><button class="btn block danger" data-delride="${id}">Delete ride</button></div>`;
}

/* ----- progress ----- */
function weekStats(who, w) {
  const ss = P.sessions.filter(s => s.week === w);
  const bw = ss.filter(s => s.type === 'Bodyweight'), hi = ss.filter(s => s.type === 'HIIT');
  const planned = bw.reduce((a, s) => a + setsFor(s).length, 0), done = bw.reduce((a, s) => a + setsDone(who, s), 0);
  let st = 0; for (let i = 0; i < 7; i++) { const d = iso(addDays(parseISO(weekStart(w)), i)); if ((val(who, 'stretch', d, 's') || []).filter(Boolean).length === 9) st++; }
  const rideN = rides().filter(([, r]) => { const dd = Math.floor((parseISO(r.date) - parseISO(weekStart(w))) / 864e5); return dd >= 0 && dd < 7 && (r.rider === 'Both' || (r.rider || '').toLowerCase() === who); }).length;
  return { bw: bw.filter(s => status(who, s.id) === 'Done').length, hi: hi.filter(s => status(who, s.id) === 'Done').length, pct: planned ? Math.round(done / planned * 100) : 0, st, rides: rideN };
}
function vProgress() {
  const ws = [...Array(12)].map((_, i) => i + 1); const pt = partner();
  const cell = (v, full, cls) => `<td class="${cls} ${v >= full ? 'full' : ''}">${v}</td>`;
  view().innerHTML = `<h1>Progress</h1><div class="sub">Bodyweight /3 · HIIT /2 · sets % · stretch days /7 · rides. <span style="color:var(--acc2)">${cap(me())}</span>${pt ? ` vs <span style="color:var(--jarom)">${cap(pt)}</span>` : ''}</div>
  <div class="card"><table class="prog"><tr><th>Wk</th><th>BW</th><th>HIIT</th><th>Sets</th><th>Str</th><th>Ride</th>${pt ? '<th>BW</th><th>HIIT</th><th>Sets</th><th>Str</th><th>Ride</th>' : ''}</tr>
  ${ws.map(w => { const a = weekStats(me(), w), b = pt && weekStats(pt, w);
    return `<tr><td><a href="#week/${w}">${w}</a></td>${cell(a.bw, 3, 'me')}${cell(a.hi, 2, 'me')}${cell(a.pct, 100, 'me')}${cell(a.st, 7, 'me')}${cell(a.rides, 99, 'me')}
    ${b ? cell(b.bw, 3, 'pt') + cell(b.hi, 2, 'pt') + cell(b.pct, 100, 'pt') + cell(b.st, 7, 'pt') + cell(b.rides, 99, 'pt') : ''}</tr>`; }).join('')}</table></div>`;
}

/* ----- settings ----- */
function vSettings() {
  view().innerHTML = `<h1>Settings</h1><div class="card">
   <label class="f">Who is using this phone?</label><select id="sMe"><option value="">Choose…</option>${['lynn', 'jarom'].map(p => `<option value="${p}" ${cfg.me === p ? 'selected' : ''}>${cap(p)}</option>`).join('')}</select>
   <label class="f">GitHub username (repo owner)</label><input id="sOwner" autocapitalize="off" autocorrect="off" value="${esc(cfg.owner)}">
   <label class="f">Private data repo name</label><input id="sRepo" autocapitalize="off" autocorrect="off" value="${esc(cfg.repo)}">
   <label class="f">GitHub token (fine-grained, Contents: read & write on that repo only)</label><input id="sTok" type="password" autocomplete="off" value="${esc(cfg.token)}">
   <label class="f">Default rest timer between sets (seconds)</label><input id="sRest" inputmode="numeric" value="${esc(cfg.restSec)}">
   <details class="mt"><summary class="sub">Advanced</summary><label class="f">API base URL</label><input id="sApi" autocapitalize="off" value="${esc(cfg.api)}"></details>
   <button class="btn block" id="sSave">Save & sync</button></div>
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
    try { await loadProgram(); prep(); await syncNow(true); location.hash = '#today'; render(); } catch (e) { toast(e.message); syncState.err = e.message; paintSync(); }
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
  setVal(file_, coll, key, field, v === '' ? null : v);
  if (coll === 'sets' && v !== '' && v !== null && field !== 'band') autoDate(key.split('-').slice(0, 2).join('-'));
  if (field === 'status' && v === 'Done') autoDate(key);
});
document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.done) {
    const lid = t.dataset.done; const on = !val(me(), 'sets', lid, 'done');
    setVal(me(), 'sets', lid, 'done', on ? true : null); t.classList.toggle('on', on);
    if (on) { autoDate(lid.split('-').slice(0, 2).join('-')); startRest(cfg.restSec || 60); vib(40); }
  } else if (t.dataset.finish) {
    const id = t.dataset.finish; setVal(me(), 'sessions', id, 'status', 'Done'); autoDate(id); toast('Nice work! 💪'); location.hash = '#today';
  } else if (t.dataset.stretch) {
    const [d, i] = t.dataset.stretch.split('|'); const arr = [...(val(me(), 'stretch', d, 's') || Array(9).fill(false))];
    arr[+i] = !arr[+i]; setVal(me(), 'stretch', d, 's', arr); t.classList.toggle('on', arr[+i]);
  } else if (t.dataset.stretchall) {
    setVal(me(), 'stretch', t.dataset.stretchall, 's', Array(9).fill(true)); render();
  } else if (t.dataset.delride) {
    if (confirm('Delete this ride?')) { setVal('shared', 'rides', t.dataset.delride, 'deleted', true); location.hash = '#rides'; }
  } else if (t.dataset.rest) {
    if (t.dataset.rest === 'skip') stopRest(); else if (rest) rest.end += 15000;
  } else if (t.dataset.hold !== undefined) {
    holdTimer(t, +t.dataset.hold);
  }
});
function autoDate(sid) { if (P._sess[sid] && !val('shared', 'sessions', sid, 'dateDone')) { setVal('shared', 'sessions', sid, 'dateDone', todayISO()); const i = document.querySelector(`[data-f="shared|sessions|${sid}|dateDone"]`); if (i) i.value = todayISO(); } }
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

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => { });
render();
if (configured()) syncNow();
