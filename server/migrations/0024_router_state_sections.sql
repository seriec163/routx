-- Состояние секций и подключений с Clash API (активный прокси,
-- задержка, доступность) для отображения в панели и PWA.
alter table router_state add column if not exists sections jsonb;
