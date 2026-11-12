alter table routers
  add column if not exists installed_products jsonb not null default '[]'::jsonb;
