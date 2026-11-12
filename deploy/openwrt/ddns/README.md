# DuckDNS на роутере

Caddy получает сертификат для `routx.duckdns.org` и принимает HTTPS на 443.
Если публичный IPv4 роутера меняется, A-запись должна обновляться, иначе
домен и продление сертификата перестанут работать.

Для этого на роутере работает маленькая служба `routx-ddns`:

* проверяет IPv4 интерфейса `wan` каждые 5 минут;
* обновляет DuckDNS по HTTPS, если IP изменился;
* раз в 24 часа отправляет обновление принудительно (DuckDNS удаляет
  неактивные домены, а запись самовосстанавливается после ручных правок);
* хранит токен в отдельном файле `0600`, не передаёт его в аргументах
  процесса и не пишет в журнал;
* после перезагрузки обновляет запись сразу (состояние в `/var/run`).

Служба не зависит от `ddns-scripts` и не меняет его настройки.

## Файлы

| Путь | Назначение |
| --- | --- |
| `/usr/sbin/routx-ddns` | сам апдейтер |
| `/etc/init.d/routx-ddns` | служба procd, автозапуск |
| `/etc/config/routx-ddns` | настройки (без секретов) |
| `/etc/routx-ddns/token` | токен DuckDNS, режим `0600` |

## Установка

Скопировать файлы из этого каталога на роутер:

```sh
mkdir -p /etc/routx-ddns
chmod 700 /etc/routx-ddns

cp routx-ddns /usr/sbin/routx-ddns
cp routx-ddns.init /etc/init.d/routx-ddns
cp routx-ddns.config /etc/config/routx-ddns
chmod 755 /usr/sbin/routx-ddns /etc/init.d/routx-ddns
chmod 644 /etc/config/routx-ddns
```

Записать токен (он показан на [duckdns.org](https://www.duckdns.org)
в блоке `token`):

```sh
printf '%s\n' 'ВАШ_ТОКЕН' > /etc/routx-ddns/token
chmod 600 /etc/routx-ddns/token
```

Запустить и включить автозапуск:

```sh
/etc/init.d/routx-ddns enable
/etc/init.d/routx-ddns restart
```

Нужен `curl` (в OpenWrt 24 — `opkg install curl`, в 25+ — `apk add curl`).

## Проверка

```sh
logread -e routx-ddns | tail -5
# routx-ddns: DuckDNS updated: routx.duckdns.org -> 203.0.113.10

cat /var/run/routx-ddns/ip
nslookup routx.duckdns.org 1.1.1.1
```

Успешное обновление DuckDNS отвечает `OK`. Ответ `KO` означает неверный
токен или домен: проверьте `/etc/routx-ddns/token` и
`uci show routx-ddns`.

## Настройки

`/etc/config/routx-ddns`:

```uci
config ddns 'main'
	option enabled '1'
	option domain 'routx.duckdns.org'
	option interface 'wan'
	option check_interval '300'
	option retry_interval '60'
	option force_interval '86400'
	option token_file '/etc/routx-ddns/token'
```

После правки:

```sh
/etc/init.d/routx-ddns restart
```

## Выключить

```sh
/etc/init.d/routx-ddns disable
/etc/init.d/routx-ddns stop
```

## Почему не ddns-scripts

`ddns-scripts` в OpenWrt пишет URL обновления (вместе с токеном) в
`/var/run/ddns/<служба>.err`, причём файл создаётся с правами `0644`.
Отдельный апдейтер позволяет держать токен только в файле `0600`
и не зависеть от формата пакета. Если нужен именно LuCI-интерфейс,
можно настроить `ddns-scripts`, но тогда токен окажется в его журнале.
