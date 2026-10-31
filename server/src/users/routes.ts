import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireSuperadmin } from '../auth/service.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { loadSettings } from '../settings.js';
import { userJson } from '../auth/routes.js';

interface RouteContext {
  pool: Pool;
  publicUrl: string;
}

const INVITE_TTL_HOURS = 7 * 24;

export async function registerUserRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/users', async (request) => {
    requireSuperadmin(request);
    const query = z
      .object({
        include_suspended: z.enum(['true', 'false']).optional(),
        include_archived: z.enum(['true', 'false']).optional(),
      })
      .parse(request.query);

    const result = await pool.query(
      `select u.id, u.email, u.role, u.status, u.totp_enabled,
              u.first_name, u.middle_name, u.last_name, u.created_at, u.last_login_at,
              u.archived_at,
              (select count(*)::int from routers r where r.owner_id = u.id and r.archived_at is null) as router_count
         from users u
        where ($1::boolean or u.status = 'active')
          and ($2::boolean or u.archived_at is null)
        order by u.created_at asc`,
      [query.include_suspended === 'true', query.include_archived === 'true'],
    );
    return { items: result.rows.map((row) => ({ ...userJson(row), router_count: row.router_count })) };
  });

  app.get('/api/v1/users/:id', async (request) => {
    requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `select id, email, role, status, totp_enabled,
              first_name, middle_name, last_name, created_at, last_login_at, archived_at
         from users where id = $1`,
      [params.id],
    );
    if (!result.rows[0]) throw notFound('Пользователь не найден');
    return { user: userJson(result.rows[0]) };
  });

  app.patch('/api/v1/users/:id', async (request) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        role: z.enum(['superadmin', 'user']).optional(),
        status: z.enum(['active', 'suspended']).optional(),
        first_name: z.string().trim().max(100).nullable().optional(),
        middle_name: z.string().trim().max(100).nullable().optional(),
        last_name: z.string().trim().max(100).nullable().optional(),
      })
      .strict()
      .parse(request.body);

    const target = await pool.query<{
      id: string;
      role: string;
      status: string;
      email: string;
      archived_at: Date | null;
    }>(
      'select id, role, status, email, archived_at from users where id = $1',
      [params.id],
    );
    const user = target.rows[0];
    if (!user) throw notFound('Пользователь не найден');
    if (user.archived_at && (body.role !== undefined || body.status !== undefined)) {
      throw conflict(
        'user_archived',
        'Пользователь в архиве. Сначала восстановите его, затем меняйте роль или статус.',
      );
    }

    const demotesSuperadmin = user.role === 'superadmin' && body.role === 'user';
    const suspendsSuperadmin = user.role === 'superadmin' && body.status === 'suspended';
    if ((demotesSuperadmin || suspendsSuperadmin) && user.id === auth.userId) {
      throw conflict('self_lockout', 'Нельзя понизить или заблокировать собственную учётную запись');
    }
    if (demotesSuperadmin || suspendsSuperadmin) {
      const activeAdmins = await pool.query<{ count: string }>(
        `select count(*)::text as count from users
          where role = 'superadmin' and status = 'active' and archived_at is null`,
      );
      if (Number(activeAdmins.rows[0]?.count ?? 0) <= 1) {
        throw conflict('last_superadmin', 'Нельзя оставить инстанс без активного суперадминистратора');
      }
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    if (body.role !== undefined) {
      values.push(body.role);
      sets.push(`role = $${values.length}`);
    }
    if (body.status !== undefined) {
      values.push(body.status);
      sets.push(`status = $${values.length}`);
    }
    for (const [field, value] of [
      ['first_name', body.first_name],
      ['middle_name', body.middle_name],
      ['last_name', body.last_name],
    ] as const) {
      if (value !== undefined) {
        values.push(value);
        sets.push(`${field} = $${values.length}`);
      }
    }
    sets.push('updated_at = now()');
    values.push(params.id);

    const updated = await pool.query(
      `update users set ${sets.join(', ')}
        where id = $${values.length}
        returning id, email, role, status, totp_enabled,
                  first_name, middle_name, last_name, created_at, last_login_at, archived_at`,
      values,
    );

    if (body.status === 'suspended') {
      await pool.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [
        params.id,
      ]);
    }

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'user.update',
      targetType: 'user',
      targetId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { before: { role: user.role, status: user.status }, after: body },
    });

    return { user: userJson(updated.rows[0]) };
  });

  app.post('/api/v1/users/:id/revoke-sessions', async (request) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      'update sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
      [params.id],
    );
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'user.revoke_sessions',
      targetType: 'user',
      targetId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { sessions: result.rowCount ?? 0 },
    });
    return { revoked: result.rowCount ?? 0 };
  });

  app.post('/api/v1/users/:id/archive', async (request) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const target = await pool.query<{
      id: string;
      role: string;
      status: string;
      email: string;
      archived_at: Date | null;
    }>('select id, role, status, email, archived_at from users where id = $1', [params.id]);
    const user = target.rows[0];
    if (!user) throw notFound('Пользователь не найден');
    if (user.id === auth.userId) {
      throw conflict('self_lockout', 'Нельзя архивировать собственную учётную запись');
    }
    if (user.archived_at) throw conflict('already_archived', 'Пользователь уже в архиве');
    if (user.role === 'superadmin' && user.status === 'active') {
      const activeAdmins = await pool.query<{ count: string }>(
        `select count(*)::text as count from users
          where role = 'superadmin' and status = 'active' and archived_at is null`,
      );
      if (Number(activeAdmins.rows[0]?.count ?? 0) <= 1) {
        throw conflict('last_superadmin', 'Нельзя оставить инстанс без активного суперадминистратора');
      }
    }

    await pool.query(
      `update users set archived_at = now(), status = 'suspended', updated_at = now()
        where id = $1`,
      [params.id],
    );
    await pool.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [
      params.id,
    ]);
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'user.archive',
      targetType: 'user',
      targetId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { email: user.email },
    });
    return { ok: true };
  });

  app.post('/api/v1/users/:id/restore', async (request) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const target = await pool.query<{
      id: string;
      email: string;
      archived_at: Date | null;
    }>('select id, email, archived_at from users where id = $1', [params.id]);
    const user = target.rows[0];
    if (!user) throw notFound('Пользователь не найден');
    if (!user.archived_at) throw conflict('not_archived', 'Пользователь не находится в архиве');

    const settings = await loadSettings(pool);
    const active = await pool.query<{ count: string }>(
      'select count(*)::text as count from users where archived_at is null',
    );
    if (Number(active.rows[0]?.count ?? 0) >= settings.limits.usersPerInstance) {
      throw conflict(
        'limit_reached',
        `Достигнут лимит учётных записей на сервере (${settings.limits.usersPerInstance}).`,
      );
    }

    await pool.query(
      `update users set archived_at = null, status = 'active', updated_at = now()
        where id = $1`,
      [params.id],
    );
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'user.restore',
      targetType: 'user',
      targetId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { email: user.email },
    });
    return { ok: true };
  });

  app.delete('/api/v1/users/:id', async (request, reply) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const target = await pool.query<{
      id: string;
      role: string;
      status: string;
      email: string;
      archived_at: Date | null;
    }>('select id, role, status, email, archived_at from users where id = $1', [params.id]);
    const user = target.rows[0];
    if (!user) throw notFound('Пользователь не найден');
    if (user.id === auth.userId) {
      throw conflict('self_lockout', 'Нельзя удалить собственную учётную запись');
    }
    if (user.role === 'superadmin' && user.status === 'active') {
      const activeAdmins = await pool.query<{ count: string }>(
        `select count(*)::text as count from users
          where role = 'superadmin' and status = 'active' and archived_at is null`,
      );
      if (Number(activeAdmins.rows[0]?.count ?? 0) <= 1) {
        throw conflict('last_superadmin', 'Нельзя оставить инстанс без активного суперадминистратора');
      }
    }

    const owned = await pool.query<{ has_data: boolean }>(
      `select (
         exists (select 1 from routers where owner_id = $1)
         or exists (select 1 from templates where owner_id = $1)
         or exists (select 1 from subscriptions where owner_id = $1)
         or exists (select 1 from invites where created_by = $1)
       ) as has_data`,
      [params.id],
    );
    if (owned.rows[0]?.has_data) {
      throw conflict(
        'user_has_data',
        'У пользователя есть роутеры, шаблоны, подписки или приглашения. Архивируйте его, чтобы сохранить историю.',
      );
    }

    try {
      await pool.query('delete from users where id = $1', [params.id]);
    } catch (error) {
      if ((error as { code?: string }).code === '23503') {
        throw conflict(
          'user_has_references',
          'Пользователь связан с другими записями. Архивируйте его вместо удаления.',
        );
      }
      throw error;
    }

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'user.delete',
      targetType: 'user',
      targetId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { email: user.email },
    });
    reply.code(204);
  });

  app.post('/api/v1/users/:id/password-reset', async (request) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);

    const target = await pool.query<{ id: string; email: string }>(
      'select id, email from users where id = $1',
      [params.id],
    );
    const user = target.rows[0];
    if (!user) throw notFound('Пользователь не найден');

    // Старые неиспользованные ссылки перестают действовать.
    await pool.query(
      'update password_resets set used_at = now() where user_id = $1 and used_at is null',
      [user.id],
    );

    const token = randomToken(32);
    const id = uuidv7();
    const result = await pool.query<{ expires_at: Date }>(
      `insert into password_resets (id, user_id, token_hash, created_by, expires_at)
       values ($1,$2,$3,$4, now() + interval '1 hour')
       returning expires_at`,
      [id, user.id, sha256Hex(token), auth.userId],
    );

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'user.password_reset_create',
      targetType: 'user',
      targetId: user.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { email: user.email },
    });

    return {
      reset: {
        url: `${ctx.publicUrl}/#/reset-password/${encodeURIComponent(token)}`,
        expires_at: result.rows[0]!.expires_at.toISOString(),
      },
      user: { email: user.email },
    };
  });

  app.post('/api/v1/invites', async (request, reply) => {
    const auth = requireSuperadmin(request);
    const body = z
      .object({
        role: z.enum(['superadmin', 'user']).default('user'),
        email: z.string().trim().toLowerCase().email().max(254).optional(),
      })
      .strict()
      .parse(request.body ?? {});

    const settings = await loadSettings(pool);
    const total = await pool.query<{ count: string }>(
      'select count(*)::text as count from users where archived_at is null',
    );
    const open = await pool.query<{ count: string }>(
      'select count(*)::text as count from invites where used_at is null and expires_at > now()',
    );
    if (Number(total.rows[0]?.count ?? 0) + Number(open.rows[0]?.count ?? 0) >= settings.limits.usersPerInstance) {
      throw badRequest(
        'limit_reached',
        `Достигнут лимит учётных записей на сервере (${settings.limits.usersPerInstance}), включая открытые приглашения. Удалите неиспользуемые аккаунты или приглашения.`,
      );
    }

    if (body.email) {
      const existing = await pool.query('select 1 from users where email = $1', [body.email]);
      if (existing.rows[0]) throw conflict('email_taken', 'Пользователь с таким e-mail уже существует');
    }

    const token = randomToken(32);
    const id = uuidv7();
    const result = await pool.query<{ expires_at: Date }>(
      `insert into invites (id, token_hash, created_by, role, email, expires_at)
       values ($1,$2,$3,$4,$5, now() + ($6 || ' hours')::interval)
       returning expires_at`,
      [id, sha256Hex(token), auth.userId, body.role, body.email ?? null, INVITE_TTL_HOURS],
    );

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'invite.create',
      targetType: 'invite',
      targetId: id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { role: body.role, email_bound: Boolean(body.email) },
    });

    reply.code(201);
    return {
      invite: {
        id,
        role: body.role,
        email: body.email ?? null,
        expires_at: result.rows[0]!.expires_at.toISOString(),
        url: `${ctx.publicUrl}/#/invite/${encodeURIComponent(token)}`,
        token,
      },
      warning: 'Ссылка показывается один раз. Передайте её пользователю по защищённому каналу.',
    };
  });

  app.get('/api/v1/invites', async (request) => {
    requireSuperadmin(request);
    const result = await pool.query(
      `select i.id, i.role, i.email, i.expires_at, i.used_at, i.created_at,
              u.email as created_by_email, ub.email as used_by_email
         from invites i
         left join users u on u.id = i.created_by
         left join users ub on ub.id = i.used_by
        order by i.created_at desc limit 100`,
    );
    return { items: result.rows };
  });

  app.delete('/api/v1/invites/:id', async (request, reply) => {
    const auth = requireSuperadmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `update invites set expires_at = now() where id = $1 and used_at is null`,
      [params.id],
    );
    if ((result.rowCount ?? 0) === 0) throw notFound('Активное приглашение не найдено');
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'invite.revoke',
      targetType: 'invite',
      targetId: params.id,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    reply.code(204);
  });
}
