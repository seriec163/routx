import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../lib/crypto.js';
import { HttpError, badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../lib/password.js';
import { generateTotpSecret, provisioningUri, totpStep, verifyTotp } from '../lib/totp.js';
import { loadSettings } from '../settings.js';
import {
  CSRF_COOKIE,
  IMPERSONATION_COOKIE,
  MFA_TICKET_TTL_SECONDS,
  clearDeviceCookie,
  clearSessionCookies,
  consumeMfaTicket,
  createMfaTicket,
  createSession,
  isManagerRole,
  isMfaRequired,
  requireUser,
  resolveSession,
  revokeSession,
  rotateSessionCsrf,
  setSessionCookies,
  SESSION_COOKIE,
} from './service.js';

interface RouteContext {
  pool: Pool;
  masterKey: string;
  publicUrl: string;
  secureCookie: boolean;
  inviteTtlSeconds: number;
}

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(1).max(256);

const loginSchema = z.object({ email: emailSchema, password: passwordSchema }).strict();
const mfaSchema = z.object({ mfa_ticket: z.string().min(20).max(200), code: z.string().min(6).max(10) }).strict();
const acceptSchema = z
  .object({
    token: z.string().min(20).max(64),
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();
const passwordChangeSchema = z
  .object({ current_password: passwordSchema, new_password: passwordSchema })
  .strict();
const resetTokenSchema = z.string().min(20).max(64);
const resetPasswordSchema = z
  .object({ token: resetTokenSchema, password: passwordSchema })
  .strict();
const profileSchema = z
  .object({
    email: emailSchema.optional(),
    current_password: passwordSchema.optional(),
    first_name: z.string().trim().max(100).nullable().optional(),
    middle_name: z.string().trim().max(100).nullable().optional(),
    last_name: z.string().trim().max(100).nullable().optional(),
  })
  .strict();

let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomToken(24));
  return dummyHashPromise;
}

export function userJson(row: {
  id: string;
  email: string;
  role: string;
  totp_enabled: boolean;
  status: string;
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
  parent_id?: string | null;
  parent_email?: string | null;
  created_at?: Date;
  last_login_at?: Date | null;
  archived_at?: Date | null;
}) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    totp_enabled: row.totp_enabled,
    first_name: row.first_name ?? null,
    middle_name: row.middle_name ?? null,
    last_name: row.last_name ?? null,
    parent_id: row.parent_id ?? null,
    parent_email: row.parent_email ?? null,
    created_at: row.created_at?.toISOString(),
    last_login_at: row.last_login_at?.toISOString() ?? null,
    archived_at: row.archived_at?.toISOString() ?? null,
  };
}

