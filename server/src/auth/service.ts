import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { sha256, sha256Hex, randomToken } from '../lib/crypto.js';
import { HttpError, forbidden, unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { loadSettings, type PlatformSettings } from '../settings.js';

export const SESSION_COOKIE = 'rc_session';
export const CSRF_COOKIE = 'rc_csrf';
export const IMPERSONATION_COOKIE = 'rc_admin_session';
/**
 * Долгоживущая привязка устройства. Это HttpOnly-cookie, а не сессия:
 * по ней приложение получает новую сессию, пока телефон не отвязан.
 * 400 дней — практический максимум, который не срезают браузеры;
 * при активности срок продлевается вместе с сессией.
 */
export const DEVICE_COOKIE = 'rc_device';
export const DEVICE_TOKEN_DAYS = 400;
export const MFA_TICKET_TTL_SECONDS = 300;

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  totpEnabled: boolean;
  mfaPassed: boolean;
  sessionId: string;
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  impersonatedBy?: string | null;
  impersonatorEmail?: string | null;
  mobileDeviceId: string | null;
}

export type Role = 'superadmin' | 'admin' | 'user';

export function isManagerRole(role: Role): boolean {
  return role === 'superadmin' || role === 'admin';
}

/**
 * Может ли актор управлять указанным пользователем. Суперадминистратор — всех,
 * администратор — только пользователей своей ветки (parent_id = его id).
 */
export function canManageBranchUser(
  actorRole: Role,
  actorId: string,
  target: { role: string; parent_id: string | null },
): boolean {
  if (actorRole === 'superadmin') return true;
  if (actorRole !== 'admin') return false;
  return target.role === 'user' && target.parent_id === actorId;
}

export function isMfaRequired(settings: PlatformSettings, role: Role): boolean {
  return settings.mfaPolicy === 'all' || (settings.mfaPolicy === 'admins' && isManagerRole(role));
}

export function cookieOptions(config: { secure: boolean; days: number }) {
  return {
    httpOnly: true,
    secure: config.secure,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: config.days * 24 * 60 * 60,
  };
}

export function deviceCookieOptions(config: { secure: boolean }) {
  return {
    httpOnly: true,
    secure: config.secure,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: DEVICE_TOKEN_DAYS * 24 * 60 * 60,
  };
}

export interface CreatedSession {
  id: string;
  token: string;
  csrf: string;
  expiresAt: Date;
}

