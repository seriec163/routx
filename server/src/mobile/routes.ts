import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { createSession, setSessionCookies } from '../auth/service.js';
import { userJson } from '../auth/routes.js';
import { sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { loadSettings } from '../settings.js';

interface RouteContext {
  pool: Pool;
  secureCookie: boolean;
}

/**
 * Обмен одноразового токена на обычную сессию.
 *
 * Ссылку и QR создаёт сам роутер (LuCI → Службы → JanusNew) и отдаёт её
 * только локально, поэтому панель Router Control таких ссылок не выпускает.
 * Токен живёт 5 минут, используется один раз и хранится в виде SHA-256.
 */
export async function registerMobileRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool } = ctx;

  app.post(
    '/api/v1/mobile/exchange',
    {
      config: {
        public: true,
        csrfExempt: true,
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const body = z
        .object({ token: z.string().trim().min(20).max(200) })
        .strict()
        .parse(request.body);

      // Одноразовый обмен: строка помечается использованной атомарно.
      const result = await pool.query<{ id: string; user_id: string; router_id: string }>(
        `update mobile_tokens
            set used_at = now()
          where token_hash = $1
            and used_at is null
            and expires_at > now()
          returning id, user_id, router_id`,
        [sha256(body.token)],
      );
      const row = result.rows[0];
      if (!row) {
        await audit(pool, {
          action: 'auth.mobile_login',
          result: 'denied',
          code: 'mobile_token_invalid',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        throw unauthorized('Ссылка истекла или уже использована. Войдите в панель.');
      }

      const userResult = await pool.query<{
        id: string;
        email: string;
        role: 'superadmin' | 'user';
        status: string;
        totp_enabled: boolean;
        first_name: string | null;
        middle_name: string | null;
        last_name: string | null;
        created_at: Date;
        last_login_at: Date | null;
        archived_at: Date | null;
      }>(
        `select id, email, role, status, totp_enabled,
                first_name, middle_name, last_name, created_at, last_login_at, archived_at
           from users where id = $1`,
        [row.user_id],
      );
      const user = userResult.rows[0];
      if (!user || user.status !== 'active' || user.archived_at) {
        throw unauthorized('Учётная запись недоступна');
      }

      const settings = await loadSettings(pool);
      const session = await createSession(pool, {
        userId: user.id,
        // Токен выдан привязанным агентом роутера, то есть с самого устройства.
        mfaPassed: true,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        days: settings.sessionDays,
      });
      const requestOrigin = request.headers.origin;
      const secureCookie =
        ctx.secureCookie ||
        (typeof requestOrigin === 'string' && requestOrigin.startsWith('https://'));
      setSessionCookies(reply, session, {
        secure: secureCookie,
        days: settings.sessionDays,
      });

      await pool.query(
        'update users set last_login_at = now(), updated_at = now() where id = $1',
        [user.id],
      );
      await audit(pool, {
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.mobile_login',
        targetType: 'router',
        targetId: row.router_id,
        routerId: row.router_id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { token_id: row.id, session: session.id },
      });

      return {
        user: userJson({
          ...user,
          totp_enabled: user.totp_enabled,
        }),
        router_id: row.router_id,
        csrf_token: session.csrf,
        mfa_policy: settings.mfaPolicy,
      };
    },
  );
}
