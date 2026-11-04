'use strict';
// Shared helpers for the Vercel functions in /api.
// Uses only Node built-ins and the global fetch, so there is nothing to install.
//
// Environment variables (set in Vercel, never in the site code):
//   SUPABASE_URL                the project URL
//   SUPABASE_SERVICE_ROLE_KEY   the secret service_role key (server only)
//   ADMIN_USERNAME              the admin username
//   ADMIN_PASSWORD              the admin password
//   SESSION_SECRET              a long random string (40+ characters)

const crypto = require('crypto');

const COOKIE_NAME = 'fl_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_BODY_BYTES = 1024 * 1024;

function env(name){ return process.env[name] ? String(process.env[name]) : ''; }

function missingConfig(){
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'SESSION_SECRET']
    .filter(k => !env(k));
  if(env('SESSION_SECRET') && env('SESSION_SECRET').length < 32) missing.push('SESSION_SECRET (needs 32+ characters)');
  return missing;
}

/* ---------- responses ---------- */
function send(res, status, body, headers){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  Object.entries(headers || {}).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(body));
}

function methodNotAllowed(res, allow){
  send(res, 405, { error: 'Method not allowed.' }, { Allow: allow });
}

function readJson(req){
  return new Promise((resolve, reject) => {
    if(req.body !== undefined && req.body !== null){
      if(typeof req.body === 'string'){ try{ return resolve(JSON.parse(req.body)); }catch(e){ return reject(new Error('Invalid JSON.')); } }
      if(Buffer.isBuffer(req.body)){ try{ return resolve(JSON.parse(req.body.toString('utf8'))); }catch(e){ return reject(new Error('Invalid JSON.')); } }
      return resolve(req.body);
    }
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if(size > MAX_BODY_BYTES){ reject(new Error('Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try{ resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }catch(e){ reject(new Error('Invalid JSON.')); } });
    req.on('error', reject);
  });
}

/* ---------- sessions: a signed, expiring cookie ---------- */
function b64u(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64u(str){ return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

// The signing key depends on the password too, so changing the password or
// the secret logs every session out.
function signingKey(){
  return crypto.createHmac('sha256', env('SESSION_SECRET')).update('v1:' + env('ADMIN_PASSWORD')).digest();
}
function mac(body){ return b64u(crypto.createHmac('sha256', signingKey()).update(body).digest()); }

function safeEqual(a, b){
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function makeToken(now){
  const exp = Math.floor((now || Date.now()) / 1000) + SESSION_SECONDS;
  const body = b64u(JSON.stringify({ sub: 'admin', exp }));
  return body + '.' + mac(body);
}

function parseCookies(req){
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if(i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

function isAdmin(req, now){
  if(missingConfig().length) return false;
  const token = parseCookies(req)[COOKIE_NAME];
  if(!token || token.indexOf('.') < 0) return false;
  const [body, sig] = token.split('.');
  let good = false;
  try{ good = safeEqual(sig, mac(body)); }catch(e){ return false; }
  if(!good) return false;
  try{
    const p = JSON.parse(fromB64u(body).toString('utf8'));
    return p.sub === 'admin' && Number(p.exp) > Math.floor((now || Date.now()) / 1000);
  }catch(e){ return false; }
}

function sessionCookie(token){
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`;
}
function clearedCookie(){
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function checkCredentials(username, password){
  // run both comparisons so timing does not reveal which one was wrong
  const u = safeEqual(String(username || ''), env('ADMIN_USERNAME'));
  const p = safeEqual(String(password || ''), env('ADMIN_PASSWORD'));
  return u && p;
}

// Browsers send Origin on POST. If it is present it must be this site.
function sameOrigin(req){
  const origin = req.headers.origin;
  if(!origin) return true;
  try{ return new URL(origin).host === req.headers.host; }catch(e){ return false; }
}

/* ---------- gentle brute-force limit (per server instance) ---------- */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
function clientIp(req){
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || String(req.headers['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function isBlocked(ip, now){
  const a = attempts.get(ip);
  if(!a) return false;
  if((now || Date.now()) - a.first > WINDOW_MS){ attempts.delete(ip); return false; }
  return a.count >= MAX_FAILS;
}
function recordFail(ip, now){
  const t = now || Date.now();
  const a = attempts.get(ip);
  if(!a || t - a.first > WINDOW_MS) attempts.set(ip, { count: 1, first: t });
  else a.count++;
}
function clearFails(ip){ attempts.delete(ip); }
function resetThrottle(){ attempts.clear(); }

/* ---------- Supabase REST (service key stays on the server) ---------- */
async function supabase(path, options){
  const base = env('SUPABASE_URL').replace(/\/+$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  // New-format secret keys (sb_secret_...) go in apikey only. The older
  // service_role key is a JWT and is also sent as a Bearer token.
  const auth = key.startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {};
  const res = await fetch(base + '/rest/v1/' + path, {
    ...options,
    headers: { apikey: key, ...auth, 'Content-Type': 'application/json', ...((options && options.headers) || {}) }
  });
  let data = null;
  const text = await res.text();
  if(text){ try{ data = JSON.parse(text); }catch(e){ data = text; } }
  return { ok: res.ok, status: res.status, data };
}

/* ---------- validating what the browser sends ---------- */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function str(v, max){ return typeof v === 'string' ? v.slice(0, max) : ''; }
function num(v){ const n = Number(v); return Number.isFinite(n) ? n : null; }

// Returns a clean row for the flights table, or null when the row is unusable.
function cleanRow(r){
  if(!r || typeof r !== 'object' || !ID_RE.test(String(r.id || ''))) return null;
  const elapsed = num(r.elapsed), rate = num(r.landing_rate), g = num(r.landing_g);
  if(elapsed === null || rate === null || g === null) return null;
  if(elapsed < 0 || elapsed > 60 || Math.abs(rate) > 5000 || g < 0 || g > 20) return null;
  const date = str(r.date, 10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const tfp = r.tfp === null || r.tfp === undefined ? null : num(r.tfp);
  const updated = Date.parse(r.updated_at || '');
  return {
    id: String(r.id),
    dep: str(r.dep, 8).toUpperCase(),
    arr: str(r.arr, 8).toUpperCase(),
    flight_num: str(r.flight_num, 16).toUpperCase(),
    date,
    elapsed, landing_rate: rate, landing_g: g,
    aircraft: str(r.aircraft, 12).toUpperCase(),
    notes: str(r.notes, 2000),
    shared_cockpit: !!r.shared_cockpit,
    role: str(r.role, 24),
    exclude_from_avg: !!r.exclude_from_avg,
    windshear: false,
    sva: !!r.sva,
    tfp: tfp !== null && tfp >= 0 && tfp <= 60 ? tfp : null,
    rank: str(r.rank, 32),
    updated_at: isNaN(updated) ? new Date().toISOString() : new Date(updated).toISOString()
  };
}

module.exports = {
  COOKIE_NAME, SESSION_SECONDS, ID_RE,
  env, missingConfig, send, methodNotAllowed, readJson,
  makeToken, isAdmin, sessionCookie, clearedCookie, checkCredentials, sameOrigin,
  clientIp, isBlocked, recordFail, clearFails, resetThrottle,
  supabase, cleanRow
};
