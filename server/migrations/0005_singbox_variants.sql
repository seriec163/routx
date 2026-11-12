-- sing-box: предыдущий вариант/версия для отката после неудачной смены.
alter table routers add column if not exists sing_box_previous_version text;
alter table routers add column if not exists sing_box_previous_variant text;
alter table routers add column if not exists sing_box_installed_at timestamptz;

update settings
   set value = '{"version": 5}'::jsonb, updated_at = now()
 where key = 'schema_version';
