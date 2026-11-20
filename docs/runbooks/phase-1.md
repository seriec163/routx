# Этап 1 — каркас, миграции, health-проверки, Compose

**Статус:** завершён. В поставку входят сервер Fastify 5 на Node.js 24/22, PostgreSQL 16,
React 19 SPA, SQL-миграции, Docker Compose, CI и этот runbook.

**Границы этапа:** только инфраструктура сервера. Этап не устанавливает, не переустанавливает
и не настраивает Forkop/Prokop, не открывает входящих портов на роутерах и не содержит
агента. Все команды ниже выполняются на сервере RoutX, а не на роутере.

---

## 1. Требования

| Компонент | Минимум | Примечание |
|---|---|---|
| Node.js | 22.12 | Docker-образ и CI используют Node.js 24 LTS |
| npm | 10 | поставляется с Node.js |
| PostgreSQL | 16 | локально, в Docker или внешний управляемый |
| Docker + Compose | Docker 24+, Compose v2 | основной способ поставки |
| Свободные порты | 3000 (приложение), 5432 (БД) | оба по умолчанию только на loopback |

Проверка:

```powershell
node -v          # v22.12+ или v24.x
npm -v
docker version
docker compose version
```

> На Windows Docker Engine работает только при запущенном Docker Desktop. Если команда
> `docker version` пишет `failed to connect to the docker API ... dockerDesktopLinuxEngine`,
> запустите Docker Desktop и дождитесь статуса Engine running. Запуск службы
> `com.docker.service` из обычной консоли может требовать прав администратора.

---

## 2. Быстрый старт для разработки

### 2.1. Конфигурация

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Полученную строку вставьте в `.env` как `RC_MASTER_KEY`. Остальные значения для локального
запуска уже подходят. `.env` не коммитится и исключён из Docker-образа.

Ключевые переменные:

| Переменная | Назначение |
|---|---|
| `DATABASE_URL` | строка подключения; для сервера на хосте — `127.0.0.1:5432` |
| `RC_MASTER_KEY` | ключ шифрования серверных секретов; в production обязателен, ≥ 32 символов |
| `POSTGRES_*` | параметры контейнера PostgreSQL |
| `RC_BIND_ADDR`, `RC_PORT` | публикация приложения; по умолчанию `127.0.0.1:3000` |
| `MIGRATE_ON_START` | применять миграции при старте процесса; в production `false` |
| `TRUST_PROXY` | доверять `X-Forwarded-*`; включайте только за доверенным прокси |

### 2.2. База данных

```powershell
docker compose up -d db
docker compose ps          # db должен стать healthy
```

Если 5432 занят, задайте в `.env` другой порт, например `POSTGRES_PORT=5433`, и измените
`DATABASE_URL` на `...@127.0.0.1:5433/router_control`.

### 2.3. Зависимости и миграции

```powershell
npm ci
npm run db:migrate
```

Ожидаемый вывод при первом запуске:

```text
применена миграция 0001_init.sql
Готово: применено миграций — 1
```

Повторный запуск идемпотентен:

```text
новых миграций нет
Готово: база уже актуальна
```

### 2.4. Запуск

```powershell
npm run dev
```

* SPA с горячей перезагрузкой — <http://127.0.0.1:5173>;
* API — <http://127.0.0.1:3000>;
* Vite проксирует `/healthz`, `/readyz` и `/api` на API.

