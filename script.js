/* ===================== CLOUD SYNC (SUPABASE) ===================== */
const CLOUD_KEY = 'flightlog_cloud_cfg';
let cloudCfg = JSON.parse(localStorage.getItem(CLOUD_KEY) || 'null');
let supa = null;

function initCloud(){
  if(cloudCfg && cloudCfg.url && cloudCfg.key && window.supabase){
    try{ supa = window.supabase.createClient(cloudCfg.url, cloudCfg.key); }
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
    aircraft:f.aircraft, notes:f.notes, shared_cockpit:f.sharedCockpit,
    role:f.role, exclude_from_avg:f.excludeFromAvg,
    sva:f.sva, tfp:f.tfp, rank:f.rank, updated_at:new Date().toISOString()
  };
}
function fromRow(r){
  return {
    id:r.id, dep:r.dep, arr:r.arr, flightNum:r.flight_num, date:r.date,
    elapsed:r.elapsed, landingRate:r.landing_rate, landingG:r.landing_g,
    aircraft:r.aircraft, notes:r.notes||'', sharedCockpit:r.shared_cockpit,
    role:r.role||'', excludeFromAvg:r.exclude_from_avg,
    sva:r.sva, tfp:r.tfp, rank:r.rank||''
  };
}

async function syncNow(){
  if(!supa) return { ok:false, msg:'Not connected.' };
  setLamp('syncing');
  try{
    if(DB.flights.length){
      const rows = DB.flights.map(toRow);
      const { error: upErr } = await supa.from('flights').upsert(rows, { onConflict:'id' });
      if(upErr) throw upErr;
    }
    const { data, error: selErr } = await supa.from('flights').select('*');
    if(selErr) throw selErr;
    const localIds = new Set(DB.flights.map(f=>f.id));
    let pulled = 0;
    (data||[]).forEach(row=>{
      if(!localIds.has(row.id)){ DB.flights.push(fromRow(row)); pulled++; }
    });
    saveData();
    setLamp('online');
    return { ok:true, msg:`Synced. Pushed ${DB.flights.length} local, pulled ${pulled} new from cloud.` };
  }catch(err){
    setLamp('error');
    return { ok:false, msg:'Sync failed: ' + (err.message||err) };
  }
}

/* ===================== STORAGE ===================== */
const STORE_KEY = 'flightlog_data_v1';

function loadData(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return { flights: [] };
}
function saveData(){ localStorage.setItem(STORE_KEY, JSON.stringify(DB)); }

let DB = loadData();

/* ===================== HELPERS ===================== */
const RANKS = ['NEW HIRE','IOE PILOT','JUNIOR FIRST OFFICER','FIRST OFFICER','SENIOR FIRST OFFICER'];

function uid(){ return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

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
  if(f.excludeFromAvg) return getCss('--cyan');
  if(f.notes && f.notes.trim()) return getCss('--green');
  return getCss('--amber');
}
function getCss(varName){
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
}

/* ===================== ROUTER ===================== */
const view = document.getElementById('view');
const tabs = document.querySelectorAll('.tab');
let charts = {};

tabs.forEach(t=>t.addEventListener('click', ()=>route(t.dataset.tab)));

const GATED_TABS = ['add','data'];

function isUnlocked(){ return sessionStorage.getItem('flightlog_unlocked') === 'true'; }

