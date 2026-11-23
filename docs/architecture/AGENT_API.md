# Агентский API

Машинночитаемый контракт: `docs/architecture/agent-openapi.json` (OpenAPI 3.1).

Источник схем — `server/src/agent/schemas.ts`, маршруты — `server/src/agent/routes.ts`.

Пересобрать контракт после изменения схем:

```bash
npm run contract:agent
```

CI проверяет, что файл закоммичен в актуальном виде (`git diff --exit-code`).

Что описано: `bind`, `probe`, `poll`, `commands/{id}/result`, `report`,
`rotate`. Все запросы кроме `bind` подписываются токеном агента:

```text
Authorization: Bearer <agent_token>
X-Rc-Timestamp: <unix seconds>
X-Rc-Nonce: <16–128 символов>
X-Rc-Signature: HMAC-SHA256(token, method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + sha256(body))
```

Эмулятор агента для сквозной проверки: `scripts/fake-agent-check.mjs`
(см. `docs/runbooks/agent-flow-check.md`).
