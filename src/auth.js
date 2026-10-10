'use strict';
/** Identidade, Acesso & Segurança — bcrypt (bcryptjs), Bearer de 30 dias, RBAC. */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, now } = require('./db');
const cfg = require('./config');

function tokenFor(uid) {
  const token = crypto.randomBytes(24).toString('hex');
  const exp = now() + cfg.SESSION_DAYS * 86400 * 1000;
  db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)')
    .run(token, uid, now(), exp);
  return { token, expires_at: exp };
}

function userByToken(token) {
  if (!token) return null;
  const u = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                        WHERE s.token = ? AND s.expires_at > ?`).get(token, now());
  return u && !u.banned ? u : null;
}

function publicUser(u) {
  return u ? { id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at, avatar: u.avatar || '🩺', dashboard: JSON.parse(u.dashboard || '{}') } : null;
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : (req.method === 'GET' ? (req.query.token || '') : '');
}

/** Middleware Express: req.user ou 401/403. roles vazio = qualquer autenticado. */
function requireAuth(roles = []) {
  return (req, res, next) => {
    const u = userByToken(bearer(req));
    if (!u) return res.status(401).json({ ok: false, error: 'Não autenticado.' });
    if (roles.length && !roles.includes(u.role))
      return res.status(403).json({ ok: false, error: 'Sem permissão.' });
    req.user = u;
    next();
  };
}

/** Auth para Socket.io via handshake.auth.token */
function socketUser(socket) {
  return userByToken(socket.handshake.auth && socket.handshake.auth.token);
}

function login(login, password) {
  const u = db.prepare('SELECT * FROM users WHERE email = ? OR (name = ? AND role = \'root\')').get(String(login).trim().toLowerCase(), login);
  if (!u || u.banned || !bcrypt.compareSync(String(password || ''), u.pass_hash)) return null;
  return u;
}

function register(name, email, password) {
  const hash = bcrypt.hashSync(String(password), 10);
  const info = db.prepare('INSERT INTO users(name,email,pass_hash,role,created_at) VALUES(?,?,?,?,?)')
    .run(String(name).trim(), String(email).trim().toLowerCase(), hash, 'user', now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function logout(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function gcSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
}

module.exports = { tokenFor, userByToken, publicUser, requireAuth, socketUser, login, register, logout, bearer, gcSessions };
