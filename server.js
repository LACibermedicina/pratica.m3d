/* =====================================================================
   pratica.M3D — OSCE Platform v3 (reelaborada)
   Node.js: Express (REST) + Socket.io (tempo real: presença, chat,
   chat oculto de observadores, timer sincronizado, sinalização WebRTC
   mesh) + SQLite. IA server-side com failsafe Gemini → OpenAI →
   Pollinations. Instalação: npm install && npm start
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

/* ---------------- Chaves de IA (env > padrão) ---------------- */
const AI_CFG = {
  geminiKey:   process.env.GEMINI_API_KEY     || 'AQ.Ab8RN6JsrosB2v035aG0djbonAdmgSuTsxgBWkCTVZ90kk1iAQ',
  geminiKey2:  process.env.GOOGLE_API_KEY     || 'AIzaSyAmwepe9tICXQBbtYTT5IGiPnFbHGW182g',
  geminiModel: process.env.GEMINI_MODEL       || 'gemini-flash-latest',
  oaiBase:     process.env.OPENAI_BASE_URL    || 'https://api.openai.com/v1',
  oaiKey:      process.env.OPENAI_API_KEY     || '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',
  oaiModel:    process.env.OPENAI_MODEL       || 'gpt-4o-mini',
  pollToken:   process.env.POLLINATIONS_TOKEN || 'sk_2h8FmbcLahrdZo5GZTVMv2CJHBG7L2Ui',
  pollModel:   process.env.POLLINATIONS_MODEL || 'openai'
};

