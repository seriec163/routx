alter table routers drop constraint if exists routers_product_check;
alter table routers
  add constraint routers_product_check
  check (product = any (array['forkop', 'prokop', 'podkop', 'tachyon', 'unknown', 'conflict']));
