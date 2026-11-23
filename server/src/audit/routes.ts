import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireSuperadmin, requireUser } from '../auth/service.js';
import { badRequest, notFound } from '../lib/errors.js';
import { notify } from '../notifications.js';

interface RouteContext {
  pool: Pool;
}

export async function registerAuditRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/audit', async (request) => {
    requireSuperadmin(request);
    const query = z
      .object({
        actor_id: z.string().uuid().optional(),
        router_id: z.string().uuid().optional(),
        action: z.string().max(80).optional(),
        result: z.enum(['ok', 'denied', 'error']).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const result = await pool.query(
      `select a.id, a.at, a.actor_id, u.email as actor_email, a.actor_role, a.action,
              a.target_type, a.target_id, a.router_id, a.ip, a.result, a.code, a.metadata
         from audit_log a left join users u on u.id = a.actor_id
        where ($1::uuid is null or a.actor_id = $1)
          and ($2::uuid is null or a.router_id = $2)
          and ($3::text is null or a.action like $3 || '%')
          and ($4::text is null or a.result = $4)
          and ($5::timestamptz is null or a.at >= $5)
          and ($6::timestamptz is null or a.at <= $6)
        order by a.at desc
        limit $7 offset $8`,
      [
        query.actor_id ?? null,
        query.router_id ?? null,
        query.action ?? null,
        query.result ?? null,
        query.from ?? null,
        query.to ?? null,
        query.limit,
        query.offset,
      ],
    );

    return { items: result.rows, limit: query.limit, offset: query.offset };
  });

  app.get('/api/v1/audit/export.csv', async (request, reply) => {
    requireSuperadmin(request);
    const result = await pool.query(
      `select a.at, u.email as actor, a.actor_role, a.action, a.target_type, a.target_id,
              a.router_id, a.ip, a.result, a.code
         from audit_log a left join users u on u.id = a.actor_id
        order by a.at desc limit 5000`,
    );

    const header = 'at,actor,role,action,target_type,target_id,router_id,ip,result,code';
    const rows = result.rows.map((row) =>
      [
        row.at instanceof Date ? row.at.toISOString() : row.at,
        row.actor,
        row.actor_role,
        row.action,
        row.target_type,
        row.target_id,
        row.router_id,
        row.ip,
        row.result,
        row.code,
      ]
        .map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`)
        .join(','),
    );

    reply.type('text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="router-control-audit.csv"');
    return [header, ...rows].join('\n');
  });

  app.get('/api/v1/notifications', async (request) => {
    const auth = requireUser(request);
    const query = z
      .object({
        unread_only: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    const result = await pool.query(
      `select n.id, n.router_id, r.name as router_name, n.kind, n.severity, n.message,
              n.created_at, n.read_at
         from notifications n left join routers r on r.id = n.router_id
        where n.user_id = $1
          and ($2::boolean or n.read_at is null)
        order by n.created_at desc limit $3`,
      [auth.userId, query.unread_only === 'true', query.limit],
    );

    const unread = await pool.query<{ count: string }>(
      'select count(*)::text as count from notifications where user_id = $1 and read_at is null',
      [auth.userId],
    );

    return { items: result.rows, unread: Number(unread.rows[0]?.count ?? 0) };
  });

  app.post(
    '/api/v1/notifications/send',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const auth = requireSuperadmin(request);
      const body = z
        .object({
          message: z.string().trim().min(1).max(500),
          user_ids: z.array(z.string().uuid()).max(100).optional(),
          all: z.boolean().optional(),
          severity: z.enum(['info', 'warning', 'critical']).default('info'),
        })
        .strict()
        .parse(request.body ?? {});

      let result;
      if (body.all) {
        result = await pool.query<{ id: string }>(
          `select id from users
            where status = 'active' and archived_at is null
            order by created_at asc`,
        );
      } else {
        if (!body.user_ids || body.user_ids.length === 0) {
          throw badRequest('no_recipients', 'Выберите получателей сообщения');
        }
        result = await pool.query<{ id: string }>(
          `select id from users
            where id = any($1::uuid[]) and status = 'active' and archived_at is null`,
          [body.user_ids],
        );
      }

      if (result.rows.length === 0) {
        throw badRequest('no_recipients', 'Нет активных получателей');
      }

      for (const row of result.rows) {
        await notify(pool, {
          userId: row.id,
          kind: 'admin.message',
          severity: body.severity,
          message: body.message,
        });
      }

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'notification.admin_message',
        targetType: 'notification',
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          recipients: result.rows.length,
          severity: body.severity,
          broadcast: body.all === true,
        },
      });

      return { sent: result.rows.length };
    },
  );

  app.post('/api/v1/notifications/read', async (request) => {
    const auth = requireUser(request);
    const body = z
      .object({ ids: z.array(z.coerce.number().int().positive()).max(200).optional(), all: z.boolean().optional() })
      .strict()
      .parse(request.body ?? {});

    if (body.all) {
      const result = await pool.query(
        'update notifications set read_at = now() where user_id = $1 and read_at is null',
        [auth.userId],
      );
      return { updated: result.rowCount ?? 0 };
    }

    if (!body.ids || body.ids.length === 0) return { updated: 0 };
    const result = await pool.query(
      `update notifications set read_at = now()
        where user_id = $1 and id = any($2::bigint[]) and read_at is null`,
      [auth.userId, body.ids],
    );
    return { updated: result.rowCount ?? 0 };
  });

  app.delete('/api/v1/notifications/:id', async (request, reply) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const result = await pool.query('delete from notifications where id = $1 and user_id = $2', [
      params.id,
      auth.userId,
    ]);
    if ((result.rowCount ?? 0) === 0) throw notFound('Уведомление не найдено');
    reply.code(204);
  });
}