/* ---------------- Banco SQLite ---------------- */
const db = new Database(path.join(__dirname, 'pratica_m3d.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  avatar TEXT NOT NULL DEFAULT '🩺',
  prefs TEXT NOT NULL DEFAULT '{}',
  reset_token TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stations(
  id TEXT PRIMARY KEY, json TEXT NOT NULL,
  created_by TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(
  id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT,
  station_id TEXT, station_ids TEXT, mode TEXT, vis TEXT,
  creator TEXT, creator_name TEXT,
  duration INTEGER NOT NULL DEFAULT 600,      -- duração da estação (seg, customizável)
  tstate TEXT NOT NULL DEFAULT 'parado',      -- parado|ativo|pausado|encerrado
  remaining INTEGER NOT NULL DEFAULT 600,     -- restante (seg) — fonte da verdade p/ sync
  tstamp INTEGER NOT NULL DEFAULT 0,          -- quando remaining foi calculado
  created INTEGER, closed INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS room_members(
  room_id TEXT, email TEXT, PRIMARY KEY(room_id,email));
CREATE TABLE IF NOT EXISTS pep_results(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT, station_id TEXT, area TEXT, tema TEXT,
  candidate TEXT NOT NULL, evaluator TEXT,
  scores TEXT NOT NULL,          -- [{item,peso,ok,disputado,nota}]
  pct REAL NOT NULL DEFAULT 0,   -- % válida (redistribuída)
  pct_real REAL,                 -- % original antes de disputas
  invalid REAL NOT NULL DEFAULT 0, -- % do peso invalidado
  status TEXT NOT NULL DEFAULT 'aguardando', -- aguardando|confirmado|disputado|anulado
  transcript TEXT, ai INTEGER DEFAULT 0,
  time_used INTEGER DEFAULT 0,
  created INTEGER NOT NULL, updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS review_cards(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL, station_id TEXT, pep_id INTEGER,
  area TEXT, tema TEXT, pergunta TEXT NOT NULL, resposta TEXT NOT NULL,
  reviews INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0, next_review INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat_archive(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL, email TEXT, name TEXT, text TEXT,
  ts INTEGER NOT NULL, bucket INTEGER NOT NULL);  -- bucket = hora (epoch/3600000)
CREATE TABLE IF NOT EXISTS observer_chat(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL, email TEXT, name TEXT, text TEXT,
  is_ai INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS friends(
  a TEXT NOT NULL, b TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|accepted
  ts INTEGER NOT NULL, PRIMARY KEY(a,b));
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  data TEXT, read INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL);
`);

/* Seed root + config padrão */
if (!db.prepare(`SELECT COUNT(*) c FROM users WHERE email='root'`).get().c) {
  db.prepare(`INSERT INTO users(name,email,pass,role,avatar,created) VALUES('Administrador Root','root',?,'root','👑',?)`)
    .run(bcrypt.hashSync('@0Arcano', 10), Date.now());
  console.log('✔ root criado (root / @0Arcano) — troque a senha.');
}
const getSetting = (k, d) => { const r = db.prepare(`SELECT value FROM settings WHERE key=?`).get(k); return r ? r.value : d; };
const setSetting = (k, v) => db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`).run(k, String(v));
if (getSetting('invalidation_threshold', null) === null) setSetting('invalidation_threshold', 40);
if (getSetting('chat_retention_hours', null) === null) setSetting('chat_retention_hours', 2);

/* Seed do catálogo: estações padronizadas (XLSX convertido) + material base */
if (!db.prepare(`SELECT COUNT(*) c FROM stations`).get().c) {
  try {
    const fs = require('fs');
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed_stations.json'), 'utf8'));
    const ins = db.prepare(`INSERT OR IGNORE INTO stations(id,json,created_by,created) VALUES(?,?,?,?)`);
    db.transaction(() => { for (const s of seed) ins.run(s.id, JSON.stringify(s), 'seed', now()); })();
    console.log('✔ catálogo semeado:', seed.length, 'estações padronizadas');
  } catch (e) { console.log('ℹ seed_stations.json ausente — catálogo inicia vazio'); }
}

/* Retenção do chat público: mensagens expiram após N horas (padrão 2h, relógio do servidor) */
setInterval(() => {
  const h = Number(getSetting('chat_retention_hours', 2));
  db.prepare(`DELETE FROM chat_archive WHERE ts < ?`).run(now() - h * 3600000);
}, 600000);

/* ---------------- Helpers ---------------- */
const now = () => Date.now();
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const mkCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[crypto.randomInt(31)]).join('');

function userByToken(token) {
  if (!token) return null;
  const s = db.prepare(`SELECT * FROM sessions WHERE token=?`).get(token);
  if (!s || s.expires < Math.floor(now() / 1000)) return null;
  return db.prepare(`SELECT id,name,email,role,avatar,prefs,created FROM users WHERE email=?`).get(s.email) || null;
}
function bearer(req) { const m = (req.headers.authorization || '').match(/Bearer\s+(.+)/i); return m ? m[1] : null; }
function auth(req, res, next) {
  const u = userByToken(bearer(req));
  if (!u) return res.status(401).json({ error: 'não autenticado' });
  req.user = u; next();
}
const isAdmin = (u) => u.role === 'root' || u.role === 'admin';

function roomOut(r) {
  const members = db.prepare(`SELECT email FROM room_members WHERE room_id=?`).all(r.id).map(x => x.email);
  const rem = computeRemaining(r);
  return {
    id: r.id, code: r.code, name: r.name, stationId: r.station_id,
    stationIds: JSON.parse(r.station_ids || '[]'), mode: r.mode, vis: r.vis,
    creator: r.creator, creatorName: r.creator_name, created: r.created, members,
    duration: r.duration, tstate: r.tstate, remaining: rem
  };
}
/* Timer sincronizado: remaining derivado do servidor */
function computeRemaining(r) {
  if (r.tstate === 'ativo') return Math.max(0, r.remaining - Math.floor((now() - r.tstamp) / 1000));
  return r.remaining;
}

/* =====================================================================
   IA — cadeia de failsafe (chaves só no servidor)
===================================================================== */
async function aiGemini(prompt, messages) {
  const keys = [AI_CFG.geminiKey, AI_CFG.geminiKey2].filter(Boolean);
  if (!keys.length) throw new Error('Gemini sem chave');
  const body = messages
    ? { contents: messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        ...(messages.find(m => m.role === 'system') ? { systemInstruction: { parts: [{ text: messages.find(m => m.role === 'system').content }] } } : {}) }
    : { contents: [{ parts: [{ text: prompt }] }] };
  let lastErr = null;
  for (const key of keys) {   /* tenta a chave principal e a reserva */
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${AI_CFG.geminiModel}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-goog-api-key': key },
        body: JSON.stringify(body), signal: AbortSignal.timeout(90000)
      });
      if (!r.ok) throw new Error('Gemini HTTP ' + r.status);
      return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Gemini falhou');
}
async function aiOpenAI(prompt, messages) {
  if (!AI_CFG.oaiKey) throw new Error('OpenAI sem chave');
  const r = await fetch(AI_CFG.oaiBase.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_CFG.oaiKey },
    body: JSON.stringify({ model: AI_CFG.oaiModel, messages: messages || [{ role: 'user', content: prompt }], temperature: .7 }),
    signal: AbortSignal.timeout(90000)
  });
  if (!r.ok) throw new Error('OpenAI HTTP ' + r.status);
  return (await r.json()).choices?.[0]?.message?.content || '';
}
async function aiPollinations(prompt, messages) {
  const r = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AI_CFG.pollToken },
    body: JSON.stringify({ model: AI_CFG.pollModel, messages: messages || [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(90000)
  });
  if (!r.ok) throw new Error('Pollinations HTTP ' + r.status);
  return (await r.json()).choices?.[0]?.message?.content || '';
}
async function callAI(prompt, messages) {
  const errs = [];
  for (const [name, fn] of [['Gemini', aiGemini], ['OpenAI', aiOpenAI], ['Pollinations', aiPollinations]]) {
    try { const t = await fn(prompt, messages); if (t && t.length > 3) return { text: t, provider: name }; errs.push(name + ': vazio'); }
    catch (e) { errs.push(name + ': ' + e.message); }
  }
  throw new Error('Todos os provedores de IA falharam. ' + errs.join(' | '));
}
function extractJSON(t) {
  const m = String(t).match(/```(?:json)?\s*([\s\S]*?)```/) || [null, t];
  const s = m[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('IA não retornou JSON');
  return JSON.parse(s.slice(a, b + 1));
}

/* =====================================================================
   API REST
===================================================================== */
const app = express();
app.use(express.json({ limit: '4mb' }));
/* Cabeçalhos de segurança */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/ping', (req, res) => res.json({ ok: true, time: now() }));

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
    const av = ['🩺', '💉', '🧠', '🫀', '🦷', '🧑‍⚕️'][crypto.randomInt(6)];
    db.prepare(`INSERT INTO users(name,email,pass,role,avatar,created) VALUES(?,?,?,'user',?,?)`)
      .run(name, email, bcrypt.hashSync(pass, 10), av, now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pass = String(req.body.pass || '');
  const u = db.prepare(`SELECT * FROM users WHERE email=?`).get(email);
  if (!u || !bcrypt.compareSync(pass, u.pass)) return res.status(401).json({ error: 'credenciais inválidas' });
  const t = rnd(24);
  db.prepare(`INSERT INTO sessions(token,email,expires) VALUES(?,?,?)`).run(t, email, Math.floor(now() / 1000) + 86400 * SESSION_DAYS);
  res.json({ ok: true, token: t, user: { name: u.name, email: u.email, role: u.role, avatar: u.avatar, prefs: JSON.parse(u.prefs || '{}') } });
});
app.post('/api/logout', (req, res) => { const t = bearer(req); if (t) db.prepare(`DELETE FROM sessions WHERE token=?`).run(t); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ ok: true, user: { ...req.user, prefs: JSON.parse(req.user.prefs || '{}') } }));
app.post('/api/forgot', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!db.prepare(`SELECT COUNT(*) c FROM users WHERE email=?`).get(email).c) return res.status(404).json({ error: 'E-mail não encontrado' });
  const tk = 'RESET-' + rnd(4).toUpperCase();
  db.prepare(`UPDATE users SET reset_token=? WHERE email=?`).run(tk, email);
  res.json({ ok: true, token: tk });
});
app.post('/api/reset', (req, res) => {
  const u = db.prepare(`SELECT email FROM users WHERE reset_token=?`).get(String(req.body.token || '').trim());
  if (!u) return res.status(400).json({ error: 'Token inválido' });
  db.prepare(`UPDATE users SET pass=?, reset_token=NULL WHERE email=?`).run(bcrypt.hashSync(String(req.body.pass || ''), 10), u.email);
  res.json({ ok: true });
});

