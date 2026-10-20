#!/usr/bin/env bash
# «Продукт» — запуск одной командой. Нужен только Docker.
#
#   ./start.sh            поднять систему и проверить, что она работает
#   ./start.sh stop       остановить (данные и настройки остаются)
#   ./start.sh logs       логи api и ml
#   ./start.sh check      проверить уже запущенную систему
#
#   ./start.sh import ПАПКА [ИМЯ ОБЪЕКТА]
#                     загрузить комплект из dataset/ прямо на сервере — без лимитов интерфейса
#                     (50 МБ на файл, 200 МБ на пакет). Папка указывается относительно dataset/:
#                       ./start.sh import 01_ПАКЕТ_УЧАСТНИКАМ_3_ОБЪЕКТА "Пакет участникам"
#
# Флаги запуска:
#   --gpu | --cpu     видеокарта используется, если найдена; флаг решает за скрипт
#   --port 8080       если 80-й порт занят чем-то другим
#   --domain ИМЯ      HTTPS: Caddy сам получит сертификат Let's Encrypt (нужны порты 80 и 443)
#   --mlflow          включить MLflow по /mlflow/ (вход из админки); запоминается в .env.stand
#   --llm | --no-llm  локальная модель Qwen3 8B для свободного поиска — только с видеокартой;
#                     запоминается в .env.stand. Без флага модель выключена, остальное работает как раньше
#   --no-build        не пересобирать образы
#
# Секреты скрипт генерирует сам в `.env.stand` при первом запуске и больше их не трогает.
# Развёртывание на сервере, данные, обслуживание — docs/guides/deploy.md.
set -euo pipefail
cd "$(dirname "$0")"

CMD=start
MODE=auto
BUILD=1
MLFLOW=0
LLM=""
PORT=""
DOMAIN=""
ENV_FILE=".env.stand"
IMPORT_PATH=""
OBJECT_NAME=""

say() { printf '\n▶ %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*" >&2; }
fail() {
  printf '\n✗ %s\n' "$*" >&2
  exit 1
}
# шапка файла и есть справка — так она не разъедется с поведением
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }
# grep в конвейере убивает источник сигналом SIGPIPE, а pipefail считает это ошибкой,
# поэтому текст сначала забираем в переменную
has() { grep -qi -- "$2" <<<"$1"; }
# JSON-строка из произвольного текста: экранируем обратную косую черту и кавычку
json_string() { printf '"%s"' "$(printf '%s' "$1" | sed 's|\\|\\\\|g; s|"|\\"|g')"; }
# Первое значение поля в ответе api — без jq, его на чистой машине может не быть.
# `|| true` обязателен: без совпадения grep возвращает 1, а head вдобавок гасит его SIGPIPE,
# и при `set -o pipefail` скрипт молча падал бы вместо понятного сообщения.
field() { grep -o "\"$2\":\"[^\"]*\"" <<<"$1" | head -1 | cut -d'"' -f4 || true; }
# Сколько раз образец встретился в ответе (grep -c считал бы строки, а JSON — одна строка)
count() { grep -o -- "$2" <<<"$1" | wc -l || true; }

while [ $# -gt 0 ]; do
  case "$1" in
  start | stop | logs | check | import) CMD="$1" ;;
  --gpu) MODE=gpu ;;
  --cpu) MODE=cpu ;;
  --no-build) BUILD=0 ;;
  --mlflow) MLFLOW=1 ;;
  --llm) LLM=1 ;;
  --no-llm) LLM=0 ;;
  --port)
    PORT="${2:?--port ждёт номер порта}"
    shift
    ;;
  --port=*) PORT="${1#*=}" ;;
  --domain)
    DOMAIN="${2:?--domain ждёт доменное имя}"
    shift
    ;;
  --domain=*) DOMAIN="${1#*=}" ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    # у import два позиционных аргумента: папка и (необязательно) имя объекта
    if [ "$CMD" = import ] && [ -z "$IMPORT_PATH" ]; then
      IMPORT_PATH="$1"
    elif [ "$CMD" = import ] && [ -z "$OBJECT_NAME" ]; then
      OBJECT_NAME="$1"
    else
      printf 'не знаю такой аргумент: %s\n\n' "$1" >&2
      usage >&2
      exit 2
    fi
    ;;
  esac
  shift
