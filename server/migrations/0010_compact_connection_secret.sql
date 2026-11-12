-- Компактный секрет rc1.… для подключения. Сам секрет уже зашифрован
-- AES-256-GCM ключом, производным от RC_MASTER_KEY, поэтому в БД хранится
-- как текст и не требует повторного шифрования.
alter table router_connections
  add column if not exists compact_secret text;

update settings
   set value = '{"version": 10}'::jsonb, updated_at = now()
 where key = 'schema_version';
