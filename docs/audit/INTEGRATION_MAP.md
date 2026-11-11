# RoutX — карта интеграции с Forkop и Prokop

Статус: **аудит завершён, реализация не начиналась**.
Дата аудита: 2026-10-27.
Входные данные: только исходный код двух репозиториев (read-only клоны в `audit/`), без запуска на оборудовании.

| Продукт | Репозиторий | Коммит | Дата коммита | Версия |
|---|---|---|---|---|
| Forkop | `https://github.com/ushan0v/forkop` | `dd483297be0ac4e52bb8f482e2640238b75af532` | 2026-07-18 | из Makefile/release-переменной |
| Prokop | `https://github.com/Asofwar/prokop` | `3d2119e013d9671796dafccb460a5acbafcfef7b` | 2026-10-20 | `2.32.0` (`RELEASE_VERSION`) |

Обозначения в документе:

* **Проверено** — подтверждено чтением кода (файл и функция указаны).
* **Проектное решение** — наш вывод/ограничение, не команда upstream.
* **GAP** — возможность отсутствует у продукта; эмулировать нельзя, только явно сообщать пользователю.

---

## 1. Главный вывод

Оба продукта — это **один и тот же код** (Prokop — переименованный форк Forkop), но ветки разошлись:

* Forkop: клиент **и** сервер (inbound-режим), нет снапшотов, нет каталога версий sing-box, нет агрегированного health, нет `check_environment`.
* Prokop: только клиент, зато есть нативные снапшоты с транзакционным restore, `get_health_status`, история, `check_environment`, `core_releases`, установка конкретной версии sing-box, killswitch, autotune, уведомления.

Поэтому интеграция обязана идти **через два независимых адаптера** с общим интерфейсом, а не через «общий CLI». Различия — не косметика: у Forkop нельзя честно показать версии sing-box для выбора, нельзя сделать нативный backup/restore, нельзя получить агрегированный health.

Обе программы:

* написаны на **ucode** (`PKGARCH:=all`, архитектурно-независимы);
* уже зависят от `curl`, `ucode`, `ucode-mod-fs`, `ucode-mod-uci`, `nftables`, `bind-dig`, `ip-full`, `ca-bundle`;
* имеют CLI `/usr/bin/forkop` и `/usr/bin/prokop` с фиксированным `command_spec`;
* читают UCI `/etc/config/forkop` и `/etc/config/prokop`;
* **не** предоставляют API для «выполнить произвольную команду» — это плюс для нашей модели безопасности.

---

## 2. Идентификация продукта и версии

| Что | Forkop | Prokop |
|---|---|---|
| Бинарник CLI | `/usr/bin/forkop` | `/usr/bin/prokop` |
| Библиотека | `/usr/lib/forkop` | `/usr/lib/prokop` |
| UCI | `/etc/config/forkop` | `/etc/config/prokop` |
| Каталог состояния | `/etc/forkop` | `/etc/prokop` |
| init | `/etc/init.d/forkop` | `/etc/init.d/prokop` |
| Версия | `show_version` | `show_version` → `2.32.0` |
| Read-only обёртка для LuCI | `/usr/libexec/forkop-ro` | `/usr/libexec/prokop-ro` |

Проверено: `prokop/files/usr/lib/core/constants.uc`, `prokop/files/usr/bin/prokop`, `prokop/files/usr/libexec/prokop-ro`, `forkop/files/usr/lib/core/constants.uc`.

Агент определяет продукт **локально** (наличие бинарника + успешный `show_version`), а не по версии прошивки:

1. нет ни одного → `product_missing`, изменения запрещены;
2. есть ровно один → `forkop` или `prokop`;
3. есть оба → `product_conflict`: **сообщить ошибку и ничего не менять** (требование ТЗ). Read-only диагностика разрешена, любые mutate-задания блокируются на сервере и в агенте.

Смена продукта на роутере (миграция Forkop → Prokop, которую умеет installer Prokop) обнаруживается при следующем poll: статус `product_changed`, applied-состояние шаблонов инвалидируется, требуется новый снапшот и подтверждение.

---

## 3. Санкционированные поверхности интеграции

Разрешено ровно три поверхности:

1. **CLI продукта** — фиксированные команды из `command_spec` (см. §4).
2. **UCI** — только `uci get/set/delete/commit` по белому списку опций (см. §5).
3. **Файлы состояния продукта** — только на чтение и только те, что перечислены в §4/§11 (версия sing-box, снапшоты).

Запрещено:

