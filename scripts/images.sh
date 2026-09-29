#!/usr/bin/env bash
# Образы для развёртывания без интернета.
#
# Проверяющие разворачивают решение в закрытом контуре: `./start.sh` там собрать образы не сможет —
# сборка качает пакеты pip и npm и веса распознавания. Поэтому образы собираются у нас, выгружаются
# одним архивом и загружаются на месте, а запуск идёт без сборки.
#
#   ./scripts/images.sh save [--cpu | --gpu | --all] [--mlflow] [ПАПКА]
#         выгрузить образы в ПАПКА (по умолчанию var/images/) архивом
#         inspector-images-<версия>-<вариант>.tar.gz и файлом .sha256 рядом.
#         --cpu (по умолчанию) — образ ML для процессора, --gpu — для видеокарты, --all — оба;
#         --mlflow — добавить MLflow, Prometheus и Grafana (профиль mlops).
#         Недостающие образы сначала собираются (нужен интернет — это делается у нас).
#
#   ./scripts/images.sh load АРХИВ.tar.gz
#         сверить контрольную сумму и загрузить образы в Docker. Дальше — без интернета:
#           ./start.sh --no-build --cpu      (или --gpu, если в архиве образ для видеокарты)
#
#   ./scripts/images.sh list             какие образы нужны и есть ли они в Docker
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n▶ %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() {
  printf '\n✗ %s\n' "$*" >&2
  exit 1
}
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

CMD="${1:-}"
[ -n "$CMD" ] || {
  usage
  exit 1
}
shift

VARIANT=cpu
MLOPS=0
OUT="var/images"
ARCHIVE=""
while [ $# -gt 0 ]; do
  case "$1" in
  --cpu) VARIANT=cpu ;;
  --gpu) VARIANT=gpu ;;
  --all) VARIANT=all ;;
  --mlflow) MLOPS=1 ;;
  -h | --help)
    usage
    exit 0
    ;;
  *) if [ "$CMD" = load ]; then ARCHIVE="$1"; else OUT="$1"; fi ;;
  esac
  shift
done

# Образы приложения — те же имена, что в docker-compose.app.yml и docker-compose.gpu.yml
APP=(inspector-api inspector-web inspector-rin-mock)
ML_CPU=inspector-ml
ML_GPU=inspector-ml-gpu
# Профиль mlops: версии — из compose, чтобы не разъехались
mlops_images() { sed -n 's/^ *image: *\(\(ghcr.io\/mlflow\|prom\/\|grafana\/\)[^ ]*\).*/\1/p' docker-compose.app.yml; }

images() {
  local list=("${APP[@]}")
  case "$VARIANT" in
  cpu) list+=("$ML_CPU") ;;
  gpu) list+=("$ML_GPU") ;;
  all) list+=("$ML_CPU" "$ML_GPU") ;;
  esac
  if [ "$MLOPS" = 1 ]; then
    local extra
    while read -r extra; do list+=("$extra"); done < <(mlops_images)
  fi
  printf '%s\n' "${list[@]}"
}

present() { docker image inspect "$1" >/dev/null 2>&1; }

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

build_missing() {
  local missing=() image
  while read -r image; do present "$image" || missing+=("$image"); done < <(images)
  [ ${#missing[@]} -gt 0 ] || return 0
  say "собираю недостающие образы: ${missing[*]}"
  # compose подставляет переменные во весь файл даже для сборки, поэтому нужен .env.stand
  ./infra/stand/make-env.sh >/dev/null
  local files=(-f docker-compose.app.yml) services=()
  for image in "${missing[@]}"; do
    case "$image" in
    inspector-api) services+=(api) ;;
    inspector-web) services+=(web) ;;
    inspector-rin-mock) services+=(rin-mock) ;;
    "$ML_CPU") services+=(ml) ;;
    "$ML_GPU") ;;
    *) docker pull "$image" ;;
    esac
  done
  [ ${#services[@]} -eq 0 ] || docker compose "${files[@]}" --env-file .env.stand build "${services[@]}"
  if [[ " ${missing[*]} " == *" $ML_GPU "* ]]; then
    docker compose -f docker-compose.app.yml -f docker-compose.gpu.yml --env-file .env.stand build ml
  fi
}

case "$CMD" in
list)
  while read -r image; do
    if present "$image"; then
      note "✓ $image  $(docker image inspect "$image" --format '{{.Size}}' | awk '{ printf "%.1f ГБ", $1 / 1e9 }')"
    else
      note "✗ $image  — нет, соберётся при save"
    fi
  done < <(images)
  ;;

save)
  command -v docker >/dev/null || fail "нужен Docker"
  build_missing
  version="$(git describe --always --dirty 2>/dev/null || date +%Y%m%d)"
  mkdir -p "$OUT"
  archive="$OUT/inspector-images-$version-$VARIANT.tar.gz"
  list=()
  while read -r image; do list+=("$image"); done < <(images)
  say "выгружаю ${#list[@]} образов в $archive"
  for image in "${list[@]}"; do note "$image"; done
  note "это минуты: образ ML весит несколько гигабайт"
  # gzip -1: в разы быстрее -6, а веса моделей всё равно почти не сжимаются
  docker save "${list[@]}" | gzip -1 >"$archive.part"
  mv "$archive.part" "$archive"
  sum="$(sha_of "$archive")"
  printf '%s  %s\n' "$sum" "$(basename "$archive")" >"$archive.sha256"
  say "готово"
  note "архив: $archive ($(du -h "$archive" | cut -f1))"
  note "SHA-256: $sum"
  note "на месте: ./scripts/images.sh load $(basename "$archive") && ./start.sh --no-build --$([ "$VARIANT" = gpu ] && echo gpu || echo cpu)"
  ;;

load)
  [ -n "$ARCHIVE" ] || fail "укажите архив: ./scripts/images.sh load inspector-images-….tar.gz"
  [ -f "$ARCHIVE" ] || fail "нет файла $ARCHIVE"
  if [ -f "$ARCHIVE.sha256" ]; then
    expected="$(cut -d' ' -f1 "$ARCHIVE.sha256")"
    say "сверяю контрольную сумму"
    actual="$(sha_of "$ARCHIVE")"
    [ "$actual" = "$expected" ] || fail "SHA-256 не совпал: ожидали $expected, получили $actual — архив повреждён при передаче"
    note "совпадает: $actual"
  else
    note "файла $ARCHIVE.sha256 рядом нет — контрольную сумму не сверяю"
  fi
  say "загружаю образы в Docker"
  docker load -i "$ARCHIVE"
  say "готово — запуск без сборки и без интернета:"
  note "./start.sh --no-build --cpu     (или --gpu, если загружен inspector-ml-gpu)"
  ;;

*)
  usage
  exit 1
  ;;
esac
