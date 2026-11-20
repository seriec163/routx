# RoutX на OpenWrt с HTTPS

Схема, по которой RoutX работает на роутере `192.168.2.1`:

* Docker Compose: `db`, `app`, `caddy`;
* приложение слушает только `127.0.0.1:3000`;
* Caddy слушает `443` и проксирует на `app:3000`;
* LuCI остаётся на `80`, HTTPS LuCI переведён на `8443`;
* сертификат Let's Encrypt Caddy получает через TLS-ALPN-01 (порт 80 не нужен).

## 1. Освободить 443 у LuCI

```sh
uci delete uhttpd.main.listen_https
uci add_list uhttpd.main.listen_https='0.0.0.0:8443'
uci add_list uhttpd.main.listen_https='[::]:8443'
uci commit uhttpd
/etc/init.d/uhttpd restart
```

LuCI после этого: `http://192.168.2.1` и `https://192.168.2.1:8443`.

## 2. Разрешить 443 с WAN

```sh
uci add firewall rule
uci set firewall.@rule[-1].name='Allow-RoutX-HTTPS'
uci set firewall.@rule[-1].src='wan'
uci set firewall.@rule[-1].proto='tcp'
uci set firewall.@rule[-1].dest_port='443'
uci set firewall.@rule[-1].target='ACCEPT'
uci commit firewall
/etc/init.d/firewall reload
```

## 3. Окружение

В `/opt/routx/.env`:

```env
RC_DOMAIN=routx.duckdns.org
RC_PUBLIC_URL=https://routx.duckdns.org
RC_COOKIE_SECURE=true
TRUST_PROXY=true
```

`RC_MASTER_KEY` и `POSTGRES_PASSWORD` — свои. Домен должен указывать
на публичный IP роутера.

## 4. Запуск

```sh
cd /opt/routx
# docker-compose.yml и Caddyfile из этого каталога
docker compose up -d
```

Проверка:

```sh
curl -I https://routx.duckdns.org
curl https://routx.duckdns.org/healthz
docker compose logs caddy --tail 30
```

В журнале Caddy должно быть `certificate obtained successfully`
и `serving initial configuration`.

## 5. Обновление

```sh
cd /opt/routx
docker compose pull
docker compose up -d
```

Образ берётся из `ghcr.io/seriec163/routx:latest`. Для локальной сборки:
`docker build -t ghcr.io/seriec163/routx:latest .`.

Сертификат и приватный ключ лежат в томе `caddy_data` и переживают
пересоздание контейнера. Продление автоматическое.

## 6. DuckDNS

Домен `routx.duckdns.org` должен указывать на публичный IPv4 роутера.
Готовый апдейтер и инструкция — в каталоге [`ddns/`](ddns/README.md).
Он проверяет IP каждые 5 минут, обновляет запись по HTTPS и держит токен
в файле `0600`.

## Важно

* Порт **80 не используется RoutX**. Если на роутере он занят (например,
  пробросом на Home Assistant), открытие `http://домен` попадёт в тот сервис.
  Для переадресации HTTP→HTTPS нужно освободить 80 и убрать
  `auto_https disable_redirects` в Caddyfile.
* Приложение намеренно не публикуется в LAN на 3000 — только через HTTPS.
* A-запись DuckDNS обновляет служба `routx-ddns` (каталог `ddns/`).
  Она ставится отдельно и хранит токен в файле `0600`. Без неё при смене
  публичного IP домен и сертификат перестанут работать.
* После смены `RC_COOKIE_SECURE=true` вход по старому HTTP-адресу
  не сохраняет сессию. Используйте HTTPS.
