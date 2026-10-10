<?php
declare(strict_types=1);

/** Salas de simulação OSCE: WebRTC mesh (relay), timer autoritativo, chats, PEP e disputa. */

const SRS_INTERVALS = [1, 3, 7, 15, 30];
const OBS_TTL = 86400;

function room_by_code(string $code): ?array
{
    $st = db()->prepare('SELECT * FROM rooms WHERE code = ?');
    $st->execute([strtoupper($code)]);
    $r = $st->fetch();
    return $r ?: null;
}

function room_public(array $r): array
{
    return [
        'code' => $r['code'], 'name' => $r['name'],
        'station_ids' => jdec($r['station_ids']), 'active_station' => $r['active_station'],
        'rtype' => $r['rtype'], 'open' => (int)$r['open'], 'study_mode' => (int)$r['study_mode'],
        'creator_id' => (int)$r['creator_id'], 'creator_name' => $r['creator_name'],
        'timer' => room_timer($r), 'created_at' => (int)$r['created_at'],
    ];
}

/** Timer calculado e validado no servidor — fonte única da verdade. */
function room_timer(array $r): array
{
    $dur = (int)$r['timer_duration'];
    $remaining = (int)$r['timer_remaining'];
    if ($r['timer_state'] === 'running') {
        $remaining = max(0, $dur - (now() - (int)$r['timer_started_at']));
    }
    $alert = null;
    if ($remaining <= 60) $alert = 'red';
    elseif ($remaining <= 180) $alert = 'amber';
    return ['state' => $r['timer_state'], 'duration' => $dur, 'remaining' => $remaining,
            'started_at' => (int)$r['timer_started_at'], 'alert' => $alert, 'server' => now()];
}

function room_stations(array $r): array
{
    $ids = jdec($r['station_ids']);
    if (!$ids) return [];
    $ph = implode(',', array_fill(0, count($ids), '?'));
    $st = db()->prepare("SELECT * FROM stations WHERE id IN ($ph)");
    $st->execute($ids);
    $out = [];
    foreach ($st->fetchAll() as $s) $out[] = st_row($s, true);
    return $out;
}

function room_members(string $code): array
{
    $st = db()->prepare('SELECT * FROM room_members WHERE room_code = ? AND last_seen > ? ORDER BY role, user_name');
    $st->execute([$code, now() - 30]);
    $out = [];
    foreach ($st->fetchAll() as $m) {
        $out[] = ['peer_id' => $m['peer_id'], 'user_id' => (int)$m['user_id'], 'name' => $m['user_name'],
                  'role' => $m['role'], 'last_seen' => (int)$m['last_seen']];
    }
    return $out;
}

