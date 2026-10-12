<?php
// Endpoint RESERVA de token Agora (failsafe): usado pelo front apenas se a API Node falhar.
// Uso: GET /php/token.php?canal=sala-xxx&uid=123&papel=observador
// Credenciais vêm do ambiente (AGORA_APP_ID / AGORA_APP_CERTIFICATE), nunca do cliente.
// Implementação AccessToken2 ("007") seguindo o algoritmo oficial da Agora — valide com o
// servidor de testes do console Agora antes de confiar nele como caminho principal.

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

$appId = getenv('AGORA_APP_ID') ?: '';
$appCert = getenv('AGORA_APP_CERTIFICATE') ?: '';
$canal = preg_replace('/[^a-zA-Z0-9_\-]/', '', $_GET['canal'] ?? '');
$uid   = preg_replace('/[^0-9]/', '', $_GET['uid'] ?? '0');

if (!$appId || !$appCert) { echo json_encode(['modo' => 'demo']); exit; } // failsafe final
if (!$canal) { http_response_code(400); echo json_encode(['erro' => 'canal inválido']); exit; }

function p16($x) { return pack('v', $x); }
function p32($x) { return pack('V', $x); }
function pstr($s) { return p16(strlen($s)) . $s; }

// Serviço RTC (tipo 1) com privilégio "entrar no canal" (1)
$expira = time() + 3600;
$servico = p16(1) . pstr($canal) . pstr((string)$uid) . p16(1) . p16(1) . p32($expira);

// AccessToken2
$salt = random_int(1, 99999999);
$emitido = time();
$msg = pstr($appId) . p32($emitido) . p32($expira) . p32($salt) . p16(1) . $servico;
$h1 = hash_hmac('sha256', $appCert, hex2bin($appId), true);
$assinaturaBase = hash_hmac('sha256', p32($emitido), $h1, true);
$assinatura = hash_hmac('sha256', $msg, $assinaturaBase, true);
$conteudo = pstr($assinatura) . $msg;
$token = '007' . base64_encode(gzcompress($conteudo, 9));

echo json_encode([
    'modo' => 'agora',
    'appId' => $appId,
    'canal' => $canal,
    'uid' => (int)$uid,
    'token' => $token,
    'expiraEm' => $expira,
]);
