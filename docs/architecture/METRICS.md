# Метрики

`GET /metrics` отдаёт снимок в формате Prometheus (`text/plain; version=0.0.4`).
Доступ:

* если задан `RC_METRICS_TOKEN`, нужен заголовок
  `Authorization: Bearer <токен>`;
* без токена эндпоинт открыт — закрывайте его на уровне Caddy/фаервола,
  если панель смотрит в интернет.

Что отдаётся:

| Метрика | Тип | Смысл |
|---|---|---|
| `routx_routers{status}` | gauge | роутеры по статусу |
| `routx_routers_online` | gauge | сколько онлайн |
| `routx_jobs{status}` | gauge | задачи по статусу |
| `routx_jobs_failed_24h{type}` | gauge | ошибки за сутки по типам |
| `routx_jobs_oldest_queued_seconds` | gauge | возраст старейшей задачи в очереди |
| `routx_db_size_bytes` | gauge | размер базы |
| `routx_disk_free_bytes`, `routx_disk_total_bytes` | gauge | раздел с `/app/data` |
| `routx_uptime_seconds` | gauge | uptime процесса |
| `routx_process_memory_bytes` | gauge | RSS |

Пример scrape-конфига:

```yaml
scrape_configs:
  - job_name: routx
    scheme: https
    static_configs:
      - targets: ["routx.example.com"]
    authorization:
      credentials: <RC_METRICS_TOKEN>
```

Полезные алерты: `routx_jobs_oldest_queued_seconds > 3600`,
`routx_jobs_failed_24h{type="agent_update"} > 0`,
`routx_routers_online < ожидаемого`, `routx_disk_free_bytes < 1 GiB`.