/* ---------- Perfil (avatar emoji + preferências de dashboard) ---------- */
app.post('/api/profile', auth, (req, res) => {
  const u = req.user;
  if (req.body.name) db.prepare(`UPDATE users SET name=? WHERE email=?`).run(String(req.body.name).slice(0, 60), u.email);
  if (req.body.avatar) db.prepare(`UPDATE users SET avatar=? WHERE email=?`).run(String(req.body.avatar).slice(0, 8), u.email);
  if (req.body.prefs && typeof req.body.prefs === 'object')
    db.prepare(`UPDATE users SET prefs=? WHERE email=?`).run(JSON.stringify(req.body.prefs).slice(0, 8000), u.email);
  if (req.body.pass) db.prepare(`UPDATE users SET pass=? WHERE email=?`).run(bcrypt.hashSync(String(req.body.pass), 10), u.email);
  const nu = userByToken(bearer(req));
  broadcastPresence();
  res.json({ ok: true, user: { ...nu, prefs: JSON.parse(nu.prefs || '{}') } });
});

/* ---------- Usuários / presença ---------- */
app.get('/api/users', auth, (req, res) => {
  const users = db.prepare(`SELECT name,email,role,avatar,created FROM users ORDER BY name`).all();
  res.json({ ok: true, users, online: onlineList() });
});
app.post('/api/set_role', auth, (req, res) => {
  if (req.user.role !== 'root') return res.status(403).json({ error: 'somente root' });
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  db.prepare(`UPDATE users SET role=? WHERE email=? AND role!='root'`).run(role, String(req.body.email || ''));
  res.json({ ok: true });
});
app.post('/api/del_user', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'sem permissão' });
  const u = db.prepare(`SELECT role FROM users WHERE email=?`).get(String(req.body.email || ''));
  if (!u) return res.status(404).json({ error: 'usuário não encontrado' });
  if (u.role !== 'user') return res.status(403).json({ error: 'root/admins não podem ser excluídos' });
  db.prepare(`DELETE FROM users WHERE email=?`).run(String(req.body.email || ''));
  res.json({ ok: true });
});

/* ---------- Estações (salas de prática) ---------- */
app.get('/api/rooms', auth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM rooms WHERE closed=0 ORDER BY created DESC`).all();
  res.json({ ok: true, rooms: rows.map(roomOut) });
});
app.post('/api/room_create', auth, (req, res) => {
  try {
    const ids = Array.isArray(req.body.stationIds) ? req.body.stationIds : [];
    const id = 'room-' + rnd(5), code = mkCode();
    const dur = Math.min(7200, Math.max(60, Number(req.body.duration) || 600));
    db.prepare(`INSERT INTO rooms(id,code,name,station_id,station_ids,mode,vis,creator,creator_name,duration,tstate,remaining,tstamp,created)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,'parado',?,0,?)`)
      .run(id, code, String(req.body.name || '').trim() || ('Estação de ' + req.user.name),
        ids[0] || null, JSON.stringify(ids), req.body.mode === 'ia' ? 'ia' : 'users',
        req.body.vis === 'closed' ? 'closed' : 'open', req.user.email, req.user.name, dur, dur, now());
    for (const m of (req.body.members || []))
      db.prepare(`INSERT OR IGNORE INTO room_members(room_id,email) VALUES(?,?)`).run(id, String(m));
    broadcastRooms();
    res.json({ ok: true, id, code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/room_update', auth, (req, res) => {
  const r = db.prepare(`SELECT * FROM rooms WHERE id=?`).get(String(req.body.id || ''));
  if (!r) return res.status(404).json({ error: 'Estação não encontrada' });
  if (r.creator !== req.user.email && !isAdmin(req.user)) return res.status(403).json({ error: 'sem permissão' });
  if (req.body.stationId) {
    db.prepare(`UPDATE rooms SET station_id=? WHERE id=?`).run(String(req.body.stationId), r.id);
    io.to(r.id).emit('room:station', { roomId: r.id, stationId: String(req.body.stationId), by: req.user.name });
  }
  if (req.body.vis) db.prepare(`UPDATE rooms SET vis=? WHERE id=?`).run(req.body.vis === 'closed' ? 'closed' : 'open', r.id);
  broadcastRooms();
  res.json({ ok: true });
});
app.post('/api/room_join', auth, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const r = code
    ? db.prepare(`SELECT * FROM rooms WHERE code=? AND closed=0`).get(code)
    : db.prepare(`SELECT * FROM rooms WHERE id=? AND closed=0`).get(String(req.body.id || ''));
  if (!r) return res.status(404).json({ error: 'Estação não existe mais' });
  const mem = db.prepare(`SELECT email FROM room_members WHERE room_id=?`).all(r.id).map(x => x.email);
  const priv = isAdmin(req.user) || r.creator === req.user.email;
  if (r.vis === 'closed' && !priv && !mem.includes(req.user.email)) {
    if (code) db.prepare(`INSERT OR IGNORE INTO room_members(room_id,email) VALUES(?,?)`).run(r.id, req.user.email);
    else return res.status(403).json({ error: 'Estação fechada — peça o link de convite' });
  }
  res.json({ ok: true, room: roomOut(r) });
});
app.post('/api/room_close', auth, (req, res) => {
  const r = db.prepare(`SELECT creator FROM rooms WHERE id=?`).get(String(req.body.id || ''));
  if (!r) return res.status(404).json({ error: 'Estação não encontrada' });
  if (r.creator !== req.user.email && !isAdmin(req.user)) return res.status(403).json({ error: 'sem permissão' });
  db.prepare(`UPDATE rooms SET closed=1, tstate='encerrado' WHERE id=?`).run(String(req.body.id));
  io.to(String(req.body.id)).emit('room:closed', { roomId: String(req.body.id) });
  broadcastRooms();
  res.json({ ok: true });
});

/* ---------- Catálogo de estações ---------- */
app.get('/api/stations', auth, (req, res) => {
  const rows = db.prepare(`SELECT json FROM stations ORDER BY created`).all();
  res.json({ ok: true, stations: rows.map(r => JSON.parse(r.json)) });
});
app.post('/api/stations', auth, (req, res) => {
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

/* ---------- IA: geração de estação com nível de complexidade ---------- */
app.post('/api/ai/station', auth, async (req, res) => {
  try {
    const { area = 'CM', tema = '', nivel = 'intermediário', extra = '' } = req.body || {};
    const detalhe = { 'básico': 'objetiva e direta, com 6-8 itens de checklist e 2-3 cards de exames',
      'intermediário': 'detalhada, com 10-14 itens de checklist, 4-6 cards de exames e protocolo de conduta',
      'avançado': 'muito detalhada e realista, com 15-20 itens de checklist (incluindo armadilhas e intercorrências), 6-10 cards de exames pormenorizados, protocolo completo e roteiro de ator rico' }[nivel] || '';
    const prompt = `Você é elaborador de estações OSCE no padrão INEP/Revalida e bancas de residência médica brasileiras, seguindo diretrizes do Ministério da Saúde/SUS, protocolos pediátricos, curvas OMS e sociedades de especialidade.
