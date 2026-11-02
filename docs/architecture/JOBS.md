# RoutX — задания (очередь, состояния, восстановление)

Очередь — таблица `jobs` в PostgreSQL (`FOR UPDATE SKIP LOCKED`), см. `DATA_MODEL.md` §6. Внешний брокер не используется.

---

## 1. Состояния

Разрешённые статусы (требование ТЗ, ровно эти):

```text
queued ──▶ running ──┬──▶ success
                     ├──▶ failed
                     ├──▶ timeout
                     └──▶ cancelled
   │
   └──▶ cancelled (до старта)
```

| Статус | Значение |
|---|---|
| `queued` | создано, ждёт исполнителя или `scheduled_at` |
| `running` | захвачено воркером, есть lease |
| `success` | результат получен и проверен |
| `failed` | терминальная ошибка (исчерпаны попытки или ошибка неретраибельная) |
| `timeout` | не уложилось в `timeout_seconds` |
| `cancelled` | отменено пользователем/системой до завершения |

Дополнительно (не статусы, а поля): `error_code`, `error_detail`, `next_retry_at`, `attempt`.

`needs_attention` — **не** статус задания, а статус `apply_runs`/`rollout_targets`: задание завершилось `success`, но проверка показала, что требуется человек (например, сервис не поднялся после обновления).

---

## 2. Типы заданий

| Тип | Mutate | Типичный таймаут | Ретраи | Сериализация |
|---|---|---|---|---|
| `precheck` | нет | 60 с | 2 | нет |
| `monitor` | нет | 90 с | 1 (следующий тик всё равно) | per-router |
| `diff` | нет | 120 с | 2 | per-router |
| `apply` | да | 300 с | **0** | строго per-router |
| `snapshot` | да (локально) | 120 с | 1 | per-router |
| `restore` | да | 300 с | 0 | строго per-router |
| `diagnostics` | нет | 120 с (quick) / 300 с (full) | 1 | per-router |
| `sb_check` | нет | 120 с | 2 | per-router |
| `sb_install` | да | 900 с | **0** | строго per-router |
| `reconcile` | нет | 120 с | 2 | per-router |

Правила:

* mutate-задания **никогда** не ретраятся автоматически: повторное применение конфигурации или установка компонента без человека опасна. Ретрай — только новая явная команда пользователя.
* `apply` и `sb_install` не могут выполняться одновременно на одном роутере.
* `monitor` не выполняется, если на роутере есть `apply`/`restore`/`sb_install` в `queued|running`.

---

## 3. Захват и lease

```text
worker loop (каждые 2 с):
  BEGIN;
  SELECT id FROM jobs
   WHERE status='queued'
     AND scheduled_at <= now()
     AND (next_retry_at IS NULL OR next_retry_at <= now())
   ORDER BY priority, scheduled_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1;
  UPDATE jobs SET status='running', attempt=attempt+1,
                  started_at=now(), lease_owner=$me,
                  lease_expires_at=now()+interval '30 seconds'
   WHERE id=$id;
  COMMIT;
```

* Lease продлевается каждые 10 с, пока воркер жив (`heartbeat` воркера).
* Reaper каждые 15 с:

```sql
UPDATE jobs
   SET status = CASE WHEN attempt >= max_attempts THEN 'timeout' ELSE 'queued' END,
       error_code = 'lease_expired',
       next_retry_at = now() + interval '10 seconds',
       lease_owner = NULL
 WHERE status='running' AND lease_expires_at < now();
```

Для mutate-заданий `attempt >= max_attempts` (max_attempts=1) → `timeout`, не `queued`.

* `idempotency_key` (например, `apply:{apply_run_id}`) защищает от дублей при повторном нажатии кнопки.

---

## 4. Жизненный цикл задания (детально)

```text
1. API создаёт jobs(status=queued) + apply_runs(awaiting_confirmation)
2. Пользователь подтверждает → apply_runs(queued), jobs(queued)
3. Воркер захватывает job
4. Проверки до отправки команды:
   - router.status in (online, error) и не conflict
   - product != unknown
   - agent manifest содержит op
   - нет активного mutate на роутере
   - apply: backup_ok=true, diff_hash актуален
5. Создаётся agent_commands(pending, expires_at)
6. poll отдаёт команду → delivered
7. Агент выполняет и присылает result
8. Сервер валидирует result, пишет job_events
9. Для apply/sb_install — обязательная пост-проверка (verify)
10. Терминальный статус + аудит + обновление router_state/apply_runs
```

Если команда не доставлена за TTL → `agent_commands(expired)`, задание `timeout` (`reason=agent_unreachable`), мониторинг фиксирует пропуск.

---

## 5. Таймауты

Три уровня:

1. **TTL команды** (доставка): 10 мин mutate / 2 мин read.
2. **Таймаут задания** (`jobs.timeout_seconds`): от старта выполнения.
3. **Таймаут на роутере** (агент): внутренний guard на каждый upstream-вызов (например, `reload` — 180 с, `check_proxy` — 60 с, `component_action` — до 900 с).

Правило: таймаут агента **меньше** таймаута задания, чтобы агент успел прислать `failed/timeout`, а не оставить сервер гадать.

Для upstream-заданий (`service_action_async`, `latency_test_async`, `component_action_async`) агент:

* опрашивает `*_status` с интервалом 1–2 с;
* прекращает опрос по таймауту задания;
* при `reason=stale` сообщает `failed` с кодом `upstream_stale`;
* при `reason=busy` — не ретраит, сообщает `job_busy`.

---

## 6. Отмена

* `POST /jobs/{id}/cancel`:
  * `queued` → `cancelled` сразу;
  * `running` → флаг `cancel_requested` (поле в `jobs`), агент получает `cancel` в следующем poll; если команда уже выполняется — агент завершает текущий upstream-вызов и не начинает следующий шаг;
  * mutate-задание, уже начавшее `apply_uci`, **не отменяется** посередине: доводится до verify/rollback, отмена игнорируется с `409 job_in_progress`.
* Массовая отмена — по `batch_id` (только `queued`).

---

## 7. Планировщик мониторинга

Требование: цель 60 с, разнос по времени, без наложений на роутер.

```text
tick = 10 s
for each router where monitoring_enabled and status != 'conflict':
    if router has active job (apply/restore/sb_install/diagnostics/diff): skip
    due = last_monitor_finished + 60 s + jitter(router_id)
    if now >= due and no monitor job in (queued|running):
        enqueue monitor (priority 200)
```

`jitter(router_id)` — детерминированный (hash от UUID) в диапазоне 0…15 с. Это даёт ровный разброс без «толпы» в одну секунду и без случайных пропусков.

Дополнительно:

* глобальный лимит одновременных `monitor` — `min(32, 2×workers)`.
* если роутер offline, интервал удваивается до 5 мин (не долбить), после 3 успехов возвращается к 60 с.
* при `429`/`503` от агента — backoff.

---

## 8. Восстановление после сбоев

| Сценарий | Действие |
|---|---|
| Сервер упал во время `running` | Lease истекает → reaper. Read-задания → `queued`; mutate → `timeout` (`reason=server_restart`) |
| Сервер упал после отправки команды, до результата | Команда остаётся `delivered`; после рестарта переотдаётся с тем же `id`; агент дедуплицирует и возвращает сохранённый результат (или выполняет, если ещё не выполнял) |
| Агент упал во время выполнения | После старта агент видит `inflight` в своём журнале; помечает `lost`, выполняет `reconcile`: читает фактическое состояние и сообщает серверу |
| Агент перезагрузился | Журнал на flash; `command_id` не повторяется; `reconcile` при следующем poll |
| Роутер offline > TTL | Команда `expired`; задание `timeout`; UI: «роутер недоступен» |
| Дубликат результата | `200`, повторно не пишется |

### 8.1. `reconcile`

При старте агента и при каждом подключении, если в журнале есть незавершённые команды:

1. `product_probe` + `read_state` + `get_status`;
2. сравнение с `expected_state_hash` из команды;
3. результат: `applied` (состояние совпало), `not_applied` (не менялось), `unknown` (частично);
4. сервер обновляет `apply_runs` (только `success`, `failed`, `needs_attention` — без «додумывания»).

Это единственный способ честно закрыть «сервер не знает, применилось ли» без слепого повтора.

---

## 9. Идемпотентность

* `agents_commands.id` — UUIDv7; журнал на роутере (`command_id → {status, result_hash, at}`), TTL 7 дней, лимит 500 записей.
* Повторная доставка той же команды: агент возвращает сохранённый результат, **не выполняя** операцию.
* Мутации дополнительно проверяют `expected_state_hash`: если состояние уже соответствует desired — `skipped` (идемпотентный no-op).
* `apply` имеет `diff_hash`; повторный apply того же diff после успеха → `409 already_applied`.

---

## 10. События и наблюдаемость

`job_events` (append-only):

```text
seq | at | status | code | message | data
1   | …  | running | -            | "job started"            | {"worker":"w1"}
2   | …  | running | command_sent | "command delivered"      | {"command_id":"…"}
3   | …  | running | snapshot_ok  | "snapshot created"       | {"id":"…","size":1234}
4   | …  | running | reload_queued| "reload queued"          | {"waited_ms":12000}
5   | …  | success | verified     | "service and proxy ok"   | {"delay_ms":42}
```

Метрики сервера:

* `rc_jobs_total{type,status}`;
* `rc_job_duration_seconds{type}` (histogram);
* `rc_agent_poll_age_seconds{router}`;
* `rc_agent_commands_pending`;
* `rc_apply_total{result}`;
* `rc_monitor_misses_total{router}`.
