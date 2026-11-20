-- Поддержка Podkop как третьего продукта на клиентском роутере.
alter table routers drop constraint if exists routers_product_check;
alter table routers add constraint routers_product_check
  check (product in ('forkop', 'prokop', 'podkop', 'unknown', 'conflict'));

alter table binding_tokens drop constraint if exists binding_tokens_product_hint_check;
alter table binding_tokens add constraint binding_tokens_product_hint_check
  check (product_hint in ('any', 'forkop', 'prokop', 'podkop'));
