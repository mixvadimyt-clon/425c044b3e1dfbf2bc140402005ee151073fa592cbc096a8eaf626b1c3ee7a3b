#!/usr/bin/env bash
# Те же проверки, что гоняет CI (`.github/workflows/ci.yml`), но на своей машине.
#
#   ./scripts/check-local.sh                 все проверки
#   ./scripts/check-local.sh api web         только эти
#   ./scripts/check-local.sh --list          что вообще есть
#
# Зачем: когда минуты Actions кончились или PR ещё не открыт, это единственный способ узнать,
# что код работает, — а для TypeScript единственный вообще, если Docker на машине нет.
# Не заменяет `.github/workflows/images.yml`: сборку образов и сквозной прогон в Docker
# проверяет только он (или `./start.sh` локально, если Docker есть).
set -uo pipefail
cd "$(dirname "$0")/.."

# Node ставят по-разному; в Git Bash его часто нет в PATH, хотя он установлен
if ! command -v node >/dev/null 2>&1 && [ -x "/c/Program Files/nodejs/node.exe" ]; then
  PATH="/c/Program Files/nodejs:$PATH"
  export PATH
fi

ALL="contracts api web rin-mock ml"
want="${*:-$ALL}"
case "${1:-}" in
--list)
  echo "$ALL"
  exit 0
  ;;
-h | --help)
  sed -n '2,12p' "$0" | sed 's|^# \{0,1\}||'
  exit 0
  ;;
esac

failed=""
skipped=""

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# шаг: если команда упала, помечаем сервис и идём дальше — хочется видеть всё разом, а не первое
step() {
  local label="$1"
  shift
  if "$@" >/tmp/check-local.$$ 2>&1; then
    ok "$label"
  else
    bad "$label"
    tail -25 /tmp/check-local.$$ | sed 's/^/      /'
    return 1
  fi
}

run_service() {
  local name="$1" dir="$2"
  shift 2
  case " $want " in *" $name "*) ;; *) return 0 ;; esac
  if [ ! -d "$dir" ]; then
    skipped="$skipped $name(нет папки)"
    return 0
  fi
  say "$name"
  if (cd "$dir" && "$@"); then
    return 0
  fi
  failed="$failed $name"
  return 1
}

node_service() { # npm ci → gen → lint → build → test, как в ci.yml; шаги без скрипта пропускаются
  local rc=0
  step "npm ci" npm ci || rc=1
  for s in gen lint build test; do
    if npm run --silent "$s" --if-present >/dev/null 2>&1; then
      step "npm run $s" npm run "$s" || rc=1
    fi
  done
  return $rc
}

command -v node >/dev/null 2>&1 || {
  echo "нужен Node.js 22+: https://nodejs.org (в Git Bash может понадобиться перезапуск терминала)" >&2
  exit 1
}
major="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
[ "$major" = 22 ] || printf '\033[33m⚠ Node %s, а CI и образы собираются на 22 — расхождения возможны\033[0m\n' "$(node --version)"

run_service contracts contracts bash -c '
  set -e
  npm ci >/dev/null
  npm run lint
  npm run bundle >/dev/null
  git diff --exit-code -- dist || { echo "dist разошёлся с исходниками — закоммитьте результат npm run bundle"; exit 1; }
  echo "  lint и свежесть dist в порядке"
'

run_service api services/api node_service
run_service web services/web node_service
# у мока нет зависимостей и lock-файла, поэтому и в ci.yml для него только npm test
run_service rin-mock services/rin-mock bash -c 'set -e; npm test >/dev/null 2>&1 && echo "  ✓ npm test" || { npm test; exit 1; }'

if case " $want " in *" ml "*) true ;; *) false ;; esac; then
  if command -v uv >/dev/null 2>&1; then
    say "ml"
    (cd services/ml && uv sync --dev >/dev/null 2>&1 && uv run gen >/dev/null 2>&1 &&
      step "ruff" uv run ruff check . && step "pytest" uv run pytest -q -p no:warnings) || failed="$failed ml"
  else
    skipped="$skipped ml(нет uv)"
  fi
fi

rm -f /tmp/check-local.$$
echo
[ -z "$skipped" ] || printf '\033[33mпропущено:%s\033[0m\n' "$skipped"
if [ -n "$failed" ]; then
  printf '\033[31m✗ не прошло:%s\033[0m\n' "$failed"
  exit 1
fi
printf '\033[32m✓ всё прошло\033[0m — кроме сборки образов: её проверяет images.yml или ./start.sh\n'