Crie uma estação clínica ${detalhe}. Área: ${area}. Tema: ${tema || 'à sua escolha, relevante para prova prática'}. ${extra}
Responda SOMENTE com JSON no formato:
{"tema":"...","area":"${area}","especialidade":"...","nivel":"${nivel}","duracao":10,
"instrucoes":"instruções ao candidato",
"cenario":"cenário clínico completo (anamnese inicial, sinais vitais)",
"roteiroAtor":"roteiro detalhado para o ator/paciente padronizado (respostas a perguntas-chave, comportamento, achados de exame físico)",
"protocolo":"protocolo de conduta aplicável (ex.: XABCDE do trauma, ABCDE, atendimento ao RN, sutura) com passos",
"exames":[{"tipo":"laboratorial|ecg|rx|tc|rm|usg|ectoscopia|sorologia|outro","titulo":"...","resultado":"resultado pormenorizado"}],
"checklist":[{"item":"descrição da tarefa do PEP","peso":1}]}
Os pesos devem somar proporcionalmente a relevância (itens críticos peso 2-3).`;
    const r = await callAI(prompt, null);
    const st = extractJSON(r.text);
    st.id = 'ai-' + rnd(5);
    if (!Array.isArray(st.checklist) || !st.checklist.length) throw new Error('estação sem checklist');
    db.prepare(`INSERT INTO stations(id,json,created_by,created) VALUES(?,?,?,?)`)
      .run(st.id, JSON.stringify(st), req.user.email, now());
    io.emit('stations:changed');
    res.json({ ok: true, station: st, provider: r.provider });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- IA: correção automatizada do PEP a partir da transcrição ---------- */
app.post('/api/ai/correct', auth, async (req, res) => {
  try {
    const st = db.prepare(`SELECT json FROM stations WHERE id=?`).get(String(req.body.stationId || ''));
    if (!st) return res.status(404).json({ error: 'Estação não encontrada' });
    const station = JSON.parse(st.json);
    const transcript = String(req.body.transcript || '').slice(0, 20000);
    if (!transcript.trim()) return res.status(400).json({ error: 'transcrição vazia' });
    const prompt = `Você é corretor de OSCE. Analise a transcrição da prática e marque cada item do PEP (checklist) como cumprido (ok=true) ou não (ok=false), com justificativa curta.
ESTAÇÃO: ${station.tema} (${station.area})
CHECKLIST: ${JSON.stringify(station.checklist)}
TRANSCRIÇÃO: """${transcript}"""
Responda SOMENTE JSON: {"scores":[{"item":"...","peso":1,"ok":true,"nota":"justificativa"}],"pontosFortes":["..."],"aReforcar":["..."],"estrategias":["..."]}
Mantenha item e peso EXATAMENTE como no checklist, na mesma ordem.`;
    const r = await callAI(prompt, null);
    res.json({ ok: true, correction: extractJSON(r.text), provider: r.provider });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- IA: análise de desempenho (pontos fortes/fracos + estratégias) ---------- */
app.post('/api/ai/coach', auth, async (req, res) => {
  try {
    const hist = db.prepare(`SELECT area,tema,pct,status FROM pep_results WHERE candidate=? AND status!='anulado' ORDER BY created DESC LIMIT 30`).all(req.user.email);
    const cards = db.prepare(`SELECT tema,area,reviews,hits FROM review_cards WHERE email=? AND reviews>0 ORDER BY created DESC LIMIT 30`).all(req.user.email);
    const prompt = `Você é mentor de preparação para OSCE/Revalida. Com base no histórico abaixo, gere: pontos fortes, pontos que precisam de reforço e estratégias concretas de estudo (revisão espaçada, estações a repetir, protocolos a revisar).
HISTÓRICO DE PRÁTICAS: ${JSON.stringify(hist)}
DESEMPENHO EM CARDS DE REVISÃO: ${JSON.stringify(cards)}
Responda SOMENTE JSON: {"fortes":["..."],"reforcar":["..."],"estrategias":["..."]}`;
    const r = await callAI(prompt, null);
    res.json({ ok: true, coach: extractJSON(r.text), provider: r.provider });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- IA: card didático de revisão ---------- */
app.post('/api/ai/card', auth, async (req, res) => {
  try {
    const arg = String(req.body.argumento || '').slice(0, 500);
    if (!arg) return res.status(400).json({ error: 'argumento vazio' });
    const prompt = `Crie um card didático de revisão (flashcard) sobre: "${arg}". Contexto: medicina, preparação OSCE/Revalida, condutas SUS/Ministério da Saúde e protocolos vigentes.
Responda SOMENTE JSON: {"pergunta":"caso clínico curto + pergunta fundamental","resposta":"resposta detalhada com conduta, doses e referências de protocolo quando aplicável"}`;
    const r = await callAI(prompt, null);
    const c = extractJSON(r.text);
    const info = db.prepare(`INSERT INTO review_cards(email,station_id,pep_id,area,tema,pergunta,resposta,created)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(req.user.email, req.body.stationId || null, req.body.pepId || null,
        String(req.body.area || ''), String(req.body.tema || arg.slice(0, 60)),
        String(c.pergunta), String(c.resposta), now());
    res.json({ ok: true, id: info.lastInsertRowid, card: c, provider: r.provider });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- Biblioteca de cards ---------- */
