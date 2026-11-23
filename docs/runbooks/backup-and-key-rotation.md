# Резервные копии и ротация ключа

## 1. Шифрованные бэкапы PostgreSQL

Бэкап делает отдельный контейнер `backup` (профиль `backup`). Он:

1. снимает `pg_dump --format=custom`;
2. проверяет дамп через `pg_restore --list`;
3. шифрует AES-256-CBC (PBKDF2);
4. удаляет локальные копии старше `BACKUP_RETENTION_DAYS`;
5. при необходимости отправляет файл offsite.

### Настройка

В `.env`:

```dotenv
BACKUP_PASSPHRASE=<длинный случайный пароль>
BACKUP_RETENTION_DAYS=14
# Необязательно. Команда получает путь в $BACKUP_FILE.
# BACKUP_OFFSITE_CMD=rclone copy "$BACKUP_FILE" remote:routx-backups/
```

Пароль шифрования храните отдельно от бэкапов и от `.env` в Git. Без него
дампы не восстановить.

### Запуск

```sh
docker compose --profile backup build backup
docker compose --profile backup run --rm backup
```

Файл появится в `./backups/`:

```text
router_control-20261031T121500Z.dump.enc
```

### Расписание

Linux (cron, ежедневно в 03:15):

```cron
15 3 * * * cd /opt/routx && docker compose --profile backup run --rm backup >> /var/log/routx-backup.log 2>&1
```

Windows (Task Scheduler): запускать

```powershell
docker compose --profile backup run --rm backup
```

с рабочей папкой проекта.

### Восстановление

1. Расшифровать:

```sh
openssl enc -d -aes-256-cbc -pbkdf2 \
  -in backups/router_control-....dump.enc \
  -out /tmp/router_control.dump \
  -pass env:BACKUP_PASSPHRASE
```

2. Проверить:

```sh
docker compose exec -T db pg_restore --list < /tmp/router_control.dump >/dev/null
```

3. Восстановить в **пустую** базу (не поверх рабочей без подтверждения):

```sh
docker compose exec -T db pg_restore \
  --clean --if-exists --no-owner --no-privileges \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" < /tmp/router_control.dump
```

4. Перезапустить `app` и проверить `/readyz`, вход и состояние роутеров.

RPO — 24 часа при ежедневном запуске. RTO — около 1 часа с учётом проверки.

## 2. Ротация `RC_MASTER_KEY`

Ключ шифрует:

- `router_connections.secret_enc`;
- `router_connections.compact_secret` (`rc1.…`);
- `subscriptions.secret_enc`;
- `users.totp_secret_enc`.

Процедура выполняется **без остановки приложения**, пока оно работает со старым
ключом.

### Проверка без записи

```sh
docker compose exec -T \
  -e RC_MASTER_KEY_NEW='<новый ключ>' \
  app node server/dist/cli/rotate-master-key.js --dry-run
```

Команда проверит, что все секреты читаются текущим ключом, и ничего не изменит.

### Ротация

```sh
docker compose exec -T \
  -e RC_MASTER_KEY_NEW='<новый ключ>' \
  app node server/dist/cli/rotate-master-key.js
```

Ожидаемый вывод:

```text
Ключ ротирован: подключений N, компактных секретов M, подписок K, TOTP T.
```

### Переключение приложения

1. Заменить `RC_MASTER_KEY` в `.env` на новый.
2. Удалить `RC_MASTER_KEY_NEW` из окружения.
3. Перезапустить:

```sh
docker compose up -d app
```

4. Проверить вход, 2FA, подключения и подписки.

Если ротация упала, транзакция откатывается, старый ключ продолжает работать.
Не меняйте `.env` до успешного завершения команды.

### Ограничения

- Ротация не меняет `RC_MASTER_KEY` в уже запущенном процессе: после смены
  `.env` нужен перезапуск `app`.
- Старые копии `.env` и бэкапы, зашифрованные прежним ключом, нужно хранить
  отдельно до истечения срока.
- При потере старого ключа без ротации расшифровать данные невозможно.
