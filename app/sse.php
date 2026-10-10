<?php
declare(strict_types=1);

/**
 * Barramento de tempo real (substitui Socket.io): Server-Sent Events.
 * O servidor grava cada ação relevante na tabela `events`; este endpoint
 * entrega ao cliente, em streaming, tudo o que aconteceu desde o último id.
 * A presença é marcada por POST /api/ping (heartbeat) — sem polling de dados.
 */

function sse_room_events(int $since, string $room, int $uid, int $maxSeconds = 25): void
{
    @set_time_limit(0);
    if (function_exists('apache_setenv')) @apache_setenv('no-gzip', '1');
    @ini_set('zlib.output_compression', '0');
    @ini_set('output_buffering', '0');
    while (ob_get_level() > 0) ob_end_flush();

    header('Content-Type: text/event-stream; charset=utf-8');
    header('Cache-Control: no-cache, no-transform');
    header('Connection: keep-alive');
    header('X-Accel-Buffering: no');

    $pdo = db();
    $deadline = time() + $maxSeconds;
    $last = $since;
    $ticks = 0;

    // abertura: última posição conhecida
    echo "retry: 2500\n\n";
    echo "event: hello\n";
    echo 'data: ' . jenc(['since' => $last, 'server' => now()]) . "\n\n";
    flush();

    while (time() < $deadline) {
        if (connection_aborted()) return;

        $sql = 'SELECT * FROM events WHERE id > ?';
        $args = [$last];
        if ($room !== '') { $sql .= ' AND (room = ? OR room = \'\')'; $args[] = $room; }
        $sql .= ' ORDER BY id ASC LIMIT 120';
        $st = $pdo->prepare($sql);
        $st->execute($args);
        $rows = $st->fetchAll();

        foreach ($rows as $r) {
            $last = max($last, (int)$r['id']);
            echo "id: {$r['id']}\n";
            echo "event: {$r['type']}\n";
            echo 'data: ' . jenc([
                'type' => $r['type'],
                'room' => $r['room'],
                'payload' => jdec($r['payload']),
                'at' => (int)$r['created_at'],
            ]) . "\n\n";
        }
        if ($rows) { flush(); }

        $ticks++;
        if ($ticks % 6 === 0) {                     // heartbeat + presença
            $pres = sse_presence($room);
            echo "event: presence\n";
            echo 'data: ' . jenc(['members' => $pres]) . "\n\n";
            echo ": keep-alive\n\n";
            flush();
        }

        usleep(700000);                             // ~0,7 s
        if (function_exists('gc_collect_cycles')) gc_collect_cycles();
    }

    echo "event: bye\n";
    echo 'data: ' . jenc(['since' => $last]) . "\n\n";
    flush();
}

function sse_presence(string $room): array
{
    if ($room === '') return [];
    $st = db()->prepare('SELECT * FROM room_members WHERE room_code = ? AND last_seen > ? ORDER BY user_name');
    $st->execute([$room, now() - 30]);
    $out = [];
    foreach ($st->fetchAll() as $m) {
        $out[] = ['peer_id' => $m['peer_id'], 'user_id' => (int)$m['user_id'],
                  'name' => $m['user_name'], 'role' => $m['role']];
    }
    return $out;
}
