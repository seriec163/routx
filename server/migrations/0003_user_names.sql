-- Пользовательские имена для персонализированного приветствия
alter table users add column if not exists first_name text;
alter table users add column if not exists middle_name text;
alter table users add column if not exists last_name text;

update settings set value = '{"version": 3}'::jsonb, updated_at = now() where key = 'schema_version';
