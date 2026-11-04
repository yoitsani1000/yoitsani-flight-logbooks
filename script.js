/* ===================== CLOUD SYNC (SUPABASE) ===================== */
//
// Fill these in ONCE, then redeploy, and every device will auto-connect —
// no more typing the URL/key in on each new phone or browser.
//
// This is safe in the way Supabase is designed to be used: the "anon" key
// is meant to be public/client-visible — it is NOT a secret like a service
// role key. The real access boundary is your Row Level Security (RLS)
// policy on the `flights` table, not whether this key is hidden.
//
// What hardcoding it here actually changes: right now the key only lived
// in your own browser's local storage. Baking it into this file means it
// ships inside script.js — so if your GitHub repo is PUBLIC, anyone could
// find it by reading the repo or your live site's JS. If your repo is
// private, exposure is limited to anyone who opens dev tools on your own
// deployed site (which they could do either way, since it's still
// client-side JS — there's no way to truly hide a credential in a static
// site without a backend).
//
// Access is enforced by Supabase Auth plus Row Level Security (see
// supabase_auth_setup.sql). Signing in gives each person a session token;
// the database only lets the owner write and lets any signed-in user read.
// Nothing in this file grants access on its own.
//
const DEFAULT_SUPABASE_URL = 'https://zdwmjlfkctlcjcdxwhbu.supabase.co';   // <-- paste your Supabase project URL here, e.g. 'https://xxxx.supabase.co'
const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpkd21qbGZrY3RsY2pjZHh3aGJ1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1ODk2MzUsImV4cCI6MjA5ODE2NTYzNX0.r3R3QNYbJ5RRThraXIARtUMIwHmvXK9QjOw-6Ugi3iw';   // <-- paste your anon public key here

const CLOUD_KEY = 'flightlog_cloud_cfg';
let cloudCfg = JSON.parse(localStorage.getItem(CLOUD_KEY) || 'null');
if(!cloudCfg && DEFAULT_SUPABASE_URL && DEFAULT_SUPABASE_KEY){
  cloudCfg = { url: DEFAULT_SUPABASE_URL, key: DEFAULT_SUPABASE_KEY };
}
let supa = null;

function initCloud(){
  if(cloudCfg && cloudCfg.url && cloudCfg.key && window.supabase){
    try{
      supa = window.supabase.createClient(cloudCfg.url, cloudCfg.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
    }
    catch(e){ supa = null; }
  }
  setLamp(supa ? 'idle' : 'offline');
}

function setLamp(state){
  const lamp = document.getElementById('lamp');
  if(!lamp) return;
  lamp.className = 'lamp lamp-' + state;
}

function toRow(f){
  return {
    id:f.id, dep:f.dep, arr:f.arr, flight_num:f.flightNum, date:f.date,
    elapsed:f.elapsed, landing_rate:f.landingRate, landing_g:f.landingG,
    aircraft:f.aircraft, notes:f.notes||'', shared_cockpit:!!f.sharedCockpit,
    role:f.role||'', exclude_from_avg:!!f.excludeFromAvg,
    windshear: false, // kept for schema compat — column still exists in Supabase table
    sva:!!f.sva, tfp:f.tfp||null, rank:f.rank||'', updated_at:f.updatedAt || new Date().toISOString()
  };
}
function fromRow(r){
  if(!r || !r.id) return null;
  return {
    id:r.id,
    dep:r.dep||'', arr:r.arr||'', flightNum:r.flight_num||'',
    date: r.date ? String(r.date).slice(0,10) : '',
    elapsed: parseFloat(r.elapsed)||0,
    landingRate: parseFloat(r.landing_rate)||0,
    landingG: parseFloat(r.landing_g)||0,
    aircraft:r.aircraft||'', notes:r.notes||'',
    sharedCockpit:!!r.shared_cockpit,
    role:r.role||'', excludeFromAvg:!!r.exclude_from_avg,
    sva:!!r.sva, tfp:r.tfp!=null?parseFloat(r.tfp):null, rank:r.rank||'',
    updatedAt: r.updated_at || ''
  };
}

function ts(v){ const t = Date.parse(v || ''); return isNaN(t) ? 0 : t; }

async function syncNow(){
  if(!supa) return { ok:false, msg:'Not connected. Add your Supabase credentials in the Data tab.' };
  setLamp('syncing');
  try{
    // Only the owner may write. Viewers pull and never push.
    const isOwner = getRole() === 'owner';
    // Order matters: read the cloud first so deletions made on other devices
    // are applied BEFORE this device pushes, otherwise a stale device would
    // resurrect rows that were deleted elsewhere.
    const { data, error: selErr } = await supa.from('flights').select('*');
    if(selErr) throw selErr;
    const cloud = new Map();
    (data||[]).forEach(r=>{ if(r && r.id) cloud.set(r.id, r); });

    // 1. Apply deletions made on other devices (soft-deleted rows in the cloud).
    const before = DB.flights.length;
    DB.flights = DB.flights.filter(f=>{ const r = cloud.get(f.id); return !(r && r.deleted_at); });
    const removed = before - DB.flights.length;

    // 2. Push deletions made on this device.
    const tombIds = new Set(DB.deleted.map(t=>t.id));
    let deletedPushed = 0;
    if(isOwner && tombIds.size){
      const { error: delErr } = await supa.from('flights')
        .update({ deleted_at: new Date().toISOString() })
        .in('id', [...tombIds]);
      if(delErr) throw delErr;
      deletedPushed = tombIds.size;
      DB.deleted = [];
      saveData();
    }

    // 3. Pull new rows and newer versions of existing rows.
    const indexById = new Map(DB.flights.map((f,i)=>[f.id,i]));
    let pulled = 0, updated = 0;
    cloud.forEach((r,id)=>{
      if(r.deleted_at || tombIds.has(id)) return;
      const remote = fromRow(r);
      if(!remote) return;
      if(!indexById.has(id)){
        DB.flights.push(remote);
        pulled++;
      }else{
        const i = indexById.get(id);
        if(ts(remote.updatedAt) > ts(DB.flights[i].updatedAt)){
          DB.flights[i] = remote;
          updated++;
        }
      }
    });

    // 4. Push only rows that are missing from the cloud or newer locally.
    const toPush = !isOwner ? [] : DB.flights.filter(f=>{
      const r = cloud.get(f.id);
      return !r || ts(f.updatedAt) > ts(r.updated_at);
    });
    toPush.forEach(f=>{ if(!f.updatedAt) f.updatedAt = new Date().toISOString(); });
    if(toPush.length){
      const { error: upErr } = await supa.from('flights').upsert(toPush.map(toRow), { onConflict:'id' });
      if(upErr) throw upErr;
    }

    saveData();
    setLamp('online');
    const parts = isOwner ? [`pushed ${toPush.length}`, `pulled ${pulled} new`] : [`pulled ${pulled} new`];
    if(updated) parts.push(`updated ${updated}`);
    if(removed) parts.push(`removed ${removed} deleted elsewhere`);
    if(deletedPushed) parts.push(`deleted ${deletedPushed} in cloud`);
    return { ok:true, msg:`Synced: ${parts.join(', ')}. Total: ${DB.flights.length} flights.` };
  }catch(err){
    setLamp('error');
    return { ok:false, msg:'Sync failed: ' + describeError(err) };
  }
}

/* ===================== STORAGE ===================== */
const STORE_KEY = 'flightlog_data_v1';

// DB shape: { flights: [...], deleted: [{id, deletedAt}] }
// `deleted` holds local deletions not yet pushed to the cloud (tombstones).
function normalizeDB(d){
  if(!d || !Array.isArray(d.flights)) return { flights: [], deleted: [] };
  if(!Array.isArray(d.deleted)) d.deleted = [];
  return d;
}

function loadData(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw) return normalizeDB(JSON.parse(raw));
  }catch(e){}
  return normalizeDB(null);
}
function saveData(){ localStorage.setItem(STORE_KEY, JSON.stringify(DB)); }

