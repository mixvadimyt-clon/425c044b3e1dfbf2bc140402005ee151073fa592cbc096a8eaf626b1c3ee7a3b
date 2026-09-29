#!/usr/bin/env bash
# Ночная копия базы стенда без остановки api (ADR-0007): SQLite «VACUUM INTO» в том data, хранятся последние KEEP копий.
# Файлы комплектов не копируем: они лежат по sha256 и восстанавливаются повторной загрузкой.
# cron на ВМ:  15 3 * * *  cd /opt/inspector && ./scripts/stand-backup.sh >> var/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP="${KEEP:-3}"
COMPOSE=(docker compose -f docker-compose.app.yml)
# без .env.stand compose обрывается на JWT_SECRET и INTERNAL_TOKEN — они объявлены как ${VAR:?…},
# и это касается любой команды, включая exec. В CI переменные приходят из окружения, файла там нет.
if [ -f .env.stand ]; then COMPOSE+=(--env-file .env.stand); fi
NAME="inspector-$(date +%Y%m%d-%H%M%S).sqlite"
"${COMPOSE[@]}" exec -T api sh -c "mkdir -p /data/backup && node --disable-warning=ExperimentalWarning -e \"
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync('/data/inspector.sqlite').exec(\\\"VACUUM INTO '/data/backup/$NAME'\\\");
\" && cd /data/backup && ls -1t inspector-*.sqlite | tail -n +$((KEEP + 1)) | xargs -r rm -f && ls -lh /data/backup"
echo "$(date -Is) копия базы: /data/backup/$NAME"
