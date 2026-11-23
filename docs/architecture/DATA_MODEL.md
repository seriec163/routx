# RoutX — модель данных

СУБД: PostgreSQL 16. Все временные метки — `timestamptz` (UTC). Идентификаторы — UUIDv7 (`uuid`), кроме `audit_log` (bigserial) и метрик (партиции).
Секреты: только хэши/шифротекст. Никаких plaintext-токенов, паролей, URL подписок.

---

## 1. Схема (ER, текстом)

```text
users 1─┬─< sessions
        ├─< invites (created_by)
        ├─< api_tokens
        └─< routers (owner_id) 1─┬─< binding_tokens
                                 ├─< agent_commands
                                 ├─< router_state
                                 ├─< template_assignments >─ templates
                                 ├─< apply_runs 1─< apply_items
                                 ├─< jobs 1─< job_events
                                 ├─< monitoring_samples
                                 ├─< diagnostics_reports
                                 └─< router_snapshots
templates 1─< template_revisions
sing_box_versions 1─< rollout_targets >─ rollouts
audit_log (ссылается на актора и цель, без FK на секреты)
```

---

## 2. Пользователи и доступ

### 2.1. `users`

```sql
create table users (
  id              uuid primary key,
  email           citext not null unique,
  password_hash   text   not null,              -- argon2id
  role            text   not null check (role in ('superadmin','admin','user')),
  parent_id       uuid references users(id) on delete set null, -- ветка администратора
  status          text   not null default 'active'
                         check (status in ('active','suspended')),
  totp_secret_enc bytea,                        -- AES-256-GCM
  totp_enabled    boolean not null default false,
  totp_confirmed_at timestamptz,
  totp_last_step  bigint,                       -- защита от replay TOTP
  failed_logins   int not null default 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on users (role, status);
create index on users (parent_id);
```

Инварианты:

* ровно один `superadmin` создаётся при инициализации (bootstrap), дальнейшие — только им;
* `parent_id` задаёт ветку: у пользователя, приглашённого администратором,
  `parent_id = id` этого администратора; у администраторов и пользователей,
  созданных суперадминистратором, `parent_id = null`;
* `totp_secret_enc` обязателен при `totp_enabled = true`;
* e-mail нормализуется в нижний регистр до вставки.

### 2.2. `sessions`

```sql
create table sessions (
  id           uuid primary key,
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   bytea not null unique,           -- sha256(opaque token)
  ip           inet,
  user_agent   text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  mfa_passed   boolean not null default false
);
create index on sessions (user_id, expires_at desc);
```

### 2.3. `invites`

```sql
create table invites (
  id          uuid primary key,
  token_hash  bytea not null unique,            -- sha256(32-char base32)
  created_by  uuid not null references users(id),
  role        text not null check (role in ('superadmin','admin','user')),
  email       citext,                           -- необязательное ограничение
  expires_at  timestamptz not null,             -- по умолчанию now()+5 min
  used_at     timestamptz,
  used_by     uuid references users(id),
  attempts    int not null default 0,
  created_at  timestamptz not null default now()
);
create index on invites (expires_at) where used_at is null;
```

Погашение — один атомарный запрос:

```sql
update invites
   set used_at = now(), used_by = $1
 where token_hash = $2
   and used_at is null
   and expires_at > now()
returning id, role, email;
```

`attempts` инкрементируется при неудаче (rate limit по IP + по токену).

### 2.4. `api_tokens` (опционально, для автоматизации суперадмина)

`id, user_id, name, token_hash, scopes text[], last_used_at, expires_at, revoked_at`.

---

## 3. Роутеры

### 3.1. `routers`

```sql
create table routers (
  id                  uuid primary key,
  owner_id            uuid not null references users(id) on delete restrict,
  name                text not null,
  product             text not null check (product in ('forkop','prokop','unknown','conflict')),
  product_version     text,
  agent_version       text,
  manifest_version    int,
  openwrt_version     text,
  arch                text,
  model               text,
  sing_box_version    text,
  sing_box_variant    text,
  status              text not null default 'pending'
                      check (status in ('pending','online','offline','error','conflict','unsupported')),
  last_seen_at        timestamptz,
  last_poll_at        timestamptz,
  last_error          text,
  offline_after_misses int not null default 3,
  monitoring_enabled  boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (owner_id, name)
);
create index on routers (owner_id, status);
create index on routers (last_seen_at) where status <> 'offline';
```

