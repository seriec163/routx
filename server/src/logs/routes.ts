import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireUser } from '../auth/service.js';
import { getRouterForBranch } from '../routers/service.js';

interface RouteContext {
  pool: Pool;
}

/**
 * Каталог логов и ошибок роутеров. Диагностика складывает сюда логи
 * Tachyon/sing-box, воркер — терминальные ошибки задач, а мониторинг
 * автоматически запускает диагностику при stopped/failed.
 */
export async function registerLogRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/router-logs', async (request) => {
    const auth = requireUser(request);
    const query = z
      .object({
        router_id: z.string().uuid().optional(),
        level: z.enum(['error', 'warn', 'info']).optional(),
        source: z.string().trim().max(80).optional(),
        before: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);

    if (query.router_id) {
      await getRouterForBranch(pool, auth, query.router_id);
    }

    const result = await pool.query<{
      id: string;
      router_id: string;
      router_name: string;
      source: string;
      level: string;
      message: string;
      context: unknown;
      created_at: Date;
    }>(
      `select l.id, l.router_id, r.name as router_name, l.source, l.level,
              l.message, l.context, l.created_at
         from router_logs l
         join routers r on r.id = l.router_id
        where ($1::uuid is null or l.router_id = $1)
          and ($2::text is null or l.level = $2)
          and ($3::text is null or l.source = $3)
          and ($4::timestamptz is null or l.created_at < $4)
          and (
                $5::boolean
                or r.owner_id = $6
                or ($7::boolean and r.owner_id in (select id from users where parent_id = $6))
              )
        order by l.created_at desc
        limit $8`,
      [
        query.router_id ?? null,
        query.level ?? null,
        query.source && query.source !== '' ? query.source : null,
        query.before ?? null,
        auth.role === 'superadmin',
        auth.userId,
        auth.role === 'admin',
        query.limit,
      ],
    );

    return { items: result.rows };
  });
}
