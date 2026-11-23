import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  bindSchema,
  probeSchema,
  reportSchema,
  resultSchema,
} from '../server/src/agent/schemas.js';

const output = new URL('../docs/architecture/agent-openapi.json', import.meta.url);

function schema(value: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(value) as Record<string, unknown>;
}

const document = {
  openapi: '3.1.0',
  info: {
    title: 'RoutX Agent API',
    version: '1',
    description:
      'Протокол агента RoutX. Запросы, кроме bind, подписываются токеном агента: ' +
      'Authorization: Bearer <token>, X-Rc-Timestamp (секунды), X-Rc-Nonce (16–128 символов), ' +
      'X-Rc-Signature = HMAC-SHA256(token, method + "\\n" + path + "\\n" + timestamp + "\\n" + nonce + "\\n" + sha256(body)).',
  },
  servers: [{ url: '{baseUrl}', variables: { baseUrl: { default: 'https://routx.example.com' } } }],
  components: {
    securitySchemes: {
      agentToken: { type: 'http', scheme: 'bearer' },
    },
  },
  paths: {
    '/agent/v1/bind': {
      post: {
        summary: 'Привязать роутер по одноразовому токену',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: schema(bindSchema) } },
        },
        responses: {
          '200': {
            description: 'Токен агента и параметры опроса',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['router_id', 'agent_token', 'server_url'],
                  properties: {
                    router_id: { type: 'string', format: 'uuid' },
                    agent_token: { type: 'string' },
                    server_url: { type: 'string' },
                    poll_interval_seconds: { type: 'integer' },
                    poll_hold_seconds: { type: 'integer' },
                    require_signature: { type: 'boolean' },
                    server_time: { type: 'string', format: 'date-time' },
                    protocol: { type: 'string', const: 'v1' },
                  },
                },
              },
            },
          },
          '400': { description: 'Токен недействителен или продукт не совпал' },
        },
      },
    },
    '/agent/v1/probe': {
      post: {
        summary: 'Передать состояние роутера',
        security: [{ agentToken: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: schema(probeSchema) } },
        },
        responses: {
          '200': {
            description: 'Принято',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    ok: { type: 'boolean' },
                    server_time: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/agent/v1/poll': {
      post: {
        summary: 'Получить команду (long-poll)',
        security: [{ agentToken: [] }],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          '200': {
            description: 'Команда или null',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    command: {
                      oneOf: [
                        { type: 'null' },
                        {
                          type: 'object',
                          properties: {
                            id: { type: 'string', format: 'uuid' },
                            op: { type: 'string' },
                            args: { type: 'object' },
                            expires_at: { type: 'string', format: 'date-time' },
                            attempt: { type: 'integer' },
                          },
                        },
                      ],
                    },
                    server_time: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/agent/v1/commands/{id}/result': {
      post: {
        summary: 'Вернуть результат команды',
        security: [{ agentToken: [] }],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: schema(resultSchema) } },
        },
        responses: { '200': { description: 'Результат принят' } },
      },
    },
    '/agent/v1/report': {
      post: {
        summary: 'Загрузить диагностический отчёт',
        security: [{ agentToken: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: schema(reportSchema) } },
        },
        responses: { '201': { description: 'Отчёт сохранён' } },
      },
    },
    '/agent/v1/rotate': {
      post: {
        summary: 'Ротировать токен агента',
        security: [{ agentToken: [] }],
        responses: {
          '200': {
            description: 'Новый токен',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    agent_token: { type: 'string' },
                    server_time: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`agent contract: ${output.pathname}`);