Правила:

* `product = 'conflict'` → все mutating-задания запрещены (проверка в домене + в SQL-условии выборки заданий);
* `owner_id` меняется только суперадмином (передача роутера), с записью в аудит;
* `manifest_version` увеличивается при обновлении агента; шаблоны, несовместимые с манифестом, помечаются `incompatible`.

### 3.2. `router_credentials`

```sql
create table router_credentials (
  router_id     uuid primary key references routers(id) on delete cascade,
  token_hash    bytea not null,          -- sha256(bearer)
  token_prefix  text  not null,          -- первые 8 символов для UI
  created_at    timestamptz not null default now(),
  rotated_at    timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz
);
```

Хранится только хэш. Ротация: новая запись + overlap-окно (старый токен живёт ≤ 10 мин), затем revoke.

### 3.3. `binding_tokens`

```sql
create table binding_tokens (
  id          uuid primary key,
  token_hash  bytea not null unique,
  created_by  uuid not null references users(id),
  router_id   uuid references routers(id) on delete cascade,
  product_hint text check (product_hint in ('any','forkop','prokop')),
  expires_at  timestamptz not null,      -- now()+5 min
  used_at     timestamptz,
  used_ip     inet,
  created_at  timestamptz not null default now()
);
create index on binding_tokens (expires_at) where used_at is null;
```

Два сценария:

1. `router_id` задан — привязка нового агента к уже созданной карточке;
2. `router_id` пуст — агент создаёт карточку (только если у создателя есть свободный слот лимита).

Погашение атомарное, как у инвайтов. Повторное использование → `409 token_used` без раскрытия деталей.

### 3.4. `router_state` (последнее прочитанное состояние)

```sql
create table router_state (
  router_id     uuid primary key references routers(id) on delete cascade,
  managed       jsonb not null default '{}'::jsonb,  -- allowlist-опции: только не секретные
  state_hash    text,
  health        jsonb,                                -- нормализованный health
  service       jsonb,                                -- running/enabled/status/dns
  capabilities  jsonb,
  collected_at  timestamptz,
  source        text                                  -- 'poll' | 'diff' | 'apply-verify'
);
```

`managed` **никогда** не содержит `selector_proxy_links`, `outbound_jsons`, `subscription_url.url`, inbound-секреты.

---

## 4. Шаблоны

### 4.1. `templates`

```sql
create table templates (
  id             uuid primary key,
  owner_id       uuid not null references users(id) on delete cascade,
  name           text not null,
  description    text,
  schema_version int  not null default 1,
  current_revision int not null default 1,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (owner_id, name)
);
```

### 4.2. `template_revisions` (иммутабельные)

```sql
create table template_revisions (
  template_id  uuid not null references templates(id) on delete cascade,
  revision     int  not null,
  payload      jsonb not null,       -- managed: path -> value
  exclusions   jsonb not null,       -- явные исключения (расширяют hard-exclude)
  created_by   uuid not null references users(id),
  created_at   timestamptz not null default now(),
  primary key (template_id, revision)
);
```

`payload`:

```json
{
  "settings": { "log_level": "warn", "dns_strategy": "prefer_ipv4" },
  "sections": {
    "main": { "sort_by_latency": "1", "community_lists": ["russia_inside"] }
  },
  "urltest": {
    "Fastest": { "tolerance": "50", "check_interval": "3m" }
  },
  "create_urltest": ["Fastest"]
}
```

Инварианты (проверяются при сохранении и повторно при apply):

* пути только из манифеста;
* нет секретных путей;
* нет wildcard;
* `create_urltest` содержит только имена, встречающиеся в `urltest`;
* тип значения соответствует опции (`option`/`list`);
* изменение ревизии не мутирует прошлую (новая строка).

