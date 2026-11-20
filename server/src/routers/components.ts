import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { badRequest } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { getRouterForMutation } from './service.js';

interface RouteContext {
  pool: Pool;
}

const COMPONENTS = ['tachyon', 'tachyon-core'] as const;

/**
 * Обновления самого Tachyon: LuCI-модуль и ядро tachyon-core.
 *
 * Используем штатный CLI Tachyon на роутере, поэтому панель и LuCI видят
 * одинаковые версии и один журнал операции. Проверка и обновление идут
 * отдельными задачами, чтобы долгая установка не блокировала опрос агента.
 */
export async function registerRouterComponentRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool } = ctx;

  app.post(
    '/api/v1/routers/bulk-update',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const body = z
        .object({
          router_ids: z.array(z.string().uuid()).min(1).max(100),
          targets: z
            .object({
              routx: z.boolean().default(false),
              tachyon: z.boolean().default(false),
              tachyon_core: z.boolean().default(false),
            })
            .strict()
            .refine(
              (value) => value.routx || value.tachyon || value.tachyon_core,
              'Выберите хотя бы один компонент',
            ),
        })
        .strict()
        .parse(request.body);

      const ids = [...new Set(body.router_ids)];
      const batchId = uuidv7();
      const jobs: Array<{ router_id: string; job_id: string }> = [];
      const skipped: Array<{ router_id: string; reason: string }> = [];

      for (const routerId of ids) {
        let router;
        try {
          router = await getRouterForMutation(pool, auth, routerId);
        } catch (error) {
          skipped.push({
            router_id: routerId,
            reason: error instanceof Error ? error.message : 'Роутер недоступен',
          });
          continue;
        }
        const knownNonTachyon =
          router.product !== 'tachyon' && router.product !== 'unknown';
        const targets = {
          routx: body.targets.routx,
          tachyon: body.targets.tachyon && !knownNonTachyon,
          tachyon_core: body.targets.tachyon_core && !knownNonTachyon,
        };
        if (!targets.routx && !targets.tachyon && !targets.tachyon_core) {
          skipped.push({
            router_id: routerId,
            reason: knownNonTachyon
              ? 'Компоненты Tachyon не применимы к этому продукту'
              : 'Не выбран ни один компонент',
          });
          continue;
        }

        const job = await enqueueJob(pool, {
          type: 'bulk_update',
          routerId: router.id,
          batchId,
          requestedBy: auth.userId,
          timeoutSeconds: 2400,
          maxAttempts: 1,
          payload: { targets },
        });
        jobs.push({ router_id: router.id, job_id: job.id });
      }

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.bulk_update',
        targetType: 'instance',
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          batch_id: batchId,
          targets: body.targets,
          routers: ids,
          jobs: jobs.map((item) => item.job_id),
          skipped,
        },
      });

      reply.code(202);
      return { batch_id: batchId, jobs, skipped };
    },
  );

  app.post('/api/v1/routers/:id/components/check', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouterForMutation(pool, auth, params.id);
    if (router.product !== 'tachyon') {
      throw badRequest('component_unsupported', 'Обновления компонентов доступны только для Tachyon');
    }

    const job = await enqueueJob(pool, {
      type: 'component_check',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 300,
      maxAttempts: 1,
      payload: {},
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.component_check',
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
  });

  app.post('/api/v1/routers/:id/components/:component/update', async (request, reply) => {
    const auth = requireUser(request);
    const params = z
      .object({ id: z.string().uuid(), component: z.enum(COMPONENTS) })
      .parse(request.params);
    const router = await getRouterForMutation(pool, auth, params.id);
    if (router.product !== 'tachyon') {
      throw badRequest('component_unsupported', 'Обновления компонентов доступны только для Tachyon');
    }

    const job = await enqueueJob(pool, {
      type: 'component_update',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 1200,
      maxAttempts: 1,
      payload: { component: params.component },
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.component_update',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { component: params.component, job_id: job.id },
    });

    reply.code(202);
    return { job: jobJson(job) };
  });
}
