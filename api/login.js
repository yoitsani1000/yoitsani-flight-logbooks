'use strict';
const s = require('../lib/server');

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return s.methodNotAllowed(res, 'POST');
  if(!s.sameOrigin(req)) return s.send(res, 403, { error: 'Request blocked.' });

  const missing = s.missingConfig();
  if(missing.length) return s.send(res, 500, { error: 'The server is not set up yet. Missing in Vercel: ' + missing.join(', ') + '.' });

  const ip = s.clientIp(req);
  if(s.isBlocked(ip)) return s.send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });

  let body;
  try{ body = await s.readJson(req); }catch(e){ return s.send(res, 400, { error: e.message }); }

  if(!s.checkCredentials(body && body.username, body && body.password)){
    s.recordFail(ip);
    await sleep(500); // slows down guessing
    return s.send(res, 401, { error: 'That username and password do not match.' });
  }

  s.clearFails(ip);
  s.send(res, 200, { ok: true, admin: true, username: s.env('ADMIN_USERNAME') }, { 'Set-Cookie': s.sessionCookie(s.makeToken()) });
};
