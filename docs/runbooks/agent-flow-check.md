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