function route(name){
  tabs.forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
  Object.values(charts).forEach(c=>c && c.destroy());
  charts = {};
  view.innerHTML = '';

  if(GATED_TABS.includes(name) && !isUnlocked()){
    view.appendChild(document.getElementById('tpl-lock').content.cloneNode(true));
    renderLock(name);
    document.getElementById('statusLeft').textContent = 'LOCKED // ENTER CODE TO CONTINUE';
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
  document.getElementById('statusLeft').textContent = name.toUpperCase()+' // ' + DB.flights.length + ' FLIGHTS LOGGED';
  document.getElementById('statusRight').textContent = new Date().toISOString().slice(0,10);
}

const ACCESS_CODE = '1725873';

function renderLock(targetTab){
  let buffer = '';
  const dots = document.querySelectorAll('#pinDots .pin-dot');
  const hint = document.getElementById('lockHint');
  const card = document.querySelector('.lock-card');

  function updateDots(){
    dots.forEach((d,i)=> d.classList.toggle('filled', i < buffer.length));
  }
  function showError(){
    hint.textContent = 'INCORRECT CODE';
    hint.classList.add('error-text');
    card.classList.add('shake');
    setTimeout(()=>{
      card.classList.remove('shake');
      buffer = '';
      updateDots();
    }, 400);
  }

  document.querySelectorAll('#keypad button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const key = btn.dataset.key;
      if(key === 'clear'){
        buffer = '';
        hint.textContent = '\u00a0';
        hint.classList.remove('error-text');
        updateDots();
        return;
      }
      if(key === 'back'){
        buffer = buffer.slice(0, -1);
        hint.textContent = '\u00a0';
        hint.classList.remove('error-text');
        updateDots();
        return;
      }
      if(buffer.length >= ACCESS_CODE.length) return;
      buffer += key;
      updateDots();
      if(buffer.length === ACCESS_CODE.length){
        if(buffer === ACCESS_CODE){
          sessionStorage.setItem('flightlog_unlocked', 'true');
          route(targetTab);
        } else {
          showError();
        }
      }
    });
  });
}

/* ===================== DIAL CARD BUILDER ===================== */
function dial(label, value, unit='', cls=''){
  return `<div class="dial ${cls}"><span class="dial-label">${label}</span><div class="dial-value">${value}<span class="unit">${unit}</span></div></div>`;
}

/* ===================== DASHBOARD ===================== */
function renderDashboard(){
  const list = generalFlights();
  const s = statsFor(list);
  document.getElementById('dash-dials').innerHTML = [
    dial('TOTAL HOURS', s.hours?fmt(s.hours,1):'—','HRS'),
    dial('TOTAL FLIGHTS', s.flights||0),
    dial('AVG LANDING RATE', s.avgRate!=null?fmt(s.avgRate,0):'—','FPM'),
    dial('AVG LANDING G', s.avgG!=null?fmt(s.avgG,2):'—','G'),
    dial('BEST LANDING', s.bestRate!=null?fmt(s.bestRate,0):'—','FPM','good'),
    dial('WORST LANDING', s.worstRate!=null?fmt(s.worstRate,0):'—','FPM','bad'),
    dial('HIGHEST G', s.highG!=null?fmt(s.highG,2):'—','G','warn'),
    dial('LOWEST G', s.lowG!=null?fmt(s.lowG,2):'—','G','good'),
    dial('AIRPORTS VISITED', s.dests||0),
    dial('LONGEST LEG', s.longest?fmt(s.longest,1):'—','HRS'),
    dial('SHORTEST LEG', s.shortest?fmt(s.shortest,1):'—','HRS'),
  ].join('');

  buildScatter('chartRate', list, 'landingRate', 'FPM');
  buildScatter('chartG', list, 'landingG', 'G');
  buildHoursBar('chartHours', list);
  buildAircraftChart('chartAircraft', list);

  const rows = airportCounts(list);
  document.getElementById('airportTable').innerHTML = tableHtml(
    ['AIRPORT','VISITS'], rows.map(r=>[r[0], r[1]])
  );
}

function sortedByDate(list){
  return [...list].sort((a,b)=> new Date(a.date) - new Date(b.date));
}

function buildScatter(canvasId, list, key, unitLabel){
  const sorted = sortedByDate(list);
  const ctx = document.getElementById(canvasId);
  if(!ctx) return;
  const points = sorted.map(f=>({x:f.date, y:f[key]}));
  const colors = sorted.map(pointColor);
  const radii = sorted.map(f=> isFlagged(f) ? 4 : 1.5);
  const hoverRadii = sorted.map(f=> isFlagged(f) ? 6 : 3);
  charts[canvasId] = new Chart(ctx, {
    type:'line',
    data:{ datasets:[{
      data: points,
      borderColor: getCss('--hairline'),
      backgroundColor: colors,
      pointBackgroundColor: colors,
      pointRadius: radii,
      pointHoverRadius: hoverRadii,
      borderWidth: 1,
      tension: 0
    }]},
    options:{
      responsive:true,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{
        label: (c)=> `${unitLabel}: ${c.parsed.y}`
      }}},
      scales:{
        x:{ type:'time', time:{unit:'month'}, ticks:{color:getCss('--text-dim')}, grid:{color:getCss('--hairline')} },
        y:{ ticks:{color:getCss('--text-dim')}, grid:{color:getCss('--hairline')} }
      }
    }
  });
}

