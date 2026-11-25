# Переключение версий панели

Версии фиксируются двумя способами:

* git-теги `v2.0.0`, `v2.1.0` и ветки `release/2.0`, `release/2.1`;
* Docker-образы `routx:<version>` (например, `routx:2.1.0`).

На сервере активная версия задаётся одной строкой в `/opt/routx/.env`:

```env
ROUTX_IMAGE=routx:2.1.0
```

## Сборка версии

```bash
# исходники версии распакованы, например, из git archive v2.1.0
/opt/routx/build-version.sh 2.1.0 /opt/routx-build-2.1.0 3c057a8
```

Скрипт соберёт `routx:2.1.0` с `RC_BUILD_SHA=3c057a8` (это значение видно в
`/healthz` как `build`).

## Переключение

```bash
# вперёд, с проверкой версии
/opt/routx/switch-version.sh routx:2.1.0 --expect-version 2.1.0

# назад
/opt/routx/switch-version.sh routx:2.0.0 --expect-version 2.0.0

# посмотреть план, ничего не менять
/opt/routx/switch-version.sh routx:2.1.0 --dry-run
```

Что делает скрипт:

1. проверяет, что образ есть локально;
2. сохраняет `.env` в бэкап;
3. меняет `ROUTX_IMAGE` и пересоздаёт только `app`;
4. ждёт `healthy` до 2 минут;
5. проверяет `/healthz` (и `--expect-version`, если задан);
6. сравнивает версию схемы БД до и после;
7. при любой ошибке сам возвращает предыдущий образ;
8. пишет строку в `/opt/routx/version-history.log`.

`Caddy` и `PostgreSQL` не перезапускаются, тома данных не меняются.

## Схема БД и откат

Если новая версия применила миграции, откат на старую может быть
несовместим. Скрипт заметит изменение `schema_version` и откатится **до**
подтверждения. Осознанный откат с изменением схемы:

```bash
/opt/routx/switch-version.sh routx:2.0.0 --allow-schema-change
```

Перед такими работами делайте резервную копию БД (см.
`backup-and-key-rotation.md`).

## Если что-то пошло не так вручную

```bash
cd /opt/routx
ROUTX_IMAGE=ghcr.io/seriec163/routx:sha-376a933 \
  docker compose --env-file .env -p routx up -d app
curl -s http://127.0.0.1:3000/healthz
```

Старые образы остаются локально, поэтому откат не требует сборки.

## Место на диске

Каждый образ RoutX занимает около 230 МБ, а промежуточные слои сборки —
больше. На NanoPI `/opt` всего 26 ГБ, и несколько сборок подряд заполняют
раздел: Postgres не может писать WAL, уходит в recovery, и переключение
падает с `container routx-db-1 is unhealthy`.

Перед серией сборок и после неё:

```bash
df -h /opt
docker image prune -f              # только dangling-слои, безопасно
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep routx:
# удалить старые теги, оставив текущий и предыдущий
rm -rf /opt/routx-build-<старая версия> /opt/routx-<старая версия>-src.tgz
```

Если база уже в recovery: освободить место и `docker restart routx-db-1`,
дождаться `healthy`, затем повторить `switch-version.sh`.
