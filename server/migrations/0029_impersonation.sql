-- Вход суперадминистратора под пользователем.
-- impersonated_by хранится в сессии, чтобы интерфейс показал плашку
-- «вы вошли как …»; возврат к суперадминистратору требует отдельную
-- HttpOnly-cookie с его исходной сессией.

alter table sessions add column if not exists impersonated_by uuid
  references users(id) on delete set null;
create index if not exists sessions_impersonated_by_idx
  on sessions (impersonated_by) where impersonated_by is not null;
