import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import {
  IMPERSONATION_COOKIE,
  SESSION_COOKIE,
  canManageBranchUser,
  cookieOptions,
  createSession,
  requireManager,
  requireSuperadmin,
  setSessionCookies,
} from '../auth/service.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { loadSettings } from '../settings.js';
import { userJson } from '../auth/routes.js';

interface RouteContext {
  pool: Pool;
  publicUrl: string;
  secureCookie: boolean;
}

type Auth = NonNullable<FastifyRequest['auth']>;

/**
 * Полный отзыв доступа пользователя: сессии и долгоживущие привязки
 * телефонов. Без второго шага PWA восстановила бы сессию по rc_device.
 */
async function revokeUserDevices(pool: Pool, userId: string, by: string): Promise<void> {
  await pool.query(
    `update mobile_devices
        set revoked_at = now(), revoked_by = $2, device_token_hash = null
      where user_id = $1 and revoked_at is null`,
    [userId, by],
  );
}

interface ManagedUserRow {
  id: string;
  role: string;
  status: string;
  email: string;
  archived_at: Date | null;
  parent_id: string | null;
}

const INVITE_TTL_HOURS = 7 * 24;
const emailSchema = z.string().trim().toLowerCase().email().max(254);

function canManageTarget(auth: Auth, user: ManagedUserRow): boolean {
  return canManageBranchUser(auth.role, auth.userId, user);
}

