# Выкатка образа панели (ветка / тест)

Как безопасно поставить на панель образ, собранный из ветки (например,
`routx-2.0`), не откатываясь на старый `:latest`.

## 1. Собрать образ на панели

Исходники складываются в отдельный каталог, чтобы не трогать рабочий
`/opt/routx`:

```bash
tar -czf routx-src.tgz -C <repo> server web agent package.json package-lock.json Dockerfile
scp routx-src.tgz root@panel:/opt/
ssh root@panel
rm -rf /opt/routx-build && mkdir -p /opt/routx-build
tar -xzf /opt/routx-src.tgz -C /opt/routx-build
cd /opt/routx-build
docker build --build-arg RC_BUILD_SHA=<short-sha> -t routx:<tag> .
```

Тег лучше делать с sha: `routx:2.0-4c5b478`. Так видно, что именно запущено.

## 2. Зафиксировать образ

В `/opt/routx/.env` (или в окружении compose) задать:

```env
ROUTX_IMAGE=routx:2.0-4c5b478
```

Это важно: в compose образ задан как `${ROUTX_IMAGE:-...:latest}`. Если
переменная не задана, `docker compose up -d app` возьмёт `:latest` и может
откатить панель на старый образ — пропадут новые разделы.

## 3. Пересоздать только приложение

```bash
cd /opt/routx
docker compose --env-file /opt/routx/.env -p routx up -d app
```

Caddy и БД при этом не перезапускаются.

## 4. Проверить

```bash
curl -s https://<домен>/healthz          # build = <short-sha>
curl -s https://<домен>/metrics | head   # должны быть routx_* метрики
curl -s https://<домен>/agent/routx-agent.version
```

В UI:

* «Развёртывание» → `GET /api/v1/deploy/verify` (`ok: true`);
* «Логи и ошибки» — есть колонки «Действие» и «Итог»;
* карточка роутера — Wi-Fi читается, вкладки на месте.

## 5. Откат

```bash
cd /opt/routx
ROUTX_IMAGE=ghcr.io/seriec163/routx:sha-376a933 \
  docker compose --env-file /opt/routx/.env -p routx up -d app
```

Проверить `/healthz` и что нужные маршруты вернулись. Данные в томах
(`routx_rc_data`, `routx_pgdata`) при смене образа не меняются.
