/* =====================================================================
   M3D OSCE Platform — server.js
   Backend Node.js: Express (API REST) + Socket.io (tempo real:
   chat, reações, cards, presença e sinalização WebRTC mesh) + SQLite.
   Banco: pratica_m3d.sqlite (criado automaticamente na mesma pasta).
   IA com cadeia de failsafe: Gemini → OpenAI → Pollinations.
===================================================================== */
'use strict';
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 30;

/* ---------------- Chaves de IA (env > padrão do escopo) ---------------- */
const AI_CFG = {
  geminiKey:   process.env.GEMINI_API_KEY   || 'AIzaSyAcfi7swz1RzgX1UqdkHQgXSHpzQDADW3A',
  geminiModel: process.env.GEMINI_MODEL     || 'gemini-flash-latest',
  oaiBase:     process.env.OPENAI_BASE_URL  || 'https://api.openai.com/v1',
  oaiKey:      process.env.OPENAI_API_KEY   || '',
  oaiModel:    process.env.OPENAI_MODEL     || 'gpt-4o-mini',
  pollToken:   process.env.POLLINATIONS_TOKEN || 'sk_2h8FmbcLahrdZo5GZTVMv2CJHBG7L2Ui',
  pollModel:   process.env.POLLINATIONS_MODEL || 'openai'
};

