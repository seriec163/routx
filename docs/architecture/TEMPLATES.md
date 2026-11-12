# RoutX — шаблоны, diff, применение, откат

> **Новая модель (2026):** шаблон больше не привязан к имени секции. На
> странице роутера он применяется к выбранному правилу как пресет действия,
> ресурсов и настроек. Актуальное описание — `docs/runbooks/rules-and-templates.md`.
> Ниже сохранено описание старого формата и общей механики diff/apply.

Ключевой модуль: именно здесь требования ТЗ наиболее жёсткие.

---

## 1. Что такое шаблон

Шаблон = **полный желаемый набор управляемых параметров** + **явный список исключений**.

```json
{
  "schema_version": 1,
  "product_scope": ["forkop", "prokop"],
  "managed": {
    "settings:settings.log_level": "warn",
    "settings:settings.dns_strategy": "prefer_ipv4",
    "settings:settings.dns_server": ["77.88.8.8"],
    "settings:settings.source_network_interfaces": ["br-lan"],
    "section:main.sort_by_latency": "1",
    "section:main.community_lists": ["russia_inside"],
    "urltest:Fastest.tolerance": "50",
    "urltest:Fastest.check_interval": "3m"
  },
  "excluded": {
    "settings:settings.enable_yacd": "локальная политика роутера",
    "section:main.rule_set": "управляется подпиской"
  },
  "create_urltest": ["Fastest"],
  "remove_urltest": []
}
```

### 1.1. Правило полноты

* Есть **универсум** — все управляемые (не секретные, не идентификационные) опции для данного продукта и манифеста агента, для сущностей в области действия шаблона.
* `managed ∪ excluded` обязан покрывать универсум **без пересечений**.
* Опция, которой нет ни там, ни там → шаблон не сохраняется (`validation_failed`), UI показывает список пропусков.
* `excluded` — не «забыли», а осознанное решение; причина (`reason`) обязательна для UI.

Следствия:

* diff всегда полный и детерминированный: не бывает «непонятно, почему эта опция не изменилась»;
* добавление новой опции в манифест агента делает старые шаблоны неполными → они помечаются `incomplete` и требуют обновления (явное, видимое событие, а не тихое игнорирование);
* шаблон не может «случайно» управлять секретом — секреты вообще вне универсума.

### 1.2. Семантика значений

* Скаляр (`option`) — authoritative, полная замена.
* Список (`list`) — **полная замена**, не merge. Порядок значим (UCI list).
* `null` — «вернуть к умолчанию upstream» (удалить опцию). Это операция `delete` в diff.
* Отсутствие пути в `managed` при наличии в `excluded` — не трогаем.

### 1.3. Область действия (scope)

Шаблон применяется к роутеру, поэтому универсум зависит от существующих сущностей:

| Тип | Можно ли создавать | Можно ли удалять |
|---|---|---|
| `settings` | нет (singleton) | нет |
| `section` | **нет** | **нет** |
| `subscription_url` | **нет** | **нет** |
| `section_interface` | нет | нет |
| `urltest` | да, только из `create_urltest` | да, только из `remove_urltest`, с предупреждением |
| `server` (Forkop) | нет | нет |

Если шаблон объявляет `section:foo`, а на роутере секции `foo` нет → `diff` возвращает `blocked` с `reason=missing_entity` и списком. Автосоздание подключений запрещено: это ровно тот случай, когда можно потерять VLESS/Sub. Исключение — явная декларация `create_sections`: секция создаётся пустой, а подключения в неё добавляются только через отдельную вкладку «Подключения» (секреты не входят в шаблон).

### 1.4. Галочки и пользовательские списки

UI редактора шаблона работает не с сырым JSON, а с каталогом ресурсов Prokop/Forkop:

* `community_lists` — 27 предустановленных списков (`youtube`, `telegram`, `meta`, …),
  каталог совпадает с `prokop/files/usr/lib/singbox/rulesets.uc`;
* `rule_set` / `rule_set_with_subnets` — URL или локальный путь `.srs`/`.json`;
* `remote_domain_lists` / `remote_subnet_lists` — URL `.lst` для импорта доменов/подсетей;
* ручные домены и IP/CIDR — `manual_entries.<section>`; сервер превращает их в локальный
  `.lst` с хэшем содержимого в имени и добавляет путь в `domain_ip_lists`.
  Обычный домен = домен и поддомены; поддерживаются `full:`, `keyword:`, `regex:`;
  строки `//…` и `#…` считаются комментариями.