export async function createSession(
  pool: Pool,
  input: {
    userId: string;
    mfaPassed: boolean;
    ip: string | null;
    userAgent: string | null;
    days: number;
    impersonatedBy?: string | null;
  },
): Promise<CreatedSession> {
  const id = uuidv7();
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expiresAt = new Date(Date.now() + input.days * 24 * 60 * 60 * 1000);

  await pool.query(
    `insert into sessions (id, user_id, token_hash, csrf_hash, ip, user_agent, mfa_passed, expires_at, impersonated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.userId,
      sha256(token),
      sha256(csrf),
      input.ip,
      input.userAgent?.slice(0, 300) ?? null,
      input.mfaPassed,
      expiresAt,
      input.impersonatedBy ?? null,
    ],
  );

  return { id, token, csrf, expiresAt };
}

export function setSessionCookies(
  reply: FastifyReply,
  session: CreatedSession,
  options: { secure: boolean; days: number },
): void {
  reply.setCookie(SESSION_COOKIE, session.token, cookieOptions(options));
  reply.setCookie(CSRF_COOKIE, session.csrf, {
    ...cookieOptions(options),
    httpOnly: false,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
  reply.clearCookie(IMPERSONATION_COOKIE, { path: '/' });
}

export function setDeviceCookie(
  reply: FastifyReply,
  token: string,
  options: { secure: boolean },
): void {
  reply.setCookie(DEVICE_COOKIE, token, deviceCookieOptions(options));
}

export function clearDeviceCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(DEVICE_COOKIE, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'strict',
  });
}

export interface ResolvedSession extends AuthUser {
  csrfHash: Buffer;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Продлевать сессию, пока ей пользуются. Порог — половина исходного срока:
 * сессия на 45 дней продлевается примерно раз в 22 дня. Короткие сессии
 * (вход под пользователем на 2 часа) не трогаем.
 */
export function shouldRenewSession(
  session: { createdAt: Date; expiresAt: Date; impersonatedBy?: string | null },
  now = Date.now(),
): boolean {
  if (session.impersonatedBy) return false;
  const total = session.expiresAt.getTime() - session.createdAt.getTime();
  if (total < 24 * 60 * 60 * 1000) return false;
  return session.expiresAt.getTime() - now < total / 2;
}

export async function resolveSession(
  pool: Pool,
  token: string,
): Promise<ResolvedSession | null> {
  const result = await pool.query<{
    session_id: string;
    csrf_hash: Buffer;
    mfa_passed: boolean;
    user_id: string;
    email: string;
    role: Role;
    totp_enabled: boolean;
    mobile_device_id: string | null;
    impersonated_by: string | null;
    impersonator_email: string | null;
    created_at: Date;
    expires_at: Date;
  }>(
    `select s.id as session_id, s.csrf_hash, s.mfa_passed, s.mobile_device_id,
            s.impersonated_by, imp.email as impersonator_email,
            s.created_at, s.expires_at,
            u.id as user_id, u.email, u.role, u.totp_enabled
       from sessions s
       join users u on u.id = s.user_id
       left join users imp on imp.id = s.impersonated_by
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and u.status = 'active'`,
    [sha256(token)],
  );

  const row = result.rows[0];
  if (!row) return null;

  void pool
    .query(
      `update sessions set last_seen_at = now()
        where id = $1 and last_seen_at < now() - interval '60 seconds'`,
      [row.session_id],
    )
    .catch(() => undefined);

  if (row.mobile_device_id) {
    void pool
      .query(
        `update mobile_devices set last_seen_at = now()
          where id = $1 and last_seen_at < now() - interval '60 seconds'`,
        [row.mobile_device_id],
      )
      .catch(() => undefined);
  }

  return {
    id: row.user_id,
    email: row.email,
    role: row.role,
    totpEnabled: row.totp_enabled,
    mfaPassed: row.mfa_passed,
    sessionId: row.session_id,
    csrfHash: row.csrf_hash,
    impersonatedBy: row.impersonated_by,
    impersonatorEmail: row.impersonator_email,
    mobileDeviceId: row.mobile_device_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Новый CSRF-токен для существующей сессии. Нужен при возврате из режима
 * «войти как пользователь»: старый CSRF-cookie был заменён на пользовательский.
 */
export async function rotateSessionCsrf(pool: Pool, sessionId: string): Promise<string> {
  const csrf = randomToken(24);
  await pool.query('update sessions set csrf_hash = $2 where id = $1 and revoked_at is null', [
    sessionId,
    sha256(csrf),
  ]);
  return csrf;
}

interface GuardOptions {
  secureCookie: boolean;
  agentPaths?: boolean;
}

/**
 * Глобальные охранники Web API. Публичные маршруты помечаются
 * `config: { public: true }`, CSRF-исключения — `config: { csrfExempt: true }`.
 */
export function registerGuards(app: FastifyInstance, pool: Pool, options: GuardOptions): void {
  app.decorateRequest('auth');

  app.addHook('preHandler', async (request, reply) => {
    const config = request.routeOptions.config as
      | { public?: boolean; allowPendingMfa?: boolean; csrfExempt?: boolean }
      | undefined;

    if (!request.url.startsWith('/api/v1/')) return;
    if (config?.public) {
      if (!config.csrfExempt && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
        assertSameOrigin(request);
      }
      return;
    }

    const token = request.cookies[SESSION_COOKIE];
    if (!token) throw unauthorized();

    const session = await resolveSession(pool, token);
    if (!session) {
      clearSessionCookies(reply);
      throw unauthorized('Сессия истекла, войдите снова');
    }

    request.auth = {
      sessionId: session.sessionId,
      userId: session.id,
      email: session.email,
      role: session.role,
      mfaPassed: session.mfaPassed,
      impersonatedBy: session.impersonatedBy ?? null,
      impersonatorEmail: session.impersonatorEmail ?? null,
      mobileDeviceId: session.mobileDeviceId,
    };

    if (!session.mfaPassed && !config?.allowPendingMfa) {
      throw new HttpError(403, 'mfa_required', 'Требуется подтверждение второго фактора');
    }

    if (!config?.csrfExempt && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      assertSameOrigin(request);
      const header = request.headers['x-csrf-token'];
      const cookie = request.cookies[CSRF_COOKIE];
      if (typeof header !== 'string' || !cookie || header !== cookie) {
        throw forbidden('CSRF-токен отсутствует или не совпадает');
      }
      const expected = sha256(header);
      if (expected.length !== session.csrfHash.length || !expected.equals(session.csrfHash)) {
        throw forbidden('CSRF-токен недействителен');
      }
    }

    await ensureDeviceBinding(pool, request, reply, session, options);
    await renewSessionIfNeeded(pool, request, reply, session, token, options);
  });

  void options.agentPaths;
}

/**
 * Выдаёт rc_device существующим мобильным сессиям, созданным до появления
 * привязки. Достаточно одного запроса после обновления панели — и телефон
 * сможет восстанавливать сессию без нового QR.
 */
async function ensureDeviceBinding(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  session: ResolvedSession,
  options: GuardOptions,
): Promise<void> {
  if (!session.mobileDeviceId) return;
  const existing = request.cookies[DEVICE_COOKIE];
  if (typeof existing === 'string' && existing !== '') return;

  const token = randomToken(32);
  const result = await pool.query(
    `update mobile_devices
        set device_token_hash = $2, device_token_created_at = now()
      where id = $1 and revoked_at is null and device_token_hash is null`,
    [session.mobileDeviceId, sha256(token)],
  );
  if ((result.rowCount ?? 0) > 0) {
    setDeviceCookie(reply, token, { secure: options.secureCookie });
  }
}

/**
 * Продление активной сессии. Cookie переставляются с тем же токеном,
 * поэтому параллельные вкладки не мешают друг другу: CSRF-значение
 * берётся из запроса и не меняется.
 */
async function renewSessionIfNeeded(
  pool: Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  session: ResolvedSession,
  token: string,
  options: GuardOptions,
): Promise<void> {
  if (!shouldRenewSession(session)) return;

  const settings = await loadSettings(pool);
  const newExpiresAt = new Date(Date.now() + settings.sessionDays * 24 * 60 * 60 * 1000);
  if (newExpiresAt.getTime() <= session.expiresAt.getTime()) return;

  await pool.query(
    'update sessions set expires_at = $2 where id = $1 and revoked_at is null',
    [session.sessionId, newExpiresAt],
  );

  reply.setCookie(
    SESSION_COOKIE,
    token,
    cookieOptions({ secure: options.secureCookie, days: settings.sessionDays }),
  );

  const csrf = request.cookies[CSRF_COOKIE];
  if (typeof csrf === 'string' && csrf !== '') {
    reply.setCookie(CSRF_COOKIE, csrf, {
      ...cookieOptions({ secure: options.secureCookie, days: settings.sessionDays }),
      httpOnly: false,
    });
  }

  // Привязка телефона должна жить вместе с сессией: пока приложение
  // открывают, срок cookie устройства тоже продлевается.
  const deviceToken = request.cookies[DEVICE_COOKIE];
  if (typeof deviceToken === 'string' && deviceToken !== '') {
    setDeviceCookie(reply, deviceToken, { secure: options.secureCookie });
  }
}

function assertSameOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    const host = request.headers.host;
    if (!host || parsed.host !== host) {
      throw forbidden('Запрос с недопустимого Origin');
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'HttpError') throw error;
    throw forbidden('Некорректный заголовок Origin');
  }
}

export function requireUser(request: FastifyRequest): NonNullable<FastifyRequest['auth']> {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export function requireSuperadmin(request: FastifyRequest): NonNullable<FastifyRequest['auth']> {
  const auth = requireUser(request);
  if (auth.role !== 'superadmin') throw forbidden('Действие доступно только суперадминистратору');
  return auth;
}

/**
 * Управляющий уровень: суперадминистратор или администратор. Конкретные
 * маршруты дополнительно проверяют владение роутером и ветку пользователей.
 */
export function requireManager(request: FastifyRequest): NonNullable<FastifyRequest['auth']> {
  const auth = requireUser(request);
  if (!isManagerRole(auth.role)) throw forbidden('Действие доступно администратору');
  return auth;
}

export async function userCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>('select count(*)::text as count from users');
  return Number(result.rows[0]?.count ?? 0);
}

export async function routerCountForOwner(pool: Pool, ownerId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'select count(*)::text as count from routers where owner_id = $1',
    [ownerId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function createMfaTicket(pool: Pool, userId: string): Promise<string> {
  const token = randomToken(32);
  await pool.query(
    `insert into mfa_tickets (id, user_id, token_hash, expires_at)
     values ($1,$2,$3, now() + ($4 || ' seconds')::interval)`,
    [uuidv7(), userId, sha256(token), MFA_TICKET_TTL_SECONDS],
  );
  return token;
}

export async function consumeMfaTicket(pool: Pool, token: string): Promise<string | null> {
  const result = await pool.query<{ user_id: string }>(
    `update mfa_tickets
        set used_at = now()
      where token_hash = $1 and used_at is null and expires_at > now()
      returning user_id`,
    [sha256(token)],
  );
  return result.rows[0]?.user_id ?? null;
}

export async function revokeSession(pool: Pool, sessionId: string): Promise<void> {
  await pool.query('update sessions set revoked_at = now() where id = $1', [sessionId]);
}

export function auditFingerprint(value: string): string {
  return sha256Hex(value).slice(0, 12);
}
