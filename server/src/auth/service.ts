import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { sha256, sha256Hex, randomToken } from '../lib/crypto.js';
import { HttpError, forbidden, unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import type { PlatformSettings } from '../settings.js';

export const SESSION_COOKIE = 'rc_session';
export const CSRF_COOKIE = 'rc_csrf';
export const MFA_TICKET_TTL_SECONDS = 300;

export interface AuthUser {
  id: string;
  email: string;
  role: 'superadmin' | 'user';
  totpEnabled: boolean;
  mfaPassed: boolean;
  sessionId: string;
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
}

export function isMfaRequired(settings: PlatformSettings, role: 'superadmin' | 'user'): boolean {
  return settings.mfaPolicy === 'all' || (settings.mfaPolicy === 'admins' && role === 'superadmin');
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
  },
): Promise<CreatedSession> {
  const id = uuidv7();
  const token = randomToken(32);
  const csrf = randomToken(24);
  const expiresAt = new Date(Date.now() + input.days * 24 * 60 * 60 * 1000);

  await pool.query(
    `insert into sessions (id, user_id, token_hash, csrf_hash, ip, user_agent, mfa_passed, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      input.userId,
      sha256(token),
      sha256(csrf),
      input.ip,
      input.userAgent?.slice(0, 300) ?? null,
      input.mfaPassed,
      expiresAt,
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
}

export async function resolveSession(
  pool: Pool,
  token: string,
): Promise<(AuthUser & { csrfHash: Buffer }) | null> {
  const result = await pool.query<{
    session_id: string;
    csrf_hash: Buffer;
    mfa_passed: boolean;
    user_id: string;
    email: string;
    role: 'superadmin' | 'user';
    totp_enabled: boolean;
  }>(
    `select s.id as session_id, s.csrf_hash, s.mfa_passed,
            u.id as user_id, u.email, u.role, u.totp_enabled
       from sessions s
       join users u on u.id = s.user_id
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

  return {
    id: row.user_id,
    email: row.email,
    role: row.role,
    totpEnabled: row.totp_enabled,
    mfaPassed: row.mfa_passed,
    sessionId: row.session_id,
    csrfHash: row.csrf_hash,
  };
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
  });

  void options.agentPaths;
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
