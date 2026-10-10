<?php
declare(strict_types=1);

/** pratica.M3D v5 — camada de dados (SQLite / PDO, modo WAL). */

const AREAS = ['CM', 'CIR', 'GO', 'PED', 'MFC'];

const AREA_LABELS = [
    'CM'  => 'Clínica Médica',
    'CIR' => 'Cirurgia',
    'GO'  => 'Ginecologia e Obstetrícia',
    'PED' => 'Pediatria',
    'MFC' => 'Medicina de Família e Comunidade',
];

const AREA_COLORS = [
    'CM' => '#0d9488', 'CIR' => '#e11d48', 'GO' => '#8b5cf6',
    'PED' => '#38bdf8', 'MFC' => '#d97706',
];

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;
    @mkdir(STORAGE_DIR, 0775, true);
    $pdo = new PDO('sqlite:' . STORAGE_DIR . '/pratica_m3d.sqlite');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA synchronous = NORMAL');
    return $pdo;
}

function db_ddl(): string
{
    return <<<'SQL'
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  avatar TEXT DEFAULT '🩺',
  layout TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resets(
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stations(
  id TEXT PRIMARY KEY,
  tema TEXT NOT NULL,
  area TEXT DEFAULT 'CM',
  especialidade TEXT DEFAULT '',
  nivel TEXT DEFAULT 'intermediário',
  duracao INTEGER DEFAULT 10,
  fonte TEXT DEFAULT '',
  instrucoes TEXT DEFAULT '',
  cenario TEXT DEFAULT '',
  roteiro_ator TEXT DEFAULT '',
  protocolo TEXT DEFAULT '',
  exames TEXT DEFAULT '[]',
  checklist TEXT DEFAULT '[]',
  frozen INTEGER DEFAULT 0,
  created_by TEXT DEFAULT 'seed',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms(
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  station_ids TEXT NOT NULL,
  active_station TEXT,
  rtype TEXT DEFAULT 'ppl',
  open INTEGER DEFAULT 1,
  study_mode INTEGER DEFAULT 0,
  creator_id INTEGER NOT NULL,
  creator_name TEXT DEFAULT '',
  timer_state TEXT DEFAULT 'idle',
  timer_duration INTEGER DEFAULT 600,
  timer_started_at INTEGER DEFAULT 0,
  timer_remaining INTEGER DEFAULT 600,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members(
  room_code TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT DEFAULT '',
  role TEXT DEFAULT 'medico',
  last_seen INTEGER NOT NULL,
  PRIMARY KEY(room_code, peer_id)
);
CREATE TABLE IF NOT EXISTS pep_results(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT, station_id TEXT, user_id INTEGER, user_name TEXT,
  marks TEXT DEFAULT '{}', score REAL DEFAULT 0,
  transcript TEXT DEFAULT '', notes TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS srs_cards(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, station_id TEXT,
  front TEXT NOT NULL, back TEXT NOT NULL,
  level INTEGER DEFAULT 0, next_due INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_calls(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT, model TEXT, purpose TEXT, ok INTEGER,
  latency_ms INTEGER, error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS disputes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT, item_idx INTEGER, user_id INTEGER, user_name TEXT,
  reason TEXT, status TEXT DEFAULT 'open', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_archive(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT, ref TEXT, user_id INTEGER, user_name TEXT,
  text TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS flowcards(
  id TEXT PRIMARY KEY,
  user_id INTEGER,
  station_id TEXT,
  tema TEXT,
  title TEXT,
  kind TEXT DEFAULT 'procedimento',
  summary TEXT DEFAULT '',
  spec TEXT DEFAULT '{}',
  svg TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT DEFAULT '',
  type TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  user_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER, actor_name TEXT,
  action TEXT, target TEXT, meta TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_room ON events(room, id);
CREATE INDEX IF NOT EXISTS idx_stations_area ON stations(area);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_srs_user ON srs_cards(user_id, next_due);
SQL;
}

/**
 * Garante o schema, o usuário root e o seed das 428 estações.
 * Idempotente — roda a cada boot, porém o seed só ocorre quando a base está vazia.
 */
function db_init(): int
{
    $pdo = db();
    $pdo->exec(db_ddl());

    /* ---------------- root master (imune a exclusão/rebaixamento) ---------- */
    $has = (int)$pdo->query("SELECT COUNT(*) FROM users WHERE role='root'")->fetchColumn();
    if ($has === 0) {
        $st = $pdo->prepare('INSERT INTO users(name,email,pass,role,avatar,created_at) VALUES(?,?,?,?,?,?)');
        $st->execute([
            'root',
            'root@pratica.m3d',
            password_hash((string)env('ROOT_PASSWORD', '@0Arcano'), PASSWORD_BCRYPT),
            'root',
            '👑',
            now(),
        ]);
    }

    /* ------------------------------- seed 428 estações -------------------- */
    $count = (int)$pdo->query('SELECT COUNT(*) FROM stations')->fetchColumn();
    if ($count === 0) {
        db_seed_stations($pdo);
    }
    return (int)$pdo->query('SELECT COUNT(*) FROM stations')->fetchColumn();
}

function db_seed_stations(PDO $pdo): int
{
    $file = DATA_DIR . '/seed_stations.json';
    if (!is_file($file)) return 0;
    $data = json_decode((string)file_get_contents($file), true);
    if (!is_array($data)) return 0;

    $sql = 'INSERT OR IGNORE INTO stations
        (id,tema,area,especialidade,nivel,duracao,fonte,instrucoes,cenario,
         roteiro_ator,protocolo,exames,checklist,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
    $st = $pdo->prepare($sql);
    $t  = now();
    $n  = 0;
    $pdo->beginTransaction();
    foreach ($data as $s) {
        if (empty($s['id']) || empty($s['tema'])) continue;
        $st->execute([
            (string)$s['id'],
            (string)$s['tema'],
            (string)($s['area'] ?? 'CM'),
            (string)($s['especialidade'] ?? ''),
            (string)($s['nivel'] ?? 'intermediário'),
            (int)($s['duracao'] ?? 10),
            (string)($s['fonte'] ?? ''),
            (string)($s['instrucoes'] ?? ''),
            (string)($s['cenario'] ?? ''),
            (string)($s['roteiroAtor'] ?? ($s['roteiro_ator'] ?? '')),
            (string)($s['protocolo'] ?? ''),
            jenc($s['exames'] ?? []),
            jenc($s['checklist'] ?? []),
            'seed',
            $t,
            $t,
        ]);
        $n++;
    }
    $pdo->commit();
    return $n;
}

/* ------------------------------------------------------------------ eventos -- */

function evt(string $room, string $type, array $payload = [], ?int $uid = null): void
{
    $st = db()->prepare('INSERT INTO events(room,type,payload,user_id,created_at) VALUES(?,?,?,?,?)');
    $st->execute([$room, $type, jenc($payload), $uid, now()]);
}

function evt_gc(): void
{
    // mantém apenas 1h de eventos para o barramento SSE
    db()->exec('DELETE FROM events WHERE created_at < ' . (now() - 3600));
}