let DB = loadData();

/* ===================== HELPERS ===================== */
const RANKS = ['NEW HIRE','IOE PILOT','JUNIOR FIRST OFFICER','FIRST OFFICER','SENIOR FIRST OFFICER'];

function uid(){ return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

// Escape anything user-controlled before it goes into innerHTML.
function esc(v){
  return String(v==null ? '' : v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// Mark a string as trusted markup so tableHtml() leaves it alone.
function raw(html){ return { html }; }

function fmt(n, d=1){ return (Math.round(n*Math.pow(10,d))/Math.pow(10,d)).toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d}); }

function svaFlights(){ return DB.flights.filter(f=>f.sva); }
function generalFlights(){ return DB.flights; }

function avgExcl(list, key){
  const vals = list.filter(f=>!f.excludeFromAvg).map(f=>f[key]).filter(v=>typeof v==='number'&&!isNaN(v));
  if(!vals.length) return null;
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}

function statsFor(list){
  if(!list.length){
    return {hours:0,flights:0,worstRate:null,bestRate:null,highG:null,lowG:null,dests:0,longest:0,shortest:0,avgRate:null,avgG:null};
  }
  const rates = list.map(f=>f.landingRate);
  const gs = list.map(f=>f.landingG);
  const elapsed = list.map(f=>f.elapsed);
  const airports = new Set();
  list.forEach(f=>{ airports.add(f.dep); airports.add(f.arr); });
  return {
    hours: list.reduce((a,f)=>a+f.elapsed,0),
    flights: list.length,
    worstRate: Math.min(...rates),
    bestRate: Math.max(...rates),
    highG: Math.max(...gs),
    lowG: Math.min(...gs),
    dests: airports.size,
    longest: Math.max(...elapsed),
    shortest: Math.min(...elapsed),
    avgRate: avgExcl(list,'landingRate'),
    avgG: avgExcl(list,'landingG')
  };
}

function airportCounts(list){
  const counts = {};
  list.forEach(f=>{
    counts[f.dep] = (counts[f.dep]||0)+1;
    counts[f.arr] = (counts[f.arr]||0)+1;
  });
  return Object.entries(counts).sort((a,b)=>b[1]-a[1]);
}

function isFlagged(f){
  return !!(f.excludeFromAvg || (f.notes && f.notes.trim()));
}
function pointColor(f){
  if(f.excludeFromAvg) return getCss('--rose');
  if(f.notes && f.notes.trim()) return getCss('--accent');
  return getCss('--steel');
}
function getCss(varName){
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

/* ===================== ROUTER ===================== */
const view = document.getElementById('view');
const tabs = document.querySelectorAll('.tab');
let charts = {};

tabs.forEach(t=>t.addEventListener('click', ()=>route(t.dataset.tab)));

const TAB_NAMES = { dashboard:'Dashboard', sva:'Southwest Virtual', add:'Log flight', logbook:'Logbook', data:'Data' };
const OWNER_ONLY_TABS = ['add','data'];

/* ===================== AUTH =====================
   Supabase Auth (email and password) is the real gate. The owner account is
   marked with app_metadata.role = 'owner' (set once in SQL, and users cannot
   edit it). Any other signed-in account is a viewer: read-only.
   The last known identity is cached so the app still opens offline; that cache
   only controls what the screen shows. The database enforces the real rules. */
const AUTH_CACHE_KEY = 'flightlog_auth_cache';
let authState = null; // { email, role: 'owner' | 'viewer', offline } or null when signed out

function getRole(){ return authState ? authState.role : null; }

function roleFromUser(user){
  return user && user.app_metadata && user.app_metadata.role === 'owner' ? 'owner' : 'viewer';
}
function readAuthCache(){
  try{
    const c = JSON.parse(localStorage.getItem(AUTH_CACHE_KEY) || 'null');
    return c && (c.role === 'owner' || c.role === 'viewer') ? c : null;
  }catch(e){ return null; }
}
function writeAuthCache(state){
  try{
    if(state) localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ email: state.email, role: state.role }));
    else localStorage.removeItem(AUTH_CACHE_KEY);
  }catch(e){}
}
function applyAuth(state){
  authState = state;
  document.body.dataset.auth = state ? state.role : 'out';
  const btn = document.getElementById('lockBtn');
  if(btn && state){
    const who = state.email ? 'Signed in as ' + state.email + '. ' : '';
    btn.title = who + 'Sign out';
  }
}
function isOfflineError(e){
  return !!e && (e.name === 'AuthRetryableFetchError' || /fetch|network|timed? ?out|offline/i.test(e.message || ''));
}

async function initAuth(){
  const cached = readAuthCache();
  const offlineState = cached ? { ...cached, offline: true } : null;
  if(!supa){ applyAuth(offlineState); return; }
  if(!initAuth._listening){
    initAuth._listening = true;
    // runs when the session ends (sign out, or the refresh token was rejected)
    supa.auth.onAuthStateChange(event=>{
      if(event === 'SIGNED_OUT' && authState && !authState.offline){
        writeAuthCache(null);
        applyAuth(null);
        route('dashboard');
      }
    });
  }
  try{
    const r = await Promise.race([
      supa.auth.getSession(),
      new Promise(resolve=> setTimeout(()=> resolve({ timedOut:true }), 4000))
    ]);
    if(r.timedOut || (r.error && isOfflineError(r.error))){ applyAuth(offlineState); return; }
    const session = r.data && r.data.session;
    if(session){
      const state = { email: session.user.email, role: roleFromUser(session.user), offline:false };
      writeAuthCache(state);
      applyAuth(state);
    }else{
      writeAuthCache(null);
      applyAuth(null);
    }
  }catch(e){
    applyAuth(isOfflineError(e) ? offlineState : null);
  }
}

async function signIn(email, password){
  if(!supa) return { ok:false, msg:'Sign-in needs the cloud library, which did not load. Check that the vendor folder was uploaded with the site.' };
  try{
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    if(error){
      if(isOfflineError(error)) return { ok:false, msg:'Cannot reach the server. Check your connection and try again.' };
      if(/invalid login/i.test(error.message || '')) return { ok:false, msg:'That email and password do not match.' };
      return { ok:false, msg: error.message || 'Sign-in failed.' };
    }
    const state = { email: data.user.email, role: roleFromUser(data.user), offline:false };
    writeAuthCache(state);
    applyAuth(state);
    return { ok:true };
  }catch(e){
    return { ok:false, msg: isOfflineError(e) ? 'Cannot reach the server. Check your connection and try again.' : describeError(e) };
  }
}

function clearStoredSession(){
  // supabase-js keeps its session under sb-<project>-auth-token
  try{
    Object.keys(localStorage).filter(k=> /^sb-.*-auth-token/.test(k)).forEach(k=> localStorage.removeItem(k));
  }catch(e){}
}

async function signOut(){
  try{
    if(supa){
      const { error } = await supa.auth.signOut();
      if(error) clearStoredSession(); // e.g. offline: the server call failed, so clear it here
    }else{
      clearStoredSession();
    }
  }catch(e){ clearStoredSession(); }
  writeAuthCache(null);
  applyAuth(null);
  route('dashboard');
  flashStatus('Signed out');
}

