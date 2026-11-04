'use strict';
const s = require('../lib/server');

module.exports = async function handler(req, res){
  if(req.method !== 'GET') return s.methodNotAllowed(res, 'GET');
  const admin = s.isAdmin(req);
  s.send(res, 200, admin ? { admin: true, username: s.env('ADMIN_USERNAME') } : { admin: false });
};
