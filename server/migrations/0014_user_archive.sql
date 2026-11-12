-- Архив пользователей: безопасная альтернатива удалению.
-- Архивный пользователь не может войти, не занимает место в лимите
-- учётных записей и может быть восстановлен.

alter table users add column if not exists archived_at timestamptz;

create index if not exists users_archived_idx
  on users (archived_at)
  where archived_at is not null;

update settings
   set value = '{"version": 14}'::jsonb, updated_at = now()
 where key = 'schema_version';
