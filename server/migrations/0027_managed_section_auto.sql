-- Основная секция роутера не должна зависеть от имени router_control.
--
-- 1) Убираем default/NOT NULL, чтобы новые роутеры не получали фиктивное
--    имя до первого чтения состояния.
-- 2) Если текущая managed_section выключена или отсутствует, а на роутере
--    ровно одна включённая секция с подключением — выбираем её.
-- 3) Если legacy-секции router_control на роутере нет — сбрасываем имя,
--    чтобы первый же read_state выбрал реальную секцию.

alter table routers alter column managed_section drop default;
alter table routers alter column managed_section drop not null;

with section_flags as (
  select rs.router_id,
         substring(e.key from '^section\.([^.]+)\.') as name,
         max(case when split_part(e.key, '.', 3) = 'action' then e.value end) as action,
         max(case when split_part(e.key, '.', 3) = 'enabled' then e.value end) as enabled
    from router_state rs
    cross join lateral jsonb_each_text(rs.managed) as e(key, value)
   where e.key like 'section.%'
   group by 1, 2
),
enabled_sections as (
  select router_id, name
    from section_flags
   where action in ('connection', 'proxy', 'outbound', 'vpn')
     and coalesce(enabled, '1') <> '0'
),
counts as (
  select router_id, count(*) as total, min(name) as only_name
    from enabled_sections
   group by 1
)
update routers r
   set managed_section = c.only_name,
       updated_at = now()
  from counts c
 where c.router_id = r.id
   and c.total = 1
   and not exists (
     select 1
       from section_flags s
      where s.router_id = r.id
        and s.name = r.managed_section
        and s.action in ('connection', 'proxy', 'outbound', 'vpn')
        and coalesce(s.enabled, '1') <> '0'
   );

update routers r
   set managed_section = null,
       updated_at = now()
 where r.managed_section = 'router_control'
   and not exists (
     select 1
       from router_state rs
      where rs.router_id = r.id
        and rs.managed ? 'section.router_control.action'
   );

update settings
   set value = '{"version": 27}'::jsonb, updated_at = now()
 where key = 'schema_version';