* редактировать `/etc/sing-box/config.json` напрямую (его генерирует продукт);
* вызывать внутренние `.uc`-модули продукта напрямую (кроме случаев, когда это и есть CLI);
* использовать `opkg/apk` для переустановки продукта;
* вызывать `uninstall`, `full_uninstall`, `package_prerm`, `package_postinst`, `luci_postinst`, `dnsmasq_restore`/`restore_dnsmasq`, `component_action prokop install`.

### 3.1. Санитизация окружения (обязательно)

Оба продукта читают переменные окружения (`PROKOP_*`, `FORKOP_*`, `UCI_*`, `SB_*`, `TMP_*`, `PATH`) и допускают их переопределение — это задокументировано в коде и в `prokop-ro`:

```sh
exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/prokop "$@"
```

**Проектное решение:** агент всегда запускает CLI продукта через `env -i` с фиксированным `PATH`, никогда не наследует окружение вызывающего. Это блокирует подмену `PROKOP_CONFIG`, `UCI_CONFIG_DIR`, `PATH` и т.п.

### 3.2. Запуск без shell

Все вызовы — argv-массивы, без `sh -c`, без интерполяции строк. Аргументы, приходящие с сервера, проходят грамматическую валидацию (`^[a-z0-9_]+$` для действий, теги версий `^v?[0-9][A-Za-z0-9._-]*$`, теги прокси — как opaque-строка с ограничением длины и запретом `\0`/переводов строк).

---

## 4. Матрица CLI

### 4.1. Общие команды (есть в обоих)

| Команда | Аргументы | Назначение |
|---|---|---|
| `start` / `stop` / `restart` / `enable` / `disable` | 0 | жизненный цикл |
| `reload` | `[reason]` | перегенерация и применение конфигурации |
| `show_version` | 0 | версия продукта |
| `show_sing_box_version` | 0 | версия sing-box |
| `get_status` | 0 | running/enabled/status/dns_configured |
| `get_sing_box_status` | 0 | статус sing-box |
| `get_system_info` | 0 | модель, версия OpenWrt, версии компонентов, подпись бинарника |
| `get_ui_state` | 0 | единый poll: сервис + capabilities + actions (+ `now` в Prokop) |
| `get_ui_capabilities` | 0 | флаги вариантов sing-box, наличие провайдеров |
| `check_proxy` | 0 | e2e-проверка через `sing-box tools fetch ifconfig.me`, exit 0/1 |
| `check_nft` | 0 | проверка nftables |
| `check_nft_rules` | 0 | проверка правил |
| `check_sing_box` | 0 | валидация конфигурации sing-box |
| `check_fakeip` | 0 | FakeIP |
| `check_logs` / `check_sing_box_logs` | 0 | логи (маскированные) |
| `check_dns_available` | 0 | доступность DNS |
| `global_check` | 2 | сводная проверка (текст, маскируется) |
| `show_config` | 1 (`masked`/`raw`) | UCI (masked — allowlist-маскирование) |
| `show_sing_box_config` | 1 | сгенерированный конфиг (masked/raw) |
| `clash_api` | 4 | прокси/соединения/задержки/переключение |
| `service_action_async` / `service_action_status` | 1 / 1 | асинхронный жизненный цикл |
| `latency_test_async` / `latency_test_status` | 4 / 1 | асинхронный замер задержек |
| `component_action_async` / `component_action_status` | 2 (Forkop) / 3 (Prokop) / 1 | асинхронные действия с компонентами |
| `subscription_update_async` / `subscription_update_status` | 2 / 1 | обновление подписки |
| `component_updates_if_due` / `component_update_check_cache` | 0 | проверка обновлений |
| `list_update` / `list_update_if_due` | 0 | обновление списков |

### 4.2. Только Prokop

| Команда | Аргументы | Назначение |
|---|---|---|
| `get_health_status` | 0 | `overall`, сервис, DNS, guard, recovery, last_reload |
| `get_history` / `history_clear` / `history_retention_set` | 0 / 0 / 2 | история событий и её retention |
| `check_environment` | 0 | JSON-строки `ok/warning/not_checked/unavailable` |
| `support_report` | 0 | **НЕмаскированный** отчёт — не использовать |
| `config_snapshot_create` | 1 | снапшот UCI-конфига |
| `config_snapshot_list` / `diff` / `restore` / `delete` / `clear` | 0/1/1/1/0 | управление снапшотами |
| `core_releases` | 0 | список стабильных релизов `shtorm-7/sing-box-extended` с SHA-256 |
| `prokop_releases` | 0 | релизы самого Prokop |
| `route_trace` | 4 | диагностика маршрута |
| `device_traffic` | 0 | трафик по устройствам |
| `connectivity_test` | 3 | проверка связности |
| `killswitch_status/sync/disable` | 0 | killswitch — **вне области v1** |
| `autotune_*` | — | **вне области v1** |
| `notify_*` | — | **вне области v1** |
| `profile_*`, `smart_detect_*` | — | experiments — **вне области v1** |
| `urltest_override_save/reset` | 7 / 2 | точечное переопределение urltest — **вне области v1** |
| `get_readonly_config_sections`, `get_dashboard_runtime_metadata` | 0 | метаданные для дашборда |

