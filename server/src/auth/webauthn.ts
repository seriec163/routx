import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { audit } from '../audit.js';
import { verifyPassword } from '../lib/password.js';
import { conflict, badRequest, notFound, unauthorized } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';
import { loadSettings } from '../settings.js';
import {
  createSession,
  isMfaRequired,
  requireUser,
  setSessionCookies,
} from './service.js';
import { userJson } from './routes.js';

interface RouteContext {
  pool: Pool;
  publicUrl: string;
  secureCookie: boolean;
}

const passwordSchema = z.string().min(1).max(256);

function rpConfig(publicUrl: string): { rpID: string; origin: string } {
  const url = new URL(publicUrl);
  return { rpID: url.hostname, origin: url.origin };
}

interface CredentialRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
  device_type: string | null;
  backed_up: boolean;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
}

interface UserRow {
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

async function loadUserForPassword(
  pool: Pool,
  userId: string,
  password: string,
): Promise<{ id: string; email: string; role: UserRow['role']; password_hash: string }> {
  const result = await pool.query<{
    id: string;
    email: string;
    role: UserRow['role'];
    status: string;
    password_hash: string;
  }>('select id, email, role, status, password_hash from users where id = $1', [userId]);
  const user = result.rows[0];
  if (!user || user.status !== 'active') throw unauthorized();
  if (!(await verifyPassword(user.password_hash, password))) {
    throw unauthorized('Текущий пароль неверен');
  }
  return user;
}

async function saveChallenge(
  pool: Pool,
  input: { challenge: string; userId: string | null; kind: 'registration' | 'authentication' },
): Promise<string> {
  await pool.query('delete from webauthn_challenges where expires_at < now()');
  const id = uuidv7();
  await pool.query(
    `insert into webauthn_challenges (id, challenge, user_id, kind, expires_at)
     values ($1, $2, $3, $4, now() + interval '5 minutes')`,
    [id, input.challenge, input.userId, input.kind],
  );
  return id;
}

async function consumeChallenge(
  pool: Pool,
  challengeId: string,
  kind: 'registration' | 'authentication',
): Promise<{ challenge: string; user_id: string | null } | null> {
  const result = await pool.query<{ challenge: string; user_id: string | null }>(
    `delete from webauthn_challenges
      where id = $1 and kind = $2 and expires_at > now()
      returning challenge, user_id`,
    [challengeId, kind],
  );
  return result.rows[0] ?? null;
}

/**
 * Passkey — дополнительный способ входа. Пароль + TOTP остаются рабочими;
 * passkey можно добавить вручную и входить им как альтернативой.
 */
export async function registerWebAuthnRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/auth/webauthn/credentials', async (request) => {
    const auth = requireUser(request);
    const result = await pool.query<{
      id: string;
      name: string;
      device_type: string | null;
      backed_up: boolean;
      created_at: Date;
      last_used_at: Date | null;
    }>(
      `select id, name, device_type, backed_up, created_at, last_used_at
         from webauthn_credentials
        where user_id = $1
        order by created_at desc`,
      [auth.userId],
    );
    return { items: result.rows };
  });

  app.post('/api/v1/auth/webauthn/register/options', async (request) => {
    const auth = requireUser(request);
    const body = z.object({ password: passwordSchema }).strict().parse(request.body);
    const user = await loadUserForPassword(pool, auth.userId, body.password);
    const credentials = await pool.query<{ credential_id: string }>(
      'select credential_id from webauthn_credentials where user_id = $1',
      [user.id],
    );
    const { rpID } = rpConfig(ctx.publicUrl);
    const options = await generateRegistrationOptions({
      rpName: 'RoutX',
      rpID,
      userID: Uint8Array.from(Buffer.from(user.id.replace(/-/g, ''), 'hex')),
      userName: user.email,
      userDisplayName: user.email,
      attestationType: 'none',
      excludeCredentials: credentials.rows.map((row) => ({ id: row.credential_id })),
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
        authenticatorAttachment: 'platform',
      },
    });
    const challengeId = await saveChallenge(pool, {
      challenge: options.challenge,
      userId: user.id,
      kind: 'registration',
    });
    return { challenge_id: challengeId, options };
  });

  app.post('/api/v1/auth/webauthn/register/verify', async (request) => {
    const auth = requireUser(request);
    const body = z
      .object({
        challenge_id: z.string().uuid(),
        response: z.unknown(),
        name: z.string().trim().min(1).max(60).optional(),
      })
      .strict()
      .parse(request.body);

    const challenge = await consumeChallenge(pool, body.challenge_id, 'registration');
    if (!challenge || challenge.user_id !== auth.userId) {
      throw badRequest('webauthn_challenge', 'Регистрация устарела, начните заново');
    }

    const { rpID, origin } = rpConfig(ctx.publicUrl);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch {
      throw badRequest('webauthn_registration_failed', 'Не удалось проверить passkey');
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw badRequest('webauthn_registration_failed', 'Не удалось проверить passkey');
    }

    const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;
    const id = uuidv7();
    const name = body.name ?? 'Passkey';
    try {
      await pool.query(
        `insert into webauthn_credentials
           (id, user_id, credential_id, public_key, counter, transports,
            device_type, backed_up, name)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          auth.userId,
          credential.id,
          Buffer.from(credential.publicKey),
          credential.counter,
          credential.transports ?? [],
          credentialDeviceType,
          credentialBackedUp,
          name,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw conflict('passkey_exists', 'Этот passkey уже добавлен');
      }
      throw error;
    }

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'auth.passkey_add',
      targetType: 'user',
      targetId: auth.userId,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { credential_id: credential.id, name },
    });

    return {
      id,
      name,
      device_type: credentialDeviceType,
      backed_up: credentialBackedUp,
    };
  });

  app.post('/api/v1/auth/webauthn/credentials/:id/remove', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ password: passwordSchema }).strict().parse(request.body);
    await loadUserForPassword(pool, auth.userId, body.password);

    const result = await pool.query<{ credential_id: string; name: string }>(
      `delete from webauthn_credentials
        where id = $1 and user_id = $2
        returning credential_id, name`,
      [params.id, auth.userId],
    );
    const removed = result.rows[0];
    if (!removed) throw notFound('Passkey не найден');

    await audit(pool, {
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'auth.passkey_remove',
      targetType: 'user',
      targetId: auth.userId,
      result: 'ok',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { credential_id: removed.credential_id, name: removed.name },
    });
    return { ok: true };
  });

  app.post(
    '/api/v1/auth/webauthn/login/options',
    {
      config: {
        public: true,
        csrfExempt: true,
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async () => {
      const { rpID } = rpConfig(ctx.publicUrl);
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'required',
        timeout: 60_000,
      });
      const challengeId = await saveChallenge(pool, {
        challenge: options.challenge,
        userId: null,
        kind: 'authentication',
      });
      return { challenge_id: challengeId, options };
    },
  );

  app.post(
    '/api/v1/auth/webauthn/login/verify',
    {
      config: {
        public: true,
        csrfExempt: true,
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const body = z
        .object({ challenge_id: z.string().uuid(), response: z.unknown() })
        .strict()
        .parse(request.body);
      const challenge = await consumeChallenge(pool, body.challenge_id, 'authentication');
      if (!challenge) {
        throw unauthorized('Подтверждение устарело, попробуйте снова');
      }

      const response = body.response as AuthenticationResponseJSON;
      if (!response || typeof response.id !== 'string' || response.id === '') {
        throw badRequest('webauthn_response', 'Некорректный ответ passkey');
      }

      const credentialResult = await pool.query<CredentialRow>(
        'select * from webauthn_credentials where credential_id = $1',
        [response.id],
      );
      const credential = credentialResult.rows[0];
      if (!credential) {
        await audit(pool, {
          action: 'auth.passkey_login',
          result: 'denied',
          code: 'credential_unknown',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        });
        throw unauthorized('Passkey не найден на сервере');
      }

      const userResult = await pool.query<UserRow>(
        `select id, email, role, status, totp_enabled,
                first_name, middle_name, last_name, parent_id,
                created_at, last_login_at, archived_at
           from users where id = $1`,
        [credential.user_id],
      );
      const user = userResult.rows[0];
      if (!user || user.status !== 'active' || user.archived_at) {
        throw unauthorized('Учётная запись недоступна');
      }

      const { rpID, origin } = rpConfig(ctx.publicUrl);
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: credential.credential_id,
            publicKey: new Uint8Array(credential.public_key),
            counter: Number(credential.counter),
          },
          requireUserVerification: true,
        });
      } catch {
        await audit(pool, {
          actorId: user.id,
          actorRole: user.role,
          action: 'auth.passkey_login',
          targetType: 'user',
          targetId: user.id,
          result: 'denied',
          code: 'signature_invalid',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { credential_id: credential.credential_id },
        });
        throw unauthorized('Не удалось подтвердить passkey');
      }

      if (!verification.verified) {
        throw unauthorized('Не удалось подтвердить passkey');
      }

      await pool.query(
        `update webauthn_credentials
            set counter = $2, last_used_at = now()
          where id = $1`,
        [credential.id, verification.authenticationInfo.newCounter],
      );
      await pool.query(
        'update users set last_login_at = now(), updated_at = now() where id = $1',
        [user.id],
      );

      const settings = await loadSettings(pool);
      const session = await createSession(pool, {
        userId: user.id,
        // Face ID / Touch ID подтвердил владение passkey — второй фактор пройден.
        mfaPassed: true,
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
        action: 'auth.passkey_login',
        targetType: 'user',
        targetId: user.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { session: session.id, credential_id: credential.credential_id },
      });

      return {
        user: userJson(user),
        csrf_token: session.csrf,
        mfa_policy: settings.mfaPolicy,
        enrollment_required: isMfaRequired(settings, user.role) && !user.totp_enabled,
      };
    },
  );
}
