-- Web Push: подписки браузеров и установленных PWA на уведомления.
-- endpoint уникален: один браузер может быть привязан только к одному
-- пользователю, повторная подписка обновляет владельца и ключи.
create table if not exists push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  endpoint        text not null,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_success_at timestamptz,
  last_error      text,
  last_error_at   timestamptz
);

create unique index if not exists push_subscriptions_endpoint_idx
  on push_subscriptions (endpoint);
create index if not exists push_subscriptions_user_idx
  on push_subscriptions (user_id, created_at desc);