Проверка API:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/healthz
Invoke-RestMethod http://127.0.0.1:3000/readyz
Invoke-RestMethod http://127.0.0.1:3000/api/v1/meta
```

Ожидаемые ответы:

```json
{"status":"ok","service":"routx","version":"0.1.0","uptime_s":1,"now":"..."}
{"status":"ready","version":"0.1.0","schema_version":"1","checks":{"db":"ok","schema":"ok"},"now":"..."}
{"name":"routx","version":"0.1.0","api_version":"v1","schema_version":"1"}
```

`/healthz` отвечает `200` даже при недоступной БД (это проверка живости процесса).
`/readyz` отвечает `503`, пока БД недоступна или миграции не применены. `/api/v1/meta`
также отвечает `503` без БД.

Остановка: `Ctrl+C` в терминале `npm run dev`. База остаётся в томе `routx_pgdata`;
остановить её — `docker compose stop db`.

---

## 3. Production через Docker Compose

### 3.1. Подготовка `.env`

```powershell
Copy-Item .env.example .env
```

Обязательно измените:

```dotenv
NODE_ENV=production
RC_MASTER_KEY=<32+ случайных символа, base64url>
POSTGRES_PASSWORD=<длинный пароль без спецсимволов, ломающих URL>
RC_BIND_ADDR=127.0.0.1
RC_PORT=3000
TRUST_PROXY=false
```

`POSTGRES_PASSWORD` подставляется в `DATABASE_URL`, поэтому используйте URL-безопасный
алфавит (`A-Z a-z 0-9 - _`) либо percent-encoding. Пароль из `.env.example` — только для
локальной разработки.

### 3.2. Сборка и запуск

```powershell
docker compose up -d --build
docker compose ps
```

Контейнер `app` при старте применяет миграции и затем запускает сервер
(`node server/dist/migrate-cli.js && node server/dist/index.js`). Повторный запуск безопасен.

Проверка:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/healthz
Invoke-RestMethod http://127.0.0.1:3000/readyz
Invoke-RestMethod http://127.0.0.1:3000/api/v1/meta
```

Логи и остановка:

```powershell
docker compose logs -f app
docker compose down            # данные PostgreSQL сохраняются в томе
```

> `docker compose down -v` **удаляет том с базой**. Не используйте эту команду на
> рабочем инстансе без резервной копии.

### 3.3. HTTPS через Caddy (необязательно)

Caddy включён профилем `proxy` и терминирует TLS. Приложение при этом остаётся на
loopback-порту 3000.

Для локальной проверки:

```dotenv
RC_DOMAIN=localhost
RC_TLS_MODE=internal
TRUST_PROXY=true
```

```powershell
docker compose --profile proxy up -d --build
```

Caddy выдаст сертификат локального CA; браузер предупредит о недоверенном издателе, пока
CA не добавлен в доверенные. Для публичного домена:

```dotenv
RC_DOMAIN=rc.example.com
RC_TLS_MODE=admin@example.com
TRUST_PROXY=true
```

Откройте в firewall только 80/tcp и 443/tcp. Порты 3000 и 5432 должны оставаться
недоступными из интернета.

> Caddy запускается после того, как `app` станет `healthy`. Если контейнер `app` не
> проходит healthcheck, `caddy` не стартует — смотрите `docker compose logs app`.

---

## 4. Полная проверка этапа

```powershell
npm ci
npm run typecheck      # сервер (src + тесты) и SPA
npm test               # 15 тестов
npm run build          # dist сервера и web/dist
npm audit              # 0 уязвимостей
docker compose config --quiet
```

Проверка миграций на реальном PostgreSQL 16 (локально или в контейнере):

```powershell
npm run db:migrate
npm run db:migrate
```

Проверка схемы:

```sql
select name from schema_migrations order by name;
select value from settings where key = 'schema_version';
select table_name from information_schema.tables
 where table_schema = 'public' order by table_name;
```

Ожидается:

```text
0001_init.sql
{"version": 1}
schema_migrations, settings
```

### Что проверено в этой поставке

* `npm run typecheck`, `npm test` (15 тестов), `npm run build` — успешно;
* `npm audit` — 0 уязвимостей;
* миграция `0001_init.sql` на PostgreSQL 16: первый запуск, повторный запуск, схема;
* реальные ответы `/healthz`, `/readyz`, `/api/v1/meta`, отдача SPA и fallback на `/routers`;
* `docker compose config --quiet` — конфигурация Compose валидна.