done

# ------------------------------------------------------------------ окружение
command -v docker >/dev/null 2>&1 ||
  fail "нужен Docker: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 ||
  fail "нужен Docker Compose v2 (пакет docker-compose-plugin): https://docs.docker.com/compose/install/"
docker info >/dev/null 2>&1 ||
  fail "демон Docker не отвечает. Запустите его (sudo systemctl start docker) или добавьте себя
  в группу docker: sudo usermod -aG docker \$USER — и перезайдите в систему."

# Видеокарта нужна и по существу (на процессоре распознавание скана — около минуты на страницу),
# и по условиям организаторов: нормативы производительности меряются в GPU-конфигурации.
# Минимальная архитектура карты, собранная в колесе paddlepaddle-gpu: cuda_archs там
# [61, 70, 75, 80, 86, 89, 90]. Maxwell (5.x) не поддерживается, и это не настройка —
# в колесе просто нет кода под него.
GPU_MIN_CAPABILITY=61

# Пригодна ли карта: мало видеть её — на неподдерживаемой сборка упадёт на установке
# paddlepaddle-gpu через шестнадцать минут, а если бы и собралась, распознавание бы не пошло.
# Поймано 22.09 на GTX 750 Ti (Maxwell, 5.0).
gpu_capability() {
  local caps
  caps="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null || true)"
  # «8.6» → 86; берём лучшую карту, если их несколько. Одним awk, а не grep | sort | head: без
  # видеокарты вывод пустой, grep возвращает 1, и при pipefail ./start.sh без флагов молча выходил
  # с кодом 1 на любой машине без nvidia-smi (27.09, стенд в Yandex Cloud)
  printf '%s
' "$caps" | tr -d ' .' | awk '/^[0-9]+$/ && $1 + 0 > best + 0 { best = $1 } END { if (best != "") print best }'
}

gpu_ready() {
  command -v nvidia-smi >/dev/null 2>&1 || return 1
  has "$(nvidia-smi -L 2>/dev/null || true)" '^gpu' || return 1
  has "$(docker info 2>/dev/null || true)" 'runtimes:.*nvidia' || return 1
  local cap
  cap="$(gpu_capability)"
  # архитектуру не узнали — не запрещаем: пусть решает флаг, а не наша догадка
  [ -n "$cap" ] || return 0
  [ "$cap" -ge "$GPU_MIN_CAPABILITY" ]
}

if [ "$MODE" = auto ]; then
  if gpu_ready; then
    MODE=gpu
  else
    MODE=cpu
    cap="$(gpu_capability)"
    if [ -n "$cap" ] && [ "$cap" -lt "$GPU_MIN_CAPABILITY" ]; then
      note "видеокарта есть, но её архитектура ${cap%?}.${cap#?} старше поддерживаемой сборкой распознавания (6.1+) — берём вариант для процессора"
    fi
  fi
fi

FILES=(-f docker-compose.app.yml)
if [ "$MODE" = gpu ]; then
  FILES+=(-f docker-compose.gpu.yml)
  if ! gpu_ready; then
    cap="$(gpu_capability)"
    if [ -n "$cap" ] && [ "$cap" -lt "$GPU_MIN_CAPABILITY" ]; then
      warn "карта видна, но её архитектура ${cap%?}.${cap#?} не поддерживается сборкой paddlepaddle-gpu
    (собраны 6.1 и новее). Распознавание на ней не пойдёт — правильный вариант здесь --cpu"
    else
      warn "видеокарта затребована флагом, но nvidia-smi или NVIDIA Container Toolkit не видны; если запуск упадёт — повторите с --cpu"
    fi
  fi
fi

# --------------------------------------------------------------- .env.stand
generated="$(./infra/stand/make-env.sh "${DOMAIN:-:80}")"
# В CI и на стенде переменные могут прийти из окружения — там они и главные: значение из
# оболочки compose берёт раньше, чем из --env-file.
password="${DEMO_PASSWORD:-$generated}"
if [ -n "$DOMAIN" ]; then
  sed -i.bak "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$DOMAIN|" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
fi
[ -z "$PORT" ] || export HTTP_PORT="$PORT"

