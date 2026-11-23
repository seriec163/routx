import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type AppDatabase = NodePgDatabase<typeof schema>;

export interface AppDb {
  ping(): Promise<void>;
  getSchemaVersion(): Promise<string | null>;
}

export interface DbHandle extends AppDb {
  pool: Pool;
  db: AppDatabase;
  close(): Promise<void>;
}

export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'router-control',
  });

  const db = drizzle(pool, { schema });

  // Idle-соединения могут быть завершены сервером (например, при импорте базы).
  // Без обработчика pg выбрасывает необработанное событие и роняет процесс.
  pool.on('error', (error) => {
    console.error('Соединение с PostgreSQL оборвалось:', error.message);
  });

  return {
    pool,
    db,
    async ping() {
      await pool.query('select 1');
    },
    async getSchemaVersion() {
      const rows = await db
        .select({ value: schema.settings.value })
        .from(schema.settings)
        .where(eq(schema.settings.key, 'schema_version'))
        .limit(1);

      const version = rows[0]?.value?.version;
      if (version === undefined || version === null) return null;
      return String(version);
    },
    async close() {
      await pool.end();
    },
  };
}
