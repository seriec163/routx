-- Passkeys (WebAuthn) и одноразовые резервные коды.
--
-- Passkey — дополнительный способ входа: приватный ключ хранится в
-- защищённом чипе телефона/ноутбука, на сервере лежит только открытый ключ.
-- Резервные коды дают полное восстановление доступа: сброс пароля,
-- отключение TOTP и удаление всех passkey.

create table if not exists webauthn_credentials (
  id            uuid primary key,
  user_id       uuid not null references users(id) on delete cascade,
  credential_id text not null unique,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  device_type   text,
  backed_up     boolean not null default false,
  name          text not null default 'Passkey',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index if not exists webauthn_credentials_user_idx
  on webauthn_credentials (user_id, created_at desc);

create table if not exists webauthn_challenges (
  id          uuid primary key,
  challenge   text not null,
  user_id     uuid references users(id) on delete cascade,
  kind        text not null check (kind in ('registration', 'authentication')),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists webauthn_challenges_expires_idx
  on webauthn_challenges (expires_at);

create index if not exists webauthn_challenges_user_idx
  on webauthn_challenges (user_id, kind);

create table if not exists recovery_codes (
  id         uuid primary key,
  user_id    uuid not null references users(id) on delete cascade,
  code_hash  bytea not null unique,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

create index if not exists recovery_codes_user_idx
  on recovery_codes (user_id, used_at);
