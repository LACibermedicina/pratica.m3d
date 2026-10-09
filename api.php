<?php
/* =====================================================================
   pratica.M3D — API PHP 8 + SQLite (PDO)
   Controle de credenciais, sessões persistentes, salas, presença e
   histórico de performance para relatórios do dashboard.
   Banco: pratica_m3d.sqlite (criado automaticamente na mesma pasta)
===================================================================== */
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
if(($_SERVER['REQUEST_METHOD']??'')==='OPTIONS'){ http_response_code(204); exit; }

$db = new PDO('sqlite:'.__DIR__.'/pratica_m3d.sqlite', null, null, [PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
$db->exec("PRAGMA journal_mode=WAL");
$db->exec("CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', reset_token TEXT, created INTEGER NOT NULL)");
$db->exec("CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL)");
$db->exec("CREATE TABLE IF NOT EXISTS presence(email TEXT PRIMARY KEY, name TEXT, ts INTEGER, room TEXT, room_role TEXT, role TEXT)");
$db->exec("CREATE TABLE IF NOT EXISTS rooms(
  id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT, station_id TEXT NOT NULL, station_ids TEXT,
  mode TEXT, vis TEXT, creator TEXT, creator_name TEXT, created INTEGER, closed INTEGER DEFAULT 0)");
$db->exec("CREATE TABLE IF NOT EXISTS room_members(room_id TEXT, email TEXT, PRIMARY KEY(room_id,email))");
$db->exec("CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, area TEXT, tema TEXT, pct INTEGER, got INTEGER,
  tot INTEGER, time_used INTEGER, room TEXT, ai INTEGER DEFAULT 0, transcript TEXT, review TEXT, date INTEGER)");
$db->exec("CREATE UNIQUE INDEX IF NOT EXISTS history_uniq ON history(email,date,tema)");
$db->exec("CREATE TABLE IF NOT EXISTS signals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, src TEXT NOT NULL, dst TEXT,
  kind TEXT NOT NULL, payload TEXT, ts INTEGER NOT NULL)");
$db->exec("CREATE TABLE IF NOT EXISTS room_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, email TEXT, name TEXT,
  kind TEXT NOT NULL, payload TEXT, ts INTEGER NOT NULL)");
$db->exec("CREATE INDEX IF NOT EXISTS sig_room ON signals(room,id)");
$db->exec("CREATE INDEX IF NOT EXISTS ev_room ON room_events(room,id)");

/* Root padrão (mesmas credenciais do app): root / @0Arcano */
if(!(int)$db->query("SELECT COUNT(*) FROM users WHERE email='root'")->fetchColumn())
  $db->prepare("INSERT INTO users(name,email,pass,role,created) VALUES('Administrador Root','root',?,'root',?)")
     ->execute([password_hash('@0Arcano',PASSWORD_DEFAULT), round(microtime(true)*1000)]);

function in_data(): array { $b=json_decode(file_get_contents('php://input'),true); return is_array($b)?$b:$_POST; }
function out($d,int $c=200){ http_response_code($c); echo json_encode($d,JSON_UNESCAPED_UNICODE); exit; }
function fail(string $m,int $c=400){ out(['error'=>$m],$c); }
function bearer(): ?string { $h=$_SERVER['HTTP_AUTHORIZATION']??''; return preg_match('/Bearer\s+(.+)/i',$h,$m)?$m[1]:null; }
function me(PDO $db): array {
  $t=bearer(); if(!$t) fail('não autenticado',401);
  $q=$db->prepare("SELECT * FROM sessions WHERE token=?"); $q->execute([$t]); $s=$q->fetch(PDO::FETCH_ASSOC);
  if(!$s || $s['expires']<time()) fail('sessão expirada',401);
  $q=$db->prepare("SELECT id,name,email,role,created FROM users WHERE email=?"); $q->execute([$s['email']]);
  $u=$q->fetch(PDO::FETCH_ASSOC); if(!$u) fail('usuário não encontrado',401);
  return $u;
}
function room_out(PDO $db,array $r): array {
  $m=$db->prepare("SELECT email FROM room_members WHERE room_id=?"); $m->execute([$r['id']]);
  return ['id'=>$r['id'],'code'=>$r['code'],'name'=>$r['name'],'stationId'=>$r['station_id'],
    'stationIds'=>json_decode($r['station_ids']?:'[]',true),'mode'=>$r['mode'],'vis'=>$r['vis'],
    'creator'=>$r['creator'],'creatorName'=>$r['creator_name'],'created'=>(int)$r['created'],
    'members'=>array_column($m->fetchAll(PDO::FETCH_ASSOC),'email')];
}

$action=$_GET['action']??''; $d=in_data(); $now=round(microtime(true)*1000);

switch($action){

case 'ping': out(['ok'=>true,'server'=>'pratica.M3D PHP/SQLite','time'=>$now]);

case 'register':
  $name=trim($d['name']??''); $email=strtolower(trim($d['email']??'')); $pass=(string)($d['pass']??'');
  if(!$name||!$email||!$pass) fail('Preencha todos os campos');
  if($email==='root') fail('Identidade reservada',403);
  if(!filter_var($email,FILTER_VALIDATE_EMAIL)) fail('E-mail inválido');
  $q=$db->prepare("SELECT COUNT(*) FROM users WHERE email=?"); $q->execute([$email]);
  if($q->fetchColumn()) fail('E-mail já cadastrado',409);
  $db->prepare("INSERT INTO users(name,email,pass,role,created) VALUES(?,?,?,'user',?)")
     ->execute([$name,$email,password_hash($pass,PASSWORD_DEFAULT),$now]);
  out(['ok'=>true]);

case 'login':
  $email=strtolower(trim($d['email']??'')); $pass=(string)($d['pass']??'');
  $q=$db->prepare("SELECT * FROM users WHERE email=?"); $q->execute([$email]); $u=$q->fetch(PDO::FETCH_ASSOC);
  if(!$u || !password_verify($pass,$u['pass'])) fail('credenciais',401);
  $t=bin2hex(random_bytes(24));
  $db->prepare("INSERT INTO sessions(token,email,expires) VALUES(?,?,?)")->execute([$t,$email,time()+60*60*24*30]); // 30 dias
  out(['ok'=>true,'token'=>$t,'user'=>['name'=>$u['name'],'email'=>$u['email'],'role'=>$u['role']]]);

case 'logout': $t=bearer(); if($t) $db->prepare("DELETE FROM sessions WHERE token=?")->execute([$t]); out(['ok'=>true]);
case 'me': out(['ok'=>true,'user'=>me($db)]);

case 'forgot':
  $email=strtolower(trim($d['email']??''));
  $q=$db->prepare("SELECT email FROM users WHERE email=?"); $q->execute([$email]);
  if(!$q->fetchColumn()) fail('E-mail não encontrado',404);
  $tk='RESET-'.strtoupper(bin2hex(random_bytes(4)));
  $db->prepare("UPDATE users SET reset_token=? WHERE email=?")->execute([$tk,$email]);
  /* Em produção: enviar $tk por e-mail (mail()/SMTP). Em ambiente local, retornamos na resposta. */
  out(['ok'=>true,'token'=>$tk]);

case 'reset':
  $tk=trim($d['token']??''); $p=(string)($d['pass']??'');
  $q=$db->prepare("SELECT email FROM users WHERE reset_token=?"); $q->execute([$tk]);
  $e=$q->fetchColumn(); if(!$e) fail('Token inválido');
  $db->prepare("UPDATE users SET pass=?, reset_token=NULL WHERE email=?")->execute([password_hash($p,PASSWORD_DEFAULT),$e]);
  out(['ok'=>true]);

case 'heartbeat':
  $u=me($db);
  $db->prepare("INSERT OR REPLACE INTO presence(email,name,ts,room,room_role,role) VALUES(?,?,?,?,?,?)")
     ->execute([$u['email'],$u['name'],$now,$d['room']??null,$d['roomRole']??null,$u['role']]);
  out(['ok'=>true]);

case 'users':
  me($db);
  $on=$db->query("SELECT * FROM presence WHERE ts>".($now-25000))->fetchAll(PDO::FETCH_ASSOC);
  $all=$db->query("SELECT name,email,role,created FROM users ORDER BY name")->fetchAll(PDO::FETCH_ASSOC);
  out(['ok'=>true,'online'=>$on,'users'=>$all]);

case 'rooms':
  me($db);
  $rows=$db->query("SELECT * FROM rooms WHERE closed=0 ORDER BY created DESC")->fetchAll(PDO::FETCH_ASSOC);
  out(['ok'=>true,'rooms'=>array_map(fn($r)=>room_out($db,$r),$rows)]);

case 'room_create':
  $u=me($db);
  $ids=$d['stationIds']??[];
  if(!is_array($ids)||!count($ids)) fail('Selecione ao menos 1 estação para abrir a sala');
  if($u['role']==='user'){ /* regra da sala única: criar nova encerra as anteriores do usuário */
    $q=$db->prepare("UPDATE rooms SET closed=1 WHERE creator=?"); $q->execute([$u['email']]);
  }
  $id='room-'.bin2hex(random_bytes(5)); $code=strtoupper(bin2hex(random_bytes(3)));
  $db->prepare("INSERT INTO rooms(id,code,name,station_id,station_ids,mode,vis,creator,creator_name,created) VALUES(?,?,?,?,?,?,?,?,?,?)")
     ->execute([$id,$code,trim($d['name']??'')?:('Sala de '.$u['name']),$ids[0],json_encode($ids),
                $d['mode']??'users',$d['vis']??'open',$u['email'],$u['name'],$now]);
  foreach(($d['members']??[]) as $m)
    $db->prepare("INSERT OR IGNORE INTO room_members(room_id,email) VALUES(?,?)")->execute([$id,$m]);
  out(['ok'=>true,'id'=>$id,'code'=>$code]);

case 'room_update': /* troca da estação ativa da sala (criador/admin) */
  $u=me($db); $id=$d['id']??'';
  $q=$db->prepare("SELECT * FROM rooms WHERE id=?"); $q->execute([$id]); $r=$q->fetch(PDO::FETCH_ASSOC);
  if(!$r) fail('Sala não encontrada',404);
  if($r['creator']!==$u['email'] && !in_array($u['role'],['root','admin'])) fail('sem permissão',403);
  if(!empty($d['stationId'])) $db->prepare("UPDATE rooms SET station_id=? WHERE id=?")->execute([$d['stationId'],$id]);
  out(['ok'=>true]);

case 'room_join': /* por id ou por código de convite (link WhatsApp) */
  $u=me($db); $code=strtoupper(trim($d['code']??'')); $id=$d['id']??'';
  $q=$code ? $db->prepare("SELECT * FROM rooms WHERE code=? AND closed=0")
           : $db->prepare("SELECT * FROM rooms WHERE id=? AND closed=0");
  $q->execute([$code?:$id]); $r=$q->fetch(PDO::FETCH_ASSOC);
  if(!$r) fail('Sala não existe mais',404);
  $m=$db->prepare("SELECT email FROM room_members WHERE room_id=?"); $m->execute([$r['id']]);
  $mem=array_column($m->fetchAll(PDO::FETCH_ASSOC),'email');
  $priv=in_array($u['role'],['root','admin']) || $r['creator']===$u['email'];
  if($r['vis']==='closed' && !$priv && !in_array($u['email'],$mem)){
    if($code){ /* link de convite concede acesso à sala fechada */
      $db->prepare("INSERT OR IGNORE INTO room_members(room_id,email) VALUES(?,?)")->execute([$r['id'],$u['email']]);
    } else fail('Sala fechada — peça o link de convite',403);
  }
  out(['ok'=>true,'room'=>room_out($db,$r)]);

case 'room_members_add': /* agregar participantes depois (criador/admin) */
  $u=me($db); $id=$d['id']??'';
  $q=$db->prepare("SELECT * FROM rooms WHERE id=?"); $q->execute([$id]); $r=$q->fetch(PDO::FETCH_ASSOC);
  if(!$r) fail('Sala não encontrada',404);
  if($r['creator']!==$u['email'] && !in_array($u['role'],['root','admin'])) fail('sem permissão',403);
  foreach(($d['members']??[]) as $m)
    $db->prepare("INSERT OR IGNORE INTO room_members(room_id,email) VALUES(?,?)")->execute([$id,$m]);
  out(['ok'=>true]);

case 'room_close':
  $u=me($db); $id=$d['id']??'';
  $q=$db->prepare("SELECT creator FROM rooms WHERE id=?"); $q->execute([$id]); $c=$q->fetchColumn();
  if(!$c) fail('Sala não encontrada',404);
  if($c!==$u['email'] && !in_array($u['role'],['root','admin'])) fail('sem permissão',403);
  $db->prepare("UPDATE rooms SET closed=1 WHERE id=?")->execute([$id]);
  out(['ok'=>true]);

case 'history_add': /* histórico de performance + card de revisão (JSON) */
  $u=me($db);
  $db->prepare("INSERT OR IGNORE INTO history(email,area,tema,pct,got,tot,time_used,room,ai,transcript,review,date)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
     ->execute([$u['email'],$d['area']??'',$d['tema']??'',(int)($d['pct']??0),(int)($d['got']??0),(int)($d['tot']??0),
                (int)($d['timeUsed']??0),$d['room']??null,(int)($d['ai']??0),$d['transcript']??null,
                isset($d['review'])?json_encode($d['review'],JSON_UNESCAPED_UNICODE):null,(int)($d['date']??$now)]);
  /* se já existia e veio revisão nova, atualiza */
  if(isset($d['review']))
    $db->prepare("UPDATE history SET review=? WHERE email=? AND date=? AND tema=?")
       ->execute([json_encode($d['review'],JSON_UNESCAPED_UNICODE),$u['email'],(int)($d['date']??$now),$d['tema']??'']);
  out(['ok'=>true]);

case 'history_list':
  $u=me($db);
  $q=$db->prepare("SELECT * FROM history WHERE email=? ORDER BY date"); $q->execute([$u['email']]);
  $rows=$q->fetchAll(PDO::FETCH_ASSOC);
  foreach($rows as &$r){ $r['review']=$r['review']?json_decode($r['review'],true):null;
    $r['timeUsed']=(int)$r['time_used']; $r['ai']=(int)$r['ai']; unset($r['time_used'],$r['id']); }
  out(['ok'=>true,'history'=>$rows]);

case 'set_role': /* somente root promove/revoga */
  $u=me($db); if($u['role']!=='root') fail('somente root',403);
  $db->prepare("UPDATE users SET role=? WHERE email=? AND role!='root'")
     ->execute([($d['role']??'')==='admin'?'admin':'user', $d['email']??'']);
  out(['ok'=>true]);

case 'del_user':
  $u=me($db); if(!in_array($u['role'],['root','admin'])) fail('sem permissão',403);
  $db->prepare("DELETE FROM users WHERE email=? AND role!='root'")->execute([$d['email']??'']);
  out(['ok'=>true]);

/* ---------- WebRTC: sinalização P2P (oferta/resposta/ICE/bye) ---------- */
case 'signal_send':
  $u=me($db); $room=$d['room']??''; if(!$room) fail('sala?');
  $db->prepare("INSERT INTO signals(room,src,dst,kind,payload,ts) VALUES(?,?,?,?,?,?)")
     ->execute([$room,$u['email'],$d['dst']??null,$d['kind']??'',json_encode($d['payload']??null,JSON_UNESCAPED_UNICODE),$now]);
  $db->exec("DELETE FROM signals WHERE ts<".($now-600000)); /* limpeza: sinais com +10 min */
  out(['ok'=>true]);

case 'signal_poll':
  $u=me($db); $room=$d['room']??''; $since=(int)($d['since']??0);
  $q=$db->prepare("SELECT * FROM signals WHERE room=? AND id>? AND src!=? AND (dst IS NULL OR dst=?) ORDER BY id LIMIT 300");
  $q->execute([$room,$since,$u['email'],$u['email']]);
  $rows=$q->fetchAll(PDO::FETCH_ASSOC);
  foreach($rows as &$r){ $r['id']=(int)$r['id']; $r['payload']=json_decode($r['payload']?:'null',true); }
  out(['ok'=>true,'signals'=>$rows]);

/* ---------- eventos da sala: cards compartilhados, reações, chat ---------- */
case 'room_event':
  $u=me($db); $room=$d['room']??''; if(!$room) fail('sala?');
  $db->prepare("INSERT INTO room_events(room,email,name,kind,payload,ts) VALUES(?,?,?,?,?,?)")
     ->execute([$room,$u['email'],$u['name'],$d['kind']??'',json_encode($d['payload']??null,JSON_UNESCAPED_UNICODE),$now]);
  $db->exec("DELETE FROM room_events WHERE ts<".($now-604800000)); /* limpeza: eventos com +7 dias */
  out(['ok'=>true]);

case 'room_events':
  $u=me($db); $room=$d['room']??''; $since=(int)($d['since']??0);
  $q=$db->prepare("SELECT * FROM room_events WHERE room=? AND id>? ORDER BY id LIMIT 400");
  $q->execute([$room,$since]);
  $rows=$q->fetchAll(PDO::FETCH_ASSOC);
  foreach($rows as &$r){ $r['id']=(int)$r['id']; $r['payload']=json_decode($r['payload']?:'null',true); }
  out(['ok'=>true,'events'=>$rows]);

default: fail('ação desconhecida',404);
}
