-- Три уровня доступа:
--   superadmin — вся панель и все роутеры;
--   admin      — свои роутеры и пользователи своей ветки, без настроек панели;
--   user       — только свои роутеры.
-- parent_id задаёт ветку: пользователь, приглашённый администратором, получает
-- parent_id = id этого администратора. У пользователей superadmin parent_id = null.

alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('superadmin', 'admin', 'user'));

alter table users add column if not exists parent_id uuid references users(id) on delete set null;
create index if not exists users_parent_idx on users (parent_id);

alter table invites drop constraint if exists invites_role_check;
alter table invites add constraint invites_role_check
  check (role in ('superadmin', 'admin', 'user'));
