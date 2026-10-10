'use strict';
/** pratica.M3D v6 — camada de dados (better-sqlite3, WAL). Síncrona e rápida. */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');

const AREAS = ['CM', 'CIR', 'GO', 'PED', 'MFC'];
const AREA_LABELS = {
  CM: 'Clínica Médica', CIR: 'Cirurgia', GO: 'Ginecologia e Obstetrícia',
  PED: 'Pediatria', MFC: 'Medicina de Família e Comunidade',
};
const AREA_COLORS = { CM: '#0d9488', CIR: '#e11d48', GO: '#8b5cf6', PED: '#38bdf8', MFC: '#d97706' };
const SRS_INTERVALS = [1, 3, 7, 15, 30];

fs.mkdirSync(cfg.STORAGE_DIR, { recursive: true });
const db = new Database(path.join(cfg.STORAGE_DIR, 'pratica_m3d.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',        -- root | admin | user
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS stations(
  id TEXT PRIMARY KEY,
  tema TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT 'CM',
  especialidade TEXT DEFAULT '',
  nivel TEXT DEFAULT 'intermediário',
  duracao INTEGER DEFAULT 10,
  fonte TEXT DEFAULT '',
  instrucoes TEXT DEFAULT '',
  cenario TEXT DEFAULT '',
  roteiro_ator TEXT DEFAULT '',
  protocolo TEXT DEFAULT '',
  exames TEXT DEFAULT '',
  checklist TEXT DEFAULT '[]',              -- JSON array de {item, peso}
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stations_area ON stations(area);
CREATE TABLE IF NOT EXISTS rooms(
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  station_ids TEXT DEFAULT '[]',
  active_station TEXT DEFAULT '',
  rtype TEXT DEFAULT 'live',                -- live | study
  open INTEGER DEFAULT 1,
  study_mode INTEGER DEFAULT 0,
  creator_id INTEGER NOT NULL,
  creator_name TEXT DEFAULT '',
  timer_duration INTEGER DEFAULT 600,       -- segundos
  timer_started_at INTEGER DEFAULT 0,       -- epoch ms (0 = parado)
  timer_paused_left INTEGER DEFAULT 0,      -- segundos restantes quando pausado
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'room',       -- room | private
  from_id INTEGER NOT NULL,
  from_name TEXT DEFAULT '',
  to_id INTEGER DEFAULT 0,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, id);
CREATE TABLE IF NOT EXISTS marks(
  room TEXT NOT NULL,
  station_id TEXT NOT NULL,
  evaluator_id INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  item_idx INTEGER NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  PRIMARY KEY(room, station_id, evaluator_id, candidate_id, item_idx)
);
CREATE TABLE IF NOT EXISTS peps(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  station_id TEXT NOT NULL,
  candidate_id INTEGER NOT NULL,
  evaluator_id INTEGER NOT NULL,
  evaluator_name TEXT DEFAULT '',
  items TEXT NOT NULL DEFAULT '[]',         -- JSON [{item,peso,marcado,nota}]
  score REAL DEFAULT 0,
  max_score REAL DEFAULT 0,
  pct REAL DEFAULT 0,
  ai_json TEXT DEFAULT '',                  -- correção da IA (JSON)
  ai_status TEXT DEFAULT 'pending',         -- pending | done | failed
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_peps_cand ON peps(candidate_id);
CREATE TABLE IF NOT EXISTS disputes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pep_id INTEGER NOT NULL REFERENCES peps(id) ON DELETE CASCADE,
  by_id INTEGER NOT NULL,
  by_name TEXT DEFAULT '',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | resolved | rejected
  resolution TEXT DEFAULT '',
  ai_json TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS srs_cards(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  station_id TEXT DEFAULT '',
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  stage INTEGER NOT NULL DEFAULT 0,
  next_due INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_srs_user ON srs_cards(user_id, next_due);
CREATE TABLE IF NOT EXISTS flow_cards(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  station_id TEXT DEFAULT '',
  title TEXT NOT NULL,
  spec TEXT NOT NULL,                       -- JSON {title, steps:[{t,text}], fonte}
  summary TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flow_user ON flow_cards(user_id);
CREATE TABLE IF NOT EXISTS ai_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT DEFAULT '',
  task TEXT DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  error TEXT DEFAULT '',
  ts INTEGER NOT NULL
);
`);

const now = () => Date.now();
const jenc = (v) => JSON.stringify(v ?? null);
const jdec = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };

/* ------------------------------------------------------------- seed -------- */
function normalizeStation(s, i) {
  const pick = (...ks) => { for (const k of ks) if (s[k] != null && s[k] !== '') return s[k]; return ''; };
  let checklist = pick('checklist');
  if (typeof checklist === 'string') { try { checklist = JSON.parse(checklist); } catch { checklist = []; } }
  if (!Array.isArray(checklist)) checklist = [];
  checklist = checklist.map((c) => (typeof c === 'string'
    ? { item: c, peso: 1 }
    : { item: String(c.item || c.descricao || c.criterio || ''), peso: +(c.peso || 1) }))
    .filter((c) => c.item);
  const area = String(pick('area', 'grande_area') || 'CM').toUpperCase().trim();
  return {
    id: String(pick('id') || `st-${i + 1}`),
    tema: String(pick('tema', 'titulo', 'título') || 'Estação sem título'),
    area: AREAS.includes(area) ? area : 'CM',
    especialidade: String(pick('especialidade') || ''),
    nivel: String(pick('nivel', 'nível') || 'intermediário'),
    duracao: Math.max(1, parseInt(pick('duracao', 'duração', 'tempo') || 10, 10) || 10),
    fonte: String(pick('fonte') || ''),
    instrucoes: String(pick('instrucoes', 'instruções') || ''),
    cenario: String(pick('cenario', 'cenário') || ''),
    roteiro_ator: String(pick('roteiro_ator', 'roteiroAtor', 'roteiro') || ''),
    protocolo: String(pick('protocolo') || ''),
    exames: String(pick('exames') || ''),
    checklist,
  };
}

function seed() {
  const bcrypt = require('bcryptjs');
  const nUsers = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (nUsers === 0) {
    db.prepare('INSERT INTO users(name,email,pass_hash,role,created_at) VALUES(?,?,?,?,?)')
      .run('root', 'root@m3d.local', bcrypt.hashSync(cfg.ROOT_PASSWORD, 10), 'root', now());
    console.log('[db] usuário root criado (defina ROOT_PASSWORD no .env)');
  }
  const nSt = db.prepare('SELECT COUNT(*) n FROM stations').get().n;
  if (nSt === 0) {
    const f = path.join(cfg.DATA_DIR, 'seed_stations.json');
    if (fs.existsSync(f)) {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      const ins = db.prepare(`INSERT OR IGNORE INTO stations
        (id,tema,area,especialidade,nivel,duracao,fonte,instrucoes,cenario,roteiro_ator,protocolo,exames,checklist,created_at)
        VALUES (@id,@tema,@area,@especialidade,@nivel,@duracao,@fonte,@instrucoes,@cenario,@roteiro_ator,@protocolo,@exames,@checklist,@created_at)`);
      const tx = db.transaction((rows) => {
        rows.forEach((s, i) => { const r = normalizeStation(s, i); ins.run({ ...r, checklist: jenc(r.checklist), created_at: now() }); });
      });
      tx(Array.isArray(raw) ? raw : []);
      console.log(`[db] seed: ${db.prepare('SELECT COUNT(*) n FROM stations').get().n} estações importadas`);
    }
  }
}
seed();

module.exports = { db, now, jenc, jdec, AREAS, AREA_LABELS, AREA_COLORS, SRS_INTERVALS, normalizeStation };
