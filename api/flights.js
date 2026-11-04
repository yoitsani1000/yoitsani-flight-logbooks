'use strict';
const s = require('../lib/server');

const PAGE = 1000;
const MAX_UPSERTS = 1000;
const MAX_DELETES = 1000;

// Anyone can read. Only a logged-in admin can write.
module.exports = async function handler(req, res){
  if(req.method === 'GET') return read(req, res);
  if(req.method === 'POST') return write(req, res);
  s.methodNotAllowed(res, 'GET, POST');
};

async function read(req, res){
  const missing = s.missingConfig();
  if(missing.length) return s.send(res, 500, { error: 'The server is not set up yet. Missing in Vercel: ' + missing.join(', ') + '.' });
  try{
    const flights = [];
    for(let offset = 0; ; offset += PAGE){
      const r = await s.supabase(`flights?select=*&order=id.asc&limit=${PAGE}&offset=${offset}`, { method: 'GET' });
      if(!r.ok) return s.send(res, 502, { error: 'The database could not be read (' + r.status + ').' });
      const rows = Array.isArray(r.data) ? r.data : [];
      flights.push(...rows);
      if(rows.length < PAGE) break;
      if(offset > 50000) break; // safety stop
    }
    s.send(res, 200, { flights });
  }catch(e){
    s.send(res, 502, { error: 'The database could not be reached.' });
  }
}

async function write(req, res){
  if(!s.sameOrigin(req)) return s.send(res, 403, { error: 'Request blocked.' });
  if(!s.isAdmin(req)) return s.send(res, 401, { error: 'Log in as admin to make changes.' });
  const missing = s.missingConfig();
  if(missing.length) return s.send(res, 500, { error: 'The server is not set up yet. Missing in Vercel: ' + missing.join(', ') + '.' });

  let body;
  try{ body = await s.readJson(req); }catch(e){ return s.send(res, 400, { error: e.message }); }

  const rawUpserts = Array.isArray(body && body.upserts) ? body.upserts : [];
  const rawDeletes = Array.isArray(body && body.softDeletes) ? body.softDeletes : [];
  if(rawUpserts.length > MAX_UPSERTS || rawDeletes.length > MAX_DELETES){
    return s.send(res, 413, { error: 'Too many changes in one request.' });
  }

  const rows = rawUpserts.map(s.cleanRow);
  if(rows.some(r => r === null)) return s.send(res, 400, { error: 'One of the flights has missing or invalid values.' });
  const ids = rawDeletes.map(String);
  if(ids.some(id => !s.ID_RE.test(id))) return s.send(res, 400, { error: 'One of the flight ids is invalid.' });

  try{
    if(rows.length){
      const r = await s.supabase('flights?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(rows)
      });
      if(!r.ok) return s.send(res, 502, { error: 'The database rejected the save (' + r.status + ').' + detail(r.data) });
    }
    if(ids.length){
      const list = ids.map(encodeURIComponent).join(',');
      const r = await s.supabase(`flights?id=in.(${list})`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ deleted_at: new Date().toISOString() })
      });
      if(!r.ok) return s.send(res, 502, { error: 'The database rejected the delete (' + r.status + ').' + detail(r.data) });
    }
    s.send(res, 200, { ok: true, upserted: rows.length, deleted: ids.length });
  }catch(e){
    s.send(res, 502, { error: 'The database could not be reached.' });
  }
}

// Include Supabase's own message (for example a missing column) but never anything else.
function detail(data){
  return data && typeof data === 'object' && data.message ? ' ' + String(data.message).slice(0, 200) : '';
}
