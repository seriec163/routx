import type { Pool } from 'pg';
import { hashPassword, checkPasswordPolicy } from './lib/password.js';
import { uuidv7 } from './lib/ids.js';
import { audit } from './audit.js';

export interface BootstrapResult {
  created: boolean;
  userId?: string;
  email?: string;
  reason?: string;
}

/**
 * Первый суперадминистратор создаётся только на пустой базе.
 * Пароль задаётся через переменные окружения RC_BOOTSTRAP_* или CLI.
 * TOTP обязателен по политике и подтверждается при первом входе.
 */
export async function ensureBootstrapAdmin(
  pool: Pool,
  input: { email?: string; password?: string },
): Promise<BootstrapResult> {
  const count = await pool.query<{ count: string }>('select count(*)::text as count from users');
  if (Number(count.rows[0]?.count ?? 0) > 0) {
    return { created: false, reason: 'users_exist' };
  }

  if (!input.email || !input.password) {
    return { created: false, reason: 'no_credentials' };
  }

  const policy = checkPasswordPolicy(input.password);
  if (!policy.ok) {
    throw new Error(`Пароль bootstrap-администратора не соответствует политике: ${policy.message}`);
  }

  const id = uuidv7();
  const passwordHash = await hashPassword(input.password);

  await pool.query(
    `insert into users (id, email, password_hash, role, status)
     values ($1,$2,$3,'superadmin','active')`,
    [id, input.email.trim().toLowerCase(), passwordHash],
  );

  await audit(pool, {
    actorId: id,
    actorRole: 'superadmin',
    action: 'user.bootstrap',
    targetType: 'user',
    targetId: id,
    result: 'ok',
    metadata: { email: input.email },
  });

  return { created: true, userId: id, email: input.email.trim().toLowerCase() };
}
