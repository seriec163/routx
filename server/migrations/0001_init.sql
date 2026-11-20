-- Этап 1: служебные настройки инстанса.
-- Остальные таблицы (users, routers, templates, jobs, monitoring) добавляются
-- на этапах 2–7 отдельными миграциями.

create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

insert into settings (key, value)
values ('schema_version', '{"version": 1}'::jsonb)
on conflict (key) do nothing;
