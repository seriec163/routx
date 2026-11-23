-- Долгоживущая привязка телефона к RoutX.
--
-- Обычная сессия живёт ограниченное время и продлевается при активности.
-- Дополнительно устройство получает HttpOnly-cookie rc_device: по нему
-- приложение может прозрачно получить новую сессию, если cookie сессии
-- потерялась или истекла. Привязка хранится в mobile_devices и удаляется
-- вместе с приложением (cookie) либо отзывом устройства на роутере.
--
-- client_device_id — идентификатор установленного PWA из localStorage.
-- Нужен, чтобы повторный скан QR в том же приложении переиспользовал
-- существующую строку устройства, а не создавал новую.

alter table mobile_devices
  add column if not exists client_device_id text,
  add column if not exists device_token_hash bytea,
  add column if not exists device_token_created_at timestamptz,
  add column if not exists device_token_last_used_at timestamptz;

create unique index if not exists mobile_devices_client_idx
  on mobile_devices (router_id, user_id, client_device_id)
  where client_device_id is not null and revoked_at is null;

create unique index if not exists mobile_devices_token_idx
  on mobile_devices (device_token_hash)
  where device_token_hash is not null;
