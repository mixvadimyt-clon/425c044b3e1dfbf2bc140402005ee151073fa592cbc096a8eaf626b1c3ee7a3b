#!/usr/bin/env bash
# Проверка «образ никуда не ходит наружу».
#
#   ./scripts/stand-offline-check.sh            проверить на уже собранных образах
#   KEEP=1 ./scripts/stand-offline-check.sh     не удалять проверочный контур после прогона
#   OUT=папка ./scripts/stand-offline-check.sh  куда сохранить протокол (submission и gold)
#
# Поднимает api, ml и мок «РиН» отдельным проектом compose (`inspector-offline`, свои тома)
# во внутренней сети без маршрута в интернет (infra/stand/offline.yml) и проверяет:
#   1. изоляция настоящая — изнутри не открывается ни HuggingFace, ни голый IP;
#   2. сквозной путь работает без сети: контрольный комплект (scripts/demo-errors-set.py),
#      в котором один акт ИД превращён в скан, — значит, распознавание тоже идёт без сети
#      на весах из образа, — даёт протокол FULL с тремя кандидатами;
#   3. в логах ml нет попыток что-то скачать.
# Веб-клиент (Caddy) не поднимается: он занял бы порт стенда, а наружу Caddy ходит только
# за сертификатом Let's Encrypt, когда в SITE_ADDRESS задан домен.
#
# Рабочий стенд не трогает: другое имя проекта, свои тома, после прогона всё удаляется.
# Образы берутся готовые — сначала `./start.sh` (или `docker compose ... build`).
set -euo pipefail
cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1 # Git Bash под Windows не должен переписывать пути внутри контейнера

PROJECT=inspector-offline
OUT="${OUT:-var/offline-check}"
say() { printf '\n▶ %s\n' "$*"; }
fail() {
  printf '\n✗ %s\n' "$*" >&2
  exit 1
}
# Путь для `docker run -v`: под Git Bash нужен виндовый вид, в Linux — обычный
host_path() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
rand() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

for image in inspector-api inspector-ml inspector-rin-mock; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "нет образа $image — сначала ./start.sh"
done

# Рядом с данными, а не в mktemp: /tmp из Git Bash compose под Windows не находит
mkdir -p var
ENV_FILE="var/offline-check.env"
PASS="$(rand)"
cat >"$ENV_FILE" <<EOF
JWT_SECRET=$(rand)$(rand)
INTERNAL_TOKEN=$(rand)$(rand)
DEMO_PASSWORD=$PASS
ML_CPUS=${ML_CPUS:-2}
EOF
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.app.yml -f infra/stand/offline.yml --env-file "$ENV_FILE")

cleanup() {
  if [ -z "${KEEP:-}" ]; then
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

say "контур без интернета: api, ml, rin-mock (проект $PROJECT)"
"${COMPOSE[@]}" up -d --no-build --wait --wait-timeout 300 api ml rin-mock || {
  "${COMPOSE[@]}" logs --no-color --tail 40 >&2
  fail "контур не поднялся"
}
internal="$(docker network inspect "${PROJECT}_default" --format '{{.Internal}}')"
[ "$internal" = true ] || fail "сеть ${PROJECT}_default не внутренняя — проверка ничего бы не доказала"
printf '  сеть %s_default: internal=%s\n' "$PROJECT" "$internal"

say "изоляция: изнутри контура интернета нет"
"${COMPOSE[@]}" exec -T ml python - <<'PY' || fail "из контейнера ml есть выход наружу — изоляция не работает"
import socket, sys, urllib.request

reached = []
for url in ("https://huggingface.co", "https://paddle-model-ecology.bj.bcebos.com"):
    try:
        urllib.request.urlopen(url, timeout=5)
        reached.append(url)
    except Exception as exc:
        print(f"  {url}: недоступен ({type(exc).__name__})")
try:
    socket.create_connection(("1.1.1.1", 443), timeout=5).close()
    reached.append("1.1.1.1:443")
except OSError as exc:
    print(f"  1.1.1.1:443: недоступен ({type(exc).__name__})")
sys.exit(1 if reached else 0)
PY

say "сквозной путь без сети: контрольный комплект, один акт ИД — скан"
mkdir -p "$OUT"
docker run --rm -i --network "${PROJECT}_default" \
  -v "$(host_path .)/scripts:/repo/scripts:ro" -v "$(host_path "$OUT"):/out" \
  -e PASS="$PASS" -e PYTHONIOENCODING=utf-8 \
  --entrypoint python inspector-ml - <<'PY' || fail "сквозной путь без сети не прошёл"
import json, os, subprocess, sys, time, urllib.request, uuid
from pathlib import Path

import pymupdf

BASE = "http://api:3000"
work = Path("/tmp/set")
subprocess.run([sys.executable, "/repo/scripts/demo-errors-set.py", str(work)], check=True, stdout=subprocess.DEVNULL)

# Акт №14 — без текстового слоя: значение B25 можно взять только распознаванием
act = work / "Исполнительная документация" / "АОСР №14 от 14.05.2026.pdf"
src = pymupdf.open(act)
pix, rect = src[0].get_pixmap(dpi=200), src[0].rect
src.close()
scan = pymupdf.open()
scan.new_page(width=rect.width, height=rect.height).insert_image(rect, pixmap=pix)
scan.save(act)


def call(method, path, body=None, headers=None, raw=False):
    req = urllib.request.Request(BASE + path, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    return data if raw else json.loads(data or b"null")


token = call("POST", "/api/v1/auth/login", json.dumps({"login": "inspector", "password": os.environ["PASS"]}).encode(),
             {"content-type": "application/json"})["access_token"]
auth = {"authorization": f"Bearer {token}"}
obj = call("POST", "/api/v1/objects", json.dumps({"name": "Проверка без интернета"}).encode(),
           {**auth, "content-type": "application/json"})["id"]

boundary = uuid.uuid4().hex
parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="object_id"\r\n\r\n{obj}\r\n'.encode()]
def attach(field, path, ctype):
    parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{path.name}"\r\n'
                  f"Content-Type: {ctype}\r\n\r\n").encode() + path.read_bytes() + b"\r\n")