function route(name){
  const role = getRole();
  if(role && OWNER_ONLY_TABS.includes(name) && role !== 'owner') name = 'dashboard';

  tabs.forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
  Object.values(charts).forEach(c=>c && c.destroy());
  charts = {};
  view.innerHTML = '';

  if(!role){
    view.appendChild(document.getElementById('tpl-signin').content.cloneNode(true));
    renderSignIn();
    document.getElementById('statusLeft').textContent = 'Signed out';
    document.getElementById('statusRight').textContent = new Date().toISOString().slice(0,10);
    return;
  }

  const tpl = document.getElementById('tpl-'+name);
  view.appendChild(tpl.content.cloneNode(true));
  if(name==='dashboard') renderDashboard();
  if(name==='sva') renderSVA();
  if(name==='add') renderAddForm();
  if(name==='logbook') renderLogbook();
  if(name==='data') renderData();
  const roleTag = role === 'viewer' ? ' (view only)' : (authState.offline ? ' (offline)' : '');
  document.getElementById('statusLeft').textContent = TAB_NAMES[name] + ': ' + DB.flights.length + ' flights logged' + roleTag;
  document.getElementById('statusRight').textContent = new Date().toISOString().slice(0,10);
}

function renderSignIn(){
  const form = document.getElementById('signinForm');
  const email = document.getElementById('si-email');
  const pass = document.getElementById('si-pass');
  const msg = document.getElementById('signinMsg');
  const btn = document.getElementById('signinBtn');
  const card = form.closest('.signin-card') || form;

  form.addEventListener('submit', async e=>{
    e.preventDefault();
    msg.textContent = '';
    msg.classList.remove('error-text');
    if(!email.value.trim() || !pass.value){
      msg.textContent = 'Enter your email and password.';
      msg.classList.add('error-text');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    const res = await signIn(email.value.trim(), pass.value);
    if(!res.ok){
      btn.disabled = false;
      btn.textContent = 'Sign in';
      msg.textContent = res.msg;
      msg.classList.add('error-text');
      card.classList.add('shake');
      setTimeout(()=> card.classList.remove('shake'), 400);
      pass.value = '';
      pass.focus();
      return;
    }
    await pullAfterSignIn();
    route('dashboard');
  });
  email.focus();
}

/* ===================== RENDER HELPERS ===================== */
const MON3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const RANK_LABELS = {
  'NEW HIRE':'New hire',
  'IOE PILOT':'IOE pilot',
  'JUNIOR FIRST OFFICER':'Junior first officer',
  'FIRST OFFICER':'First officer',
  'SENIOR FIRST OFFICER':'Senior first officer'
};
function rankLabel(r){ return RANK_LABELS[r] || r || ''; }

// "2026-03-07" -> "07 Mar 2026" without any timezone conversion
function prettyDate(iso){
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]} ${MON3[+m[2]-1]} ${m[1]}` : (iso || '');
}

function fact(label, value, unit='', cls=''){
  return `<div class="fact ${cls}"><dt>${esc(label)}</dt><dd>${value}${unit ? `<small>${esc(unit)}</small>` : ''}</dd></div>`;
}

// Total time as a mechanical Hobbs meter: four white-on-black wheels, then a tenths wheel.
function renderHobbs(elId, hours){
  const el = document.getElementById(elId);
  if(!el) return;
  const [whole, tenth] = (hours || 0).toFixed(1).split('.');
  el.setAttribute('aria-label', `${fmt(hours || 0, 1)} hours`);
  el.innerHTML = whole.padStart(4, '0').split('').map(d=>`<span class="wheel">${d}</span>`).join('')
    + '<span class="hobbs-point"></span>'
    + `<span class="wheel tenth">${tenth}</span>`;
}

function landingFacts(s){
  return [
    fact('Average rate', s.avgRate!=null ? fmt(s.avgRate,0) : '—', 'fpm'),
    fact('Average G',    s.avgG!=null ? fmt(s.avgG,2) : '—', 'g'),
    fact('Best landing', s.bestRate!=null ? fmt(s.bestRate,0) : '—', 'fpm', 'good'),
    fact('Worst landing',s.worstRate!=null ? fmt(s.worstRate,0) : '—', 'fpm', 'bad'),
    fact('Highest G',    s.highG!=null ? fmt(s.highG,2) : '—', 'g', 'warn'),
    fact('Lowest G',     s.lowG!=null ? fmt(s.lowG,2) : '—', 'g', 'good')
  ].join('');
}

// Airport bars: top N, expandable.
function renderAirportBars(id, rows, limit){
  const el = document.getElementById(id);
  if(!el) return;
  if(!rows.length){ el.innerHTML = '<p class="empty">No flights logged yet.</p>'; return; }
  const max = rows[0][1];
  let shown = limit;
  function draw(){
    const bars = rows.slice(0, shown).map(([code, n])=>
      `<li><span class="bar-label">${esc(code)}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, Math.round(n/max*100))}%"></span></span><span class="bar-count">${n}</span></li>`
    ).join('');
    let btn = '';
    if(rows.length > limit){
      btn = `<button class="link-btn" type="button">${shown < rows.length ? `Show all ${rows.length} airports` : 'Show fewer'}</button>`;
    }
    el.innerHTML = `<ul class="bars">${bars}</ul>${btn}`;
    const b = el.querySelector('.link-btn');
    if(b) b.addEventListener('click', ()=>{ shown = shown < rows.length ? rows.length : limit; draw(); });
  }
  draw();
}

/* ---------- landing quality ----------
   One scale used everywhere: the spread bar, the rate chart's shaded zone
   and the colour of each rate in the logbook. */
const SPREAD = [
  { k:'smooth', label:'Smooth', note:'under 150 fpm', test:a=> a<=150 },
  { k:'normal', label:'Normal', note:'150 to 350 fpm', test:a=> a>150 && a<=350 },
  { k:'firm',   label:'Firm',   note:'350 to 500 fpm', test:a=> a>350 && a<=500 },
  { k:'hard',   label:'Hard',   note:'over 500 fpm',   test:a=> a>500 }
];
function rateClass(rate){
  const a = Math.abs(rate);
  if(isNaN(a)) return '';
  if(a <= 150) return 'r-smooth';
  if(a > 500) return 'r-hard';
  if(a > 350) return 'r-firm';
  return '';
}

function renderSpread(id, list){
  const el = document.getElementById(id);
  if(!el) return;
  const rows = list.filter(f=> !f.excludeFromAvg && isFinite(f.landingRate));
  if(!rows.length){ el.innerHTML = ''; return; }
  const counts = SPREAD.map(b=> rows.filter(f=> b.test(Math.abs(f.landingRate))).length);
  const total = rows.length;
  const pct = n => Math.round(n/total*100);
  const summary = SPREAD.map((b,i)=> `${counts[i]} ${b.label.toLowerCase()}`).join(', ');
  el.innerHTML =
    `<div class="spread-bar" role="img" aria-label="Landing quality of ${total} landings: ${summary}">`
      + SPREAD.map((b,i)=> counts[i] ? `<span class="seg seg-${b.k}" style="flex-grow:${counts[i]}"></span>` : '').join('')
    + '</div>'
    + '<ul class="spread-key">'
      + SPREAD.map((b,i)=>
          `<li><i class="sw sw-${b.k}"></i><span class="sk-name">${b.label}</span><b>${pct(counts[i])}%</b><small>${esc(b.note)}, ${counts[i]} landing${counts[i]===1?'':'s'}</small></li>`
        ).join('')
    + '</ul>';
}

