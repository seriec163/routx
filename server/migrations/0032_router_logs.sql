-- Каталог логов и ошибок с роутеров.
--
-- Сюда попадают:
--  * полные логи Tachyon/sing-box из диагностики;
--  * ошибки задач (job), чтобы разбирать сбои без доступа к роутеру;
--  * автоматическая быстрая диагностика при переходе службы в failed/stopped.

create table if not exists router_logs (
  id         uuid primary key,
  router_id  uuid not null references routers(id) on delete cascade,
  source     text not null,
  level      text not null check (level in ('error', 'warn', 'info')),
  message    text not null,
  context    jsonb not null default '{}'::jsonb,
  job_id     uuid,
  created_at timestamptz not null default now()
);

create index if not exists router_logs_router_idx
  on router_logs (router_id, created_at desc);

create index if not exists router_logs_level_idx
  on router_logs (level, created_at desc);

create index if not exists router_logs_created_idx
  on router_logs (created_at);
