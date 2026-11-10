import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { badRequest, notFound } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { assertOnline, getRouter } from '../routers/service.js';
import { loadSettings } from '../settings.js';

interface RouteContext {
  pool: Pool;
}

export async function registerDiagnosticsRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool } = ctx;

  app.post('/api/v1/diagnostics', async (request, reply) => {
    const auth = requireUser(request);
    const body = z
      .object({
        router_ids: z.array(z.string().uuid()).min(1).max(100),
        kind: z.enum(['quick', 'full']).default('quick'),
      })
      .strict()
      .parse(request.body);

    const settings = await loadSettings(pool);
    if (body.router_ids.length > settings.limits.batchSize) {
      throw badRequest(
        'batch_too_large',
        `Максимум ${settings.limits.batchSize} роутеров в одном пакете`,
      );
    }

    const batchId = uuidv7();
    const jobs = [];

    for (const routerId of [...new Set(body.router_ids)]) {
      const router = await getRouter(pool, auth, routerId);
      assertOnline(router);
      const job = await enqueueJob(pool, {
        type: 'diagnostics',
        routerId: router.id,
        requestedBy: auth.userId,
        batchId,
        timeoutSeconds: body.kind === 'full' ? 240 : 120,
        payload: { kind: body.kind },
      });
      jobs.push(jobJson(job));
    }

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'diagnostics.request',
      targetType: 'batch',
      targetId: batchId,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { kind: body.kind, routers: body.router_ids.length },
    });

    reply.code(202);
    return { batch_id: batchId, jobs };
  });

  app.get('/api/v1/diagnostics', async (request) => {
    const auth = requireUser(request);
    const query = z
      .object({
        router_id: z.string().uuid().optional(),
        kind: z.enum(['quick', 'full']).optional(),
        batch_id: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(request.query);

    const result = await pool.query(
      `select d.id, d.router_id, r.name as router_name, d.job_id, d.batch_id, d.kind,
              d.product, d.agent_version, d.sha256, d.size_bytes, d.created_at, d.expires_at
         from diagnostics_reports d join routers r on r.id = d.router_id
        where ($1::uuid is null or d.router_id = $1)
          and ($2::text is null or d.kind = $2)
          and ($3::uuid is null or d.batch_id = $3)
          and ($4::boolean or r.owner_id = $5)
        order by d.created_at desc limit $6`,
      [
        query.router_id ?? null,
        query.kind ?? null,
        query.batch_id ?? null,
        auth.role === 'superadmin',
        auth.userId,
        query.limit,
      ],
    );

    return { items: result.rows };
  });

  app.get('/api/v1/diagnostics/:id', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await loadReport(pool, auth, params.id);
    return {
      report: {
        id: row.id,
        router_id: row.router_id,
        router_name: row.router_name,
        kind: row.kind,
        product: row.product,
        agent_version: row.agent_version,
        sha256: row.sha256,
        size_bytes: row.size_bytes,
        created_at: row.created_at,
        expires_at: row.expires_at,
        payload: row.report,
        text: row.report_text,
      },
    };
  });

  app.get('/api/v1/diagnostics/:id/download', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await loadReport(pool, auth, params.id);

    const body =
      row.report_text ??
      ['RoutX — диагностический отчёт', JSON.stringify(row.report, null, 2)].join('\n\n');

    reply.type('text/plain; charset=utf-8');
    reply.header(
      'Content-Disposition',
      `attachment; filename="diagnostics-${row.router_name.replace(/[^A-Za-z0-9_.-]/g, '_')}-${row.id.slice(0, 8)}.txt"`,
    );
    return body;
  });

  app.delete('/api/v1/diagnostics/:id', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await loadReport(pool, auth, params.id);
    await pool.query('delete from diagnostics_reports where id = $1', [row.id]);
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'diagnostics.delete',
      targetType: 'diagnostics_report',
      targetId: row.id,
      routerId: row.router_id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    reply.code(204);
  });
}

interface ReportRow {
  id: string;
  router_id: string;
  router_name: string;
  job_id: string | null;
  batch_id: string | null;
  kind: string;
  product: string;
  agent_version: string | null;
  report: unknown;
  report_text: string | null;
  sha256: string;
  size_bytes: number;
  created_at: Date;
  expires_at: Date;
  owner_id?: string;
}

async function loadReport(
  pool: Pool,
  auth: { userId: string; role: 'superadmin' | 'admin' | 'user' },
  id: string,
): Promise<ReportRow> {
  const result = await pool.query<ReportRow>(
    `select d.*, r.name as router_name, r.owner_id
       from diagnostics_reports d join routers r on r.id = d.router_id
      where d.id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw notFound('Отчёт не найден');
  if (auth.role !== 'superadmin' && row.owner_id !== auth.userId) {
    throw notFound('Отчёт не найден');
  }
  if (row.expires_at.getTime() < Date.now()) {
    throw notFound('Срок хранения отчёта истёк');
  }
  return row;
}