function tableHtml(headers, rows){
  if(!rows.length) return '<p class="empty">No data yet.</p>';
  const cell = c => (c && typeof c === 'object' && 'html' in c) ? c.html : esc(c);
  return `<table><thead><tr>${headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r=>`<tr>${r.map(c=>`<td>${cell(c)}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}

/* ---------- charts ---------- */
function palette(){
  return {
    line:getCss('--line'), dim:getCss('--dim'), text:getCss('--text'), bg:getCss('--bg'),
    surface:getCss('--surface'), raised:getCss('--raised'),
    accent:getCss('--accent'), steel:getCss('--steel'), sky:getCss('--sky'),
    mint:getCss('--mint'), rose:getCss('--rose'), violet:getCss('--violet')
  };
}

// Returns false (and explains why in the page) when the Chart.js file did not load.
function chartsReady(canvasId){
  if(window.Chart){
    const P = palette();
    Chart.defaults.font.family = getCss('--sans');
    Chart.defaults.font.size = 12;
    Chart.defaults.color = P.dim;
    Chart.defaults.borderColor = P.line;
    return true;
  }
  const c = document.getElementById(canvasId);
  const box = c && c.parentElement;
  if(box && !box.dataset.failed){
    box.dataset.failed = '1';
    box.innerHTML = '<p class="empty">Charts could not load. Make sure the vendor folder was uploaded with the site.</p>';
  }
  return false;
}

function tooltipBase(P){
  return { backgroundColor:P.raised, titleColor:P.text, bodyColor:P.text, borderColor:P.line, borderWidth:1, padding:10, displayColors:false, cornerRadius:6 };
}
function dateTitle(items){
  return items.length ? formatUtcDate(new Date(items[0].parsed.x)).replace(/^\w+,\s*/,'') : '';
}

function sortedByDate(list){
  return [...list].sort((a,b)=> (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function buildScatter(canvasId, list, key, unitLabel){
  const ctx = document.getElementById(canvasId);
  if(!ctx || !chartsReady(canvasId)) return;
  const P = palette();
  const sorted = sortedByDate(list);
  const points = sorted.map(f=>({x:f.date, y:f[key]}));
  const colors = sorted.map(pointColor);
  // shade the smooth zone (0 to -150 fpm) on the landing-rate chart
  const smoothZone = {
    id:'smoothZone',
    beforeDatasetsDraw(chart){
      if(key !== 'landingRate') return;
      const { ctx:c, chartArea:a, scales:{y} } = chart;
      const top = Math.max(y.getPixelForValue(0), a.top);
      const bottom = Math.min(y.getPixelForValue(-150), a.bottom);
      if(bottom <= top) return;
      c.save();
      c.fillStyle = P.mint + '1c';
      c.fillRect(a.left, top, a.width, bottom - top);
      c.restore();
    }
  };
  charts[canvasId] = new Chart(ctx, {
    type:'line',
    plugins:[smoothZone],
    data:{ datasets:[{
      data: points,
      borderColor: P.steel + '66',
      backgroundColor: colors,
      pointBackgroundColor: colors,
      pointBorderWidth: 0,
      pointRadius: sorted.map(f=> isFlagged(f) ? 4 : 1.5),
      pointHoverRadius: sorted.map(f=> isFlagged(f) ? 6 : 3.5),
      borderWidth: 1.25,
      tension: 0
    }]},
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ ...tooltipBase(P), callbacks:{
        title: dateTitle,
        label: (c)=> `${c.parsed.y} ${unitLabel}`
      }}},
      scales:{
        x:{ type:'time', time:{unit:'month'}, ticks:{maxTicksLimit:6, maxRotation:0}, grid:{display:false}, border:{color:P.line} },
        y:{ grid:{color:P.line}, border:{display:false}, ticks:{maxTicksLimit:6} }
      }
    }
  });
}

function buildHoursBar(canvasId, list){
  const ctx = document.getElementById(canvasId);
  if(!ctx || !chartsReady(canvasId)) return;
  const P = palette();
  const map = {};
  list.forEach(f=>{
    const ym = (f.date||'').slice(0,7);
    if(ym) map[ym] = (map[ym]||0) + f.elapsed;
  });
  const keys = Object.keys(map).sort();
  charts[canvasId] = new Chart(ctx, {
    type:'bar',
    data:{ labels:keys.map(k=>`${MON3[+k.slice(5,7)-1]} ${k.slice(0,4)}`),
           datasets:[{ data:keys.map(k=>+map[k].toFixed(1)), backgroundColor:P.steel, hoverBackgroundColor:P.accent, borderRadius:2, maxBarThickness:28 }]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ ...tooltipBase(P), callbacks:{ label:(c)=> `${c.parsed.y} hours` } } },
      scales:{ x:{ grid:{display:false}, border:{color:P.line}, ticks:{maxTicksLimit:8, maxRotation:0} },
               y:{ grid:{color:P.line}, border:{display:false}, ticks:{maxTicksLimit:5} } } }
  });
}

function buildAircraftChart(canvasId, list){
  const ctx = document.getElementById(canvasId);
  if(!ctx || !chartsReady(canvasId)) return;
  const P = palette();
  const counts = {};
  list.forEach(f=>{ const ac = f.aircraft || 'Unknown'; counts[ac] = (counts[ac]||0)+1; });
  const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  const total = list.length || 1;
  const labels = entries.map(e=>e[0]);
  const values = entries.map(e=>e[1]);

  const base = [P.accent, P.sky, P.steel, P.mint, P.rose, P.violet];
  const colors = labels.map((_,i)=> i < base.length ? base[i] : `hsl(${(i*47)%360}, 45%, 60%)`);

  const sliceLabelPlugin = {
    id:'sliceLabel',
    afterDatasetsDraw(chart){
      const c = chart.ctx;
      c.save();
      c.font = `600 12px ${getCss('--cond')}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = P.bg;
      chart.getDatasetMeta(0).data.forEach((arc, i)=>{
        const pct = Math.round((values[i]/total)*100);
        if(pct < 6) return;
        const angle = (arc.startAngle + arc.endAngle) / 2;
        const radius = (arc.innerRadius + arc.outerRadius) / 2;
        c.fillText(`${pct}%`, arc.x + Math.cos(angle)*radius, arc.y + Math.sin(angle)*radius);
      });
      c.restore();
    }
  };

  charts[canvasId] = new Chart(ctx, {
    type:'doughnut',
    data:{ labels, datasets:[{ data:values, backgroundColor:colors, borderColor:P.surface, borderWidth:2, hoverOffset:0 }]},
    options:{
      responsive:true, aspectRatio:1, cutout:'48%',
      events:['mousemove','mouseout','click','touchstart','touchmove'],
      plugins:{ legend:{display:false}, tooltip:{ ...tooltipBase(P), callbacks:{
        label:(c)=> `${c.label}: ${c.parsed} flights (${Math.round((c.parsed/total)*100)}%)`
      }}}
    },
    plugins:[sliceLabelPlugin]
  });
  renderAircraftLegend(labels, values, colors, total);
}

function renderAircraftLegend(labels, values, colors, total){
  const el = document.getElementById('aircraftLegend');
  if(!el) return;
  el.innerHTML = labels.map((l,i)=>{
    const pct = Math.round((values[i]/total)*100);
    return `<li class="legend-item"><span class="legend-swatch" style="background:${colors[i]}"></span><span>${esc(l)}</span><span class="legend-count">${values[i]} (${pct}%)</span></li>`;
  }).join('');
}

/* ===================== DASHBOARD ===================== */
function renderDashboard(){
  const list = generalFlights();
  const s = statsFor(list);

  renderHobbs('dash-hobbs', s.hours);
  document.getElementById('dash-facts').innerHTML = [
    fact('Flights', s.flights || 0),
    fact('Airports', s.dests || 0),
    fact('Longest leg', s.longest ? fmt(s.longest,1) : '—', 'hrs'),
    fact('Shortest leg', s.shortest ? fmt(s.shortest,1) : '—', 'hrs')
  ].join('');
  renderSpread('dash-spread', list);
  document.getElementById('dash-ledger').innerHTML = landingFacts(s);

  buildScatter('chartRate', list, 'landingRate', 'fpm');
  buildScatter('chartG', list, 'landingG', 'g');
  buildHoursBar('chartHours', list);
  buildAircraftChart('chartAircraft', list);
  renderAirportBars('airportTable', airportCounts(list), 8);
}