### 4.3. `template_assignments`

```sql
create table template_assignments (
  router_id    uuid not null references routers(id) on delete cascade,
  template_id  uuid not null references templates(id) on delete cascade,
  revision     int  not null,
  desired_hash text not null,
  applied_hash text,
  applied_at   timestamptz,
  drift        text not null default 'unknown'
               check (drift in ('unknown','in_sync','drift','incompatible','blocked')),
  last_checked_at timestamptz,
  primary key (router_id, template_id)
);
```

Один роутер может иметь несколько шаблонов, но **пересечение путей запрещено** (иначе неопределённость). Проверка при назначении; при конфликте — отказ с указанием пересекающихся путей.

---

## 5. Применение

### 5.1. `apply_runs`

```sql
create table apply_runs (
  id            uuid primary key,
  router_id     uuid not null references routers(id) on delete cascade,
  template_id   uuid references templates(id) on delete set null,
  revision      int,
  diff          jsonb not null,          -- [{op:'add|change|delete', path, before, after}]
  diff_hash     text  not null,
  snapshot_ref  text,                    -- id нативного снапшота или наш
  backup_ok     boolean not null default false,
  status        text not null default 'awaiting_confirmation'
                check (status in ('awaiting_confirmation','queued','running',
                                  'success','failed','rolled_back','rollback_failed',
                                  'needs_attention','cancelled','stale')),
  requested_by  uuid not null references users(id),
  confirmed_by  uuid references users(id),
  confirmed_at  timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  error_code    text,
  error_detail  text,                    -- без секретов
  created_at    timestamptz not null default now()
);
create index on apply_runs (router_id, created_at desc);
```

Инварианты:

* `backup_ok = true` до перехода в `running`;
* `confirmed_by is not null` до `queued`, если diff непустой;
* `diff_hash` сверяется агентом с текущим состоянием; расхождение → `stale`;
* `status='rolled_back'` только если restore + verify прошли.

### 5.2. `apply_items` (детализация для UI и аудита)

`apply_run_id, seq, op, path, value_before jsonb, value_after jsonb, result ('ok'|'failed'|'skipped'), error_code`.

Значения — только управляемые (не секретные) опции.

### 5.3. `router_snapshots`

```sql
create table router_snapshots (
  id          uuid primary key,
  router_id   uuid not null references routers(id) on delete cascade,
  kind        text not null check (kind in ('native','local')),
  external_id text,                  -- id снапшота Prokop
  reason      text not null,         -- before-apply | manual | pre-update
  sha256      text,
  size_bytes  bigint,
  product_version text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz
);
create index on router_snapshots (router_id, created_at desc);
```

Содержимое снапшота **не** копируется на сервер (там секреты). Сервер знает только метаданные.

---

## 6. Задания

### 6.1. `jobs`

```sql
create table jobs (
  id             uuid primary key,
  type           text not null,      -- monitor, diff, apply, diagnostics, sb_check, sb_install,
                                     -- snapshot, restore, bind_verify, precheck, reconcile
  router_id      uuid references routers(id) on delete cascade,
  batch_id       uuid,
  requested_by   uuid references users(id),
  status         text not null default 'queued'
                 check (status in ('queued','running','success','failed','cancelled','timeout')),
  priority       smallint not null default 100,
  payload        jsonb not null default '{}'::jsonb,
  result         jsonb,
  attempt        int not null default 0,
  max_attempts   int not null default 3,
  timeout_seconds int not null default 120,
  idempotency_key text,
  scheduled_at   timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  lease_owner    text,
  lease_expires_at timestamptz,
  next_retry_at  timestamptz,
  error_code     text,
  error_detail   text,
  created_at     timestamptz not null default now()
);
create unique index on jobs (idempotency_key) where idempotency_key is not null;
create index on jobs (status, scheduled_at) where status in ('queued','running');
create index on jobs (router_id, created_at desc);
create index on jobs (batch_id);
```

Захват:

