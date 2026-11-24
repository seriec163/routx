import { writeFileSync } from 'node:fs';
import { buildApp } from '../server/src/app.js';
import { collectedRoutes } from '../server/src/route-manifest.js';

const output = new URL('../docs/architecture/api-openapi.json', import.meta.url);

async function main(): Promise<void> {
  const emptyQuery = async () => ({ rows: [], rowCount: 0, command: '', fields: [] });
const pool = {
  query: emptyQuery,
  connect: async () => ({ query: emptyQuery, release: () => undefined }),
};

const app = await buildApp({
  db: {
    pool: pool as never,
    ping: async () => undefined,
    getSchemaVersion: async () => '33',
  },
  config: {
    masterKey: 'x'.repeat(32),
    publicUrl: 'https://routx.example.com',
    secureCookie: true,
    agentRequireSignature: true,
    agentPollHoldSeconds: 25,
    dataDir: '/tmp/routx-contract',
    migrationsDir: 'server/migrations',
    databaseUrl: 'postgres://contract@127.0.0.1/contract',
    cookieSecureRaw: 'true',
  },
  logger: false,
  webDist: null,
  agentDist: null,
});

const routes = collectedRoutes(app)
  .filter((route) => route.url.startsWith('/api/v1') || route.url === '/metrics')
  .sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`));
await app.close();

function openApiPath(url: string): string {
  return url
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    .replace(/\*/g, '{wildcard}');
}

const errorSchema = { $ref: '#/components/schemas/Error' };
const jobSchema = { $ref: '#/components/schemas/Job' };
const jobEnvelope = {
  type: 'object',
  properties: { job: jobSchema },
  required: ['job'],
};

const components = {
  securitySchemes: {
    sessionCookie: { type: 'apiKey', in: 'cookie', name: 'rc_session' },
    csrfHeader: { type: 'apiKey', in: 'header', name: 'x-csrf-token' },
  },
  schemas: {
    Error: {
      type: 'object',
      properties: {
        error: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            message: { type: 'string' },
            request_id: { type: 'string' },
            details: {},
          },
          required: ['code', 'message'],
        },
      },
      required: ['error'],
    },
    Job: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        type: { type: 'string' },
        router_id: { type: ['string', 'null'], format: 'uuid' },
        status: { type: 'string', enum: ['queued', 'running', 'success', 'failed', 'cancelled', 'timeout'] },
        payload: { type: 'object', additionalProperties: true },
        result: { type: ['object', 'null'], additionalProperties: true },
        error: {
          type: ['object', 'null'],
          properties: { code: { type: 'string' }, message: { type: 'string' } },
        },
        attempt: { type: 'integer' },
        max_attempts: { type: 'integer' },
        timeout_seconds: { type: 'integer' },
        created_at: { type: 'string', format: 'date-time' },
        started_at: { type: ['string', 'null'], format: 'date-time' },
        finished_at: { type: ['string', 'null'], format: 'date-time' },
      },
      required: ['id', 'type', 'status'],
    },
    RouterSummary: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        status: { type: 'string' },
        product: { type: 'string' },
        product_version: { type: ['string', 'null'] },
        agent_version: { type: ['string', 'null'] },
        managed_section: { type: ['string', 'null'] },
        owner_email: { type: ['string', 'null'] },
        last_seen_at: { type: ['string', 'null'], format: 'date-time' },
      },
      required: ['id', 'name', 'status'],
    },
    RouterLog: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        router_id: { type: 'string', format: 'uuid' },
        router_name: { type: 'string' },
        source: { type: 'string' },
        level: { type: 'string', enum: ['error', 'warn', 'info'] },
        message: { type: 'string' },
        context: { type: ['object', 'null'] },
        created_at: { type: 'string', format: 'date-time' },
        job_id: { type: ['string', 'null'], format: 'uuid' },
        job_type: { type: ['string', 'null'] },
        job_status: { type: ['string', 'null'] },
        job_error_code: { type: ['string', 'null'] },
      },
    },
  },
};

interface OperationOverride {
  summary: string;
  request?: unknown;
  response?: unknown;
  responseCode?: string;
  contentType?: string;
}

const overrides: Record<string, OperationOverride> = {
  'POST /api/v1/auth/login': {
    summary: 'Вход по email и паролю',
    request: {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' } },
      required: ['email', 'password'],
    },
  },
  'GET /api/v1/routers': {
    summary: 'Список роутеров',
    response: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/RouterSummary' } },
      },
    },
  },
  'POST /api/v1/routers': {
    summary: 'Создать роутер',
    request: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        owner_id: { type: 'string', format: 'uuid' },
        product_hint: { type: 'string', enum: ['any', 'forkop', 'prokop', 'podkop', 'tachyon'] },
      },
      required: ['name'],
    },
    response: {
      type: 'object',
      properties: { router: { $ref: '#/components/schemas/RouterSummary' } },
    },
    responseCode: '201',
  },
  'GET /api/v1/routers/{id}': {
    summary: 'Роутер, состояние и назначения шаблонов',
    response: {
      type: 'object',
      properties: {
        router: { $ref: '#/components/schemas/RouterSummary' },
        state: { type: ['object', 'null'], additionalProperties: true },
        assignments: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
  },
  'POST /api/v1/routers/{id}/refresh': {
    summary: 'Прочитать состояние роутера',
    response: jobEnvelope,
    responseCode: '202',
  },
  'POST /api/v1/routers/{id}/diff': {
    summary: 'Сравнить состояние с шаблоном',
    request: {
      type: 'object',
      properties: {
        template_id: { type: 'string', format: 'uuid' },
        revision: { type: 'integer' },
        section_map: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['template_id'],
    },
    response: jobEnvelope,
    responseCode: '202',
  },
  'POST /api/v1/routers/{id}/wifi/read': {
    summary: 'Прочитать Wi-Fi сети',
    response: jobEnvelope,
    responseCode: '202',
  },
  'POST /api/v1/routers/{id}/wifi': {
    summary: 'Создать Wi-Fi сеть',
    request: {
      type: 'object',
      properties: {
        ssid: { type: 'string', maxLength: 32 },
        encryption: {
          type: 'string',
          enum: ['none', 'owe', 'psk', 'psk2', 'psk-mixed', 'sae', 'sae-mixed'],
        },
        key: { type: 'string' },
        hidden: { type: 'boolean' },
        disabled: { type: 'boolean' },
        isolate: { type: 'boolean' },
        radios: { type: 'array', items: { type: 'string' } },
      },
      required: ['ssid', 'encryption'],
    },
    response: jobEnvelope,
    responseCode: '202',
  },
  'GET /api/v1/jobs': {
    summary: 'Список задач',
    response: {
      type: 'object',
      properties: { items: { type: 'array', items: jobSchema } },
    },
  },
  'GET /api/v1/jobs/{id}': {
    summary: 'Задача с событиями',
    response: jobEnvelope,
  },
  'GET /api/v1/router-logs': {
    summary: 'Логи и ошибки роутеров',
    response: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/RouterLog' } },
      },
    },
  },
  'GET /api/v1/deploy/status': { summary: 'Состояние инстанса и мастер-ключа' },
  'GET /api/v1/deploy/verify': { summary: 'Проверка после импорта' },
  'GET /metrics': {
    summary: 'Метрики Prometheus',
    response: { type: 'string' },
    contentType: 'text/plain',
  },
};

const paths: Record<string, Record<string, unknown>> = {};
for (const route of routes) {
  const path = openApiPath(route.url);
  const method = route.method.toLowerCase();
  const key = `${route.method} ${path}`;
  const override = overrides[key];
  const tag = path.split('/')[3] ?? 'api';

  const responses: Record<string, unknown> = {};
  if (override?.response) {
    responses[override.responseCode ?? '200'] = {
      description: 'Успех',
      content: {
        [override.contentType ?? 'application/json']: { schema: override.response },
      },
    };
  } else {
    responses[override?.responseCode ?? '200'] = {
      description: 'Успех',
      content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
    };
  }
  for (const code of ['400', '401', '403', '404', '409', '429', '500']) {
    responses[code] = {
      description: 'Ошибка',
      content: { 'application/json': { schema: errorSchema } },
    };
  }

  const operation: Record<string, unknown> = {
    tags: [tag],
    summary: override?.summary ?? `${route.method} ${path}`,
    operationId: `${method}_${path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    responses,
  };
  if (!route.public) {
    operation.security = [{ sessionCookie: [] }];
  }
  if (override?.request) {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: override.request } },
    };
  } else if (['post', 'put', 'patch'].includes(method)) {
    operation.requestBody = {
      required: false,
      content: {
        'application/json': { schema: { type: 'object', additionalProperties: true } },
      },
    };
  }

  paths[path] ??= {};
  paths[path][method] = operation;
}

const document = {
  openapi: '3.1.0',
  info: {
    title: 'RoutX API',
    version: '2.1.4',
    description:
      'Пользовательский API панели RoutX. Аутентификация — cookie rc_session; ' +
      'для POST/PUT/PATCH/DELETE нужен заголовок x-csrf-token из cookie rc_csrf.',
  },
  servers: [{ url: '{baseUrl}', variables: { baseUrl: { default: 'https://routx.example.com' } } }],
  components,
  paths,
};

  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`api contract: ${routes.length} routes, ${output.pathname}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
