import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';

const config = loadConfig();
const db = createDb(config.DATABASE_URL);

try {
  const applied = await migrate(db.pool, { dir: config.MIGRATIONS_DIR });
  console.info(
    applied.length > 0
      ? `Готово: применено миграций — ${applied.length}`
      : 'Готово: база уже актуальна',
  );
} catch (error) {
  console.error('Миграции не применены:', error);
  process.exitCode = 1;
} finally {
  await db.close();
}
