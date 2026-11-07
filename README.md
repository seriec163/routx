<p align="center">
  <img src="./assets/readme/hero.svg" alt="RoutX — панель управления роутерами OpenWrt" width="100%">
</p>

<p align="center">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22.12%2B-339933?logo=node.js&logoColor=white">
  <img alt="Docker" src="https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white">
  <img alt="OpenWrt" src="https://img.shields.io/badge/OpenWrt-24.10%20%7C%2025.12-00B5E2?logo=openwrt&logoColor=white">
  <img alt="Agent" src="https://img.shields.io/badge/agent-1.5.44-3ddc9a">
  <img alt="Schema" src="https://img.shields.io/badge/schema-27-8b5cf6">
  <img alt="Tests" src="https://img.shields.io/badge/tests-84%20passed-3ddc9a">
  <img alt="Install" src="https://img.shields.io/badge/install-one--command-3ddc9a">
</p>

<h1 align="center">RoutX</h1>

<p align="center">
  Централизованная панель для роутеров OpenWrt: установка и переключение
  <b>Tachyon</b>, <b>Forkop</b>, <b>Prokop</b> и <b>Podkop</b>, подписки,
  правила маршрутизации, мониторинг и PWA.
</p>

<p align="center">
  <a href="#быстрый-старт">Быстрый старт</a> ·
  <a href="#возможности">Возможности</a> ·
  <a href="#архитектура">Архитектура</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#документация">Документация</a>
</p>

> **Один роутер — один продукт.** RoutX ставит выбранный продукт, удаляет
> остальные и переносит секции, списки, домены и подписки. Перед изменениями
> создаётся снимок, при ошибке выполняется откат.

---

## Возможности

| | |
|:--|:--|
| 🧭 **Единый центр управления** | Все роутеры, продукты, версии и статусы в одной панели. |
| 🚀 **Установка одной командой** | Docker Compose или нативный Node.js + PostgreSQL. CLI `routx` сам готовит `.env`, администратора и базу. |
| 🔁 **Смена и переустановка продукта** | Выбор версии Tachyon, удаление старых пакетов, перенос настроек и автоматический откат. |
| 📦 **Каталог tachyon-lists** | 143 списка с описаниями, группами и счётчиками. Для Tachyon — нативно, для Forkop — rule-set, для Prokop — SRS, для Podkop — домены и подсети. |
| 🧩 **Правила без шаблонов** | Секции, домены, IP, community lists, подписки и прямые ссылки. |
| 📊 **Мониторинг** | Задержка, живые узлы, direct/VPN IP, история и health-статусы. |
| 🔐 **Безопасность** | Токены агентов, CSRF, rate limit, аудит, мастер-ключ, read-only контейнер. |
| 📱 **PWA** | Мобильный интерфейс, push-уведомления, QR-вход и выбор ресурсов с описаниями. |
| 🛠 **CLI `routx`** | `install`, `update`, `status`, `logs`, `restart`, `doctor`, `uninstall`. |

---

## Быстрый старт

Установка одной командой на Debian / Ubuntu. Скрипт скачает исходники с
GitHub, запустит нативную установку и **спросит домен**:

```sh
curl -fsSL https://raw.githubusercontent.com/seriec163/routx/main/install.sh | sudo sh
```

Можно ответить пустым вводом — тогда панель будет доступна на
`http://127.0.0.1:3000`. Если домен указан, CLI создаст `.env` с HTTPS,
установит и настроит Caddy, сгенерирует `Caddyfile.routx` и включит
systemd-сервис. Отключить автоматический Caddy: `--no-caddy`.

Полностью неинтерактивно:

```sh
curl -fsSL https://raw.githubusercontent.com/seriec163/routx/main/install.sh \
  | sudo sh -s -- --domain panel.example.com --tls-email admin@example.com --yes
```

`--yes` разрешает автоматически поставить Node.js 24, PostgreSQL и `psql`,
создать базу и systemd-сервис. Если зависимости уже есть, они не тронутся.

### Docker (опционально)

```sh
curl -fsSL https://raw.githubusercontent.com/seriec163/routx/main/install.sh \
  | sudo sh -s -- --docker --domain panel.example.com --tls-email admin@example.com
```

### Из клона репозитория

```sh
git clone https://github.com/seriec163/routx.git
cd routx

# Нативная установка (по умолчанию)
sudo ./scripts/routx install --domain panel.example.com --tls-email admin@example.com

# Docker
sudo ./scripts/routx install --docker --domain panel.example.com --tls-email admin@example.com
```

В конце установки CLI выведет адрес панели, e-mail и пароль первого
администратора. Пароль показывается один раз — сохраните его.

---

## CLI

После установки доступна команда `routx` (из `/usr/local/bin` или
`/opt/routx/scripts/routx`).

```sh
sudo routx                 # установка, спросит домен
sudo routx install         # то же самое
sudo routx install --docker
```

| Команда | Что делает |
|:--|:--|
| `routx` / `routx install` | Нативная установка, спрашивает домен |
| `routx install --docker` | Установка через Docker Compose |
| `routx install --native --install-deps` | Нативная установка с зависимостями |
| `routx update` | Обновление кода, сборка, миграции и перезапуск |
| `routx status` | Режим, каталог, URL, состояние сервиса и `/readyz` |
| `routx logs -f` | Логи приложения |
| `routx restart` / `stop` / `start` | Управление сервисом |
| `routx doctor` | Проверка `.env`, БД, Docker/PostgreSQL, порта и диска |
| `routx uninstall [--purge]` | Удаление установки |
| `routx version` | Версия CLI, приложения и git-коммита |