### Что требует Docker-демона на вашей машине

Сборка образа и запуск контейнеров (`docker compose up -d --build`) не выполнялись в среде
разработки, где Docker Engine был недоступен. Выполните команды §3.2–3.3 и убедитесь, что
`docker compose ps` показывает `healthy` для `app` и `db`.

---

## 5. Диагностика

| Симптом | Причина и действие |
|---|---|
| `failed to connect to the docker API` | Docker Desktop не запущен либо служба недоступна. Запустите Docker Desktop; при необходимости — от имени администратора. |
| `db` не становится `healthy` | `docker compose logs db`; проверьте `POSTGRES_PASSWORD`, свободен ли `POSTGRES_PORT`. |
| `/readyz` → `503`, `checks.db=error` | Неверный `DATABASE_URL`, БД не запущена или миграции не применены. |
| `/api/v1/meta` → `503` | То же: нет соединения с БД. |
| `schema_version: null` | Выполните `npm run db:migrate`. |
| `RC_MASTER_KEY обязателен...` | В production ключ отсутствует или короче 32 символов. Сгенерируйте новый. |
| SPA отдаёт 404 | Не выполнен `npm run build`; проверьте `WEB_DIST` и наличие `web/dist/index.html`. |
| Порт 3000 занят | Измените `RC_PORT`/`PORT`; для Vite — `server.port` в `web/vite.config.ts`. |
| Порт 5432 занят | `POSTGRES_PORT=5433` и соответствующий `DATABASE_URL`. |
| `npm audit` находит уязвимости | Обновите зависимости; не применяйте `npm audit fix --force` без проверки мажорных версий. |
| PowerShell не понимает `curl` | Используйте `curl.exe` или `Invoke-RestMethod`. |

Логи приложения в development — pino-pretty, в production — JSON в stdout.
Секреты в логи не пишутся.

---

## 6. Безопасность этапа

* Порт приложения по умолчанию публикуется только на `127.0.0.1`.
* PostgreSQL публикуется только на `127.0.0.1`.
* `RC_MASTER_KEY` обязателен в production; `.env` исключён из git и образа.
* Контейнер `app` работает от непривилегированного пользователя, с `read_only` и
  `no-new-privileges`.
* Выставляются CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`; API и health-ответы — `no-store`.
* `TRUST_PROXY` по умолчанию `false`; включайте только за доверенным reverse proxy.
* Аутентификации на этом этапе нет: не публикуйте порт 3000 в интернет до этапа 2.

---

## 7. Критерии приёмки этапа 1

- [x] Монорепозиторий собирается одной командой `npm run build`.
- [x] Сервер Fastify отдаёт `/healthz`, `/readyz`, `/api/v1/meta`.
- [x] SPA собирается и отдаётся сервером, включая fallback для клиентских маршрутов.
- [x] SQL-миграции применяются детерминированно и идемпотентно.
- [x] `schema_version` читается из БД.
- [x] Есть unit-тесты конфигурации и служебных эндпоинтов.
- [x] Docker Compose описывает `db`, `app` и необязательный `caddy`.
- [x] CI выполняет typecheck, тесты, сборку, миграции и smoke-тест.
- [x] Секреты не попадают в репозиторий и образ.
- [x] Документация запуска и проверки на русском языке.

---

## 8. Откат этапа

Этап 1 не меняет данные роутеров. Откат серверной части:

```powershell
docker compose down            # без -v: том PostgreSQL сохраняется
```

Для полного удаления тестового инстанса:

```powershell
docker compose down -v
```

Удаление тома уничтожает `schema_migrations` и `settings`. На рабочем инстансе сначала
сделайте резервную копию PostgreSQL. Миграция `0001_init.sql` обратима вручную
(`drop table settings; drop table schema_migrations;`), но автоматического down-скрипта нет.
