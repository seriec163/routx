# RoutX

Централизованное управление парком роутеров OpenWrt с уже установленным **Forkop** или **Prokop**: шаблоны конфигурации, подтверждаемое применение с откатом, мониторинг, диагностика, управление версиями sing-box.

> **Статус: этап 1 завершён (2026-10-27).** Реализованы каркас сервера Fastify 5 на Node.js, PostgreSQL 16 с миграциями, React SPA, Docker Compose, CI и runbook. Установка, переустановка и замена Forkop/Prokop не выполняются: система работает поверх уже запущенного продукта.

## Итерация «имена, списки, подключения»

* В профиль пользователя добавлены имя, отчество и фамилия; приветствие на дашборде — «Здравствуйте, Артур Николаевич». Поля редактируют сам пользователь в «Аккаунте» и суперадминистратор в «Пользователях».
* Редактор шаблона переведён с JSON на галочки: каталог ресурсов Prokop/Forkop (`community_lists`), URL-списки (`rule_set`, `remote_domain_lists`, `remote_subnet_lists`) и ручные домены/IP (`domain_ip_lists`).
* Шаблон может явно создать управляемую секцию (`create_sections`) и задать её действие. Пользовательские секции и VLESS/Sub-подключения не перезаписываются.
* В настройках роутера появилась вкладка «Свои списки»: дополнения к шаблону (URL или домены/IP) хранятся на сервере и подмешиваются в diff/apply.
* Вкладка «Подключения»: подписка и/или VLESS-ссылки. Ссылки передаются по TLS, хранятся в AES-256-GCM и показываются в UI маской. JanusNew пишет их в отдельную секцию `router_control` (`subscription_url` / `selector_proxy_links`).

---

## Что уже сделано

| Артефакт | Содержание |
|---|---|
| [`docs/audit/INTEGRATION_MAP.md`](docs/audit/INTEGRATION_MAP.md) | Проверенные по исходникам Forkop/Prokop команды CLI, UCI-схема, секреты, reload, async-задания, диагностика, sing-box, снапшоты, совместимость платформ, трассировка требований, риски |
| [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) | Компоненты, потоки, мониторинг, rollout sing-box, стек, этапы, критерии приёмки |
| [`docs/architecture/DECISIONS.md`](docs/architecture/DECISIONS.md) | Принятые решения §20, обоснования, последствия; журнал решений |
| [`docs/architecture/DATA_MODEL.md`](docs/architecture/DATA_MODEL.md) | Схема PostgreSQL, инварианты, retention |
| [`docs/architecture/API.md`](docs/architecture/API.md) | Web API, протокол агента, allowlist операций, лимиты |
| [`docs/architecture/JOBS.md`](docs/architecture/JOBS.md) | Статусы, lease, reaper, планировщик, reconcile, идемпотентность |
| [`docs/architecture/TEMPLATES.md`](docs/architecture/TEMPLATES.md) | Грамматика путей, правило полноты, жёсткие исключения, трёхсторонний diff, apply/rollback |
| [`docs/architecture/SECURITY.md`](docs/architecture/SECURITY.md) | Модель угроз, RBAC, токены, 2FA, защита агента, аудит и редакция |
| [`docs/runbooks/phase-1.md`](docs/runbooks/phase-1.md) | Запуск, проверка, диагностика и откат этапа 1 |
| [`docs/runbooks/phase-11-routing-ui.md`](docs/runbooks/phase-11-routing-ui.md) | Имена, галочки списков, свои списки роутера, подписки/VLESS, установка JanusNew и страница LuCI |
| [`docs/runbooks/singbox-variants.md`](docs/runbooks/singbox-variants.md) | Варианты sing-box Tiny/Extended/Stable, проверка и откат |
| [`docs/runbooks/monitoring-and-rollouts.md`](docs/runbooks/monitoring-and-rollouts.md) | Мониторинг прокси и поэтапное обновление sing-box |
| [`docs/runbooks/router-onboarding.md`](docs/runbooks/router-onboarding.md) | Мастер добавления роутера из четырёх шагов |
| [`docs/runbooks/archive-and-delete.md`](docs/runbooks/archive-and-delete.md) | Архив, восстановление и полное удаление роутеров и шаблонов |
| [`docs/runbooks/connections-and-sections.md`](docs/runbooks/connections-and-sections.md) | Физические и логические секции, внешние подписки, безопасное слияние подключений |
| [`docs/runbooks/prokop-diagnostics.md`](docs/runbooks/prokop-diagnostics.md) | Пояснения к спорным проверкам Prokop |
| [`docs/runbooks/backup-and-key-rotation.md`](docs/runbooks/backup-and-key-rotation.md) | Шифрованные бэкапы PostgreSQL и ротация `RC_MASTER_KEY` |