### 4.3. Только Forkop

| Команда | Аргументы | Назначение |
|---|---|---|
| `check_inbounds` / `check_inbounds_config` | 0 | проверка серверных inbound'ов |
| `get_server_capabilities` | 0 | возможности серверного режима |
| `generate_reality_keypair` / `get_tls_certificate_sha256` | 0 / 1 | серверный режим |
| `get_zapret_status`, `get_zapret2_status`, `get_byedpi_status` | 0 | статусы DPI-провайдеров (в Prokop тоже есть) |

**Вывод:** серверный режим (inbound, Reality-ключи, VLESS-сервер) есть только у Forkop. RoutX v1 управляет **клиентской** конфигурацией; серверные секции не читаются и не изменяются.

### 4.4. Жёсткий denylist (никогда не вызывать)

`uninstall`, `full_uninstall`, `package_prerm`, `package_postinst`, `luci_postinst`, `dnsmasq_restore`, `restore_dnsmasq`, `neutralize_zapret_defaults`, `component_action prokop *`, `killswitch_disable`, `autotune_apply*`, `autotune_rollback`, `profile_activate`, `config_snapshot_clear`, `history_clear`.

Причина: переустановка/сброс/замена продукта, изменение общесистемного DNS, отключение защиты или удаление истории запрещены ТЗ; часть из них необратима без вмешательства в роутер.

---

## 5. UCI-модель

Проверено: `prokop/files/etc/config/prokop`, `prokop/files/usr/lib/config/validator.uc`, `prokop/files/usr/lib/config/connections.uc`, `prokop/files/usr/lib/config/snapshots.uc`.

Типы секций: `settings`, `section`, `subscription_url`, `section_interface`, `urltest`, `priority_group`, `priority_level`, `server` (только Forkop, legacy в Prokop).

### 5.1. `settings` (singleton `settings`)

Ключевые опции (полный список — в `/etc/config/prokop`, 60+):

* DNS: `dns_type`, `dns_server` (list), `bootstrap_dns_server` (list), `dns_strategy`, `dns_check_interval`, `dns_failover_failure_threshold`, `dns_rewrite_ttl`, `dns_detour_enabled`, `dns_detour_section`;
* сеть: `source_network_interfaces` (list), `enable_output_network_interface`, `output_network_interface`, `enable_badwan_interface_monitoring`, `badwan_monitored_interfaces`, `badwan_reload_delay`, `dont_touch_dhcp`;
* sing-box: `config_path`, `cache_path`, `log_level`, `exclude_ntp`, `intercept_client_dns`, `tproxy_low_memory`, `nfqws_first_packets`;
* обновления: `list_update_enabled`, `update_interval`, `component_update_check_enabled`, `component_update_check_interval`;
* прочее: `enable_yacd`, `disable_quic`, `latency_test_url`, `download_lists_via_proxy`, `mirror_base_url`, `device_traffic`, `exclude_bittorrent`.

**Не управляются шаблонами (hard exclude):** `config_version`, `applied_migrations`, `mirror_base_url`, `sing_box_pinned_version`, `direct_proxy_*`, `torrserver_*`, `enable_yacd`, `config_path`, `cache_path`.

### 5.2. `section` (правило/подключение)

```uci
config section 'main'
    option label 'Main'
    option enabled '1'
    option action 'connection'          # connection|proxy|outbound|vpn|bypass|block|dns|zapret|zapret2|byedpi|singbox_dpi
    list selector_proxy_links 'vless://…'   # СЕКРЕТ
    list outbound_jsons '{…}'               # СЕКРЕТ (может содержать пароли)
    list community_lists 'russia_inside'
    list rule_set 'https://…/rules.srs'
    list rule_set_with_subnets 'https://…'
    list fully_routed_ips '192.168.1.2'
    list excluded_source_ip_cidr '192.168.1.3'
    option outbound_detour_enabled '0'
    option outbound_detour_section 'main'
    option sort_by_latency '0'
```

**Hard exclude:** `selector_proxy_links`, `outbound_jsons` — это ровно те «индивидуальные VLESS/Sub-подключения», которые ТЗ запрещает перезаписывать.

