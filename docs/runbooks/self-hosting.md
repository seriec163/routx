# Свой сервер RoutX

Репозиторий можно клонировать и развернуть отдельным инстансом. Это
**не** подключение к уже работающей панели: у нового сервера будет своя
база, свой домен, свой администратор и свои роутеры.

## Что нужно

* Linux-хост или VPS (Debian / Ubuntu — проще всего);
* для Docker-режима — Docker 24+ и Compose v2, 2 ГБ RAM и 10 ГБ диска;
* для нативного режима — Node.js 22.12+, PostgreSQL 16, 1–2 ГБ диска;
* свой домен и DNS-запись `A`/`AAAA` на этот хост;
* открытые порты **80** и **443**;
* OpenWrt 24.10/25 на клиентском роутере с Forkop, Prokop или Podkop —
  без него панель запустится, но управлять будет нечем. Podkop требует
  OpenWrt 24.10+ и минимум 25 МБ свободного места.

Публичный HTTPS обязателен для PWA, QR-входа и Web Push.

## Установка

Самый быстрый способ — bootstrap-скрипт. Он скачает исходники с GitHub,
запустит нативную установку и откроет мастер: домен, e-mail для Let's Encrypt,
e-mail и пароль администратора, порт.

```sh
curl -fsSL https://raw.githubusercontent.com/seriec163/routx/main/install.sh | sudo sh
```

Без интерактивных вопросов:

```sh
curl -fsSL https://raw.githubusercontent.com/seriec163/routx/main/install.sh \
  | sudo sh -s -- \
      --domain routx.example.com \
      --tls-email admin@example.com \
      --admin-email admin@example.com \
      --yes
```

`--yes` автоматически ставит Node.js 24, PostgreSQL и `psql`, создаёт базу,
настраивает Caddy и systemd-сервис. Для Docker-режима добавьте `--docker`.
Если Caddy не нужен, укажите `--no-caddy`.

### Из клона репозитория

```sh
git clone https://github.com/seriec163/routx.git
cd routx
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
cd routx
git pull
docker compose --profile proxy up -d --build
```

Или одной командой в любом режиме:

```sh
sudo routx update
```

Для Docker `routx update` скачивает свежий образ
`ghcr.io/seriec163/routx:latest`; локальная сборка — `routx update --build`.

### Обновление из панели

Один раз установите host-службу:

```sh
sudo routx updater install
```

После этого в «Настройках сервера» появляется блок «Обновления»: панель
проверяет последний коммит GitHub, показывает разницу версий и позволяет
нажать «Обновить панель». Updater скачивает образ, перезапускает контейнер и
проверяет healthcheck. Если новая версия не поднялась, он автоматически
возвращает предыдущий образ.

Ручной откат:

```sh
sudo routx rollback
```

База и ключи хранятся в Docker-томах `router-control_pgdata` и
`router-control_rc_data`; пересборка их не удаляет.

## Ограничения

* Нет публичного Docker-образа: образ собирается локально из исходников.
* Лицензия — [Apache License 2.0](../../LICENSE). Код можно свободно
  использовать, изменять и распространять; при распространении сохраняйте
  [NOTICE](../../NOTICE) и ссылку на оригинальный репозиторий.
* Панель не обновляет сама себя из интерфейса; обновление — через
  `git pull` и пересборку.
* Почта/SMTP не настроена: восстановление пароля работает через TOTP,
  ссылку администратора или CLI.
* Агенты ниже 1.5.0 не выбираются для обновления из панели; их нужно
  один раз обновить вручную.
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
