<?php
declare(strict_types=1);

/** Roteador da API REST — autenticação, RBAC, catálogo, importação/exportação, KPIs. */

function api_dispatch(): void
{
    $path = (string)(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');
    $path = rtrim($path, '/') ?: '/';
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

    foreach (api_routes() as $r) {
        if ($r[0] !== $method) continue;
        if (preg_match($r[1], $path, $m)) {
            try { $r[2]($m); }
            catch (Throwable $e) { err('Erro interno: ' . $e->getMessage(), 500); }
            return;
        }
    }
    err('Rota não encontrada: ' . $method . ' ' . $path, 404);
}

function api_routes(): array
{
    return array_merge(routes_auth(), routes_stations(), routes_ai(), routes_room(), routes_study());
}

/* ------------------------------------------------------------------- auth ---- */

function routes_auth(): array
{
    return [
        ['POST', '#^/api/register$#', function () {
            $r = auth_register((string)param('name', ''), (string)param('email', ''), (string)param('pass', ''));
            json_out(array_merge(['ok' => true], $r));
        }],
        ['POST', '#^/api/login$#', function () {
            $r = auth_login((string)param('email', ''), (string)param('pass', ''));
            json_out(array_merge(['ok' => true], $r));
        }],
        ['POST', '#^/api/logout$#', function () {
            $u = auth_current();
            if ($u) {
                db()->prepare('DELETE FROM sessions WHERE token = ?')->execute([bearer()]);
                audit($u, 'logout', (string)$u['id']);
            }
            ok(['message' => 'Sessão encerrada']);
        }],
        ['POST', '#^/api/forgot$#', function () {
            ok(auth_forgot((string)param('email', '')));
        }],
        ['POST', '#^/api/reset$#', function () {
            ok(auth_reset((string)param('token', ''), (string)param('pass', '')));
        }],
        ['GET', '#^/api/me$#', function () {
            $u = auth_current();
            if (!$u) err('Não autenticado', 401);
            ok(['user' => auth_public($u)]);
        }],
        ['POST', '#^/api/profile$#', function () {
            $u = auth_require();
            ok(['user' => auth_profile_update($u, body())]);
        }],
        ['GET', '#^/api/admin/users$#', function () {
            auth_require(['root', 'admin']);
            ok(['users' => auth_list_users()]);
        }],
        ['POST', '#^/api/admin/set_role$#', function () {
            $u = auth_require();
            ok(auth_set_role($u, (string)param('email', ''), (string)param('role', 'user')));
        }],
        ['GET', '#^/api/admin/audit$#', function () {
            auth_require(['root', 'admin']);
            $st = db()->query('SELECT * FROM audit ORDER BY id DESC LIMIT 200');
            ok(['audit' => $st->fetchAll()]);
        }],
        ['GET', '#^/api/meta$#', function () {
            $stats = [];
            $st = db()->query('SELECT area, COUNT(*) n FROM stations GROUP BY area');
            foreach ($st->fetchAll() as $r) $stats['areas'][$r['area']] = (int)$r['n'];
            $stats['stations'] = (int)db()->query('SELECT COUNT(*) FROM stations')->fetchColumn();
            $stats['rooms'] = (int)db()->query('SELECT COUNT(*) FROM rooms')->fetchColumn();
            $stats['users'] = (int)db()->query('SELECT COUNT(*) FROM users')->fetchColumn();
            ok(['meta' => $stats, 'area_labels' => AREA_LABELS, 'area_colors' => AREA_COLORS]);
        }],
    ];
}

/* --------------------------------------------------------------- catálogo ---- */

function st_row(array $r, bool $full = true): array
{
    $out = [
        'id' => (string)$r['id'], 'tema' => $r['tema'], 'area' => $r['area'],
        'especialidade' => $r['especialidade'], 'nivel' => $r['nivel'],
        'duracao' => (int)$r['duracao'], 'fonte' => $r['fonte'],
        'frozen' => (int)$r['frozen'],
        'area_label' => AREA_LABELS[$r['area']] ?? $r['area'],
        'area_color' => AREA_COLORS[$r['area']] ?? '#0d9488',
    ];
    if ($full) {
        $out += [
            'instrucoes' => $r['instrucoes'], 'cenario' => $r['cenario'],
            'roteiro_ator' => $r['roteiro_ator'], 'protocolo' => $r['protocolo'],
            'exames' => jdec($r['exames']), 'checklist' => jdec($r['checklist']),
        ];
    }
    return $out;
}

function routes_stations(): array
{
    return [
        ['GET', '#^/api/stations$#', function () {
            $area = (string)($_GET['area'] ?? '');
            $q = trim((string)($_GET['q'] ?? ''));
            $nivel = trim((string)($_GET['nivel'] ?? ''));
            $limit = min(500, max(1, (int)($_GET['limit'] ?? 60)));
            $offset = max(0, (int)($_GET['offset'] ?? 0));

            $w = []; $a = [];
            if ($area !== '' && in_array($area, AREAS, true)) { $w[] = 'area = ?'; $a[] = $area; }
            if ($nivel !== '') { $w[] = 'nivel = ?'; $a[] = $nivel; }
            if ($q !== '') {
                $w[] = '(tema LIKE ? OR especialidade LIKE ? OR instrucoes LIKE ? OR fonte LIKE ?)';
                array_push($a, "%$q%", "%$q%", "%$q%", "%$q%");
            }
            $where = $w ? ' WHERE ' . implode(' AND ', $w) : '';
            $st = db()->prepare('SELECT COUNT(*) FROM stations' . $where);
            $st->execute($a);
            $total = (int)$st->fetchColumn();

            $st = db()->prepare('SELECT * FROM stations' . $where . ' ORDER BY area, tema LIMIT ' . $limit . ' OFFSET ' . $offset);
            $st->execute($a);
            $rows = array_map(fn($r) => st_row($r, false), $st->fetchAll());

            $byArea = [];
            foreach (db()->query('SELECT area, COUNT(*) n FROM stations GROUP BY area')->fetchAll() as $r) {
                $byArea[$r['area']] = (int)$r['n'];
            }
            ok(['stations' => $rows, 'total' => $total, 'by_area' => $byArea,
                'area_labels' => AREA_LABELS, 'area_colors' => AREA_COLORS]);
        }],

        ['GET', '#^/api/stations/export$#', function () {
            auth_require(['root', 'admin']);
            $ids = isset($_GET['ids']) && $_GET['ids'] !== '' ? array_filter(explode(',', (string)$_GET['ids'])) : null;
            $pkg = sio_export_package($ids ? array_values($ids) : null, (string)($_GET['area'] ?? '') ?: null);
            $name = 'pacote-estacoes-' . date('Ymd-His') . '.json';
            header('Content-Type: application/json; charset=utf-8');
            header('Content-Disposition: attachment; filename="' . $name . '"');
            echo jenc(['pacote' => 'pratica.M3D', 'versao' => 5, 'gerado_em' => date('c'), 'total' => count($pkg), 'estacoes' => $pkg]);
            exit;
        }],

        ['POST', '#^/api/stations/import$#', function () {
            $u = auth_require(['root', 'admin']);
            $overwrite = (string)param('overwrite', '0') === '1';
            $b = body();
            $rows = $b['rows'] ?? $b['stations'] ?? null;

            if ($rows === null && isset($b['pacote']['estacoes'])) $rows = $b['pacote']['estacoes'];
            if (!is_array($rows)) err('Envie {rows:[...]} (planilha convertida) ou {pacote:{estacoes:[...]}}');

            $res = sio_import($rows, $overwrite, $u, (string)param('source', 'upload'));
            ok(array_merge($res, ['message' => "{$res['created']} criadas, {$res['updated']} atualizadas, {$res['skipped']} ignoradas"]));
        }],

        ['POST', '#^/api/stations/sync$#', function () {
            $u = auth_require(['root', 'admin']);
            ok(sio_sync_workbook($u));
        }],

        ['GET', '#^/api/stations/([^/]+)$#', function ($m) {
            $st = db()->prepare('SELECT * FROM stations WHERE id = ?');
            $st->execute([$m[1]]);
            $r = $st->fetch();
            if (!$r) err('Estação não encontrada', 404);
            ok(['station' => st_row($r, true)]);
        }],

        ['POST', '#^/api/stations$#', function () {
            $u = auth_require(['root', 'admin']);
            $b = body();
            $norm = sio_normalize($b);
            if ($norm['tema'] === '') err('Informe o tema da estação');
            $res = sio_import([$norm], true, $u, 'manual');
            if ($res['created'] + $res['updated'] === 0) err('Não foi possível salvar (verifique tema/area)');
            $st = db()->prepare('SELECT * FROM stations WHERE id = ?');
            $st->execute([$norm['id']]);
            $row = $st->fetch();
            ok(['message' => 'Estação salva', 'id' => $norm['id'],
                'station' => $row ? st_row($row, true) : null, 'import' => $res]);
        }],

        ['PUT', '#^/api/stations/([^/]+)$#', function ($m) {
            $u = auth_require(['root', 'admin']);
            $b = body(); $b['id'] = $m[1];
            $res = sio_import([$b], true, $u, 'edicao');
            ok(array_merge($res, ['message' => 'Estação atualizada']));
        }],

        ['DELETE', '#^/api/stations/([^/]+)$#', function ($m) {
            $u = auth_require(['root', 'admin']);
            $st = db()->prepare('DELETE FROM stations WHERE id = ?');
            $st->execute([$m[1]]);
            if (!$st->rowCount()) err('Estação não encontrada', 404);
            audit($u, 'station_delete', $m[1]);
            ok(['message' => 'Estação removida']);
        }],
    ];
}

/* --------------------------------------------------------------------- KPIs --- */