### 5.3. `subscription_url`

```uci
config subscription_url
    option section 'main'
    option url 'https://…'          # СЕКРЕТ (токен подписки)
    option user_agent '…'
    option subscription_update_enabled '1'
    option subscription_update_interval '1h'
    option download_via_proxy_enabled '0'
    option show_dashboard_metadata '1'
    option prefix_nodes '0'
    option node_prefix 'Provider'
    option include_urltest_groups '1'
```

**Hard exclude:** `url`. Остальные опции — управляемые.

### 5.4. `urltest`

`section`, `name`, `check_interval`, `tolerance`, `testing_url`, `idle_timeout`, `interrupt_exist_connections`, `pin_dashboard`, `filter_mode`, `detect_server_country`, `exclude_countries`, `exclude_outbounds`, `exclude_regex`, `include_countries`, `include_outbounds`, `include_regex`.

Управляемо; создание/удаление `urltest`-секций разрешено только явной декларацией в шаблоне.

### 5.5. `section_interface`

`section`, `name`, `domain_resolver_enabled`, `domain_resolver_dns_type`, `domain_resolver_dns_server`.

Управляемо, но создание секций — только явное.

### 5.6. Что шаблон **не** может

* создавать/удалять `section`, `subscription_url`, `section_interface`, `server`;
* менять `selector_proxy_links`, `outbound_jsons`, `subscription_url.url`;
* трогать `server`-секции (inbound-секреты);
* задавать опции, которых нет в манифесте агента;
* использовать wildcard-селекторы секций (`section[*]`, regex по именам).

Итог: шаблон — это **полный набор управляемых параметров** (desired state) для уже существующих сущностей + явно разрешённые `urltest`-секции. Всё остальное — «не наше», diff покажет только управляемую часть.

---

## 6. Секреты и маскирование

| Механизм | Поведение | Источник |
|---|---|---|
| `show_config masked` | allowlist-маскирование UCI: всё, что не в списке безопасных опций, → `MASKED` (fail closed) | `diagnostics/status.uc` |
| `show_sing_box_config masked` | маскирование сгенерированного JSON | `diagnostics/status.uc` |
| `global_check masked` | маскированный текстовый отчёт | `diagnostics/runtime.uc` |
| `get_health_status` | не содержит секретов (флаги/статусы/события) | `diagnostics/health.uc` |
| `config_snapshot_diff` | маскированный diff | `config/snapshots.uc` |
| `support_report` | **НЕ маскируется** | `diagnostics/runtime.uc` |

**Проектные правила:**

1. Агент по умолчанию отправляет только masked-вывод.
2. `support_report` не собирается и не хранится. Если суперадмин явно запросит — задание помечается `sensitive`, результат не сохраняется на диск, а показывается один раз с предупреждением. (Рекомендация: не реализовывать в v1 вовсе.)
3. `show_config raw` / `show_sing_box_config raw` — запрещены на уровне агента.
4. `read_state` (наш op) читает только опции из манифеста, секретные — никогда, даже если сервер попросит.
5. В аудит-лог никогда не попадают значения секретных опций, токены, URL подписок, ключи.

---

## 7. Применение конфигурации

### 7.1. Prokop

`reload [reason]` → init.d `reload_service` → `initd_ucode reload-service <reason> $$`.

Возможные ответы (stdout, exit 0):

* (пусто) — применено;
* `queued` — принято, но не применено (занят lock / отложено);
* `stopped` — runtime остановлен пользователем, reload пропущен.

Причины, для которых reload заведомо может вернуть `queued`: `list-content`, `config-restore`, `autotune`, `direct-proxy`.
Проверено: `prokop/files/etc/init.d/prokop`, `prokop/files/usr/lib/service/initd.uc`, `prokop/files/usr/lib/service/lifecycle.uc`.

Внутренний rollback при неудачном reload восстанавливает **runtime** (sing-box config + nft), но **не** откатывает `/etc/config/prokop`. Поэтому наш пайплайн обязан иметь собственный снапшот.

### 7.2. Forkop

`reload [reason]` возвращает код, применяет изменения, при неудаче откатывает runtime из собственного backup (`abort_reload`). Токенов `queued`/`stopped` нет. UI-трекинг задания — через `service_action_async reload` + `service_action_status`.

### 7.3. Пайплайн применения (одинаковый для обоих)

