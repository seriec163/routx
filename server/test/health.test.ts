import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const readyDb = {
  async ping() {},
  async getSchemaVersion() {
    return '1';
  },
};

const brokenDb = {
  async ping() {
    throw new Error('connection refused');
  },
  async getSchemaVersion() {
    throw new Error('connection refused');
  },
};

const unmigratedDb = {
  async ping() {},
  async getSchemaVersion() {
    return null;
  },
};

describe('служебные эндпоинты', () => {
  it('/healthz отвечает 200 даже при недоступной БД', async () => {
    app = await buildApp({ db: brokenDb, logger: false });
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'routx' });
  });

  it('/readyz отвечает 200, когда БД доступна', async () => {
    app = await buildApp({ db: readyDb, logger: false });
    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ready', checks: { db: 'ok' } });
  });

  it('/readyz отвечает 503, когда БД недоступна', async () => {
    app = await buildApp({ db: brokenDb, logger: false });
    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'not_ready', checks: { db: 'error' } });
  });

  it('/readyz отвечает 503, пока миграции не применены', async () => {
    app = await buildApp({ db: unmigratedDb, logger: false });
    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not_ready',
      checks: { db: 'ok', schema: 'missing' },
    });
  });

  it('/api/v1/meta отдаёт версию схемы', async () => {
    app = await buildApp({ db: readyDb, logger: false });
    const response = await app.inject({ method: 'GET', url: '/api/v1/meta' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'routx',
      api_version: 'v1',
      schema_version: '1',
    });
  });

  it('/api/v1/meta отвечает 503 при ошибке БД', async () => {
    app = await buildApp({ db: brokenDb, logger: false });
    const response = await app.inject({ method: 'GET', url: '/api/v1/meta' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'service_unavailable' } });
  });

  it('неизвестный API-путь отдаёт 404 в конверте ошибки', async () => {
    app = await buildApp({ db: readyDb, logger: false });
    const response = await app.inject({ method: 'GET', url: '/api/v1/unknown' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('выставляет базовые security-заголовки', async () => {
    app = await buildApp({ db: readyDb, logger: false });
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('запрещает кеширование служебных и API-ответов', async () => {
    app = await buildApp({ db: readyDb, logger: false });
    const response = await app.inject({ method: 'GET', url: '/api/v1/meta' });

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});
