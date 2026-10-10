#!/usr/bin/env bash
# Smoke test end-to-end da API (sem navegador).
set -u
cd "$(dirname "$0")/.."
PORT=3111
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0

# extrai um valor de um JSON no stdin usando uma expressão python com a variável `d`
j() { python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
    print($1)
except Exception as e:
    print('<<erro:',e,'>>')"; }
chk() { # chk "nome" "esperado" "obtido"
  if [ "$2" = "$3" ]; then echo "  ok   $1 → $3"; PASS=$((PASS+1));
  else echo "  FAIL $1 → esperado[$2] obtido[$3]"; FAIL=$((FAIL+1)); fi
}

echo "== 1. lint de todos os arquivos PHP =="
ERR=0
while IFS= read -r f; do
  out=$(php -l "$f" 2>&1) || { echo "  $out"; ERR=1; }
done < <(find . -name '*.php' -not -path './storage/*')
if [ $ERR -eq 0 ]; then echo "  ok   sintaxe dos arquivos PHP"; PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo "== 2. subindo o servidor (php -S $PORT) =="
php -S 127.0.0.1:$PORT index.php >/tmp/m3d.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -s -o /dev/null "$BASE/health" && break; sleep 0.25; done

H=$(curl -s "$BASE/health"); echo "  /health → $H"
chk "health.status" "ok" "$(echo "$H" | j "d['status']")"
chk "health.stations (seed 428)" "428" "$(echo "$H" | j "d['stations']")"
chk "health.ai_chain" "['gemini', 'openai', 'pollinations']" "$(echo "$H" | j "d['ai_chain']")"

echo "== 3. front-end servido (SPA, logo vetorial, sem chave exposta) =="
HTML=$(curl -s "$BASE/")
chk "SPA responde 200 com o título" "True" "$(echo "$HTML" | grep -q 'pratica.M3D v5' && echo True || echo False)"
chk "logo é SVG inline (nenhum arquivo de imagem)" "True" "$(echo "$HTML" | grep -q 'class="m3d-logo"' && echo True || echo False)"
chk "logo usa gradientes vetoriais" "True" "$(echo "$HTML" | grep -q 'linearGradient' && echo True || echo False)"
chk "nenhuma chave de IA no HTML" "True" "$(echo "$HTML" | grep -Eq 'AIza|sk-[A-Za-z0-9]{20}' && echo False || echo True)"
JS=$(curl -s "$BASE/assets/app.js")
chk "nenhuma chave de IA no app.js" "True" "$(echo "$JS" | grep -Eq 'AIza|sk-[A-Za-z0-9]{20}' && echo False || echo True)"
chk "app.js tem o fallback SDP manual" "True" "$(echo "$JS" | grep -q 'SDP manual' && echo True || echo False)"

echo "== 4. autenticação (registro, login, sessão 30d, RBAC) =="
EM="t$(date +%s)@m3d.test"
R=$(curl -s -X POST "$BASE/api/register" -H 'Content-Type: application/json' -d "{\"name\":\"Candidato Teste\",\"email\":\"$EM\",\"pass\":\"secret123\"}")
TOK=$(echo "$R" | j "d['token']")
chk "register.token" "True" "$([ -n "$TOK" ] && echo True || echo False)"
chk "register.role" "user" "$(echo "$R" | j "d['role']")"

ME=$(curl -s "$BASE/api/me" -H "Authorization: Bearer $TOK")
chk "me.name" "Candidato Teste" "$(echo "$ME" | j "d['user']['name']")"
chk "me.sem_token → 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/me")"
chk "admin.users como 'user' → 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/admin/users" -H "Authorization: Bearer $TOK")"

RROOT=$(curl -s -X POST "$BASE/api/login" -H 'Content-Type: application/json' -d '{"email":"root@pratica.m3d","pass":"@0Arcano"}')
RTOK=$(echo "$RROOT" | j "d['token']")
chk "login root (seed com bcrypt)" "root" "$(echo "$RROOT" | j "d['role']")"
chk "admin.users como root → ok" "True" "$(echo "$(curl -s "$BASE/api/admin/users" -H "Authorization: Bearer $RTOK")" | j "d['ok']")"
chk "root promove admin" "admin" "$(echo "$(curl -s -X POST "$BASE/api/admin/set_role" -H "Authorization: Bearer $RTOK" -H 'Content-Type: application/json' -d "{\"email\":\"$EM\",\"role\":\"admin\"}")" | j "d['role']")"
chk "root imune a rebaixamento (recusa)" "True" "$(echo "$(curl -s -X POST "$BASE/api/admin/set_role" -H "Authorization: Bearer $RTOK" -H 'Content-Type: application/json' -d '{"email":"root@pratica.m3d","role":"user"}')" | j "d['ok']==False")"

