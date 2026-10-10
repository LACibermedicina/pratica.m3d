<?php
declare(strict_types=1);

/* ------------------------------------------------------------ respostas ---- */

function json_out($data, int $code = 200): void
{
    if (!headers_sent()) {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
    }
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function ok($data = []): void
{
    json_out(array_merge(['ok' => true], is_array($data) ? $data : ['data' => $data]));
}

function err(string $msg, int $code = 400, array $extra = []): void
{
    json_out(array_merge(['ok' => false, 'error' => $msg], $extra), $code);
}

/* --------------------------------------------------------------- entradas --- */

function body(): array
{
    static $b = null;
    if ($b !== null) return $b;
    $raw = file_get_contents('php://input') ?: '';
    $ct  = strtolower($_SERVER['CONTENT_TYPE'] ?? '');
    if (strpos($ct, 'application/json') !== false) {
        $b = json_decode($raw, true) ?: [];
    } else {
        $b = $_POST ?: (json_decode($raw, true) ?: []);
    }
    return $b;
}

function param(string $k, $default = null)
{
    $b = body();
    if (array_key_exists($k, $b)) return $b[$k];
    if (array_key_exists($k, $_GET)) return $_GET[$k];
    return $default;
}

function bearer(): string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
    if ($h === '' && function_exists('apache_request_headers')) {
        foreach (apache_request_headers() as $k => $v) {
            if (strtolower($k) === 'authorization') { $h = $v; break; }
        }
    }
    if (preg_match('/Bearer\s+(.+)/i', $h, $m)) return trim($m[1]);
    return (string)($_GET['token'] ?? $_COOKIE['m3d_token'] ?? '');
}

/* ---------------------------------------------------------------- helpers --- */

function rid(int $bytes = 6): string
{
    return bin2hex(random_bytes($bytes));
}

function now(): int { return time(); }

function jdec($s, $d = [])
{
    if (is_array($s)) return $s;
    $v = json_decode((string)$s, true);
    return is_array($v) ? $v : $d;
}

function jenc($v): string
{
    return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function client_ip(): string
{
    return (string)($_SERVER['REMOTE_ADDR'] ?? '');
}

function audit(?array $actor, string $action, string $target = '', $meta = []): void
{
    $st = db()->prepare('INSERT INTO audit(actor_id,actor_name,action,target,meta,created_at) VALUES(?,?,?,?,?,?)');
    $st->execute([
        $actor['id'] ?? null,
        $actor['name'] ?? 'sistema',
        $action,
        $target,
        is_array($meta) ? jenc($meta) : (string)$meta,
        now(),
    ]);
}
