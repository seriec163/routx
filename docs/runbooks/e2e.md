# E2E (Playwright)

Каркас браузерных тестов лежит в `e2e/`, конфиг — `playwright.config.ts`.

Запуск против уже поднятой панели:

```bash
npm run test:e2e
# или против конкретного адреса:
PLAYWRIGHT_BASE_URL=https://routx.example.com npm run test:e2e
```

Первый раз нужно поставить браузер:

```bash
npx playwright install chromium
```

Сейчас покрыт smoke: страница входа и корень без сессии. В CI есть отдельный
джоб **Playwright + agent flow**: он поднимает Postgres, применяет миграции,
собирает панель, создаёт bootstrap-администратора, запускает сервер, гоняет
Playwright и сквозной сценарий `verify:agent-flow` (bind → probe → refresh →
секция → удаление временного роутера).