Установка в другой каталог:

```sh
sudo ./scripts/routx install --dir /srv/routx --domain panel.example.com
```

---

## Архитектура

<p align="center">
  <img src="./assets/readme/architecture.svg" alt="Архитектура RoutX" width="100%">
</p>

* **Панель** — Fastify + TypeScript, PostgreSQL, фоновые задания, аудит и SPA.
* **Агент** — ucode на OpenWrt. Сам ходит на панель по long-poll, входящие
  порты и открытый API на роутере не нужны.
* **Продукты** — Tachyon, Forkop, Prokop и Podkop. RoutX управляет пакетами,
  версиями, секциями, подписками и правилами.
* **CLI** — один вход для Docker и нативного развёртывания, обновления и
  диагностики.

---

## Поддерживаемые продукты

| Продукт | Версии | Списки | Особенности |
|:--|:--|:--|:--|
| **Tachyon** | 1.7.x | 139 нативных + rule-set | Основной продукт, `tachyon-lists`, `.trs`, выбор версии |
| **Forkop** | 2.x | нативные имена / JSON rule-set | `x`, `gemini`, `chatgpt`, `claude`, ASN-списки |
| **Prokop** | 2.x | нативные / SRS rule-set | Совместим с Forkop 1.x, миграция секций |
| **Podkop** | 0.7.x | нативные / домены и подсети | OpenWrt 24.10+, отдельные ссылки и outbound |

При смене продукта RoutX:

1. снимает снимок конфигурации;
2. сохраняет секции, домены, списки, подписки и ссылки;
3. удаляет пакеты и остатки старого продукта;
4. устанавливает выбранный продукт и переносит настройки;
5. проверяет версию и службу, при ошибке откатывается.

---

## Каталог списков

RoutX использует [Dushnilin/tachyon-lists](https://github.com/Dushnilin/tachyon-lists)
как источник истины:

* 143 списка и 11 тематических групп;
* поиск, описания, счётчики доменов и подсетей;
* подсказка при наведении: что входит в список и куда его направлять;
* группы «Популярные», «Нейросети», «Медиа», «Соцсети», «Игры»,
  «Технологии», «Инфраструктура», «Регионы», «Напрямую», «Блокировки»;
* обновление каталога: `node scripts/sync-tachyon-lists.mjs`.

---

## Требования

| Режим | Минимум | Рекомендуется |
|:--|:--|:--|
| **Docker** | 2 ГБ RAM, 5 ГБ диска | 10 ГБ с запасом на образы и бэкапы |
| **Без Docker** | Node.js 22.12+, PostgreSQL 16, 1–2 ГБ диска | 3–5 ГБ |
| **Роутер** | OpenWrt 24.10 / 25.12, aarch64 | 128 МБ RAM, свободное место под продукт |

Docker-установка использует `postgres:16-alpine`, `caddy:2-alpine` и
production-образ приложения. Нативная — systemd-сервис `routx`.

---

## Безопасность

* Мастер-ключ шифрования секретов и токенов агентов.
* Отдельный токен на каждый роутер, подпись запросов и защита от replay.
* CSRF, secure-cookie, rate limit и аудит действий.
* Агент не открывает входящие порты: только исходящий long-poll.
* Docker-контейнер приложения работает read-only, с `no-new-privileges`.
* Снимки перед изменениями и автоматический откат при ошибке.
* Секреты не попадают в логи и диагностические отчёты.

---

## Разработка

```sh
npm ci
npm run dev          # API :3000, SPA :5173
npm run typecheck
npm test             # 84 теста
npm run build
npm run db:migrate
npm run agent:build  # пакеты агента в agent/dist
```

Требуется PostgreSQL. Для разработки можно поднять только базу:

```sh
docker compose up -d db
```

---

## Документация

| Документ | О чём |
|:--|:--|
| [`docs/runbooks/self-hosting.md`](docs/runbooks/self-hosting.md) | Свой сервер, домен, HTTPS, первый вход |
| [`docs/runbooks/agent-packages.md`](docs/runbooks/agent-packages.md) | Агент, установка, обновление, выбор продукта |
| [`docs/runbooks/products-and-versions.md`](docs/runbooks/products-and-versions.md) | Продукты, версии, переустановка |
| [`docs/runbooks/backup-and-key-rotation.md`](docs/runbooks/backup-and-key-rotation.md) | Бэкапы и ротация ключа |
| [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) | Архитектура |
| [`docs/architecture/API.md`](docs/architecture/API.md) | API и протокол агента |
| [`docs/architecture/DATA_MODEL.md`](docs/architecture/DATA_MODEL.md) | Модель данных |

---

## Структура репозитория

```text
server/            Fastify + TypeScript: API, задания, агент-шлюз, миграции
server/migrations/ SQL-миграции
server/test/       Vitest
web/               React + Vite SPA и PWA
agent/             ucode-агент для OpenWrt и сборка пакетов
scripts/routx      CLI установки и обслуживания
install.sh         bootstrap-установщик одной командой
assets/readme/     SVG для GitHub-страницы
docs/              архитектура и runbook'и
```

---

<p align="center">
  <sub>RoutX · OpenWrt control plane · Tachyon / Forkop / Prokop / Podkop</sub>
</p>