app.get('/api/cards', auth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM review_cards WHERE email=? ORDER BY created DESC`).all(req.user.email);
  res.json({ ok: true, cards: rows });
});
app.post('/api/cards/review', auth, (req, res) => {
  const c = db.prepare(`SELECT * FROM review_cards WHERE id=? AND email=?`).get(Number(req.body.id), req.user.email);
  if (!c) return res.status(404).json({ error: 'card não encontrado' });
  const hit = req.body.hit ? 1 : 0;
  const streak = hit ? c.streak + 1 : 0;
  const gaps = [1, 3, 7, 15, 30]; // revisão espaçada (dias)
  const gap = gaps[Math.min(streak, gaps.length - 1)];
  db.prepare(`UPDATE review_cards SET reviews=reviews+1, hits=hits+?, streak=?, next_review=? WHERE id=?`)
    .run(hit, streak, now() + gap * 86400000, c.id);
  res.json({ ok: true, streak, nextGapDays: gap });
});
app.delete('/api/cards/:id', auth, (req, res) => {
  db.prepare(`DELETE FROM review_cards WHERE id=? AND email=?`).run(Number(req.params.id), req.user.email);
  res.json({ ok: true });
});

/* ---------- Amizades ---------- */
function areFriends(x, y) {
  return !!db.prepare(`SELECT 1 FROM friends WHERE status='accepted' AND ((a=? AND b=?) OR (a=? AND b=?))`).get(x, y, y, x);
}
function notify(email, kind, text, data) {
  db.prepare(`INSERT INTO notifications(email,kind,text,data,ts) VALUES(?,?,?,?,?)`)
    .run(email, kind, String(text).slice(0, 500), data ? JSON.stringify(data).slice(0, 2000) : null, now());
  const p = presence.get(email);
  if (p) for (const sid of p.sockets) io.to(sid).emit('notify', { kind, text, ts: now() });
}
app.get('/api/friends', auth, (req, res) => {
  const me = req.user.email;
  const rows = db.prepare(`SELECT * FROM friends WHERE a=? OR b=?`).all(me, me);
  const friends = [], incoming = [], outgoing = [];
  for (const r of rows) {
    const other = r.a === me ? r.b : r.a;
    const u = db.prepare(`SELECT name,email,avatar FROM users WHERE email=?`).get(other);
    if (!u) continue;
    if (r.status === 'accepted') friends.push(u);
    else if (r.b === me) incoming.push(u); else outgoing.push(u);
  }
  res.json({ ok: true, friends, incoming, outgoing });
});
app.post('/api/friends/request', auth, (req, res) => {
  const to = String(req.body.email || '');
  if (to === req.user.email) return res.status(400).json({ error: 'você não pode se adicionar' });
  if (!db.prepare(`SELECT 1 FROM users WHERE email=?`).get(to)) return res.status(404).json({ error: 'usuário não encontrado' });
  db.prepare(`INSERT OR IGNORE INTO friends(a,b,status,ts) VALUES(?,?,'pending',?)`).run(req.user.email, to, now());
  notify(to, 'friend_req', req.user.name + ' enviou um pedido de amizade', { from: req.user.email });
  res.json({ ok: true });
});
app.post('/api/friends/respond', auth, (req, res) => {
  const from = String(req.body.email || '');
  const r = db.prepare(`SELECT * FROM friends WHERE a=? AND b=? AND status='pending'`).get(from, req.user.email);
  if (!r) return res.status(404).json({ error: 'pedido não encontrado' });
  if (req.body.accept) {
    db.prepare(`UPDATE friends SET status='accepted' WHERE a=? AND b=?`).run(from, req.user.email);
    notify(from, 'friend_ok', req.user.name + ' aceitou seu pedido de amizade', {});
  } else db.prepare(`DELETE FROM friends WHERE a=? AND b=?`).run(from, req.user.email);
  res.json({ ok: true });
});

/* ---------- Notificações (persistem mesmo offline) ---------- */
app.get('/api/notifications', auth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications WHERE email=? ORDER BY ts DESC LIMIT 60`).all(req.user.email);
  res.json({ ok: true, notifications: rows });
});
app.post('/api/notifications/read', auth, (req, res) => {
  db.prepare(`UPDATE notifications SET read=1 WHERE email=?`).run(req.user.email);
  res.json({ ok: true });
});

/* ---------- Detalhe de usuário respeitando a privacidade ---------- */
app.get('/api/users/:email/detail', auth, (req, res) => {
  const target = db.prepare(`SELECT name,email,role,avatar,prefs,created FROM users WHERE email=?`).get(String(req.params.email));
  if (!target) return res.status(404).json({ error: 'usuário não encontrado' });
  const me = req.user.email;
  const prefs = JSON.parse(target.prefs || '{}');
  const share = prefs.share || {};
  const privileged = isAdmin(req.user) || me === target.email || areFriends(me, target.email);
  const out = { name: target.name, email: target.email, avatar: target.avatar,
    friend: areFriends(me, target.email), self: me === target.email };
  if (privileged && share.profile !== false) out.since = target.created;
  if (privileged && share.performance !== false)
    out.history = db.prepare(`SELECT area,tema,pct,created,status FROM pep_results WHERE candidate=? AND status IN ('aguardando','confirmado') ORDER BY created DESC LIMIT 60`).all(target.email);
  if (privileged && share.cards !== false)
    out.cards = db.prepare(`SELECT id,area,tema,pergunta,resposta,reviews,hits FROM review_cards WHERE email=? ORDER BY created DESC LIMIT 60`).all(target.email);
  res.json({ ok: true, user: out });
});

/* ---------- Chat público: recentes (2h), limpeza admin ---------- */
app.get('/api/chat/recent', auth, (req, res) => {
  const h = Number(getSetting('chat_retention_hours', 2));
  const rows = db.prepare(`SELECT email,name,text,ts FROM chat_archive WHERE room='lobby' AND ts>? ORDER BY ts LIMIT 200`).all(now() - h * 3600000);
  res.json({ ok: true, msgs: rows });
});
app.post('/api/chat/clear', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'somente administradores' });
  db.prepare(`DELETE FROM chat_archive WHERE room='lobby'`).run();
  io.emit('chat:cleared', { room: 'lobby' });
  res.json({ ok: true });
});

/* ---------- Painel de sessão: tema aleatório ainda não estudado ---------- */
app.get('/api/review/session', auth, (req, res) => {
  const done = new Set(db.prepare(`SELECT tema FROM pep_results WHERE candidate=?`).all(req.user.email).map(r => r.tema));
  const rows = db.prepare(`SELECT json FROM stations`).all().map(r => JSON.parse(r.json));
  const fresh = rows.filter(s => !done.has(s.tema));
  const pool = fresh.length ? fresh : rows;
  if (!pool.length) return res.json({ ok: true, empty: true });
  const st = pool[crypto.randomInt(pool.length)];
  res.json({ ok: true, station: { id: st.id, tema: st.tema, area: st.area, especialidade: st.especialidade, instrucoes: st.instrucoes } });
});

