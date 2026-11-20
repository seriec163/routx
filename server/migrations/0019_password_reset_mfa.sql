-- Сброс 2FA вместе с паролем: администратор может включить это в ссылке
-- восстановления, если пользователь потерял телефон с аутентификатором.
alter table password_resets
  add column if not exists reset_mfa boolean not null default false;
