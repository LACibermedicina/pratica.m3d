<?php
declare(strict_types=1);

/**
 * pratica.M3D v5 — ponto de entrada único (roteador).
 *  • /api/*        → API REST (Bearer Token, sessão de 30 dias)
 *  • /sse          → stream de eventos em tempo real (SSE, substitui Socket.io)
 *  • /cards/*.svg  → cards de procedimento com fluxograma vetorial
 *  • /assets/*     → SPA sem etapa de build (Tailwind CDN + CSS/JS próprios)
 *  • /             → SPA (views em app/views)
 *
 * Uso:  php -S 0.0.0.0:${PORT:-3000} index.php
 */

require __DIR__ . '/app/bootstrap.php';
require __DIR__ . '/app/logo.php';

$path = (string)(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');
$path = rtrim($path, '/') ?: '/';
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

/* -------------------------------------------------------------- health check -- */
if ($path === '/health') {
    $n = db_init();
    ok(['status' => 'ok', 'app' => 'pratica.M3D v5', 'php' => PHP_VERSION,
        'stations' => $n, 'ai_chain' => array_keys(ai_providers()),
        'db' => 'sqlite/WAL', 'realtime' => 'SSE']);
}

/* ------------------------------------------------------------- assets públicos - */
if (preg_match('#^/assets/([A-Za-z0-9._-]+)$#', $path, $m)) {
    $file = PUBLIC_DIR . '/assets/' . $m[1];
    if (!is_file($file)) { http_response_code(404); exit('404'); }
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    $types = ['css' => 'text/css', 'js' => 'application/javascript', 'svg' => 'image/svg+xml',
              'png' => 'image/png', 'jpg' => 'image/jpeg', 'ico' => 'image/x-icon',
              'json' => 'application/json', 'woff2' => 'font/woff2'];
    header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream') . '; charset=utf-8');
    header('Cache-Control: public, max-age=600');
    readfile($file);
    exit;
}

/* ------------------------------------------------- cards de procedimento (SVG) -- */
if (preg_match('#^/cards/([A-Za-z0-9-]+)\.svg$#', $path, $m)) {
    $u = auth_current();
    if (!$u) { http_response_code(401); exit('401 — autentique-se para ver o card'); }
    $svg = flow_card_svg((int)$u['id'], $m[1]);
    if ($svg === null) { http_response_code(404); exit('404'); }
    header('Content-Type: image/svg+xml; charset=utf-8');
    header('Cache-Control: private, max-age=300');
    echo $svg;
    exit;
}

/* ------------------------------------------------------- tempo real (SSE) ------- */
if ($path === '/sse') {
    $u = auth_current();
    if (!$u) err('Não autenticado', 401);
    evt_gc();
    sse_room_events((int)($_GET['since'] ?? 0), strtoupper((string)($_GET['room'] ?? '')), (int)$u['id']);
    exit;
}

/* ------------------------------------------------------------------- API REST -- */
if (strpos($path, '/api/') === 0) {
    api_dispatch();
    exit;
}

/* ----------------------------------------------------------------------- SPA ---- */
$stationCount = db_init();                     // cria schema + root + seed das 428
$aiReady = (ai_cfg('GEMINI_API_KEY') !== '' || ai_cfg('OPENAI_API_KEY') !== '');

header('Content-Type: text/html; charset=utf-8');
header('X-Frame-Options: SAMEORIGIN');
header('Referrer-Policy: same-origin');

include VIEWS_DIR . '/head.php';
include VIEWS_DIR . '/layout.php';
?>
</body>
</html>