# Профили compose запоминаем в .env.stand через COMPOSE_PROFILES: compose читает его оттуда сам, и stop,
# logs и следующий ./start.sh без флага видят тот же состав.
profiles_now() { sed -n 's/^COMPOSE_PROFILES=//p' "$ENV_FILE" | tail -1; }
# set_env ИМЯ ЗНАЧЕНИЕ [КОММЕНТАРИЙ] — заменить строку в .env.stand или дописать в конец
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i.bak "s|^$1=.*|$1=$2|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    {
      printf '\n'
      [ -z "${3:-}" ] || printf '# %s\n' "$3"
      printf '%s=%s\n' "$1" "$2"
    } >>"$ENV_FILE"
  fi
}
# profile ИМЯ on|off
profile() {
  local list
  list="$(profiles_now)"
  case "$2,,$list," in
  on,*,"$1",*) return 0 ;;
  on,*) list="${list:+$list,}$1" ;;
  off,*,"$1",*) list="$(printf '%s' ",$list," | sed "s|,$1,|,|; s|^,||; s|,$||")" ;;
  off,*) return 0 ;;
  esac
  set_env COMPOSE_PROFILES "$list" "профили compose: ./start.sh --mlflow, --llm"
}

# MLflow — профиль compose mlops
[ "$MLFLOW" = 0 ] || profile mlops on

# Локальная модель (ADR-0008) — профиль llm и LLM_ENABLED для ML. Только на видеокарте: на процессоре
# Qwen3 8B отвечает минутами на гипотезу, и задача не уложится в ML_JOB_TIMEOUT_S.
if [ "$LLM" = 1 ] && [ "$MODE" != gpu ]; then
  warn "--llm работает только с видеокартой (вариант gpu), модель не включаю"
  LLM=""
fi
case "$LLM" in
1)
  profile llm on
  set_env LLM_ENABLED true "локальная модель (./start.sh --llm / --no-llm)"
  ;;
0)
  profile llm off
  set_env LLM_ENABLED false "локальная модель (./start.sh --llm / --no-llm)"
  ;;
esac
LLM_ON=0
if [ "$MODE" = gpu ] && has ",$(profiles_now)," ',llm,'; then LLM_ON=1; fi

# Потолок процессора для ML. PaddleOCR на процессоре берёт все ядра на каждого воркера: на
# 4-ядерной машине разбор скана держал 400 %, и api с интерфейсом вставали вместе с ним — и на
# загрузке, и сразу после старта, когда api повторяет недоделанную задачу. В варианте cpu отдаём
# ML половину ядер Docker; перебить можно ML_CPUS в окружении или в .env.stand (0 — без потолка).
DOCKER_CPUS="$(docker info --format '{{.NCPU}}' 2>/dev/null || true)"
case "$DOCKER_CPUS" in '' | *[!0-9]*) DOCKER_CPUS="$(nproc 2>/dev/null || echo 2)" ;; esac
if [ "$MODE" = cpu ] && [ -z "${ML_CPUS:-}" ] && ! grep -q '^ML_CPUS=' "$ENV_FILE"; then
  export ML_CPUS=$((DOCKER_CPUS > 1 ? DOCKER_CPUS / 2 : 1))
fi

COMPOSE=(docker compose "${FILES[@]}" --env-file "$ENV_FILE")
# Без --domain адрес берём из .env.stand: на стенде Caddy отвечает только по своему имени, и
# ./start.sh check или import на http://localhost получали бы пустой ответ (27.09).
site="$(sed -n 's/^SITE_ADDRESS=//p' "$ENV_FILE" | tail -1)"
case "$site" in '' | :*) ;; *) [ -n "$DOMAIN" ] || DOMAIN="$site" ;; esac
if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"; else URL="http://localhost${PORT:+:$PORT}"; fi

# ------------------------------------------------------------------- проверка
# Отвечает ли система по своему адресу. Сертификат Let's Encrypt выпускается не мгновенно,
# поэтому ждём с запасом.
alive() {
  local body
  for _ in $(seq 1 30); do
    body="$(curl -fsS --max-time 5 "$URL/health" 2>/dev/null || true)"
    if has "$body" '"status":"ok"'; then return 0; fi
    sleep 2
  done
  return 1
}