1. `snapshot_create` (Prokop: `config_snapshot_create before-apply`; Forkop: наш snapshot-модуль).
2. `read_state` — только управляемые опции.
3. Diff: `add` / `change` / `delete` (три состояния: current, desired, last_applied).
4. Пользователь подтверждает **точный** список изменений.
5. `apply_uci` — валидация каждой операции по манифесту, `uci set/delete`, `uci commit <product>`.
6. `reload` + ожидание завершения.
7. Верификация: `get_status` (running), `get_ui_state`, `check_proxy` (exit 0), для Prokop ещё `get_health_status.overall ∈ {ok, recovered}`.
8. Успех → `applied_state` сохраняется. Неудача → `snapshot_restore` (Prokop) или восстановление файла + reload (Forkop), повторная верификация, отчёт `rolled_back` / `rollback_failed`.

**Не «безопасно» откатывать**, если: с момента снапшота конфиг менялся извне (Prokop сам это ловит: `concurrent_change`), идёт другое действие, сервис остановлен пользователем. В этих случаях — `needs_attention` и ручное решение, без слепого restore.

---

## 8. Асинхронные задания upstream

### 8.1. Идентификаторы и хранение

* `job_id` = `"<epoch>-<usec>"` (не UUID), валидируется `valid_job_id`.
* Состояние — JSON-файл в каталоге задания: `/var/run/prokop/...` (tmpfs) с fallback `/tmp/run/prokop/...`.
* Живость воркера: `pid` + `pid_ticks` (start ticks из `/proc`), чтобы переиспользованный PID не считался живым.
* Мёртвый воркер без результата → `running:false, reason:"stale"`.

### 8.2. Схемы

`service_action_status` / `latency_test_status`:

```json
{
  "success": true, "running": true,
  "kind": "service|latency", "action": "reload|start|stop|restart",
  "latency_type": "proxy|group|proxy_list", "section": "main", "tag": "…",
  "message": "…", "pid": "1234", "pid_ticks": "…",
  "started_at": 1760000000, "updated_at": 1760000005,
  "exit_code": null, "reason": "failure|timeout|busy|queued|stale|<clash_error>",
  "progress": { "completed": 3, "total": 10, "failed": 1 }
}
```

`component_action_status`:

```json
{
  "success": true, "running": false, "kind": "component",
  "component": "sing_box", "action": "install_version",
  "message": "…", "pid": null,
  "started_at": 0, "updated_at": 0,
  "current_version": "1.12.x", "latest_version": "1.13.x",
  "changed": true, "status": "latest|updated|…", "exit_code": 0,
  "progress": {…}, "now": 1760000000
}
```

`action_start_response` при отказе:

```json
{ "success": false, "job_id": "", "message": "…", "reason": "busy|startup_in_progress|invalid_input|not_found|failure" }
```

**Проектное решение:** сервер никогда не парсит человекочитаемый `message` для логики — только `success`, `running`, `reason`, `exit_code`, `changed`, `status`.

### 8.3. Ограничения upstream, которые нужно уважать

* Одновременно может идти только одно действие каждого вида (component/service/latency) — блокировки на роутере.
* `latency_test_async` берёт глобальный lock: два замера параллельно невозможны.
* `component_action_async` возвращает `busy`, если уже идёт другое действие компонента.
* Job-файлы в tmpfs → после перезагрузки роутера история заданий теряется. Наш сервер обязан хранить своё состояние и уметь продолжать/помечать `lost`.

---

## 9. Мониторинг и health-семантика

### 9.1. Дешёвый poll (рекомендуется как база)

`get_ui_state` — один процесс, отдаёт:

* `service.<product>.running/enabled/status/dns_configured` (+ у Prokop `stopped_by_user`, `not_started`, `restart_blocked`, `stop_available`, `dns_complete`, `dhcp_user_managed`);
* `capabilities` (вариант sing-box, DPI-провайдеры);
* `actions` (что сейчас выполняется);
* `now` (часы роутера).

Это одновременно проверка доступности роутера и состояния сервиса. Стоимость — один вызов ucode, без сети.

### 9.2. Health (только Prokop)

`get_health_status` → `overall: ok|recovered|transitioning|stopped|not_started|error`, `guard`, `recovery`, `last_reload`, `reload.busy`, `bridge_netfilter`, `recent_activity`.
`overall` учитывает: DPI-guard, незавершённое обновление пакета, последний неудачный reload/restore.

Для Forkop эквивалента нет → `health: unavailable` + derived-статус из `get_status` + `check_proxy`.

### 9.3. Задержки и здоровье прокси