Дополнения конкретного роутера хранятся в `routers.list_extras` и подмешиваются к payload
при diff/apply. Шаблон остаётся базой, но итоговый diff всегда показывает и дополнения.

Секция, объявленная в `create_sections`, создаётся агентом, если её нет. Для неё обязателен
`action`; для `connection`/`proxy`/`outbound`/`vpn` на роутере уже должно быть подключение.

Удаление стало безопасным: `settings.*` удаляется только при явном `null` в payload, а
скалярные опции секции (`action`, `label`, `enabled`, `sort_by_latency`, `outbound_detour_*`)
не удаляются из-за отсутствия в шаблоне. Списки (`community_lists`, `rule_set`, …) по-прежнему
заменяются целиком.

---

## 2. Пути (path grammar)

```text
<type>:<section>.<option>

type   := settings | section | subscription_url | section_interface | urltest
section:= [A-Za-z0-9_-]{1,64}          (имя UCI-секции, не тип)
option := [a-z0-9_]{1,64}
```

Примеры: `settings:settings.log_level`, `section:main.sort_by_latency`, `urltest:Fastest.tolerance`.

Запрещено:

* wildcard/regex/индексы (`section:*`, `urltest:[0-9]+`);
* анонимные секции (`@section[0]`) — только стабильные имена;
* вложенные/вычисляемые пути;
* любые пути вне манифеста агента.

Валидация пути выполняется трижды: в UI, в домене сервера (по сохранённому манифесту) и в агенте (по локальному манифесту). Расхождение версий → `capability_missing`, а не «попробуем».

---

## 3. Жёсткие исключения (нельзя включить в шаблон никогда)

Из аудита (`INTEGRATION_MAP.md` §5–6):

```text
section:*.selector_proxy_links        # VLESS/URI-подключения
section:*.outbound_jsons              # JSON-подключения (пароли)
subscription_url:*.url                # токен подписки
settings:settings.config_version
settings:settings.applied_migrations
settings:settings.mirror_base_url
settings:settings.sing_box_pinned_version
settings:settings.direct_proxy_*
settings:settings.torrserver_*
settings:settings.config_path
settings:settings.cache_path
settings:settings.enable_yacd
server:*                              # inbound-секреты Forkop
```

Дополнительно агент маскирует/отказывает по regex имени опции:

```text
(password|passwd|secret|token|uuid|private_key|public_key|auth|credential|api_key)
```

Это fail-closed: новая секретная опция в upstream автоматически не попадёт в шаблон.

---

## 4. Трёхсторонний diff

Три источника:

| Источник | Что это |
|---|---|
| `current` | `read_state` с роутера (allowlist), на момент diff |
| `desired` | `managed` шаблона |
| `last_applied` | `template_assignments.applied_hash` + снимок значений на момент последнего успешного apply |

Правила:

```text
для каждого пути из universum:
  c = current[path] (или ABSENT)
  d = desired[path] (или ABSENT, если excluded)
  if d == ABSENT: continue                       # excluded, не трогаем
  if d == null:
      if c != ABSENT: op = delete
  else:
      if c == ABSENT: op = add
      elif c != d:    op = change
      else:           op = none
```

`last_applied` используется для **drift**:

```text
drift = (current != last_applied) на путях, которые мы управляем
```

Если drift есть, но `desired == current` — это внешнее изменение «в нашу сторону», не конфликт.
Если drift есть и `desired != current` — при apply будет перезапись внешнего изменения: UI обязан показать «изменено вне RoutX» с временем и (если есть) инициатором из аудита.

### 4.1. Формат diff

```json
{
  "diff_hash": "sha256:…",
  "state_hash": "sha256:…",
  "items": [
    { "op": "change", "path": "settings:settings.log_level",
      "before": "info", "after": "warn", "external": false },
    { "op": "add", "path": "urltest:Fastest.tolerance",
      "before": null, "after": "50", "external": false },
    { "op": "delete", "path": "section:main.sort_by_latency",
      "before": "1", "after": null, "external": true,
      "external_changed_at": "2026-10-26T18:02:11Z" }
  ],
  "warnings": [
    { "code": "external_change", "path": "section:main.sort_by_latency" },
    { "code": "urltest_remove_referenced", "name": "Backup" }
  ],
  "blocked": []
}
```