attach("registry", work / "registry.csv", "text/csv")
for pdf in sorted(work.rglob("*.pdf")):
    attach("files", pdf, "application/pdf")
body = b"".join(parts) + f"--{boundary}--\r\n".encode()

started = time.time()
pid = call("POST", "/api/v1/documents/upload", body,
           {**auth, "content-type": f"multipart/form-data; boundary={boundary}"})["process_id"]
while True:
    st = call("GET", f"/api/v1/processes/{pid}/status", headers=auth)
    if st["status"] in ("READY", "VERIFYING", "COMPLETED", "FAILED") or time.time() - started > 1200:
        break
    time.sleep(2)
print(f"  проверка {st['status']} за {time.time() - started:.0f} с")

files = call("GET", f"/api/v1/processes/{pid}/files", headers=auth)
for f in files:
    ocr = (f.get("quality") or {}).get("pages_ocr") or 0
    print(f"  {f['original_name']:30} {f.get('doc_stage')}  {f.get('processing_status')}"
          + (f"  распознано страниц: {ocr}" if ocr else ""))
proto = call("GET", f"/api/v1/protocols/{st['current_protocol_id']}", headers=auth)
candidates = proto["tables"].get("candidates", [])
for r in candidates:
    print(f"  CANDIDATE {r['param_code']} {r.get('rule_key')}: {r.get('rationale')}")

for fmt in ("submission", "gold"):
    data = call("GET", f"/api/v1/protocols/{proto['id']}/export?format={fmt}", headers=auth, raw=True)
    Path(f"/out/{fmt}.json").write_bytes(data)

problems = []
if st["status"] != "READY":
    problems.append(f"статус {st['status']}, ожидался READY")
if any(f.get("processing_status") != "PARSED" for f in files):
    problems.append("не все файлы разобраны")
scanned = next((f for f in files if f["original_name"] == act.name), {})
if not (scanned.get("quality") or {}).get("pages_ocr"):
    problems.append("скан акта №14 не прошёл через распознавание (quality.pages_ocr = 0)")
if proto.get("scenario") != "FULL":
    problems.append(f"сценарий {proto.get('scenario')}, ожидался FULL")
if sorted(r["param_code"] for r in candidates) != ["M-002", "M-055", "M-055"]:
    problems.append("ожидались три кандидата: M-002 и два M-055")
plate = next((r for r in candidates if r.get("rule_key") == "Фундаментная плита"), None)
if not plate or "ИД: B25" not in (plate.get("rationale") or "").replace("В25", "B25"):
    problems.append("значение ИД из скана акта №14 не распознано — распознавание без сети не сработало")
for p in problems:
    print("  ✗", p)
sys.exit(1 if problems else 0)
PY

say "логи ml и api: попыток выйти в сеть нет"
logs="$("${COMPOSE[@]}" logs --no-color ml api 2>&1)"
# «To redownload, please delete…» — штатная строка PaddleX про веса из кеша, это не попытка скачать
if grep -iE 'downloading|connecting to|connection (refused|error)|max retries|name resolution' <<<"$logs"; then
  fail "в логах ml или api попытки выйти в сеть — строки выше"
fi
printf '  в логах ml и api обращений наружу нет\n'

printf '\n✓ Работает без интернета: api, ml и мок «РиН» в изолированной сети, распознавание — на весах из образа.\n'
printf '  Протокол: %s/submission.json и %s/gold.json\n' "$OUT" "$OUT"
