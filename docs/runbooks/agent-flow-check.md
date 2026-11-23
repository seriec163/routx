# Проверка пути установки без роутера

Скрипт `scripts/fake-agent-check.mjs` проходит тот же путь, что реальный агент
после установки:

1. вход в панель;
2. создание временного роутера и binding-token;
3. `bind` с эмулятором агента;
4. подписанный `probe`;
5. `refresh_state` (агент отвечает `read_state`);
6. проверка `sections`, `managed_section` и статуса `online`;
7. удаление временного роутера.

Запуск:

```bash
ROUTX_URL=https://routx.example.com \
ROUTX_EMAIL=admin@example.com \
ROUTX_PASSWORD='пароль' \
npm run verify:agent-flow
```

Если 2FA включена, используйте готовую сессию:

```bash
npm run verify:agent-flow -- \
  --base https://routx.example.com \
  --session "$RC_SESSION" --csrf "$RC_CSRF"
```

Флаги:

* `--keep` — не удалять временный роутер (для разбора через UI);
* `--name` — имя роутера.

Код выхода `0` — путь работает; `1` — на каком-то шаге ошибка, в выводе будет
метод, путь и тело ответа.

Скрипт удобно запускать после переноса панели и после обновления, которое
меняет `probe`/`read_state`. В будущем он же станет основой интеграционного
теста в CI (с Postgres и поднятым приложением).

## Проверка self-update на живом роутере

Обновление агента затрагивает `apk`/`opkg` на устройстве, поэтому проверяется
на реальном роутере. Схема безопасная: панель временно начинает отдавать новый
пакет из каталога данных, затем обновляется один роутер.

1. Собрать агент в Linux (на Windows `.apk` не собирается):

   ```bash
   tar -czf agent.tgz --exclude=dist agent
   scp agent.tgz root@panel:/opt/
   ssh root@panel
   mkdir -p /opt/routx-agent-build && tar -xzf /opt/agent.tgz -C /opt/routx-agent-build
   docker run --rm -v /opt/routx-agent-build/agent:/src -w /src node:24-alpine node build.mjs
   ```

2. Положить `dist` в том `rc_data` и временно указать панели новый каталог:

   ```bash
   docker cp /opt/routx-agent-build/agent/dist routx-app-1:/app/data/agent-dist
   # в docker-compose.yml сервиса app:
   #   RC_AGENT_DIST: /app/data/agent-dist
   docker compose up -d app
   curl -s https://<домен>/agent/routx-agent.version
   ```

3. Поставить `agent_update` для одного роутера (через UI «Обновления агентов»
   или `POST /api/v1/deploy/agent-update`).

4. Проверить: `routers.agent_version` сменился, роутер `online`, в
   `/var/log/routx-agent-update.log` строка `rc=0 ... verified=ok`.

5. Вернуть `RC_AGENT_DIST` (или оставить каталог, если версия раскатывается на
   весь парк) и перезапустить `app`.

Если версия не сменилась за отведённое время: смотреть
`/var/log/routx-agent-update.log` на роутере, проверить свободное место и
блокировку `apk`. Скрипт сам перезапускает агент даже при ошибке установки,
поэтому связь с панелью не теряется.