/* ---------- PEP: salvar, revisar, disputar ---------- */
function recount(scores) {
  const valid = scores.filter(s => !s.disputado);
  const totV = valid.reduce((a, s) => a + (s.peso || 1), 0);
  const gotV = valid.reduce((a, s) => a + (s.ok ? (s.peso || 1) : 0), 0);
  const totAll = scores.reduce((a, s) => a + (s.peso || 1), 0);
  const inv = scores.filter(s => s.disputado).reduce((a, s) => a + (s.peso || 1), 0);
  return { pct: totV ? Math.round(gotV / totV * 1000) / 10 : 0, invalid: totAll ? Math.round(inv / totAll * 1000) / 10 : 0 };
}
app.post('/api/pep/save', auth, (req, res) => {
  try {
    const scores = Array.isArray(req.body.scores) ? req.body.scores : [];
    if (!scores.length) return res.status(400).json({ error: 'scores vazio' });
    const { pct, invalid } = recount(scores);
    const info = db.prepare(`INSERT INTO pep_results(room_id,station_id,area,tema,candidate,evaluator,scores,pct,pct_real,invalid,status,transcript,ai,time_used,created,updated)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.body.roomId || null, req.body.stationId || null, req.body.area || '', req.body.tema || '',
        String(req.body.candidate || req.user.email), req.body.evaluator || null,
        JSON.stringify(scores), pct, pct, invalid, 'aguardando',
        req.body.transcript || null, req.body.ai ? 1 : 0, Number(req.body.timeUsed) || 0, now(), now());
    res.json({ ok: true, id: info.lastInsertRowid, pct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/pep/list', auth, (req, res) => {
  const rows = isAdmin(req.user)
    ? db.prepare(`SELECT * FROM pep_results ORDER BY created DESC LIMIT 300`).all()
    : db.prepare(`SELECT * FROM pep_results WHERE candidate=? OR evaluator=? ORDER BY created DESC LIMIT 300`).all(req.user.email, req.user.email);
  res.json({ ok: true, results: rows.map(r => ({ ...r, scores: JSON.parse(r.scores) })) });
});
/* Disputa de item: candidato sem avaliador pode discordar; >limiar% invalidado → anulado */
app.post('/api/pep/dispute', auth, (req, res) => {
  const p = db.prepare(`SELECT * FROM pep_results WHERE id=?`).get(Number(req.body.id));
  if (!p) return res.status(404).json({ error: 'PEP não encontrado' });
  const isEval = p.evaluator === req.user.email || isAdmin(req.user);
  if (p.candidate !== req.user.email && !isEval) return res.status(403).json({ error: 'sem permissão' });
  const scores = JSON.parse(p.scores);
  const idx = Number(req.body.index);
  if (!scores[idx]) return res.status(400).json({ error: 'item inválido' });
  scores[idx].disputado = !!req.body.disputado;
  if (req.body.nota) scores[idx].nota = String(req.body.nota).slice(0, 500);
  if (isEval && typeof req.body.ok === 'boolean') { scores[idx].ok = req.body.ok; scores[idx].disputado = false; }
  const { pct, invalid } = recount(scores);
  const thr = Number(getSetting('invalidation_threshold', 40));
  let status = 'disputado';
  if (invalid > thr) status = 'anulado';
  else if (isEval && typeof req.body.ok === 'boolean') status = 'confirmado';
  db.prepare(`UPDATE pep_results SET scores=?, pct=?, invalid=?, status=?, updated=? WHERE id=?`)
    .run(JSON.stringify(scores), pct, invalid, status, now(), p.id);
  res.json({ ok: true, pct, invalid, status, threshold: thr });
});
app.post('/api/pep/confirm', auth, (req, res) => {
  const p = db.prepare(`SELECT * FROM pep_results WHERE id=?`).get(Number(req.body.id));
  if (!p) return res.status(404).json({ error: 'PEP não encontrado' });
  if (p.evaluator && p.evaluator !== req.user.email && !isAdmin(req.user)) return res.status(403).json({ error: 'somente o avaliador' });
  db.prepare(`UPDATE pep_results SET status='confirmado', evaluator=COALESCE(evaluator,?), updated=? WHERE id=?`)
    .run(req.user.email, now(), p.id);
  res.json({ ok: true });
});

/* ---------- Performance (exclui anulados e disputados não revisados) ---------- */
app.get('/api/performance', auth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM pep_results WHERE candidate=? AND status IN ('aguardando','confirmado') ORDER BY created`).all(req.user.email);
  res.json({ ok: true, history: rows.map(r => ({ area: r.area, tema: r.tema, pct: r.pct, ai: r.ai, timeUsed: r.time_used, date: r.created, status: r.status })) });
});

/* ---------- Chat público: histórico por hora (admin) ---------- */
app.get('/api/chat/history', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'somente administradores' });
  const bucket = Number(req.query.bucket) || 0;
  const rows = bucket
    ? db.prepare(`SELECT * FROM chat_archive WHERE room='lobby' AND bucket=? ORDER BY ts`).all(bucket)
    : db.prepare(`SELECT bucket, COUNT(*) n, MIN(ts) ini, MAX(ts) fim FROM chat_archive WHERE room='lobby' GROUP BY bucket ORDER BY bucket DESC LIMIT 60`).all();
  res.json({ ok: true, rows });
});

/* ---------- Admin: settings, relatórios, teste de IA ---------- */
app.get('/api/settings', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'somente administradores' });
  res.json({ ok: true, settings: { invalidation_threshold: Number(getSetting('invalidation_threshold', 40)), chat_retention_hours: Number(getSetting('chat_retention_hours', 2)) } });
});
app.post('/api/settings', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'somente administradores' });
  if (req.body.invalidation_threshold !== undefined)
    setSetting('invalidation_threshold', Math.min(100, Math.max(1, Number(req.body.invalidation_threshold) || 40)));
  if (req.body.chat_retention_hours !== undefined)
    setSetting('chat_retention_hours', Math.min(168, Math.max(1, Number(req.body.chat_retention_hours) || 2)));
  res.json({ ok: true });
});
app.get('/api/admin/reports', auth, (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'somente administradores' });
  res.json({
    ok: true,
    users: db.prepare(`SELECT COUNT(*) c FROM users`).get().c,
    stations: db.prepare(`SELECT COUNT(*) c FROM stations`).get().c,
    peps: db.prepare(`SELECT status, COUNT(*) n FROM pep_results GROUP BY status`).all(),
    chatByDay: db.prepare(`SELECT date(ts/1000,'unixepoch') dia, COUNT(*) n FROM chat_archive GROUP BY dia ORDER BY dia DESC LIMIT 30`).all(),
    topUsers: db.prepare(`SELECT name, COUNT(*) n FROM chat_archive GROUP BY email ORDER BY n DESC LIMIT 10`).all()
  });
});
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
/* Teste de provedores: SOMENTE admin */
app.get('/api/ai/test', auth, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'somente administradores' });
  const out = [];
  for (const [n, f] of [['Gemini', aiGemini], ['OpenAI', aiOpenAI], ['Pollinations', aiPollinations]]) {
    const t = Date.now();
    try { await f('Responda apenas: pong', null); out.push({ provider: n, ok: true, ms: Date.now() - t }); }
    catch (e) { out.push({ provider: n, ok: false, error: e.message }); }
  }
  res.json({ ok: true, results: out });
});

