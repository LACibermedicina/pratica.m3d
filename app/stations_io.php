<?php
declare(strict_types=1);

/**
 * Importação XLSX/JSON e exportação de pacotes de estações.
 *
 * XLSX: lido no SERVIDOR por um leitor ZIP/XLSX em PHP puro (sem extensão zip),
 * procurando a aba "Estações" — cabeçalho flexível, case-insensitive, com aliases.
 * O frontend também aceita colar/arrastar a planilha (SheetJS) e envia as linhas em JSON.
 */

const SIO_FIELDS = ['id', 'tema', 'area', 'especialidade', 'nivel', 'duracao', 'fonte',
                    'instrucoes', 'cenario', 'roteiro_ator', 'protocolo', 'exames', 'checklist'];

function sio_aliases(): array
{
    return [
        'roteiroator' => 'roteiro_ator', 'roteiro' => 'roteiro_ator', 'roteiro do ator' => 'roteiro_ator',
        'tema/titulo' => 'tema', 'titulo' => 'tema', 'título' => 'tema',
        'grande area' => 'area', 'grande área' => 'area', 'área' => 'area', 'area medica' => 'area',
        'duração' => 'duracao', 'tempo' => 'duracao', 'nível' => 'nivel', 'nivel de complexidade' => 'nivel',
        'instruções' => 'instrucoes', 'instrucao' => 'instrucoes', 'cenário' => 'cenario',
        'especialidade médica' => 'especialidade', 'fonte/prova' => 'fonte', 'prova' => 'fonte',
        'protocolo/diretriz' => 'protocolo', 'exames complementares' => 'exames',
        'checklist/pep' => 'checklist', 'pep' => 'checklist', 'codigo' => 'id', 'código' => 'id',
    ];
}

function sio_norm_field(string $h): string
{
    $h = mb_strtolower(trim($h));
    foreach (['á' => 'a', 'à' => 'a', 'ã' => 'a', 'â' => 'a', 'é' => 'e', 'ê' => 'e', 'í' => 'i', 'ó' => 'o', 'ô' => 'o', 'õ' => 'o', 'ú' => 'u', 'ç' => 'c'] as $a => $b) {
        $h = str_replace($a, $b, $h);
    }
    $h = trim(preg_replace('/\s+/', ' ', $h));
    $alt = sio_aliases();
    if (isset($alt[$h])) return $alt[$h];
    $alt2 = [];
    foreach ($alt as $k => $v) $alt2[sio_norm_key($k)] = $v;
    $n = sio_norm_key($h);
    if (isset($alt2[$n])) return $alt2[$n];
    return in_array($n, SIO_FIELDS, true) ? $n : '';
}

function sio_norm_key(string $s): string
{
    $s = mb_strtolower($s);
    foreach (['á','à','ã','â','é','ê','í','ó','ô','õ','ú','ç','.','_','-',':','/'] as $c) $s = str_replace($c, '', $s);
    return preg_replace('/[^a-z0-9 ]/', '', $s) ?? '';
}

/* ------------------------------------------------------ leitor XLSX em PHP ---- */

function xlsx_zip_entries(string $path): array
{
    $d = (string)file_get_contents($path);
    $eocd = strrpos($d, "PK\x05\x06");
    if ($eocd === false) throw new RuntimeException('Arquivo ZIP/XLSX inválido');
    $count = unpack('v', substr($d, $eocd + 10, 2))[1];
    $cdOff = unpack('V', substr($d, $eocd + 16, 4))[1];
    $p = $cdOff;
    $out = [];
    for ($i = 0; $i < $count; $i++) {
        if (substr($d, $p, 4) !== "PK\x01\x02") break;
        $method = unpack('v', substr($d, $p + 10, 2))[1];
        $csize  = unpack('V', substr($d, $p + 20, 4))[1];
        $nlen   = unpack('v', substr($d, $p + 28, 2))[1];
        $elen   = unpack('v', substr($d, $p + 30, 2))[1];
        $clen   = unpack('v', substr($d, $p + 32, 2))[1];
        $lho    = unpack('V', substr($d, $p + 42, 4))[1];
        $name   = substr($d, $p + 46, $nlen);
        $lnlen  = unpack('v', substr($d, $lho + 26, 2))[1];
        $lelen  = unpack('v', substr($d, $lho + 28, 2))[1];
        $start  = $lho + 30 + $lnlen + $lelen;
        $raw    = substr($d, $start, $csize);
        $out[$name] = $method === 8 ? (@gzinflate($raw) ?: '') : $raw;
        $p += 46 + $nlen + $elen + $clen;
    }
    return $out;
}

