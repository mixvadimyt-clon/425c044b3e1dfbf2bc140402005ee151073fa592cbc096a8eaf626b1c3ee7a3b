#!/usr/bin/env bash
# ВМ стенда в Yandex Cloud. Параметры ВМ и график работы — из ADR-0007.
#
#   ./infra/stand/yc-stand.sh preflight  # облако готово? профиль, сеть, образ, ключ — ничего не меняет
#   ./infra/stand/yc-stand.sh plan       # что будет создано и почём — ничего не меняет
#   APPLY=1 ./infra/stand/yc-stand.sh create
#   ./infra/stand/yc-stand.sh bootstrap  # код на ВМ через deploy-ключ (репозиторий приватный)
#
# STAND_ADMIN_CIDRS — откуда пускать на 22 (по умолчанию отовсюду; вход только по ключу).
#   ./infra/stand/yc-stand.sh logins [--all | --follow]   # кто заходил на стенд (scripts/stand-logins.sh)
#   ./infra/stand/yc-stand.sh ssh [команда]   # например: ssh sudo /opt/inspector/infra/stand/setup.sh
#   ./infra/stand/yc-stand.sh status | ip | start | stop | snapshot
#
# Создание ВМ, статического адреса и группы безопасности — платные действия, поэтому без APPLY=1
# скрипт только печатает команды. Прочитайте план глазами: флаги сверены со справкой yc 1.37
# (26.09), но на живом облаке команды ещё не выполнялись. Повторный create пропускает то, что
# уже создано, — упавший посередине запуск можно просто повторить.
#
# Бюджет с оповещениями на 3 000 и 4 000 ₽ в скрипт не вынесен намеренно: он заводится один раз в
# консоли биллинга, требует идентификатор платёжного аккаунта, и ошибка там дороже сэкономленной
# минуты. Шаг есть в чек-листе docs/guides/deploy.md.
set -euo pipefail

NAME="${STAND_NAME:-inspector-stand}"
ZONE="${STAND_ZONE:-ru-central1-a}"
NETWORK="${STAND_NETWORK:-default}"
SUBNET="${STAND_SUBNET:-$NETWORK-$ZONE}"
DISK_GB="${STAND_DISK_GB:-50}"
IMAGE_FAMILY="${STAND_IMAGE_FAMILY:-ubuntu-2404-lts}"
# отдельный ключ стенда: id_ed25519 у администратора закреплён за GitHub в ~/.ssh/config
SSH_KEY="${STAND_SSH_KEY:-$HOME/.ssh/inspector_stand.pub}"
REPO="${STAND_REPO:-git@github.com:mixvadimyt-clon/425c044b3e1dfbf2bc140402005ee151073fa592cbc096a8eaf626b1c3ee7a3b.git}"
PYTHON="${PYTHON:-python3}"
# 22 — только администраторам: список CIDR через запятую, например «95.27.151.199/32,151.243.191.92/32»
ADMIN_CIDRS="${STAND_ADMIN_CIDRS:-0.0.0.0/0}"
SG="$NAME-sg"
ADDRESS="$NAME-ip"

# первая ВМ: подключение без вопроса о ключе хоста; свой ключ стенда, если лежит рядом с .pub
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
[ ! -f "${SSH_KEY%.pub}" ] || SSH_OPTS+=(-i "${SSH_KEY%.pub}" -o IdentitiesOnly=yes)

say() { printf '\n▶ %s\n' "$*"; }

need_yc() {
  # установщик дописывает PATH в профиль оболочки, а открытый терминал его ещё не видит
  [ -x "$HOME/yandex-cloud/bin/yc" ] && PATH="$HOME/yandex-cloud/bin:$PATH"
  command -v yc >/dev/null || {
    echo "нужен Yandex Cloud CLI: https://yandex.cloud/docs/cli/quickstart" >&2
    exit 1
  }
}

# печатает команду и выполняет её только при APPLY=1
run() {
  printf '  %s\n' "$*"
  if [ -n "${APPLY:-}" ]; then "$@"; fi
}

