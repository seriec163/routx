-- Поэтапное обновление sing-box: вариант и версия.
alter table rollouts add column if not exists variant text;

update rollouts set variant = 'extended' where variant is null;

update settings
   set value = '{"version": 6}'::jsonb, updated_at = now()
 where key = 'schema_version';
