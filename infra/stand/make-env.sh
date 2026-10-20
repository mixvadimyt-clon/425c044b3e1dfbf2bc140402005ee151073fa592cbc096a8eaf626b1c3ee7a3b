#!/usr/bin/env bash
# Файл настроек стенда `.env.stand` со свежими секретами.
#
#   password=$(./infra/stand/make-env.sh [АДРЕС])
#
# АДРЕС — значение SITE_ADDRESS: «:80» (по умолчанию) — без TLS; доменное имя — Caddy выпустит
# на него сертификат Let's Encrypt.
#
# Идемпотентен: если файл уже есть, он не перезаписывается — секреты рождаются один раз, на той
# машине, где работает стенд, и никуда с неё не уезжают. Пароль демо-пользователей уходит в stdout
# одной строкой (вызывающий решает, как его показать), всё остальное — в stderr.
set -euo pipefail
cd "$(dirname "$0")/../.."

SITE="${1:-:80}"
ENV_FILE="${ENV_FILE:-.env.stand}"

# openssl есть не в каждом окружении, поэтому запасной путь через /dev/urandom
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    od -An -tx1 -N "$1" /dev/urandom | tr -d ' \n'
  fi
}

if [ -f "$ENV_FILE" ]; then
  printf '%s уже есть — секреты не трогаем\n' "$ENV_FILE" >&2
  sed -n 's/^DEMO_PASSWORD=//p' "$ENV_FILE"
  exit 0
fi

# 16 шестнадцатеричных цифр: пароль набирают руками, поэтому без символов, которые
# путаются в консоли и в мессенджере
demo_password="$(rand_hex 8)"
umask 077
sed \
  -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$SITE|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=$(rand_hex 32)|" \
  -e "s|^INTERNAL_TOKEN=.*|INTERNAL_TOKEN=$(rand_hex 32)|" \
  -e "s|^DEMO_PASSWORD=.*|DEMO_PASSWORD=$demo_password|" \
  -e "s|^RIN_TOKEN=.*|RIN_TOKEN=$(rand_hex 16)|" \
  -e "s|^RIN_SECRET=.*|RIN_SECRET=$(rand_hex 16)|" \
  -e "s|^GRAFANA_PASSWORD=.*|GRAFANA_PASSWORD=$(rand_hex 12)|" \
  infra/stand/stand.env.example >"$ENV_FILE"
chmod 600 "$ENV_FILE"
printf 'создан %s со свежими секретами (в git он не попадает)\n' "$ENV_FILE" >&2
printf '%s\n' "$demo_password"