# ресурс уже есть — create его пропускает (только при APPLY=1: план облако не спрашивает)
exists() { [ -n "${APPLY:-}" ] && "$@" >/dev/null 2>&1; }

# поле из ответа yc ... --format json
field() { "$PYTHON" -c 'import json,sys; print(eval(sys.argv[1], {"d": json.load(sys.stdin)}))' "$1"; }

instance_json() { yc compute instance get --name "$NAME" --format json; }

external_address() {
  instance_json | field 'd["network_interfaces"][0]["primary_v4_address"]["one_to_one_nat"]["address"]'
}

remote() { ssh "${SSH_OPTS[@]}" "yc-user@$(external_address)" "$@"; }

preflight() {
  local bad=0 out folder
  check() {
    local what="$1"
    shift
    if out="$("$@" 2>&1)"; then
      printf '  ✓ %s%s\n' "$what" "${out:+ — $out}"
    else
      printf '  ✗ %s\n      %s\n' "$what" "$(printf '%s' "$out" | tail -n 1)"
      bad=1
    fi
  }
  free() {
    local what="$1"
    shift
    if "$@" >/dev/null 2>&1; then
      printf '  • %s уже есть — create его пропустит\n' "$what"
    else
      printf '  ✓ %s — имя свободно\n' "$what"
    fi
  }

  say "профиль yc"
  folder="$(yc config get folder-id 2>/dev/null || true)"
  if [ -z "$folder" ]; then
    echo "  ✗ каталог не выбран — выполните yc init (облако, каталог, зона $ZONE)"
    exit 1
  fi
  check "каталог" sh -c "yc resource-manager folder get $folder --format json | $PYTHON -c 'import json,sys; d=json.load(sys.stdin); print(d[\"name\"], d[\"id\"])'"
  check "облако" sh -c "yc config get cloud-id"

  say "сеть и образ"
  check "сеть $NETWORK" sh -c "yc vpc network get --name $NETWORK --format json | $PYTHON -c 'import json,sys; print(json.load(sys.stdin)[\"id\"])'"
  check "подсеть $SUBNET в зоне $ZONE" sh -c "yc vpc subnet get --name $SUBNET --format json | $PYTHON -c 'import json,sys; d=json.load(sys.stdin); assert d[\"zone_id\"] == \"$ZONE\", \"подсеть в зоне \" + d[\"zone_id\"]; print(d[\"v4_cidr_blocks\"][0])'"
  check "образ $IMAGE_FAMILY" sh -c "yc compute image get-latest-from-family $IMAGE_FAMILY --folder-id standard-images --format json | $PYTHON -c 'import json,sys; d=json.load(sys.stdin); print(d[\"name\"])'"

  say "ключ SSH"
  check "$SSH_KEY" sh -c "test -f '$SSH_KEY' && ssh-keygen -lf '$SSH_KEY' | cut -d' ' -f2"

  say "имена ресурсов"
  free "группа $SG" yc vpc security-group get --name "$SG"
  free "адрес $ADDRESS" yc vpc address get --name "$ADDRESS"
  free "ВМ $NAME" yc compute instance get --name "$NAME"

  if [ "$bad" = 0 ]; then
    printf '\nОблако готово. Дальше: %s plan, затем APPLY=1 %s create\n' "$0" "$0"
  else
    printf '\nЕсть ошибки — create с ними упадёт. Сеть и подсеть по умолчанию: yc vpc network list, yc vpc subnet list\n' >&2
    exit 1
  fi
}

