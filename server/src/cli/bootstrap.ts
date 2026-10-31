import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { ensureBootstrapAdmin } from '../bootstrap.js';

const config = loadConfig();
const email = process.argv[2] ?? process.env.RC_BOOTSTRAP_EMAIL;
const password = process.argv[3] ?? process.env.RC_BOOTSTRAP_PASSWORD;

if (!email || !password) {
  console.error(
    'Использование: npm run bootstrap -- <email> <password>\n' +
      'Либо задайте RC_BOOTSTRAP_EMAIL и RC_BOOTSTRAP_PASSWORD.',
  );
  process.exit(2);
}

const db = createDb(config.DATABASE_URL);
try {
  const result = await ensureBootstrapAdmin(db.pool, { email, password });
  if (result.created) {
    console.info(`Создан суперадминистратор ${result.email}. Включите 2FA при первом входе.`);
  } else {
    console.info(
      result.reason === 'users_exist'
        ? 'Пользователи уже существуют — bootstrap пропущен.'
        : 'Bootstrap не выполнен: не заданы учётные данные.',
    );
  }
} catch (error) {
  console.error('Ошибка bootstrap:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
