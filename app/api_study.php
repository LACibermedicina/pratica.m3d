<?php
declare(strict_types=1);

/** Ferramentas didáticas: cards de revisão com repetição espaçada (SRS 1/3/7/15/30). */

function routes_study(): array
{
    return [
        ['GET', '#^/api/srs$#', function () {
            $u = auth_require();
            $st = db()->prepare('SELECT c.*, s.tema, s.area FROM srs_cards c LEFT JOIN stations s ON s.id = c.station_id
                                 WHERE c.user_id = ? ORDER BY c.next_due ASC LIMIT 400');
            $st->execute([(int)$u['id']]);
            $rows = $st->fetchAll();
            $due = array_values(array_filter($rows, fn($r) => (int)$r['next_due'] <= now()));
            foreach ($rows as &$r) $r['due'] = (int)$r['next_due'] <= now();
            ok(['cards' => $rows, 'due' => count($due), 'total' => count($rows),
                'intervals' => SRS_INTERVALS]);
        }],

        ['GET', '#^/api/srs/due$#', function () {
            $u = auth_require();
            $st = db()->prepare('SELECT c.*, s.tema, s.area FROM srs_cards c LEFT JOIN stations s ON s.id = c.station_id
                                 WHERE c.user_id = ? AND c.next_due <= ? ORDER BY c.next_due ASC LIMIT 60');
            $st->execute([(int)$u['id'], now()]);
            ok(['cards' => $st->fetchAll()]);
        }],

        /** Transforma os itens do PEP em cartões didáticos (caso clínico no verso). */
        ['POST', '#^/api/srs/generate$#', function () {
            $u = auth_require();
            $sid = (string)param('station_id', '');
            $st = db()->prepare('SELECT * FROM stations WHERE id = ?');
            $st->execute([$sid]);
            $s = $st->fetch();
            if (!$s) err('Estação não encontrada', 404);

            $items = jdec($s['checklist']);
            if (!$items) err('Esta estação não possui itens de PEP para gerar cartões', 400);

            $has = db()->prepare('SELECT COUNT(*) FROM srs_cards WHERE user_id = ? AND station_id = ?');
            $has->execute([(int)$u['id'], $sid]);
            if ((int)$has->fetchColumn() > 0) ok(['created' => 0, 'message' => 'Os cartões desta estação já estão na sua biblioteca']);

            $ins = db()->prepare('INSERT INTO srs_cards(user_id,station_id,front,back,level,next_due,created_at)
                                  VALUES(?,?,?,?,0,?,?)');
            $n = 0;
            foreach ($items as $c) {
                $item = (string)($c['item'] ?? '');
                if ($item === '') continue;
                $front = "Caso: {$s['tema']} ({$s['area']})\n\nPEP: {$item}";
                $back  = "Abordagem esperada\n\n"
                       . "Cenário: " . mb_substr((string)$s['cenario'], 0, 420) . "\n\n"
                       . "Protocolo: " . mb_substr((string)$s['protocolo'], 0, 420) . "\n\n"
                       . "Como executar: " . $item;
                $ins->execute([(int)$u['id'], $sid, $front, $back, now(), now()]);
                $n++;
            }
            audit($u, 'srs_generate', $sid, ['cartoes' => $n]);
            ok(['created' => $n, 'message' => "$n cartões criados para $sid"]);
        }],

        ['POST', '#^/api/srs/review$#', function () {
            $u = auth_require();
            $b = body();
            $id = (int)($b['id'] ?? 0);
            $grade = (string)($b['grade'] ?? 'good');

            $st = db()->prepare('SELECT * FROM srs_cards WHERE id = ? AND user_id = ?');
            $st->execute([$id, (int)$u['id']]);
            $c = $st->fetch();
            if (!$c) err('Cartão não encontrado', 404);

            $lvl = (int)$c['level'];
            if ($grade === 'again')      $lvl = 0;
            elseif ($grade === 'hard')   $lvl = max(0, $lvl);
            elseif ($grade === 'easy')   $lvl = min(count(SRS_INTERVALS) - 1, $lvl + 2);
            else                          $lvl = min(count(SRS_INTERVALS) - 1, $lvl + 1);

            $days = SRS_INTERVALS[$lvl];
            if ($grade === 'again') $due = now() + 600;                 // reaparece em 10 min
            else                    $due = now() + $days * 86400;

            db()->prepare('UPDATE srs_cards SET level = ?, next_due = ? WHERE id = ?')->execute([$lvl, $due, $id]);
            ok(['id' => $id, 'level' => $lvl, 'interval_days' => $days,
                'next_due' => $due, 'message' => "Próxima revisão em " . ($grade === 'again' ? '10 minutos' : "$days dia(s)")]);
        }],

        ['DELETE', '#^/api/srs/([0-9]+)$#', function ($m) {
            $u = auth_require();
            $st = db()->prepare('DELETE FROM srs_cards WHERE id = ? AND user_id = ?');
            $st->execute([(int)$m[1], (int)$u['id']]);
            if (!$st->rowCount()) err('Cartão não encontrado', 404);
            ok(['message' => 'Cartão removido']);
        }],
    ];
}
