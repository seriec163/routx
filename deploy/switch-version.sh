#!/bin/sh
# Переключение панели между версиями образов с автоматическим откатом.
#
#   ./switch-version.sh routx:2.1.0 --expect-version 2.1.0
#   ./switch-version.sh routx:2.0.0
#   ./switch-version.sh routx:2.1.0 --dry-run
#
# Скрипт меняет только ROUTX_IMAGE в .env и пересоздаёт сервис app.
# Caddy и база не перезапускаются. При ошибке возвращает предыдущий образ.

set -eu

ROUTX_DIR=${ROUTX_DIR:-/opt/routx}
PROJECT=${COMPOSE_PROJECT:-routx}
ENV_FILE="$ROUTX_DIR/.env"
COMPOSE_FILE="$ROUTX_DIR/docker-compose.yml"
HISTORY="$ROUTX_DIR/version-history.log"
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3000/healthz}
READY_URL=${READY_URL:-http://127.0.0.1:3000/readyz}

TARGET=""
EXPECT_VERSION=""
DRY_RUN=0
ALLOW_SCHEMA=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --expect-version) EXPECT_VERSION=${2:-}; shift 2 ;;
    --allow-schema-change) ALLOW_SCHEMA=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --*) echo "Неизвестный флаг: $1" >&2; exit 2 ;;
    *) TARGET="$1"; shift ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "Укажите образ: switch-version.sh routx:2.1.0" >&2
  exit 2
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Нет $ENV_FILE" >&2
  exit 2
fi

CURRENT=$(grep '^ROUTX_IMAGE=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
CURRENT=${CURRENT:-<не задан>}

if ! docker image inspect "$TARGET" >/dev/null 2>&1; then
  echo "Образ $TARGET не найден локально." >&2
  echo "Соберите его: ./build-version.sh <version> <source-dir> <git-sha>" >&2
  exit 2
fi

APP_ID=$(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" ps -q app 2>/dev/null || true)
old_schema=""
if [ -n "$APP_ID" ]; then
  old_schema=$(curl -fsS "$READY_URL" 2>/dev/null | sed -n 's/.*"schema_version":"\([^"]*\)".*/\1/p' || true)
fi

echo "Текущий образ: $CURRENT"
echo "Новый образ:   $TARGET"
echo "Схема БД:      ${old_schema:-неизвестно}"
[ -n "$EXPECT_VERSION" ] && echo "Ожидаемая версия: $EXPECT_VERSION"

if [ "$CURRENT" = "$TARGET" ]; then
  echo "Уже запущен $TARGET — переключение не нужно."
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY-RUN: изменил бы ROUTX_IMAGE на $TARGET и пересоздал app."
  exit 0
fi

BACKUP="$ENV_FILE.bak-switch-$(date +%Y%m%d%H%M%S)"
cp "$ENV_FILE" "$BACKUP"

set_image() {
  IMAGE=$1
  if grep -q '^ROUTX_IMAGE=' "$ENV_FILE"; then
    sed -i "s#^ROUTX_IMAGE=.*#ROUTX_IMAGE=$IMAGE#" "$ENV_FILE"
  else
    printf '\nROUTX_IMAGE=%s\n' "$IMAGE" >> "$ENV_FILE"
  fi
}

wait_health() {
  i=0
  while [ "$i" -lt 60 ]; do
    id=$(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" ps -q app 2>/dev/null || true)
    if [ -n "$id" ]; then
      status=$(docker inspect "$id" --format '{{.State.Health.Status}}' 2>/dev/null || echo starting)
      [ "$status" = "healthy" ] && return 0
    fi
    sleep 2
    i=$((i + 1))
  done
  return 1
}

recreate() {
  cd "$ROUTX_DIR"
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -p "$PROJECT" up -d app
}

rollback() {
  echo "Откат на $CURRENT..." >&2
  if [ "$CURRENT" = "<не задан>" ]; then
    cp "$BACKUP" "$ENV_FILE"
  else
    set_image "$CURRENT"
  fi
  recreate >/dev/null 2>&1 || true
  wait_health && echo "Откат выполнен, панель здорова." >&2 || echo "Откат выполнен, но health не подтверждён." >&2
}

echo "Переключаю..."
set_image "$TARGET"
if ! recreate; then
  echo "Не удалось пересоздать app." >&2
  rollback
  exit 1
fi

if ! wait_health; then
  echo "Новый контейнер не стал healthy." >&2
  rollback
  exit 1
fi

health=$(curl -fsS "$HEALTH_URL" 2>/dev/null || true)
echo "health: $health"

new_version=$(printf '%s' "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$EXPECT_VERSION" ] && [ "$new_version" != "$EXPECT_VERSION" ]; then
  echo "Версия $new_version не совпала с ожидаемой $EXPECT_VERSION." >&2
  rollback
  exit 1
fi

new_schema=$(curl -fsS "$READY_URL" 2>/dev/null | sed -n 's/.*"schema_version":"\([^"]*\)".*/\1/p' || true)
if [ -n "$old_schema" ] && [ -n "$new_schema" ] && [ "$old_schema" != "$new_schema" ] && [ "$ALLOW_SCHEMA" != "1" ]; then
  echo "Схема БД изменилась: $old_schema -> $new_schema." >&2
  echo "Откат старого образа может быть несовместим. Повторите с --allow-schema-change, если уверены." >&2
  rollback
  exit 3
fi

printf '%s %s -> %s ok version=%s schema=%s\n' \
  "$(date -Iseconds 2>/dev/null || date)" "$CURRENT" "$TARGET" "${new_version:-?}" "${new_schema:-?}" >> "$HISTORY"
echo "Готово: $TARGET (версия ${new_version:-?})."