* `clash_api get_proxies` → теги, типы, `now` у селекторов.
* `clash_api get_proxy_latency <tag> [timeout_ms] [url]` → `{delay: ms}` или ошибка.
* `clash_api get_group_latency <group> [timeout_ms]` → карта `tag→delay` (для `urltest` — через group delay).
* `clash_api get_proxy_latencies '<json-array>' [timeout_ms] [progress_path]` → `{success,count,failed,failed_count}`; по одному тегу за раз, `urltest` — в конце.
* `latency_test_async proxy|group|proxy_list <section> <tag> [timeout]` → job.
* Ошибки: `latency_failed` (замер не дал числа), `clash_api_timeout`, `clash_api_unreachable`, `clash_api_unavailable`, `clash_api_invalid_response`, `clash_api_error`, `clash_api_auth_unavailable`.

Тестовый URL: `settings.latency_test_url`, по умолчанию `https://www.gstatic.com/generate_204`.

**Ключевое различие (требование ТЗ):**

| Понятие | Как измеряем | Что означает |
|---|---|---|
| Роутер доступен | успешный poll/`get_ui_state` | агент жив, сеть до сервера есть |
| Сервис работает | `get_status.running=1` + `get_ui_state.service.*` | процесс/правила подняты |
| Прокси здоров | `check_proxy` exit 0 **и** `clash_api` delay > 0 | трафик реально проходит через туннель |
| Прокси деградировал | delay > порога или часть тегов без delay | часть узлов мертва, но сервис жив |

Нельзя выводить «прокси здоров» из «роутер доступен». И наоборот.

### 9.4. `check_proxy` — детали

Валидирует конфиг sing-box, затем запускает `sing-box tools fetch ifconfig.me` на временном конфиге, до 5 попыток, возвращает exit 0/1 и маскированный текст. **Задержку не измеряет.** Для latency — только Clash API.

---

## 10. Диагностика: quick / full

### 10.1. Quick (оба продукта)

| Проверка | Forkop | Prokop |
|---|---|---|
| `get_status` | ✅ | ✅ |
| `get_ui_state` | ✅ | ✅ |
| `check_proxy` | ✅ | ✅ |
| `check_nft_rules` | ✅ | ✅ |
| `check_sing_box` | ✅ | ✅ |
| `check_fakeip` | ✅ | ✅ |
| `check_dns_available` | ✅ | ✅ |
| `get_system_info` | ✅ | ✅ |

### 10.2. Full (дополнительно)

| Проверка | Forkop | Prokop |
|---|---|---|
| `check_logs` | ✅ | ✅ |
| `check_sing_box_logs` | ✅ | ✅ |
| `global_check masked` | ✅ (текст) | ✅ (текст) |
| `get_health_status` | ❌ | ✅ |
| `get_history` | ❌ | ✅ |
| `check_environment` | ❌ | ✅ |
| `check_inbounds`, `check_inbounds_config` | ✅ | ❌ |
| `support_report` | ❌ | ✅, но **не используем** (unmasked) |

**Проектное решение:** каждая проверка в отчёте имеет `state`:

* `ok` / `warning` / `error` — результат;
* `not_available` — команды нет у продукта (с причиной `product_capability`);
* `not_checked` — команда есть, но не запускалась (таймаут, отмена, лимит).

UI обязан показывать «проверка недоступна для Forkop», а не пустой/зелёный результат.

Отчёты хранятся только masked, с `sha256`, `size`, `product`, `agent_version`, `created_at`, TTL.

---

## 11. sing-box

### 11.1. Варианты и состояние

| Что | Forkop | Prokop |
|---|---|---|
| state-файлы | `/etc/forkop/sing-box-version`, `/etc/forkop/sing-box-variant` | `/etc/prokop/sing-box-version`, `/etc/prokop/sing-box-variant` |
| варианты | stable, tiny, extended, extended-compressed | те же |
| каталог действий | `check_update`, `install`, `install_extended`, `install_extended_compressed`, `install_tiny`, `install_stable` | + `install_version` |
| список версий | ❌ | `core_releases` |

`core_releases` возвращает `[{tag,url,published_at}]` только для не-draft/не-prerelease релизов `shtorm-7/sing-box-extended`, у которых есть SHA-256 ассета. `tag` валидируется как `^v?[0-9][A-Za-z0-9._-]*$`.

### 11.2. Что делает установка (upstream)

1. Проверка свободного места (`df -k`) и памяти (`MemAvailable`) перед скачиванием в `/tmp`.
2. Выбор архива по архитектуре (`opkg print-architecture` / `apk --print-arch` / `/etc/apk/arch` / `DISTRIB_ARCH` / `uname -m`).
3. Скачивание, проверка SHA-256 (для pinned-версии — обязательна).
4. Бэкап текущего бинарника, удаление конфликтующего варианта, установка пакета.
5. Валидация бинарника, перезапуск сервиса, проверка.
6. При неудаче — откат бинарника.