/* ===================== SVA DASHBOARD ===================== */
function renderSVA(){
  const list = svaFlights();
  const s = statsFor(list);
  const totalTFP = list.reduce((a,f)=>a+(f.tfp||0),0);

  renderHobbs('sva-hobbs', s.hours);
  document.getElementById('sva-facts').innerHTML = [
    fact('Flights', s.flights || 0),
    fact('TFP total', totalTFP ? fmt(totalTFP,2) : '—', 'hrs'),
    fact('Airports', s.dests || 0),
    fact('Longest leg', s.longest ? fmt(s.longest,1) : '—', 'hrs')
  ].join('');
  renderSpread('sva-spread', list);
  document.getElementById('sva-ledger').innerHTML = landingFacts(s);

  const rankRows = RANKS.map(r=>{
    const sub = list.filter(f=>f.rank===r);
    if(!sub.length) return [rankLabel(r), '—', '—', 0];
    const ar = avgExcl(sub,'landingRate');
    const ag = avgExcl(sub,'landingG');
    return [rankLabel(r), ar!=null ? fmt(ar,0) : '—', ag!=null ? fmt(ag,2) : '—', sub.length];
  });
  document.getElementById('svaRankTable').innerHTML = tableHtml(
    ['Rank','Avg rate (fpm)','Avg G','Flights'], rankRows
  );

  const ctx = document.getElementById('chartTFP');
  if(ctx && chartsReady('chartTFP')){
    const P = palette();
    let running = 0;
    const points = sortedByDate(list).map(f=>{ running += (f.tfp||0); return {x:f.date, y:+running.toFixed(2)}; });
    charts.chartTFP = new Chart(ctx, {
      type:'line',
      data:{ datasets:[{ data:points, borderColor:P.sky, backgroundColor:P.sky + '1f', fill:true, pointRadius:0, pointHoverRadius:4, borderWidth:2, tension:0.1 }]},
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ ...tooltipBase(P), callbacks:{ title:dateTitle, label:(c)=> `${c.parsed.y} TFP hours` } } },
        scales:{ x:{ type:'time', time:{unit:'month'}, grid:{display:false}, border:{color:P.line}, ticks:{maxTicksLimit:6, maxRotation:0} },
                 y:{ grid:{color:P.line}, border:{display:false}, ticks:{maxTicksLimit:6} } } }
    });
  }

  renderAirportBars('svaAirportTable', airportCounts(list), 8);
}

/* ===================== ADD FLIGHT FORM ===================== */
function renderAddForm(){
  const sharedCb = document.getElementById('f-shared');
  const sharedFields = document.getElementById('sharedFields');
  const roleSelect = document.getElementById('f-role');
  const excludeCb = document.getElementById('f-exclude');

  sharedCb.addEventListener('change', ()=> sharedFields.classList.toggle('hidden', !sharedCb.checked));
  roleSelect.addEventListener('change', ()=>{
    // auto-set exclude from avg: only PM landings shouldn't count toward personal averages
    excludeCb.checked = /PM LDG/.test(roleSelect.value);
  });

  const svaCb = document.getElementById('f-issva');
  const svaFields = document.getElementById('svaFields');
  svaCb.addEventListener('change', ()=> svaFields.classList.toggle('hidden', !svaCb.checked));

  const lastRank = localStorage.getItem('flightlog_last_rank');
  if(lastRank) document.getElementById('f-rank').value = lastRank;

  document.getElementById('f-date').valueAsDate = new Date();

  document.getElementById('flightForm').addEventListener('submit', e=>{
    e.preventDefault();
    const shared = sharedCb.checked;
    const isSva = svaCb.checked;
    const rank = document.getElementById('f-rank').value;
    if(rank) localStorage.setItem('flightlog_last_rank', rank);

    const flight = {
      id: uid(),
      dep: document.getElementById('f-dep').value.toUpperCase().trim(),
      arr: document.getElementById('f-arr').value.toUpperCase().trim(),
      flightNum: document.getElementById('f-flightnum').value.toUpperCase().trim(),
      date: document.getElementById('f-date').value,
      elapsed: parseFloat(document.getElementById('f-elapsed').value),
      landingRate: parseFloat(document.getElementById('f-landingrate').value),
      landingG: parseFloat(document.getElementById('f-landingg').value),
      aircraft: document.getElementById('f-aircraft').value.toUpperCase().trim(),
      notes: document.getElementById('f-notes').value.trim(),
      sharedCockpit: shared,
      role: shared ? roleSelect.value : '',
      excludeFromAvg: shared ? excludeCb.checked : false,
      sva: isSva,
      tfp: isSva ? parseFloat(document.getElementById('f-tfp').value || '0') : null,
      rank: isSva ? rank : '',
      updatedAt: new Date().toISOString()
    };
    DB.flights.push(flight);
    saveData();
    document.getElementById('flightForm').reset();
    sharedFields.classList.add('hidden');
    svaFields.classList.add('hidden');
    document.getElementById('f-date').valueAsDate = new Date();
    flashStatus('Flight saved: ' + flight.dep + ' to ' + flight.arr);
  });
}

function flashStatus(msg){
  const el = document.getElementById('statusLeft');
  const prev = el.textContent;
  el.textContent = msg;
  setTimeout(()=>{ el.textContent = prev; }, 2200);
  // the status bar can be off-screen on a phone, so confirm with a toast too
  const toast = document.getElementById('toast');
  if(toast){
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(flashStatus._t);
    flashStatus._t = setTimeout(()=> toast.classList.remove('show'), 2400);
  }
}

/* ===================== LOGBOOK ===================== */
const LOG_PAGE = 40;

// Chips only mark what is unusual. Almost every flight is Southwest Virtual at
// the current rank, so repeating that on each row just hides the exceptions.
function stripHtml(f, canDelete, promoted){
  const tags = [
    promoted ? `<span class="chip promo">Promoted to ${esc(rankLabel(f.rank))}</span>` : '',
    !f.sva ? '<span class="chip">General</span>' : '',
    f.sharedCockpit ? '<span class="chip">Shared cockpit</span>' : '',
    f.excludeFromAvg ? '<span class="chip warn">Left out of averages</span>' : ''
  ].join('');
  return `<article class="strip${f.sva ? ' is-sva' : ''}${f.excludeFromAvg ? ' is-excl' : ''}">`
    + `<span class="s-date">${esc(prettyDate(f.date))}</span>`
    + `<span class="s-route">${esc(f.dep)}<i></i>${esc(f.arr)}</span>`
    + `<span class="s-flt">${esc(f.flightNum || '—')}<small>${esc(f.aircraft || '')}${f.sva ? `<span class="tfp">, ${fmt(f.tfp||0,2)} TFP</span>` : ''}</small></span>`
    + `<span class="s-num s-time">${fmt(f.elapsed,1)}<small>hr</small></span>`
    + `<span class="s-num s-rate ${rateClass(f.landingRate)}">${fmt(f.landingRate,0)}<small>fpm</small></span>`
    + `<span class="s-num s-g">${fmt(f.landingG,2)}<small>g</small></span>`
    + `<span class="s-tags">${tags}</span>`
    + (canDelete ? `<button class="icon-btn s-del" type="button" data-id="${esc(f.id)}" aria-label="Delete flight ${esc(f.dep)} to ${esc(f.arr)} on ${esc(prettyDate(f.date))}">Delete</button>` : '')
    + (f.notes ? `<p class="s-notes">${esc(f.notes)}</p>` : '')
    + `</article>`;
}

