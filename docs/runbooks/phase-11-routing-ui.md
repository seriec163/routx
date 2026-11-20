# Итерация: имена, списки и подключения

Документ описывает изменения после этапа 1: персонализацию, галочки списков Prokop/Forkop,
серверные дополнения к шаблону, подписки/VLESS и подготовку RoutX к установке.

---

## 1. Имена и приветствие

* Поля `users.first_name`, `users.middle_name`, `users.last_name` (миграция `0003_user_names.sql`).
* Пользователь редактирует их в «Аккаунте»: `PATCH /api/v1/auth/me`.
* Суперадминистратор редактирует их в «Пользователях»: `PATCH /api/v1/users/{id}`.
* Приветствие на дашборде: `Здравствуйте, <first_name> <middle_name>`.
  Если имя не задано — используется часть e-mail до `@`.

---

## 2. Шаблон: галочки вместо JSON

Payload шаблона дополнен полями:

```json
{
  "sections": {
    "router_control": {
      "action": "connection",
      "enabled": "1",
      "label": "RoutX",
      "community_lists": ["youtube", "telegram"],
      "rule_set": ["https://example.com/list.srs"],
      "remote_domain_lists": ["https://example.com/domains.lst"],
      "remote_subnet_lists": ["https://example.com/subnets.lst"]
    }
  },
  "create_sections": ["router_control"],
  "manual_entries": {
    "router_control": {
      "domains": ["example.com"],
      "ips": ["203.0.113.10", "2001:db8::/32"]
    }
  }
}
```

* `create_sections` — секции, которые агент создаст, если их нет. Для каждой обязателен `action`.
  Сервер дополнительно считает создаваемой любую секцию шаблона с заданным `action`,
  поэтому `create_sections` больше не нужно заполнять вручную: поведение
  «если секции нет — создать» работает для всех шаблонов.
* Галочки — это `community_lists`. Каталог и подписи взяты из Prokop/Forkop
  (`prokop/files/usr/lib/singbox/rulesets.uc`, `luci-app-prokop/.../section.js`).
* DNS управляется отдельной панелью: `dns_type`, `dns_server`, `bootstrap_dns_server`,
  `dns_strategy`, `dns_check_interval`, `dns_failover_failure_threshold`, `dns_rewrite_ttl`,
  `dns_detour_enabled`, `dns_detour_section`, `intercept_client_dns`, `disable_quic`.
  Пустое поле означает «не управлять»; для удаления параметра нужен явный `null` через JSON.
* DNS-правило (`action: dns`) может задавать свои `dns_type`, `dns_server`,
  `dns_detour_enabled` и `dns_detour_section`.
* Секции читаются из состояния роутеров: `GET /api/v1/router-sections`. В редакторе
  показывается список всех секций, найденных на роутерах; кнопка «В шаблон» копирует
  текущие значения и добавляет секцию в `create_sections`. Так шаблон можно применить
  к любой существующей секции, а отсутствующую — создать.
* Если в шаблоне есть секция с действием `connection`/`proxy`/`outbound`/`vpn`,
  а на роутере её нет, сервер ищет существующую секцию с подпиской
  (`subscription_url.*.section`) и привязывает шаблон к ней. Например,
  `router_control` → `gga`. Привязка сохраняется в
  `template_assignments.section_map` и показывается в таблице назначений и в diff.
* Сопоставление можно изменить вручную: на странице роутера → «Шаблоны и diff» →
  «Сопоставление». Выбирается целевая секция роутера для каждой секции шаблона.
  Целевая секция должна существовать в прочитанном состоянии роутера.
* Если подходящей секции нет или их несколько, diff останавливается с понятной
  ошибкой. Это защищает от создания правила `connection` без подключения, из-за
  которого Prokop отказывается загружать конфигурацию.
* Ручные домены/IP не пишутся в UCI напрямую: RoutX собирает локальный `.lst`
  в `/etc/routx-agent/lists/<section>-<hash>.lst` и добавляет путь в `domain_ip_lists`.
  Хэш в имени меняется при изменении содержимого, поэтому diff всегда видит изменение.
