<?php
declare(strict_types=1);

/**
 * Cards de procedimento com fluxograma vetorial (SVG gerado no servidor).
 * O "spec" (título + passos) vem da IA; se a IA falhar usa-se o template XABCDE local.
 * Nada aqui depende de IA de imagem: o fluxograma é desenhado proceduralmente em SVG,
 * e o resumo prático (gerado a partir do CONTEXTO do fluxograma) é gravado na
 * biblioteca de cards do usuário.
 */

const FLOW_COLORS = [
    'inicio' => '#0d9488', 'avaliacao' => '#0284c7', 'conduta' => '#d97706',
    'alerta' => '#e11d48', 'reavaliacao' => '#7c3aed', 'default' => '#0f766e',
];

function flow_wrap(string $s, int $max): array
{
    $s = trim(preg_replace('/\s+/u', ' ', $s));
    if ($s === '') return [''];
    $words = preg_split('/\s+/u', $s) ?: []; $lines = []; $cur = '';
    foreach ($words as $w) {
        $try = $cur === '' ? $w : $cur . ' ' . $w;
        if (mb_strlen($try) > $max && $cur !== '') { $lines[] = $cur; $cur = $w; }
        else $cur = $try;
    }
    if ($cur !== '') $lines[] = $cur;
    return $lines ?: [''];
}

function flow_esc(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES | ENT_XML1, 'UTF-8');
}

function flow_fallback_spec(string $tema): array
{
    return [
        'title' => 'Abordagem — ' . ($tema !== '' ? $tema : 'Atendimento inicial'),
        'kind' => 'procedimento',
        'fonte' => 'Template XABCDE / protocolos do Ministério da Saúde',
        'steps' => [
            ['kind' => 'inicio',     'label' => 'X — Vias aéreas com controle de coluna',    'detail' => 'Verificar perviedade; aspirar ou intubar se necessário'],
            ['kind' => 'avaliacao',  'label' => 'A/B — Respiração e ventilação',             'detail' => 'FR, SatO2, ausculta; oxigênio conforme protocolo'],
            ['kind' => 'conduta',    'label' => 'C — Circulação e controle de hemorragias',  'detail' => '2 acessos venosos, cristaloide, monitorização contínua'],
            ['kind' => 'avaliacao',  'label' => 'D — Avaliação neurológica',                 'detail' => 'Escala de Glasgow, pupilas, glicemia capilar'],
            ['kind' => 'avaliacao',  'label' => 'E — Exposição e exame completo',            'detail' => 'Prevenir hipotermia; buscar lesões associadas'],
            ['kind' => 'conduta',    'label' => 'Conduta específica do tema',                'detail' => 'Seguir protocolo/diretriz vigente do Ministério da Saúde'],
            ['kind' => 'reavaliacao','label' => 'Reavaliação seriada e referência',          'detail' => 'Reavaliar sinais vitais; encaminhar se critério'],
        ],
    ];
}

