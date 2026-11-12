-- Правила (секции) роутера и подключения, привязанные к конкретной секции.
--
-- Раньше все подключения Router Control писались в одну секцию
-- routers.managed_section. Теперь у каждого подключения есть своя секция,
-- поэтому можно создать отдельное правило «YouTube через VPN» и не смешивать
-- его с основным.

alter table router_connections
  add column if not exists section text;

update router_connections c
   set section = coalesce(r.managed_section, 'router_control')
  from routers r
 where r.id = c.router_id
   and c.section is null;

update router_connections
   set section = 'router_control'
 where section is null;

alter table router_connections
  alter column section set not null;

-- Старое ограничение запрещало одинаковые подписи даже в разных секциях.
alter table router_connections
  drop constraint if exists router_connections_router_id_label_key;

create unique index if not exists router_connections_section_label_idx
  on router_connections (router_id, section, label);

create index if not exists router_connections_section_idx
  on router_connections (router_id, section, created_at asc);

-- Для применений, созданных вручную (без шаблона), нужно знать, какие секции
-- агент должен создать. Раньше это выводилось только из ревизии шаблона.
alter table apply_runs
  add column if not exists create_sections jsonb not null default '[]'::jsonb;

update settings
   set value = '{"version": 15}'::jsonb, updated_at = now()
 where key = 'schema_version';
