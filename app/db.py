"""pratica.M3D v4 — camada de dados (SQLite stdlib, WAL)."""
import os, json, sqlite3, time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, 'data')
DB = os.path.join(DATA, 'pratica_m3d.sqlite')
os.makedirs(DATA, exist_ok=True)

AREAS = ['CM', 'CIR', 'GO', 'PED', 'MFC']

def conn():
    c = sqlite3.connect(DB, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA journal_mode=WAL')
    c.execute('PRAGMA foreign_keys=ON')
    return c

DDL = """
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
 pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
 avatar TEXT DEFAULT '🩺', layout TEXT DEFAULT '{}',
 created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
 token TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resets(
 token TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stations(
 id TEXT PRIMARY KEY, tema TEXT NOT NULL, area TEXT DEFAULT 'CM',
 especialidade TEXT DEFAULT '', nivel TEXT DEFAULT 'intermediário',
 duracao INTEGER DEFAULT 10, fonte TEXT DEFAULT '',
 instrucoes TEXT DEFAULT '', cenario TEXT DEFAULT '',
 roteiro_ator TEXT DEFAULT '', protocolo TEXT DEFAULT '',
 exames TEXT DEFAULT '[]', checklist TEXT DEFAULT '[]',
 frozen INTEGER DEFAULT 0, created_by TEXT DEFAULT 'seed',
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms(
 code TEXT PRIMARY KEY, name TEXT NOT NULL,
 station_ids TEXT NOT NULL, active_station TEXT,
 rtype TEXT DEFAULT 'ppl', open INTEGER DEFAULT 1,
 creator_id INTEGER NOT NULL, creator_name TEXT DEFAULT '',
 created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pep_results(
 id INTEGER PRIMARY KEY AUTOINCREMENT, room_code TEXT,
 station_id TEXT, user_id INTEGER, user_name TEXT,
 marks TEXT DEFAULT '{}', score REAL DEFAULT 0,
 transcript TEXT DEFAULT '', notes TEXT DEFAULT '',
 created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS srs_cards(
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
 station_id TEXT, front TEXT NOT NULL, back TEXT NOT NULL,
 level INTEGER DEFAULT 0, next_due INTEGER NOT NULL,
 created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ai_calls(
 id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT, model TEXT,
 purpose TEXT, ok INTEGER, latency_ms INTEGER, error TEXT,
 created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS disputes(
 id INTEGER PRIMARY KEY AUTOINCREMENT, station_id TEXT,
 item_idx INTEGER, user_id INTEGER, reason TEXT,
 status TEXT DEFAULT 'open', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chat_archive(
 id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, ref TEXT,
 user_name TEXT, text TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS flowcards(
 id TEXT PRIMARY KEY, tema TEXT, spec TEXT, png TEXT, cover TEXT,
 user_id INTEGER, created_at INTEGER NOT NULL);
"""

def init():
    c = conn()
    c.executescript(DDL)
    now = int(time.time())
    if not c.execute("SELECT 1 FROM users WHERE role='root'").fetchone():
        import bcrypt
        pw = bcrypt.hashpw(b'@0Arcano', bcrypt.gensalt()).decode()
        c.execute("INSERT INTO users(name,email,pass,role,avatar,created_at) VALUES(?,?,?,?,?,?)",
                  ('root', 'root@pratica.m3d', pw, 'root', '👑', now))
    if c.execute("SELECT COUNT(*) n FROM stations").fetchone()['n'] == 0:
        seed = os.path.join(DATA, 'seed_stations.json')
        if os.path.exists(seed):
            data = json.load(open(seed, encoding='utf-8'))
            for s in data:
                c.execute("""INSERT OR IGNORE INTO stations
                  (id,tema,area,especialidade,nivel,duracao,fonte,instrucoes,cenario,
                   roteiro_ator,protocolo,exames,checklist,created_by,created_at,updated_at)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (s.get('id'), s.get('tema'), s.get('area', 'CM'), s.get('especialidade', ''),
                   s.get('nivel', 'intermediário'), int(s.get('duracao') or 10), s.get('fonte', ''),
                   s.get('instrucoes', ''), s.get('cenario', ''), s.get('roteiroAtor', ''),
                   s.get('protocolo', ''), json.dumps(s.get('exames', []), ensure_ascii=False),
                   json.dumps(s.get('checklist', []), ensure_ascii=False), 'seed', now, now))
    c.commit()
    n = c.execute("SELECT COUNT(*) n FROM stations").fetchone()['n']
    c.close()
    return n
