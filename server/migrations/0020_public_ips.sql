-- Публичные IP роутера: напрямую и через VPN.
alter table monitoring_samples
  add column if not exists direct_ip text,
  add column if not exists vpn_ip text;