function buildHoursBar(canvasId, list){
  const map = {};
  list.forEach(f=>{
    const ym = (f.date||'').slice(0,7);
    if(!ym) return;
    map[ym] = (map[ym]||0) + f.elapsed;
  });
  const keys = Object.keys(map).sort();
  const ctx = document.getElementById(canvasId);
  charts[canvasId] = new Chart(ctx, {
    type:'bar',
    data:{ labels:keys, datasets:[{ data:keys.map(k=>+map[k].toFixed(1)), backgroundColor: getCss('--amber-dim'), borderColor: getCss('--amber'), borderWidth:1 }]},
    options:{ responsive:true, plugins:{legend:{display:false}},
      scales:{ x:{ticks:{color:getCss('--text-dim')},grid:{display:false}}, y:{ticks:{color:getCss('--text-dim')},grid:{color:getCss('--hairline')}} } }
  });
}

function buildAircraftChart(canvasId, list){
  const ctx = document.getElementById(canvasId);
  if(!ctx) return;
  const counts = {};
  list.forEach(f=>{ const ac = f.aircraft || 'UNKNOWN'; counts[ac] = (counts[ac]||0)+1; });
  const entries = Object.entries(counts).sort((a,b)=>b[1]-a[1]);
  const total = list.length || 1;
  const labels = entries.map(e=>e[0]);
  const values = entries.map(e=>e[1]);

  const basePalette = ['--amber','--cyan','--green','--red','--amber-dim','--cyan-dim'];
  const colors = labels.map((_,i)=>{
    if(i < basePalette.length) return getCss(basePalette[i]);
    // generate extra distinct hues for overflow beyond base palette
    const hue = (i * 47) % 360;
    return `hsl(${hue}, 55%, 55%)`;
  });

  const sliceLabelPlugin = {
    id:'sliceLabel',
    afterDatasetsDraw(chart){
      const c = chart.ctx;
      const meta = chart.getDatasetMeta(0);
      c.save();
      c.font = '600 11px JetBrains Mono, monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      meta.data.forEach((arc, i)=>{
        const pct = Math.round((values[i]/total)*100);
        if(pct < 4) return; // skip labels for slivers, legend still shows them
        const angle = (arc.startAngle + arc.endAngle) / 2;
        const radius = (arc.innerRadius + arc.outerRadius) / 2;
        const x = arc.x + Math.cos(angle) * radius;
        const y = arc.y + Math.sin(angle) * radius;
        c.fillStyle = '#10130f';
        c.fillText(`${pct}%`, x, y);
      });
      c.restore();
    }
  };

  charts[canvasId] = new Chart(ctx, {
    type:'pie',
    data:{ labels, datasets:[{ data: values, backgroundColor: colors, borderColor: getCss('--bg'), borderWidth:2 }]},
    options:{
      responsive:true,
      aspectRatio:1.1,
      plugins:{
        legend:{ display:false }, // real HTML legend rendered below instead — see renderAircraftLegend
        tooltip:{ callbacks:{
          label:(c)=> `${c.label}: ${c.parsed} flights (${Math.round((c.parsed/total)*100)}%)`
        }}
      }
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
    return `<span class="legend-item">
      <span class="legend-swatch" style="background:${colors[i]}"></span>
      ${l} — ${values[i]} (${pct}%)
    </span>`;
  }).join('');
}

