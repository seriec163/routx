import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireUser } from '../auth/service.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { getJob, jobJson, requestCancel } from './queue.js';
import { audit } from '../audit.js';

interface RouteContext {
  pool: Pool;
}

export async function registerJobRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/jobs', async (request) => {
    const auth = requireUser(request);
    const query = z
      .object({
        router_id: z.string().uuid().optional(),
        status: z.enum(['queued', 'running', 'success', 'failed', 'cancelled', 'timeout']).optional(),
        type: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    const result = await pool.query(
      `select j.* from jobs j
        where ($1::uuid is null or j.router_id = $1)
          and ($2::text is null or j.status = $2)
          and ($3::text is null or j.type = $3)
          and (
            $4::boolean
            or j.requested_by = $5
            or j.router_id in (select id from routers where owner_id = $5)
          )
        order by j.created_at desc
        limit $6`,
      [
        query.router_id ?? null,
        query.status ?? null,
        query.type ?? null,
        auth.role === 'superadmin',
        auth.userId,
        query.limit,
      ],
    );

    return { items: result.rows.map((row) => jobJson(row)) };
  });

  app.get('/api/v1/jobs/:id', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = await getJob(pool, params.id);
    if (!job) throw notFound('Задача не найдена');

    if (auth.role !== 'superadmin') {
      const allowed =
        job.requested_by === auth.userId ||
        (job.router_id !== null &&
          (
            await pool.query('select 1 from routers where id = $1 and owner_id = $2', [
              job.router_id,
              auth.userId,
            ])
          ).rows[0]);
      if (!allowed) throw notFound('Задача не найдена');
    }

    return { job: jobJson(job) };
  });

  app.post('/api/v1/jobs/:id/cancel', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = await getJob(pool, params.id);
    if (!job) throw notFound('Задача не найдена');

    if (auth.role !== 'superadmin') {
      if (job.requested_by !== auth.userId) {
        const owned = job.router_id
          ? await pool.query('select 1 from routers where id = $1 and owner_id = $2', [
              job.router_id,
              auth.userId,
            ])
          : null;
        if (!owned?.rows[0]) throw forbidden('Нельзя отменить чужую задачу');
      }
    }

    await requestCancel(pool, job);
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'job.cancel',
      targetType: 'job',
      targetId: job.id,
      routerId: job.router_id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { type: job.type, status: job.status },
    });

    const refreshed = await getJob(pool, job.id);
    return { job: refreshed ? jobJson(refreshed) : null };
  });

  app.get('/api/v1/routers/:id/jobs', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const router = await pool.query<{ owner_id: string }>(
      'select owner_id from routers where id = $1',
      [params.id],
    );
    if (!router.rows[0]) throw notFound('Роутер не найден');
    if (auth.role !== 'superadmin' && router.rows[0].owner_id !== auth.userId) {
      throw notFound('Роутер не найден');
    }

    const result = await pool.query(
      `select * from jobs where router_id = $1 order by created_at desc limit 100`,
      [params.id],
    );
    return { items: result.rows.map((row) => jobJson(row)) };
  });

  void badRequest;
}