function room_analytics(int $uid, string $role): array
{
    $scope = in_array($role, ['root', 'admin'], true) ? '' : ' WHERE r.user_id = ' . (int)$uid;
    $rows = db()->query("SELECT r.score, r.created_at, s.area, s.tema
                         FROM pep_results r LEFT JOIN stations s ON s.id = r.station_id$scope")->fetchAll();

    $n = count($rows); $soma = 0.0; $tempo = 0; $porArea = [];
    foreach ($rows as $r) {
        $soma += (float)$r['score'];
        $tempo += 600;                                  // ~10 min por estação registrada
        $a = (string)($r['area'] ?? 'CM');
        $porArea[$a]['soma'] = ($porArea[$a]['soma'] ?? 0) + (float)$r['score'];
        $porArea[$a]['n'] = ($porArea[$a]['n'] ?? 0) + 1;
    }
    $bars = [];
    foreach (AREAS as $a) {
        $bars[] = ['area' => $a, 'label' => AREA_LABELS[$a], 'color' => AREA_COLORS[$a],
                   'media' => isset($porArea[$a]['n']) ? round($porArea[$a]['soma'] / $porArea[$a]['n'], 1) : 0,
                   'treinos' => $porArea[$a]['n'] ?? 0];
    }
    return [
        'kpis' => [
            'treinos' => $n,
            'media' => $n ? round($soma / $n, 1) : 0,
            'tempo_min' => (int)round($tempo / 60),
            'estacoes_concluidas' => $n,
            'estacoes_catalogo' => (int)db()->query('SELECT COUNT(*) FROM stations')->fetchColumn(),
            'salas' => (int)db()->query('SELECT COUNT(*) FROM rooms')->fetchColumn(),
            'usuarios' => (int)db()->query('SELECT COUNT(*) FROM users')->fetchColumn(),
        ],
        'bars' => $bars,
        'donut' => ['global' => $n ? round($soma / $n, 1) : 0, 'restante' => $n ? round(100 - $soma / $n, 1) : 100],
        'ultimos' => array_map(fn($r) => ['tema' => $r['tema'], 'area' => $r['area'], 'score' => (float)$r['score'],
                                          'at' => (int)$r['created_at']], array_slice(array_reverse($rows), 0, 12)),
    ];
}

function routes_room(): array
{
    return [
        /* ------------------------------------------------------- lista de salas -- */
        ['GET', '#^/api/rooms$#', function () {
            $u = auth_require();
            $st = db()->query('SELECT r.*, (SELECT COUNT(*) FROM room_members m WHERE m.room_code = r.code AND m.last_seen > ' . (now() - 30) . ') membros
                               FROM rooms r ORDER BY r.open DESC, r.created_at DESC LIMIT 60');
            $out = [];
            foreach ($st->fetchAll() as $r) {
                $p = room_public($r);
                $p['membros'] = (int)$r['membros'];
                $p['live'] = (int)$r['membros'] > 0;
                $p['mine'] = (int)$r['creator_id'] === (int)$u['id'];
                $out[] = $p;
            }
            ok(['rooms' => $out]);
        }],

        /* ------------------------------------------------------ criar sala ------- */
        ['POST', '#^/api/rooms$#', function () {
            $u = auth_require();
            $b = body();
            $ids = array_values(array_filter(array_map('strval', (array)($b['station_ids'] ?? []))));
            if (!$ids) err('Regra da estação: é proibido abrir sala sem ao menos uma estação selecionada');

            $ph = implode(',', array_fill(0, count($ids), '?'));
            $st = db()->prepare("SELECT id FROM stations WHERE id IN ($ph)");
            $st->execute($ids);
            $valid = array_column($st->fetchAll(), 'id');
            if (!$valid) err('Nenhuma das estações informadas existe');

            // Regra da sala única (admins/root podem manter várias)
            if (!in_array($u['role'], ['root', 'admin'], true)) {
                $old = db()->prepare('SELECT code FROM rooms WHERE creator_id = ?');
                $old->execute([(int)$u['id']]);
                foreach ($old->fetchAll() as $o) {
                    db()->prepare('DELETE FROM room_members WHERE room_code = ?')->execute([$o['code']]);
                    db()->prepare('DELETE FROM rooms WHERE code = ?')->execute([$o['code']]);
                }
            }

            $code = strtoupper(rid(3));
            $name = trim((string)($b['name'] ?? '')) ?: ('Treino ' . $u['name']);
            $st = db()->prepare('INSERT INTO rooms(code,name,station_ids,active_station,rtype,open,study_mode,
                creator_id,creator_name,timer_state,timer_duration,timer_started_at,timer_remaining,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,\'idle\',600,0,600,?)');
            $st->execute([
                $code, $name, jenc($valid), $valid[0],
                (string)($b['rtype'] ?? 'ppl') === 'ai' ? 'ai' : 'ppl',
                !empty($b['open']) ? 1 : 0,
                !empty($b['study_mode']) ? 1 : 0,
                (int)$u['id'], $u['name'], now(),
            ]);

            evt('lobby', 'room:new', ['code' => $code, 'name' => $name, 'creator' => $u['name'],
                                      'rtype' => (string)($b['rtype'] ?? 'ppl'), 'open' => !empty($b['open']) ? 1 : 0]);
            audit($u, 'room_create', $code, ['estacoes' => count($valid)]);
            ok(['room' => room_public(room_by_code($code) ?: [])]);
        }],

        ['GET', '#^/api/rooms/([A-Za-z0-9]+)$#', function ($m) {
            auth_require();
            $r = room_by_code($m[1]);
            if (!$r) err('Sala não encontrada', 404);
            ok(['room' => room_public($r), 'stations' => room_stations($r), 'members' => room_members($r['code'])]);
        }],

        ['DELETE', '#^/api/rooms/([A-Za-z0-9]+)$#', function ($m) {
            $u = auth_require();
            $r = room_by_code($m[1]);
            if (!$r) err('Sala não encontrada', 404);
            if ((int)$r['creator_id'] !== (int)$u['id'] && !in_array($u['role'], ['root', 'admin'], true)) {
                err('Somente o criador (ou admin) encerra a sala', 403);
            }
            evt($r['code'], 'room:closed', ['by' => $u['name']]);
            db()->prepare('DELETE FROM room_members WHERE room_code = ?')->execute([$r['code']]);
            db()->prepare('DELETE FROM rooms WHERE code = ?')->execute([$r['code']]);
            audit($u, 'room_close', $r['code']);
            ok(['message' => 'Sala encerrada']);
        }],

        /* ------------------------------------------------------- presença -------- */
        ['POST', '#^/api/rooms/([A-Za-z0-9]+)/join$#', function ($m) {
            $u = auth_require();
            $r = room_by_code($m[1]);
            if (!$r) err('Sala não encontrada', 404);
            $b = body();
            $peer = (string)($b['peer_id'] ?? rid(4));
            $role = in_array((string)($b['role'] ?? 'medico'), ['medico', 'avaliador', 'observador'], true)
                  ? (string)$b['role'] : 'medico';

            $st = db()->prepare('INSERT INTO room_members(room_code,peer_id,user_id,user_name,role,last_seen)
                                 VALUES(?,?,?,?,?,?)
                                 ON CONFLICT(room_code,peer_id) DO UPDATE SET role=excluded.role, last_seen=excluded.last_seen');
            $st->execute([$r['code'], $peer, (int)$u['id'], $u['name'], $role, now()]);

            evt($r['code'], 'room:members', ['peer_id' => $peer, 'name' => $u['name'], 'role' => $role, 'action' => 'join']);
            ok(['peer_id' => $peer, 'room' => room_public($r), 'stations' => room_stations($r)]);
        }],

        ['POST', '#^/api/rooms/([A-Za-z0-9]+)/leave$#', function ($m) {
            auth_require();
            $b = body();
            db()->prepare('DELETE FROM room_members WHERE room_code = ? AND peer_id = ?')
                ->execute([strtoupper($m[1]), (string)($b['peer_id'] ?? '')]);
            evt(strtoupper($m[1]), 'room:members', ['peer_id' => (string)($b['peer_id'] ?? ''), 'action' => 'leave']);
            ok(['message' => 'Saiu da sala']);
        }],

        ['POST', '#^/api/ping$#', function () {
            auth_require();
            $b = body();
            $code = strtoupper((string)($b['room'] ?? ''));
            $peer = (string)($b['peer_id'] ?? '');
            if ($code === '' || $peer === '') ok(['pong' => now()]);
            db()->prepare('UPDATE room_members SET last_seen = ? WHERE room_code = ? AND peer_id = ?')
                ->execute([now(), $code, $peer]);
            ok(['pong' => now(), 'members' => room_members($code)]);
        }],

        /* --------------------------------------- estação ativa (tempo real) ----- */
        ['POST', '#^/api/rooms/([A-Za-z0-9]+)/station$#', function ($m) {
            $u = auth_require();
            $r = room_by_code($m[1]);
            if (!$r) err('Sala não encontrada', 404);
            if ((int)$r['creator_id'] !== (int)$u['id'] && !in_array($u['role'], ['root', 'admin'], true)) {
                err('Somente o criador troca a estação ativa', 403);
            }
            $sid = (string)param('station_id', '');
            if (!in_array($sid, jdec($r['station_ids']), true)) err('Estação não faz parte desta sala', 400);

            db()->prepare('UPDATE rooms SET active_station = ? WHERE code = ?')->execute([$sid, $r['code']]);
            evt($r['code'], 'room:station', ['station_id' => $sid, 'by' => $u['name']]);
            ok(['active_station' => $sid]);
        }],

        /* ------------------------------------------------------------ timer ----- */
        ['POST', '#^/api/rooms/([A-Za-z0-9]+)/timer$#', function ($m) {
            $u = auth_require();
            $r = room_by_code($m[1]);
            if (!$r) err('Sala não encontrada', 404);
            if ((int)$r['creator_id'] !== (int)$u['id'] && !in_array($u['role'], ['root', 'admin'], true)) {
                err('Somente o criador controla o cronômetro', 403);
            }
            $b = body();
            $action = (string)($b['action'] ?? 'state');
            $cur = room_timer($r);
            $state = $cur['state']; $dur = $cur['duration']; $rem = $cur['remaining']; $started = (int)$r['timer_started_at'];

            switch ($action) {
                case 'start':
                case 'resume':
                    $state = 'running';
                    $started = now();
                    $rem = ($action === 'resume' && $cur['remaining'] > 0 && $cur['remaining'] < $dur) ? $cur['remaining'] : $dur;
                    $started = now();
                    break;
                case 'pause':
                    $state = 'paused'; $rem = $cur['remaining']; $started = 0; break;
                case 'reset':
                    $state = 'idle'; $rem = $dur; $started = 0; break;
                case 'set':
                    $dur = max(30, min(3600, (int)($b['seconds'] ?? $dur)));
                    $rem = $dur; $state = 'idle'; $started = 0; break;
            }

            db()->prepare('UPDATE rooms SET timer_state=?, timer_duration=?, timer_started_at=?, timer_remaining=? WHERE code=?')
                ->execute([$state, $dur, $started, $rem, $r['code']]);
            $fresh = room_by_code($r['code']);
            $t = room_timer($fresh ?: []);
            evt($r['code'], 'timer:ctl', ['action' => $action, 'timer' => $t, 'by' => $u['name']]);
            ok(['timer' => $t]);
        }],

        /* -------------------------------------------------------------- chats --- */
        ['POST', '#^/api/rooms/([A-Za-z0-9]+)/chat$#', function ($m) {
            $u = auth_require();
            $code = strtoupper($m[1]);
            $text = trim((string)param('text', ''));
            if ($text === '') err('Mensagem vazia');
            $text = mb_substr($text, 0, 1500);
            $scope = (string)param('scope', 'room');

            if ($scope === 'obs') {                     // chat oculto: só observadores veem durante a estação
                evt($code . '#obs', 'chat:obs', ['name' => $u['name'], 'text' => $text, 'user_id' => (int)$u['id']]);
            } else {
                db()->prepare('INSERT INTO chat_archive(scope,ref,user_id,user_name,text,created_at) VALUES(?,?,?,?,?,?)')
                    ->execute(['room', $code, (int)$u['id'], $u['name'], $text, now()]);
                evt($code, 'chat:room', ['name' => $u['name'], 'text' => $text, 'user_id' => (int)$u['id']]);
            }
            ok(['message' => 'enviado']);
        }],

        ['POST', '#^/api/rooms/([A-Za-z0-9]+)/finish$#', function ($m) {
            $u = auth_require();
            $code = strtoupper($m[1]);
            $r = room_by_code($code);
            if (!$r) err('Sala não encontrada', 404);
            // revela o chat oculto dos observadores a todos
            $st = db()->prepare("SELECT * FROM events WHERE room = ? AND type = 'chat:obs' ORDER BY id");
            $st->execute([$code . '#obs']);
            foreach ($st->fetchAll() as $e) {
                $p = jdec($e['payload']);
                evt($code, 'chat:room', ['name' => '👀 ' . ($p['name'] ?? 'observador'), 'text' => $p['text'] ?? '']);
            }
            evt($code, 'station:finish', ['by' => $u['name']]);
            ok(['message' => 'Estação encerrada — anotações dos observadores reveladas']);
        }],

        ['POST', '#^/api/chat/lobby$#', function () {
            $u = auth_require();
            $text = trim((string)param('text', ''));
            if ($text === '') err('Mensagem vazia');
            $text = mb_substr($text, 0, 1000);
            db()->prepare('INSERT INTO chat_archive(scope,ref,user_id,user_name,text,created_at) VALUES(?,?,?,?,?,?)')
                ->execute(['lobby', date('Y-m-d H'), (int)$u['id'], $u['name'], $text, now()]);
            evt('', 'chat:lobby', ['name' => $u['name'], 'text' => $text, 'user_id' => (int)$u['id']]);
            ok(['message' => 'enviado']);
        }],

        ['GET', '#^/api/chat/archive$#', function () {
            auth_require(['root', 'admin']);
            $st = db()->query("SELECT * FROM chat_archive ORDER BY id DESC LIMIT 300");
            ok(['archive' => $st->fetchAll()]);
        }],

        /* ----------------------------------------------------- relay WebRTC ----- */
        ['POST', '#^/api/rooms/([A-Za-z0-9]+)/rtc$#', function ($m) {
            $u = auth_require();
            $code = strtoupper($m[1]);
            $b = body();
            evt($code, 'rtc', [
                'from' => (string)($b['from'] ?? ''), 'to' => (string)($b['to'] ?? ''),
                'kind' => (string)($b['kind'] ?? 'ice'), 'data' => $b['data'] ?? null,
                'name' => $u['name'],
            ]);
            ok(['relayed' => true]);
        }],

        /* --------------------------------------------------------- PEP / score -- */
        ['POST', '#^/api/pep$#', function () {
            $u = auth_require();
            $b = body();
            $st = db()->prepare('SELECT * FROM stations WHERE id = ?');
            $st->execute([(string)($b['station_id'] ?? '')]);
            $s = $st->fetch();
            if (!$s) err('Estação não encontrada', 404);

            $items = jdec($s['checklist']);
            $marks = (array)($b['marks'] ?? []);
            $total = 0.0; $ganho = 0.0;
            foreach ($items as $i => $c) {
                $peso = (float)($c['peso'] ?? 1);
                $total += $peso;
                if (!empty($marks[(string)($i + 1)])) $ganho += $peso;
            }
            $score = $total > 0 ? round($ganho / $total * 100, 1) : 0.0;

            $ins = db()->prepare('INSERT INTO pep_results(room_code,station_id,user_id,user_name,marks,score,transcript,notes,created_at)
                                  VALUES(?,?,?,?,?,?,?,?,?)');
            $ins->execute([(string)($b['room_code'] ?? ''), $s['id'], (int)$u['id'], $u['name'],
                           jenc($marks), $score, mb_substr((string)($b['transcript'] ?? ''), 0, 20000),
                           (string)($b['notes'] ?? ''), now()]);
            $id = (int)db()->lastInsertId();

            evt((string)($b['room_code'] ?? ''), 'pep:result',
                ['station_id' => $s['id'], 'score' => $score, 'user' => $u['name'], 'result_id' => $id]);
            ok(['result_id' => $id, 'score' => $score, 'total_peso' => $total, 'ganho' => $ganho]);
        }],

        /* ------------------------------------------------------- contestação ---- */
        ['POST', '#^/api/disputes$#', function () {
            $u = auth_require();
            $b = body();
            $sid = (string)($b['station_id'] ?? '');
            $st = db()->prepare('SELECT * FROM stations WHERE id = ?');
            $st->execute([$sid]);
            $s = $st->fetch();
            if (!$s) err('Estação não encontrada', 404);

            $ins = db()->prepare('INSERT INTO disputes(station_id,item_idx,user_id,user_name,reason,status,created_at)
                                  VALUES(?,?,?,?,?,?,?)');
            $ins->execute([$sid, (int)($b['item_idx'] ?? 0), (int)$u['id'], $u['name'],
                           mb_substr((string)($b['reason'] ?? ''), 0, 1000), 'open', now()]);

            $total = max(1, count(jdec($s['checklist'])));
            $open  = (int)db()->query("SELECT COUNT(DISTINCT item_idx) FROM disputes WHERE station_id = " . db()->quote($sid) . " AND status <> 'closed'")->fetchColumn();
            $ratio = round($open / $total * 100, 1);
            $frozen = $ratio > 40;

            if ($frozen) {                              // >40% anulado → congela e manda para o painel
                db()->prepare('UPDATE stations SET frozen = 1, updated_at = ? WHERE id = ?')->execute([now(), $sid]);
                db()->prepare("UPDATE disputes SET status = 'review' WHERE station_id = ? AND status = 'open'")->execute([$sid]);
                evt((string)($b['room_code'] ?? ''), 'dispute:frozen', ['station_id' => $sid, 'ratio' => $ratio]);
                audit($u, 'dispute_freeze', $sid, ['ratio' => $ratio]);
            }
            ok(['ratio' => $ratio, 'open' => $open, 'total_itens' => $total, 'frozen' => $frozen,
                'message' => $frozen
                    ? 'Anulação acima de 40% — estação congelada e enviada para revisão no painel admin.'
                    : 'Contestação registrada.']);
        }],

        ['GET', '#^/api/disputes$#', function () {
            auth_require(['root', 'admin']);
            $st = db()->query('SELECT d.*, s.tema FROM disputes d LEFT JOIN stations s ON s.id = d.station_id ORDER BY d.id DESC LIMIT 200');
            ok(['disputes' => $st->fetchAll()]);
        }],

        ['POST', '#^/api/disputes/([0-9]+)$#', function ($m) {
            $u = auth_require(['root', 'admin']);
            $b = body();
            $action = (string)($b['action'] ?? 'close');
            $st = db()->prepare("UPDATE disputes SET status = ? WHERE id = ?");
            $st->execute([$action === 'reopen' ? 'open' : 'closed', (int)$m[1]]);

            $did = db()->prepare('SELECT station_id FROM disputes WHERE id = ?');
            $did->execute([(int)$m[1]]);
            $sid = (string)$did->fetchColumn();
            if ($sid) {
                $open = (int)db()->query("SELECT COUNT(DISTINCT item_idx) FROM disputes WHERE station_id = " . db()->quote($sid) . " AND status <> 'closed'")->fetchColumn();
                if ($open === 0) db()->prepare('UPDATE stations SET frozen = 0 WHERE id = ?')->execute([$sid]);
            }
            audit($u, 'dispute_' . $action, $m[1]);
            ok(['message' => 'Contestação atualizada']);
        }],

        /* ------------------------------------------------------------ KPIs ----- */
        ['GET', '#^/api/analytics$#', function () {
            $u = auth_require();
            ok(room_analytics((int)$u['id'], $u['role']));
        }],

        ['GET', '#^/api/pep/results$#', function () {
            $u = auth_require();
            $sql = 'SELECT r.*, s.tema, s.area FROM pep_results r LEFT JOIN stations s ON s.id = r.station_id';
            $args = [];
            if (!in_array($u['role'], ['root', 'admin'], true)) { $sql .= ' WHERE r.user_id = ?'; $args[] = (int)$u['id']; }
            $sql .= ' ORDER BY r.id DESC LIMIT 120';
            $st = db()->prepare($sql);
            $st->execute($args);
            $rows = $st->fetchAll();
            foreach ($rows as &$r) { $r['marks'] = jdec($r['marks']); $r['notes'] = jdec($r['notes'], []); }
            ok(['results' => $rows]);
        }],
    ];
}
