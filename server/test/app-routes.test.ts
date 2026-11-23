import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('маршруты приложения', () => {
  it('регистрируются без дублей', async () => {
    const empty = async () => ({ rows: [], rowCount: 0, command: '', fields: [] });
    const pool = {
      query: empty,
      connect: async () => ({ query: empty, release: () => undefined }),
    };

    const app = await buildApp({
      db: {
        pool: pool as never,
        ping: async () => undefined,
        getSchemaVersion: async () => '28',
      },
      config: {
        masterKey: 'x'.repeat(32),
        publicUrl: 'http://127.0.0.1:3000',
        secureCookie: false,
        agentRequireSignature: false,
        agentPollHoldSeconds: 25,
        masterKeySource: 'env',
      },
      logger: false,
      webDist: null,
      agentDist: null,
    });

    expect(app).toBeTruthy();
    expect(
      app.hasRoute({ method: 'POST', url: '/api/v1/users/:id/impersonate' }),
    ).toBe(true);
    expect(
      app.hasRoute({ method: 'POST', url: '/api/v1/auth/impersonation/stop' }),
    ).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/updates' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/api/v1/updates/apply' })).toBe(true);
    await app.close();
  });
});