/** Fluxograma vetorial: caixas arredondadas com gradiente, setas e numeração. */
function flow_svg(array $spec, string $title = ''): string
{
    $steps = array_slice((array)($spec['steps'] ?? []), 0, 10);
    if (!$steps) $steps = flow_fallback_spec('')['steps'];

    $W = 960; $padX = 40; $boxW = $W - $padX * 2;
    $titleText = (string)($spec['title'] ?? 'Fluxograma');
    $titleLines = flow_wrap($titleText, 62);
    $headH = 30 + count($titleLines) * 34 + 18;

    $boxH = 92; $gap = 26;
    $H = $headH + count($steps) * ($boxH + $gap) + 66;

    $svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' . $W . ' ' . $H . '" width="' . $W . '" height="' . $H . '" role="img" aria-label="' . flow_esc($titleText) . '">';
    $svg .= '<defs>';
    foreach (FLOW_COLORS as $k => $c) {
        $svg .= '<linearGradient id="g-' . $k . '" x1="0" y1="0" x2="1" y2="1">'
              . '<stop offset="0" stop-color="' . $c . '" stop-opacity="0.98"/>'
              . '<stop offset="1" stop-color="' . $c . '" stop-opacity="0.78"/></linearGradient>';
    }
    $svg .= '<linearGradient id="bgm" x1="0" y1="0" x2="1" y2="1">'
          . '<stop offset="0" stop-color="#ecfeff"/><stop offset="0.55" stop-color="#f0fdfa"/><stop offset="1" stop-color="#fffbeb"/></linearGradient>'
          . '<filter id="soft" x="-20%" y="-20%" width="140%" height="140%">'
          . '<feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#0f766e" flood-opacity="0.18"/></filter>'
          . '</defs>';

    $svg .= '<rect width="' . $W . '" height="' . $H . '" rx="26" fill="url(#bgm)"/>';
    $svg .= '<rect x="10" y="10" width="' . ($W - 20) . '" height="' . ($H - 20) . '" rx="20" fill="none" stroke="#99f6e4" stroke-width="2"/>';

    // cabeçalho
    $svg .= '<circle cx="34" cy="40" r="9" fill="#0d9488"/><circle cx="34" cy="40" r="3.6" fill="#ccfbf1"/>';
    $y = 58;
    foreach ($titleLines as $i => $line) {
        $svg .= '<text x="54" y="' . $y . '" font-family="ui-rounded,Segoe UI,system-ui,sans-serif" font-size="' . ($i === 0 ? 25 : 21) . '" font-weight="800" fill="#0f766e">' . flow_esc($line) . '</text>';
        $y += 32;
    }
    $svg .= '<text x="' . ($W - 34) . '" y="' . ($headH - 34) . '" text-anchor="end" font-family="ui-rounded,Segoe UI,sans-serif" font-size="12" font-weight="700" fill="#5b7d78">pratica.M3D · card de procedimento</text>';

    $cy = $headH;
    foreach ($steps as $i => $st) {
        $kind = (string)($st['kind'] ?? 'default');
        if (!isset(FLOW_COLORS[$kind])) $kind = 'default';
        $label = (string)($st['label'] ?? 'Passo ' . ($i + 1));
        $detail = (string)($st['detail'] ?? '');
        $x = $padX;

        $svg .= '<g filter="url(#soft)">';
        $svg .= '<rect x="' . $x . '" y="' . $cy . '" width="' . $boxW . '" height="' . $boxH . '" rx="18" fill="url(#g-' . $kind . ')"/>';
        $svg .= '<rect x="' . $x . '" y="' . $cy . '" width="6" height="' . $boxH . '" rx="3" fill="#ffffff" opacity="0.55"/>';
        $svg .= '</g>';

        // numeração
        $svg .= '<circle cx="' . ($x + 34) . '" cy="' . ($cy + 34) . '" r="16" fill="#ffffff" opacity="0.22"/>';
        $svg .= '<text x="' . ($x + 34) . '" y="' . ($cy + 40) . '" text-anchor="middle" font-family="ui-rounded,Segoe UI,sans-serif" font-size="16" font-weight="800" fill="#ffffff">' . ($i + 1) . '</text>';

        $lx = $x + 62; $ly = $cy + 30;
        foreach (flow_wrap($label, 58) as $line) {
            $svg .= '<text x="' . $lx . '" y="' . $ly . '" font-family="ui-rounded,Segoe UI,sans-serif" font-size="16.5" font-weight="800" fill="#ffffff">' . flow_esc($line) . '</text>';
            $ly += 21;
        }
        if ($detail !== '') {
            foreach (flow_wrap($detail, 78) as $line) {
                $svg .= '<text x="' . $lx . '" y="' . ($ly + 2) . '" font-family="ui-rounded,Segoe UI,sans-serif" font-size="12.5" fill="#ecfeff" opacity="0.96">' . flow_esc($line) . '</text>';
                $ly += 17;
            }
        }

        // seta
        if ($i < count($steps) - 1) {
            $ax = $W / 2; $ay1 = $cy + $boxH + 3; $ay2 = $cy + $boxH + $gap - 4;
            $svg .= '<line x1="' . $ax . '" y1="' . $ay1 . '" x2="' . $ax . '" y2="' . $ay2 . '" stroke="#0f766e" stroke-width="2.6" opacity="0.55"/>';
            $svg .= '<polygon points="' . ($ax - 6) . ',' . ($ay2 - 7) . ' ' . ($ax + 6) . ',' . ($ay2 - 7) . ' ' . $ax . ',' . $ay2 . '" fill="#0f766e" opacity="0.7"/>';
        }
        $cy += $boxH + $gap;
    }

    $svg .= '<text x="' . $W . '" y="' . ($H - 18) . '" text-anchor="end" font-family="ui-rounded,Segoe UI,sans-serif" font-size="11.5" fill="#5b7d78">'
          . flow_esc('Fonte: ' . (string)($spec['fonte'] ?? 'Diretrizes do Ministério da Saúde / protocolos vigentes')) . '</text>';
    $svg .= '</svg>';
    return $svg;
}