```sql
update jobs
   set status='running', attempt=attempt+1, started_at=now(),
       lease_owner=$1, lease_expires_at=now()+($2||' seconds')::interval
 where id = (
   select id from jobs
    where status='queued' and scheduled_at <= now()
      and (next_retry_at is null or next_retry_at <= now())
    order by priority, scheduled_at
    for update skip locked
    limit 1)
returning *;
```

Серийность на роутер обеспечивается отдельной таблицей-замком или частичным уникальным индексом:

```sql
create unique index one_active_job_per_router
  on jobs (router_id)
  where status = 'running' and type <> 'monitor';
```

(Мониторинг исключён, но он и так не накладывается — см. `router_locks`.)

### 6.2. `job_events`

`job_id, seq, at, status, code, message, data jsonb`. Append-only, для таймлайна в UI.

### 6.3. `agent_commands` (outbox)

```sql
create table agent_commands (
  id           uuid primary key,        -- = command_id
  router_id    uuid not null references routers(id) on delete cascade,
  job_id       uuid not null references jobs(id) on delete cascade,
  op           text not null,
  args         jsonb not null,
  attempt      int not null default 1,
  status       text not null default 'pending'
               check (status in ('pending','delivered','acked','failed','expired')),
  created_at   timestamptz not null default now(),
  delivered_at timestamptz,
  expires_at   timestamptz not null,    -- mutation: +10 min, read: +2 min
  acked_at     timestamptz,
  result       jsonb
);
create unique index on agent_commands (router_id, id);
create index on agent_commands (router_id, status) where status in ('pending','delivered');
```

Доставка: poll отдаёт `pending` + переотдаёт `delivered`, если `delivered_at < now()-interval '30 seconds'` и не истёк TTL. Агент дедуплицирует по `id`.

### 6.4. `router_locks`

```sql
create table router_locks (
  router_id  uuid primary key references routers(id) on delete cascade,
  holder     text not null,
  expires_at timestamptz not null
);
```

Используется мониторингом и любыми «фоновыми» операциями, чтобы не пересекаться с apply.

---

## 7. Мониторинг

### 7.1. `monitoring_samples` (партиционирование по месяцу)

```sql
create table monitoring_samples (
  router_id     uuid not null references routers(id) on delete cascade,
  ts            timestamptz not null,
  reachable     boolean not null,
  service_state text,          -- running|stopped|stopped_by_user|not_started|error|unknown
  health        text,          -- overall Prokop или derived
  proxy_health  text,          -- healthy|degraded|unhealthy|unknown
  latency_ms    int,
  failed_tags   int,
  total_tags    int,
  sing_box_version text,
  agent_version text,
  detail        jsonb,
  primary key (router_id, ts)
) partition by range (ts);
```

Партиции создаются на 2 месяца вперёд; старые detach/drop по retention.

### 7.2. `monitoring_rollups`

`router_id, bucket_start, granularity ('hour'|'day'), samples, reachable_pct, avg_latency_ms, p95_latency_ms, unhealthy_pct, primary key (router_id, granularity, bucket_start)`.

### 7.3. `router_availability`

`router_id, offline_since, online_since, last_transition, misses` — для быстрого статуса без сканов.

---

## 8. Диагностика

### 8.1. `diagnostics_reports`

```sql
create table diagnostics_reports (
  id           uuid primary key,
  router_id    uuid not null references routers(id) on delete cascade,
  job_id       uuid references jobs(id) on delete set null,
  batch_id     uuid,
  kind         text not null check (kind in ('quick','full')),
  product      text not null,
  agent_version text,
  report       jsonb not null,       -- только masked
  report_text  text,                 -- global_check masked
  sha256       text not null,
  size_bytes   int  not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index on diagnostics_reports (router_id, created_at desc);
create index on diagnostics_reports (batch_id);
```

Ограничения: `size_bytes <= 2 MiB`; `report` проходит серверный санитайзер (повторная проверка на ключи `password|secret|token|uuid|private_key|url` — для `url` допускаются только `rule_set`/`testing_url`).

