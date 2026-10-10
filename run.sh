#!/usr/bin/env bash
# pratica.M3D v6 — inicialização (Node + SQLite WAL). Sem etapa de build.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
[ -d node_modules ] || npm install --no-audit --no-fund
echo "▶ pratica.M3D v6 em http://localhost:${PORT:-3000}"
echo "  admin master: root / ${ROOT_PASSWORD:-@0Arcano}  (defina ROOT_PASSWORD no .env)"
exec node src/server.js
