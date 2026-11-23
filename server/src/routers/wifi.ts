import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { getRouter, getRouterForMutation } from './service.js';

interface RouteContext {
  pool: Pool;
}

const IFACE_RE = /^[A-Za-z0-9_]{1,64}$/;

const changesSchema = z
  .object({
    ssid: z.string().trim().min(1).max(32).optional(),
    encryption: z
      .enum(['none', 'psk', 'psk2', 'psk-mixed', 'sae', 'sae-mixed'])
      .optional(),
    key: z.string().min(1).max(64).optional(),
    hidden: z.boolean().optional(),
    disabled: z.boolean().optional(),
    isolate: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Нет изменений');

/**
 * Wi-Fi сети читаются и меняются через агент: панель не знает структуру
 * /etc/config/wireless и не хранит текущие пароли. Чтение отдаёт только
 * признак того, что пароль задан.
 */
export async function registerRouterWifiRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool } = ctx;

  app.post(
    '/api/v1/routers/:id/wifi/read',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const router = await getRouter(pool, auth, params.id);

      const job = await enqueueJob(pool, {
        type: 'wifi_read',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 90,
        maxAttempts: 1,
        payload: {},
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.wifi_read',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { job_id: job.id },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );

  app.put(
    '/api/v1/routers/:id/wifi/:iface',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z
        .object({ id: z.string().uuid(), iface: z.string().regex(IFACE_RE) })
        .parse(request.params);
      const changes = changesSchema.parse(request.body);
      const router = await getRouterForMutation(pool, auth, params.id);

      const job = await enqueueJob(pool, {
        type: 'wifi_update',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 240,
        maxAttempts: 1,
        payload: { iface: params.iface, changes },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.wifi_update',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          iface: params.iface,
          fields: Object.keys(changes),
          key_changed: typeof changes.key === 'string' && changes.key.length > 0,
          job_id: job.id,
        },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );
}
