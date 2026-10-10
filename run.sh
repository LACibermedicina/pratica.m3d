#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
[ -f .env ] && export $(grep -v '^#' .env | xargs) || true
pip install -r requirements.txt
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-3000}"
