# sing-box: варианты и откат

## Варианты

| ID | Что ставится | Источник |
|---|---|---|
| `tiny` | `sing-box-tiny` из пакетного репозитория OpenWrt/Prokop | package feed |
| `stable` | обычный `sing-box` из пакетного репозитория | package feed |
| `extended` | `sing-box-extended` (XHTTP и дополнительные протоколы) | `shtorm-7/sing-box-extended` |
| `extended_compressed` | Extended со сжатым бинарником и Cronet | `shtorm-7/sing-box-extended` |

Текущий вариант определяется по `/etc/<product>/sing-box-variant`, версия — по
`prokop/forkop show_sing_box_version`.

## API

* `GET /api/v1/singbox/variants` — каталог вариантов.
* `POST /api/v1/routers/{id}/singbox/check` — `component_action sing_box check_update`,
  возвращает текущую/последнюю версию и вариант.
* `POST /api/v1/routers/{id}/singbox/install`
  ```json
  { "variant": "extended", "acknowledge_risk": true }
  ```
  Для конкретной версии Extended:
  ```json
  { "variant": "extended", "version_tag": "1.12.22", "acknowledge_risk": true }
  ```
* `POST /api/v1/routers/{id}/singbox/rollback` — вернуть сохранённые
  `sing_box_previous_variant` / `sing_box_previous_version`.

## Откат

Перед установкой сервер запоминает текущий вариант/версию. Если upstream-установка
завершилась ошибкой, job пытается поставить предыдущий вариант и проверяет его.
При успешном откате job всё равно помечается `failed`, чтобы ошибка не потерялась.
Успешная установка сохраняет предыдущие значения в `routers.sing_box_previous_*`.

## Место на роутере

Prokop/Forkop перед установкой проверяют свободное место и могут отказать:

```text
Not enough free space ... 18496 KiB available where 32341 KiB is needed
```

При смене варианта Prokop/Forkop сначала удаляет текущий пакет sing-box, чтобы
освободить место, и только затем ставит новый. Поэтому на время установки
sing-box может быть недоступен — это ожидаемо и допустимо.

Если новый пакет не установился или не прошёл проверку, RoutX пытается
вернуть предыдущий вариант и версию. Успешная установка сохраняет предыдущие
значения в `routers.sing_box_previous_*`.

Если места не хватает даже после удаления старого пакета, установка завершится
ошибкой; тогда нужен extroot/USB или очистка кэшей. На Cudy WR3000S с 44.7 MB
overlay свободно около 18 MB, поэтому Extended может потребовать освобождения
места.

`component_action` Prokop/Forkop остаётся штатным механизмом установки: он сам
проверяет место, удаляет конфликтующий пакет и делает backup/restore. Router
Control не обходит эту проверку и не устанавливает пакеты в обход Prokop.

## UI

Страница роутера → вкладка **sing-box**:

* текущий вариант и версия;
* карточки Tiny / Extended / Extended compressed / Stable;
* «Проверить обновления»;
* «Вернуть предыдущую»;
* при выборе карточки ниже открывается панель версий:
  * Extended — список версий из официального каталога, можно поставить конкретную;
  * Extended compressed — последняя compressed-сборка; конкретную версию выбрать
    нельзя, потому что `component_action sing_box install_version` в Prokop/Forkop
    всегда ставит Extended;
  * Tiny и Stable — последняя версия из пакетного репозитория; списка версий нет.

Выбор карточки не запускает установку: сначала показываются доступные версии или
способ установки, затем пользователь подтверждает действие.

После установки проверяется версия/вариант, обновляются `routers.sing_box_*`.
