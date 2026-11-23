# RoutX — API и протокол агента

Две независимые поверхности:

1. **Web API** (`/api/v1/...`) — для панели и автоматизации (cookie-сессия или API-токен).
2. **Agent API** (`/agent/v1/...`) — только для агентов на роутерах (bearer-токен роутера).

Общие правила: JSON UTF-8, `Content-Type: application/json`, время — RFC 3339 UTC, ID — UUID строкой. Ошибки — единый конверт (см. §1.4).

---

## 1. Web API

### 1.1. Аутентификация

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/v1/auth/login` | e-mail + пароль; при 2FA → `mfa_required` + `mfa_ticket` |
| POST | `/api/v1/auth/mfa` | TOTP-код + `mfa_ticket` → сессия |
| POST | `/api/v1/auth/logout` | отзыв сессии |
| GET | `/api/v1/auth/me` | профиль, роль, политика 2FA |
| POST | `/api/v1/auth/password` | смена пароля (требует текущий) |
| POST | `/api/v1/auth/mfa/enroll` | выдать секрет (показывается один раз) |
| POST | `/api/v1/auth/mfa/confirm` | подтвердить кодом |
| POST | `/api/v1/auth/mfa/disable` | только если политика разрешает |
| POST | `/api/v1/auth/invite/accept` | инвайт + пароль + (2FA при политике) |

Сессия: cookie `rc_session` (HttpOnly, Secure, SameSite=Lax, 30 дней), серверный opaque-токен. `mfa_ticket` — 5 минут, одноразовый.

Ограничения: 5 попыток логина / 15 мин на (e-mail + IP), затем `locked_until`; одинаковый ответ на неверный пароль и несуществующего пользователя.

### 1.2. Ресурсы

| Группа | Пути |
|---|---|
| Пользователи (superadmin) | `GET/POST /users`, `GET/PATCH/DELETE /users/{id}`, `POST /users/{id}/reset-mfa` |
| Инвайты | `GET/POST /invites`, `DELETE /invites/{id}` |
| Роутеры | `GET/POST /routers`, `GET/PATCH/DELETE /routers/{id}`, `POST /routers/{id}/binding-token`, `POST /routers/{id}/rotate-credential`, `POST /routers/{id}/transfer` |
| Состояние | `GET /routers/{id}/state`, `POST /routers/{id}/refresh` (job `precheck`) |
| Шаблоны | `GET/POST /templates`, `GET/PATCH/DELETE /templates/{id}`, `GET /templates/{id}/revisions`, `POST /templates/{id}/revisions`, `POST /templates/validate` |
| Каталог списков | `GET /settings/routing-catalog` (27 ресурсов Prokop/Forkop) |
| Свои списки роутера | `GET/PUT /routers/{id}/list-extras` |
| Подключения | `GET/POST /routers/{id}/connections`, `PATCH/DELETE /routers/{id}/connections/{connection_id}` (job `connections_apply`) |
| Профиль | `PATCH /auth/me` (имя, отчество, фамилия, e-mail + текущий пароль) |
| Сообщение администратора | `POST /notifications/send` (superadmin; всем или выбранным) |
| Назначения | `GET/PUT/DELETE /routers/{id}/templates/{template_id}` |
| Diff/apply | `POST /routers/{id}/diff`, `GET /apply-runs/{id}`, `POST /apply-runs/{id}/confirm`, `POST /apply-runs/{id}/cancel` |
| Задания | `GET /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel` |
| Мониторинг | `GET /routers/{id}/metrics?hours=&granularity=`, `GET /routers/{id}/connection-losses?hours=`, `GET /routers/{id}/availability` |
| Диагностика | `POST /routers/{id}/diagnostics` (`kind=quick|full`), `GET /diagnostics/{id}`, `GET /diagnostics?batch_id=` |
| sing-box | `GET /sing-box/versions`, `POST /sing-box/rollouts`, `POST /sing-box/rollouts/{id}/approve`, `POST /sing-box/rollouts/{id}/pause`, `POST /routers/{id}/sing-box/install` |
| Аудит | `GET /audit?actor=&router=&action=&from=&to=` (superadmin) |
| Настройки | `GET/PATCH /settings` (superadmin) |

### 1.3. Пагинация и фильтры

`?limit=50&cursor=<opaque>`; ответ `{ "items": [...], "next": "..." | null }`. Сортировка по умолчанию — по времени desc.

### 1.4. Конверт ошибки

```json
{
  "error": {
    "code": "router_conflict",
    "message": "На роутере обнаружены и Forkop, и Prokop. Изменения заблокированы.",
    "details": { "products": ["forkop","prokop"] },
    "request_id": "01J..."
  }
}
```

Коды (стабильные, для UI): `unauthorized`, `forbidden`, `not_found`, `conflict`, `validation_failed`, `rate_limited`, `router_offline`, `router_conflict`, `unsupported_platform`, `capability_missing`, `stale_diff`, `job_busy`, `job_timeout`, `agent_version_unsupported`, `internal`.

Чужие объекты → `404 not_found` (не `403`).

### 1.5. Идемпотентность и подтверждения

* `POST` с `Idempotency-Key` — повтор возвращает тот же результат (хранится 24 ч).
* `POST /apply-runs/{id}/confirm` требует `diff_hash`; несовпадение → `409 stale_diff`.
* Массовые операции создают `batch_id`; результат — агрегат + ссылки на задания.

---

## 2. Agent API

### 2.1. Транспорт и аутентификация

* HTTPS, TLS ≥ 1.2, проверка сертификата по системному CA (`/etc/ssl/certs`).
* Заголовки:

```text
Authorization: Bearer <router-token>
X-RC-Agent-Version: 1.0.0
X-RC-Manifest-Version: 1
X-RC-Timestamp: 1760000000
X-RC-Nonce: <32 hex/base64url>
Content-Type: application/json
```

* Сервер проверяет: токен (SHA-256 + сравнение за постоянное время), `|now - timestamp| ≤ 300 c`, nonce не встречался за 10 мин (таблица `nonces`), `router.status != revoked`.
* Ошибки: `401` → агент останавливает poll и требует повторной привязки; `403` → продукт запрещён; `409` → конфликт версии манифеста.

### 2.2. Привязка

```http
POST /agent/v1/bind
{ "token": "<32-char binding token>", "agent_version": "1.0.0",
  "manifest_version": 1, "product": "prokop|forkop|conflict|none",
  "product_version": "2.32.0", "openwrt": "24.10.4", "arch": "aarch64_cortex-a53",
  "model": "…", "sing_box_version": "1.12.0", "sing_box_variant": "extended",
  "capabilities": { … }, "precheck": { "free_kb": 41200, "mem_available_kb": 180000 } }