/* ---------------------------------------------------------------- biblioteca -- */

function flow_save_card(array $user, array $spec, string $summary, ?string $stationId, string $kind = 'procedimento'): array
{
    $id = 'card-' . rid(6);
    $svg = flow_svg($spec);
    $title = (string)($spec['title'] ?? 'Card de procedimento');
    $st = db()->prepare('INSERT INTO flowcards(id,user_id,station_id,tema,title,kind,summary,spec,svg,created_at)
                         VALUES(?,?,?,?,?,?,?,?,?,?)');
    $st->execute([
        $id, (int)$user['id'], $stationId, (string)($spec['tema'] ?? $title), $title,
        $kind, $summary, jenc($spec), $svg, now(),
    ]);
    audit($user, 'card_create', $id, ['kind' => $kind, 'station' => $stationId]);
    return ['id' => $id, 'title' => $title, 'kind' => $kind, 'summary' => $summary,
            'svg_url' => '/cards/' . $id . '.svg'];
}

function flow_get_card(int $uid, string $id): ?array
{
    $st = db()->prepare('SELECT * FROM flowcards WHERE id = ? AND user_id = ?');
    $st->execute([$id, $uid]);
    $c = $st->fetch();
    if (!$c) return null;
    $c['id'] = (string)$c['id'];
    $c['spec'] = jdec($c['spec']);
    $c['svg_url'] = '/cards/' . $c['id'] . '.svg';
    unset($c['svg']);
    return $c;
}

function flow_list_cards(int $uid, string $q = '', int $limit = 120): array
{
    $sql = 'SELECT id,station_id,tema,title,kind,summary,created_at FROM flowcards WHERE user_id = ?';
    $args = [$uid];
    if ($q !== '') { $sql .= ' AND (title LIKE ? OR tema LIKE ? OR summary LIKE ?)'; $args[] = "%$q%"; $args[] = "%$q%"; $args[] = "%$q%"; }
    $sql .= ' ORDER BY created_at DESC LIMIT ' . (int)$limit;
    $st = db()->prepare($sql);
    $st->execute($args);
    $rows = $st->fetchAll();
    foreach ($rows as &$r) { $r['svg_url'] = '/cards/' . $r['id'] . '.svg'; }
    return $rows;
}

function flow_card_svg(int $uid, string $id): ?string
{
    $st = db()->prepare('SELECT svg FROM flowcards WHERE id = ? AND user_id = ?');
    $st->execute([$id, $uid]);
    $s = $st->fetchColumn();
    return $s === false ? null : (string)$s;
}

function flow_delete_card(int $uid, string $id): bool
{
    $st = db()->prepare('DELETE FROM flowcards WHERE id = ? AND user_id = ?');
    $st->execute([$id, $uid]);
    return $st->rowCount() > 0;
}

/* --------------------------------------------------- resumo prático via IA ---- */

/**
 * Gera o resumo prático ponta a ponta a partir do CONTEXTO da estação
 * (tema, cenário, roteiro do ator, PEP e protocolo) e devolve
 * { spec (fluxograma), summary (card), provider }.
 */
function flow_ai_summary(array $station, array $pepMarks = []): array
{
    $tema = (string)($station['tema'] ?? '');
    $checklist = jdec($station['checklist'] ?? '[]');
    $pepLines = [];
    foreach ($checklist as $i => $c) $pepLines[] = ($i + 1) . '. ' . (string)($c['item'] ?? '');
    $pep = implode("\n", array_slice($pepLines, 0, 24));

    $prompt = <<<PR
Você é preceptor de OSCE/Revalida. Produza um RESUMO PRÁTICO de abordagem ponta a ponta
(da chegada do paciente até a resolução do caso) sobre o tema abaixo.

TEMA: {$tema}
ÁREA: {$station['area']}
ESPECIALIDADE: {$station['especialidade']}
PROTOCOLO/DIRETRIZ: {$station['protocolo']}
CENÁRIO: {$station['cenario']}
IDENTIFICAÇÃO DO CASO: {$station['instrucoes']}

PEP oficial (critérios avaliados):
{$pep}

Responda SOMENTE com um JSON válido, sem comentários, no formato:
{
  "title": "título curto do fluxograma (máx. 70 caracteres)",
  "fonte": "diretriz/protocolo citado (ex.: Ministério da Saúde, XABCDE, INEP)",
  "summary": "resumo prático em 3 a 6 frases, objetivas, do primeiro contato até a resolução",
  "steps": [
    {"kind": "inicio|avaliacao|conduta|alerta|reavaliacao", "label": "passo objetivo (máx. 90 caracteres)", "detail": "detalhe de execução (máx. 150 caracteres)"}
  ]
}
Gere de 6 a 9 passos, em ordem cronológica de atendimento, cobrindo anamnese, exame físico,
hipóteses, exames complementares, conduta imediata, tratamento e reavaliação/encaminhamento.
PR
    ;
    try {
        $r = ai_complete($prompt, 'flow_summary');
        $d = ai_extract_json($r['text']);
    } catch (Throwable $e) {
        $d = flow_fallback_spec($tema);
        $d['summary'] = 'Resumo indisponível no momento (' . mb_substr($e->getMessage(), 0, 120) . '). '
                      . 'Segue o fluxo XABCDE como abordagem inicial estruturada do tema ' . $tema . ', '
                      . 'com reavaliação seriada e definição de destino do paciente.';
        $d['_ai_error'] = $e->getMessage();
        return ['spec' => $d, 'summary' => $d['summary'], 'provider' => null, 'degraded' => true];
    }

    $steps = [];
    foreach ((array)($d['steps'] ?? []) as $s) {
        if (!is_array($s)) continue;
        $steps[] = ['kind' => (string)($s['kind'] ?? 'conduta'),
                    'label' => (string)($s['label'] ?? ''),
                    'detail' => (string)($s['detail'] ?? '')];
    }
    if (count($steps) < 3) $steps = flow_fallback_spec($tema)['steps'];

    $spec = [
        'title' => (string)($d['title'] ?? ('Abordagem — ' . $tema)),
        'tema' => $tema,
        'fonte' => (string)($d['fonte'] ?? 'Diretrizes do Ministério da Saúde / protocolos vigentes'),
        'steps' => $steps,
    ];
    $summary = (string)($d['summary'] ?? '');
    if ($summary === '') $summary = 'Abordagem ponta a ponta de ' . $tema . ' conforme os passos do fluxograma.';

    return ['spec' => $spec, 'summary' => $summary, 'provider' => $r['provider'], 'degraded' => false];
}