Проверено: `prokop/files/usr/lib/components/action.uc`.

### 11.3. Ограничения для RoutX

* **Forkop:** нет списка версий и установки конкретной версии. Максимум — `check_update` + `install_stable|tiny|extended|extended_compressed`. Staged rollout по тегам невозможен → UI должен честно писать «управление версиями недоступно для Forkop».
* **Prokop:** `install_version` работает **только для extended-варианта**; при pin на не-extended upstream отказывает. `install` без тега ставит тот же вариант, что установлен.
* `core_releases` не отдаёт размер/чек-сумму в списке → предварительная проверка размера на сервере невозможна; проверки выполняет upstream, мы отображаем результат.
* Обновление может остановить и не запустить сервис (`restarted=false`, `reason`) — обязательна пост-проверка `get_status` + `check_proxy`, иначе `needs_attention`.

---

## 12. Бэкапы и снапшоты

### 12.1. Prokop (нативно)

* `config_snapshot_create manual|automatic|before-apply` → `{status:"created"|"existing"|"failed", snapshot, reason?}`.
* Дедупликация по хэшу конфига; лимит manual-снапшотов (retention 6–50, default ~20, резерв 2).
* `config_snapshot_diff <id>` → маскированные изменения.
* `config_snapshot_restore <id>` → `success` | `recovered` | `restored_not_started` | `needs_attention` | `failed` | `busy`, с `changes`, `notices`, `guard`.
* Транзакционный restore: guard, валидация, reload, LKG, откат при неудаче.
* `status:"failed", reason:"uncommitted_uci_changes"` — если в UCI есть незакоммиченные правки.

### 12.2. Forkop (GAP)

Нативных снапшотов нет. Наш snapshot-модуль:

1. `uci export forkop` → файл (с секретами!) в `/etc/router-control/snapshots/<ts>/config.uci` с правами `0600`;
2. `sha256sum` + размер + счётчик секций;
3. метаданные (`created_at`, `reason`, `product_version`, `sing_box_version`);
4. retention (по умолчанию 10 на роутер);
5. restore: проверка хэша → замена `/etc/config/forkop` → `uci commit` не нужен (файл уже записан) → `reload` → верификация.

Секреты в снапшоте — необходимое зло (иначе restore неполный). Поэтому: файл только `0600`, каталог `0700`, на сервер **не отправляется**, в UI — только метаданные и маскированный diff (агент маскирует при генерации diff).

---

## 13. Совместимость платформ

| Параметр | Forkop | Prokop |
|---|---|---|
| OpenWrt | ≥ 24.10, 15 МБ свободно | ровно 24.10.* (opkg), 25.12+ (apk) |
| Пакетный менеджер | opkg/IPK, apk для новых | opkg/IPK, apk |
| Архитектура приложения | `all` (ucode) | `all` (ucode) |
| Зависимости | `ca-bundle kmod-inet-diag kmod-netlink-diag kmod-tun curl ucode ucode-mod-fs ucode-mod-uci kmod-nft-tproxy coreutils-base64 bind-dig nftables kmod-nft-nat ip-full` | `ca-bundle kmod-inet-diag kmod-tun curl ucode ucode-mod-fs ucode-mod-uci conntrack kmod-nft-tproxy bind-dig nftables-json kmod-nft-nat ip-full` |
| Конфликты | `https-dns-proxy nextdns luci-app-passwall luci-app-passwall2` | те же |
| RAM | не заявлено в коде installer'а | README: 256 МБ |
| Зеркало | опционально | опционально, только Filogic/Rockchip |

**Проектное решение:** агент при регистрации выполняет `precheck` (локально, фиксированный код):

* `DISTRIB_ID`/`DISTRIB_RELEASE`, `DISTRIB_ARCH`, модель;
* `df -k /overlay` (или `/`), `MemAvailable`;
* наличие `ucode`, `curl`, `uci`, `sing-box`;
* версия продукта, вариант sing-box;
* наличие второго продукта → `product_conflict`.

Несовпадение с поддерживаемым диапазоном → `unsupported_platform`, кнопки изменений блокируются, диагностика доступна.

---

## 14. Трассировка требований → механизм

