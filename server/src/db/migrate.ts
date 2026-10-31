import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Pool } from 'pg';

export interface MigrateOptions {
  dir?: string;
  info?: (message: string) => void;
}

const MIGRATION_FILE = /^\d{3,}_[a-z0-9_-]+\.sql$/i;

/**
 * Простой детерминированный SQL-runner: файлы migrations/NNN_name.sql
 * применяются по возрастанию имени, каждый — в отдельной транзакции.
 * Повторный запуск безопасен: применённые файлы пропускаются.
 */
export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<string[]> {
  const dir = options.dir ?? fileURLToPath(new URL('../../migrations', import.meta.url));
  const info = options.info ?? ((message) => console.info(message));

  await pool.query(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const lock = await pool.connect();
  const appliedNow: string[] = [];

  try {
    await lock.query('select pg_advisory_lock(hashtext($1)::bigint)', [
      'router-control:migrations',
    ]);

    const files = (await readdir(dir)).filter((file) => MIGRATION_FILE.test(file)).sort();
    const applied = new Set(
      (await lock.query<{ name: string }>('select name from schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(path.join(dir, file), 'utf8');
      const client = await pool.connect();

      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        appliedNow.push(file);
        info(`применена миграция ${file}`);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`миграция ${file} не применена: ${(error as Error).message}`, {
          cause: error,
        });
      } finally {
        client.release();
      }
    }

    if (appliedNow.length === 0) info('новых миграций нет');
  } finally {
    await lock.query('select pg_advisory_unlock(hashtext($1)::bigint)', [
      'router-control:migrations',
    ]);
    lock.release();
  }

  return appliedNow;
}