function renderLogbook(){
  const filterSheet = document.getElementById('filterSheet');
  const filterRank = document.getElementById('filterRank');
  const filterAircraft = document.getElementById('filterAircraft');
  const filterAirport = document.getElementById('filterAirport');
  const filterSearch = document.getElementById('filterSearch');
  const clearBtn = document.getElementById('clearFilters');
  const table = document.getElementById('logbookTable');
  const countEl = document.getElementById('logCount');
  let shown = LOG_PAGE;

  // filter options come from the current data
  const ranks = RANKS.filter(r=> DB.flights.some(f=>f.rank===r));
  filterRank.innerHTML = '<option value="all">All ranks</option>' + ranks.map(r=>`<option value="${esc(r)}">${esc(rankLabel(r))}</option>`).join('');
  const aircraftTypes = [...new Set(DB.flights.map(f=>f.aircraft).filter(Boolean))].sort();
  filterAircraft.innerHTML = '<option value="all">All aircraft</option>' + aircraftTypes.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('');
  const airports = [...new Set(DB.flights.flatMap(f=>[f.dep, f.arr]).filter(Boolean))].sort();
  filterAirport.innerHTML = '<option value="all">All airports</option>' + airports.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('');

  [filterSheet, filterRank, filterAircraft, filterAirport].forEach(el=> el.addEventListener('change', ()=>{ shown = LOG_PAGE; draw(); }));
  filterSearch.addEventListener('input', ()=>{ shown = LOG_PAGE; draw(); });
  clearBtn.addEventListener('click', ()=>{
    filterSheet.value = 'all'; filterRank.value = 'all'; filterAircraft.value = 'all'; filterAirport.value = 'all';
    filterSearch.value = '';
    shown = LOG_PAGE; draw();
  });

  // one delegated listener handles every strip
  table.addEventListener('click', e=>{
    const del = e.target.closest('.icon-btn');
    if(del){
      if(getRole() !== 'owner') return;
      if(confirm('Delete this flight?')){
        const id = del.dataset.id;
        DB.flights = DB.flights.filter(f=>f.id!==id);
        // tombstone so the next sync deletes it in the cloud too
        DB.deleted.push({ id, deletedAt: new Date().toISOString() });
        saveData();
        draw();
      }
      return;
    }
    if(e.target.closest('[data-more]')){ shown += LOG_PAGE; draw(); }
  });

  function draw(){
    let list = sortedByDate(DB.flights).reverse();
    if(filterSheet.value==='sva') list = list.filter(f=>f.sva);
    if(filterSheet.value==='general') list = list.filter(f=>!f.sva);
    if(filterRank.value!=='all') list = list.filter(f=>f.rank===filterRank.value);
    if(filterAircraft.value!=='all') list = list.filter(f=>f.aircraft===filterAircraft.value);
    if(filterAirport.value!=='all') list = list.filter(f=>f.dep===filterAirport.value || f.arr===filterAirport.value);
    const q = filterSearch.value.toUpperCase().trim();
    if(q) list = list.filter(f=> (f.dep+f.arr+f.flightNum).toUpperCase().includes(q));

    const total = DB.flights.length;
    countEl.textContent = list.length === total
      ? `${total} flight${total===1 ? '' : 's'}`
      : `${list.length} of ${total} flights`;

    if(!list.length){
      table.innerHTML = `<p class="empty">${total ? 'No flights match these filters.' : 'No flights yet. Add one from the Log flight tab.'}</p>`;
      return;
    }
    const canDelete = getRole() === 'owner';
    const slice = list.slice(0, shown);

    // Month pages, like a paper logbook: flights and hours for the month,
    // plus the running total. The running total only makes sense unfiltered.
    const filtersActive = !!q || [filterSheet, filterRank, filterAircraft, filterAirport].some(el=> el.value !== 'all');
    const monthTotals = {};
    list.forEach(f=>{
      const m = monthTotals[f.date.slice(0,7)] || (monthTotals[f.date.slice(0,7)] = { n:0, hrs:0 });
      m.n++; m.hrs += f.elapsed || 0;
    });
    const toDate = {};
    let run = 0;
    sortedByDate(DB.flights).forEach(f=>{ run += f.elapsed || 0; toDate[f.date.slice(0,7)] = run; });
    // a flight counts as a promotion when its rank differs from the previous SVA flight's
    const promoted = {};
    let prevRank = '';
    sortedByDate(DB.flights.filter(f=>f.sva && f.rank)).forEach(f=>{
      if(prevRank && f.rank !== prevRank) promoted[f.id] = true;
      prevRank = f.rank;
    });

    let body = '', lastMonth = '';
    slice.forEach(f=>{
      const ym = f.date.slice(0,7);
      if(ym !== lastMonth){
        lastMonth = ym;
        const m = monthTotals[ym];
        body += `<h4 class="month"><span class="m-name">${esc(MONTHS[+ym.slice(5,7)-1] || '')} ${esc(ym.slice(0,4))}</span>`
          + `<span class="m-sum"><span>${m.n} flight${m.n===1?'':'s'}</span><span><b>${fmt(m.hrs,1)}</b> hrs</span>`
          + (filtersActive ? '' : `<span class="m-todate">Total to date <b>${fmt(toDate[ym] || 0,1)}</b></span>`)
          + '</span></h4>';
      }
      body += stripHtml(f, canDelete, !!promoted[f.id]);
    });

    table.innerHTML =
      '<div class="strip-head" aria-hidden="true"><span>Date</span><span>Route</span><span>Flight</span><span class="num">Time</span><span class="num">Rate</span><span class="num">G</span><span>Details</span><span></span></div>'
      + body
      + (list.length > shown ? `<div class="more"><button class="btn-ghost" type="button" data-more>Show ${Math.min(LOG_PAGE, list.length - shown)} more (${list.length - shown} left)</button></div>` : '');
  }
  draw();
}

/* ===================== DATA TAB: IMPORT/EXPORT ===================== */
function excelSerialToISO(serial){
  if(typeof serial !== 'number') return String(serial).slice(0,10);
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  return new Date(ms).toISOString().slice(0,10);
}