`diff_hash` = SHA-256 от канонического JSON (`items` без `external*`, отсортированные по `path`). Он фиксирует подтверждение.

### 4.2. Блокировки diff

`blocked` (применение невозможно) возникает, если:

* `product_conflict` или `product_changed`;
* `unsupported_platform`;
* нет обязательной сущности (`missing_entity`);
* шаблон неполный/несовместим с манифестом (`incomplete`, `incompatible`);
* путь не в манифесте (`capability_missing`);
* значение не проходит валидацию upstream-типа (interval, enum, IP, URL).

`blocked` не мешает показать diff — он мешает подтвердить.

---

## 5. Подтверждение

Требования:

* diff показывается **до** применения, сгруппированный: `add` / `change` / `delete`;
* `delete` — отдельная секция с отдельным чекбоксом «я понимаю, что опции будут удалены»;
* для каждого `change` — `before → after`;
* для `external` — пометка «изменено вне RoutX»;
* для массового применения — diff по каждому роутеру, подтверждение общее, но с обязательным просмотром списка заблокированных;
* подтверждение фиксирует `diff_hash` и `confirmed_by`; изменение состояния между diff и apply → `409 stale_diff`, нужен новый diff.

Ограничения:

* пустой diff → apply не создаётся (`no_changes`);
* `delete`-операций больше 20 % от общего числа → дополнительное предупреждение (защита от «шаблон сломался»).

---

## 6. Пайплайн применения

```text
apply(router, diff_hash):
  1. перепроверить: router online, product ok, нет активных mutate
  2. snapshot_create(reason=before-apply)  ── обязательно
     ├─ Prokop: config_snapshot_create before-apply
     └─ Forkop: локальный снапшот /etc/config/forkop (0600, sha256)
     если снапшот не создан → failed(snapshot_failed), изменений нет
  3. read_state заново → пересчитать diff
     если diff_hash != подтверждённый → stale_diff, стоп
  4. apply_uci(ops)  (агент)
     ├─ валидация каждой операции по манифесту
     ├─ uci set/delete
     ├─ uci commit <product>
     └─ при ошибке на любом шаге → откат файла из снапшота
  5. reload(reason=routx)
     ├─ Prokop: дождаться service_action_status; учесть queued/stopped
     └─ Forkop: дождаться job; код возврата + verify
  6. verify:
     ├─ get_status.running = 1
     ├─ get_ui_state: сервис не в transition
     ├─ check_sing_box = 0
     ├─ check_proxy = 0
     └─ Prokop: get_health_status.overall ∈ {ok, recovered}
  7. success → applied_hash, applied_at, drift=in_sync
     failure → rollback:
        ├─ snapshot_restore (Prokop) / restore+reload (Forkop)
        ├─ reload
        ├─ verify
        ├─ ok → rolled_back
        └─ нет → rollback_failed → needs_attention (никаких автоповторов)
```

### 6.1. Когда откат **не** выполняется автоматически

| Условие | Почему | Что вместо |
|---|---|---|
| Конфиг менялся извне после снапшота | можно потерять чужие изменения | `needs_attention`, показать diff |
| Пользователь остановил сервис (`stopped_by_user=1`) | reload бессмыслен, restore не поднимет | `needs_attention` |
| Идёт другое действие (component/service/latency) | upstream lock, риск гонки | ждать/`job_busy` |
| Снапшот не читается/не найден | нечем откатывать | `rollback_failed` |
| Продукт сменился | снапшот от другого продукта | `product_changed` |
| `restore` вернул `needs_attention` | upstream сам просит человека | пробросить статус как есть |

### 6.2. Что считается успехом

Все пункты `verify` одновременно. «Reload вернул 0» — **не** успех, особенно у Prokop с `queued`.

---

## 7. Drift и периодическая сверка

* После каждого `monitor` (или раз в N циклов) сервер сравнивает `current` с `applied_state`.
* `drift=drift` → бейдж в UI, письмо/уведомление (если включено), но **никакого автоприменения**.
* Суперадмин может включить «auto-reconcile» для конкретного шаблона: тогда создаётся обычный `apply` с подтверждением (или без — отдельная настройка), но всё равно со снапшотом.
* При `product_changed` drift сбрасывается в `unknown` и требуется новый baseline.

---

## 8. Несколько шаблонов на роутер

