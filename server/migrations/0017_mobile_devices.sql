-- Авторизованные телефоны (устройства), которые вошли по QR с роутера.
-- Устройство живёт, пока владелец не удалит его на самом роутере.

create table if not exists mobile_devices (
  id          uuid primary key,
  router_id   uuid not null references routers(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  platform    text,
  user_agent  text,
  ip          text,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  text
);

create index if not exists mobile_devices_router_idx
  on mobile_devices (router_id, revoked_at);

create index if not exists mobile_devices_user_idx
  on mobile_devices (user_id, created_at desc);

alter table sessions
  add column if not exists mobile_device_id uuid references mobile_devices(id) on delete set null;

create index if not exists sessions_mobile_device_idx
  on sessions (mobile_device_id);

update settings
   set value = '{"version": 17}'::jsonb, updated_at = now()
 where key = 'schema_version';
