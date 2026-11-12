import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { audit } from '../audit.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { uuidv7 } from '../lib/ids.js';

const config = loadConfig();
const email = (process.argv[2] ?? '').trim().toLowerCase();
const resetMfa = process.argv.includes('--reset-mfa');

if (!email) {
  console.error(
    'Использование: node server/dist/cli/password-reset.js <email> [--reset-mfa]',
  );
  process.exit(2);
}

const db = createDb(config.DATABASE_URL);
try {
  const result = await db.pool.query<{
    id: string;
    email: string;
    role: 'superadmin' | 'admin' | 'user';
  }>('select id, email, role from users where email = $1', [email]);
  const user = result.rows[0];

  if (!user) {
    console.error(`Пользователь ${email} не найден`);
    process.exitCode = 1;
  } else {
    await db.pool.query(
      'update password_resets set used_at = now() where user_id = $1 and used_at is null',
      [user.id],
    );
    const token = randomToken(32);
    const expires = await db.pool.query<{ expires_at: Date }>(
      `insert into password_resets (id, user_id, token_hash, created_by, expires_at, reset_mfa)
       values ($1, $2, $3, $4, now() + interval '1 hour', $5)
       returning expires_at`,
      [uuidv7(), user.id, sha256Hex(token), user.id, resetMfa],
    );

    await audit(db.pool, {
      actorId: user.id,
      actorRole: user.role,
      action: 'user.password_reset_cli',
      targetType: 'user',
      targetId: user.id,
      result: 'ok',
      metadata: { email: user.email, reset_mfa: resetMfa },
    });

    console.info(
      `Ссылка сброса для ${user.email} (действует до ${expires.rows[0]!.expires_at.toISOString()}):`,
    );
    console.info(`${config.RC_PUBLIC_URL}/#/reset-password/${encodeURIComponent(token)}`);
    if (resetMfa) {
      console.info('Вместе с паролем будет сброшен второй фактор (2FA).');
    }
  }
} catch (error) {
  console.error('Ошибка сброса пароля:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
