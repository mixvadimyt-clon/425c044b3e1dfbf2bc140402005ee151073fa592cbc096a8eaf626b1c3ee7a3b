#!/usr/bin/env bash
# Кто заходил на стенд: входы из журнала действий api — время по Москве, логин, итог, адрес, браузер.
#
#   ./scripts/stand-logins.sh             # все входы, удачные и нет
#   ./scripts/stand-logins.sh --all       # все действия с записью в журнал, не только входы
#   ./scripts/stand-logins.sh --follow    # последние 20 записей и дальше новые, пока не Ctrl+C
#   STAND_OWN_IPS=95.27.151.199,151.243.191.92 ./scripts/stand-logins.sh   # свои адреса без звёздочки
#
# Только читает. Журнал в базе и его копию построчно (AUDIT_FILE, по умолчанию /data/audit.jsonl) пишет
# api: каждый вход — с логином, IP-адресом и браузером (TRUST_PROXY=1 — адрес клиента, а не Caddy).
# С машины администратора — ./infra/stand/yc-stand.sh logins [те же ключи]: свои адреса он берёт из правила
# SSH в группе безопасности. Просмотры страниц без входа сюда не попадают — только действия.
set -euo pipefail
cd "$(dirname "$0")/.."

ALL=0
FOLLOW=0
for a in "$@"; do
  case "$a" in
  --all) ALL=1 ;;
  --follow | -f) FOLLOW=1 ;;
  -h | --help)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "неизвестный ключ: $a (см. --help)" >&2
    exit 1
    ;;
  esac
done

COMPOSE=(docker compose -f docker-compose.app.yml --env-file .env.stand)
FILE="$(sed -n 's/^AUDIT_FILE=//p' .env.stand 2>/dev/null | tail -1)"
FILE="${FILE:-/data/audit.jsonl}"

read_log() {
  if [ "$FOLLOW" = 1 ]; then
    "${COMPOSE[@]}" exec -T api tail -n 20 -F "$FILE"
  else
    "${COMPOSE[@]}" exec -T api cat "$FILE"
  fi
}

read_log | ALL="$ALL" OWN="${STAND_OWN_IPS:-}" python3 -u -c '
import json, os, sys
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    MSK = ZoneInfo("Europe/Moscow")
except Exception:
    MSK = timezone(timedelta(hours=3))

def browser(ua):
    """«Safari · macOS» вместо строки на 150 знаков; незнакомое — как есть, коротко."""
    if not ua:
        return "—"
    name = next((n for k, n in (("YaBrowser", "Яндекс Браузер"), ("Edg/", "Edge"), ("OPR/", "Opera"),
                                ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari"))
                 if k in ua), None)
    osn = next((n for k, n in (("Windows", "Windows"), ("Android", "Android"), ("iPhone", "iOS"),
                               ("iPad", "iPadOS"), ("Mac OS X", "macOS"), ("Linux", "Linux")) if k in ua), None)
    return " · ".join(x for x in (name, osn) if x) if name else ua[:40]


own = {x.strip() for x in os.environ.get("OWN", "").split(",") if x.strip()}
everything = os.environ.get("ALL") == "1"
strangers = set()
head = ("время, МСК", "кто", "итог", "адрес")
print(f"{head[0]:19}  {head[1]:12} {head[2]:8} {head[3]:16} браузер / действие", flush=True)
for line in sys.stdin:
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if not everything and e.get("action") != "login":
        continue
    d = e.get("details") or {}
    t = datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00")).astimezone(MSK)
    ip = e.get("ip_address") or "—"
    if e.get("action") == "login":
        who = d.get("login") or "—"
        res = "вход" if d.get("success") else ("блок" if d.get("blocked") else "НЕВЕРНО")
        what = browser(e.get("user_agent"))
    else:
        who = (e.get("user_role") or "система").lower()
        res = str(d.get("status_code", ""))
        what = e.get("action", "")
    mark = ""
    if own and ip != "—" and ip not in own:  # у системных записей адреса нет
        mark = "  ★"
        strangers.add(ip)
    print(f"{t:%Y-%m-%d %H:%M:%S}  {who:12} {res:8} {ip:16} {what}{mark}", flush=True)
if own:
    print(f"\nчужих адресов: {len(strangers)}" + (" — " + ", ".join(sorted(strangers)) if strangers else ""))
'