function renderData(){
  document.getElementById('importFile').addEventListener('change', handleImport);
  document.getElementById('exportJson').addEventListener('click', exportJson);
  document.getElementById('exportCsv').addEventListener('click', exportCsv);
  document.getElementById('exportPdf').addEventListener('click', exportPdf);
  document.getElementById('restoreFile').addEventListener('change', handleRestore);
  document.getElementById('wipeData').addEventListener('click', ()=>{
    if(confirm('This permanently erases all logged flights from this browser. Continue?')){
      DB = normalizeDB(null);
      saveData();
      flashStatus('All data erased from this device');
      route('data');
    }
  });

  const pill = document.getElementById('syncPill');
  const setup = document.getElementById('cloudSetup');
  const connected = document.getElementById('cloudConnected');
  const syncStatusEl = document.getElementById('syncStatus');

  function refreshCloudUI(){
    const usingDefaults = !localStorage.getItem(CLOUD_KEY) && !!supa;
    if(supa){
      setup.classList.add('hidden');
      connected.classList.remove('hidden');
      pill.textContent = usingDefaults ? 'Connected (built in)' : 'Connected';
      pill.className = 'sync-pill online';
    }else{
      setup.classList.remove('hidden');
      connected.classList.add('hidden');
      pill.textContent = 'Disconnected';
      pill.className = 'sync-pill';
    }
  }
  refreshCloudUI();

  document.getElementById('connectCloud').addEventListener('click', ()=>{
    const url = document.getElementById('c-url').value.trim();
    const key = document.getElementById('c-key').value.trim();
    if(!url || !key){ alert('Enter both the project URL and anon key.'); return; }
    if(!window.supabase){ alert('Supabase library failed to load — check your connection and try again.'); return; }
    cloudCfg = { url, key };
    localStorage.setItem(CLOUD_KEY, JSON.stringify(cloudCfg));
    initCloud();
    refreshCloudUI();
    syncStatusEl.textContent = 'Connected. Tap SYNC NOW to push/pull data.';
  });

  document.getElementById('disconnectCloud')?.addEventListener('click', ()=>{
    cloudCfg = null;
    supa = null;
    localStorage.removeItem(CLOUD_KEY);
    setLamp('offline');
    refreshCloudUI();
  });

  document.getElementById('syncNow')?.addEventListener('click', async (e)=>{
    const btn = e.currentTarget;
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Syncing...';
    syncStatusEl.textContent = 'Syncing...';
    syncStatusEl.style.color = '';
    try{
      const res = await syncNow();
      syncStatusEl.textContent = res.msg;
      syncStatusEl.style.color = res.ok ? '' : 'var(--red)';
      if(res.ok){
        flashStatus('Cloud sync complete: ' + DB.flights.length + ' flights');
        const activeTab = document.querySelector('.tab.active');
        if(activeTab && activeTab.dataset.tab !== 'data') route(activeTab.dataset.tab);
      }
    }catch(err){
      // catches anything syncNow's own try/catch didn't (e.g. a throw before it could build its result object)
      console.error('Sync button error:', err);
      syncStatusEl.textContent = 'Sync failed unexpectedly: ' + describeError(err);
      syncStatusEl.style.color = 'var(--red)';
    }finally{
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
}

function describeError(err){
  if(!err) return 'Unknown error';
  if(err.message) return err.message + (err.hint ? ' (' + err.hint + ')' : '') + (err.code ? ' [code ' + err.code + ']' : '');
  if(err.error_description) return err.error_description;
  try{ return JSON.stringify(err); }catch(e){ return String(err); }
}

function buildRankThresholds(workbook){
  // Reads a "RANK PROGRESS" style sheet with RANKS + NEEDED LEGS columns.
  // Returns [{rank, maxLeg}] describing the rank held for legs up to maxLeg
  // (the rank BEFORE reaching the next threshold).
  const sheetName = workbook.SheetNames.find(n=>/rank progress/i.test(n));
  if(!sheetName) return null;
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, {header:1, defval:''});
  if(!rows.length) return null;
  const header = rows[0].map(h=>String(h).trim().toUpperCase());
  const iRank = header.indexOf('RANKS');
  const iLegs = header.indexOf('NEEDED LEGS');
  if(iRank<0 || iLegs<0) return null;
  const nextRankAt = [];
  for(let r=1; r<rows.length; r++){
    const row = rows[r];
    if(!row || !row[iRank]) continue;
    const legs = parseFloat(row[iLegs]);
    if(!isNaN(legs)) nextRankAt.push({ rank:String(row[iRank]).trim().toUpperCase(), maxLeg:legs });
  }
  if(!nextRankAt.length) return null;
  const heldRankSequence = ['NEW HIRE', ...nextRankAt.map(t=>t.rank)];
  return nextRankAt.map((t,i)=>({ rank: heldRankSequence[i], maxLeg: t.maxLeg }));
}
function rankForLeg(legNumber, thresholds){
  for(const t of thresholds){ if(legNumber <= t.maxLeg) return t.rank; }
  return thresholds.length ? thresholds[thresholds.length-1].rank : '';
}

function matchKey(dep, arr, date, rate){
  return dep+'|'+arr+'|'+date+'|'+(Math.round(rate*10)/10).toFixed(1);
}

function handleImport(e){
  const file = e.target.files[0];
  if(!file) return;
  const statusEl = document.getElementById('importStatus');
  statusEl.textContent = 'Reading ' + file.name + '...';
  const reader = new FileReader();
  reader.onload = (evt)=>{
    try{
      const wb = XLSX.read(evt.target.result, {type:'array'});
      const sheetName = wb.SheetNames.find(n=>/flight sheet/i.test(n)) || wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, {header:1, defval:''});
      const header = rows[0].map(h=>String(h).trim().toUpperCase());
      const idx = (name)=> header.indexOf(name);
      const iDep=idx('DEP'), iArr=idx('ARR'), iFlt=idx('FLIGHT #'), iDate=idx('DATE'),
            iElapsed=idx('ELAPSED'), iTfp=idx('TFP'), iRate=idx('LANDING R'), iG=idx('LANDING G'),
            iAc=idx('AIRCRAFT'), iNotes=idx('NOTES');
      if(iDep<0 || iArr<0 || iRate<0){
        statusEl.textContent = 'Could not find the expected columns in "' + sheetName + '". Check the file format.';
        return;
      }
      const isSvaSheet = iTfp>=0;
      const thresholds = isSvaSheet ? buildRankThresholds(wb) : null;

      // index existing flights by match key so we can merge instead of duplicate
      const existingByKey = {};
      DB.flights.forEach(f=>{
        const k = matchKey(f.dep, f.arr, f.date, f.landingRate);
        if(!existingByKey[k]) existingByKey[k] = [];
        existingByKey[k].push(f);
      });

      let legNumber = 0;
      let added = 0, merged = 0, skipped = 0;
      for(let r=1; r<rows.length; r++){
        const row = rows[r];
        if(!row || !row[iDep]) continue;
        legNumber++;
        const dep = String(row[iDep]||'').trim().toUpperCase();
        const arr = String(row[iArr]||'').trim().toUpperCase();
        const date = excelSerialToISO(row[iDate]);
        const rate = parseFloat(row[iRate]) || 0;
        const notes = (iNotes>=0 ? String(row[iNotes]||'') : '').trim();
        const upperNotes = notes.toUpperCase();
        const role = (upperNotes.match(/P[FM] TO\/P[FM] LDG/)||[''])[0];
        const tfp = isSvaSheet ? (parseFloat(row[iTfp]) || 0) : null;
        const rank = isSvaSheet ? (thresholds ? rankForLeg(legNumber, thresholds) : '') : '';

        const key = matchKey(dep, arr, date, rate);
        const candidates = existingByKey[key];
        const existing = candidates && candidates.find(f => isSvaSheet ? true : !f._importedThisBatch);

        if(existing){
          // merge: fill in SVA fields if this is the SVA sheet, fill in general fields if missing
          if(isSvaSheet && !existing.sva){
            existing.sva = true;
            existing.tfp = tfp;
            existing.rank = rank;
            existing.updatedAt = new Date().toISOString();
            merged++;
          } else if(!isSvaSheet && !existing._importedThisBatch){
            // re-importing general sheet over an SVA-only stub, or a true duplicate re-import: just skip
            skipped++;
          } else {
            skipped++;
          }
          existing._importedThisBatch = true;
          continue;
        }

        const flight = {
          id: uid(),
          dep, arr,
          flightNum: String(iFlt>=0 ? row[iFlt] : '').trim().toUpperCase(),
          date,
          elapsed: parseFloat(row[iElapsed]) || 0,
          landingRate: rate,
          landingG: parseFloat(row[iG]) || 0,
          aircraft: String(row[iAc]||'').trim().toUpperCase(),
          notes,
          sharedCockpit: upperNotes.includes('SHARED COCKPIT'),
          role,
          excludeFromAvg: /PM LDG/.test(role),
          sva: isSvaSheet,
          tfp,
          rank,
          updatedAt: new Date().toISOString(),
          _importedThisBatch: true
        };
        DB.flights.push(flight);
        if(!existingByKey[key]) existingByKey[key] = [];
        existingByKey[key].push(flight);
        added++;
      }
      DB.flights.forEach(f=>{ delete f._importedThisBatch; });
      saveData();
      const rankNote = isSvaSheet ? (thresholds ? ' Rank assigned from RANK PROGRESS leg thresholds.' : ' No RANK PROGRESS sheet found — rank left blank, set manually if needed.') : '';
      statusEl.textContent = `Imported ${added} new, merged ${merged} into existing flights, skipped ${skipped} duplicates, from "${sheetName}".` + rankNote;
    }catch(err){
      statusEl.textContent = 'Import failed: ' + err.message;
    }
  };
  reader.readAsArrayBuffer(file);
}

function exportJson(){
  download('flightlog_backup.json', JSON.stringify(DB, null, 2), 'application/json');
}

function exportCsv(){
  const headers = ['date','dep','arr','flightNum','aircraft','elapsed','landingRate','landingG','sharedCockpit','excludeFromAvg','sva','tfp','rank','notes'];
  const lines = [headers.join(',')];
  DB.flights.forEach(f=>{
    lines.push(headers.map(h=>{
      const v = f[h];
      const s = v===null||v===undefined ? '' : String(v);
      return '"' + s.replace(/"/g,'""') + '"';
    }).join(','));
  });
  download('flightlog_export.csv', lines.join('\n'), 'text/csv');
}

function exportPdf(){
  if(!window.jspdf || !window.jspdf.jsPDF){
    alert('PDF library failed to load — check your connection and try again.');
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:'landscape', unit:'pt', format:'letter' });

  const list = [...DB.flights].sort((a,b)=> new Date(a.date) - new Date(b.date));
  const s = statsFor(list);
  const svaList = list.filter(f=>f.sva);
  const totalTFP = svaList.reduce((a,f)=>a+(f.tfp||0),0);

  const now = new Date();
  const pdfTimestamp = `${formatUtcDate(now)}  ${formatUtcTime(now)} UTC`;

  doc.setFont('courier','bold');
  doc.setFontSize(18);
  doc.text('Logbook - Anurag Mallick', 40, 36);
  doc.setFont('courier','normal');
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(`Generated ${pdfTimestamp}`, 40, 52);
  doc.setTextColor(0);

  const summaryLines = [
    `Total Flights: ${s.flights}     Total Hours: ${s.hours?fmt(s.hours,1):'\u2014'}     Airports Visited: ${s.dests}`,
    `Avg Landing Rate: ${s.avgRate!=null?fmt(s.avgRate,0):'\u2014'} FPM     Avg Landing G: ${s.avgG!=null?fmt(s.avgG,2):'\u2014'} G     Best: ${s.bestRate!=null?fmt(s.bestRate,0):'\u2014'} FPM     Worst: ${s.worstRate!=null?fmt(s.worstRate,0):'\u2014'} FPM`,
    `Southwest Virtual Flights: ${svaList.length}     Total TFP: ${fmt(totalTFP,2)} HRS`
  ];
  doc.setFont('courier','normal');
  doc.setFontSize(10);
  summaryLines.forEach((line,i)=> doc.text(line, 40, 76 + i*15));

  const rows = list.map(f=>[
    f.date, f.dep, f.arr, f.flightNum, f.aircraft,
    fmt(f.elapsed,1), fmt(f.landingRate,0), fmt(f.landingG,2),
    f.sva ? fmt(f.tfp||0,2) : '\u2014',
    f.rank || '\u2014',
    [f.sharedCockpit?'SHARED':'', f.excludeFromAvg?'EXCL':''].filter(Boolean).join(' ') || '\u2014',
    f.notes || ''
  ]);

  doc.autoTable({
    head:[['DATE','DEP','ARR','FLT#','A/C','HRS','RATE','G','TFP','RANK','FLAGS','NOTES']],
    body: rows,
    startY: 76 + summaryLines.length*15 + 14,
    styles:{ fontSize:7, cellPadding:3, font:'courier' },
    headStyles:{ fillColor:[18,22,26], textColor:[255,176,0], fontStyle:'bold', font:'courier' },
    alternateRowStyles:{ fillColor:[245,245,245] },
    margin:{ left:40, right:40 },
    columnStyles:{ 11:{ cellWidth:160 } }
  });

  doc.save('flightlog_export.pdf');
}

function download(filename, content, mime){
  const blob = new Blob([content], {type:mime});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

function handleRestore(e){
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (evt)=>{
    try{
      const data = JSON.parse(evt.target.result);
      if(!Array.isArray(data.flights)) throw new Error('Invalid backup file');
      DB = normalizeDB(data);
      saveData();
      flashStatus('Backup restored: ' + DB.flights.length + ' flights');
      route('data');
    }catch(err){
      alert('Restore failed: ' + err.message);
    }
  };
  reader.readAsText(file);
}

document.getElementById('lockBtn').addEventListener('click', signOut);

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function formatUtcDate(d){
  const dd = String(d.getUTCDate()).padStart(2,'0');
  return `${DAYS[d.getUTCDay()]}, ${dd} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function formatUtcTime(d){
  return [d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds()].map(n=>String(n).padStart(2,'0')).join(':');
}
function tickClock(){
  const now = new Date();
  const dateEl = document.getElementById('utcDate');
  const timeEl = document.getElementById('utcTime');
  if(dateEl) dateEl.textContent = formatUtcDate(now);
  if(timeEl) timeEl.textContent = formatUtcTime(now);
}
tickClock();
setInterval(tickClock, 1000);

/* ===================== INIT ===================== */
// Viewers always pull so they see current data. The owner pulls only when this
// device has nothing yet, and syncs by hand after that.
async function pullAfterSignIn(){
  if(!supa || !authState || authState.offline) return;
  if(authState.role === 'owner' && DB.flights.length > 0) return;
  const statusEl = document.getElementById('statusLeft');
  if(statusEl) statusEl.textContent = 'Pulling from the cloud...';
  // race the sync against a 6-second timeout so a slow or offline Supabase never freezes the page
  const timeout = new Promise(resolve => setTimeout(()=> resolve({ok:false, msg:'Cloud timed out. Load the page again when connected, or restore a JSON backup.'}), 6000));
  const res = await Promise.race([syncNow(), timeout]);
  if(!res.ok){
    if(statusEl) statusEl.textContent = 'Cloud pull failed: ' + res.msg;
  }else if(DB.flights.length > 0){
    if(statusEl) statusEl.textContent = 'Loaded ' + DB.flights.length + ' flights from the cloud';
  }
}

function currentTab(){
  const t = document.querySelector('.tab.active');
  return t ? t.dataset.tab : 'dashboard';
}

initCloud();

// If this device remembers a sign-in, open straight away and check it in the
// background, so a slow or missing connection never leaves a blank page.
const rememberedSignIn = readAuthCache();
if(rememberedSignIn){
  applyAuth({ ...rememberedSignIn, offline:true });
  route('dashboard');
}
const stateKey = ()=> authState ? authState.role + (authState.offline ? '~' : '') : 'out';
const keyBefore = stateKey();
const flightsBefore = DB.flights.length;

initAuth()
  .then(pullAfterSignIn)
  .catch(err => {
    console.error('Startup error:', err);
    const statusEl = document.getElementById('statusLeft');
    if(statusEl) statusEl.textContent = 'Startup error: ' + (err.message || err);
  })
  .finally(() => {
    // Redraw only if something changed, so a form being filled in is not wiped.
    if(!rememberedSignIn || stateKey() !== keyBefore || DB.flights.length !== flightsBefore){
      route(rememberedSignIn && getRole() ? currentTab() : 'dashboard');
    }
  });