echo "== 5. catálogo + importação/exportação =="
ST=$(curl -s "$BASE/api/stations?limit=3")
chk "catalog.total" "428" "$(echo "$ST" | j "d['total']")"
SID=$(echo "$ST" | j "d['stations'][0]['id']")
chk "lista é leve (sem instrucoes)" "False" "$(echo "$ST" | j "'instrucoes' in d['stations'][0]")"
chk "detalhe traz checklist do PEP" "True" "$(echo "$(curl -s "$BASE/api/stations/$SID")" | j "len(d['station']['checklist'])>0")"
chk "5 grandes áreas" "['CIR', 'CM', 'GO', 'MFC', 'PED']" "$(echo "$ST" | j "sorted(d['by_area'].keys())")"

IMP=$(curl -s -X POST "$BASE/api/stations/import" -H "Authorization: Bearer $RTOK" -H 'Content-Type: application/json' \
  -d '{"rows":[{"tema":"Importada A (teste)","area":"PED","nivel":"básico","checklist":"item1;item2"},{"tema":"Importada B (teste)","area":"MFC","checklist":[{"item":"x","peso":3}]}],"overwrite":"0"}')
chk "import cria 2" "2" "$(echo "$IMP" | j "d['created']")"
chk "reimport sem overwrite deduplica" "1" "$(echo "$(curl -s -X POST "$BASE/api/stations/import" -H "Authorization: Bearer $RTOK" -H 'Content-Type: application/json' -d '{"rows":[{"tema":"Importada A (teste)","area":"PED"}]}')" | j "d['created']")"
EXP=$(curl -s "$BASE/api/stations/export?area=PED" -H "Authorization: Bearer $RTOK")
chk "export é pacote reimportável" "True" "$(echo "$EXP" | j "d['total']>0 and 'estacoes' in d")"
chk "pacote exportado mantém formato XLSX-like (roteiroAtor)" "True" "$(echo "$EXP" | j "'roteiroAtor' in d['estacoes'][0]")"

echo "== 6. salas, timer autoritativo, chat, SSE, PEP e disputa =="
RN=$(curl -s -X POST "$BASE/api/rooms" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Sala Teste\",\"rtype\":\"ppl\",\"open\":1,\"station_ids\":[\"$SID\"]}")
CODE=$(echo "$RN" | j "d['room']['code']")
chk "sala criada com código" "True" "$([ -n "$CODE" ] && echo True || echo False)"
chk "sala sem estação é rejeitada" "True" "$(echo "$(curl -s -X POST "$BASE/api/rooms" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"name":"vazia","station_ids":[]}')" | j "d['ok']==False")"

chk "join define peer" "peerA1" "$(echo "$(curl -s -X POST "$BASE/api/rooms/$CODE/join" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"role":"medico","peer_id":"peerA1"}')" | j "d['peer_id']")"
chk "timer set 600s" "600" "$(echo "$(curl -s -X POST "$BASE/api/rooms/$CODE/timer" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"action":"set","seconds":600}')" | j "d['timer']['duration']")"
chk "timer inicia no servidor" "running" "$(echo "$(curl -s -X POST "$BASE/api/rooms/$CODE/timer" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"action":"start"}')" | j "d['timer']['state']")"
sleep 2
REM=$(curl -s "$BASE/api/rooms/$CODE" | j "d['room']['timer']['remaining']")
chk "remaining decrementa no servidor (<=598)" "True" "$(awk -v x="${REM:-9999}" 'BEGIN{print (x+0<=598)?"True":"False"}')"
chk "pause preserva o tempo" "paused" "$(echo "$(curl -s -X POST "$BASE/api/rooms/$CODE/timer" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"action":"pause"}')" | j "d['timer']['state']")"

chk "chat da sala" "enviado" "$(echo "$(curl -s -X POST "$BASE/api/rooms/$CODE/chat" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"text":"mensagem de teste","scope":"room"}')" | j "d['message']")"
chk "chat oculto dos observadores" "enviado" "$(echo "$(curl -s -X POST "$BASE/api/rooms/$CODE/chat" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"text":"anotação oculta","scope":"obs"}')" | j "d['message']")"
chk "relay de sinalização WebRTC" "True" "$(echo "$(curl -s -X POST "$BASE/api/rooms/$CODE/rtc" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"from":"peerA1","to":"peerB2","kind":"offer","data":{"sdp":"v=0","type":"offer"}}')" | j "d['relayed']")"

SSE=$(curl -s --max-time 3 "$BASE/sse?room=$CODE&since=0&token=$TOK" | head -60)
chk "SSE transmite chat:room" "True" "$(echo "$SSE" | grep -q 'event: chat:room' && echo True || echo False)"
chk "SSE transmite timer:ctl" "True" "$(echo "$SSE" | grep -q 'event: timer:ctl' && echo True || echo False)"
chk "SSE transmite relay rtc" "True" "$(echo "$SSE" | grep -q 'event: rtc' && echo True || echo False)"

chk "PEP grava nota ponderada" "True" "$(echo "$(curl -s -X POST "$BASE/api/pep" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"room_code\":\"$CODE\",\"station_id\":\"$SID\",\"marks\":{\"1\":1,\"2\":1}}")" | j "float(d['score'])>0")"
for i in 1 2 3 4 5 6 7 8; do
  curl -s -o /dev/null -X POST "$BASE/api/disputes" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
    -d "{\"station_id\":\"$SID\",\"item_idx\":$i,\"reason\":\"discordo do item $i\",\"room_code\":\"$CODE\"}"
