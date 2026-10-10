#!/usr/bin/env bash
# pratica.M3D v6 — inicialização (Node + SQLite WAL). Sem etapa de build.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
[ -d node_modules ] || npm install --no-audit --no-fund
echo "▶ pratica.M3D v6 em http://localhost:${PORT:-3000}"
echo "  admin master: root — senha definida no .env (não impressa)"
exec node src/server.js