/* ---------------- Banco de dados SQLite ---------------- */
const db = new Database(path.join(__dirname, 'pratica_m3d.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
  reset_token TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(
  id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT,
  station_id TEXT NOT NULL, station_ids TEXT,
  mode TEXT, vis TEXT, creator TEXT, creator_name TEXT,
  created INTEGER, closed INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS room_members(
  room_id TEXT, email TEXT, PRIMARY KEY(room_id,email));
CREATE TABLE IF NOT EXISTS stations(
  id TEXT PRIMARY KEY, json TEXT NOT NULL,
  created_by TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT, area TEXT, tema TEXT, pct INTEGER, got INTEGER, tot INTEGER,
  time_used INTEGER, room TEXT, ai INTEGER DEFAULT 0,
  transcript TEXT, review TEXT, date INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS history_uniq ON history(email,date,tema);
`);

/* Seed automático: root / @0Arcano (bcrypt) */
if (!db.prepare(`SELECT COUNT(*) c FROM users WHERE email='root'`).get().c) {
  db.prepare(`INSERT INTO users(name,email,pass,role,created) VALUES('Administrador Root','root',?,'root',?)`)
    .run(bcrypt.hashSync('@0Arcano', 10), Date.now());
  console.log('✔ Usuário root criado (root / @0Arcano) — troque a senha depois.');
}

/* ---------------- Helpers ---------------- */
const now = () => Date.now();
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const mkCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[crypto.randomInt(31)]).join('');

function userByToken(token) {
  if (!token) return null;
  const s = db.prepare(`SELECT * FROM sessions WHERE token=?`).get(token);
  if (!s || s.expires < Math.floor(now() / 1000)) return null;
  return db.prepare(`SELECT id,name,email,role,created FROM users WHERE email=?`).get(s.email) || null;
}
function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/Bearer\s+(.+)/i);
  return m ? m[1] : null;
}
/** middleware REST: exige sessão válida */
function auth(req, res, next) {
  const u = userByToken(bearer(req));
  if (!u) return res.status(401).json({ error: 'não autenticado / sessão expirada' });
  req.user = u; next();
}
const isAdmin = (u) => u.role === 'root' || u.role === 'admin';

function roomOut(r) {
  const members = db.prepare(`SELECT email FROM room_members WHERE room_id=?`).all(r.id).map(x => x.email);
  return {
    id: r.id, code: r.code, name: r.name, stationId: r.station_id,
    stationIds: JSON.parse(r.station_ids || '[]'), mode: r.mode, vis: r.vis,
    creator: r.creator, creatorName: r.creator_name, created: r.created, members
  };
}

/* =====================================================================
   IA — cadeia de failsafe Gemini → OpenAI → Pollinations (server-side,
   as chaves nunca vão ao navegador)
===================================================================== */
async function aiGemini(prompt, messages) {
  if (!AI_CFG.geminiKey) throw new Error('Gemini sem chave');
  const body = messages
    ? {
        contents: messages.filter(m => m.role !== 'system')
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        ...(messages.find(m => m.role === 'system')
          ? { systemInstruction: { parts: [{ text: messages.find(m => m.role === 'system').content }] } } : {})
      }
    : { contents: [{ parts: [{ text: prompt }] }] };
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${AI_CFG.geminiModel}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-goog-api-key': AI_CFG.geminiKey },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error('Gemini HTTP ' + r.status);
  return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
}
async function aiOpenAI(prompt, messages) {
  if (!AI_CFG.oaiKey) throw new Error('OpenAI sem chave');
  const r = await fetch(AI_CFG.oaiBase.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_CFG.oaiKey },
    body: JSON.stringify({ model: AI_CFG.oaiModel, messages: messages || [{ role: 'user', content: prompt }], temperature: .7 }),
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error('OpenAI HTTP ' + r.status);
  return (await r.json()).choices?.[0]?.message?.content || '';
}
async function aiPollinations(prompt, messages) {
  const r = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_CFG.pollToken },
    body: JSON.stringify({ model: AI_CFG.pollModel, messages: messages || [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error('Pollinations HTTP ' + r.status);
  return (await r.json()).choices?.[0]?.message?.content || '';
}
/** Executa a cadeia de failsafe. Retorna {text, provider}. */
async function callAI(prompt, messages) {
  const errs = [];
  for (const [name, fn] of [['Gemini', aiGemini], ['OpenAI', aiOpenAI], ['Pollinations', aiPollinations]]) {
    try {
      const t = await fn(prompt, messages);
      if (t && t.length > 3) return { text: t, provider: name };
      errs.push(name + ': resposta vazia');
    } catch (e) { errs.push(name + ': ' + e.message); }
  }
  throw new Error('Todos os provedores de IA falharam. ' + errs.join(' | '));
}

/* =====================================================================
   API REST (Express)
===================================================================== */
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/ping', (req, res) => res.json({ ok: true, server: 'M3D OSCE Platform Node/Socket.io', time: now() }));

/* ---------- Auth ---------- */
app.post('/api/register', (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const pass = String(req.body.pass || '');
    if (!name || !email || !pass) return res.status(400).json({ error: 'Preencha todos os campos' });
    if (email === 'root') return res.status(403).json({ error: 'Identidade reservada' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido' });
    if (db.prepare(`SELECT COUNT(*) c FROM users WHERE email=?`).get(email).c)
      return res.status(409).json({ error: 'E-mail já cadastrado' });
    db.prepare(`INSERT INTO users(name,email,pass,role,created) VALUES(?,?,?,'user',?)`)
      .run(name, email, bcrypt.hashSync(pass, 10), now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const pass = String(req.body.pass || '');
    const u = db.prepare(`SELECT * FROM users WHERE email=?`).get(email);
    if (!u || !bcrypt.compareSync(pass, u.pass)) return res.status(401).json({ error: 'credenciais' });
    const t = rnd(24);
    db.prepare(`INSERT INTO sessions(token,email,expires) VALUES(?,?,?)`)
      .run(t, email, Math.floor(now() / 1000) + 60 * 60 * 24 * SESSION_DAYS);
    res.json({ ok: true, token: t, user: { name: u.name, email: u.email, role: u.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => {
  const t = bearer(req);
  if (t) db.prepare(`DELETE FROM sessions WHERE token=?`).run(t);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ ok: true, user: req.user }));

/* Recuperação de senha por token */
app.post('/api/forgot', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!db.prepare(`SELECT COUNT(*) c FROM users WHERE email=?`).get(email).c)
    return res.status(404).json({ error: 'E-mail não encontrado' });
  const tk = 'RESET-' + rnd(4).toUpperCase();
  db.prepare(`UPDATE users SET reset_token=? WHERE email=?`).run(tk, email);
  /* Em produção: enviar por e-mail (SMTP). Em ambiente local, retorna na resposta. */
  res.json({ ok: true, token: tk });
});
app.post('/api/reset', (req, res) => {
  const tk = String(req.body.token || '').trim();
  const u = db.prepare(`SELECT email FROM users WHERE reset_token=?`).get(tk);
  if (!u) return res.status(400).json({ error: 'Token inválido' });
  db.prepare(`UPDATE users SET pass=?, reset_token=NULL WHERE email=?`)
    .run(bcrypt.hashSync(String(req.body.pass || ''), 10), u.email);
  res.json({ ok: true });
});

/* ---------- Usuários / presença ---------- */
app.get('/api/users', auth, (req, res) => {
  const users = db.prepare(`SELECT name,email,role,created FROM users ORDER BY name`).all();
  res.json({ ok: true, users, online: onlineList() });
});

/* Papéis: somente root promove/revoga admins; root e admins não podem ser excluídos */
app.post('/api/set_role', auth, (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'somente root' });
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  db.prepare(`UPDATE users SET role=? WHERE email=? AND role!='root'`).run(role, String(req.body.email || ''));
  res.json({ ok: true });
});
app.post('/api/del_user', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'sem permissão' });
  const email = String(req.body.email || '');
  const u = db.prepare(`SELECT role FROM users WHERE email=?`).get(email);
  if (!u) return res.status(404).json({ error: 'usuário não encontrado' });
  if (u.role === 'root' || u.role === 'admin')
    return res.status(403).json({ error: 'root e administradores não podem ser excluídos' });
  db.prepare(`DELETE FROM users WHERE email=?`).run(email);
  res.json({ ok: true });
});

/* ---------- Salas ---------- */
app.get('/api/rooms', auth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM rooms WHERE closed=0 ORDER BY created DESC`).all();
  res.json({ ok: true, rooms: rows.map(roomOut) });
});

app.post('/api/room_create', auth, (req, res) => {
  try {
    const ids = Array.isArray(req.body.stationIds) ? req.body.stationIds : [];
    if (!ids.length) return res.status(400).json({ error: 'Selecione ao menos 1 estação para abrir a sala' });
    if (req.user.role === 'user') /* regra da sala única: criar nova encerra as anteriores */
      db.prepare(`UPDATE rooms SET closed=1 WHERE creator=?`).run(req.user.email);
    const id = 'room-' + rnd(5), code = mkCode();
    const name = String(req.body.name || '').trim() || ('Sala de ' + req.user.name);
    db.prepare(`INSERT INTO rooms(id,code,name,station_id,station_ids,mode,vis,creator,creator_name,created)
                VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id, code, name, ids[0], JSON.stringify(ids),
        req.body.mode === 'ia' ? 'ia' : 'users', req.body.vis === 'closed' ? 'closed' : 'open',
        req.user.email, req.user.name, now());
    for (const m of (req.body.members || []))
      db.prepare(`INSERT OR IGNORE INTO room_members(room_id,email) VALUES(?,?)`).run(id, String(m));
    broadcastRooms();
    res.json({ ok: true, id, code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/room_update', auth, (req, res) => {
  const r = db.prepare(`SELECT * FROM rooms WHERE id=?`).get(String(req.body.id || ''));
  if (!r) return res.status(404).json({ error: 'Sala não encontrada' });
  if (r.creator !== req.user.email && !isAdmin(req.user)) return res.status(403).json({ error: 'sem permissão' });
  if (req.body.stationId) {
    db.prepare(`UPDATE rooms SET station_id=? WHERE id=?`).run(String(req.body.stationId), r.id);
    io.to(r.id).emit('room:station', { roomId: r.id, stationId: String(req.body.stationId), by: req.user.name });
  }
  broadcastRooms();
  res.json({ ok: true });
});

app.post('/api/room_join', auth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const id = String(req.body.id || '');
  const r = code
    ? db.prepare(`SELECT * FROM rooms WHERE code=? AND closed=0`).get(code)
    : db.prepare(`SELECT * FROM rooms WHERE id=? AND closed=0`).get(id);
  if (!r) return res.status(404).json({ error: 'Sala não existe mais' });
  const mem = db.prepare(`SELECT email FROM room_members WHERE room_id=?`).all(r.id).map(x => x.email);
  const priv = isAdmin(req.user) || r.creator === req.user.email;
  if (r.vis === 'closed' && !priv && !mem.includes(req.user.email)) {
    if (code) /* link de convite concede acesso à sala fechada */
      db.prepare(`INSERT OR IGNORE INTO room_members(room_id,email) VALUES(?,?)`).run(r.id, req.user.email);
    else return res.status(403).json({ error: 'Sala fechada — peça o link de convite' });
  }
  res.json({ ok: true, room: roomOut(r) });
});

app.post('/api/room_members_add', auth, (req, res) => {
  const r = db.prepare(`SELECT * FROM rooms WHERE id=?`).get(String(req.body.id || ''));
  if (!r) return res.status(404).json({ error: 'Sala não encontrada' });
  if (r.creator !== req.user.email && !isAdmin(req.user)) return res.status(403).json({ error: 'sem permissão' });
  for (const m of (req.body.members || []))
    db.prepare(`INSERT OR IGNORE INTO room_members(room_id,email) VALUES(?,?)`).run(r.id, String(m));
  broadcastRooms();
  res.json({ ok: true });
});

app.post('/api/room_close', auth, (req, res) => {
  const r = db.prepare(`SELECT creator FROM rooms WHERE id=?`).get(String(req.body.id || ''));
  if (!r) return res.status(404).json({ error: 'Sala não encontrada' });
  if (r.creator !== req.user.email && !isAdmin(req.user)) return res.status(403).json({ error: 'sem permissão' });
  db.prepare(`UPDATE rooms SET closed=1 WHERE id=?`).run(String(req.body.id));
  io.to(String(req.body.id)).emit('room:closed', { roomId: String(req.body.id) });
  broadcastRooms();
  res.json({ ok: true });
});

/* ---------- Estações personalizadas (catálogo compartilhado, admin) ---------- */
app.get('/api/stations', auth, (req, res) => {
  const rows = db.prepare(`SELECT json FROM stations ORDER BY created`).all();
  res.json({ ok: true, stations: rows.map(r => JSON.parse(r.json)) });
});
app.post('/api/stations', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'somente administradores' });
  try {
    const list = Array.isArray(req.body.stations) ? req.body.stations : [req.body.station];
    let n = 0;
    const ins = db.prepare(`INSERT OR REPLACE INTO stations(id,json,created_by,created) VALUES(?,?,?,?)`);
    const tx = db.transaction(() => {
      for (const s of list) {
        if (!s || !s.tema || !s.area || !Array.isArray(s.checklist)) continue;
        s.id = s.id || ('cst-' + rnd(5));
        ins.run(s.id, JSON.stringify(s), req.user.email, now()); n++;
      }
    });
    tx();
    io.emit('stations:changed');
    res.json({ ok: true, imported: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/stations/:id', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'somente administradores' });
  db.prepare(`DELETE FROM stations WHERE id=?`).run(req.params.id);
  io.emit('stations:changed');
  res.json({ ok: true });
});

/* ---------- Histórico de performance + card de revisão ---------- */
app.post('/api/history_add', auth, (req, res) => {
  try {
    const d = req.body, date = Number(d.date) || now();
    const review = d.review ? JSON.stringify(d.review) : null;
    db.prepare(`INSERT OR IGNORE INTO history(email,area,tema,pct,got,tot,time_used,room,ai,transcript,review,date)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.user.email, d.area || '', d.tema || '', Number(d.pct) || 0, Number(d.got) || 0, Number(d.tot) || 0,
        Number(d.timeUsed) || 0, d.room || null, d.ai ? 1 : 0, d.transcript || null, review, date);
    if (review) /* se já existia e veio revisão nova, atualiza */
      db.prepare(`UPDATE history SET review=? WHERE email=? AND date=? AND tema=?`)
        .run(review, req.user.email, date, d.tema || '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/history_list', auth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM history WHERE email=? ORDER BY date`).all(req.user.email);
  res.json({
    ok: true, history: rows.map(r => ({
      area: r.area, tema: r.tema, pct: r.pct, got: r.got, tot: r.tot,
      timeUsed: r.time_used, room: r.room, ai: r.ai, transcript: r.transcript,
      review: r.review ? JSON.parse(r.review) : null, date: r.date
    }))
  });
});

/* ---------- IA (proxy com failsafe — chaves ficam no servidor) ---------- */
app.post('/api/ai', auth, async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '');
    if (!prompt) return res.status(400).json({ error: 'prompt vazio' });
    const r = await callAI(prompt, null);
    res.json({ ok: true, text: r.text, provider: r.provider });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/ai/chat', auth, async (req, res) => {
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ error: 'messages vazio' });
    const r = await callAI(null, messages.map(m => ({ role: String(m.role), content: String(m.content).slice(0, 8000) })));
    res.json({ ok: true, text: r.text, provider: r.provider });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/ai/test', auth, async (req, res) => {
  const out = [];
  for (const [n, f] of [['Gemini', aiGemini], ['OpenAI', aiOpenAI], ['Pollinations', aiPollinations]]) {
    const t = Date.now();
    try { await f('Responda apenas: pong', null); out.push({ provider: n, ok: true, ms: Date.now() - t }); }
    catch (e) { out.push({ provider: n, ok: false, error: e.message }); }
  }
  res.json({ ok: true, results: out });
});

/* =====================================================================
   Socket.io — tempo real (chat, reações, cards, presença, WebRTC mesh)
===================================================================== */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/* Presença em memória: email → {name, role, room, roomRole, ts, sockets:Set} */
const presence = new Map();
function onlineList() {
  const t = now(), out = [];
  for (const [email, p] of presence)
    if (t - p.ts < 25000 && p.sockets.size)
      out.push({ email, name: p.name, role: p.role, room: p.room, roomRole: p.roomRole });
  return out;
}
function broadcastPresence() { io.emit('presence', onlineList()); }
function broadcastRooms() {
  const rows = db.prepare(`SELECT * FROM rooms WHERE closed=0 ORDER BY created DESC`).all();
  io.emit('rooms', rows.map(roomOut));
}
setInterval(broadcastPresence, 5000);

/* Autenticação do handshake por token Bearer */
io.use((socket, next) => {
  const u = userByToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('não autenticado'));
  socket.user = u; next();
});

io.on('connection', (socket) => {
  const u = socket.user;
  let p = presence.get(u.email);
  if (!p) { p = { name: u.name, role: u.role, room: null, roomRole: null, ts: now(), sockets: new Set() }; presence.set(u.email, p); }
  p.name = u.name; p.role = u.role; p.ts = now(); p.sockets.add(socket.id);

  socket.emit('presence', onlineList());
  broadcastRooms();

  /* heartbeat: mantém presença e sala/papel atuais */
  socket.on('heartbeat', (d) => {
    const pp = presence.get(u.email); if (!pp) return;
    pp.ts = now();
    if (d && typeof d === 'object') { pp.room = d.room || null; pp.roomRole = d.roomRole || null; }
  });

  /* ---------- entrar/sair de sala (join socket room + aviso aos pares) ---------- */
  socket.on('room:join', (d) => {
    const roomId = String(d?.roomId || ''); if (!roomId) return;
    const r = db.prepare(`SELECT * FROM rooms WHERE id=? AND closed=0`).get(roomId);
    if (!r) return;
    socket.join(roomId);
    socket.data.room = roomId;
    socket.data.roomRole = String(d?.role || 'medico');
    const pp = presence.get(u.email); if (pp) { pp.room = roomId; pp.roomRole = socket.data.roomRole; pp.ts = now(); }
    socket.to(roomId).emit('room:peer_joined', { roomId, email: u.email, name: u.name, role: socket.data.roomRole });
    socket.emit('room:joined', { ok: true, room: roomOut(r) });
    broadcastPresence();
    io.to(roomId).emit('room:presence', { roomId, online: onlineList().filter(x => x.room === roomId) });
  });

  socket.on('room:leave', () => {
    const roomId = socket.data.room;
    if (roomId) {
      socket.leave(roomId);
      socket.to(roomId).emit('room:peer_left', { roomId, email: u.email, name: u.name });
      io.to(roomId).emit('room:presence', { roomId, online: onlineList().filter(x => x.room === roomId) });
    }
    socket.data.room = null;
    const pp = presence.get(u.email); if (pp) { pp.room = null; pp.roomRole = null; pp.ts = now(); }
    broadcastPresence();
  });

  /* ---------- chat (lobby = 'lobby' · sala = roomId) ---------- */
  socket.on('chat', (d) => {
    const room = String(d?.room || ''); if (!room) return;
    const text = String(d?.text || '').slice(0, 2000); if (!text.trim()) return;
    const msg = { room, email: u.email, name: u.name, text, ts: now() };
    if (room === 'lobby') io.emit('chat', msg);
    else io.to(room).emit('chat', msg);
  });

  /* ---------- reações com emoji (ao vivo) ---------- */
  socket.on('react', (d) => {
    const room = String(d?.room || ''); const emoji = String(d?.emoji || '').slice(0, 8);
    if (!room || !emoji) return;
    io.to(room).emit('react', { room, email: u.email, name: u.name, emoji, ts: now() });
  });

  /* ---------- cards compartilháveis (avaliador/chefe → sala) ---------- */
  socket.on('card', (d) => {
    const room = String(d?.room || ''); if (!room) return;
    const card = {
      cid: String(d?.cid || rnd(6)), cat: String(d?.cat || 'geral'),
      text: String(d?.text || '').slice(0, 1000), by: u.name, role: socket.data.roomRole || '',
      stationId: d?.stationId || null, stationTema: String(d?.stationTema || ''), ts: now()
    };
    if (!card.text.trim()) return;
    io.to(room).emit('card', { room, card });
  });

  /* ---------- sinalização WebRTC mesh (offer/answer/ICE/hello/bye) ---------- */
  socket.on('signal', (d) => {
    const room = String(d?.room || ''); if (!room) return;
    const kind = String(d?.kind || '');
    if (!['hello', 'offer', 'answer', 'ice', 'bye'].includes(kind)) return;
    const dst = d?.dst ? String(d.dst) : null;
    const envelope = { room, src: u.email, name: u.name, kind, payload: d?.payload ?? null };
    if (dst) {
      const target = presence.get(dst);
      if (target) for (const sid of target.sockets) io.to(sid).emit('signal', envelope);
    } else {
      socket.to(room).emit('signal', envelope); /* broadcast (ex.: hello/bye) */
    }
  });

  socket.on('disconnect', () => {
    const pp = presence.get(u.email);
    if (pp) {
      pp.sockets.delete(socket.id);
      if (!pp.sockets.size) {
        const roomId = pp.room;
        presence.delete(u.email);
        if (roomId) {
          io.to(roomId).emit('room:peer_left', { roomId, email: u.email, name: u.name });
          io.to(roomId).emit('room:presence', { roomId, online: onlineList().filter(x => x.room === roomId) });
        }
      }
    }
    broadcastPresence();
  });
});

/* ---------------- start ---------------- */
server.listen(PORT, () => {
  console.log(`\n🩺 M3D OSCE Platform rodando em http://localhost:${PORT}`);
  console.log(`   Login administrador: root / @0Arcano\n`);
});