---

## 9. sing-box и rollout

### 9.1. `sing_box_versions`

`id, product ('prokop'), tag, release_url, published_at, asset_sha256, discovered_at, is_stable boolean, unique(product, tag)`.

Заполняется из `core_releases` (Prokop). Для Forkop пусто — UI показывает GAP.

### 9.2. `rollouts`

```sql
create table rollouts (
  id           uuid primary key,
  version_tag  text not null,
  status       text not null default 'draft'
               check (status in ('draft','running','paused','completed','cancelled','failed')),
  stage        int not null default 0,       -- 0=canary,1=10%,2=50%,3=100%
  stage_started_at timestamptz,
  created_by   uuid not null references users(id),
  approved_by  uuid references users(id),
  created_at   timestamptz not null default now()
);
```

### 9.3. `rollout_targets`

`rollout_id, router_id, stage, status ('pending'|'installing'|'verifying'|'success'|'failed'|'skipped'|'rolled_back'), previous_version, started_at, finished_at, error_code`.

Правила:

* цель включается в стадию только если `product='prokop'`, `status='online'`, `sing_box_variant='extended'`;
* между стадиями — ручное подтверждение;
* ≥ 2 неудачи подряд → `paused`;
* откат — новая запись `previous_version`, не «отмена» установки.

---

## 10. Аудит

```sql
create table audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    uuid references users(id),
  actor_role  text,
  action      text not null,        -- auth.login, router.bind, template.update, apply.confirm, sb.install, …
  target_type text,
  target_id   uuid,
  router_id   uuid,
  ip          inet,
  user_agent  text,
  result      text not null check (result in ('ok','denied','error')),
  code        text,
  metadata    jsonb not null default '{}'::jsonb
);
create index on audit_log (at desc);
create index on audit_log (actor_id, at desc);
create index on audit_log (router_id, at desc);
```

`metadata` проходит allowlist по `action`; значения секретных полей вырезаются до вставки (не после). Запрещено логировать тела запросов целиком.

---

## 11. Служебное

* `settings` — `key text primary key, value jsonb, updated_by, updated_at` (политика 2FA, лимиты, retention, offline-порог, supported platforms).
* `nonces` — `nonce text primary key, router_id, seen_at` (TTL 10 мин, чистится джобой).
* `outbox_email` (если будут письма) — не в v1.
* `schema_migrations` — Drizzle Kit.

---

## 12. Retention (D-10: не более 30 дней)

| Данные | Срок | Механизм |
|---|---|---|
| `monitoring_samples` | 30 дней | drop партиций |
| `monitoring_rollups` (hour) | 30 дней | delete |
| `monitoring_rollups` (day) | не используются в v1 | — |
| `diagnostics_reports` | 30 дней | delete + expires_at |
| `jobs` (success) | 30 дней | delete |
| `jobs` (failed/timeout) | 30 дней | delete |
| `job_events` | вместе с job | cascade |
| `agent_commands` | 7 дней после ack | delete |
| `audit_log` | 30 дней | delete пачками, append-only до этого |
| `sessions` | 30 дней неактивности | delete |
| `invites`/`binding_tokens` | 30 дней после истечения | delete |
| `router_snapshots` | Prokop: upstream retention; наш: 10 на роутер | delete |
| `sing_box_versions` | 30 дней | delete |

---

## 13. Инварианты целостности (сводка)

1. Нет задания `apply` без `apply_runs.backup_ok`.
2. Нет `running`-задания на роутер с `product='conflict'`.
3. Нет `template_revisions` с секретным путём (проверка в БД-триггере + в домене).
4. Нет двух назначенных шаблонов с пересечением путей на одном роутере.
5. `monitoring_samples` — только для `monitoring_enabled`.
6. `audit_log` не содержит значений секретных опций (проверка allowlist при вставке).
7. `router_credentials.token_hash` — единственное место, где живёт аутентификация агента.
8. Удаление пользователя не удаляет его роутеры: `on delete restrict` + обязательная передача/архивация суперадмином.