Код этапа 1:

| Артефакт | Содержание |
|---|---|
| `server/` | Fastify 5 + TypeScript: конфигурация, `/healthz`, `/readyz`, `/api/v1/meta`, security-заголовки, статическая отдача SPA |
| `server/migrations/` | `0001_init.sql`: `schema_migrations`, `settings`, `schema_version` |
| `server/src/db/migrate.ts` | SQL-runner с advisory lock, отдельной транзакцией на файл и идемпотентным повторным запуском |
| `server/src/cli/rotate-master-key.ts` | Ротация `RC_MASTER_KEY` с проверкой `--dry-run` и транзакционным перешифрованием |
| `scripts/backup-db.sh`, `Dockerfile.backup` | Шифрованный `pg_dump`, проверка дампа, retention и offsite-хук |
| `server/test/` | Vitest: конфигурация и служебные эндпоинты (15 тестов) |
| `web/` | React 19 + Vite 8 SPA: статус API, PostgreSQL, схемы и панели |
| `Dockerfile`, `docker-compose.yml` | Node 24, PostgreSQL 16, healthchecks, непривилегированный контейнер, профили `proxy` и `backup` |
| `.gitlab-ci.yml` | GitLab CI: typecheck, тесты, сборка, миграции, agent-пакеты и Docker-образ |
| `.github/workflows/ci.yml` | GitHub Actions: typecheck, тесты, сборка, миграции и runtime smoke-тест |

Аудит выполнен по зафиксированным коммитам:

* Forkop — `dd483297be0ac4e52bb8f482e2640238b75af532` (2026-07-18);
* Prokop — `3d2119e013d9671796dafccb460a5acbafcfef7b` (2026-10-20), `RELEASE_VERSION = 2.32.0`.

Клоны лежат в `audit/forkop` и `audit/prokop` **только для чтения** и не входят в поставку продукта.

---

## Принятые решения (2026-10-27)

| Параметр | Решение |
|---|---|
| Сервер | Node.js 24 LTS + TypeScript (Fastify 5), PostgreSQL 16, очередь в `jobs` без Redis, React 19 SPA |
| Агент | HTTPS long-poll ≤ 25 с, bearer + nonce/timestamp |
| Платформы | OpenWrt 24.10.x (opkg) и 25.12+ (apk); `aarch64_cortex-a53`, `aarch64_generic` |
| 2FA | `all` по умолчанию (TOTP для всех), `off` отсутствует |
| Лимиты | 10 роутеров/пользователя, 20 пользователей, 100 роутеров; batch 10 |
| Мониторинг | 60 с, 3 пропуска ≈ 3 мин, деградация прокси > 1500 мс |
| Retention | до 30 дней (метрики, отчёты, задания, аудит) |
| Бэкап сервера | ночной шифрованный `pg_dump` + offsite, RPO 24 ч, RTO 1 ч |
| Обновление агента | только вручную, подписанный пакет + SHA-256 |
| sing-box | пользователь — на своих роутерах (каталог `extended`, 1/24 ч); rollout — superadmin |

Полные формулировки и отклонённые альтернативы — `docs/architecture/DECISIONS.md`.

---

## Проверенные поверхности интеграции

