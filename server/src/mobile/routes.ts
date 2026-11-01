import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import QRCode from 'qrcode';
import { z } from 'zod';
import { audit } from '../audit.js';
import { createSession, requireUser, setSessionCookies } from '../auth/service.js';
import { userJson } from '../auth/routes.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { getRouterForMutation } from '../routers/service.js';
import { loadSettings } from '../settings.js';

interface RouteContext {
  pool: Pool;
  publicUrl: string;
  secureCookie: boolean;
}

const MOBILE_TTL_SECONDS = 5 * 60;

/**
 * Мобильный вход по QR:
 *  - владелец создаёт одноразовую ссылку из панели;
 *  - телефон открывает /#/install?token=…, токен лежит во фрагменте URL
 *    и не попадает в логи сервера/Referer;
 *  - обмен токена создаёт обычную сессию и ставит cookie.
 */
export async function registerMobileRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool } = ctx;

  app.post(
    '/api/v1/routers/:id/mobile-token',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const router = await getRouterForMutation(pool, auth, params.id);

      const token = randomToken(32);
      const id = uuidv7();
      const expiresAt = new Date(Date.now() + MOBILE_TTL_SECONDS * 1000);

      // При повторной генерации старый QR перестаёт работать.
      await pool.query(
        `update mobile_tokens
            set used_at = now()
          where user_id = $1 and router_id = $2
            and used_at is null and expires_at > now()`,
        [auth.userId, router.id],
      );

      await pool.query(
        `insert into mobile_tokens (id, token_hash, user_id, router_id, expires_at)
         values ($1,$2,$3,$4,$5)`,
        [id, sha256(token), auth.userId, router.id, expiresAt],
      );

      const origin = request.headers.origin;
      const originBase =
        typeof origin === 'string' && /^https?:\/\//i.test(origin)
          ? origin.replace(/\/+$/, '')
          : '';
      const base = originBase || ctx.publicUrl.replace(/\/+$/, '');
      const url = `${base}/#/install?token=${encodeURIComponent(token)}&router=${encodeURIComponent(router.id)}`;
      const qr = await QRCode.toDataURL(url, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 420,
        color: { dark: '#07111f', light: '#ffffff' },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.mobile_token',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          token_id: id,
          expires_at: expiresAt.toISOString(),
          public_url_https: base.startsWith('https://'),
        },
      });

      return {
        id,
        token,
        url,
        qr_data_url: qr,
        expires_at: expiresAt.toISOString(),
        ttl_seconds: MOBILE_TTL_SECONDS,
        https: base.startsWith('https://'),
      };
    },
  );

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
        // Токен создан из уже прошедшей MFA сессии владельца и одноразовый.
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
