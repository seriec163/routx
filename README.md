# RoutX

Централизованное управление парком роутеров OpenWrt с продуктами
**Tachyon**, **Forkop**, **Prokop** и **Podkop**: шаблоны конфигурации,
подписки и подключения, мониторинг, диагностика, снимки с откатом, задания,
обновление агентов и смена продукта на роутере.

RoutX не заменяет продукт на роутере без команды: он работает поверх
установленного продукта и меняет его только при явной смене/переустановке
из панели.

## Возможности

* **Один роутер — один продукт**: Tachyon, Forkop, Prokop или Podkop.
* **Смена и переустановка продукта** из панели с переносом настроек,
  списков, подписок и подключений.
* **Каталог версий** из GitHub Releases. Для Tachyon можно выбрать версию;
  Forkop, Prokop и Podkop ставятся официальным установщиком (последняя
  версия).
* **Список установленных пакетов** на роутере и удаление лишних пакетов.
* **SSH-установщик RoutX** находит несколько продуктов, показывает версии и
  пакеты, позволяет выбрать активный продукт и удаляет остальные вместе с
  конфигами, состоянием и nft-таблицами.
* **Подписки и VLESS**: Tachyon хранит подписку как native
  `outbound_source`, Forkop/Prokop — как `subscription_url`, Podkop — как
  отдельные ссылки.
* **Шаблоны и правила**: встроенные списки, домены, подсети,
  пользовательские списки, секции и действия.
* **Мониторинг**: health, proxy health, задержка, direct/VPN IP, история.
* **Диагностика** quick/full, отчёты и скачивание.
* **Снимки и откат** перед изменениями.
* **Асинхронные задания** с прогрессом, таймаутами и журналом.
* **Обновление агентов** из панели для версий 1.5.0+; более старые —
  один раз вручную.
* **PWA и мобильный интерфейс**, push-уведомления, QR-вход.

## Требования

### Сервер с Docker

* Docker 24+ и Docker Compose v2;
* 2 ГБ RAM;
* **5 ГБ свободного диска минимум, 10 ГБ рекомендуется с запасом** — под
  Docker-образы, build cache, PostgreSQL, бэкапы и логи.
* для HTTPS — домен и открытые порты 80/443 (Caddy).

### Сервер без Docker

* Node.js 22.12+ (рекомендуется 24 LTS);
* PostgreSQL 16;
* `npm` и стандартные build-инструменты;
* reverse proxy (Caddy/nginx) для HTTPS, если нужен публичный доступ.

### Роутер

* OpenWrt 24.10.x (opkg) или 25.12+ (apk);
* архитектура `aarch64_cortex-a53` или `aarch64_generic`;
* установленный Tachyon/Forkop/Prokop/Podkop либо установка продукта через
  установщик RoutX;
* для Podkop — OpenWrt 24.10+ и достаточно свободного места (обычно 25+ МБ).

## Установка с Docker

Примерный расход на небольшой парк:

| Компонент | Размер |
|---|---|
| Образ приложения | ~220–340 МБ |
| PostgreSQL + Caddy + базовые образы | ~500–800 МБ |
| PostgreSQL с данными и историей | ~100 МБ на несколько роутеров, растёт с retention |
| Docker build cache | 1–3 ГБ во время сборки, можно очистить `docker builder prune` |
| Бэкапы и логи | зависит от retention и включается отдельно |

Поэтому 5 ГБ обычно достаточно, а 10 ГБ — спокойный запас на обновления,
пересборки и бэкапы.

```sh
git clone https://gitlab.com/artur.utenkov/router-control.git
cd router-control
cp .env.example .env
```

Сгенерируйте ключ шифрования:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

В `.env` задайте как минимум:

```dotenv
NODE_ENV=production
POSTGRES_PASSWORD=<длинный пароль без спецсимволов URL>
RC_MASTER_KEY=<сгенерированный ключ, 32+ символа>
RC_PUBLIC_URL=http://localhost:3000
RC_BIND_ADDR=127.0.0.1
RC_PORT=3000

# Первый администратор (создаётся при старте)
RC_BOOTSTRAP_EMAIL=admin@example.com
RC_BOOTSTRAP_PASSWORD=<пароль не короче 12 символов>
```

Запуск:

```sh
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/readyz
```

Панель: `http://127.0.0.1:3000`. Контейнер `app` сам применяет миграции при
старте.

### HTTPS через Caddy

Задайте в `.env`:

```dotenv
RC_PUBLIC_URL=https://routx.example.com
RC_COOKIE_SECURE=true
TRUST_PROXY=true
RC_DOMAIN=routx.example.com
RC_TLS_MODE=admin@example.com
```

И запустите с профилем `proxy`:

```sh
docker compose --profile proxy up -d --build
```

`RC_TLS_MODE=internal` подходит только для локальной проверки; для публичного
домена указывайте e-mail для Let's Encrypt.

### Обновление Docker-установки

```sh
git pull
docker compose --profile proxy up -d --build
```

Тома `router-control_pgdata`, `router-control_rc_data`,
`router-control_caddy_data` сохраняют базу, ключи и сертификаты.