plan_create() {
  say "группа безопасности $SG — наружу открыты только 22, 80 и 443"
  if exists yc vpc security-group get --name "$SG"; then
    echo "  уже есть — пропускаем"
  else
    # у исходящего правила порт обязателен и для protocol=any: без port=any yc отказывает (27.09)
    run yc vpc security-group create --name "$SG" --network-name "$NETWORK" \
      --rule "direction=ingress,port=22,protocol=tcp,v4-cidrs=[$ADMIN_CIDRS]" \
      --rule "direction=ingress,port=80,protocol=tcp,v4-cidrs=[0.0.0.0/0]" \
      --rule "direction=ingress,port=443,protocol=tcp,v4-cidrs=[0.0.0.0/0]" \
      --rule "direction=egress,port=any,protocol=any,v4-cidrs=[0.0.0.0/0]"
  fi

  # в режиме плана подставляем понятную заглушку, в режиме создания — настоящее значение
  local sg_id="<id группы $SG>"
  if [ -n "${APPLY:-}" ]; then
    sg_id=$(yc vpc security-group get --name "$SG" --format json | field 'd["id"]')
  fi

  say "ВМ $NAME — 2 vCPU (100 %), 8 ГБ, $DISK_GB ГБ network-ssd, Ubuntu 24.04 LTS"
  if exists yc compute instance get --name "$NAME"; then
    echo "  уже есть — пропускаем"
  else
    run yc compute instance create --name "$NAME" --zone "$ZONE" --platform standard-v3 \
      --cores 2 --core-fraction 100 --memory 8G \
      --create-boot-disk "type=network-ssd,size=${DISK_GB}G,image-family=$IMAGE_FAMILY,image-folder-id=standard-images" \
      --network-interface "subnet-name=$SUBNET,nat-ip-version=ipv4,security-group-ids=$sg_id" \
      --ssh-key "$SSH_KEY"
  fi

  # Адрес — тот, что облако выдало ВМ, закреплённый как статический, а не зарезервированный заранее.
  # 27.09: оба заранее зарезервированных адреса (yc vpc address create, пулы 51.250.x и 62.84.x) снаружи
  # отвечали с 4 узлов check-host.net из 40 даже при группе «разрешено всё», а выданный ВМ временный
  # 111.88.x — с 35 из 40. Закреплённый адрес переживает остановку ВМ по графику.
  say "адрес ВМ — закрепляем статическим ($ADDRESS)"
  if [ -z "${APPLY:-}" ]; then
    run yc vpc address update --id "<id адреса ВМ>" --reserved=true --new-name "$ADDRESS"
  elif yc vpc address get --name "$ADDRESS" >/dev/null 2>&1; then
    echo "  уже закреплён: $(yc vpc address get --name "$ADDRESS" --format json | field 'd["external_ipv4_address"]["address"]')"
  else
    local ip addr_id
    ip=$(external_address)
    addr_id=$(yc vpc address list --format json |
      field "[a['id'] for a in d if (a.get('external_ipv4_address') or {}).get('address') == '$ip'][0]")
    run yc vpc address update --id "$addr_id" --reserved=true --new-name "$ADDRESS"
    echo "  проверьте доступность снаружи: nc -z -w 5 $ip 22 (или check-host.net → TCP)"
  fi

  cat <<EOF

Дальше:
  $0 bootstrap                     # код на ВМ: deploy-ключ только на чтение, git clone в /opt/inspector
  $0 ssh sudo /opt/inspector/infra/stand/setup.sh   # Docker, секреты, запуск, таймеры, проверка

Стоимость по ADR-0007: около 5,94 ₽/час пока ВМ работает и около 1,25 ₽/час пока остановлена
(диск и адрес). График: с 27.09 до 23.10 работает непрерывно — около 3 800 ₽ из квоты 5 000 ₽.
EOF
}

