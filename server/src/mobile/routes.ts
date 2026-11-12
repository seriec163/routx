import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import {
  clearDeviceCookie,
  createSession,
  DEVICE_COOKIE,
  setDeviceCookie,
  setSessionCookies,
} from '../auth/service.js';
import { userJson } from '../auth/routes.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { loadSettings } from '../settings.js';
import { deviceLabel } from './device.js';

interface RouteContext {
  pool: Pool;
  secureCookie: boolean;
}

function secureCookieFor(ctx: RouteContext, origin: string | undefined): boolean {
  return ctx.secureCookie || (typeof origin === 'string' && origin.startsWith('https://'));
}

/**
 * Обмен одноразового токена на обычную сессию.
 *
 * Ссылку и QR создаёт сам роутер (LuCI → Службы → RoutX) и отдаёт её
 * только локально, поэтому панель RoutX таких ссылок не выпускает.
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
        .object({
          token: z.string().trim().min(20).max(200),
          // Идентификатор установленного приложения из localStorage.
          // По нему повторный скан в том же PWA переиспользует устройство.
          device_id: z.string().uuid().optional(),
        })
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
        role: 'superadmin' | 'admin' | 'user';
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
      const userAgent = request.headers['user-agent'] ?? null;
      const storedAgent = userAgent?.slice(0, 300) ?? null;
      const label = deviceLabel(userAgent);
      const clientDeviceId = body.device_id ?? null;
      const deviceToken = randomToken(32);

      // Старые отозванные устройства не должны занимать место в лимите.
      await pool.query(
        `delete from mobile_devices
          where router_id = $1
            and revoked_at is not null
            and revoked_at < now() - interval '30 days'`,
        [row.router_id],
      );

      let deviceId: string | null = null;
      if (clientDeviceId) {
        const existing = await pool.query<{ id: string }>(
          `select id from mobile_devices
            where router_id = $1 and user_id = $2
              and client_device_id = $3 and revoked_at is null`,
          [row.router_id, user.id, clientDeviceId],
        );
        deviceId = existing.rows[0]?.id ?? null;
      }

      if (deviceId) {
        // Повторный скан в том же приложении: обновляем устройство и
        // заменяем его прежние сессии одной новой.
        await pool.query(
          `update mobile_devices
              set name = $2, platform = $3, user_agent = $4, ip = $5,
                  last_seen_at = now(), device_token_hash = $6,
                  device_token_created_at = now(), device_token_last_used_at = null
            where id = $1`,
          [
            deviceId,
            label.name,
            label.platform,
            storedAgent,
            request.ip,
            sha256(deviceToken),
          ],
        );
        await pool.query(
          `update sessions set revoked_at = now()
            where mobile_device_id = $1 and revoked_at is null`,
          [deviceId],
        );
      } else {
        // Один роутер — ограниченное число авторизованных телефонов.
        // Удалять их можно только на самом роутере (LuCI → RoutX).
        const active = await pool.query<{ count: string }>(
          `select count(*)::text as count from mobile_devices
            where router_id = $1 and revoked_at is null`,
          [row.router_id],
        );
        if (Number(active.rows[0]?.count ?? 0) >= 50) {
          throw badRequest(
            'too_many_devices',
            'Слишком много авторизованных телефонов. Удалите лишние на роутере: LuCI → Служба → RoutX.',
          );
        }

        deviceId = uuidv7();
        await pool.query(
          `insert into mobile_devices
             (id, router_id, user_id, name, platform, user_agent, ip,
              client_device_id, device_token_hash, device_token_created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())`,
          [
            deviceId,
            row.router_id,
            user.id,
            label.name,
            label.platform,
            storedAgent,
            request.ip,
            clientDeviceId,
            sha256(deviceToken),
          ],
        );
      }

      const session = await createSession(pool, {
        userId: user.id,
        // Токен выдан привязанным агентом роутера, то есть с самого устройства.
        mfaPassed: true,
        ip: request.ip,
        userAgent,
        days: settings.sessionDays,
      });
      await pool.query('update sessions set mobile_device_id = $1 where id = $2', [
        deviceId,
        session.id,
      ]);
      const secureCookie = secureCookieFor(ctx, request.headers.origin);
      setSessionCookies(reply, session, {
        secure: secureCookie,
        days: settings.sessionDays,
      });
      setDeviceCookie(reply, deviceToken, { secure: secureCookie });

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
        metadata: { token_id: row.id, session: session.id, device_id: deviceId },
      });

      return {
        user: userJson({
          ...user,
          totp_enabled: user.totp_enabled,
        }),
        router_id: row.router_id,
        device: { id: deviceId, name: label.name },
        csrf_token: session.csrf,
        mfa_policy: settings.mfaPolicy,
      };
    },
  );

  /**
   * Прозрачное восстановление сессии по привязке устройства.
   * Работает, пока цела HttpOnly-cookie rc_device и устройство не отозвано
   * на роутере. После удаления PWA cookie исчезает — нужен новый QR.
   */
  app.post(
    '/api/v1/mobile/refresh',
    {
      config: {
        public: true,
        csrfExempt: true,
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const token = request.cookies[DEVICE_COOKIE];
      const secureCookie = secureCookieFor(ctx, request.headers.origin);
      if (typeof token !== 'string' || token.length < 20) {
        throw unauthorized('Устройство не привязано. Отсканируйте QR на роутере.');
      }

      const result = await pool.query<{
        device_id: string;
        device_name: string;
        router_id: string;
        router_name: string;
        id: string;
        email: string;
        role: 'superadmin' | 'admin' | 'user';
        status: string;
        totp_enabled: boolean;
        first_name: string | null;
        middle_name: string | null;
        last_name: string | null;
        created_at: Date;
        last_login_at: Date | null;
        archived_at: Date | null;
      }>(
        `select d.id as device_id, d.name as device_name,
                d.router_id, r.name as router_name,
                u.id, u.email, u.role, u.status, u.totp_enabled,
                u.first_name, u.middle_name, u.last_name,
                u.created_at, u.last_login_at, u.archived_at
           from mobile_devices d
           join users u on u.id = d.user_id
           join routers r on r.id = d.router_id
          where d.device_token_hash = $1
            and d.revoked_at is null
            and r.archived_at is null`,
        [sha256(token)],
      );
      const row = result.rows[0];
      if (!row || row.status !== 'active' || row.archived_at) {
        clearDeviceCookie(reply, secureCookie);
        throw unauthorized('Привязка устройства недействительна. Отсканируйте QR заново.');
      }

      const settings = await loadSettings(pool);
      const userAgent = request.headers['user-agent'] ?? null;
      const session = await createSession(pool, {
        userId: row.id,
        mfaPassed: true,
        ip: request.ip,
        userAgent,
        days: settings.sessionDays,
      });
      await pool.query('update sessions set mobile_device_id = $1 where id = $2', [
        row.device_id,
        session.id,
      ]);
      setSessionCookies(reply, session, {
        secure: secureCookie,
        days: settings.sessionDays,
      });
      setDeviceCookie(reply, token, { secure: secureCookie });
      await pool.query(
        `update mobile_devices
            set last_seen_at = now(), device_token_last_used_at = now()
          where id = $1`,
        [row.device_id],
      );
      await audit(pool, {
        actorId: row.id,
        actorRole: row.role,
        action: 'auth.mobile_refresh',
        targetType: 'router',
        targetId: row.router_id,
        routerId: row.router_id,
        result: 'ok',
        ip: request.ip,
        userAgent,
        metadata: { device_id: row.device_id, session: session.id },
      });

      return {
        user: userJson(row),
        router_id: row.router_id,
        router_name: row.router_name,
        device: { id: row.device_id, name: row.device_name },
        csrf_token: session.csrf,
        mfa_policy: settings.mfaPolicy,
      };
    },
  );
}