* Только CLI продукта (`/usr/bin/forkop`, `/usr/bin/prokop`) и UCI по allowlist; прямые правки сгенерированного `sing-box/config.json` и внутренних `.uc`-модулей запрещены.
* Вызов upstream CLI — всегда через `env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin` (оба продукта учитывают переменные окружения).
* Два независимых адаптера с общим контрактом: набор возможностей Forkop и Prokop различается (Prokop: health, snapshots, `core_releases`/`install_version`; Forkop: inbound-режим и свои проверки).
* Снапшоты: нативные у Prokop (`config_snapshot_*`), собственные у Forkop (копия `/etc/config/forkop`, 0600).
* Секреты (VLESS/URI, `outbound_jsons`, URL подписки, inbound) не попадают в шаблоны, diff, отчёты и аудит. Исключение — явно добавленные пользователем подписки/VLESS во вкладке «Подключения»: они передаются по TLS, хранятся на сервере только в AES-256-GCM и показываются маской.
* Обнаружены оба продукта → `product_conflict`: чтение разрешено, изменения заблокированы.

Подробности и точные команды — в `INTEGRATION_MAP.md`; ничего не додумано: каждая команда сопоставлена с исходником upstream.

---

## Ключевые ограничения

* Роутер инициирует только исходящий TLS; входящих портов, SSH и проброса портов нет.
* Один управляемый продукт на роутер; переустановка/сброс/замена запрещены.
* Все изменяющие операции — асинхронные задания с сохраняемым состоянием (`queued/running/success/failed/cancelled/timeout`).
* Бэкап обязателен до применения; без снапшота apply не создаётся.
* Шаблон — полный набор управляемых параметров + явные исключения; отдельные VLESS/Sub-подключения не перезаписываются.
* Диагностика — только нативная; недоступное помечается «недоступно», а не имитируется.
* Секреты не пишутся в логи и аудит; произвольного shell-API нет.

---

## Быстрый старт

Требования: Node.js 22.12+ (Docker/CI — Node.js 24), PostgreSQL 16, Docker Compose.

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# вставьте ключ в RC_MASTER_KEY в .env

docker compose up -d db
npm ci
npm run db:migrate
npm run dev            # SPA: http://127.0.0.1:5173, API: http://127.0.0.1:3000
```

Проверка:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/healthz
Invoke-RestMethod http://127.0.0.1:3000/readyz
Invoke-RestMethod http://127.0.0.1:3000/api/v1/meta
npm run typecheck
npm test
npm run build
```

Production-запуск, HTTPS через Caddy, полная диагностика и откат —
[`docs/runbooks/phase-1.md`](docs/runbooks/phase-1.md).

План этапов и критерии приёмки — [`ARCHITECTURE.md` §13](docs/architecture/ARCHITECTURE.md):

1. ✅ каркас, миграции, `/healthz`, Compose;
2. аутентификация, RBAC, инвайты, 2FA, аудит;
3. агент: bind, poll, heartbeat, precheck, конфликт продуктов;
4. задания: очередь, lease, retry, timeout, reconcile;
5. read state, diff, шаблоны;
6. apply, snapshot, verify, rollback;
7. мониторинг 60 с;
8. диагностика quick/full и отчёты;
9. версии sing-box и staged rollout;
10. hardening.

---

## Структура репозитория

```text
server/           # Node.js + TS: API, домен, задания, шлюз агента, планировщик, миграции
server/migrations/ # SQL-миграции
server/src/db/    # пул PostgreSQL, Drizzle-схема, SQL-runner
server/test/      # Vitest
web/              # React + TypeScript SPA (Vite)
docs/             # аудит, архитектура, runbook'и
audit/            # read-only клоны Forkop/Prokop (не входят в поставку, в .gitignore)
.github/          # CI
```

Каталоги `agent/` и `tests/` появятся на этапах 3 и 4. Агент не входит в этап 1.

---

## Следующий шаг

Этап 2: аутентификация, роли `superadmin`/`user`, инвайты с одноразовыми токенами,
TOTP-политика `all`/`admins`, аудит без секретов и изоляция пользователей.
