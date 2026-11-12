import type { FastifyInstance } from 'fastify';
import { lookup } from 'node:dns/promises';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireUser } from '../auth/service.js';
import { badRequest, unavailable } from '../lib/errors.js';
import { PushService } from '../push.js';

export interface PushRouteContext {
  pool: Pool;
  push: PushService | null;
}

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe8') ||
    value.startsWith('fe9') ||
    value.startsWith('fea') ||
    value.startsWith('feb') ||
    value.startsWith('::ffff:')
  );
}

/**
 * Endpoint приходит от браузера, а сервер делает по нему POST. Не даём
 * использовать подписку как SSRF-канал во внутреннюю сеть: проверяем и
 * литеральный адрес, и результат DNS-резолва.
 */
async function assertPushEndpoint(endpoint: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw badRequest('invalid_endpoint', 'Некорректный адрес push-подписки');
  }
  if (url.protocol !== 'https:') {
    throw badRequest('invalid_endpoint', 'Push-подписка должна использовать HTTPS');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('[')) {
    throw badRequest('invalid_endpoint', 'Push-подписка указывает на внутренний адрес');
  }
  if (isPrivateIpv4(host)) {
    throw badRequest('invalid_endpoint', 'Push-подписка указывает на внутренний адрес');
  }

  const addresses = await lookup(host, { all: true }).catch(() => []);
  for (const item of addresses) {
    const address = item.address.toLowerCase();
    if (item.family === 4 ? isPrivateIpv4(address) : isPrivateIpv6(address)) {
      throw badRequest('invalid_endpoint', 'Push-подписка указывает на внутренний адрес');
    }
  }
}

export async function registerPushRoutes(
  app: FastifyInstance,
  ctx: PushRouteContext,
): Promise<void> {
  const { pool, push } = ctx;

  app.get('/api/v1/push/config', async (request) => {
    const auth = requireUser(request);
    if (!push) {
      return { enabled: false, public_key: null, subscriptions: 0 };
    }
    const result = await pool.query<{ count: string }>(
      'select count(*)::text as count from push_subscriptions where user_id = $1',
      [auth.userId],
    );
    return {
      enabled: true,
      public_key: push.publicKey,
      subscriptions: Number(result.rows[0]?.count ?? 0),
    };
  });

  app.post('/api/v1/push/subscribe', async (request) => {
    const auth = requireUser(request);
    if (!push) {
      throw unavailable('push_unavailable', 'Push-уведомления на сервере не настроены');
    }

    const body = z
      .object({
        endpoint: z.string().min(10).max(2048),
        keys: z
          .object({
            p256dh: z.string().min(10).max(512),
            auth: z.string().min(4).max(512),
          })
          .strict(),
      })
      .strict()
      .parse(request.body ?? {});

    await assertPushEndpoint(body.endpoint);

    const userAgent = request.headers['user-agent']?.slice(0, 300) ?? null;
    const existing = await pool.query<{ count: string; known: boolean }>(
      `select count(*)::text as count,
              bool_or(endpoint = $2) as known
         from push_subscriptions where user_id = $1`,
      [auth.userId, body.endpoint],
    );
    if (
      Number(existing.rows[0]?.count ?? 0) >= 20 &&
      existing.rows[0]?.known !== true
    ) {
      throw badRequest('too_many_subscriptions', 'Слишком много устройств с уведомлениями');
    }

    await pool.query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       values ($1,$2,$3,$4,$5)
       on conflict (endpoint) do update
         set user_id = excluded.user_id,
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             user_agent = excluded.user_agent,
             updated_at = now(),
             last_error = null,
             last_error_at = null`,
      [auth.userId, body.endpoint, body.keys.p256dh, body.keys.auth, userAgent],
    );

    return { ok: true };
  });

  app.post('/api/v1/push/unsubscribe', async (request) => {
    const auth = requireUser(request);
    const body = z
      .object({ endpoint: z.string().min(10).max(2048) })
      .strict()
      .parse(request.body ?? {});

    await pool.query('delete from push_subscriptions where endpoint = $1 and user_id = $2', [
      body.endpoint,
      auth.userId,
    ]);
    return { ok: true };
  });

  app.post('/api/v1/push/test', async (request) => {
    const auth = requireUser(request);
    if (!push) {
      throw unavailable('push_unavailable', 'Push-уведомления на сервере не настроены');
    }
    const count = await pool.query<{ count: string }>(
      'select count(*)::text as count from push_subscriptions where user_id = $1',
      [auth.userId],
    );
    if (Number(count.rows[0]?.count ?? 0) === 0) {
      throw badRequest('no_subscriptions', 'Сначала включите уведомления на этом устройстве');
    }

    await push.sendToUser(auth.userId, {
      title: 'RoutX',
      body: 'Уведомления подключены. Здесь появятся события роутеров.',
      tag: 'routx-test',
      severity: 'info',
    });
    return { ok: true };
  });
}
