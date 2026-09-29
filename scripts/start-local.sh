#!/usr/bin/env bash
# Локальный запуск «Продукт» без Docker: api (+ ml и web, если они уже есть).
# Использование: ./scripts/start-local.sh            — api с ML-заглушкой (+ web)
#                ML_TRANSPORT=http ./scripts/start-local.sh — api + настоящий services/ml
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ -f .env ] || cp .env.example .env

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "▶ api (http://localhost:${API_PORT:-3000})"
(cd services/api && { [ -d node_modules ] || npm ci; } && npm run gen >/dev/null && npm run dev) &
pids+=($!)

if [ "${ML_TRANSPORT:-$(grep -E '^ML_TRANSPORT=' .env | cut -d= -f2)}" = "http" ]; then
  if [ -f services/ml/pyproject.toml ]; then
    echo "▶ ml (http://localhost:${ML_PORT:-8000})"
    (cd services/ml && uv sync && uv run inspector-ml serve) &
    pids+=($!)
  else
    echo "⚠ ML_TRANSPORT=http, но services/ml ещё не создан — используйте ML_TRANSPORT=stub"
  fi
fi

RIN_URL_VALUE="${RIN_URL:-$(grep -E '^RIN_URL=' .env | cut -d= -f2 | cut -d' ' -f1)}"
if [ -n "$RIN_URL_VALUE" ] && [ -f services/rin-mock/package.json ]; then
  case "$RIN_URL_VALUE" in
    http://localhost:*|http://127.0.0.1:*)
      echo "▶ rin-mock — мок внешней ИС ($RIN_URL_VALUE), пакеты: var/rin-mock/packages (npm run package в services/rin-mock)"
      (cd services/rin-mock && RIN_MOCK_PORT="${RIN_URL_VALUE##*:}" npm start) &
      pids+=($!)
      ;;
  esac
fi

if [ -f services/web/package.json ]; then
  echo "▶ web (http://localhost:5173)"
  (cd services/web && { [ -d node_modules ] || npm ci; } && npm run dev) &
  pids+=($!)
fi

echo "Логины (dev): inspector/inspector · supervisor/supervisor · admin/admin · ml/ml"
wait
