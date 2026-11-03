# Свой сервер RoutX из GitLab

Репозиторий можно клонировать и развернуть отдельным инстансом. Это
**не** подключение к уже работающей панели: у нового сервера будет своя
база, свой домен, свой администратор и свои роутеры.

## Что нужно

* Linux-хост или VPS с Docker 24+ и Compose v2;
* 2 ГБ RAM и 10 ГБ диска (сборка Node.js требует памяти);
* свой домен и DNS-запись `A`/`AAAA` на этот хост;
* открытые порты **80** и **443**;
* OpenWrt 24.10/25 на клиентском роутере с Forkop, Prokop или Podkop —
  без него панель запустится, но управлять будет нечем. Podkop требует
  OpenWrt 24.10+ и минимум 25 МБ свободного места.

Публичный HTTPS обязателен для PWA, QR-входа и Web Push.

## Установка

```sh
git clone https://gitlab.com/artur.utenkov/router-control.git
cd router-control
cp .env.example .env
```

Сгенерируйте секреты:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

В `.env` задайте:

```dotenv
NODE_ENV=production
POSTGRES_PASSWORD=<длинный пароль без спецсимволов URL>
RC_MASTER_KEY=<сгенерированный ключ, 32+ символа>
RC_BIND_ADDR=127.0.0.1
RC_PORT=3000
RC_PUBLIC_URL=https://routx.example.com
RC_COOKIE_SECURE=true
TRUST_PROXY=true

RC_DOMAIN=routx.example.com
RC_TLS_MODE=admin@example.com

# Первый администратор создастся при старте. После входа пароль можно сменить.
RC_BOOTSTRAP_EMAIL=admin@example.com
RC_BOOTSTRAP_PASSWORD=<пароль не короче 12 символов>
```

`RC_TLS_MODE=internal` подходит только для локальной проверки: браузер не
будет доверять сертификату, а PWA/push на телефоне не заработают. Для
публичного домена указывайте e-mail для Let's Encrypt.

Запуск:

```sh
docker compose --profile proxy up -d --build
docker compose ps
curl https://routx.example.com/healthz
```

Контейнер `app` сам применяет миграции при старте. Caddy получает
сертификат и проксирует HTTPS на приложение.

## Первый вход

1. Откройте `https://routx.example.com`.
2. Войдите с `RC_BOOTSTRAP_EMAIL` и `RC_BOOTSTRAP_PASSWORD`.
3. Сразу смените пароль и включите 2FA в «Учётной записи».
4. Создайте роутер в панели и выпустите команду установки агента.
5. На роутере выполните команду из панели.

Ключи Web Push (VAPID) создаются автоматически в `/app/data/vapid.json`
и переживают перезапуск. SMTP и внешний push-сервис не нужны.

## Обновление

```sh
cd router-control
git pull
docker compose --profile proxy up -d --build
```

База и ключи хранятся в Docker-томах `router-control_pgdata` и
`router-control_rc_data`; пересборка их не удаляет.

## Ограничения

* Нет готового one-click установщика и публичного Docker-образа: образ
  собирается локально из исходников. CI собирает образ, но не публикует
  его в registry.
* Репозиторий не содержит `LICENSE`. Если вы хотите разрешить посторонним
  использовать и распространять код, добавьте лицензию (например, MIT или
  Apache-2.0). Без лицензии по умолчанию действует «все права защищены».
* Панель не обновляет сама себя из интерфейса; обновление — через
  `git pull` и пересборку.
* Почта/SMTP не настроена: восстановление пароля работает через TOTP,
  ссылку администратора или CLI.
* Агенты версий ≤1.2.3 не умеют self-update, их нужно один раз обновить
  вручную.
* Порт 80 должен быть свободен для ACME. Если он занят, используйте
  DNS-challenge Caddy или свой сертификат.
* Резервные копии и offsite-хранилище настраиваются отдельно:
  `docs/runbooks/backup-and-key-rotation.md`.

## Безопасность

* Не коммитьте `.env`, ключи, дампы базы и `vapid.json`.
* Для каждого инстанса используйте свои `RC_MASTER_KEY`,
  `POSTGRES_PASSWORD` и домен.
* Не открывайте PostgreSQL и порт 3000 наружу: приложение слушает
  loopback, наружу смотрит только Caddy.
* Публичный репозиторий означает, что код и документация видны всем.
  Секретов в истории быть не должно.