```

Ответ:

```json
{ "router_id": "…", "token": "<64-char>", "server_time": 1760000000,
  "limits": { "max_report_bytes": 2097152, "poll_hold_seconds": 25 },
  "policy": { "monitoring_seconds": 60, "allow_mutations": true } }
```

Токен показывается один раз; агент пишет его в `/etc/routx/agent.conf` (0600) атомарно (tmp + rename).

### 2.3. Long-poll

```http
POST /agent/v1/poll
{ "status": "idle|busy", "now": 1760000000, "queue_depth": 0,
  "inflight": "command-id|null", "product": "prokop", "product_version": "2.32.0",
  "sing_box_version": "1.12.0", "health": "ok", "last_error": null }
```

Сервер держит запрос ≤ 25 с.

* есть команда → `200` с телом команды;
* нет → `204 No Content`.

Команда:

```json
{
  "id": "018f…", "op": "apply_uci", "attempt": 1,
  "expires_at": "2026-10-27T12:10:00Z",
  "args": { "ops": [ … ], "expected_diff_hash": "sha256:…", "snapshot": true }
}
```

Агент обязан:

* отклонить команду с `expires_at` в прошлом (`reason=expired`), для mutate — не выполнять;
* отклонить `op`, которого нет в манифесте (`reason=capability_missing`);
* не выполнять вторую mutate-команду, пока первая не завершена (`reason=busy`);
* дедуплицировать по `id` (журнал).

### 2.4. Результат

```http
POST /agent/v1/result
{ "command_id": "018f…", "status": "success|failed|cancelled|timeout",
  "started_at": 1760000000, "finished_at": 1760000012,
  "result": { … }, "error": { "code": "…", "message": "…" } | null,
  "metrics": { "duration_ms": 12000 } }
