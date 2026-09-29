#!/usr/bin/env bash
# Первичная настройка ВМ стенда (ADR-0007). Идемпотентен: повторный запуск ничего не ломает
# и не перезаписывает уже созданный .env.stand.
#
#   ssh <ВМ>
#   sudo apt-get update && sudo apt-get install -y git
#   sudo git clone <репозиторий> /opt/inspector
#   sudo /opt/inspector/infra/stand/setup.sh
#
# Что делает: ставит Docker, создаёт .env.stand со свежими секретами, поднимает приложение,
# включает таймеры (сторож, ночная копия базы, недельная очистка кеша растров) и прогоняет
# проверку доступности.
#
# Секретов в облачных метаданных и в git нет намеренно: скрипт генерирует их на самой ВМ и один раз
# печатает пароль демо-пользователей. Потом его можно прочитать только из .env.stand на ВМ.
#
# STAND_DOMAIN — доменное имя стенда; без него адрес берётся по внешнему IP через sslip.io,
#                и Caddy выпускает сертификат Let's Encrypt на это имя.
# SKIP_SMOKE=1  — не прогонять ./scripts/stand-smoke.sh в конце.
# STAND_NO_MLFLOW=1 — не поднимать MLflow (по умолчанию он есть: проверяющие смотрят метрики и модели).
# STAND_IMAGES=<архив> — не собирать образы на ВМ, а загрузить архив ./scripts/images.sh save --cpu.
# STAND_NO_BUILD=1 — не пересобирать уже собранные образы: например, сменить домен
#                (STAND_DOMAIN=… STAND_NO_BUILD=1 SKIP_SMOKE=1 sudo -E ./infra/stand/setup.sh).
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE=(docker compose -f docker-compose.app.yml --env-file .env.stand)