function xlsx_shared_strings(string $xml): array
{
    if ($xml === '') return [];
    $out = [];
    if (preg_match_all('/<si>(.*?)<\/si>/s', $xml, $m)) {
        foreach ($m[1] as $si) {
            preg_match_all('/<t[^>]*>(.*?)<\/t>/s', $si, $t);
            $txt = '';
            foreach ($t[1] as $piece) $txt .= html_entity_decode($piece, ENT_QUOTES | ENT_XML1, 'UTF-8');
            $out[] = $txt;
        }
    }
    return $out;
}

function xlsx_col_letters(string $ref): string
{
    preg_match('/^([A-Z]+)/', $ref, $m);
    return $m[1] ?? '';
}

function xlsx_sheet_rows(string $sheetXml, array $shared): array
{
    $rows = [];
    if (!preg_match_all('/<row[^>]*>(.*?)<\/row>/s', $sheetXml, $rm)) return $rows;
    foreach ($rm[1] as $rowXml) {
        $cells = [];
        if (preg_match_all('/<c\s([^>]*)\/>|<c\s([^>]*)>(.*?)<\/c>/s', $rowXml, $cm, PREG_SET_ORDER)) {
            foreach ($cm as $c) {
                $attrs = $c[1] !== '' ? $c[1] : ($c[2] ?? '');
                $inner = $c[3] ?? '';
                preg_match('/r="([A-Z]+)\d+"/', $attrs, $rm2);
                $col = $rm2[1] ?? '';
                preg_match('/t="([^"]+)"/', $attrs, $tm);
                $type = $tm[1] ?? '';
                $val = '';
                if ($type === 's') {
                    preg_match('/<v>(.*?)<\/v>/s', $inner, $vm);
                    $val = $shared[(int)($vm[1] ?? 0)] ?? '';
                } elseif ($type === 'inlineStr') {
                    preg_match_all('/<t[^>]*>(.*?)<\/t>/s', $inner, $tm2);
                    $val = html_entity_decode(implode('', $tm2[1]), ENT_QUOTES | ENT_XML1, 'UTF-8');
                } else {
                    preg_match('/<v>(.*?)<\/v>/s', $inner, $vm);
                    $val = html_entity_decode((string)($vm[1] ?? ''), ENT_QUOTES | ENT_XML1, 'UTF-8');
                }
                if ($col !== '') $cells[$col] = trim($val);
            }
        }
        if ($cells) $rows[] = $cells;
    }
    return $rows;
}

/** Extrai as linhas de dados da aba "Estações" (ou da 1ª aba) do XLSX. */
function xlsx_stations_rows(string $path): array
{
    $zip = xlsx_zip_entries($path);
    if (!isset($zip['xl/workbook.xml'])) throw new RuntimeException('XLSX sem workbook.xml');

    $shared = xlsx_shared_strings($zip['xl/sharedStrings.xml'] ?? '');

    // nome → arquivo da planilha
    $sheetFile = null;
    if (preg_match_all('/<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/', $zip['xl/workbook.xml'], $sm, PREG_SET_ORDER)) {
        $rels = $zip['xl/_rels/workbook.xml.rels'] ?? '';
        $map = [];
        if (preg_match_all('/Id="(rId\d+)"[^>]*Target="([^"]+)"/', $rels, $rmap, PREG_SET_ORDER)) {
            foreach ($rmap as $r) $map[$r[1]] = ltrim(str_replace('worksheets/', 'xl/worksheets/', $r[2]), '/');
        }
        foreach ($sm as $s) {                              // prioriza a aba "Estações"
            $name = sio_norm_key($s[1]);
            if (strpos($name, 'estac') !== false) { $sheetFile = $map[$s[2]] ?? null; break; }
        }
        if (!$sheetFile) $sheetFile = $map[$sm[0][2]] ?? null;
    }
    if (!$sheetFile || !isset($zip[$sheetFile])) {
        foreach (array_keys($zip) as $k) {
            if (strpos($k, 'xl/worksheets/sheet') === 0) { $sheetFile = $k; break; }
        }
    }
    if (!$sheetFile) throw new RuntimeException('Nenhuma planilha encontrada no XLSX');

    $raw = xlsx_sheet_rows($zip[$sheetFile], $shared);
    if (!$raw) return [];

    // cabeçalho: primeira linha com ≥3 campos reconhecidos
    $header = [];
    $startAt = 0;
    foreach ($raw as $idx => $row) {
        $cand = [];
        foreach ($row as $col => $val) {
            $f = sio_norm_field($val);
            if ($f !== '') $cand[$col] = $f;
        }
        if (count($cand) >= 3) { $header = $cand; $startAt = $idx + 1; break; }
    }

    $out = [];
    foreach (array_slice($raw, $startAt) as $row) {
        $obj = [];
        foreach ($header as $col => $field) {
            if (isset($row[$col])) $obj[$field] = $row[$col];
        }
        if (!empty($obj['tema'])) $out[] = $obj;
    }
    return $out;
}

