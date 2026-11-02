import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Pool } from 'pg';

const run = promisify(execFile);

export interface PgTarget {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

export function parseDatabaseUrl(value: string): PgTarget {
  const url = new URL(value);
  const database = url.pathname.replace(/^\//, '');
  if (!database) throw new Error('DATABASE_URL без имени базы данных');
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

function pgEnv(target: PgTarget): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: target.host,
    PGPORT: target.port,
    PGUSER: target.user,
    PGPASSWORD: target.password,
    PGDATABASE: target.database,
    PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'routx-deploy',
  };
}

/** Логический дамп базы в формате custom (pg_dump). */
export async function dumpDatabase(databaseUrl: string): Promise<Buffer> {
  const target = parseDatabaseUrl(databaseUrl);
  const tmp = `/tmp/rc-dump-${randomBytes(8).toString('hex')}.dump`;
  try {
    await run(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-privileges', '--file', tmp],
      { env: pgEnv(target), maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60 * 1000 },
    );
    return await readFile(tmp);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/**
 * Полная замена базы: --clean --if-exists в одной транзакции.
 * При ошибке PostgreSQL откатывает всё, база остаётся прежней.
 */
export async function restoreDatabase(databaseUrl: string, dump: Buffer): Promise<void> {
  const target = parseDatabaseUrl(databaseUrl);
  const tmp = `/tmp/rc-restore-${randomBytes(8).toString('hex')}.dump`;
  await writeFile(tmp, dump, { mode: 0o600 });
  try {
    await run(
      'pg_restore',
      [
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-privileges',
        '--single-transaction',
        '--dbname',
        target.database,
        tmp,
      ],
      { env: pgEnv(target), maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 },
    );
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

export interface DatabaseInfo {
  size_bytes: number;
  server_version: string;
}

export async function databaseInfo(pool: Pool): Promise<DatabaseInfo> {
  const result = await pool.query<{ size: string; version: string }>(
    `select pg_database_size(current_database())::text as size,
            current_setting('server_version') as version`,
  );
  const row = result.rows[0];
  return {
    size_bytes: Number(row?.size ?? 0),
    server_version: row?.version ?? 'unknown',
  };
}

export async function tableCounts(pool: Pool): Promise<Record<string, number>> {
  const result = await pool.query<{
    users: string;
    routers: string;
    templates: string;
    subscriptions: string;
    jobs: string;
    audit: string;
  }>(
    `select
       (select count(*) from users)::text as users,
       (select count(*) from routers)::text as routers,
       (select count(*) from templates)::text as templates,
       (select count(*) from subscriptions)::text as subscriptions,
       (select count(*) from jobs)::text as jobs,
       (select count(*) from audit_log)::text as audit`,
  );
  const row = result.rows[0];
  return {
    users: Number(row?.users ?? 0),
    routers: Number(row?.routers ?? 0),
    templates: Number(row?.templates ?? 0),
    subscriptions: Number(row?.subscriptions ?? 0),
    jobs: Number(row?.jobs ?? 0),
    audit: Number(row?.audit ?? 0),
  };
}