/* =====================================================================
   Socket.io — tempo real
===================================================================== */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/* Presença: email → {name, role, avatar, room, roomRole, ts, sockets} */
const presence = new Map();
function onlineList() {
  const t = now(), out = [];
  for (const [email, p] of presence)
    if (t - p.ts < 25000 && p.sockets.size)
      out.push({ email, name: p.name, role: p.role, avatar: p.avatar, room: p.room, roomRole: p.roomRole });
  return out;
}
function broadcastPresence() { io.emit('presence', onlineList()); }
function broadcastRooms() {
  const rows = db.prepare(`SELECT * FROM rooms WHERE closed=0 ORDER BY created DESC`).all();
  io.emit('rooms', rows.map(roomOut));
}
setInterval(broadcastPresence, 5000);

io.use((socket, next) => {
  const u = userByToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('não autenticado'));
  socket.user = u; next();
});

function roomObservers(roomId) {
  return onlineList().filter(x => x.room === roomId && x.roomRole === 'observador');
}
function emitTimer(roomId) {
  const r = db.prepare(`SELECT * FROM rooms WHERE id=?`).get(roomId);
  if (r) io.to(roomId).emit('timer', { roomId, tstate: r.tstate, remaining: computeRemaining(r), duration: r.duration });
}
function revealObserverChat(roomId) {
  const msgs = db.prepare(`SELECT email,name,text,is_ai,ts FROM observer_chat WHERE room_id=? ORDER BY ts`).all(roomId);
  io.to(roomId).emit('ochat:reveal', { roomId, msgs });
}

