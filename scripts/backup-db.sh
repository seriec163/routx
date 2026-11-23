#!/bin/sh
# Шифрованный дамп PostgreSQL для RoutX.
# Запускается в контейнере backup (postgres:16-alpine + openssl).
set -eu

umask 077

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DATABASE="${PGDATABASE:-router_control}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="${BACKUP_DIR}/.router_control-${STAMP}.dump"
OUT="${BACKUP_DIR}/router_control-${STAMP}.dump.enc"

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "BACKUP_PASSPHRASE не задан" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"

echo "Создаю дамп ${DATABASE}…"
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file "$TMP" \
  "$DATABASE"

echo "Проверяю целостность дампа…"
pg_restore --list "$TMP" >/dev/null

echo "Шифрую…"
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in "$TMP" \
  -out "$OUT" \
  -pass env:BACKUP_PASSPHRASE

rm -f "$TMP"
chmod 600 "$OUT"

echo "Удаляю локальные копии старше ${RETENTION_DAYS} дней…"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'router_control-*.dump.enc' \
  -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true

if [ -n "${BACKUP_OFFSITE_CMD:-}" ]; then
  echo "Отправляю offsite…"
  export BACKUP_FILE="$OUT"
  sh -c "$BACKUP_OFFSITE_CMD"
else
  echo "BACKUP_OFFSITE_CMD не задан: копия осталась только локально"
fi

echo "Готово: ${OUT} ($(du -h "$OUT" | cut -f1))"