# Репозиторий приватный: ВМ читает его своим deploy-ключом (только чтение), а не нашими токенами.
# Первый запуск создаёт ключ на ВМ и печатает его; после добавления ключа в репозиторий повторный
# запуск клонирует код, а на уже склонированном — подтягивает main.
bootstrap() {
  say "ждём SSH на ВМ (облачная инициализация — до пары минут)"
  local i
  for i in $(seq 1 18); do
    remote true 2>/dev/null && break
    [ "$i" = 18 ] && {
      echo "ВМ не отвечает по SSH 3 минуты: $0 status, ключ $SSH_KEY" >&2
      exit 1
    }
    sleep 10
  done
  echo "  есть"

  say "код на ВМ"
  # сценарий для ВМ — в переменную: heredoc внутри $(…) bash 3.2 на macOS разбирает ненадёжно
  local script out
  read -r -d '' script <<'VM' || true
set -euo pipefail
repo="$1"
key=/root/.ssh/inspector_deploy
command -v git >/dev/null || { apt-get update -q >&2 && apt-get install -y -q git >&2; }
[ -f "$key" ] || ssh-keygen -t ed25519 -N "" -C "inspector-stand-deploy" -f "$key" -q
export GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if ! git ls-remote "$repo" HEAD >/dev/null 2>&1; then
  cat "$key.pub"
  exit 3
fi
if [ -d /opt/inspector/.git ]; then
  git -C /opt/inspector fetch -q origin
  git -C /opt/inspector merge -q --ff-only origin/main
else
  git clone -q "$repo" /opt/inspector
  git -C /opt/inspector config core.sshCommand "ssh -i $key -o IdentitiesOnly=yes"
fi
git -C /opt/inspector log -1 --format='/opt/inspector — %h %s'
VM
  if out="$(remote sudo bash -s -- "$REPO" <<<"$script")"; then
    echo "  $out"
    printf '\nДальше: %s ssh sudo /opt/inspector/infra/stand/setup.sh\n' "$0"
  else
    local rc=$?
    [ "$rc" = 3 ] || exit "$rc"
    cat <<EOF
  ВМ не видит репозиторий. Ключ ВМ (добавить как deploy key, только чтение):

  $out

  gh repo deploy-key add - --title "$NAME (Yandex Cloud)" <<< '$out'
  (или GitHub → Settings → Deploy keys → Add), затем повторите: $0 bootstrap
EOF
    exit 1
  fi
}

need_yc
case "${1:-plan}" in
preflight)
  preflight
  ;;
plan)
  APPLY=""
  plan_create
  ;;
create)
  [ -n "${APPLY:-}" ] || {
    echo "это платные действия: посмотрите план ($0 plan), затем повторите с APPLY=1" >&2
    exit 1
  }
  plan_create
  ;;
bootstrap)
  bootstrap
  ;;
start)
  # без APPLY: ВМ и адрес уже оплачиваются, запуск новых ресурсов не создаёт (раньше через run —
  # без APPLY=1 команда только печаталась)
  yc compute instance start --name "$NAME"
  ;;
stop)
  # по графику ADR-0007: остановленная ВМ стоит около 1,25 ₽/час, данные в диске сохраняются
  yc compute instance stop --name "$NAME"
  ;;
status)
  instance_json | field 'd["name"] + " — " + d["status"] + ", " + d["network_interfaces"][0]["primary_v4_address"].get("one_to_one_nat", {}).get("address", "без внешнего адреса")'
  ;;
ip)
  external_address
  ;;
snapshot)
  # один снимок после настройки (ADR-0007): ежедневные снимки диска дороже ночных копий базы.
  # Снимок платный — выполняется только с APPLY=1, без него команда печатается
  run yc compute snapshot create --disk-id "$(instance_json | field 'd["boot_disk"]["disk_id"]')" \
    --name "$NAME-$(date +%Y%m%d)"
  ;;
logins)
  # Свои адреса — сама ВМ (служебные входы скриптов) и те, кому открыт SSH в группе безопасности:
  # остальные в выводе помечены звёздочкой — так видно, когда пришла экспертиза.
  shift
  own="$(external_address)"
  own="$own,$(yc vpc security-group get --name "$SG" --format json | field '",".join(c.split("/")[0] for r in d["rules"] if (r.get("ports") or {}).get("from_port") == "22" for c in r["cidr_blocks"]["v4_cidr_blocks"] if c.endswith("/32"))')"
  exec ssh "${SSH_OPTS[@]}" -t "yc-user@$(external_address)" sudo STAND_OWN_IPS="${STAND_OWN_IPS:-$own}" /opt/inspector/scripts/stand-logins.sh "$@"
  ;;
ssh)
  # ssh [команда] — всё после ssh уходит командой на ВМ; -t — чтобы sudo и setup.sh видели терминал
  shift
  exec ssh "${SSH_OPTS[@]}" -t "yc-user@$(external_address)" "$@"
  ;;
*)
  echo "использование: $0 preflight|plan|create|bootstrap|status|ip|start|stop|snapshot|logins|ssh" >&2
  exit 1
  ;;
esac