io.on('connection', (socket) => {
  const u = socket.user;
  let p = presence.get(u.email);
  if (!p) { p = { name: u.name, role: u.role, avatar: u.avatar, room: null, roomRole: null, ts: now(), sockets: new Set() }; presence.set(u.email, p); }
  p.name = u.name; p.role = u.role; p.avatar = u.avatar; p.ts = now(); p.sockets.add(socket.id);

  socket.emit('presence', onlineList());
  broadcastRooms();

  socket.on('heartbeat', (d) => {
    const pp = presence.get(u.email); if (!pp) return;
    pp.ts = now();
    if (d && typeof d === 'object') { pp.room = d.room || null; pp.roomRole = d.roomRole || null; }
  });

  /* ---------- entrar/sair de estação com papel (avaliador|candidato|observador) ---------- */
  socket.on('room:join', (d) => {
    const roomId = String(d?.roomId || ''); if (!roomId) return;
    const r = db.prepare(`SELECT * FROM rooms WHERE id=? AND closed=0`).get(roomId);
    if (!r) return;
    socket.join(roomId);
    socket.data.room = roomId;
    socket.data.roomRole = ['avaliador', 'candidato', 'observador'].includes(d?.role) ? d.role : 'observador';
    const pp = presence.get(u.email); if (pp) { pp.room = roomId; pp.roomRole = socket.data.roomRole; pp.ts = now(); }
    socket.to(roomId).emit('room:peer_joined', { roomId, email: u.email, name: u.name, avatar: pp?.avatar, role: socket.data.roomRole });
    socket.emit('room:joined', { ok: true, room: roomOut(r) });
    emitTimer(roomId);
    broadcastPresence();
    io.to(roomId).emit('room:presence', { roomId, online: onlineList().filter(x => x.room === roomId) });
    /* observador que entra depois recebe o chat de observadores já existente */
    if (socket.data.roomRole === 'observador') {
      const msgs = db.prepare(`SELECT email,name,text,is_ai,ts FROM observer_chat WHERE room_id=? ORDER BY ts`).all(roomId);
      socket.emit('ochat:sync', { roomId, msgs });
    }
  });
  socket.on('room:leave', () => {
    const roomId = socket.data.room;
    if (roomId) {
      socket.leave(roomId);
      socket.to(roomId).emit('room:peer_left', { roomId, email: u.email, name: u.name });
      io.to(roomId).emit('room:presence', { roomId, online: onlineList().filter(x => x.room === roomId) });
    }
    socket.data.room = null; socket.data.roomRole = null;
    const pp = presence.get(u.email); if (pp) { pp.room = null; pp.roomRole = null; pp.ts = now(); }
    broadcastPresence();
  });

  /* ---------- timer sincronizado (avaliador/criador controla) ---------- */
  function canControlTimer(roomId) {
    const r = db.prepare(`SELECT creator FROM rooms WHERE id=?`).get(roomId);
    return r && (r.creator === u.email || socket.data.roomRole === 'avaliador' || isAdmin(u));
  }
  socket.on('timer:start', (d) => {
    const roomId = String(d?.roomId || ''); if (!canControlTimer(roomId)) return;
    const dur = Math.min(7200, Math.max(30, Number(d?.duration) || 0));
    if (dur) db.prepare(`UPDATE rooms SET duration=? WHERE id=?`).run(dur, roomId);
    db.prepare(`UPDATE rooms SET tstate='ativo', remaining=?, tstamp=? WHERE id=?`).run(dur || 0, now(), roomId);
    if (!dur) { const r = db.prepare(`SELECT duration FROM rooms WHERE id=?`).get(roomId); db.prepare(`UPDATE rooms SET remaining=? WHERE id=?`).run(r.duration, roomId); }
    emitTimer(roomId);
  });
  socket.on('timer:pause', (d) => {
    const roomId = String(d?.roomId || ''); if (!canControlTimer(roomId)) return;
    const r = db.prepare(`SELECT * FROM rooms WHERE id=?`).get(roomId);
    if (!r || r.tstate !== 'ativo') return;
    db.prepare(`UPDATE rooms SET tstate='pausado', remaining=?, tstamp=? WHERE id=?`).run(computeRemaining(r), now(), roomId);
    emitTimer(roomId);
  });
  socket.on('timer:resume', (d) => {
    const roomId = String(d?.roomId || ''); if (!canControlTimer(roomId)) return;
    const r = db.prepare(`SELECT * FROM rooms WHERE id=?`).get(roomId);
    if (!r || r.tstate !== 'pausado') return;
    db.prepare(`UPDATE rooms SET tstate='ativo', tstamp=? WHERE id=?`).run(now(), roomId);
    emitTimer(roomId);
  });
  socket.on('timer:set', (d) => { /* tempo customizado pelo avaliador */
    const roomId = String(d?.roomId || ''); if (!canControlTimer(roomId)) return;
    const sec = Math.min(7200, Math.max(0, Number(d?.remaining) || 0));
    db.prepare(`UPDATE rooms SET remaining=?, duration=?, tstamp=? WHERE id=?`).run(sec, sec, now(), roomId);
    emitTimer(roomId);
  });
  socket.on('timer:get', (d) => { const roomId = String(d?.roomId || ''); if (roomId) emitTimer(roomId); });
  socket.on('timer:finish', (d) => { /* encerra estação: revela chat de observadores */
    const roomId = String(d?.roomId || ''); if (!canControlTimer(roomId)) return;
    db.prepare(`UPDATE rooms SET tstate='encerrado', tstamp=? WHERE id=?`).run(now(), roomId);
    emitTimer(roomId);
    revealObserverChat(roomId);
    io.to(roomId).emit('station:ended', { roomId, by: u.name });
  });

  /* ---------- chat: lobby (arquivado por hora) e estação ---------- */
  socket.on('chat', (d) => {
    const room = String(d?.room || ''); if (!room) return;
    const text = String(d?.text || '').slice(0, 2000); if (!text.trim()) return;
    const t = now();
    const msg = { room, email: u.email, name: u.name, avatar: p.avatar, text, ts: t };
    db.prepare(`INSERT INTO chat_archive(room,email,name,text,ts,bucket) VALUES(?,?,?,?,?,?)`)
      .run(room, u.email, u.name, text, t, Math.floor(t / 3600000));
    if (room === 'lobby') io.emit('chat', msg); else io.to(room).emit('chat', msg);
  });

  /* ---------- chat oculto de observadores (+ pergunta à IA) ---------- */
  socket.on('ochat', async (d) => {
    const roomId = String(d?.room || ''); if (!roomId) return;
    if (socket.data.room !== roomId || socket.data.roomRole !== 'observador') return;
    const r = db.prepare(`SELECT tstate FROM rooms WHERE id=?`).get(roomId);
    if (!r || r.tstate === 'encerrado') return;
    const text = String(d?.text || '').slice(0, 2000); if (!text.trim()) return;
    const t = now();
    db.prepare(`INSERT INTO observer_chat(room_id,email,name,text,is_ai,ts) VALUES(?,?,?,?,0,?)`).run(roomId, u.email, u.name, text, t);
    const msg = { room: roomId, email: u.email, name: u.name, text, ts: t, is_ai: 0 };
    for (const o of roomObservers(roomId)) { const tp = presence.get(o.email); if (tp) for (const sid of tp.sockets) io.to(sid).emit('ochat', msg); }
    if (d.askAI) { /* pergunta direcionada ao prompt IA */
      try {
        const hist = db.prepare(`SELECT name,text,is_ai FROM observer_chat WHERE room_id=? ORDER BY ts DESC LIMIT 12`).all(roomId).reverse();
        const messages = [{ role: 'system', content: 'Você é um tutor médico respondendo dúvidas de observadores durante uma estação OSCE. Seja conciso e didático.' },
          ...hist.map(h => ({ role: h.is_ai ? 'assistant' : 'user', content: h.name + ': ' + h.text }))];
        const r2 = await callAI(null, messages);
        const t2 = now();
        db.prepare(`INSERT INTO observer_chat(room_id,email,name,text,is_ai,ts) VALUES(?,?,?,?,1,?)`).run(roomId, 'ia', '🤖 IA', r2.text, t2);
        const aim = { room: roomId, email: 'ia', name: '🤖 IA', text: r2.text, ts: t2, is_ai: 1 };
        for (const o of roomObservers(roomId)) { const tp = presence.get(o.email); if (tp) for (const sid of tp.sockets) io.to(sid).emit('ochat', aim); }
      } catch (e) { /* falha de IA não quebra o chat */ }
    }
  });

  /* ---------- reações ---------- */
  socket.on('react', (d) => {
    const room = String(d?.room || ''); const emoji = String(d?.emoji || '').slice(0, 8);
    if (!room || !emoji) return;
    io.to(room).emit('react', { room, email: u.email, name: u.name, emoji, ts: now() });
  });

  /* ---------- cards de exames/anexos compartilhados na estação ---------- */
  socket.on('card', (d) => {
    const room = String(d?.room || ''); if (!room) return;
    const card = {
      cid: String(d?.cid || rnd(6)), cat: String(d?.cat || 'geral'),
      title: String(d?.title || '').slice(0, 120),
      text: String(d?.text || '').slice(0, 4000), by: u.name, role: socket.data.roomRole || '',
      ts: now()
    };
    if (!card.text.trim()) return;
    io.to(room).emit('card', { room, card });
  });

  /* ---------- sinalização WebRTC mesh ---------- */
  socket.on('signal', (d) => {
    const room = String(d?.room || ''); if (!room) return;
    const kind = String(d?.kind || '');
    if (!['hello', 'offer', 'answer', 'ice', 'bye'].includes(kind)) return;
    const dst = d?.dst ? String(d.dst) : null;
    const envelope = { room, src: u.email, name: u.name, role: socket.data.roomRole, kind, payload: d?.payload ?? null };
    if (dst) { const target = presence.get(dst); if (target) for (const sid of target.sockets) io.to(sid).emit('signal', envelope); }
    else if (room === 'lobby') socket.broadcast.emit('signal', envelope);  /* conferência do lobby — o cliente exibe só amigos */
    else socket.to(room).emit('signal', envelope);
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

server.listen(PORT, () => {
  console.log(`\n🩺 pratica.M3D v3 rodando em http://localhost:${PORT}`);
  console.log(`   Admin: root / @0Arcano\n`);
});