| Требование ТЗ | Механизм (проверено) |
|---|---|
| Один управляемый продукт на роутер | installer'ы взаимоисключающие; агент проверяет оба бинарника |
| Работа поверх уже запущенного Forkop/Prokop | только CLI + UCI, без установки/переустановки |
| Только исходящий TLS | long-poll агента; входящих портов нет |
| Асинхронные задания, состояние переживает рестарт | своя очередь в PostgreSQL + upstream job'ы |
| Роли superadmin/user | RBAC + фильтрация по owner_id |
| Инвайты, 5-мин токены, хэш, атомарное погашение | `invites` + `binding_tokens` c `UPDATE … WHERE used_at IS NULL` |
| Шаблоны = полный набор + исключения | whitelist опций + hard-exclude список |
| Не перезаписывать VLESS/Sub | `selector_proxy_links`, `outbound_jsons`, `subscription_url.url` исключены |
| Diff add/change/delete + подтверждение | трёхсторонний diff, обязательный confirm |
| Бэкап перед apply, rollback | Prokop native snapshot; Forkop свой snapshot |
| Мониторинг 60 с, stagger, без наложений | планировщик + per-router lease + upstream lock |
| Proxy health ≠ reachability | `check_proxy` + Clash delay |
| Native quick/full диагностика | списки команд §10 |
| «Проверка недоступна» | `state=not_available` |
| Версии sing-box из официальных источников | `core_releases` (Prokop) / `check_update` (Forkop) |
| Arch/space/checksum | upstream-проверки в `components/action.uc` |
| Staged rollout | своя модель стадий + health-gate |
| Аудит без секретов | allowlist-поля, никогда значения секретов |
| Изоляция пользователей | opaque ID + owner-фильтр |
| Нет произвольного shell | allowlist операций агента, argv, `env -i` |

---

## 15. Риски и открытые технические вопросы

1. **Forkop не даёт версий sing-box** — «управление версиями» для него невозможно без доработки upstream. Принять как GAP.
2. **Forkop не даёт снапшотов** — свой snapshot хранит секреты; нужна политика хранения и удаления.
3. **`support_report` не маскируется** — не собирать.
4. **Env-переопределения** (`PROKOP_CONFIG`, `FORKOP_CONFIG`, `UCI_CONFIG_DIR`) — обязателен `env -i`.
5. **Reload-токены только у Prokop** — для Forkop нельзя отличить «применено» от «принято»; нужна пост-верификация, а не код возврата.
6. **Job-файлы в tmpfs** — upstream-история теряется при перезагрузке; сервер должен уметь `reconcile` после offline.
7. **`check_proxy` медленный** (до 5 попыток) — нельзя гонять каждые 60 с на всех роутерах; в мониторинге использовать Clash delay, `check_proxy` — при диагностике и после apply.
8. **Clash API слушает на локальном адресе** — доступ только через CLI на роутере, извне не проксируем.
9. **Версии ucode/OpenWrt** — манифест агента должен быть версионирован; неизвестная опция → отказ, а не «попробуем».
10. **`get_ui_state` различается** (`service.prokop` vs `service.forkop`, разные capabilities) — нормализация в адаптере, не в общем коде.

---

## Приложение A. Карта CLI → модуль (для реализации адаптеров)

Forkop (`forkop/files/usr/bin/forkop`, `command_spec`):

| Команда | Модуль | Argv-режим |
|---|---|---|
| `service_action_async` | `service/ui.uc` | `service-action-async` |
| `service_action_status` | `service/ui.uc` | `service-action-status` |
| `latency_test_async` | `service/ui.uc` | `latency-test-async` |
| `latency_test_status` | `service/ui.uc` | `latency-test-status` |
| `clash_api` | `diagnostics/runtime.uc` | `clash-api` |
| `component_action_async` | `components/updates.uc` | `component-action-async` |
| `component_action_status` | `components/updates.uc` | `component-action-status` |
| `global_check` | `diagnostics/runtime.uc` | `global-check` |

Prokop (`prokop/files/usr/bin/prokop`, `command_spec`): те же плюс `get_health_status` → `diagnostics/health.uc get`, `config_snapshot_*` → `config/snapshots.uc`, `core_releases` → `components/action.uc core-releases`, `install_version` через 3-й аргумент `component_action_async`.

## Приложение B. Каталог компонентных действий Prokop

`components/catalog.uc`:

```text
prokop:            check_update, install
sing_box:          check_update, install, install_extended,
                   install_extended_compressed, install_tiny,
                   install_stable, install_version
zapret/zapret2:    check_update, install, remove
byedpi:            check_update, install, remove
zapret_manager:    install, remove
packet_steering:   enable, restore
direct_proxy:      enable, disable
torrserver:        check_update, install, remove, start, apply_settings
torrserver_direct: enable, disable
```

RoutX v1 использует только `sing_box: check_update | install | install_extended | install_tiny | install_stable | install_version` (и то `install_version` — только Prokop). Остальное — вне области.