check() {
  if ! alive; then
    # На домене неудача — ещё не приговор: контейнеры подняты, а имя и сертификат от нас не зависят
    if [ -z "$DOMAIN" ]; then
      fail "api не отвечает ok на $URL/health — логи: ./start.sh logs"
    fi
    warn "$URL не отвечает. Контейнеры подняты; проверьте, что имя $DOMAIN указывает на эту
    машину и что порты 80 и 443 открыты — без этого сертификат не выпустят. Логи: ./start.sh logs"
    return 0
  fi
  note "api отвечает: $URL/health"

  # Матрица попадает в базу из data/matrix/params.csv только в пустую базу (seed). На работающем стенде
  # правки матрицы из main без этого шага не применялись, и стенд считал по старым шаблонам.
  # Импорт идемпотентен: изменений нет — новой версии нет, активность не меняется.
  local matrix
  matrix="$("${COMPOSE[@]}" exec -T api node --disable-warning=ExperimentalWarning dist/cli/matrix-import.js --apply 2>&1 || true)"
  if has "$matrix" "Изменений нет"; then
    note "матрица в базе совпадает с data/matrix/params.csv"
  elif has "$matrix" "Готово"; then
    note "матрица обновлена из data/matrix/params.csv ($(printf '%s' "$matrix" | grep -o 'Версия матрицы: m-[0-9.]*[0-9]' | head -1))"
  else
    warn "матрицу сверить не удалось — выполните: ${COMPOSE[*]} exec api node dist/cli/matrix-import.js --apply"
  fi

  if has "$(curl -fsS --max-time 10 "$URL/" 2>/dev/null || true)" 'id="root"'; then
    note "веб-клиент отдаётся"
  else
    warn "веб-клиент не отдал index.html — api работает, интерфейс смотрите в логах web"
  fi

  local login
  login="$(curl -fsS --max-time 10 -X POST "$URL/api/v1/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"login\":\"inspector\",\"password\":\"$password\"}" 2>/dev/null || true)"
  if has "$login" access_token; then
    note "вход под inspector работает"
  else
    fail "вход под inspector не удался — проверьте DEMO_PASSWORD в $ENV_FILE"
  fi

  [ "$LLM_ON" = 0 ] || check_llm
}

# Модель спрашиваем тем же клиентом, которым её зовёт ML (llm/client.py): так проверяются сразу адрес,
# внутренняя сеть, запрет на внешние адреса и сама модель. Первый запрос грузит веса в видеопамять — до минуты.
# Неудача не роняет запуск: без модели система работает, просто без гипотез свободного поиска (ADR-0008).
check_llm() {
  local answer
  answer="$("${COMPOSE[@]}" exec -T ml python -c '
import dataclasses
from inspector_ml.config import Settings
from inspector_ml.llm.client import LlmClient
client = LlmClient.from_settings(Settings())
if client is None:
    print("llm: выключена или адрес не локальный")
else:
    client = dataclasses.replace(client, think=False, timeout=180.0)
    answer = client.ask_json("Отвечай только JSON.", "Верни объект {\"ok\": true}.")
    print("llm: ok" if answer else "llm: нет ответа", client.model, client.base_url)
' 2>/dev/null || true)"
  if has "$answer" "llm: ok"; then
    note "модель отвечает: ${answer#llm: ok }"
  else
    warn "модель не ответила (${answer:-ML не запустил проверку}). Система работает без свободного поиска;
    логи модели — ${COMPOSE[*]} logs llm"
  fi
}

# ------------------------------------------------------------------- команды
case "$CMD" in
stop)
  say "останавливаю"
  "${COMPOSE[@]}" stop
  note "данные остались в томах Docker; поднять обратно — ./start.sh"
  exit 0
  ;;
logs)
  exec "${COMPOSE[@]}" logs -f --tail 200 api ml
  ;;
check)
  say "проверка"
  check
  printf '\n✓ система работает: %s\n' "$URL"
  exit 0
  ;;
