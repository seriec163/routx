-- Каталог подписок и доступ к ним.
create table if not exists subscriptions (
  id          uuid primary key,
  owner_id    uuid not null references users(id) on delete cascade,
  name        text not null,
  description text,
  secret_enc  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (owner_id, name)
);

create table if not exists subscription_access (
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (subscription_id, user_id)
);

create index if not exists subscription_access_user_idx on subscription_access (user_id);

-- Связь подключения роутера с каталогом. NULL — ссылка вставлена вручную.
alter table router_connections
  add column if not exists subscription_id uuid references subscriptions(id) on delete set null;

update settings
   set value = '{"version": 8}'::jsonb, updated_at = now()
 where key = 'schema_version';
