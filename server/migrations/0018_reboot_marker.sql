-- Отметка о запрошенной перезагрузке: по ней сервер понимает,
-- что роутер вернулся в сеть именно после ребута, и показывает попап.
alter table routers
  add column if not exists reboot_requested_at timestamptz;

update settings
   set value = '{"version": 18}'::jsonb, updated_at = now()
 where key = 'schema_version';