```

`result` — по схеме операции. Сервер проверяет схему, пишет `job_events`, закрывает задание.

Повторная отправка результата идемпотентна: `200` даже если уже был принят.

### 2.5. Отчёты

```http
PUT /agent/v1/reports/{report_id}?job_id=…
Content-Encoding: gzip
X-RC-SHA256: <hex>
```

≤ 2 МБ (gzip), только masked. Сервер проверяет хэш, санитайзер, сохраняет `diagnostics_reports`.

### 2.6. Heartbeat (без long-poll)

`POST /agent/v1/heartbeat` — короткий ответ `{ "ok": true, "server_time": … }`. Используется, когда агент занят длинной операцией, чтобы сервер не считал его offline.

---

## 3. Каталог операций агента (наш протокол)

**Важно:** это внутренние операции агента, а не команды Forkop/Prokop. Каждая реализуется фиксированным argv-вызовом upstream CLI/UCI из `INTEGRATION_MAP.md`.

| op | mutate | args | result |
|---|---|---|---|
| `precheck` | нет | `{}` | платформа, место, память, версии, конфликт продуктов, capabilities |
| `product_probe` | нет | `{}` | `{product, product_version, conflict: bool}` |
| `read_state` | нет | `{paths?: string[]}` | `{managed: {path: value}, state_hash}` — только allowlist |
| `snapshot_create` | да (локально) | `{reason}` | `{kind, external_id?, sha256, size}` |
| `snapshot_list` | нет | `{}` | `[{id, created_at, reason, size}]` |
| `snapshot_restore` | да | `{id}` | `{status, changes, notices}` |
| `apply_uci` | да | `{ops:[{op,path,value?}], expected_state_hash}` | `{applied, skipped}` |
| `reload` | да | `{reason}` | `{result: applied|queued|stopped, waited_ms}` |
| `verify` | нет | `{checks:[...]}` | `{service, health, proxy_ok, config_valid}` |
| `service_action` | да | `{action: start|stop|restart}` | job id + финальный статус |
| `diagnostics_quick` | нет | `{}` | отчёт (masked) |
| `diagnostics_full` | нет | `{}` | отчёт (masked) |
| `proxy_latency` | нет | `{tag, type, timeout_ms?}` | `{delay_ms}` или `{error}` |
| `proxy_latencies` | нет | `{tags:[], timeout_ms?}` | `{count, failed, failed_count, per_tag}` |
| `monitor_probe` | нет | `{}` | `{reachable, service, health, proxy, latency, versions}` |
| `sb_check_update` | нет | `{}` | `{current, latest, variant, update_available}` |
| `sb_versions` | нет | `{}` | `[{tag, published_at, url}]` или `{not_supported:true}` |
| `sb_install` | да | `{action, tag?}` | `{status, current_version, changed}` + post-check |
| `logs_tail` | нет | `{source: product|sing-box, lines: 1..200}` | `{lines: []}` (masked) |

Ограничения:

* `apply_uci.ops` ≤ 200 операций; `path` — `type:section.option`, проверяется по манифесту;
* `read_state.paths` не может расширить allowlist;
* `logs_tail.lines` ≤ 200;
* `proxy_latencies.tags` ≤ 250;
* все таймауты ограничены сверху (см. `JOBS.md`).

### 3.1. Явные запреты

Нет операций: `exec`, `shell`, `raw_cli`, `show_config_raw`, `support_report`, `uninstall`, `install_product`, `dnsmasq_restore`, `killswitch_*`, `autotune_*`, `reboot`, `opkg/apk install`.

Если сервер пришлёт неизвестный `op`, агент отвечает `failed` / `capability_missing` и **ничего не выполняет**.

---

## 4. Соответствие операций и upstream-команд

| op | Prokop | Forkop |
|---|---|---|
| `product_probe` | `show_version` | `show_version` |
| `precheck` | `get_system_info`, `get_ui_capabilities` + локальные `df`/`meminfo` | `get_system_info`, `get_ui_capabilities` + локальные |
| `read_state` | `uci get` по allowlist | `uci get` по allowlist |
| `snapshot_create` | `config_snapshot_create before-apply` | наш файловый снапшот |
| `snapshot_restore` | `config_snapshot_restore <id>` | наш restore + `reload` |
| `apply_uci` | `uci set/delete` + `uci commit prokop` | `uci set/delete` + `uci commit forkop` |
| `reload` | `service_action_async reload` + status | то же |
| `verify` | `get_status`, `get_health_status`, `check_proxy`, `check_sing_box` | `get_status`, `check_proxy`, `check_sing_box` |
| `diagnostics_quick` | §10.1 карты | §10.1 |
| `diagnostics_full` | §10.2 (без `support_report`) | §10.2 (без health/env) |
| `proxy_latency` | `clash_api get_proxy_latency` | то же |
| `monitor_probe` | `get_ui_state` + `clash_api` | то же |
| `sb_check_update` | `component_action sing_box check_update` | то же |
| `sb_versions` | `core_releases` | `{not_supported:true}` |
| `sb_install` | `component_action_async sing_box …` | без `install_version` |
| `logs_tail` | `check_logs`, `check_sing_box_logs` (или `logread` с фильтром) | то же |

`logs_tail` через `logread` — единственное чтение, не являющееся CLI продукта; объём жёстко ограничен, вывод маскируется по тем же правилам. Если политика запрещает — используем только `check_logs`.

---

## 5. Версионирование

* `api_version` в пути (`/api/v1`, `/agent/v1`).
* Агент сообщает `agent_version` и `manifest_version`.
* Сервер: `min_agent_version` в настройках; ниже — `agent_version_unsupported`, только `precheck`/`read_state`/`diagnostics`.
* Ломающие изменения протокола — `/agent/v2` с overlap-периодом ≥ 90 дней.

---

## 6. Лимиты (значения по умолчанию)

| Параметр | Значение |
|---|---|
| Тело запроса Web API | 1 МБ |
| Тело ответа агента (`result`) | 256 КБ |
| Отчёт агента (gzip) | 2 МБ |
| Poll hold | 25 с |
| Команд в poll-ответе | 1 (строго) |
| `apply_uci.ops` | 200 |
| `proxy_latencies.tags` | 250 |
| `logs_tail.lines` | 200 |
| TTL mutate-команды | 10 мин |
| TTL read-команды | 2 мин |
| Nonce-окно | ±300 с, кэш 10 мин |
| Частота poll при idle | 25 с (long-poll) |
| Backoff при ошибках | 5 с → 5 мин, jitter ±20 % |
