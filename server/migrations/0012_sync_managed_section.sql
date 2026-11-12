-- Приводим managed_section к физической секции роутера.
--
-- Раньше routers.managed_section хранил логическое имя router_control, даже
-- когда шаблон был сопоставлен с существующей секцией gga. Из-за этого
-- интерфейс показывал две секции, а применение подключений создавало вторую
-- физическую секцию router_control.
--
-- Меняем имя только тогда, когда старой секции на роутере уже нет, а целевая
-- секция из сопоставления существует. Если обе секции есть, ничего не трогаем:
-- решение должен принять пользователь.

update routers r
   set managed_section = ta.section_map->>r.managed_section,
       updated_at = now()
  from template_assignments ta
 where ta.router_id = r.id
   and r.managed_section is not null
   and ta.section_map is not null
   and ta.section_map ? r.managed_section
   and ta.section_map->>r.managed_section <> r.managed_section
   and exists (
     select 1
       from router_state rs
      where rs.router_id = r.id
        and rs.managed ? ('section.' || (ta.section_map->>r.managed_section) || '.action')
   )
   and not exists (
     select 1
       from router_state rs
      where rs.router_id = r.id
        and rs.managed ? ('section.' || r.managed_section || '.action')
   );

update settings
   set value = '{"version": 12}'::jsonb, updated_at = now()
 where key = 'schema_version';
