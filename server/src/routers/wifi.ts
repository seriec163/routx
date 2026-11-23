import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { badRequest } from '../lib/errors.js';
import { encryptSecret } from '../lib/crypto.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { getRouter, getRouterForMutation } from './service.js';

interface RouteContext {
  pool: Pool;
  masterKey: string;
}

const IFACE_RE = /^[A-Za-z0-9_]{1,64}$/;
const KEY_ENCRYPTIONS = new Set(['psk', 'psk2', 'psk-mixed', 'sae', 'sae-mixed']);

const createSchema = z
  .object({
    ssid: z.string().trim().min(1).max(32),
    encryption: z.enum(['none', 'owe', 'psk', 'psk2', 'psk-mixed', 'sae', 'sae-mixed']),
    key: z.string().min(1).max(64).optional(),
    hidden: z.boolean().default(false),
    disabled: z.boolean().default(false),
    isolate: z.boolean().default(false),
    radios: z.array(z.string().regex(IFACE_RE)).max(8).optional(),
  })
  .strict();

const changesSchema = z
  .object({
    ssid: z.string().trim().min(1).max(32).optional(),
    encryption: z
      .enum(['none', 'owe', 'psk', 'psk2', 'psk-mixed', 'sae', 'sae-mixed'])
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
    '/api/v1/routers/:id/wifi',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = createSchema.parse(request.body);
      if (KEY_ENCRYPTIONS.has(body.encryption)) {
        if (!body.key) {
          throw badRequest('wifi_key_required', 'Для защищённой сети задайте пароль');
        }
        if (body.key.length < 8 && body.key.length !== 64) {
          throw badRequest(
            'wifi_key_invalid',
            'Пароль Wi-Fi должен быть от 8 до 63 символов или 64 hex',
          );
        }
      } else if (body.key) {
        throw badRequest('wifi_key_unexpected', 'Для открытой сети пароль не нужен');
      }
      const router = await getRouterForMutation(pool, auth, params.id);

      // Пароль не должен лежать в jobs.payload открытым текстом: шифруем его
      // мастер-ключом, расшифровываем только при отправке команды агенту.
      const payload: Record<string, unknown> = { ...body };
      if (body.key) {
        payload.key_enc = encryptSecret(body.key, ctx.masterKey);
        delete payload.key;
      }

      const job = await enqueueJob(pool, {
        type: 'wifi_create',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 600,
        maxAttempts: 1,
        payload,
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.wifi_create',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          ssid: body.ssid,
          encryption: body.encryption,
          fields: Object.keys(body),
          key_changed: typeof body.key === 'string' && body.key.length > 0,
          radios: body.radios ?? [],
          job_id: job.id,
        },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );

  app.delete(
    '/api/v1/routers/:id/wifi/:iface',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z
        .object({ id: z.string().uuid(), iface: z.string().regex(IFACE_RE) })
        .parse(request.params);
      const router = await getRouterForMutation(pool, auth, params.id);

      const job = await enqueueJob(pool, {
        type: 'wifi_delete',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 600,
        maxAttempts: 1,
        payload: { iface: params.iface },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.wifi_delete',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { iface: params.iface, job_id: job.id },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );

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
        timeoutSeconds: 600,
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

      const sealedChanges: Record<string, unknown> = { ...changes };
      if (changes.key) {
        sealedChanges.key_enc = encryptSecret(changes.key, ctx.masterKey);
        delete sealedChanges.key;
      }

      const job = await enqueueJob(pool, {
        type: 'wifi_update',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 600,
        maxAttempts: 1,
        payload: { iface: params.iface, changes: sealedChanges },
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
