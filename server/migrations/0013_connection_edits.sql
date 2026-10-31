-- Временное хранение нового секрета при замене внешней подписки/ссылки.
-- Секрет шифруется тем же RC_MASTER_KEY и удаляется после выполнения задачи.

create table if not exists connection_edits (
  id uuid primary key,
  router_id uuid not null references routers(id) on delete cascade,
  secret_enc text not null,
  created_at timestamp with time zone not null default now()
);

create index if not exists connection_edits_router_idx
  on connection_edits (router_id, created_at desc);

update settings
   set value = '{"version": 13}'::jsonb, updated_at = now()
 where key = 'schema_version';
