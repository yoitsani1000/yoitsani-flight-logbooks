/* ===================== CLOUD SYNC =====================
   The browser never talks to the database. It calls this site's own /api
   functions (hosted on Vercel), which hold the database key. Anyone can read.
   Only a logged-in admin can write, and the server checks that on every save. */
async function api(path, options){
  const opts = options || {};
  const ctl = new AbortController();
  const timer = setTimeout(()=> ctl.abort(), opts.timeoutMs || 15000);
  try{
    const res = await fetch(path, {
      method: opts.method || 'GET',
      body: opts.body,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    let data = null;
    try{ data = await res.json(); }catch(e){}
    return { ok: res.ok, status: res.status, data };
  }finally{
    clearTimeout(timer);
  }
}

function initCloud(){ setLamp('idle'); }

let dataVersion = 0; // bumps whenever a sync changes the local data

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

async function syncNow(opts){
  setLamp('syncing');
  try{
    // Only the admin may write. Everyone else just pulls.
    const isOwner = getRole() === 'owner';
    // Order matters: read the cloud first so deletions made on other devices
    // are applied BEFORE this device pushes, otherwise a stale device would
    // resurrect rows that were deleted elsewhere.
    const r = await api('/api/flights', { timeoutMs: (opts && opts.timeoutMs) || 20000 });
    if(!r.ok) throw new Error((r.data && r.data.error) || ('The server returned ' + r.status + '.'));
    const cloud = new Map();
    ((r.data && r.data.flights) || []).forEach(row=>{ if(row && row.id) cloud.set(row.id, row); });

    // 1. Apply deletions made on other devices (soft-deleted rows in the cloud).
    const before = DB.flights.length;
    DB.flights = DB.flights.filter(f=>{ const row = cloud.get(f.id); return !(row && row.deleted_at); });
    const removed = before - DB.flights.length;

    // 2. Local deletions waiting to be sent.
    const tombIds = new Set(isOwner ? DB.deleted.map(t=>t.id) : []);

    // 3. Pull new rows and newer versions of existing rows.
    const indexById = new Map(DB.flights.map((f,i)=>[f.id,i]));
    let pulled = 0, updated = 0;
    cloud.forEach((row,id)=>{
      if(row.deleted_at || tombIds.has(id)) return;
      const remote = fromRow(row);
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
    if(pulled || updated || removed) dataVersion++;

    // 4. Send only what is missing from the cloud or newer here, in one request.
    const toPush = !isOwner ? [] : DB.flights.filter(f=>{
      const row = cloud.get(f.id);
      return !row || ts(f.updatedAt) > ts(row.updated_at);
    });
    toPush.forEach(f=>{ if(!f.updatedAt) f.updatedAt = new Date().toISOString(); });
    let deletedPushed = 0;
    if(isOwner && (toPush.length || tombIds.size)){
      const w = await api('/api/flights', {
        method: 'POST',
        body: JSON.stringify({ upserts: toPush.map(toRow), softDeletes: [...tombIds] }),
        timeoutMs: 30000
      });
      if(w.status === 401){
        // the login expired: fall back to read-only
        writeAuthCache(null);
        applyAuth(null);
        saveData();
        setLamp('error');
        return { ok:false, loggedOut:true, msg:'Your admin login expired. Log in again to save changes.' };
      }
      if(!w.ok) throw new Error((w.data && w.data.error) || ('The server returned ' + w.status + '.'));
      deletedPushed = tombIds.size;
      DB.deleted = [];
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
    const offline = err && (err.name === 'AbortError' || err.name === 'TypeError');
    return { ok:false, msg: offline ? 'Sync failed: cannot reach the server. Check your connection.' : 'Sync failed: ' + describeError(err) };
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
   Everyone can view. A Log in button (top right) gives the admin access to
   Log flight and Data. The server checks a signed, expiring cookie on every
   write, so what this screen shows is only a convenience.
   The last admin login is remembered on this device so the page still opens
   with edit tabs when offline. */
const AUTH_CACHE_KEY = 'flightlog_auth_cache';
const PENDING_LOGOUT_KEY = 'flightlog_pending_logout';
let authState = { role:'viewer', username:'', offline:false };

function getRole(){ return authState.role; } // 'owner' (logged in as admin) or 'viewer'

function readAuthCache(){
  try{
    const c = JSON.parse(localStorage.getItem(AUTH_CACHE_KEY) || 'null');
    return c && c.role === 'owner' ? c : null;
  }catch(e){ return null; }
}
function writeAuthCache(state){
  try{
    if(state && state.role === 'owner') localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ role:'owner', username: state.username || '' }));
    else localStorage.removeItem(AUTH_CACHE_KEY);
  }catch(e){}
}
function applyAuth(state){
  authState = state && state.role === 'owner'
    ? { role:'owner', username: state.username || '', offline: !!state.offline }
    : { role:'viewer', username:'', offline:false };
  document.body.dataset.auth = authState.role;
  const btn = document.getElementById('lockBtn');
  if(btn){
    const owner = authState.role === 'owner';
    const label = owner ? 'Log out' : 'Log in';
    const text = btn.querySelector('.lock-text');
    if(text) text.textContent = label;
    btn.setAttribute('aria-label', label);
    btn.title = owner
      ? (authState.username ? 'Logged in as ' + authState.username + '. Log out' : 'Log out')
      : 'Log in as admin to add or change flights';
  }
}
function isNetworkError(e){
  return !!e && (e.name === 'AbortError' || e.name === 'TypeError' || /fetch|network|failed|abort/i.test(e.message || ''));
}

// Checks the cookie with the server. Unreachable server: keep what is remembered.
async function initAuth(){
  try{
    if(localStorage.getItem(PENDING_LOGOUT_KEY)){
      const out = await api('/api/logout', { method:'POST', timeoutMs:4000 });
      if(out.ok) localStorage.removeItem(PENDING_LOGOUT_KEY);
    }
    const r = await api('/api/session', { timeoutMs:4000 });
    if(r.ok && r.data && r.data.admin){
      const st = { role:'owner', username: r.data.username || '', offline:false };
      writeAuthCache(st);
      applyAuth(st);
    }else if(r.ok){
      writeAuthCache(null);
      applyAuth(null);
    }
  }catch(e){
    if(!isNetworkError(e)) console.error('Session check failed:', e);
  }
}

async function logIn(username, password){
  try{
    const r = await api('/api/login', { method:'POST', body: JSON.stringify({ username, password }), timeoutMs:12000 });
    if(r.ok){
      const st = { role:'owner', username: (r.data && r.data.username) || username, offline:false };
      try{ localStorage.removeItem(PENDING_LOGOUT_KEY); }catch(e){}
      writeAuthCache(st);
      applyAuth(st);
      return { ok:true };
    }
    return { ok:false, msg: (r.data && r.data.error) || ('Login failed (' + r.status + ').') };
  }catch(e){
    return { ok:false, msg: isNetworkError(e) ? 'Cannot reach the server. Check your connection and try again.' : describeError(e) };
  }
}

async function logOut(){
  let reached = true;
  try{ const r = await api('/api/logout', { method:'POST', timeoutMs:6000 }); reached = r.ok; }
  catch(e){ reached = false; }
  // offline: the cookie cannot be cleared from here, so finish the job next time
  if(!reached){ try{ localStorage.setItem(PENDING_LOGOUT_KEY, '1'); }catch(e){} }
  writeAuthCache(null);
  applyAuth(null);
  route('dashboard');
  flashStatus(reached ? 'Logged out' : 'Logged out on this device. The session ends fully the next time you are online.');
}

function route(name){
  const role = getRole();
  if(name === 'login' && role === 'owner') name = 'dashboard';
  if(name !== 'login' && OWNER_ONLY_TABS.includes(name) && role !== 'owner') name = 'dashboard';

  tabs.forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
  Object.values(charts).forEach(c=>c && c.destroy());
  charts = {};
  view.innerHTML = '';

  if(name === 'login'){
    view.appendChild(document.getElementById('tpl-signin').content.cloneNode(true));
    renderSignIn();
    document.getElementById('statusLeft').textContent = 'Admin login';
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
  const roleTag = role === 'owner' && authState.offline ? ' (offline)' : '';
  document.getElementById('statusLeft').textContent = TAB_NAMES[name] + ': ' + DB.flights.length + ' flights logged' + roleTag;
  document.getElementById('statusRight').textContent = new Date().toISOString().slice(0,10);
}

function renderSignIn(){
  const form = document.getElementById('signinForm');
  const user = document.getElementById('si-user');
  const pass = document.getElementById('si-pass');
  const msg = document.getElementById('signinMsg');
  const btn = document.getElementById('signinBtn');
  const card = form.closest('.signin-card') || form;

  document.getElementById('signinCancel').addEventListener('click', ()=> route('dashboard'));
  form.addEventListener('submit', async e=>{
    e.preventDefault();
    msg.textContent = '';
    msg.classList.remove('error-text');
    if(!user.value.trim() || !pass.value){
      msg.textContent = 'Enter your username and password.';
      msg.classList.add('error-text');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Logging in...';
    const res = await logIn(user.value.trim(), pass.value);
    if(!res.ok){
      btn.disabled = false;
      btn.textContent = 'Log in';
      msg.textContent = res.msg;
      msg.classList.add('error-text');
      card.classList.add('shake');
      setTimeout(()=> card.classList.remove('shake'), 400);
      pass.value = '';
      pass.focus();
      return;
    }
    await pullOnLoad();
    route('dashboard');
  });
  user.focus();
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
  const syncStatusEl = document.getElementById('syncStatus');
  pill.textContent = authState.offline ? 'Offline' : 'Ready';
  pill.className = 'sync-pill' + (authState.offline ? '' : ' online');

  document.getElementById('syncNow')?.addEventListener('click', async (e)=>{
    const btn = e.currentTarget;
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Syncing...';
    syncStatusEl.textContent = 'Syncing...';
    syncStatusEl.style.color = '';
    try{
      const res = await syncNow();
      if(res.loggedOut){
        flashStatus(res.msg);
        route('dashboard');
        return;
      }
      syncStatusEl.textContent = res.msg;
      syncStatusEl.style.color = res.ok ? '' : 'var(--rose)';
      if(res.ok){
        flashStatus('Cloud sync complete: ' + DB.flights.length + ' flights');
        const activeTab = document.querySelector('.tab.active');
        if(activeTab && activeTab.dataset.tab !== 'data') route(activeTab.dataset.tab);
      }
    }catch(err){
      // catches anything syncNow's own try/catch didn't (e.g. a throw before it could build its result object)
      console.error('Sync button error:', err);
      syncStatusEl.textContent = 'Sync failed unexpectedly: ' + describeError(err);
      syncStatusEl.style.color = 'var(--rose)';
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

document.getElementById('lockBtn').addEventListener('click', ()=>{
  if(getRole() === 'owner') logOut(); else route('login');
});

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
function currentTab(){
  const t = document.querySelector('.tab.active');
  return t ? t.dataset.tab : 'dashboard';
}

// Visitors always pull so they see current data. The admin pulls only when
// this device has nothing yet, and syncs by hand after that.
async function pullOnLoad(){
  if(getRole() === 'owner' && (authState.offline || DB.flights.length > 0)) return;
  const statusEl = document.getElementById('statusLeft');
  if(statusEl) statusEl.textContent = 'Loading flights from the cloud...';
  const res = await syncNow({ timeoutMs: 8000 });
  if(!res.ok && statusEl) statusEl.textContent = 'Could not load from the cloud: ' + res.msg;
}

initCloud();

// Open straight away from whatever this device already has, then check the
// login and refresh in the background, so a slow connection never leaves a blank page.
const rememberedLogin = readAuthCache();
applyAuth(rememberedLogin ? { role:'owner', username: rememberedLogin.username, offline:true } : null);
route('dashboard');
const stateKey = ()=> authState.role + (authState.offline ? '~' : '');
const keyBefore = stateKey();
const versionBefore = dataVersion;

initAuth()
  .then(pullOnLoad)
  .catch(err => {
    console.error('Startup error:', err);
    const statusEl = document.getElementById('statusLeft');
    if(statusEl) statusEl.textContent = 'Startup error: ' + (err.message || err);
  })
  .finally(() => {
    // Redraw only if something changed, so a form being filled in is not wiped.
    if(stateKey() !== keyBefore || dataVersion !== versionBefore) route(currentTab());
  });
