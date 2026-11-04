'use strict';
const s = require('../lib/server');

module.exports = async function handler(req, res){
  if(req.method !== 'POST') return s.methodNotAllowed(res, 'POST');
  if(!s.sameOrigin(req)) return s.send(res, 403, { error: 'Request blocked.' });
  s.send(res, 200, { ok: true }, { 'Set-Cookie': s.clearedCookie() });
};
