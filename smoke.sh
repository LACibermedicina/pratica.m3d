#!/usr/bin/env bash
# Smoke test end-to-end da v6 (sem navegador).
set -u
cd "$(dirname "$0")"
PORT=3111
BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
chk(){ if [ "$2" = "$3" ]; then echo "  ok   $1 → $3"; PASS=$((PASS+1)); else echo "  FAIL $1 → esperado[$2] obtido[$3]"; FAIL=$((FAIL+1)); fi; }

echo "== 1. subindo servidor =="
PORT=$PORT node src/server.js >/tmp/m3d6.log 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT
sleep 2

echo "== 2. health =="
chk "health.ok" "true" "$(curl -s $BASE/health | python3 -c 'import sys,json;print(json.load(sys.stdin)["ok"])')"

echo "== 3. login root =="
TOK=$(curl -s -XPOST -H 'Content-Type: application/json' -d '{"login":"root","password":"@0Arcano"}' $BASE/api/login | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
[ -n "$TOK" ] && { echo "  ok   token obtido"; PASS=$((PASS+1)); } || { echo "  FAIL token"; FAIL=$((FAIL+1)); }

echo "== 4. meta/stations =="
N=$(curl -s -H "Authorization: Bearer $TOK" $BASE/api/stations | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["stations"]))')
echo "  → $N estações carregadas"

echo "== 5. criar sala =="
ROOM=$(curl -s -XPOST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke","station_ids":[],"timer_duration":120}' $BASE/api/rooms \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["room"]["code"])')
echo "  → sala $ROOM criada"

echo "== 6. video/config (sem auth) =="
chk "video.config.ok" "true" "$(curl -s $BASE/api/video/config | python3 -c 'import sys,json;print(json.load(sys.stdin)["ok"])')"

echo
echo "Resultado: $PASS ok · $FAIL falha(s)"
[ $FAIL -eq 0 ]
