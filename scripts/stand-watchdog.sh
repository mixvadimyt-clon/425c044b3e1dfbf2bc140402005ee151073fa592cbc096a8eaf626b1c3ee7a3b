#!/usr/bin/env bash
# Сторож стенда: проверяет /health и перезапускает залипшие контейнеры.
#
# Упавший контейнер compose поднимает сам (restart: unless-stopped) — сторож нужен для другого
# случая: процесс жив, порт слушает, а сервис не отвечает. Поэтому реагируем не на первую неудачу,
# а на несколько подряд, и счётчик храним между запусками: одиночный таймаут при тяжёлом разборе
# на CPU (ADR-0007) — это не повод ронять очередь задач.
#
# Ставится таймером systemd из infra/stand/setup.sh (раз в 5 минут). Вручную:
#   STAND_URL=https://стенд ./scripts/stand-watchdog.sh
#
# WATCHDOG_LIMIT — сколько неудач подряд до перезапуска (по умолчанию 3),
# WATCHDOG_STATE — файл счётчика (по умолчанию var/watchdog.state).
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${STAND_URL:-http://localhost}"
LIMIT="${WATCHDOG_LIMIT:-3}"
STATE="${WATCHDOG_STATE:-var/watchdog.state}"
PYTHON="${PYTHON:-python3}"          # на ВМ стенда это python3; переопределяется для отладки
COMPOSE=(docker compose -f docker-compose.app.yml)
if [ -f .env.stand ]; then COMPOSE+=(--env-file .env.stand); fi

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

# из ответа /health берём status и зависимости со статусом не ok
read_health() {
  "$PYTHON" -c '
import json, sys
try:
    data = json.loads(sys.stdin.read() or "{}")
except ValueError:
    data = {}
down = [name for name, state in (data.get("dependencies") or {}).items() if state != "ok"]
print(data.get("status", ""))
print(" ".join(sorted(down)))
'
}

mkdir -p "$(dirname "$STATE")"
fails=$(cat "$STATE" 2>/dev/null || echo 0)

answered=yes
body=$(curl -fsS --max-time 20 "$URL/health" 2>/dev/null) || { body=""; answered=no; }
health=$(printf %s "$body" | read_health) || health=
status=$(printf %s "$health" | sed -n 1p)
down=$(printf %s "$health" | sed -n 2p)

if [ "$status" = ok ]; then
  if [ "${fails:-0}" -gt 0 ]; then log "стенд снова отвечает (неудач подряд было: $fails)"; fi
  echo 0 >"$STATE"
  exit 0
fi

fails=$((fails + 1))
echo "$fails" >"$STATE"
log "проверка не прошла ($fails из $LIMIT): ${status:-нет ответа}${down:+, не отвечают: $down} — $URL/health"
if [ "$fails" -lt "$LIMIT" ]; then
  exit 0
fi

# ответ пришёл — web и api живы, виновата зависимость; ответа нет — перезапускаем всё
if [ "$answered" = yes ]; then
  services=(api ml)
else
  services=(api ml web rin-mock)
fi
log "перезапуск контейнеров: ${services[*]}"
"${COMPOSE[@]}" restart "${services[@]}"
echo 0 >"$STATE"
log "перезапуск выполнен; следующая проверка покажет результат"
