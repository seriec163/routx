import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { randomBase32, sha256 } from '../lib/crypto.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../lib/password.js';
import { loadSettings } from '../settings.js';
import {
  clearDeviceCookie,
  createSession,
  isMfaRequired,
  requireUser,
  setSessionCookies,
} from './service.js';
import { userJson } from './routes.js';

interface RouteContext {
  pool: Pool;
  secureCookie: boolean;
}

const newPasswordSchema = z.string().min(12).max(256);

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatRecoveryCode(raw: string): string {
  return raw.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

export function generateRecoveryCodes(): string[] {
  // 10 байт → 16 символов base32, 80 бит энтропии на код.
  return Array.from({ length: 10 }, () => formatRecoveryCode(randomBase32(10)));
}

interface RecoveryUserRow {
  id: string;
  email: string;
  role: 'superadmin' | 'admin' | 'user';
  status: string;
  totp_enabled: boolean;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  parent_id: string | null;
  created_at: Date;
  last_login_at: Date | null;
  archived_at: Date | null;
}

/**
 * Резервные коды дают полное восстановление: новый пароль, отключение TOTP
 * и удаление всех passkey. Код одноразовый, в базе хранится только хэш.
 */
export async function registerRecoveryRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/auth/recovery-codes', async (request) => {
    const auth = requireUser(request);
    const result = await pool.query<{ remaining: string; created_at: Date | null }>(
      `select count(*) filter (where used_at is null)::text as remaining,
              max(created_at) as created_at
         from recovery_codes
        where user_id = $1`,
      [auth.userId],
    );
    const row = result.rows[0];
    return {
      remaining: Number(row?.remaining ?? 0),
      created_at: row?.created_at ?? null,
    };
  });

  app.post(
    '/api/v1/auth/recovery-codes',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request) => {
      const auth = requireUser(request);
      const body = z
        .object({ password: z.string().min(1).max(256) })
        .strict()
        .parse(request.body);

      const current = await pool.query<{ status: string; password_hash: string }>(
        'select status, password_hash from users where id = $1',
        [auth.userId],
      );
      const user = current.rows[0];
      if (!user || user.status !== 'active') throw unauthorized();
      if (!(await verifyPassword(user.password_hash, body.password))) {
        throw unauthorized('Текущий пароль неверен');
      }

      const codes = generateRecoveryCodes();
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('delete from recovery_codes where user_id = $1', [auth.userId]);
        for (const code of codes) {
          await client.query(
            `insert into recovery_codes (id, user_id, code_hash)
             values ($1, $2, $3)`,
            [uuidv7(), auth.userId, sha256(normalizeRecoveryCode(code))],
          );
        }
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'auth.recovery_codes_create',
        targetType: 'user',
        targetId: auth.userId,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { count: codes.length },
      });

      return { codes, created_at: new Date().toISOString() };
    },
  );

  app.post(
    '/api/v1/auth/recovery/use',
    {
      config: {
        public: true,
        csrfExempt: true,
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const body = z
        .object({ code: z.string().trim().min(8).max(64), password: newPasswordSchema })
        .strict()
        .parse(request.body);
      const policy = checkPasswordPolicy(body.password);
      if (!policy.ok) {
        throw badRequest('weak_password', policy.message ?? 'Слабый пароль');
      }

      const passwordHash = await hashPassword(body.password);
      const client = await pool.connect();
      let user: RecoveryUserRow | null = null;
      let codeId: string | null = null;
      try {
        await client.query('begin');
        const codeResult = await client.query<{ id: string; user_id: string }>(
          `select id, user_id
             from recovery_codes
            where code_hash = $1 and used_at is null
            for update`,
          [sha256(normalizeRecoveryCode(body.code))],
        );
        const code = codeResult.rows[0];
        if (!code) {
          throw badRequest('invalid_recovery_code', 'Код не найден или уже использован');
        }

        const userResult = await client.query<RecoveryUserRow>(
          `select id, email, role, status, totp_enabled,
                  first_name, middle_name, last_name, parent_id,
                  created_at, last_login_at, archived_at
             from users where id = $1
             for update`,
          [code.user_id],
        );
        const found = userResult.rows[0];
        if (!found || found.status !== 'active' || found.archived_at) {
          throw badRequest('invalid_recovery_code', 'Код не найден или уже использован');
        }
        user = found;
        codeId = code.id;

        await client.query(
          `update users
              set password_hash = $2,
                  failed_logins = 0, locked_until = null,
                  totp_enabled = false, totp_secret_enc = null,
                  totp_confirmed_at = null, totp_last_step = null,
                  updated_at = now()
            where id = $1`,
          [user.id, passwordHash],
        );
        await client.query('update recovery_codes set used_at = now() where id = $1', [code.id]);
        await client.query('delete from webauthn_credentials where user_id = $1', [user.id]);
        await client.query(
          'update sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
          [user.id],
        );
        await client.query(
          `update mobile_devices
              set revoked_at = now(), revoked_by = 'recovery_code', device_token_hash = null
            where user_id = $1 and revoked_at is null`,
          [user.id],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      if (!user) throw badRequest('invalid_recovery_code', 'Код не найден или уже использован');
      user.totp_enabled = false;

      const settings = await loadSettings(pool);
      const session = await createSession(pool, {
        userId: user.id,
        // Резервный код — сильный одноразовый фактор; сессия сразу активна,
        // но панель попросит заново настроить TOTP.
        mfaPassed: true,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        days: settings.sessionDays,
      });
      setSessionCookies(reply, session, {
        secure: ctx.secureCookie,
        days: settings.sessionDays,
      });
      clearDeviceCookie(reply, ctx.secureCookie);

      await audit(pool, {
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.recovery_code_used',
        targetType: 'user',
        targetId: user.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { code_id: codeId, session: session.id, passkeys_deleted: true },
      });

      return {
        user: userJson(user),
        csrf_token: session.csrf,
        mfa_policy: settings.mfaPolicy,
        enrollment_required: isMfaRequired(settings, user.role),
      };
    },
  );
}
