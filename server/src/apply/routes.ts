import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import {
  assertOnline,
  getRouterForBranch,
  getRouterForBranchMutation,
} from '../routers/service.js';

interface RouteContext {
  pool: Pool;
}

export async function registerApplyRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/apply-runs', async (request) => {
    const auth = requireUser(request);
    const query = z
      .object({
        router_id: z.string().uuid().optional(),
        template_id: z.string().uuid().optional(),
        status: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    const result = await pool.query(
      `select a.*, r.name as router_name, u.email as requested_by_email
         from apply_runs a
         join routers r on r.id = a.router_id
         left join users u on u.id = a.requested_by
        where ($1::uuid is null or a.router_id = $1)
          and ($2::text is null or a.status = $2)
          and ($3::uuid is null or a.template_id = $3)
          and (
                $4::boolean
                or r.owner_id = $5
                or ($6::boolean and r.owner_id in (select id from users where parent_id = $5))
              )
        order by a.created_at desc
        limit $7`,
      [
        query.router_id ?? null,
        query.status ?? null,
        query.template_id ?? null,
        auth.role === 'superadmin',
        auth.userId,
        auth.role === 'admin',
        query.limit,
      ],
    );

    return { items: result.rows };
  });

  app.get('/api/v1/apply-runs/:id', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);

    const run = await pool.query(
      `select a.*, r.name as router_name, r.owner_id
         from apply_runs a join routers r on r.id = a.router_id
        where a.id = $1`,
      [params.id],
    );
    const row = run.rows[0];
    if (!row) throw notFound('Применение не найдено');
    if (auth.role !== 'superadmin' && row.owner_id !== auth.userId) {
      if (auth.role !== 'admin') throw notFound('Применение не найдено');
      const child = await pool.query(
        'select 1 from users where id = $1 and parent_id = $2',
        [row.owner_id, auth.userId],
      );
      if (!child.rows[0]) throw notFound('Применение не найдено');
    }

    const items = await pool.query(
      `select seq, op, path, value_before, value_after, result, error_code
         from apply_items where apply_run_id = $1 order by seq`,
      [params.id],
    );

    return { apply_run: row, items: items.rows };
  });

  app.post('/api/v1/apply-runs/:id/confirm', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ diff_hash: z.string().regex(/^[a-f0-9]{64}$/i) })
      .strict()
      .parse(request.body);

    const runResult = await pool.query<{
      id: string;
      router_id: string;
      status: string;
      diff_hash: string;
      diff: unknown;
      requested_by: string;
      created_at: Date;
    }>('select * from apply_runs where id = $1', [params.id]);
    const run = runResult.rows[0];
    if (!run) throw notFound('Применение не найдено');

    const router = await getRouterForBranchMutation(pool, auth, run.router_id);
    assertOnline(router);

    if (run.requested_by !== auth.userId && auth.role !== 'superadmin') {
      throw notFound('Применение не найдено');
    }
    if (run.status !== 'awaiting_confirmation') {
      throw conflict('apply_run_state', `Применение уже в состоянии «${run.status}»`);
    }
    if (Date.now() - run.created_at.getTime() > 60 * 60_000) {
      await pool.query(
        `update apply_runs set status = 'stale', finished_at = now() where id = $1`,
        [run.id],
      );
      throw conflict('diff_stale', 'Диff устарел (более часа). Запросите новый.');
    }
    if (run.diff_hash.toLowerCase() !== body.diff_hash.toLowerCase()) {
      throw conflict('diff_hash_mismatch', 'Хеш diff не совпадает: конфигурация изменилась');
    }

    const items = Array.isArray(run.diff) ? run.diff.length : 0;
    if (items === 0) {
      await pool.query(
        `update apply_runs set status = 'success', finished_at = now(),
                error_code = null, error_detail = 'Изменений нет'
          where id = $1`,
        [run.id],
      );
      return { applied: false, message: 'Различий нет, применение не требуется' };
    }

    const job = await enqueueJob(pool, {
      type: 'apply',
      routerId: run.router_id,
      requestedBy: auth.userId,
      timeoutSeconds: 600,
      idempotencyKey: `apply:${run.id}`,
      payload: { apply_run_id: run.id },
    });

    await pool.query(
      `update apply_runs set status = 'queued', confirmed_by = $2, confirmed_at = now()
        where id = $1 and status = 'awaiting_confirmation'`,
      [run.id, auth.userId],
    );

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'apply.confirm',
      targetType: 'apply_run',
      targetId: run.id,
      routerId: run.router_id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { diff_hash: run.diff_hash, items, job_id: job.id },
    });

    reply.code(202);
    return { job: jobJson(job), apply_run_id: run.id };
  });

  app.post('/api/v1/apply-runs/:id/cancel', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);

    const runResult = await pool.query<{ router_id: string; status: string; requested_by: string }>(
      'select router_id, status, requested_by from apply_runs where id = $1',
      [params.id],
    );
    const run = runResult.rows[0];
    if (!run) throw notFound('Применение не найдено');
    await getRouterForBranch(pool, auth, run.router_id);
    if (auth.role !== 'superadmin' && run.requested_by !== auth.userId) {
      throw notFound('Применение не найдено');
    }
    if (run.status !== 'awaiting_confirmation' && run.status !== 'queued') {
      throw conflict('apply_run_state', 'Можно отменить только ещё не начатое применение');
    }

    await pool.query(
      `update apply_runs set status = 'cancelled', finished_at = now() where id = $1`,
      [params.id],
    );
    await pool.query(
      `update jobs set status = 'cancelled', finished_at = now(), error_code = 'cancelled'
        where idempotency_key = $1 and status = 'queued'`,
      [`apply:${params.id}`],
    );

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'apply.cancel',
      targetType: 'apply_run',
      targetId: params.id,
      routerId: run.router_id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return { ok: true };
  });

  app.post('/api/v1/routers/:id/apply', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        template_id: z.string().uuid(),
        revision: z.coerce.number().int().positive().optional(),
      })
      .strict()
      .parse(request.body);

    const router = await getRouterForBranchMutation(pool, auth, params.id);
    assertOnline(router);

    const template = await pool.query<{
      owner_id: string;
      current_revision: number;
      shared: boolean;
    }>(
      'select owner_id, current_revision, shared from templates where id = $1 and archived_at is null',
      [body.template_id],
    );
    const tpl = template.rows[0];
    if (!tpl) throw notFound('Шаблон не найден');
    if (auth.role !== 'superadmin' && tpl.owner_id !== auth.userId && !tpl.shared) {
      throw notFound('Шаблон не найден');
    }

    const job = await enqueueJob(pool, {
      type: 'diff',
      routerId: router.id,
      requestedBy: auth.userId,
      timeoutSeconds: 120,
      payload: {
        template_id: body.template_id,
        revision: body.revision ?? tpl.current_revision,
      },
    });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'router.apply_prepare',
      targetType: 'router',
      targetId: router.id,
      routerId: router.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { template_id: body.template_id, job_id: job.id },
    });

    reply.code(202);
    return { job: jobJson(job) };
  });

  void badRequest;
}