* Секреты (`selector_proxy_links`, `subscription_url.url`, `outbound_jsons`) в шаблон
  по-прежнему попасть не могут.

Каталог для UI: `GET /api/v1/settings/routing-catalog`.

---

## 3. Дополнения роутера к шаблону

Вкладка «Свои списки» на странице роутера: `GET/PUT /api/v1/routers/{id}/list-extras`.

```json
{
  "section": "router_control",
  "rule_set": ["https://example.com/extra.srs"],
  "remote_domain_lists": ["https://example.com/extra-domains.lst"],
  "remote_subnet_lists": [],
  "manual_domains": ["extra.example.com"],
  "manual_ips": ["198.51.100.0/24"]
}
```

* Дополнения хранятся в `routers.list_extras` и подмешиваются к payload при diff/apply.
* Шаблон остаётся базой; при следующем сравнении дополнения видны в diff.
* Дополнения применяются только к секциям, которыми управляет назначенный шаблон.
* Ручные адреса дают отдельный локальный `.lst`; URL-списки добавляются в соответствующие
  list-опции секции.
* В ручных доменах поддерживаются строки-комментарии `//…` и `#…`, а также префиксы
  `full:` (точное совпадение), `keyword:` (подстрока) и `regex:` (регулярка).
  Обычный домен означает домен и все его поддомены.
* Удаление `settings.*` возможно только явным `null`; скалярные опции секции
  (`action`, `label`, `enabled`, `sort_by_latency`, `outbound_detour_*`) не удаляются
  из-за отсутствия в шаблоне.

---

## 4. Подписки и VLESS

Каталог подписок: страница **«Подписки»** в панели.

* `POST /api/v1/subscriptions` — добавить подписку в каталог; ссылка хранится
  в `subscriptions.secret_enc` (AES-256-GCM) и в UI показывается маской.
* Владелец открывает подписку и выбирает пользователей в «Кому доступна».
  Доступ хранится в `subscription_access`; получатель видит подписку в своём
  списке, но не может менять ссылку или передавать доступ дальше.
* `GET /api/v1/subscriptions` — свои и доступные подписки.
* `PUT /api/v1/subscriptions/{id}/access` — заменить список пользователей.
* `GET /api/v1/subscriptions/{id}/share-candidates` — пользователи для выбора.

Вкладка «Подключения» на странице роутера:

* `POST /api/v1/routers/{id}/connections` — добавить `subscription` (http/https)
  или `vless` (vless/vmess/trojan/ss/hysteria2/tuic).
* Для подписки можно передать `subscription_id` из каталога вместо `value`.
  Сервер проверит доступ, расшифрует ссылку и сохранит её копию в подключении.
* Ссылка передаётся по TLS, хранится в `router_connections.secret_enc`
  (AES-256-GCM), в UI показывается маской.
* RoutX пишет данные только в секцию `routers.managed_section` (по умолчанию
  `router_control`):
  * `section.<name>.action = connection`;
  * `section.<name>.selector_proxy_links` — VLESS-ссылки;
  * `subscription_url.rc_sub_<hash>` с `option section '<name>'` и `option url '<url>'`.
* Перед записью создаётся снимок; после записи выполняется reload и проверка состояния.
* Собственные секции пользователя и их VLESS-ссылки не изменяются.

---

## 5. Проверка

```bash
npm run typecheck
npm test
npm run build
docker compose up -d --build
docker compose logs --tail=30 app
```

Ожидаемо: миграции `0003` и `0004` применены, `/healthz` отвечает, в каталоге
`GET /api/v1/settings/routing-catalog` — 27 ресурсов.

---

## 6. Установка RoutX на роутер

Одна команда — из модального окна «Выпустить токен привязки» на странице роутера:

```sh
wget -qO- http(s)://<server>/agent/install.sh | sh -s -- --server <server> --token <token>
```

Установщик сам определяет обстановку:

1. Ищет Prokop (`/usr/bin/prokop`, `/etc/config/prokop`) и Forkop
   (`/usr/bin/forkop`, `/etc/config/forkop`).
2. Если найдены оба продукта — останавливается с `product_conflict` и ничего не меняет.
3. Если продукт уже есть — ставит/обновляет только агента.
4. Если продукта нет:
   * приходит `--product prokop|forkop` из токена привязки (если продукт был указан
     у роутера) — ставится он;
   * иначе установщик спрашивает в терминале SSH, что поставить: Prokop (по умолчанию)
     или Forkop. Без терминала нужен явный `--product`.
5. Сначала ставится и привязывается агент, затем — выбранный продукт официальным
   установщиком:
   * Prokop: `https://asofwar.github.io/prokop/install.sh --lang ru`
     (можно добавить `--sing-box tiny|stable|extended`);
   * Forkop: `https://raw.githubusercontent.com/ushan0v/forkop/main/install.sh`.
6. После установки продукта агент перезапускается и заново определяет продукт.

Дополнительные флаги:

```sh
sh install.sh --server URL --token TOKEN \
  --product prokop \
  --sing-box tiny
```

`--sing-box` действует только при установке Prokop на роутер без sing-box.

### Страница в LuCI

Пакет `routx-agent` кладёт в LuCI отдельное приложение:

* `usr/share/luci/menu.d/luci-app-routx-agent.json` — **Службы → RoutX**;
* `usr/share/rpcd/acl.d/luci-app-routx-agent.json` — доступ только на чтение
  `/var/run/routx-agent/status.json` и перезапуск агента;
* `www/luci-static/resources/view/routx-agent/status.js` — сама страница.

Страница показывает: состояние связи (подключён / ожидает привязки / не отвечает),
сервер, ID роутера, продукт и его версию, вариант и версию sing-box, версию агента,
модель и версию OpenWrt. Есть кнопки «Обновить», «Перезапустить агент» и
«Сменить секрет».

«Сменить секрет» вызывает `routx-agent rotate`: агент отправляет
`POST /agent/v1/rotate` со своим текущим токеном, сервер выдаёт новый, агент
сохраняет его в `/etc/config/routx`. Старый токен остаётся действителен
10 минут на случай обрыва. Привязка и настройки роутера не меняются.

Данные берутся из `/var/run/routx-agent/status.json` (0644, без токенов). Файл
обновляется после каждого длинного опроса (25 с) и после каждой команды сервера.
Статус считается устаревшим через 150 секунд без обновления.

Странице нужны `luci-base` и `rpcd-mod-file` — они уже есть в стандартной LuCI
OpenWrt 24.10. Если пункт меню не появился:

```sh
rm -f /tmp/luci-indexcache*
/etc/init.d/rpcd reload
```

Затем закройте вкладку LuCI и откройте её заново: LuCI кэширует дерево меню в
`sessionStorage` браузера, поэтому простая перезагрузка страницы может не
показать новый пункт. Вход/выход из LuCI также сбрасывает этот кэш.

### Зависимости и известные особенности OpenWrt 24.10

* Нужны `ucode-mod-fs`, `ucode-mod-uci`, `ucode-mod-digest`, `coreutils-timeout`, `curl`.
  Установщик доустанавливает недостающие пакеты через `opkg`.
* `/etc/config/routx` объявлен conffile: обновление пакета не стирает привязку.
  Установщик всё равно перезаписывает `server`/`bind_token` значениями из команды.
* `.ipk` для OpenWrt 24.10 собирается как gzip-tar (`debian-binary` + `control.tar.gz` +
  `data.tar.gz`), а не как `ar`-архив.
* `fs.popen()` в ucode принимает только строку, поэтому RoutX собирает argv в
  экранированную shell-команду.
* Ошибка `reload` вида `{"status":"existing", ...}` означает, что снимок уже существует;
  агент использует CLI `reload` первым, чтобы не конкурировать с init-скриптом.
