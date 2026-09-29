#!/usr/bin/env bash
# Сквозная проверка развёрнутого «Продукта»: веб-клиент → api → ml → протокол.
# Использование:
#   ./scripts/stand-smoke.sh [BASE_URL] [LOGIN] [PASSWORD] [PDF_PD PDF_RD]
#   ./scripts/stand-smoke.sh https://stand.example.ru inspector "$DEMO_PASSWORD"          # только доступность и вход
#   ./scripts/stand-smoke.sh http://localhost inspector pass pd.pdf rd.pdf                  # + загрузка и протокол
# SMOKE_WAIT_S — сколько ждать протокол (по умолчанию 600 с), SMOKE_OUT — куда сохранить протокол (JSON),
# SMOKE_SKIP_WEB=1 — проверять api напрямую, без веб-клиента.
set -euo pipefail
BASE="${1:-http://localhost}"
LOGIN="${2:-inspector}"
PASS="${3:-${DEMO_PASSWORD:-inspector}}"
PD="${4:-}"
RD="${5:-}"

field() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {"d": d}))' "$1"; }
step() { printf '▶ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

if [ -z "${SMOKE_SKIP_WEB:-}" ]; then
  step "веб-клиент: $BASE/"
  curl -fsS "$BASE/" | grep -q 'id="root"' || fail "веб-клиент не отдаёт index.html"
fi

step "api: /health"
[ "$(curl -fsS "$BASE/health" | field 'd["status"]')" = ok ] || fail "api не отвечает ok"

step "вход: $LOGIN"
LOGIN_JSON=$(curl -fsS -X POST "$BASE/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"login\":\"$LOGIN\",\"password\":\"$PASS\"}") || fail "вход не удался — проверьте логин и пароль (DEMO_PASSWORD)"
TOKEN=$(printf '%s' "$LOGIN_JSON" | field 'd["access_token"]')
AUTH=(-H "authorization: Bearer $TOKEN")

step "обмен с внешней ИС: $(curl -fsS "${AUTH[@]}" "$BASE/api/v1/integration/status" | field '(d["external_system"] + " — " + ("включён" if d["enabled"] else "выключен"))')"

if [ -z "$PD" ] || [ -z "$RD" ]; then
  echo "✓ стенд доступен (PDF не переданы — загрузку не проверяли)"
  exit 0
fi

step "объект"
OBJ=$(curl -fsS "${AUTH[@]}" -H 'content-type: application/json' -X POST "$BASE/api/v1/objects" \
  -d '{"name":"Проверка стенда (smoke)"}' | field 'd["id"]')

step "загрузка ПД и РД: $(basename "$PD"), $(basename "$RD")"
HINTS="{\"$(basename "$PD")\":\"PD\",\"$(basename "$RD")\":\"RD\"}"
PID=$(curl -fsS "${AUTH[@]}" -X POST "$BASE/api/v1/documents/upload" \
  -F "object_id=$OBJ" -F "stage_hints=$HINTS" \
  -F "files=@$PD;type=application/pdf" -F "files=@$RD;type=application/pdf" | field 'd["process_id"]')

step "разбор и сравнение (проверка $PID)"
STATUS=""
for _ in $(seq 1 "${SMOKE_WAIT_S:-600}"); do
  STATUS=$(curl -fsS "${AUTH[@]}" "$BASE/api/v1/processes/$PID/status" | field 'd["status"]')
  case "$STATUS" in
    READY|VERIFYING|COMPLETED) break ;;
    FAILED) fail "проверка завершилась с ошибкой: $(curl -fsS "${AUTH[@]}" "$BASE/api/v1/processes/$PID" | field 'd.get("error")')" ;;
  esac
  sleep 1
done
case "$STATUS" in READY|VERIFYING|COMPLETED) ;; *) fail "протокол не готов за ${SMOKE_WAIT_S:-600} с (статус $STATUS)" ;; esac

PROTOCOL=$(curl -fsS "${AUTH[@]}" "$BASE/api/v1/processes/$PID/status" | field 'd["current_protocol_id"]')
SUMMARY=$(curl -fsS "${AUTH[@]}" "$BASE/api/v1/protocols/$PROTOCOL" \
  | field '"версия %s, сценарий %s, проверок %s, модель %s" % (d["version"], d["scenario"], sum(len(v) for v in d["tables"].values()), d["versions"]["model_version"])')
step "протокол: $SUMMARY"
if [ -n "${SMOKE_OUT:-}" ]; then
  curl -fsS "${AUTH[@]}" "$BASE/api/v1/protocols/$PROTOCOL/export?format=json" -o "$SMOKE_OUT"
  step "протокол сохранён: $SMOKE_OUT"
fi
echo "✓ сквозной сценарий пройден"
