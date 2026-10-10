<?php
declare(strict_types=1);

/**
 * pratica.M3D v5 — bootstrap (PHP 8 + PDO SQLite)
 * Todas as credenciais são lidas EXCLUSIVAMENTE de variáveis de ambiente / .env.
 * Nenhuma chave fica embutida no código ou no frontend.
 */

define('ROOT', dirname(__DIR__));
define('APP_DIR', ROOT . '/app');
define('DATA_DIR', ROOT . '/data');
define('STORAGE_DIR', ROOT . '/storage');
define('PUBLIC_DIR', ROOT . '/public');
define('VIEWS_DIR', APP_DIR . '/views');

function env(string $k, $default = null)
{
    $v = getenv($k);
    if ($v === false || $v === '') return $default;
    return $v;
}

/* ---------------------------------------------------------------- .env ------ */
$__envFile = ROOT . '/.env';
if (is_file($__envFile)) {
    foreach (file($__envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $__line) {
        $__line = trim($__line);
        if ($__line === '' || $__line[0] === '#' || strpos($__line, '=') === false) continue;
        $__p = explode('=', $__line, 2);
        $__k = trim($__p[0]);
        $__v = trim($__p[1]);
        if (strlen($__v) > 1 && ($__v[0] === '"' || $__v[0] === "'") && substr($__v, -1) === $__v[0]) {
            $__v = substr($__v, 1, -1);
        }
        if (getenv($__k) === false) putenv("$__k=$__v");
    }
}

date_default_timezone_set((string)env('TZ', 'America/Sao_Paulo'));
@mkdir(STORAGE_DIR, 0775, true);
@mkdir(STORAGE_DIR . '/flowcards', 0775, true);

foreach (['db', 'http', 'auth', 'ai', 'stations_io', 'flowcards', 'sse', 'api_ai', 'api_room', 'api_study', 'api'] as $__m) {
    require_once APP_DIR . "/$__m.php";
}
