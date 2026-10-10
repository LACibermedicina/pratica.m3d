<?php
declare(strict_types=1);

/** Identidade, Acesso & Segurança — bcrypt (password_hash), Bearer de 30 dias, RBAC. */

function auth_token_for(int $uid): array
{
    $tok = bin2hex(random_bytes(24));
    $t   = now();
    $exp = $t + (int)env('SESSION_DAYS', 30) * 86400;
    $st  = db()->prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)');
    $st->execute([$tok, $uid, $t, $exp]);
    return ['token' => $tok, 'expires_at' => $exp];
}

function auth_user_by_token(?string $tok): ?array
{
    if (!$tok) return null;
    $st = db()->prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                         WHERE s.token = ? AND s.expires_at > ?');
    $st->execute([$tok, now()]);
    $u = $st->fetch();
    return $u ?: null;
}

function auth_current(): ?array
{
    static $u = false;
    if ($u === false) $u = auth_user_by_token(bearer());
    return $u ?: null;
}

function auth_require(array $roles = []): array
{
    $u = auth_current();
    if (!$u) err('Não autenticado', 401);
    if ($roles && !in_array($u['role'], $roles, true)) err('Acesso restrito a ' . implode('/', $roles), 403);
    return $u;
}

function auth_public(array $u): array
{
    return [
        'id' => (int)$u['id'],
        'name' => $u['name'],
        'email' => $u['email'],
        'role' => $u['role'],
        'avatar' => $u['avatar'],
        'layout' => jdec($u['layout'], new stdClass() == new stdClass() ? [] : []),
    ];
}

function auth_register(string $name, string $email, string $pass): array
{
    $name  = trim($name);
    $email = strtolower(trim($email));
    if (mb_strlen($name) < 3)              err('Informe seu nome completo');
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) err('E-mail inválido');
    if (mb_strlen($pass) < 6)              err('A senha precisa ter ao menos 6 caracteres');

    $st = db()->prepare('SELECT id FROM users WHERE email = ?');
    $st->execute([$email]);
    if ($st->fetch()) err('E-mail já cadastrado', 409);

    $st = db()->prepare('INSERT INTO users(name,email,pass,role,avatar,layout,created_at)
                         VALUES(?,?,?,?,?,?,?)');
    $st->execute([
        $name, $email, password_hash($pass, PASSWORD_BCRYPT),
        'user', '🩺', '{}', now(),
    ]);
    $uid = (int)db()->lastInsertId();
    $st  = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$uid]);
    $u = $st->fetch();

    audit($u, 'register', $email);
    return array_merge(auth_public($u), auth_token_for($uid));
}

function auth_login(string $email, string $pass): array
{
    $email = strtolower(trim($email));
    $st = db()->prepare('SELECT * FROM users WHERE email = ?');
    $st->execute([$email]);
    $u = $st->fetch();
    if (!$u || !password_verify($pass, $u['pass'])) err('E-mail ou senha incorretos', 401);

    audit($u, 'login', $email);
    return array_merge(auth_public($u), auth_token_for((int)$u['id']));
}

function auth_forgot(string $email): array
{
    $email = strtolower(trim($email));
    $st = db()->prepare('SELECT id FROM users WHERE email = ?');
    $st->execute([$email]);
    $u = $st->fetch();
    // resposta idêntica exista ou não a conta (evita enumeração de usuários)
    $generic = ['message' => 'Se o e-mail existir, um token de redefinição foi emitido.'];
    if (!$u) return $generic;

    $tok = bin2hex(random_bytes(20));
    $st  = db()->prepare('INSERT INTO resets(token,email,expires_at) VALUES(?,?,?)');
    $st->execute([$tok, $email, now() + 3600]);

    // Em produção este token iria por e-mail. Em dev ele é devolvido para o fluxo funcionar.
    if (env('RESET_SHOW_TOKEN', '1') === '1') {
        $generic['reset_token'] = $tok;
        $generic['link'] = '/?reset=' . $tok;
    }
    return $generic;
}

function auth_reset(string $token, string $pass): array
{
    if (mb_strlen($pass) < 6) err('A senha precisa ter ao menos 6 caracteres');
    $st = db()->prepare('SELECT * FROM resets WHERE token = ? AND expires_at > ?');
    $st->execute([$token, now()]);
    $r = $st->fetch();
    if (!$r) err('Token inválido ou expirado', 400);

    $st = db()->prepare('UPDATE users SET pass = ? WHERE email = ?');
    $st->execute([password_hash($pass, PASSWORD_BCRYPT), $r['email']]);
    db()->prepare('DELETE FROM resets WHERE token = ?')->execute([$token]);
    db()->prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)')
        ->execute([$r['email']]);

    return ['message' => 'Senha redefinida. Faça login novamente.'];
}

function auth_profile_update(array $u, array $d): array
{
    $name   = trim((string)($d['name'] ?? $u['name']));
    $avatar = (string)($d['avatar'] ?? $u['avatar']);
    $layout = array_key_exists('layout', $d) ? jenc($d['layout']) : $u['layout'];

    if (mb_strlen($name) < 3) err('Nome muito curto');

    $sql = 'UPDATE users SET name = ?, avatar = ?, layout = ? WHERE id = ?';
    $args = [$name, mb_substr($avatar, 0, 8), $layout, (int)$u['id']];

    if (!empty($d['pass'])) {
        if (mb_strlen((string)$d['pass']) < 6) err('Nova senha muito curta');
        $sql = 'UPDATE users SET name = ?, avatar = ?, layout = ?, pass = ? WHERE id = ?';
        $args = [$name, mb_substr($avatar, 0, 8), $layout, password_hash((string)$d['pass'], PASSWORD_BCRYPT), (int)$u['id']];
    }
    $st = db()->prepare($sql);
    $st->execute($args);

    $st = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([(int)$u['id']]);
    $fresh = $st->fetch();
    audit($fresh, 'profile', (string)$u['id']);
    return auth_public($fresh);
}

/** RBAC: apenas o root promove/revoga administradores. A conta root é imune. */
function auth_set_role(array $actor, string $email, string $role): array
{
    if ($actor['role'] !== 'root') err('Somente o usuário root pode alterar papéis', 403);
    if (!in_array($role, ['root', 'admin', 'user'], true)) err('Papel inválido');

    $email = strtolower(trim($email));
    $st = db()->prepare('SELECT * FROM users WHERE email = ?');
    $st->execute([$email]);
    $target = $st->fetch();
    if (!$target) err('Usuário não encontrado', 404);
    if ($target['role'] === 'root') err('A conta root é imune a alterações de papel', 403);

    $st = db()->prepare('UPDATE users SET role = ? WHERE email = ?');
    $st->execute([$role, $email]);
    audit($actor, 'set_role', $email, ['role' => $role]);
    return ['email' => $email, 'role' => $role];
}

function auth_list_users(): array
{
    $rows = db()->query('SELECT id,name,email,role,avatar,created_at FROM users ORDER BY id')->fetchAll();
    foreach ($rows as &$r) $r['id'] = (int)$r['id'];
    return $rows;
}