async function loadTarget(pool: Pool, id: string): Promise<ManagedUserRow | null> {
  const result = await pool.query<ManagedUserRow>(
    'select id, role, status, email, archived_at, parent_id from users where id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}

function assertManageable(auth: Auth, user: ManagedUserRow): void {
  if (canManageTarget(auth, user)) return;
  throw forbidden('Действие доступно только для пользователей своей ветки');
}

export async function registerUserRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/users', async (request) => {
    const auth = requireManager(request);
    const query = z
      .object({
        include_suspended: z.enum(['true', 'false']).optional(),
        include_archived: z.enum(['true', 'false']).optional(),
      })
      .parse(request.query);

    const scope = auth.role === 'superadmin' ? null : auth.userId;
    const result = await pool.query(
      `select u.id, u.email, u.role, u.status, u.totp_enabled,
              u.first_name, u.middle_name, u.last_name, u.parent_id,
              p.email as parent_email,
              u.created_at, u.last_login_at, u.archived_at,
              (select count(*)::int from routers r where r.owner_id = u.id and r.archived_at is null) as router_count
         from users u
         left join users p on p.id = u.parent_id
        where ($1::uuid is null or u.id = $1 or u.parent_id = $1)
          and ($2::boolean or u.status = 'active')
          and ($3::boolean or u.archived_at is null)
        order by u.created_at asc`,
      [scope, query.include_suspended === 'true', query.include_archived === 'true'],
    );
    return { items: result.rows.map((row) => ({ ...userJson(row), router_count: row.router_count })) };
  });

  app.get('/api/v1/users/:id', async (request) => {
    const auth = requireManager(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `select id, email, role, status, totp_enabled,
              first_name, middle_name, last_name, parent_id, created_at, last_login_at, archived_at
         from users where id = $1`,
      [params.id],
    );
    const user = result.rows[0];
    if (!user) throw notFound('Пользователь не найден');
    if (auth.role !== 'superadmin' && user.id !== auth.userId) {
      assertManageable(auth, user as ManagedUserRow);
    }
    return { user: userJson(user) };
  });

  app.post(
    '/api/v1/users/:id/impersonate',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireSuperadmin(request);
      if (auth.impersonatedBy) {
        throw forbidden('Сначала вернитесь к своей учётной записи');
      }
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const result = await pool.query<{
        id: string;
        email: string;
        role: string;
        status: string;
        archived_at: Date | null;
      }>('select id, email, role, status, archived_at from users where id = $1', [params.id]);
      const target = result.rows[0];
      if (!target) throw notFound('Пользователь не найден');
      if (target.id === auth.userId) {
        throw badRequest('self_impersonation', 'Нельзя войти под собственной учётной записью');
      }
      if (target.archived_at || target.status !== 'active') {
        throw conflict(
          'user_inactive',
          'Пользователь заблокирован или в архиве. Сначала активируйте его.',
        );
      }

      const adminToken = request.cookies[SESSION_COOKIE];
      if (!adminToken) throw unauthorized();

      const settings = await loadSettings(pool);
      // Вход под пользователем ограничен двумя часами; вернуться можно
      // кнопкой в интерфейсе, пока жива исходная сессия суперадминистратора.
      const days = Math.min(settings.sessionDays, 2 / 24);
      const session = await createSession(pool, {
        userId: target.id,
        mfaPassed: true,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        days,
        impersonatedBy: auth.userId,
      });

      reply.setCookie(
        IMPERSONATION_COOKIE,
        adminToken,
        cookieOptions({ secure: ctx.secureCookie, days }),
      );
      setSessionCookies(reply, session, { secure: ctx.secureCookie, days });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'user.impersonate',
        targetType: 'user',
        targetId: target.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { email: target.email, role: target.role },
      });

      return {
        ok: true,
        user: { id: target.id, email: target.email, role: target.role },
        expires_at: session.expiresAt.toISOString(),
      };
    },
  );

  app.patch('/api/v1/users/:id', async (request) => {
    const auth = requireManager(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        email: emailSchema.optional(),
        role: z.enum(['superadmin', 'admin', 'user']).optional(),
        status: z.enum(['active', 'suspended']).optional(),
        first_name: z.string().trim().max(100).nullable().optional(),
        middle_name: z.string().trim().max(100).nullable().optional(),
        last_name: z.string().trim().max(100).nullable().optional(),
      })
      .strict()
      .parse(request.body);

    const user = await loadTarget(pool, params.id);
    if (!user) throw notFound('Пользователь не найден');

    if (auth.role === 'admin') {
      if (user.id === auth.userId) {
        if (body.role !== undefined || body.status !== undefined) {
          throw forbidden('Нельзя менять собственную роль или статус');
        }
      } else {
        assertManageable(auth, user);
        if (body.role !== undefined && body.role !== 'user') {
          throw forbidden('Администратор может назначать только роль «Пользователь»');
        }
      }
    }

    if (user.archived_at && (body.role !== undefined || body.status !== undefined)) {
      throw conflict(
        'user_archived',
        'Пользователь в архиве. Сначала восстановите его, затем меняйте роль или статус.',
      );
    }

    const demotesSuperadmin =
      user.role === 'superadmin' && body.role !== undefined && body.role !== 'superadmin';
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
    let emailChanged = false;
    if (body.email !== undefined && body.email !== user.email) {
      const taken = await pool.query('select 1 from users where email = $1 and id <> $2', [
        body.email,
        params.id,
      ]);
      if (taken.rows[0]) throw conflict('email_taken', 'Пользователь с таким e-mail уже существует');
      values.push(body.email);
      sets.push(`email = $${values.length}`);
      emailChanged = true;
    }
    if (body.role !== undefined) {
      values.push(body.role);
      sets.push(`role = $${values.length}`);
      if (body.role === 'admin' || body.role === 'superadmin') {
        // Администратор верхнего уровня не входит в чужую ветку.
        sets.push('parent_id = null');
      }
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

    const updated = await pool
      .query(
        `update users set ${sets.join(', ')}
        where id = $${values.length}
        returning id, email, role, status, totp_enabled,
                  first_name, middle_name, last_name, parent_id, created_at, last_login_at, archived_at`,
        values,
      )
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === '23505') {
          throw conflict('email_taken', 'Пользователь с таким e-mail уже существует');
        }
        throw error;
      });

    if (body.status === 'suspended') {
      await pool.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [
        params.id,
      ]);
      await revokeUserDevices(pool, params.id, 'user_suspended');
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
      metadata: {
        before: { email: user.email, role: user.role, status: user.status },
        after: { ...body, email_changed: emailChanged },
      },
    });

    return { user: userJson(updated.rows[0]) };
  });

  app.post('/api/v1/users/:id/revoke-sessions', async (request) => {
    const auth = requireManager(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const user = await loadTarget(pool, params.id);
    if (!user) throw notFound('Пользователь не найден');
    if (auth.role === 'admin' && user.id !== auth.userId) assertManageable(auth, user);
    const result = await pool.query(
      'update sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
      [params.id],
    );
    await revokeUserDevices(pool, params.id, 'admin_revoke_sessions');
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
    const auth = requireManager(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const user = await loadTarget(pool, params.id);
    if (!user) throw notFound('Пользователь не найден');
    if (user.id === auth.userId) {
      throw conflict('self_lockout', 'Нельзя архивировать собственную учётную запись');
    }
    if (auth.role === 'admin') assertManageable(auth, user);
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
    await revokeUserDevices(pool, params.id, 'user_archived');
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
    const auth = requireManager(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const user = await loadTarget(pool, params.id);
    if (!user) throw notFound('Пользователь не найден');
    if (auth.role === 'admin') assertManageable(auth, user);
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
    const auth = requireManager(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const user = await loadTarget(pool, params.id);
    if (!user) throw notFound('Пользователь не найден');
    if (user.id === auth.userId) {
      throw conflict('self_lockout', 'Нельзя удалить собственную учётную запись');
    }
    if (auth.role === 'admin') assertManageable(auth, user);
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
    const auth = requireManager(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ reset_mfa: z.boolean().optional().default(false) })
      .strict()
      .parse(request.body ?? {});

    const user = await loadTarget(pool, params.id);
    if (!user) throw notFound('Пользователь не найден');
    if (auth.role === 'admin' && user.id !== auth.userId) assertManageable(auth, user);

    // Старые неиспользованные ссылки перестают действовать.
    await pool.query(
      'update password_resets set used_at = now() where user_id = $1 and used_at is null',
      [user.id],
    );

    const token = randomToken(32);
    const id = uuidv7();
    const result = await pool.query<{ expires_at: Date }>(
      `insert into password_resets (id, user_id, token_hash, created_by, expires_at, reset_mfa)
       values ($1,$2,$3,$4, now() + interval '1 hour', $5)
       returning expires_at`,
      [id, user.id, sha256Hex(token), auth.userId, body.reset_mfa],
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
      metadata: { email: user.email, reset_mfa: body.reset_mfa },
    });

    return {
      reset: {
        url: `${ctx.publicUrl}/#/reset-password/${encodeURIComponent(token)}`,
        expires_at: result.rows[0]!.expires_at.toISOString(),
        reset_mfa: body.reset_mfa,
      },
      user: { email: user.email },
    };
  });

  app.post('/api/v1/invites', async (request, reply) => {
    const auth = requireManager(request);
    const body = z
      .object({
        role: z.enum(['superadmin', 'admin', 'user']).default('user'),
        email: z.string().trim().toLowerCase().email().max(254).optional(),
      })
      .strict()
      .parse(request.body ?? {});

    if (auth.role === 'admin' && body.role !== 'user') {
      throw forbidden('Администратор может приглашать только пользователей');
    }

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
    const auth = requireManager(request);
    const result = await pool.query(
      `select i.id, i.role, i.email, i.expires_at, i.used_at, i.created_at,
              u.email as created_by_email, ub.email as used_by_email
         from invites i
         left join users u on u.id = i.created_by
         left join users ub on ub.id = i.used_by
        where ($1::boolean or i.created_by = $2)
        order by i.created_at desc limit 100`,
      [auth.role === 'superadmin', auth.userId],
    );
    return { items: result.rows };
  });

  app.delete('/api/v1/invites/:id', async (request, reply) => {
    const auth = requireManager(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `update invites set expires_at = now()
        where id = $1 and used_at is null
          and ($2::boolean or created_by = $3)`,
      [params.id, auth.role === 'superadmin', auth.userId],
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
