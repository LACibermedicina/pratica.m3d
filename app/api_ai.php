<?php
declare(strict_types=1);

/** Rotas de IA (proxy seguro: as chaves vivem apenas no servidor) + cards de procedimento. */

function routes_ai(): array
{
    return [
        /* ------------------------------------------------ diagnóstico ao vivo --- */
        ['GET', '#^/api/ai/status$#', function () {
            auth_require(['root', 'admin']);
            ok(['providers' => ai_status(), 'chain' => array_keys(ai_providers())]);
        }],

        ['GET', '#^/api/ai/logs$#', function () {
            auth_require(['root', 'admin']);
            $logs = db()->query('SELECT * FROM ai_calls ORDER BY id DESC LIMIT 120')->fetchAll();
            $sum  = db()->query('SELECT provider, COUNT(*) n, SUM(ok) oks, ROUND(AVG(latency_ms)) avg_ms
                                 FROM ai_calls GROUP BY provider')->fetchAll();
            ok(['logs' => $logs, 'summary' => $sum]);
        }],

        /* ------------------------------------------- geração de estação por IA --- */
        ['POST', '#^/api/ai/generate_station$#', function () {
            $u = auth_require(['root', 'admin']);
            $tema  = trim((string)param('tema', ''));
            $area  = strtoupper((string)param('area', 'CM'));
            $nivel = (string)param('nivel', 'intermediário');
            if ($tema === '') err('Informe o tema da estação');
            if (!in_array($area, AREAS, true)) $area = 'CM';

            $prompt = <<<PR
Você é banca de OSCE do Revalida/INEP. Crie UMA estação de simulação sobre o tema abaixo,
seguindo diretrizes do INEP, do SUS, do Ministério da Saúde (protocolos XABCDE quando aplicável),
do atendimento ao recém-nascido e das curvas da OMS quando pertinente.
Tema: {$tema}
Grande área: {$area} ({$area})
Nível: {$nivel}

Responda SOMENTE com JSON válido (sem comentários):
{
 "tema": "título objetivo da estação (máx. 110 caracteres)",
 "area": "{$area}",
 "especialidade": "especialidade médica",
 "nivel": "{$nivel}",
 "duracao": 10,
 "fonte": "diretriz principal utilizada",
 "instrucoes": "instruções entregues ao candidato (o que ele deve conduzir, em até 5 frases)",
 "cenario": "descrição do cenário/encontro para o ator e o avaliador",
 "roteiroAtor": "roteiro do ator: como responder às perguntas do candidato, achados que só aparecem se investigados",
 "protocolo": "protocolo/diretriz aplicável com pontos-chave",
 "exames": ["lista de exames complementares liberáveis ao candidato, com laudo resumido"],
 "checklist": [{"item":"critério observável do PEP","peso":2}]
}
Gere 8 a 12 itens de checklist acionáveis (peso 1 a 3) cobrindo segurança do paciente,
anamnese, exame físico, hipóteses, exames, conduta e reavaliação/orientação.
PR;

            try {
                $r = ai_complete($prompt, 'generate_station');
                $d = ai_extract_json($r['text']);
            } catch (Throwable $e) {
                err('Falha em toda a cadeia de IA: ' . $e->getMessage(), 502,
                    ['chain' => array_keys(ai_providers()),
                     'hint' => 'Configure GEMINI_API_KEY ou OPENAI_API_KEY no .env — Pollinations é o último recurso e pode estar indisponível.']);
            }

            $d['tema'] = (string)($d['tema'] ?? $tema);
            $d['area'] = (string)($d['area'] ?? $area);
            $d['id'] = 'ai-' . substr(sha1($d['tema'] . microtime()), 0, 10);
            $res = sio_import([$d], false, $u, 'ia');

            ok(['message' => 'Estação criada por IA', 'provider' => $r['provider'],
                'station_id' => $d['id'], 'station' => $d, 'import' => $res]);
        }],

        /* ------------------------------------------------- paciente simulado --- */
        ['POST', '#^/api/ai/patient$#', function () {
            auth_require();
            $st = db()->prepare('SELECT * FROM stations WHERE id = ?');
            $st->execute([(string)param('station_id', '')]);
            $s = $st->fetch();
            if (!$s) err('Estação não encontrada', 404);

            $hist = (array)param('history', []);
            $convo = '';
            foreach (array_slice($hist, -14) as $h) {
                $convo .= (($h['from'] ?? 'candidato') === 'paciente' ? 'PACIENTE: ' : 'CANDIDATO: ')
                        . mb_substr((string)($h['text'] ?? ''), 0, 400) . "\n";
            }
            $q = (string)param('question', '');

            $prompt = <<<PR
Você é o PACIENTE SIMULADO da estação "{$s['tema']}". Interprete o roteiro do ator literalmente.
REGRA ABSOLUTA: responda EXCLUSIVAMENTE o que for perguntado; não ofereça diagnóstico,
não sugira conduta, não antecipe informação que o candidato não investigou, e se ele não
perguntar, não fale. Frases curtas, tom leigo, no máximo 3 frases. Quando algo não constar
do roteiro, diga que não sabe ou que "sempre foi assim".

CENÁRIO: {$s['cenario']}
ROTEIRO DO ATOR: {$s['roteiro_ator']}

HISTÓRICO DA CONVERSA:
{$convo}
CANDIDATO DIZ: {$q}

Responda apenas com a fala do paciente.
PR;

            try {
                $r = ai_complete($prompt, 'patient');
                ok(['answer' => trim($r['text']), 'provider' => $r['provider']]);
            } catch (Throwable $e) {
                ok(['answer' => 'Desculpe, não entendi a pergunta. Pode repetir, doutor(a)?',
                    'provider' => null, 'degraded' => true, 'error' => $e->getMessage()]);
            }
        }],

        /* -------------------------------------------- correção automática PEP --- */
        ['POST', '#^/api/ai/correct_pep$#', function () {
            $u = auth_require();
            $st = db()->prepare('SELECT * FROM stations WHERE id = ?');
            $st->execute([(string)param('station_id', '')]);
            $s = $st->fetch();
            if (!$s) err('Estação não encontrada', 404);

            $transcript = mb_substr((string)param('transcript', ''), 0, 12000);
            if (trim($transcript) === '') err('Transcrição vazia — grave ou cole o diálogo');

            $items = jdec($s['checklist']);
            $list = '';
            foreach ($items as $i => $c) $list .= ($i + 1) . '. ' . ($c['item'] ?? '') . ' (peso ' . ($c['peso'] ?? 1) . ")\n";

            $prompt = <<<PR
Você corrige PEP de OSCE item a item, com rigor de banca. Para CADA critério, valide se a
citação ocorre NO CONTEXTO correto; se não houver evidência, marque como não cumprido.

TEMA: {$s['tema']}
PROTOCOLO: {$s['protocolo']}

CRITÉRIOS:
{$list}

TRANSCRIÇÃO:
{$transcript}

Responda SOMENTE com JSON válido:
{"items":[{"idx":1,"cumprido":true,"citacao":"trecho literal","justificativa":"por que cumpre ou não"}],
 "comentario_geral":"2 a 4 frases de devolutiva"}
PR;

            $r = ai_complete($prompt, 'correct_pep');
            $d = ai_extract_json($r['text']);
            $got = [];
            foreach ((array)($d['items'] ?? []) as $it) $got[(int)($it['idx'] ?? 0)] = $it;

            $totalPeso = 0.0; $ganho = 0.0; $marks = []; $detail = [];
            foreach ($items as $i => $c) {
                $idx = $i + 1;
                $peso = (float)($c['peso'] ?? 1);
                $it = $got[$idx] ?? null;
                $hit = (bool)($it['cumprido'] ?? false);
                $totalPeso += $peso;
                if ($hit) $ganho += $peso;
                $marks[(string)$idx] = $hit ? 1 : 0;
                $detail[] = ['idx' => $idx, 'item' => $c['item'] ?? '', 'peso' => $peso,
                             'cumprido' => $hit, 'citacao' => (string)($it['citacao'] ?? ''),
                             'justificativa' => (string)($it['justificativa'] ?? '')];
            }
            $score = $totalPeso > 0 ? round($ganho / $totalPeso * 100, 1) : 0.0;

            $stc = db()->prepare('INSERT INTO pep_results(room_code,station_id,user_id,user_name,marks,score,transcript,notes,created_at)
                                  VALUES(?,?,?,?,?,?,?,?,?)');
            $stc->execute([(string)param('room_code', ''), $s['id'], (int)$u['id'], $u['name'],
                           jenc($marks), $score, $transcript, jenc($detail), now()]);
            $rid = (int)db()->lastInsertId();

            evt((string)param('room_code', ''), 'pep:result', ['station_id' => $s['id'], 'score' => $score, 'user' => $u['name'], 'result_id' => $rid]);
            ok(['provider' => $r['provider'], 'result_id' => $rid, 'score' => $score,
                'detail' => $detail, 'comentario' => (string)($d['comentario_geral'] ?? '')]);
        }],

        /* ------------------------------------------------- coach de desempenho --- */
        ['POST', '#^/api/ai/coach$#', function () {
            $u = auth_require();
            $st = db()->prepare('SELECT r.*, s.tema, s.area FROM pep_results r LEFT JOIN stations s ON s.id = r.station_id
                                 WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 30');
            $st->execute([(int)$u['id']]);
            $rows = $st->fetchAll();

            $hist = '';
            $soma = 0.0; $n = 0;
            foreach ($rows as $r) { $soma += (float)$r['score']; $n++; $hist .= "- {$r['tema']} ({$r['area']}): {$r['score']}%\n"; }
            $media = $n ? round($soma / $n, 1) : 0;

            if (!$n) ok(['coach' => 'Ainda não há treinos registrados. Faça uma estação para o coach analisar seu desempenho.',
                         'media' => 0, 'treinos' => 0]);

            $prompt = <<<PR
Você é coach de preparação para Revalida/OSCE. Analise o histórico e devolva um diagnóstico
direto em markdown curto com: Pontos fortes, Lacunas de conhecimento, Plano de estudo de 7 dias.
Sem introdução, sem repetir os dados.

Aluno: {$u['name']}
Média: {$media}% em {$n} estações
Histórico:
{$hist}
PR;
            try {
                $r = ai_complete($prompt, 'coach');
                ok(['coach' => trim($r['text']), 'provider' => $r['provider'], 'media' => $media, 'treinos' => $n]);
            } catch (Throwable $e) {
                $pior = $rows[0];
                foreach ($rows as $x) if ((float)$x['score'] < (float)$pior['score']) $pior = $x;
                ok(['coach' => "Média de {$media}% em {$n} estações.\n\n- Maior lacuna: {$pior['tema']} ({$pior['score']}%)\n"
                    . "- Priorize revisão do PEP dessas estações e refaça-as no modo estudo.\n"
                    . "- Plano de 7 dias: 2 estações novas por dia + revisão dos cards vencidos.\n\n"
                    . "_(Análise local — provedores de IA indisponíveis no momento.)_",
                    'provider' => null, 'degraded' => true, 'media' => $media, 'treinos' => $n]);
            }
        }],

        /* --------------------------------------------------- pergunta livre ------ */
        ['POST', '#^/api/ai/ask$#', function () {
            $u = auth_require();
            $q = trim((string)param('q', ''));
            if ($q === '') err('Pergunta vazia');
            $ctx = mb_substr((string)param('context', ''), 0, 4000);
            $prompt = "Contexto do treino OSCE:\n{$ctx}\n\nPergunta do observador/candidato: {$q}\n\n"
                    . 'Responda de forma prática e objetiva, com referência à diretriz quando houver.';
            try {
                $r = ai_complete($prompt, 'ask');
                ok(['answer' => trim($r['text']), 'provider' => $r['provider']]);
            } catch (Throwable $e) {
                err('IA indisponível: ' . $e->getMessage(), 502);
            }
        }],

        /* ------------------------------- CARD DE PROCEDIMENTO (fluxograma) ------- */
        ['POST', '#^/api/flowcards$#', function () {
            $u = auth_require();
            $sid = (string)param('station_id', '');
            $st  = db()->prepare('SELECT * FROM stations WHERE id = ?');
            $st->execute([$sid]);
            $s = $st->fetch();
            if (!$s) err('Estação não encontrada', 404);

            $r = flow_ai_summary($s, (array)param('marks', []));
            $card = flow_save_card($u, $r['spec'], $r['summary'], $sid, (string)param('kind', 'procedimento'));

            ok(['card' => $card, 'provider' => $r['provider'], 'degraded' => $r['degraded'],
                'summary' => $r['summary'], 'steps' => $r['spec']['steps'],
                'title' => $r['spec']['title'], 'fonte' => $r['spec']['fonte']]);
        }],

        ['GET', '#^/api/flowcards$#', function () {
            $u = auth_require();
            ok(['cards' => flow_list_cards((int)$u['id'], trim((string)($_GET['q'] ?? '')))]);
        }],

        ['GET', '#^/api/flowcards/([^/]+)$#', function ($m) {
            $u = auth_require();
            $c = flow_get_card((int)$u['id'], $m[1]);
            if (!$c) err('Card não encontrado', 404);
            ok(['card' => $c]);
        }],

        ['DELETE', '#^/api/flowcards/([^/]+)$#', function ($m) {
            $u = auth_require();
            if (!flow_delete_card((int)$u['id'], $m[1])) err('Card não encontrado', 404);
            ok(['message' => 'Card removido da biblioteca']);
        }],
    ];
}