/* ------------------------------------------------------------- normalização -- */

function sio_normalize(array $s): array
{
    $n = [];
    foreach ($s as $k => $v) {
        $f = sio_norm_field((string)$k);
        $n[$f !== '' ? $f : $k] = $v;
    }
    $area = strtoupper(trim((string)($n['area'] ?? 'CM')));
    foreach (AREAS as $a) {
        if (strpos($area, $a) === 0) { $area = $a; break; }
    }
    if (!in_array($area, AREAS, true)) {
        $map = ['CLINICA MEDICA' => 'CM', 'CIRURGIA' => 'CIR', 'GINECOLOGIA' => 'GO', 'OBSTETRICIA' => 'GO', 'PEDIATRIA' => 'PED', 'FAMILIA' => 'MFC'];
        $area = 'CM';
        foreach ($map as $needle => $tag) {
            if (strpos(sio_norm_key((string)($n['area'] ?? '') . ' ' . (string)($n['especialidade'] ?? '')), strtolower($needle)) !== false) { $area = $tag; break; }
        }
    }
    $dur = (int)preg_replace('/\D+/', '', (string)($n['duracao'] ?? '10'));
    if ($dur <= 0) $dur = 10;

    $tema = trim((string)($n['tema'] ?? ''));
    $id = trim((string)($n['id'] ?? ''));
    if ($id === '' && $tema !== '') $id = 'imp-' . substr(sha1($tema), 0, 10);

    return [
        'id' => $id,
        'tema' => $tema,
        'area' => $area,
        'especialidade' => trim((string)($n['especialidade'] ?? '')),
        'nivel' => (string)($n['nivel'] ?? 'intermediário') ?: 'intermediário',
        'duracao' => $dur,
        'fonte' => trim((string)($n['fonte'] ?? '')),
        'instrucoes' => (string)($n['instrucoes'] ?? ''),
        'cenario' => (string)($n['cenario'] ?? ''),
        'roteiro_ator' => (string)($n['roteiro_ator'] ?? ''),
        'protocolo' => (string)($n['protocolo'] ?? ''),
        'exames' => sio_list($n['exames'] ?? []),
        'checklist' => sio_checklist($n['checklist'] ?? []),
    ];
}

function sio_list($v): array
{
    if (is_array($v)) return array_values($v);
    $s = trim((string)$v);
    if ($s === '') return [];
    if ($s[0] === '[' || $s[0] === '{') {
        $d = json_decode($s, true);
        if (is_array($d)) return array_values($d);
    }
    return array_values(array_filter(array_map('trim', preg_split('/\s*[;|]\s*/', $s) ?: [])));
}

function sio_checklist($v): array
{
    if (is_array($v)) {
        $out = [];
        foreach ($v as $i => $item) {
            if (is_array($item)) {
                $out[] = ['item' => (string)($item['item'] ?? $item['label'] ?? ('Item ' . ($i + 1))),
                          'peso' => (float)($item['peso'] ?? $item['weight'] ?? 1)];
            } else {
                $out[] = ['item' => (string)$item, 'peso' => 1.0];
            }
        }
        return $out;
    }
    $parts = sio_list($v);
    return array_map(fn($p) => ['item' => (string)$p, 'peso' => 1.0], $parts);
}

/* -------------------------------------------------------------- upsert --------- */

