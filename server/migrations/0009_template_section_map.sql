-- Явное сопоставление секций шаблона с секциями роутера.
alter table template_assignments
  add column if not exists section_map jsonb;

update settings
   set value = '{"version": 9}'::jsonb, updated_at = now()
 where key = 'schema_version';