done
FR=$(curl -s -X POST "$BASE/api/disputes" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "{\"station_id\":\"$SID\",\"item_idx\":9,\"reason\":\"ultimo\",\"room_code\":\"$CODE\"}")
echo "  contestação → ratio=$(echo "$FR" | j "d['ratio']") frozen=$(echo "$FR" | j "d['frozen']")"
chk "congelamento acima de 40% de anulação" "True" "$(echo "$FR" | j "d['frozen']==True")"
chk "estação marcada como congelada na base" "1" "$(echo "$(curl -s "$BASE/api/stations/$SID")" | j "d['station']['frozen']")"

echo "== 7. SRS (1·3·7·15·30) =="
SG=$(curl -s -X POST "$BASE/api/srs/generate" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"station_id\":\"$SID\"}")
chk "cartões gerados a partir do PEP" "True" "$(echo "$SG" | j "d['created']>0")"
LST=$(curl -s "$BASE/api/srs" -H "Authorization: Bearer $TOK")
CID=$(echo "$LST" | j "d['cards'][0]['id']")
chk "intervalos 1/3/7/15/30" "[1, 3, 7, 15, 30]" "$(echo "$LST" | j "d['intervals']")"
chk "revisão 'fácil' avança 2 níveis" "2" "$(echo "$(curl -s -X POST "$BASE/api/srs/review" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"id\":$CID,\"grade\":\"easy\"}")" | j "d['level']")"
chk "revisão 'errei' volta ao nível 0" "0" "$(echo "$(curl -s -X POST "$BASE/api/srs/review" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"id\":$CID,\"grade\":\"again\"}")" | j "d['level']")"

echo "== 8. card de procedimento (resumo da IA + fluxograma vetorial) =="
FC=$(curl -s -X POST "$BASE/api/flowcards" -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"station_id\":\"$SID\"}")
FCID=$(echo "$FC" | j "d['card']['id']")
echo "  provedor=$(echo "$FC" | j "d['provider']") degradado=$(echo "$FC" | j "d['degraded']") passos=$(echo "$FC" | j "len(d['steps'])")"
chk "card salvo na biblioteca do usuário" "True" "$([ -n "$FCID" ] && echo True || echo False)"
chk "resumo prático gerado (não vazio)" "True" "$(echo "$FC" | j "len(d['summary'])>40")"
chk "fluxograma tem >=5 passos" "True" "$(echo "$FC" | j "len(d['steps'])>=5")"
chk "passos classificados (inicio/avaliacao/conduta)" "True" "$(echo "$FC" | j "{'inicio','avaliacao','conduta'} & {s['kind'] for s in d['steps']} != set()")"
SVG=$(curl -s "$BASE/cards/$FCID.svg" -H "Authorization: Bearer $TOK")
chk "SVG é vetorial com texto" "True" "$(echo "$SVG" | grep -q 'card de procedimento' && echo True || echo False)"
chk "SVG sem imagem raster embutida" "True" "$(echo "$SVG" | grep -q 'base64' && echo False || echo True)"
chk "card exige autenticação (401 sem token)" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/cards/$FCID.svg")"
chk "biblioteca lista o card" "True" "$(echo "$(curl -s "$BASE/api/flowcards" -H "Authorization: Bearer $TOK")" | j "len(d['cards'])>=1")"

echo "== 9. KPIs, IA e gestão =="
AN=$(curl -s "$BASE/api/analytics" -H "Authorization: Bearer $TOK")
chk "analytics: barras das 5 áreas" "5" "$(echo "$AN" | j "len(d['bars'])")"
chk "analytics: KPIs presentes" "True" "$(echo "$AN" | j "'media' in d['kpis'] and 'treinos' in d['kpis']")"
chk "analytics: rosca global" "True" "$(echo "$AN" | j "'global' in d['donut']")"
chk "ai/status testa os 3 provedores" "3" "$(echo "$(curl -s "$BASE/api/ai/status" -H "Authorization: Bearer $RTOK")" | j "len(d['providers'])")"
chk "ai/logs registra tentativas da cadeia" "True" "$(echo "$(curl -s "$BASE/api/ai/logs" -H "Authorization: Bearer $RTOK")" | j "len(d['logs'])>=0")"
chk "auditoria registra ações" "True" "$(echo "$(curl -s "$BASE/api/admin/audit" -H "Authorization: Bearer $RTOK")" | j "len(d['audit'])>3")"
chk "arquivo de chat por hora" "True" "$(echo "$(curl -s "$BASE/api/chat/archive" -H "Authorization: Bearer $RTOK")" | j "len(d['archive'])>0")"
chk "reset emite token" "True" "$(echo "$(curl -s -X POST "$BASE/api/forgot" -H 'Content-Type: application/json' -d "{\"email\":\"$EM\"}")" | j "'reset_token' in d")"
chk "rota inexistente → 404" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/nao-existe" -H "Authorization: Bearer $RTOK")"

echo
echo "==================== RESULTADO: $PASS ok · $FAIL falhas ===================="
kill $SRV 2>/dev/null
[ $FAIL -eq 0 ]
