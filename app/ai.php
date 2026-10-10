<?php
declare(strict_types=1);

/**
 * Cadeia de failsafe de IA: Gemini → OpenAI → Pollinations.
 * Cada tentativa é gravada em ai_calls (provedor, modelo, latência, erro).
 * O frontend NUNCA vê chave alguma — só fala com /api/ai/* neste servidor.
 */

function ai_cfg(string $k, string $d = ''): string
{
    return (string)env($k, $d);
}

function ai_timeout(): int
{
    return (int)ceil((float)env('AI_TIMEOUT', 35));
}

function http_json(string $url, array $payload, array $headers = [], ?int $timeout = null, string $method = 'POST'): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout ?? ai_timeout(),
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER     => array_merge(['Content-Type: application/json'], $headers),
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $out  = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $cerr = curl_error($ch);
    curl_close($ch);

    if ($out === false) throw new RuntimeException('cURL: ' . $cerr);
    if ($code >= 400)   throw new RuntimeException('HTTP ' . $code . ' — ' . substr((string)$out, 0, 240));
    $data = json_decode((string)$out, true);
    return is_array($data) ? $data : ['_raw' => (string)$out];
}

function ai_log(string $provider, string $model, string $purpose, bool $okay, int $lat, string $error = ''): void
{
    $st = db()->prepare('INSERT INTO ai_calls(provider,model,purpose,ok,latency_ms,error,created_at) VALUES(?,?,?,?,?,?,?)');
    $st->execute([$provider, $model, $purpose, $okay ? 1 : 0, $lat, mb_substr($error, 0, 500), now()]);
}

/* ------------------------------------------------------------- provedores ---- */

function ai_gemini(string $prompt): string
{
    $key   = ai_cfg('GEMINI_API_KEY');
    $model = ai_cfg('GEMINI_MODEL', 'gemini-2.0-flash');
    $url   = "https://generativelanguage.googleapis.com/v1beta/models/{$model}:generateContent?key=" . urlencode($key);
    $d = http_json($url, ['contents' => [['parts' => [['text' => $prompt]]]]]);
    $t = $d['candidates'][0]['content']['parts'][0]['text'] ?? null;
    if (!$t) throw new RuntimeException('Gemini sem texto na resposta');
    return $t;
}

function ai_openai(string $prompt): string
{
    $base  = rtrim(ai_cfg('OPENAI_BASE_URL', 'https://api.openai.com/v1'), '/');
    $key   = ai_cfg('OPENAI_API_KEY');
    $model = ai_cfg('OPENAI_MODEL', 'gpt-4o-mini');
    $d = http_json("$base/chat/completions", [
        'model' => $model,
        'messages' => [['role' => 'user', 'content' => $prompt]],
    ], ['Authorization: Bearer ' . $key]);
    $t = $d['choices'][0]['message']['content'] ?? null;
    if (!$t) throw new RuntimeException('OpenAI sem conteúdo na resposta');
    return $t;
}

function ai_pollinations(string $prompt): string
{
    $model = ai_cfg('POLLINATIONS_MODEL', 'openai');
    $d = http_json('https://text.pollinations.ai/openai', [
        'model' => $model,
        'messages' => [['role' => 'user', 'content' => $prompt]],
        'private' => true,
    ]);
    if (isset($d['choices'][0]['message']['content'])) return (string)$d['choices'][0]['message']['content'];
    if (isset($d['_raw'])) return (string)$d['_raw'];
    throw new RuntimeException('Pollinations sem texto na resposta');
}

function ai_providers(): array
{
    return [
        'gemini'       => ['fn' => 'ai_gemini',       'model' => ai_cfg('GEMINI_MODEL', 'gemini-2.0-flash'), 'ready' => ai_cfg('GEMINI_API_KEY') !== ''],
        'openai'       => ['fn' => 'ai_openai',       'model' => ai_cfg('OPENAI_MODEL', 'gpt-4o-mini'),      'ready' => ai_cfg('OPENAI_API_KEY') !== ''],
        'pollinations' => ['fn' => 'ai_pollinations', 'model' => ai_cfg('POLLINATIONS_MODEL', 'openai'),    'ready' => true],
    ];
}

/** Executa a cadeia na ordem e retorna ['provider','text'] ou lança erro agregado. */
function ai_complete(string $prompt, string $purpose = 'generic'): array
{
    $errors = [];
    foreach (ai_providers() as $name => $p) {
        if (!$p['ready']) { $errors[] = "$name: chave ausente (defina via .env)"; continue; }
        $t0 = microtime(true);
        try {
            $txt = call_user_func($p['fn'], $prompt);
            ai_log($name, $p['model'], $purpose, true, (int)((microtime(true) - $t0) * 1000));
            return ['provider' => $name, 'model' => $p['model'], 'text' => $txt];
        } catch (Throwable $e) {
            ai_log($name, $p['model'], $purpose, false, (int)((microtime(true) - $t0) * 1000), get_class($e) . ': ' . $e->getMessage());
            $errors[] = "$name: " . get_class($e) . ': ' . $e->getMessage();
        }
    }
    throw new RuntimeException('Todos os provedores falharam → ' . implode(' | ', $errors));
}

/** Teste ao vivo de cada provedor (painel de diagnóstico). */
function ai_status(): array
{
    $out = [];
    foreach (ai_providers() as $name => $p) {
        if (!$p['ready']) {
            $out[] = ['provider' => $name, 'configured' => false, 'ok' => false,
                      'model' => $p['model'], 'error' => 'chave ausente — defina a variável de ambiente'];
            continue;
        }
        $t0 = microtime(true);
        try {
            $txt = call_user_func($p['fn'], 'Responda apenas: OK');
            $out[] = ['provider' => $name, 'configured' => true, 'ok' => true, 'model' => $p['model'],
                      'latency_ms' => (int)((microtime(true) - $t0) * 1000), 'sample' => mb_substr(trim($txt), 0, 40)];
        } catch (Throwable $e) {
            $out[] = ['provider' => $name, 'configured' => true, 'ok' => false, 'model' => $p['model'],
                      'latency_ms' => (int)((microtime(true) - $t0) * 1000),
                      'error' => mb_substr(get_class($e) . ': ' . $e->getMessage(), 0, 250)];
        }
    }
    return $out;
}

function ai_extract_json(string $text): array
{
    $raw = $text;
    if (preg_match('/```(?:json)?\s*(.*?)```/s', $text, $m)) $raw = $m[1];
    $candidates = [];
    $i = strpos($raw, '{'); $j = strrpos($raw, '}');
    if ($i !== false && $j !== false && $j > $i) $candidates[] = substr($raw, $i, $j - $i + 1);
    $i = strpos($raw, '['); $j = strrpos($raw, ']');
    if ($i !== false && $j !== false && $j > $i) $candidates[] = substr($raw, $i, $j - $i + 1);
    foreach ($candidates as $c) {
        $d = json_decode($c, true);
        if (is_array($d)) return $d;
    }
    throw new RuntimeException('A IA não devolveu JSON válido');
}