* Разрешено, если пути не пересекаются (проверка при назначении).
* Пересечение → `409 template_overlap` со списком путей.
* Удаление шаблона не откатывает его значения (иначе сюрприз); оно лишь снимает управление. UI предлагает «откатить перед удалением».
* `excluded` одного шаблона не должен пересекаться с `managed` другого: иначе неопределённость → отказ.

---

## 9. Пример: типовой шаблон «базовая гигиена»

```json
{
  "schema_version": 1,
  "product_scope": ["prokop"],
  "managed": {
    "settings:settings.log_level": "warn",
    "settings:settings.dns_strategy": "prefer_ipv4",
    "settings:settings.disable_quic": "1",
    "settings:settings.exclude_ntp": "0",
    "settings:settings.intercept_client_dns": "0",
    "settings:settings.tproxy_low_memory": "0",
    "settings:settings.dns_check_interval": "10s",
    "settings:settings.dns_recovery_check_interval": "60s",
    "settings:settings.dns_failover_failure_threshold": "3",
    "urltest:Fastest.check_interval": "3m",
    "urltest:Fastest.tolerance": "50",
    "urltest:Fastest.testing_url": "https://www.gstatic.com/generate_204"
  },
  "excluded": {
    "settings:settings.dns_server": "DNS-серверы задаются локально",
    "settings:settings.source_network_interfaces": "зависит от железа",
    "settings:settings.enable_badwan_interface_monitoring": "зависит от WAN",
    "settings:settings.badwan_monitored_interfaces": "зависит от WAN",
    "settings:settings.badwan_reload_delay": "зависит от WAN",
    "settings:settings.output_network_interface": "зависит от WAN",
    "settings:settings.enable_output_network_interface": "зависит от WAN",
    "settings:settings.list_update_enabled": "локальная политика",
    "settings:settings.update_interval": "локальная политика",
    "settings:settings.component_update_check_enabled": "локальная политика",
    "settings:settings.component_update_check_interval": "локальная политика",
    "settings:settings.latency_test_url": "локальная политика",
    "settings:settings.download_lists_via_proxy": "локальная политика",
    "settings:settings.download_components_via_proxy": "локальная политика",
    "settings:settings.dont_touch_dhcp": "локальная политика",
    "settings:settings.device_traffic": "локальная политика",
    "settings:settings.exclude_bittorrent": "локальная политика",
    "settings:settings.dns_rewrite_ttl": "локальная политика",
    "settings:settings.dns_detour_enabled": "локальная политика",
    "settings:settings.dns_detour_section": "локальная политика",
    "settings:settings.nfqws_first_packets": "локальная политика",
    "settings:settings.dns_type": "зависит от провайдера",
    "settings:settings.bootstrap_dns_server": "зависит от провайдера",
    "settings:settings.dns_check_timeout": "зависит от провайдера",
    "settings:settings.enable_yacd": "локальная политика"
  },
  "create_urltest": [],
  "remove_urltest": []
}
```

Обратите внимание: исключения — это не «секреты» (они вообще вне универсума), а параметры, зависящие от железа/провайдера. Такой шаблон можно применять к парку.

---

## 10. Массовое применение

* До 10 роутеров в batch (настраивается, не больше лимита роутеров на пользователя).
* Diff — по каждому; блокировки не мешают остальным.
* Подтверждение — одно, но UI обязан показать: сколько `add/change/delete`, сколько `blocked`, сколько `offline`.
* Применение — последовательное по роутерам (не параллельно), чтобы не устраивать шторм reload'ов.
* Частичный успех — нормальный результат: `batch_status=partial`, по каждому роутеру свой `apply_run`.
* Отмена batch отменяет только ещё не начатые роутеры.

---

## 11. Тесты, которые обязаны быть

1. Diff на фикстурах Forkop и Prokop (разные наборы опций, разные `get_ui_state`).
2. Шаблон с секретным путём → отказ на сохранении.
3. Шаблон с пропущенной опцией → `incomplete` со списком.
4. Diff `delete` → требует отдельного подтверждения.
5. Внешнее изменение между diff и apply → `stale_diff`.
6. Reload вернул `queued` → job не считается успешным до verify.
7. Verify провалился → restore → verify → `rolled_back`.
8. Restore невозможен → `rollback_failed`, без автоповтора.
9. `product_conflict` → apply заблокирован, read-only работает.
10. Массовое применение: один роутер offline, остальные успешны → `partial`.
