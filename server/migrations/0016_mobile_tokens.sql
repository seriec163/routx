-- Одноразовые ссылки для входа с телефона по QR.
-- Токен хранится только в виде SHA-256, живёт 5 минут и используется один раз.

create table if not exists mobile_tokens (
  id         uuid primary key,
  token_hash bytea not null unique,
  user_id    uuid not null references users(id) on delete cascade,
  router_id  uuid not null references routers(id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mobile_tokens_expires_idx
  on mobile_tokens (expires_at);

create index if not exists mobile_tokens_user_idx
  on mobile_tokens (user_id, created_at desc);

update settings
   set value = '{"version": 16}'::jsonb, updated_at = now()
 where key = 'schema_version';
