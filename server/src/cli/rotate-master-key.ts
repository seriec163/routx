import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { audit } from '../audit.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import {
  createConnectionSecret,
  decodeConnectionSecret,
} from '../routers/connection-secret.js';

/**
 * Ротация RC_MASTER_KEY.
 *
 * Запуск выполняется, пока приложение ещё работает со старым ключом:
 *
 *   RC_MASTER_KEY_NEW='новый ключ' npm run rotate-master-key -w @routx/server -- --dry-run
 *   RC_MASTER_KEY_NEW='новый ключ' npm run rotate-master-key -w @routx/server
 *
 * После успешной ротации:
 *   1. заменить RC_MASTER_KEY в .env на новый;
 *   2. убрать RC_MASTER_KEY_NEW;
 *   3. перезапустить app.
 *
 * --dry-run только проверяет, что все секреты читаются старым ключом,
 * и ничего не записывает.
 */

const config = loadConfig();
const oldKey = (config.RC_MASTER_KEY ?? '').trim();
const newKey = (process.env.RC_MASTER_KEY_NEW ?? '').trim();
const dryRun = process.argv.includes('--dry-run');

if (!oldKey || oldKey.length < 16) {
  console.error('RC_MASTER_KEY (текущий ключ) не задан или слишком короткий');
  process.exit(2);
}
if (!newKey || newKey.length < 32) {
  console.error('Задайте RC_MASTER_KEY_NEW: новый ключ минимум 32 символа');
  process.exit(2);
}
if (oldKey === newKey) {
  console.error('Новый ключ совпадает с текущим');
  process.exit(2);
}

interface ConnectionRow {
  id: string;
  kind: 'subscription' | 'vless';
  label: string;
  secret_enc: string;
  compact_secret: string | null;
}

const db = createDb(config.DATABASE_URL);
const client = await db.pool.connect();

try {
  await client.query('begin');

  let connections = 0;
  let compactSecrets = 0;
  let subscriptions = 0;
  let totpSecrets = 0;

  const connectionRows = await client.query<ConnectionRow>(
    `select id, kind, label, secret_enc, compact_secret
       from router_connections
      order by created_at asc`,
  );
  for (const row of connectionRows.rows) {
    const value = decryptSecret(row.secret_enc, oldKey);
    const nextSecret = encryptSecret(value, newKey);

    let nextCompact: string | null = null;
    if (row.compact_secret) {
      const profile = decodeConnectionSecret(row.compact_secret, oldKey);
      nextCompact = createConnectionSecret(profile, newKey);
      compactSecrets += 1;
    }

    if (!dryRun) {
      await client.query(
        `update router_connections
            set secret_enc = $2, compact_secret = $3, updated_at = now()
          where id = $1`,
        [row.id, nextSecret, nextCompact],
      );
    }
    connections += 1;
  }

  const subscriptionRows = await client.query<{ id: string; secret_enc: string }>(
    'select id, secret_enc from subscriptions order by created_at asc',
  );
  for (const row of subscriptionRows.rows) {
    const value = decryptSecret(row.secret_enc, oldKey);
    if (!dryRun) {
      await client.query(
        'update subscriptions set secret_enc = $2, updated_at = now() where id = $1',
        [row.id, encryptSecret(value, newKey)],
      );
    }
    subscriptions += 1;
  }

  const userRows = await client.query<{ id: string; totp_secret_enc: string | null }>(
    'select id, totp_secret_enc from users where totp_secret_enc is not null',
  );
  for (const row of userRows.rows) {
    if (!row.totp_secret_enc) continue;
    const secret = decryptSecret(row.totp_secret_enc, oldKey);
    if (!dryRun) {
      await client.query('update users set totp_secret_enc = $2, updated_at = now() where id = $1', [
        row.id,
        encryptSecret(secret, newKey),
      ]);
    }
    totpSecrets += 1;
  }

  if (dryRun) {
    await client.query('rollback');
    console.info(
      `Проверка успешна: подключений ${connections}, компактных секретов ${compactSecrets}, подписок ${subscriptions}, TOTP ${totpSecrets}. Ничего не изменено.`,
    );
  } else {
    await client.query('commit');
    await audit(db.pool, {
      action: 'security.master_key_rotate',
      targetType: 'system',
      result: 'ok',
      metadata: { connections, compactSecrets, subscriptions, totpSecrets },
    });
    console.info(
      `Ключ ротирован: подключений ${connections}, компактных секретов ${compactSecrets}, подписок ${subscriptions}, TOTP ${totpSecrets}.`,
    );
    console.info('Теперь замените RC_MASTER_KEY в .env на новый и перезапустите app.');
  }
} catch (error) {
  try {
    await client.query('rollback');
  } catch {
    // ignore
  }
  console.error('Ротация ключа не выполнена:', (error as Error).message);
  process.exitCode = 1;
} finally {
  client.release();
  await db.close();
}
