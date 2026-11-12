-- Одноразовые ссылки сброса пароля. Создаёт только суперадминистратор,
-- токен хранится хэшем, действует ограниченное время и используется один раз.
create table if not exists password_resets (
  id         uuid primary key,
  user_id    uuid not null references users(id) on delete cascade,
  token_hash bytea not null unique,
  created_by uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists password_resets_open_idx
  on password_resets (expires_at)
  where used_at is null;

create index if not exists password_resets_user_idx
  on password_resets (user_id, created_at desc);

update settings
   set value = '{"version": 11}'::jsonb, updated_at = now()
 where key = 'schema_version';