import)
  [ -n "$IMPORT_PATH" ] ||
    fail "укажите папку внутри dataset/, например: ./start.sh import 01_ПАКЕТ_УЧАСТНИКАМ_3_ОБЪЕКТА"
  say "импорт комплекта: $IMPORT_PATH"
  alive || fail "система не отвечает на $URL — сначала поднимите её: ./start.sh"

  token="$(field "$(curl -fsS --max-time 10 -X POST "$URL/api/v1/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"login\":\"inspector\",\"password\":\"$password\"}" 2>/dev/null || true)" access_token)"
  [ -n "$token" ] || fail "вход под inspector не удался — проверьте DEMO_PASSWORD в $ENV_FILE"

  # Тело запроса пишем в файл, а не передаём аргументом curl. В Git Bash кириллица из командной
  # строки доходит до curl.exe в однобайтовой кодировке Windows; api декодирует тело как UTF-8,
  # каждый испорченный байт разворачивается в три — и длина перестаёт сходиться с Content-Length
  # (FST_ERR_CTP_INVALID_CONTENT_LENGTH). Файл пишет сам bash, поэтому он остаётся в UTF-8.
  body="$(mktemp)"
  trap 'rm -f "$body"' EXIT
  {
    printf '{"path":%s' "$(json_string "$IMPORT_PATH")"
    [ -z "$OBJECT_NAME" ] || printf ',"object_name":%s' "$(json_string "$OBJECT_NAME")"
    printf ',"auto_start":true}'
  } >"$body"

  note "комплект копируется и хешируется на сервере — на больших папках это минуты"
  answer="$(curl -sS --max-time 3600 -X POST "$URL/api/v1/documents/import" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    --data-binary @"$body")" || fail "запрос к api не прошёл"

  process="$(field "$answer" process_id)"
  if [ -z "$process" ]; then
    fail "api не принял комплект: $(field "$answer" message)
    Папки видны так: ${COMPOSE[*]} exec api ls /import"
  fi
  total=$(count "$answer" '"original_name"')
  rejected=$(count "$answer" '"status":"REJECTED"')
  note "файлов принято: $((total - rejected)), отклонено: $rejected"
  note "проверка $process уже идёт — открывайте $URL и следите за статусом"
  exit 0
  ;;
esac

mkdir -p dataset var

if [ "$BUILD" = 1 ]; then
  say "сборка образов, вариант ML — $MODE"
  note "первый раз это 10–25 минут: в образ ML кладутся веса распознавания, чтобы в работе"
  note "не требовался интернет. Повторный запуск — секунды."
  "${COMPOSE[@]}" build
fi

say "запуск"
"${COMPOSE[@]}" up -d --wait --wait-timeout 300 || {
  printf '\n✗ сервисы не поднялись, последние строки логов:\n\n' >&2
  "${COMPOSE[@]}" logs --no-color --tail 50 >&2
  exit 1
}

say "проверка"
check

if [ "$MODE" = cpu ]; then
  ml_note="cpu — распознавание сканов ограничено 30 страницами на документ, около минуты на страницу"
  cpus_now="${ML_CPUS:-$(sed -n 's/^ML_CPUS=//p' "$ENV_FILE" | tail -1)}"
  if [ -n "$cpus_now" ] && [ "$cpus_now" != 0 ]; then
    ml_note="$ml_note;
              ML ограничен $cpus_now ядрами из $DOCKER_CPUS (перебить — ML_CPUS в $ENV_FILE, 0 — без потолка)"
  fi
else
  ml_note="gpu — предела страниц нет, видеопамять ограничена 20 ГБ (GPU_MEMORY_LIMIT_MB)"
  if [ "$LLM_ON" = 1 ]; then
    ml_note="$ml_note;
              свободный поиск — Qwen3 8B в сервисе llm, около 8,5 ГБ видеопамяти (выключить — --no-llm)"
  else
    ml_note="$ml_note;
              свободный поиск локальной моделью выключен (включить — --llm)"
  fi
fi

cat <<SUMMARY

✓ «Инспектор ИИ» работает: $URL

  Логины:  inspector · supervisor · admin · ml
  Пароль:  $password
           (он же в $ENV_FILE с правами 600; в git этот файл не попадает)

  Вариант ML: $ml_note

  состояние     ${COMPOSE[*]} ps
  логи          ./start.sh logs
  проверка      ./start.sh check
  остановить    ./start.sh stop
  сквозной путь ./scripts/stand-smoke.sh $URL inspector '$password' файл-ПД.pdf файл-РД.pdf

Что показать первым делом, как загрузить комплект и как обслуживать — docs/guides/deploy.md.
SUMMARY