function sio_import(array $rows, bool $overwrite, array $actor, string $source = 'upload'): array
{
    $pdo = db();
    $created = 0; $updated = 0; $skipped = 0; $errors = [];
    $find = $pdo->prepare('SELECT id FROM stations WHERE id = ?');

    foreach ($rows as $i => $raw) {
        if (!is_array($raw)) { $skipped++; continue; }
        $s = sio_normalize($raw);
        if ($s['tema'] === '') { $skipped++; continue; }

        $find->execute([$s['id']]);
        $exists = $find->fetch();

        if ($exists && !$overwrite) {
            // deduplica com sufixo automático
            $base = $s['id']; $n = 2;
            do {
                $s['id'] = $base . '-' . $n; $n++;
                $find->execute([$s['id']]);
                $exists = $find->fetch();
            } while ($exists && $n < 200);
            $exists = false;
        }

        try {
            if ($exists) {
                $st = $pdo->prepare('UPDATE stations SET tema=?,area=?,especialidade=?,nivel=?,duracao=?,fonte=?,
                    instrucoes=?,cenario=?,roteiro_ator=?,protocolo=?,exames=?,checklist=?,updated_at=? WHERE id=?');
                $st->execute([$s['tema'], $s['area'], $s['especialidade'], $s['nivel'], $s['duracao'], $s['fonte'],
                    $s['instrucoes'], $s['cenario'], $s['roteiro_ator'], $s['protocolo'],
                    jenc($s['exames']), jenc($s['checklist']), now(), $s['id']]);
                $updated++;
            } else {
                $st = $pdo->prepare('INSERT INTO stations(id,tema,area,especialidade,nivel,duracao,fonte,
                    instrucoes,cenario,roteiro_ator,protocolo,exames,checklist,frozen,created_by,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)');
                $st->execute([$s['id'], $s['tema'], $s['area'], $s['especialidade'], $s['nivel'], $s['duracao'], $s['fonte'],
                    $s['instrucoes'], $s['cenario'], $s['roteiro_ator'], $s['protocolo'], jenc($s['exames']), jenc($s['checklist']),
                    (string)($actor['name'] ?? $source), now(), now()]);
                $created++;
            }
        } catch (Throwable $e) {
            $skipped++;
            $errors[] = 'linha ' . ($i + 1) . ': ' . $e->getMessage();
            if (count($errors) > 12) break;
        }
    }
    audit($actor, 'import', $source, ['criadas' => $created, 'atualizadas' => $updated, 'ignoradas' => $skipped]);
    return ['created' => $created, 'updated' => $updated, 'skipped' => $skipped,
            'total' => count($rows), 'errors' => array_slice($errors, 0, 12)];
}

/** Exporta pacote (todas ou por ids) no formato aceito por /api/stations/import. */
function sio_export_package(?array $ids = null, ?string $area = null): array
{
    $sql = 'SELECT * FROM stations'; $args = []; $w = [];
    if ($ids) { $w[] = 'id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')'; $args = array_merge($args, $ids); }
    if ($area && in_array($area, AREAS, true)) { $w[] = 'area = ?'; $args[] = $area; }
    if ($w) $sql .= ' WHERE ' . implode(' AND ', $w);
    $sql .= ' ORDER BY area, tema';

    $st = db()->prepare($sql);
    $st->execute($args);
    $out = [];
    foreach ($st->fetchAll() as $r) {
        $out[] = [
            'id' => $r['id'], 'tema' => $r['tema'], 'area' => $r['area'],
            'especialidade' => $r['especialidade'], 'nivel' => $r['nivel'], 'duracao' => (int)$r['duracao'],
            'fonte' => $r['fonte'], 'instrucoes' => $r['instrucoes'], 'cenario' => $r['cenario'],
            'roteiroAtor' => $r['roteiro_ator'], 'protocolo' => $r['protocolo'],
            'exames' => jdec($r['exames']), 'checklist' => jdec($r['checklist']),
        ];
    }
    return $out;
}

/** Sincroniza a planilha data/estacoes.xlsx para a base (idempotente, sem sobrescrever). */
function sio_sync_workbook(array $actor): array
{
    $file = DATA_DIR . '/estacoes.xlsx';
    if (!is_file($file)) return ['created' => 0, 'updated' => 0, 'skipped' => 0, 'total' => 0, 'errors' => ['planilha ausente']];
    return sio_import(xlsx_stations_rows($file), false, $actor, 'estacoes.xlsx');
}
