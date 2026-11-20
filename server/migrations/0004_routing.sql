-- Router Control: управляемые списки, секция Router Control и подключения.
-- Секреты подключений хранятся только в зашифрованном виде (AES-256-GCM).

alter table routers add column if not exists managed_section text not null default 'router_control';
alter table routers add column if not exists list_extras jsonb not null default '{}'::jsonb;

alter table apply_runs add column if not exists local_lists jsonb not null default '[]'::jsonb;

create table if not exists router_connections (
  id          uuid primary key,
  router_id   uuid not null references routers(id) on delete cascade,
  kind        text not null check (kind in ('subscription','vless')),
  label       text not null,
  secret_enc  text not null,
  enabled     boolean not null default true,
  created_by  uuid not null references users(id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (router_id, label)
);
create index if not exists router_connections_router_idx on router_connections (router_id, created_at asc);

update settings
   set value = '{"version": 4}'::jsonb, updated_at = now()
 where key = 'schema_version';
