import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { badRequest } from '../lib/errors.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { assertOnline, getRouterForMutation } from './service.js';

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

  app.post('/api/v1/routers/:id/components/check', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await getRouterForMutation(pool, auth, params.id);
    assertOnline(router);
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
    assertOnline(router);
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
