-- Общий доступ к шаблонам: владелец может открыть шаблон другим
-- пользователям панели. Чужие шаблоны доступны только для чтения и
-- применения; редактирует и удаляет по-прежнему владелец.
alter table templates
  add column if not exists shared boolean not null default false;

create index if not exists templates_shared_idx
  on templates (updated_at desc)
  where shared;
