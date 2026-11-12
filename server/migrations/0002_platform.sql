-- Router Control: платформенная схема (этапы 2–10).
-- Все секреты хранятся только в виде хэшей/AES-256-GCM; открытых токенов в БД нет.

create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- Пользователи, сессии, приглашения
-- ---------------------------------------------------------------------------

create table if not exists users (
  id                uuid primary key,
  email             citext not null unique,
  password_hash     text   not null,
  role              text   not null check (role in ('superadmin','user')),
  status            text   not null default 'active' check (status in ('active','suspended')),
  totp_secret_enc   text,
  totp_enabled      boolean not null default false,
  totp_confirmed_at timestamptz,
  totp_last_step    bigint,
  failed_logins     int not null default 0,
  locked_until      timestamptz,
  last_login_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists users_role_status_idx on users (role, status);

create table if not exists sessions (
  id           uuid primary key,
  user_id      uuid not null references users(id) on delete cascade,
  token_hash   bytea not null unique,
  csrf_hash    bytea not null,
  ip           text,
  user_agent   text,
  mfa_passed   boolean not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index if not exists sessions_user_idx on sessions (user_id, expires_at desc);

create table if not exists mfa_tickets (
  id         uuid primary key,
  user_id    uuid not null references users(id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mfa_tickets_expiry_idx on mfa_tickets (expires_at) where used_at is null;

create table if not exists invites (
  id         uuid primary key,
  token_hash bytea not null unique,
  created_by uuid not null references users(id) on delete cascade,
  role       text not null check (role in ('superadmin','user')),
  email      citext,
  expires_at timestamptz not null,
  used_at    timestamptz,
  used_by    uuid references users(id) on delete set null,
  attempts   int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists invites_open_idx on invites (expires_at) where used_at is null;

-- ---------------------------------------------------------------------------
-- Роутеры и агент
-- ---------------------------------------------------------------------------

create table if not exists routers (
  id                   uuid primary key,
  owner_id             uuid not null references users(id) on delete restrict,
  name                 text not null,
  product              text not null default 'unknown'
                       check (product in ('forkop','prokop','unknown','conflict')),
  product_version      text,
  agent_version        text,
  manifest_version     int,
  openwrt_version      text,
  arch                 text,
  model                text,
  sing_box_version     text,
  sing_box_variant     text,
  status               text not null default 'pending'
                       check (status in ('pending','online','offline','error','conflict','unsupported')),
  last_seen_at         timestamptz,
  last_poll_at         timestamptz,
  last_error           text,
  offline_after_misses int not null default 3,
  monitoring_enabled   boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (owner_id, name)
);
create index if not exists routers_owner_status_idx on routers (owner_id, status);
create index if not exists routers_last_seen_idx on routers (last_seen_at);

-- Мягкая архивация: DELETE /routers/{id} не удаляет историю и задания.
alter table routers add column if not exists archived_at timestamptz;

create table if not exists router_credentials (
  router_id    uuid primary key references routers(id) on delete cascade,
  token_hash   bytea not null,
  token_prefix text not null,
  created_at   timestamptz not null default now(),
  rotated_at   timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);

-- Перекрытие при ротации: старый токен живёт 10 минут, чтобы агент успел обновиться.
alter table router_credentials add column if not exists previous_token_hash bytea;
alter table router_credentials add column if not exists previous_expires_at timestamptz;

create table if not exists binding_tokens (
  id           uuid primary key,
  token_hash   bytea not null unique,
  created_by   uuid not null references users(id) on delete cascade,
  router_id    uuid references routers(id) on delete cascade,
  product_hint text not null default 'any' check (product_hint in ('any','forkop','prokop')),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  used_ip      text,
  created_at   timestamptz not null default now()
);
create index if not exists binding_tokens_open_idx on binding_tokens (expires_at) where used_at is null;

create table if not exists router_state (
  router_id    uuid primary key references routers(id) on delete cascade,
  managed      jsonb not null default '{}'::jsonb,
  state_hash   text,
  health       jsonb,
  service      jsonb,
  capabilities jsonb,
  collected_at timestamptz,
  source       text
);

create table if not exists router_locks (
  router_id  uuid primary key references routers(id) on delete cascade,
  holder     text not null,
  expires_at timestamptz not null
);

create table if not exists nonces (
  nonce     text primary key,
  router_id uuid references routers(id) on delete cascade,
  seen_at   timestamptz not null default now()
);
create index if not exists nonces_seen_idx on nonces (seen_at);

-- ---------------------------------------------------------------------------
-- Шаблоны
-- ---------------------------------------------------------------------------

create table if not exists templates (
  id               uuid primary key,
  owner_id         uuid not null references users(id) on delete cascade,
  name             text not null,
  description      text,
  schema_version   int not null default 1,
  current_revision int not null default 1,
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (owner_id, name)
);

create table if not exists template_revisions (
  template_id uuid not null references templates(id) on delete cascade,
  revision    int not null,
  payload     jsonb not null,
  exclusions  jsonb not null default '[]'::jsonb,
  created_by  uuid not null references users(id) on delete restrict,
  created_at  timestamptz not null default now(),
  primary key (template_id, revision)
);

create table if not exists template_assignments (
  router_id       uuid not null references routers(id) on delete cascade,
  template_id     uuid not null references templates(id) on delete cascade,
  revision        int not null,
  desired_hash    text not null,
  applied_hash    text,
  applied_at      timestamptz,
  drift           text not null default 'unknown'
                  check (drift in ('unknown','in_sync','drift','incompatible','blocked')),
  last_checked_at timestamptz,
  primary key (router_id, template_id)
);

-- ---------------------------------------------------------------------------
-- Apply / snapshots
-- ---------------------------------------------------------------------------

create table if not exists apply_runs (
  id             uuid primary key,
  router_id      uuid not null references routers(id) on delete cascade,
  template_id    uuid references templates(id) on delete set null,
  revision       int,
  diff           jsonb not null,
  diff_hash      text not null,
  snapshot_ref   text,
  backup_ok      boolean not null default false,
  status         text not null default 'awaiting_confirmation'
                 check (status in ('awaiting_confirmation','queued','running','success','failed',
                                   'rolled_back','rollback_failed','needs_attention','cancelled','stale')),
  requested_by   uuid not null references users(id) on delete restrict,
  confirmed_by   uuid references users(id) on delete set null,
  confirmed_at   timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  error_code     text,
  error_detail   text,
  created_at     timestamptz not null default now()
);
create index if not exists apply_runs_router_idx on apply_runs (router_id, created_at desc);
alter table apply_runs add column if not exists base_state_hash text;
alter table apply_runs add column if not exists desired_hash text;

create table if not exists apply_items (
  apply_run_id uuid not null references apply_runs(id) on delete cascade,
  seq          int not null,
  op           text not null check (op in ('add','change','delete')),
  path         text not null,
  value_before jsonb,
  value_after  jsonb,
  result       text not null default 'pending' check (result in ('pending','ok','failed','skipped')),
  error_code   text,
  primary key (apply_run_id, seq)
);

create table if not exists router_snapshots (
  id              uuid primary key,
  router_id       uuid not null references routers(id) on delete cascade,
  kind            text not null check (kind in ('native','local')),
  external_id     text,
  reason          text not null,
  sha256          text,
  size_bytes      bigint,
  product_version text,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz
);
create index if not exists router_snapshots_router_idx on router_snapshots (router_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Очередь задач и агентские команды
-- ---------------------------------------------------------------------------

create table if not exists jobs (
  id              uuid primary key,
  type            text not null,
  router_id       uuid references routers(id) on delete cascade,
  batch_id        uuid,
  requested_by    uuid references users(id) on delete set null,
  status          text not null default 'queued'
                  check (status in ('queued','running','success','failed','cancelled','timeout')),
  priority        smallint not null default 100,
  payload         jsonb not null default '{}'::jsonb,
  result          jsonb,
  attempt         int not null default 0,
  max_attempts    int not null default 3,
  timeout_seconds int not null default 120,
  idempotency_key text,
  scheduled_at    timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  lease_owner     text,
  lease_expires_at timestamptz,
  next_retry_at   timestamptz,
  error_code      text,
  error_detail    text,
  created_at      timestamptz not null default now()
);
create unique index if not exists jobs_idempotency_idx on jobs (idempotency_key) where idempotency_key is not null;
create index if not exists jobs_queue_idx on jobs (status, scheduled_at) where status in ('queued','running');
create index if not exists jobs_router_idx on jobs (router_id, created_at desc);
create index if not exists jobs_batch_idx on jobs (batch_id);
create unique index if not exists one_active_job_per_router
  on jobs (router_id)
  where status = 'running' and type <> 'monitor' and router_id is not null;

create table if not exists job_events (
  id      bigserial primary key,
  job_id  uuid not null references jobs(id) on delete cascade,
  seq     int not null,
  at      timestamptz not null default now(),
  status  text,
  code    text,
  message text,
  data    jsonb
);
create index if not exists job_events_job_idx on job_events (job_id, seq);

create table if not exists agent_commands (
  id           uuid primary key,
  router_id    uuid not null references routers(id) on delete cascade,
  job_id       uuid not null references jobs(id) on delete cascade,
  op           text not null,
  args         jsonb not null default '{}'::jsonb,
  attempt      int not null default 1,
  status       text not null default 'pending'
               check (status in ('pending','delivered','acked','failed','expired')),
  created_at   timestamptz not null default now(),
  delivered_at timestamptz,
  expires_at   timestamptz not null,
  acked_at     timestamptz,
  result       jsonb
);
create index if not exists agent_commands_pending_idx
  on agent_commands (router_id, status) where status in ('pending','delivered');
create index if not exists agent_commands_job_idx on agent_commands (job_id);

create table if not exists agent_reports (
  id         uuid primary key,
  router_id  uuid not null references routers(id) on delete cascade,
  job_id     uuid references jobs(id) on delete set null,
  sha256     text not null,
  size_bytes int not null,
  body       bytea not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Мониторинг
-- ---------------------------------------------------------------------------

create table if not exists monitoring_samples (
  router_id        uuid not null references routers(id) on delete cascade,
  ts               timestamptz not null,
  reachable        boolean not null,
  service_state    text,
  health           text,
  proxy_health     text,
  latency_ms       int,
  failed_tags      int,
  total_tags       int,
  sing_box_version text,
  agent_version    text,
  detail           jsonb,
  primary key (router_id, ts)
);
create index if not exists monitoring_samples_ts_idx on monitoring_samples (ts);

create table if not exists monitoring_rollups (
  router_id      uuid not null references routers(id) on delete cascade,
  bucket_start   timestamptz not null,
  granularity    text not null check (granularity in ('hour','day')),
  samples        int not null,
  reachable_pct  numeric(5,2) not null,
  avg_latency_ms int,
  p95_latency_ms int,
  unhealthy_pct  numeric(5,2) not null,
  primary key (router_id, granularity, bucket_start)
);

create table if not exists router_availability (
  router_id      uuid primary key references routers(id) on delete cascade,
  offline_since  timestamptz,
  online_since   timestamptz,
  last_transition timestamptz,
  misses         int not null default 0
);

-- ---------------------------------------------------------------------------
-- Диагностика
-- ---------------------------------------------------------------------------

create table if not exists diagnostics_reports (
  id            uuid primary key,
  router_id     uuid not null references routers(id) on delete cascade,
  job_id        uuid references jobs(id) on delete set null,
  batch_id      uuid,
  kind          text not null check (kind in ('quick','full')),
  product       text not null,
  agent_version text,
  report        jsonb not null,
  report_text   text,
  sha256        text not null,
  size_bytes    int not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index if not exists diagnostics_router_idx on diagnostics_reports (router_id, created_at desc);
create index if not exists diagnostics_batch_idx on diagnostics_reports (batch_id);

-- ---------------------------------------------------------------------------
-- sing-box и staged rollout
-- ---------------------------------------------------------------------------

create table if not exists sing_box_versions (
  id            uuid primary key,
  product       text not null,
  tag           text not null,
  release_url   text,
  published_at  timestamptz,
  asset_sha256  text,
  discovered_at timestamptz not null default now(),
  is_stable     boolean not null default true,
  unique (product, tag)
);

create table if not exists rollouts (
  id               uuid primary key,
  version_tag      text not null,
  status           text not null default 'draft'
                   check (status in ('draft','running','paused','completed','cancelled','failed')),
  stage            int not null default 0,
  stage_started_at timestamptz,
  created_by       uuid not null references users(id) on delete restrict,
  approved_by      uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  finished_at      timestamptz
);

create table if not exists rollout_targets (
  rollout_id       uuid not null references rollouts(id) on delete cascade,
  router_id        uuid not null references routers(id) on delete cascade,
  stage            int not null,
  status           text not null default 'pending'
                   check (status in ('pending','installing','verifying','success','failed','skipped','rolled_back')),
  previous_version text,
  started_at       timestamptz,
  finished_at      timestamptz,
  error_code       text,
  primary key (rollout_id, router_id)
);

-- ---------------------------------------------------------------------------
-- Аудит
-- ---------------------------------------------------------------------------

create table if not exists audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    uuid references users(id) on delete set null,
  actor_role  text,
  action      text not null,
  target_type text,
  target_id   uuid,
  router_id   uuid,
  ip          text,
  user_agent  text,
  result      text not null check (result in ('ok','denied','error')),
  code        text,
  metadata    jsonb not null default '{}'::jsonb
);
create index if not exists audit_at_idx on audit_log (at desc);
create index if not exists audit_actor_idx on audit_log (actor_id, at desc);
create index if not exists audit_router_idx on audit_log (router_id, at desc);

-- ---------------------------------------------------------------------------
-- In-app уведомления (без внешних каналов, по решению D-*)
-- ---------------------------------------------------------------------------

create table if not exists notifications (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  router_id   uuid references routers(id) on delete cascade,
  kind        text not null,
  severity    text not null default 'info' check (severity in ('info','warning','critical')),
  message     text not null,
  dedupe_key  text,
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create unique index if not exists notifications_dedupe_idx
  on notifications (user_id, dedupe_key) where dedupe_key is not null;
create index if not exists notifications_user_idx on notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Настройки по умолчанию
-- ---------------------------------------------------------------------------

insert into settings (key, value) values
  ('security.mfa_policy', '{"value":"all"}'::jsonb),
  ('security.session_days', '{"value":30}'::jsonb),
  ('limits', '{"routers_per_user":10,"users_per_instance":20,"routers_per_instance":100,"batch_size":10,"templates_per_user":50}'::jsonb),
  ('monitoring', '{"interval_seconds":60,"offline_after_misses":3,"latency_degraded_ms":1500,"stagger_seconds":50}'::jsonb),
  ('retention', '{"days":30,"commands_days":7,"snapshots_local":10}'::jsonb),
  ('agent', '{"poll_hold_seconds":25,"command_ttl_read_seconds":120,"command_ttl_mutate_seconds":600,"min_version":"1.0.0"}'::jsonb),
  ('singbox', '{"user_install":true,"user_cooldown_hours":24,"staged_rollout":"superadmin"}'::jsonb),
  ('features', '{"mtls":false,"logread":false,"auto_reconcile":false,"api_tokens":false}'::jsonb)
on conflict (key) do nothing;

update settings
   set value = '{"version": 2}'::jsonb, updated_at = now()
 where key = 'schema_version';