say() { printf '\n▶ %s\n' "$*"; }
fail() {
  printf '✗ %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail "запустите через sudo: sudo $0"
cd "$INSTALL_DIR"

say "Docker"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  echo "уже установлен: $(docker --version)"
elif curl -fsSL --max-time 20 https://download.docker.com/linux/ubuntu/gpg -o /tmp/docker.asc; then
  install -m 0755 -d /etc/apt/keyrings
  install -m 0644 /tmp/docker.asc /etc/apt/keyrings/docker.asc
  codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $codename stable" >/etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  # download.docker.com из российских облаков бывает недоступен — тогда пакеты Ubuntu из зеркала
  # облака: Docker 24+, Compose v2 и buildx там есть, для docker-compose.app.yml этого хватает
  echo "download.docker.com недоступен — ставим docker.io из репозитория Ubuntu"
  apt-get update
  apt-get install -y docker.io docker-compose-v2 docker-buildx
  systemctl enable --now docker
fi

# Зеркало Docker Hub: базовые образы (node, python, caddy) тянутся через mirror.gcr.io, а если его
# нет или образа там нет — Docker сам идёт в Docker Hub. Страховка от блокировок Docker Hub по
# адресу и от лимита анонимных загрузок. Свой daemon.json не трогаем.
if [ ! -f /etc/docker/daemon.json ]; then
  printf '{\n  "registry-mirrors": ["https://mirror.gcr.io"]\n}\n' >/etc/docker/daemon.json
  systemctl restart docker
  echo "зеркало Docker Hub: mirror.gcr.io"
fi

say "ufw: входящие только 22, 80 и 443"
# Второй слой после группы безопасности облака. 22 разрешаем до включения, иначе ufw оборвёт SSH,
# через который идёт настройка. Порты, опубликованные Docker, ufw не фильтрует (Docker пишет свои
# правила в обход) — наружу у нас публикуется только Caddy на 80 и 443, Grafana — на 127.0.0.1.
if command -v ufw >/dev/null || apt-get install -y ufw >/dev/null; then
  ufw allow 22/tcp comment ssh >/dev/null
  ufw allow 80/tcp comment http >/dev/null
  ufw allow 443/tcp comment https >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable
fi

say "адрес стенда"
# Yandex Cloud отдаёт внешний адрес через метаданные, совместимые с GCE
external_ip="$(curl -fsS --max-time 5 -H 'Metadata-Flavor: Google' \
  'http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' 2>/dev/null || true)"
site="${STAND_DOMAIN:-}"
if [ -z "$site" ] && [ -n "$external_ip" ]; then
  site="${external_ip//./-}.sslip.io"
  echo "домен не задан — берём имя по внешнему адресу: $site"
fi
[ -n "$site" ] || fail "не удалось определить адрес: задайте STAND_DOMAIN=<имя> и повторите"
echo "HTTPS будет выпущен Let's Encrypt на $site (нужны открытые порты 80 и 443)"

say ".env.stand"
# Секреты генерирует общий с ./start.sh скрипт: у стенда и у проверяющего должен быть
# один способ их завести, иначе однокомандный запуск разъедется с боевым.
demo_password="$(./infra/stand/make-env.sh "$site")"
echo
echo "  ПАРОЛЬ ДЕМО-ПОЛЬЗОВАТЕЛЕЙ: $demo_password"
echo "  (inspector / supervisor / admin / ml; записан в .env.stand)"
echo
mkdir -p dataset var

say "потолок процессора для ML"
# В .env.stand, а не только в окружении ./start.sh: иначе сторож и обновление через compose поднимали бы
# ML без потолка, и распознавание скана занимало бы оба ядра ВМ вместе с интерфейсом.
if grep -q '^ML_CPUS=' .env.stand; then
  echo "уже задан: $(sed -n 's/^ML_CPUS=//p' .env.stand)"
else
  cpus="$(nproc)"
  ml_cpus=$((cpus > 1 ? cpus / 2 : 1))
  printf '\n# ML — половина ядер ВМ (setup.sh): распознавание не должно вешать интерфейс\nML_CPUS=%s\n' "$ml_cpus" >>.env.stand
  echo "ML_CPUS=$ml_cpus из $cpus"
fi

say "предел одной задачи ML"
# На 2 vCPU с ML на одном ядре извлечение 132 параметров по 91 документу идёт около 40 минут, и
# сравнение большого объекта целиком не укладывалось в 1800 с (27.09, Новослободская). Предел общий
# для api и ML: api ждёт столько же, сколько ML работает.
if grep -q '^ML_JOB_TIMEOUT_S=' .env.stand; then
  echo "уже задан: $(sed -n 's/^ML_JOB_TIMEOUT_S=//p' .env.stand) с"
else
  printf '\n# Предел одной задачи ML, с (setup.sh): стенд без видеокарты, большие объекты считаются долго\nML_JOB_TIMEOUT_S=5400\n' >>.env.stand
  echo "ML_JOB_TIMEOUT_S=5400"
fi

say "сборка и запуск"
# Тем же ./start.sh, что у проверяющего, а не голым compose: он же сверяет матрицу в базе с
# data/matrix/params.csv и проверяет вход — у стенда и у проверяющих один путь запуска.
mlflow_flag=(--mlflow)
[ -z "${STAND_NO_MLFLOW:-}" ] || mlflow_flag=()
build_flag=()
[ -z "${STAND_NO_BUILD:-}" ] || build_flag=(--no-build)
if [ -n "${STAND_IMAGES:-}" ]; then
  # запасной путь, если сборка на ВМ не проходит (нет доступа к PyPI, HuggingFace или Docker Hub):
  # архив ./scripts/images.sh save --cpu с рабочей станции, те же образы, что у проверяющих
  say "образы из архива $STAND_IMAGES — без сборки"
  ./scripts/images.sh load "$STAND_IMAGES"
  build_flag=(--no-build)
fi
./start.sh --cpu --domain "$site" "${mlflow_flag[@]}" "${build_flag[@]}"

say "таймеры systemd: сторож, ночная копия базы, очистка кеша растров"
for unit in infra/stand/systemd/*; do
  sed -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" -e "s|@STAND_URL@|https://$site|g" \
    "$unit" >"/etc/systemd/system/$(basename "$unit")"
done
systemctl daemon-reload
systemctl enable --now inspector-watchdog.timer inspector-backup.timer inspector-cache-clean.timer
systemctl list-timers --no-pager 'inspector-*' || true

if [ -n "${SKIP_SMOKE:-}" ]; then
  say "проверка пропущена (SKIP_SMOKE)"
else
  say "проверка доступности"
  # первый запуск на чистой базе: даём api подняться и применить миграции
  sleep 20
  ./scripts/stand-smoke.sh "https://$site" inspector "$demo_password" ||
    echo "проверка не прошла — смотрите ${COMPOSE[*]} logs -f api ml"
fi

cat <<EOF

Готово. Стенд: https://$site
  состояние      ${COMPOSE[*]} ps
  логи           ${COMPOSE[*]} logs -f api ml
  сторож         systemctl status inspector-watchdog.timer
  копии базы     systemctl status inspector-backup.timer
  чистка растров systemctl status inspector-cache-clean.timer
  обновление     git pull && ${COMPOSE[*]} up -d --build

Дальше (docs/guides/deploy.md): снимок диска, бюджет с оповещениями,
кеш разбора и демо-объекты.
EOF
