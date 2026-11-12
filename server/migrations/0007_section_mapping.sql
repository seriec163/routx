-- Привязка секций шаблона к существующим секциям роутера при diff/apply.
alter table apply_runs add column if not exists section_map jsonb;

update settings
   set value = '{"version": 7}'::jsonb, updated_at = now()
 where key = 'schema_version';