export async function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const { pool } = ctx;

  app.post(
    '/api/v1/auth/login',
    { config: { public: true, csrfExempt: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const settings = await loadSettings(pool);

      const result = await pool.query<{
        id: string;
        email: string;
        password_hash: string;
        role: 'superadmin' | 'admin' | 'user';
        status: string;
        totp_enabled: boolean;
        totp_secret_enc: string | null;
        totp_last_step: string | null;
        failed_logins: number;
        locked_until: Date | null;
      }>('select * from users where email = $1', [body.email]);

      const user = result.rows[0];

      if (!user) {
        await verifyPassword(await dummyHash(), body.password);
        await audit(pool, {
          action: 'auth.login',
          result: 'denied',
          code: 'invalid_credentials',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { email: body.email },
        });
        throw unauthorized('Неверный e-mail или пароль');
      }

      if (user.status !== 'active') {
        await audit(pool, {
          actorId: user.id,
          actorRole: user.role,
          action: 'auth.login',
          result: 'denied',
          code: 'suspended',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        throw forbidden('Учётная запись приостановлена');
      }

      if (user.locked_until && user.locked_until.getTime() > Date.now()) {
        await audit(pool, {
          actorId: user.id,
          actorRole: user.role,
          action: 'auth.login',
          result: 'denied',
          code: 'locked',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        throw new HttpError(
          429,
          'rate_limited',
          'Слишком много неудачных попыток. Повторите позже.',
        );
      }

      const valid = await verifyPassword(user.password_hash, body.password);
      if (!valid) {
        const failed = user.failed_logins + 1;
        const lock = failed >= 5;
        await pool.query(
          `update users set failed_logins = $2,
                  locked_until = case when $3 then now() + interval '15 minutes' else locked_until end,
                  updated_at = now()
            where id = $1`,
          [user.id, lock ? 0 : failed, lock],
        );
        await audit(pool, {
          actorId: user.id,
          actorRole: user.role,
          action: 'auth.login',
          result: 'denied',
          code: lock ? 'locked' : 'invalid_credentials',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        throw unauthorized('Неверный e-mail или пароль');
      }

      await pool.query(
        `update users set failed_logins = 0, locked_until = null, last_login_at = now(), updated_at = now()
          where id = $1`,
        [user.id],
      );

      if (user.totp_enabled) {
        const ticket = await createMfaTicket(pool, user.id);
        await audit(pool, {
          actorId: user.id,
          actorRole: user.role,
          action: 'auth.login',
          result: 'ok',
          code: 'mfa_pending',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        return {
          mfa_required: true,
          mfa_ticket: ticket,
          expires_in: MFA_TICKET_TTL_SECONDS,
        };
      }

      const mfaPassed = !isMfaRequired(settings, user.role);
      const session = await createSession(pool, {
        userId: user.id,
        mfaPassed,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        days: settings.sessionDays,
      });
      setSessionCookies(reply, session, {
        secure: ctx.secureCookie,
        days: settings.sessionDays,
      });

      await audit(pool, {
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.login',
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { session: session.id },
      });

      return {
        mfa_required: false,
        enrollment_required: isMfaRequired(settings, user.role),
        csrf_token: session.csrf,
        user: userJson({ ...user, totp_enabled: user.totp_enabled }),
        mfa_policy: settings.mfaPolicy,
      };
    },
  );

  app.post(
    '/api/v1/auth/mfa',
    { config: { public: true, csrfExempt: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = mfaSchema.parse(request.body);
      const userId = await consumeMfaTicket(pool, body.mfa_ticket);
      if (!userId) throw unauthorized('Билет MFA истёк, начните вход заново');

      const userResult = await pool.query<{
        id: string;
        email: string;
        role: 'superadmin' | 'admin' | 'user';
        status: string;
        totp_enabled: boolean;
        totp_secret_enc: string | null;
        totp_last_step: string | null;
      }>('select * from users where id = $1', [userId]);
      const user = userResult.rows[0];
      if (!user || user.status !== 'active' || !user.totp_enabled || !user.totp_secret_enc) {
        throw unauthorized('Второй фактор недоступен для этой учётной записи');
      }

      const secret = decryptSecret(user.totp_secret_enc, ctx.masterKey);
      const verification = verifyTotp(secret, body.code);
      const lastStep = user.totp_last_step ? Number(user.totp_last_step) : 0;
      if (!verification.ok || verification.step === undefined || verification.step <= lastStep) {
        await audit(pool, {
          actorId: user.id,
          actorRole: user.role,
          action: 'auth.mfa',
          result: 'denied',
          code: 'invalid_totp',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        throw unauthorized('Неверный или повторно использованный код');
      }

      await pool.query(
        'update users set totp_last_step = $2, last_login_at = now(), updated_at = now() where id = $1',
        [user.id, verification.step],
      );

      const settings = await loadSettings(pool);
      const session = await createSession(pool, {
        userId: user.id,
        mfaPassed: true,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        days: settings.sessionDays,
      });
      setSessionCookies(reply, session, { secure: ctx.secureCookie, days: settings.sessionDays });

      await audit(pool, {
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.mfa',
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { session: session.id },
      });

      return {
        user: userJson({ ...user, totp_enabled: true }),
        csrf_token: session.csrf,
        mfa_policy: settings.mfaPolicy,
      };
    },
  );

  app.get(
    '/api/v1/auth/invite/preview',
    { config: { public: true } },
    async (request) => {
      const query = z.object({ token: z.string().min(20).max(64) }).parse(request.query);
      const result = await pool.query<{
        role: string;
        email: string | null;
        expires_at: Date;
        used_at: Date | null;
      }>(
        `select role, email, expires_at, used_at from invites where token_hash = $1`,
        [sha256Hex(query.token)],
      );
      const invite = result.rows[0];
      if (!invite) throw badRequest('invalid_invite', 'Приглашение не найдено');
      return {
        role: invite.role,
        email: invite.email ? maskEmail(invite.email) : null,
        expires_at: invite.expires_at.toISOString(),
        valid: !invite.used_at && invite.expires_at.getTime() > Date.now(),
      };
    },
  );

  app.post(
    '/api/v1/auth/invite/accept',
    { config: { public: true, csrfExempt: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = acceptSchema.parse(request.body);
      const policy = checkPasswordPolicy(body.password);
      if (!policy.ok) throw badRequest('weak_password', policy.message ?? 'Слабый пароль');

      const settings = await loadSettings(pool);
      const client = await pool.connect();
      let user: {
        id: string;
        email: string;
        role: 'superadmin' | 'admin' | 'user';
        status: string;
        totp_enabled: boolean;
      };

      try {
        await client.query('begin');
        await client.query("select pg_advisory_xact_lock(hashtext('router-control:users'))");

        const countResult = await client.query<{ count: string }>('select count(*)::text as count from users');
        if (Number(countResult.rows[0]?.count ?? 0) >= settings.limits.usersPerInstance) {
          throw badRequest(
            'limit_reached',
            'Достигнут лимит учётных записей на сервере. Удалите неиспользуемые аккаунты или приглашения.',
          );
        }

        const inviteResult = await client.query<{
          id: string;
          role: 'superadmin' | 'admin' | 'user';
          email: string | null;
          expires_at: Date;
          used_at: Date | null;
          created_by: string;
        }>(
          'select id, role, email, expires_at, used_at, created_by from invites where token_hash = $1 for update',
          [sha256Hex(body.token)],
        );
        const invite = inviteResult.rows[0];
        if (!invite || invite.used_at || invite.expires_at.getTime() <= Date.now()) {
          throw badRequest('invalid_invite', 'Приглашение недействительно или истекло');
        }
        if (invite.email && invite.email.toLowerCase() !== body.email) {
          throw badRequest('invite_email_mismatch', 'Приглашение выдано для другого e-mail');
        }

        const existing = await client.query('select 1 from users where email = $1', [body.email]);
        if (existing.rows[0]) throw badRequest('email_taken', 'Пользователь с таким e-mail уже существует');

        const id = uuidv7();
        const passwordHash = await hashPassword(body.password);
        // Пользователь, приглашённый администратором, остаётся в его ветке.
        // Приглашения от суперадминистратора создают учётные записи верхнего уровня.
        const inviter = await client.query<{ role: string }>(
          'select role from users where id = $1',
          [invite.created_by],
        );
        const parentId = inviter.rows[0]?.role === 'admin' ? invite.created_by : null;
        const created = await client.query<{
          id: string;
          email: string;
          role: 'superadmin' | 'admin' | 'user';
          status: string;
          totp_enabled: boolean;
        }>(
          `insert into users (id, email, password_hash, role, status, parent_id)
           values ($1,$2,$3,$4,'active',$5)
           returning id, email, role, status, totp_enabled, parent_id`,
          [id, body.email, passwordHash, invite.role, parentId],
        );
        user = created.rows[0]!;

        await client.query('update invites set used_at = now(), used_by = $2 where id = $1', [
          invite.id,
          user.id,
        ]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      const mfaPassed = !isMfaRequired(settings, user.role);
      const session = await createSession(pool, {
        userId: user.id,
        mfaPassed,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        days: settings.sessionDays,
      });
      setSessionCookies(reply, session, { secure: ctx.secureCookie, days: settings.sessionDays });

      await audit(pool, {
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.invite_accept',
        targetType: 'user',
        targetId: user.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { email: user.email },
      });

      return {
        user: userJson(user),
        csrf_token: session.csrf,
        enrollment_required: isMfaRequired(settings, user.role),
        mfa_policy: settings.mfaPolicy,
      };
    },
  );

  app.get(
    '/api/v1/auth/password-reset/preview',
    { config: { public: true } },
    async (request) => {
      const query = z.object({ token: resetTokenSchema }).parse(request.query);
      const result = await pool.query<{
        email: string;
        expires_at: Date;
        used_at: Date | null;
        reset_mfa: boolean;
      }>(
        `select u.email, pr.expires_at, pr.used_at, pr.reset_mfa
           from password_resets pr
           join users u on u.id = pr.user_id
          where pr.token_hash = $1`,
        [sha256Hex(query.token)],
      );
      const reset = result.rows[0];
      if (!reset) throw badRequest('invalid_password_reset', 'Ссылка сброса не найдена');
      return {
        email_masked: maskEmail(reset.email),
        expires_at: reset.expires_at.toISOString(),
        mfa_reset: reset.reset_mfa,
        valid: !reset.used_at && reset.expires_at.getTime() > Date.now(),
      };
    },
  );

  app.post(
    '/api/v1/auth/password-reset',
    { config: { public: true, csrfExempt: true, rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const body = resetPasswordSchema.parse(request.body);
      const policy = checkPasswordPolicy(body.password);
      if (!policy.ok) throw badRequest('weak_password', policy.message ?? 'Слабый пароль');
      const passwordHash = await hashPassword(body.password);

      const client = await pool.connect();
      let user: { id: string; email: string; role: 'superadmin' | 'admin' | 'user' };
      let resetMfa = false;
      try {
        await client.query('begin');
        const resetResult = await client.query<{
          id: string;
          user_id: string;
          expires_at: Date;
          used_at: Date | null;
          reset_mfa: boolean;
          email: string;
          role: 'superadmin' | 'admin' | 'user';
        }>(
          `select pr.id, pr.user_id, pr.expires_at, pr.used_at, pr.reset_mfa, u.email, u.role
             from password_resets pr
             join users u on u.id = pr.user_id
            where pr.token_hash = $1
            for update`,
          [sha256Hex(body.token)],
        );
        const reset = resetResult.rows[0];
        if (!reset || reset.used_at || reset.expires_at.getTime() <= Date.now()) {
          throw badRequest(
            'invalid_password_reset',
            'Ссылка сброса недействительна или истекла',
          );
        }

        // Если администратор отметил «потерян телефон», вместе с паролем
        // сбрасываем 2FA: иначе пользователь не сможет войти без кода.
        await client.query(
          `update users
              set password_hash = $2,
                  failed_logins = 0,
                  locked_until = null,
                  totp_enabled = case when $3 then false else totp_enabled end,
                  totp_secret_enc = case when $3 then null else totp_secret_enc end,
                  totp_confirmed_at = case when $3 then null else totp_confirmed_at end,
                  totp_last_step = case when $3 then null else totp_last_step end,
                  updated_at = now()
            where id = $1`,
          [reset.user_id, passwordHash, reset.reset_mfa],
        );
        await client.query('update password_resets set used_at = now() where id = $1', [reset.id]);
        await client.query(
          'update sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
          [reset.user_id],
        );
        await client.query(
          `update mobile_devices
              set revoked_at = now(), revoked_by = 'password_reset', device_token_hash = null
            where user_id = $1 and revoked_at is null`,
          [reset.user_id],
        );
        await client.query('commit');
        resetMfa = reset.reset_mfa;
        user = { id: reset.user_id, email: reset.email, role: reset.role };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      await audit(pool, {
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.password_reset',
        targetType: 'user',
        targetId: user.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { email: user.email, mfa_reset: resetMfa },
      });

      return { ok: true, mfa_reset: resetMfa };
    },
  );

  // Самостоятельный сброс пароля по коду 2FA: почта не нужна.
  // Подходит, если телефон с аутентификатором под рукой; иначе — ссылка от админа.
  app.post(
    '/api/v1/auth/password-reset/totp',
    {
      config: {
        public: true,
        csrfExempt: true,
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
    },
    async (request) => {
      const body = z
        .object({
          email: emailSchema,
          code: z.string().trim().min(6).max(10),
          password: passwordSchema,
        })
        .strict()
        .parse(request.body);

      const policy = checkPasswordPolicy(body.password);
      if (!policy.ok) throw badRequest('weak_password', policy.message ?? 'Слабый пароль');

      const generic = () => badRequest('invalid_recovery', 'Неверный e-mail или код подтверждения');

      const result = await pool.query<{
        id: string;
        email: string;
        role: 'superadmin' | 'admin' | 'user';
        status: string;
        archived_at: Date | null;
        totp_enabled: boolean;
        totp_secret_enc: string | null;
        totp_last_step: string | null;
      }>(
        `select id, email, role, status, archived_at, totp_enabled,
                totp_secret_enc, totp_last_step
           from users where email = $1`,
        [body.email],
      );
      const user = result.rows[0];

      if (
        !user ||
        user.status !== 'active' ||
        user.archived_at ||
        !user.totp_enabled ||
        !user.totp_secret_enc
      ) {
        await audit(pool, {
          actorId: user?.id ?? null,
          actorRole: user?.role ?? null,
          action: 'auth.password_reset_totp',
          targetType: 'user',
          targetId: user?.id ?? null,
          result: 'denied',
          code: 'recovery_unavailable',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        throw generic();
      }

      const secret = decryptSecret(user.totp_secret_enc, ctx.masterKey);
      const verification = verifyTotp(secret, body.code);
      const lastStep = user.totp_last_step ? Number(user.totp_last_step) : 0;
      if (!verification.ok || verification.step === undefined || verification.step <= lastStep) {
        await audit(pool, {
          actorId: user.id,
          actorRole: user.role,
          action: 'auth.password_reset_totp',
          targetType: 'user',
          targetId: user.id,
          result: 'denied',
          code: 'invalid_totp',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        throw generic();
      }

      const passwordHash = await hashPassword(body.password);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(
          `update users
              set password_hash = $2, totp_last_step = $3,
                  failed_logins = 0, locked_until = null, updated_at = now()
            where id = $1`,
          [user.id, passwordHash, verification.step],
        );
        await client.query(
          'update sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
          [user.id],
        );
        await client.query(
          `update mobile_devices
              set revoked_at = now(), revoked_by = 'password_reset', device_token_hash = null
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

      await audit(pool, {
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.password_reset_totp',
        targetType: 'user',
        targetId: user.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { email: user.email },
      });

      return { ok: true };
    },
  );

  app.get(
    '/api/v1/auth/me',
    { config: { allowPendingMfa: true } },
    async (request) => {
      const auth = requireUser(request);
      const settings = await loadSettings(pool);
      const result = await pool.query<{
        id: string;
        email: string;
        role: string;
        status: string;
        totp_enabled: boolean;
        first_name: string | null;
        middle_name: string | null;
        last_name: string | null;
        parent_id: string | null;
        created_at: Date;
        last_login_at: Date | null;
      }>(
        `select id, email, role, status, totp_enabled,
                first_name, middle_name, last_name, parent_id, created_at, last_login_at
           from users where id = $1`,
        [auth.userId],
      );
      const user = result.rows[0];
      if (!user) throw unauthorized();

      return {
        user: userJson(user),
        csrf_token: request.cookies[CSRF_COOKIE] ?? null,
        mfa_policy: settings.mfaPolicy,
        enrollment_required: auth.impersonatedBy
          ? false
          : !user.totp_enabled && isMfaRequired(settings, auth.role),
        mfa_passed: auth.mfaPassed,
        impersonation: auth.impersonatedBy
          ? {
              by_id: auth.impersonatedBy,
              by_email: auth.impersonatorEmail ?? null,
            }
          : null,
        permissions: {
          is_superadmin: auth.role === 'superadmin',
          can_manage_routers: isManagerRole(auth.role),
          can_manage_users: isManagerRole(auth.role),
          can_manage_settings: auth.role === 'superadmin',
          can_rollout: auth.role === 'superadmin',
        },
      };
    },
  );

  app.patch('/api/v1/auth/me', async (request) => {
    const auth = requireUser(request);
    const body = profileSchema.parse(request.body);
    const sets: string[] = [];
    const values: unknown[] = [];

    let emailBefore: string | null = null;
    let emailAfter: string | null = null;
    if (body.email !== undefined) {
      const current = await pool.query<{ email: string; password_hash: string }>(
        'select email, password_hash from users where id = $1',
        [auth.userId],
      );
      const row = current.rows[0];
      if (!row) throw unauthorized();

      if (body.email !== row.email) {
        if (!body.current_password) {
          throw badRequest(
            'current_password_required',
            'Для смены e-mail укажите текущий пароль',
          );
        }
        if (!(await verifyPassword(row.password_hash, body.current_password))) {
          throw badRequest('invalid_password', 'Неверный текущий пароль');
        }
        const taken = await pool.query('select 1 from users where email = $1 and id <> $2', [
          body.email,
          auth.userId,
        ]);
        if (taken.rows[0]) throw conflict('email_taken', 'Пользователь с таким e-mail уже существует');

        emailBefore = row.email;
        emailAfter = body.email;
        values.push(body.email);
        sets.push(`email = $${values.length}`);
      }
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
    if (sets.length === 0) throw badRequest('empty_update', 'Нет полей для обновления');
    sets.push('updated_at = now()');
    values.push(auth.userId);

    const result = await pool
      .query(
        `update users set ${sets.join(', ')} where id = $${values.length} returning
           id, email, role, status, totp_enabled, first_name, middle_name, last_name,
           created_at, last_login_at`,
        values,
      )
      .catch((error: unknown) => {
        if ((error as { code?: string }).code === '23505') {
          throw conflict('email_taken', 'Пользователь с таким e-mail уже существует');
        }
        throw error;
      });

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: emailAfter ? 'auth.email_change' : 'auth.profile_update',
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: emailAfter
        ? { before: { email: emailBefore }, after: { email: emailAfter } }
        : { fields: Object.keys(body) },
    });

    return { user: userJson(result.rows[0]) };
  });

  app.post(
    '/api/v1/auth/logout',
    { config: { allowPendingMfa: true } },
    async (request, reply) => {
      const auth = requireUser(request);
      if (auth.impersonatedBy) {
        const adminToken = request.cookies[IMPERSONATION_COOKIE];
        if (adminToken) {
          const adminSession = await resolveSession(pool, adminToken);
          if (adminSession) await revokeSession(pool, adminSession.sessionId);
        }
      }
      await revokeSession(pool, auth.sessionId);
      if (auth.mobileDeviceId) {
        // Явный выход с телефона отвязывает устройство: иначе следующая
        // загрузка приложения молча восстановила бы сессию.
        await pool.query(
          `update mobile_devices
              set revoked_at = now(), revoked_by = 'logout', device_token_hash = null
            where id = $1 and revoked_at is null`,
          [auth.mobileDeviceId],
        );
        await pool.query(
          `update sessions set revoked_at = now()
            where mobile_device_id = $1 and revoked_at is null`,
          [auth.mobileDeviceId],
        );
      }
      clearDeviceCookie(reply, ctx.secureCookie);
      clearSessionCookies(reply);
      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'auth.logout',
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/auth/impersonation/stop',
    async (request, reply) => {
      const auth = requireUser(request);
      if (!auth.impersonatedBy) {
        throw forbidden('Текущая сессия не является входом под пользователем');
      }
      const adminToken = request.cookies[IMPERSONATION_COOKIE];
      if (!adminToken) {
        throw unauthorized('Сессия суперадминистратора не найдена, войдите снова');
      }
      const adminSession = await resolveSession(pool, adminToken);
      if (
        !adminSession ||
        adminSession.role !== 'superadmin' ||
        adminSession.id !== auth.impersonatedBy
      ) {
        reply.clearCookie(IMPERSONATION_COOKIE, { path: '/' });
        throw unauthorized('Сессия суперадминистратора истекла, войдите снова');
      }

      const settings = await loadSettings(pool);
      await revokeSession(pool, auth.sessionId);
      const csrf = await rotateSessionCsrf(pool, adminSession.sessionId);
      setSessionCookies(
        reply,
        {
          id: adminSession.sessionId,
          token: adminToken,
          csrf,
          expiresAt: new Date(Date.now() + settings.sessionDays * 24 * 60 * 60 * 1000),
        },
        { secure: ctx.secureCookie, days: settings.sessionDays },
      );
      reply.clearCookie(IMPERSONATION_COOKIE, { path: '/' });

      await audit(pool, {
        actorId: adminSession.id,
        actorRole: 'superadmin',
        action: 'user.impersonate_stop',
        targetType: 'user',
        targetId: auth.userId,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { impersonated_email: auth.email },
      });

      return { ok: true };
    },
  );

  app.post('/api/v1/auth/password', async (request, reply) => {
    const auth = requireUser(request);
    const body = passwordChangeSchema.parse(request.body);
    const policy = checkPasswordPolicy(body.new_password);
    if (!policy.ok) throw badRequest('weak_password', policy.message ?? 'Слабый пароль');

    const result = await pool.query<{ password_hash: string; totp_enabled: boolean }>(
      'select password_hash, totp_enabled from users where id = $1',
      [auth.userId],
    );
    const user = result.rows[0];
    if (!user || !(await verifyPassword(user.password_hash, body.current_password))) {
      throw unauthorized('Текущий пароль неверен');
    }

    const newHash = await hashPassword(body.new_password);
    await pool.query('update users set password_hash = $2, updated_at = now() where id = $1', [
      auth.userId,
      newHash,
    ]);
    await pool.query(
      'update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null',
      [auth.userId, auth.sessionId],
    );
    // Смена пароля должна выкидывать и привязанные телефоны, иначе
    // приложение молча восстановит сессию по cookie устройства.
    await pool.query(
      `update mobile_devices
          set revoked_at = now(), revoked_by = 'password_change', device_token_hash = null
        where user_id = $1 and id is distinct from $2 and revoked_at is null`,
      [auth.userId, auth.mobileDeviceId],
    );
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'auth.password_change',
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    reply.code(204);
  });

  app.post(
    '/api/v1/auth/mfa/enroll',
    { config: { allowPendingMfa: true } },
    async (request) => {
      const auth = requireUser(request);
      const result = await pool.query<{ email: string; totp_enabled: boolean }>(
        'select email, totp_enabled from users where id = $1',
        [auth.userId],
      );
      const user = result.rows[0];
      if (!user) throw unauthorized();
      if (user.totp_enabled) {
        throw badRequest('mfa_already_enabled', 'Второй фактор уже включён');
      }

      const secret = generateTotpSecret();
      await pool.query(
        'update users set totp_secret_enc = $2, totp_enabled = false, totp_confirmed_at = null, totp_last_step = null, updated_at = now() where id = $1',
        [auth.userId, encryptSecret(secret, ctx.masterKey)],
      );

      const uri = provisioningUri({ secret, email: user.email });
      const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'auth.mfa_enroll_start',
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return { secret, otpauth_uri: uri, qr_data_url: qr };
    },
  );

  app.post(
    '/api/v1/auth/mfa/confirm',
    { config: { allowPendingMfa: true } },
    async (request) => {
      const auth = requireUser(request);
      const body = z.object({ code: z.string().min(6).max(10) }).strict().parse(request.body);
      const result = await pool.query<{ totp_secret_enc: string | null; email: string }>(
        'select totp_secret_enc, email from users where id = $1',
        [auth.userId],
      );
      const user = result.rows[0];
      if (!user?.totp_secret_enc) throw badRequest('mfa_not_started', 'Сначала запустите подключение 2FA');

      const secret = decryptSecret(user.totp_secret_enc, ctx.masterKey);
      const verification = verifyTotp(secret, body.code);
      if (!verification.ok || verification.step === undefined) {
        throw badRequest('invalid_totp', 'Неверный код подтверждения');
      }

      await pool.query(
        `update users set totp_enabled = true, totp_confirmed_at = now(),
                totp_last_step = $2, updated_at = now()
          where id = $1`,
        [auth.userId, verification.step],
      );
      await pool.query('update sessions set mfa_passed = true where id = $1', [auth.sessionId]);

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'auth.mfa_enabled',
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });

      return { ok: true, mfa_passed: true };
    },
  );

  app.post('/api/v1/auth/mfa/disable', async (request) => {
    const auth = requireUser(request);
    const settings = await loadSettings(pool);
    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'auth.mfa_disable',
      result: 'denied',
      code: 'policy',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
    throw forbidden(
      `Отключение 2FA запрещено политикой (${settings.mfaPolicy === 'all' ? 'для всех' : 'для администраторов'}). Обратитесь к суперадминистратору.`,
    );
  });
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
}

export { SESSION_COOKIE };