function tableHtml(headers, rows){
  if(!rows.length) return '<p class="hint">NO DATA YET</p>';
  return `<table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${
    rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
}

/* ===================== SVA DASHBOARD ===================== */
function renderSVA(){
  const list = svaFlights();
  const s = statsFor(list);
  const totalTFP = list.reduce((a,f)=>a+(f.tfp||0),0);

  document.getElementById('sva-dials').innerHTML = [
    dial('TOTAL HOURS', s.hours?fmt(s.hours,1):'—','HRS'),
    dial('TOTAL FLIGHTS', s.flights||0),
    dial('TOTAL TFP', totalTFP?fmt(totalTFP,2):'—','HRS'),
    dial('AVG LANDING RATE', s.avgRate!=null?fmt(s.avgRate,0):'—','FPM'),
    dial('AVG LANDING G', s.avgG!=null?fmt(s.avgG,2):'—','G'),
    dial('BEST LANDING', s.bestRate!=null?fmt(s.bestRate,0):'—','FPM','good'),
    dial('WORST LANDING', s.worstRate!=null?fmt(s.worstRate,0):'—','FPM','bad'),
    dial('AIRPORTS VISITED', s.dests||0),
  ].join('');

  const rankRows = RANKS.map(r=>{
    const sub = list.filter(f=>f.rank===r);
    if(!sub.length) return [r,'—','—','0'];
    const ar = avgExcl(sub,'landingRate');
    const ag = avgExcl(sub,'landingG');
    return [r, ar!=null?fmt(ar,0):'—', ag!=null?fmt(ag,2):'—', sub.length];
  });
  document.getElementById('svaRankTable').innerHTML = tableHtml(
    ['RANK','AVG LANDING RATE (FPM)','AVG LANDING G','FLIGHTS'], rankRows
  );

  const ctx = document.getElementById('chartTFP');
  const sorted = sortedByDate(list);
  let running = 0;
  const points = sorted.map(f=>{ running += (f.tfp||0); return {x:f.date, y:+running.toFixed(2)}; });
  charts.chartTFP = new Chart(ctx, {
    type:'line',
    data:{ datasets:[{ data:points, borderColor:getCss('--cyan'), backgroundColor:getCss('--cyan-dim'), fill:true, pointRadius:2, tension:0.15 }]},
    options:{ responsive:true, plugins:{legend:{display:false}},
      scales:{ x:{type:'time', time:{unit:'month'}, ticks:{color:getCss('--text-dim')}, grid:{color:getCss('--hairline')}},
               y:{ ticks:{color:getCss('--text-dim')}, grid:{color:getCss('--hairline')} } } }
  });

  document.getElementById('svaAirportTable').innerHTML = tableHtml(
    ['AIRPORT','VISITS'], airportCounts(list)
  );
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
      rank: isSva ? rank : ''
    };
    DB.flights.push(flight);
    saveData();
    document.getElementById('flightForm').reset();
    sharedFields.classList.add('hidden');
    svaFields.classList.add('hidden');
    document.getElementById('f-date').valueAsDate = new Date();
    flashStatus('FLIGHT LOGGED: ' + flight.dep + ' \u2192 ' + flight.arr);
  });
}

function flashStatus(msg){
  const el = document.getElementById('statusLeft');
  const prev = el.textContent;
  el.textContent = msg;
  setTimeout(()=>{ el.textContent = prev; }, 2200);
}

/* ===================== LOGBOOK TABLE ===================== */
function renderLogbook(){
  const filterSheet = document.getElementById('filterSheet');
  const filterRank = document.getElementById('filterRank');
  const filterAircraft = document.getElementById('filterAircraft');
  const filterAirport = document.getElementById('filterAirport');
  const filterSearch = document.getElementById('filterSearch');
  const clearBtn = document.getElementById('clearFilters');

  // populate dynamic filter options from current data
  const ranks = [...new Set(DB.flights.map(f=>f.rank).filter(Boolean))];
  filterRank.innerHTML = '<option value="all">ALL RANKS</option>' + ranks.map(r=>`<option value="${r}">${r}</option>`).join('');

  const aircraftTypes = [...new Set(DB.flights.map(f=>f.aircraft).filter(Boolean))].sort();
  filterAircraft.innerHTML = '<option value="all">ALL AIRCRAFT</option>' + aircraftTypes.map(a=>`<option value="${a}">${a}</option>`).join('');

  const airports = [...new Set(DB.flights.flatMap(f=>[f.dep, f.arr]).filter(Boolean))].sort();
  filterAirport.innerHTML = '<option value="all">ALL AIRPORTS</option>' + airports.map(a=>`<option value="${a}">${a}</option>`).join('');

  [filterSheet, filterRank, filterAircraft, filterAirport].forEach(el=> el.addEventListener('change', drawLogbook));
  filterSearch.addEventListener('input', drawLogbook);
  clearBtn.addEventListener('click', ()=>{
    filterSheet.value = 'all'; filterRank.value = 'all'; filterAircraft.value = 'all'; filterAirport.value = 'all';
    filterSearch.value = '';
    drawLogbook();
  });
  drawLogbook();

  function drawLogbook(){
    let list = [...DB.flights].sort((a,b)=> new Date(b.date) - new Date(a.date));
    const sheet = filterSheet.value;
    if(sheet==='sva') list = list.filter(f=>f.sva);
    if(sheet==='general') list = list.filter(f=>!f.sva);

    const rank = filterRank.value;
    if(rank!=='all') list = list.filter(f=>f.rank===rank);

    const aircraft = filterAircraft.value;
    if(aircraft!=='all') list = list.filter(f=>f.aircraft===aircraft);

    const airport = filterAirport.value;
    if(airport!=='all') list = list.filter(f=>f.dep===airport || f.arr===airport);

    const q = filterSearch.value.toUpperCase().trim();
    if(q) list = list.filter(f=> (f.dep+f.arr+f.flightNum).toUpperCase().includes(q));

    const rows = list.map(f=>{
      const flags = [f.sharedCockpit?'SHARED':'', f.excludeFromAvg?'EXCL':'', f.sva?'SVA':''].filter(Boolean).join(' ');
      return [
        f.date, f.dep, f.arr, f.flightNum, f.aircraft,
        fmt(f.elapsed,1), fmt(f.landingRate,0), fmt(f.landingG,2),
        f.sva ? fmt(f.tfp||0,2) : '—',
        f.rank || '—',
        flags || '—',
        f.notes || '—',
        `<button class="icon-btn" data-id="${f.id}">DELETE</button>`
      ];
    });
    document.getElementById('logbookTable').innerHTML = tableHtml(
      ['DATE','DEP','ARR','FLT#','A/C','ELAPSED','RATE','G','TFP','RANK','FLAGS','NOTES',''], rows
    );
    document.querySelectorAll('#logbookTable .icon-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        if(confirm('Delete this flight?')){
          DB.flights = DB.flights.filter(f=>f.id!==btn.dataset.id);
          saveData();
          drawLogbook();
        }
      });
    });
  }
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
  document.getElementById('restoreFile').addEventListener('change', handleRestore);
  document.getElementById('wipeData').addEventListener('click', ()=>{
    if(confirm('This permanently erases all logged flights from this browser. Continue?')){
      DB = { flights: [] };
      saveData();
      flashStatus('ALL DATA ERASED');
      route('data');
    }
  });

  const pill = document.getElementById('syncPill');
  const setup = document.getElementById('cloudSetup');
  const connected = document.getElementById('cloudConnected');
  const syncStatusEl = document.getElementById('syncStatus');

  function refreshCloudUI(){
    if(supa){
      setup.classList.add('hidden');
      connected.classList.remove('hidden');
      pill.textContent = 'CONNECTED';
      pill.className = 'sync-pill online';
    }else{
      setup.classList.remove('hidden');
      connected.classList.add('hidden');
      pill.textContent = 'DISCONNECTED';
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

  document.getElementById('syncNow')?.addEventListener('click', async ()=>{
    syncStatusEl.textContent = 'Syncing...';
    const res = await syncNow();
    syncStatusEl.textContent = res.msg;
    if(res.ok) flashStatus('CLOUD SYNC COMPLETE');
  });
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
  statusEl.textContent = 'READING ' + file.name + '...';
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
        statusEl.textContent = 'COULD NOT FIND EXPECTED COLUMNS IN "' + sheetName + '". CHECK FILE FORMAT.';
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
          flightNum: String(row[iFlt]>=0 ? row[iFlt] : '').trim().toUpperCase(),
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
      statusEl.textContent = `IMPORTED ${added} new, merged ${merged} into existing flights, skipped ${skipped} duplicates, from "${sheetName}".` + rankNote;
    }catch(err){
      statusEl.textContent = 'IMPORT FAILED: ' + err.message;
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
      DB = data;
      saveData();
      flashStatus('BACKUP RESTORED: ' + DB.flights.length + ' FLIGHTS');
      route('data');
    }catch(err){
      alert('Restore failed: ' + err.message);
    }
  };
  reader.readAsText(file);
}

/* ===================== INIT ===================== */
initCloud();
route('dashboard');
