#!/usr/bin/env bash
# pratica.M3D v5 — inicialização (PHP 8 + SQLite/WAL). Sem etapa de build.
set -euo pipefail
cd "$(dirname "$0")"

# carrega .env, se existir
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# extensões necessárias
for ext in pdo_sqlite curl mbstring json; do
  if ! php -m | grep -qi "^${ext}$"; then
    echo "!! Falta a extensão PHP: ${ext}" >&2
    echo "   Debian/Ubuntu: sudo apt-get install -y php-cli php-sqlite3 php-curl php-mbstring" >&2
    exit 1
  fi
done

mkdir -p storage data

echo "▶ pratica.M3D v5 em http://localhost:${PORT:-3000}"
echo "  banco: storage/pratica_m3d.sqlite · seed: data/seed_stations.json (428 estações)"
echo "  admin master: root / ${ROOT_PASSWORD:-@0Arcano}"
echo

exec php -S "0.0.0.0:${PORT:-3000}" index.php
