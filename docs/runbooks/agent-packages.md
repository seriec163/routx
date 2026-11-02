# Установка и удаление агента RoutX

Поддерживаются обе схемы пакетов OpenWrt:

* OpenWrt 24.10 и older — `opkg` (`routx-agent.ipk`);
* OpenWrt 25+ / apk-based — `apk` (`routx-agent.apk`).

Во всех случаях `/etc/config/routx` с привязкой сохраняется.

## Установка через установщик RoutX

Стандартная команда из панели сама определяет менеджер пакетов:

```sh
wget -qO- https://routx.example/agent/install.sh | sh -s -- \
  --server https://routx.example --token <token>
```

Установщик:

1. Проверяет `opkg` или `apk`.
2. Доустанавливает `coreutils-timeout` и `ucode-mod-digest` доступным менеджером.
3. Скачивает `.ipk`, `.apk` и `.tar.gz`.
4. На `opkg` ставит `routx-agent.ipk`.
5. На `apk` ставит `routx-agent.apk`:

```sh
apk add --upgrade --allow-untrusted --force-overwrite ./routx-agent.apk
```

6. Если пакетный менеджер недоступен или установка не удалась, использует
   `routx-agent.tar.gz`, сохраняя старый `/etc/config/routx`.

## Обновление вручную

OpenWrt 24.10 / opkg:

```sh
wget -qO /tmp/routx-agent.ipk https://routx.example/agent/routx-agent.ipk
opkg install --force-reinstall /tmp/routx-agent.ipk
/etc/init.d/routx-agent restart
```

OpenWrt 25+ / apk:

```sh
wget -qO /tmp/routx-agent.apk https://routx.example/agent/routx-agent.apk
apk add --upgrade --allow-untrusted --force-overwrite /tmp/routx-agent.apk
/etc/init.d/routx-agent restart
```

Конфиг `/etc/config/routx` в apk-пакете намеренно не поставляется: его
создаёт `90-routx-agent`, а при обновлении существующий файл не перезаписывается.

## Удаление

opkg:

```sh
opkg remove routx-agent
```

apk:

```sh
apk del routx-agent
```

Скрипт `pre-deinstall`/`prerm` останавливает и отключает `routx-agent` перед
удалением. Если использовался tar-фолбэк без пакетного менеджера, удаляйте
файлы вручную:

```sh
/etc/init.d/routx-agent stop
/etc/init.d/routx-agent disable
rm -rf /usr/lib/routx-agent /usr/bin/routx-agent /etc/init.d/routx-agent \
  /etc/uci-defaults/90-routx-agent /www/luci-static/resources/view/routx-agent
# /etc/config/routx удаляйте только если действительно хотите сбросить привязку
```

## Проверка

```sh
routx-agent version
routx-agent status
```

Ожидаемая версия:

- **1.1.0+** — DNS-бенчмарк;
- **1.1.1+** — автозапуск продукта; sing-box запускается самим Prokop/Forkop,
  его standalone-автозапуск продукт отключает штатно;
- **1.1.2+** — безопасное слияние подключений: сохраняются чужие VLESS-ссылки и
  не создаются дубликаты подписок, уже добавленных в секцию вручную;
- **1.1.3+** — исправлен автозапуск: агент больше не пытается включить
  standalone-автозапуск sing-box (в 1.1.2 он включался, но Prokop/Forkop всё
  равно снимал его при следующем старте);
- **1.1.4+** — здоровье и быстрая диагностика учитывают, что sing-box
  управляется продуктом: выключенный `S99sing-box` при запущенном
  Prokop/Forkop больше не считается деградацией;
- **1.1.5+** — домены секции пишутся в новый combined-формат `domain`
  (`full:`, `keyword:`, `regex:`), старые `domain_keyword`/`domain_regex`
  удаляются при следующем применении;
- **1.1.6+** — DNS-бенчмарк использует DoH по IP-адресам
  (`https://1.1.1.1/dns-query` и т.п.), до трёх основных DNS и фиксированный
  bootstrap: `77.88.8.8`, `8.8.4.4`, `1.1.1.1`, `9.9.9.9`;
- **1.1.7+** — полное управление подключениями: список подписок и прямых
  ссылок, замена и удаление с маскированием секретов;
- **1.1.8+** — в мониторинге прокси группа показывается по label секции
  (`router_control`), а не по внутреннему тегу `gga-out`.