## Установка без Docker

Нужны Node.js 22.12+ и PostgreSQL 16.

```sh
git clone https://gitlab.com/artur.utenkov/router-control.git
cd router-control
cp .env.example .env
npm ci
```

В `.env` задайте:

```dotenv
NODE_ENV=production
DATABASE_URL=postgres://router_control:<пароль>@127.0.0.1:5432/router_control
RC_MASTER_KEY=<сгенерированный ключ, 32+ символа>
RC_PUBLIC_URL=https://routx.example.com
RC_COOKIE_SECURE=true
TRUST_PROXY=true
RC_BIND_ADDR=127.0.0.1
RC_PORT=3000
RC_BOOTSTRAP_EMAIL=admin@example.com
RC_BOOTSTRAP_PASSWORD=<пароль не короче 12 символов>
```

Примените миграции и соберите проект:

```sh
npm run db:migrate
npm run build
```

Запуск production-сервера:

```sh
npm run start
```

Сервер отдаёт API и собранную SPA из `web/dist`. Для HTTPS поставьте перед
ним Caddy или nginx и проксируйте на `127.0.0.1:3000`.

Для разработки:

```sh
# PostgreSQL должен быть запущен
npm run dev
# SPA: http://127.0.0.1:5173
# API: http://127.0.0.1:3000
```

### Сборка пакетов агента без Docker

```sh
npm run agent:build
```

Пакеты появятся в `agent/dist/` и будут раздаваться панелью по адресам
`/agent/routx-agent.ipk`, `/agent/routx-agent.apk`, `/agent/routx-agent.version`.

### Обновление без Docker

```sh
git pull
npm ci
npm run db:migrate
npm run build
# перезапустите процесс routx (systemd/pm2/supervisor)
```

## Установка агента на роутер

1. Добавьте роутер в панели.
2. Скопируйте команду установки.
3. Выполните её на роутере по SSH.

Если на роутере уже есть несколько продуктов, установщик покажет:

```text
На роутере найдено несколько продуктов:
  1) Forkop 1.0.5
     пакеты: forkop luci-app-forkop luci-i18n-forkop-ru sing-box-forkop
  2) Tachyon 1.7.12
     пакеты: tachyon luci-app-tachyon luci-i18n-tachyon-ru tachyon-core
Какой продукт оставить активным? [1]:
```

Выбранный продукт остаётся, остальные удаляются вместе с пакетами,
конфигами, состоянием, LuCI-файлами, cron-заданиями и nft-таблицами.
Для автоматического выбора:

```sh
wget -qO- https://routx.example.com/agent/install.sh | sh -s -- \
  --server https://routx.example.com \
  --token <token> \
  --keep tachyon
```

Обновление агентов — на странице «Развёртывание и перенос». Агенты 1.5.0+
обновляются из панели; более старые нужно один раз обновить вручную.

## CI и пайплайны

В репозитории есть:

* `.gitlab-ci.yml` — `verify` (typecheck, тесты, сборка, миграции,
  agent-пакеты) и `docker` (сборка образа);
* `.github/workflows/ci.yml` — аналогичная проверка и runtime smoke-тест.

Если GitLab показывает **«Before you can run pipelines, we need to verify
your account»**, пайплайны блокируются настройками GitLab, а не кодом.
Варианты:

* подтвердить учётную запись GitLab;
* запустить проверки локально:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run db:migrate
npm run agent:build
```

* использовать GitHub Actions, если репозиторий зеркалируется на GitHub.

## Документация

* [`docs/runbooks/self-hosting.md`](docs/runbooks/self-hosting.md) — свой
  сервер, домен, HTTPS, первый вход.
* [`docs/runbooks/agent-packages.md`](docs/runbooks/agent-packages.md) —
  установка, обновление и удаление агента, выбор активного продукта.
* [`docs/runbooks/products-and-versions.md`](docs/runbooks/products-and-versions.md) —
  продукты, версии, установленные пакеты и переустановка.
* [`docs/runbooks/phase-1.md`](docs/runbooks/phase-1.md) — запуск и
  диагностика.
* [`docs/runbooks/backup-and-key-rotation.md`](docs/runbooks/backup-and-key-rotation.md) —
  бэкапы и ротация ключа.
* [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) —
  архитектура.
* [`docs/architecture/API.md`](docs/architecture/API.md) — API и протокол
  агента.

## Структура репозитория

```text
server/            Fastify + TypeScript: API, задания, агент-шлюз, миграции
server/migrations/ SQL-миграции
server/test/       Vitest
web/               React + Vite SPA и PWA
agent/             ucode-агент для OpenWrt и сборка пакетов
docs/              архитектура и runbook'и
deploy/            примеры развёртывания, включая OpenWrt + Caddy
.github/           GitHub Actions
.gitlab-ci.yml     GitLab CI
Dockerfile         production-образ
docker-compose.yml PostgreSQL + app + Caddy (профиль proxy)
```

## Лицензия

Файл лицензии в репозитории не добавлен. По умолчанию действует режим
«все права защищены». Если нужна открытая лицензия, добавьте её явно
(например, MIT или Apache-2.0).
