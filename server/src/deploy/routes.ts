import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { Client } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireManager, requireSuperadmin } from '../auth/service.js';
import { badRequest } from '../lib/errors.js';
import { enqueueJob } from '../jobs/queue.js';
import { createBundle, fingerprint, readBundle, type DeployManifest } from './bundle.js';
import { decodePassphraseHeader } from './passphrase.js';
import { databaseInfo, dumpDatabase, restoreDatabase, tableCounts } from './pg.js';
import { setMaintenance } from './state.js';

const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const CONFIRM_PHRASE = 'ПЕРЕНЕСТИ';

export interface DeployRouteContext {
  pool: Pool;
  masterKey: string;
  masterKeySource: 'file' | 'env';
  masterKeyFile: string;
  dataDir: string;
  databaseUrl: string;
  publicUrl: string;
  cookieSecure: string;
  appVersion: string;
  migrationsDir: string;
  log: FastifyInstance['log'];
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function passphraseFrom(request: FastifyRequest): string {
  return decodePassphraseHeader(headerValue(request, 'x-rc-passphrase'));
}

function bundleBody(request: FastifyRequest): Buffer {
  if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
    throw badRequest('bundle_required', 'Прикрепите файл переноса');
  }
  if (request.body.length > MAX_BUNDLE_BYTES) {
    throw badRequest('bundle_too_large', 'Файл переноса больше 512 МиБ');
  }
  return request.body;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '').slice(0, 15);
}

async function latestMigration(dir: string): Promise<string | null> {
  try {
    const entries = await readdir(dir);
    let max = 0;
    for (const entry of entries) {
      const match = /^(\d{4})_.*\.sql$/.exec(entry);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return max > 0 ? String(max) : null;
  } catch {
    return null;
  }
}

type Queryable = Pool | Client;

/**
 * После импорта метаданные зеркала приходят из дампа, а файлы в `rc_data`
 * могут отсутствовать (том не переносился). Возвращает число записей, для
 * которых нет файла. `prune` удаляет такие записи, чтобы UI не обещал
 * скачивание, которого не будет.
 */
async function checkMirrorFiles(
  db: Queryable,
  dataDir: string,
  prune: boolean,
): Promise<number> {
  const rows = await db.query<{ id: string; storage_path: string }>(
    'select id, storage_path from package_mirror',
  );
  let missing = 0;
  for (const row of rows.rows) {
    try {
      await stat(path.join(dataDir, row.storage_path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      missing += 1;
      if (prune) await db.query('delete from package_mirror where id = $1', [row.id]);
    }
  }
  return missing;
}

async function safetyBackups(dir: string): Promise<Array<{ name: string; size_bytes: number; at: string }>> {
  try {
    const entries = await readdir(dir);
    const result: Array<{ name: string; size_bytes: number; at: string }> = [];
    for (const entry of entries) {
      if (!entry.startsWith('pre-import-') || !entry.endsWith('.rcbackup')) continue;
      const info = await stat(path.join(dir, entry));
      result.push({ name: entry, size_bytes: info.size, at: info.mtime.toISOString() });
    }
    return result.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
  } catch {
    return [];
  }
}

async function domainInfo(publicUrl: string): Promise<{ host: string; addresses: string[]; error: string | null }> {
  let host = '';
  try {
    host = new URL(publicUrl).hostname;
  } catch {
    return { host: '', addresses: [], error: 'Некорректный RC_PUBLIC_URL' };
  }
  try {
    const addresses = await lookup(host, { all: true });
    return { host, addresses: addresses.map((item) => item.address), error: null };
  } catch (error) {
    return { host, addresses: [], error: (error as Error).message };
  }
}

export async function registerDeployRoutes(
  app: FastifyInstance,
  ctx: DeployRouteContext,
): Promise<void> {
  const { pool, masterKey, dataDir, databaseUrl } = ctx;

  app.get('/api/v1/deploy/status', async (request) => {
    requireSuperadmin(request);
    const [dbInfo, counts, migrations, backups, domain] = await Promise.all([
      databaseInfo(pool),
      tableCounts(pool),
      latestMigration(ctx.migrationsDir),
      safetyBackups(dataDir),
      domainInfo(ctx.publicUrl),
    ]);

    return {
      app_version: ctx.appVersion,
      schema_version: await (async () => {
        const result = await pool.query<{ value: { version?: number } }>(
          "select value from settings where key = 'schema_version'",
        );
        const version = result.rows[0]?.value?.version;
        return version == null ? null : String(version);
      })(),
      migrations_version: migrations,
      public_url: ctx.publicUrl,
      master_key: {
        fingerprint: fingerprint(masterKey),
        source: ctx.masterKeySource,
        file: ctx.masterKeyFile,
      },
      database: {
        ...dbInfo,
        name: (() => {
          try {
            return new URL(databaseUrl).pathname.replace(/^\//, '');
          } catch {
            return null;
          }
        })(),
      },
      counts,
      uptime_seconds: Math.round(process.uptime()),
      safety_backups: backups,
      domain,
    };
  });

  app.post(
    '/api/v1/deploy/export',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const auth = requireSuperadmin(request);
      const body = z.object({ passphrase: z.string().min(12).max(200) }).strict().parse(request.body);

      const dump = await dumpDatabase(databaseUrl);
      const [counts, dbInfo, migrations] = await Promise.all([
        tableCounts(pool),
        databaseInfo(pool),
        latestMigration(ctx.migrationsDir),
      ]);

      const bundle = createBundle({
        appVersion: ctx.appVersion,
        schemaVersion: migrations,
        publicUrl: ctx.publicUrl,
        masterKey,
        cookieSecure: ctx.cookieSecure,
        counts,
        database: dbInfo,
        dump,
        passphrase: body.passphrase,
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'deploy.export',
        targetType: 'instance',
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          size_bytes: bundle.length,
          dump_bytes: dump.length,
          counts,
          master_key_fingerprint: fingerprint(masterKey),
        },
      });

      const filename = `routx-${stamp()}.rcbackup`;
      reply
        .type('application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${filename}"`);
      return bundle;
    },
  );

  app.post(
    '/api/v1/deploy/inspect',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      bodyLimit: MAX_BUNDLE_BYTES,
    },
    async (request) => {
      requireSuperadmin(request);
      const passphrase = passphraseFrom(request);
      const { manifest } = readBundle(bundleBody(request), passphrase);
      const current = await latestMigration(ctx.migrationsDir);

      return {
        manifest,
        compatible: Number(manifest.schema_version ?? 0) <= Number(current ?? 0),
        current_migrations_version: current,
        same_domain: manifest.public_url === ctx.publicUrl,
        master_key_matches: manifest.master_key_fingerprint === fingerprint(masterKey),
      };
    },
  );

  app.post(
    '/api/v1/deploy/import',
    {
      config: { rateLimit: { max: 3, timeWindow: '10 minutes' } },
      bodyLimit: MAX_BUNDLE_BYTES,
    },
    async (request, reply) => {
      const auth = requireSuperadmin(request);
      const query = z.object({ confirm: z.string().optional() }).parse(request.query);
      if ((query.confirm ?? '').trim().toUpperCase() !== CONFIRM_PHRASE) {
        throw badRequest(
          'confirm_required',
          `Для переноса введите слово ${CONFIRM_PHRASE}`,
        );
      }

      const passphrase = passphraseFrom(request);
      const { manifest, secrets, dump } = readBundle(bundleBody(request), passphrase);
      const currentVersion = Number((await latestMigration(ctx.migrationsDir)) ?? 0);
      if (Number(manifest.schema_version ?? 0) > currentVersion) {
        throw badRequest(
          'bundle_newer',
          'Файл создан на более новой версии RoutX. Сначала обновите панель на этом сервере.',
        );
      }

      // Сначала сохраняем текущую базу: если импорт упадёт, вернём её.
      const currentDump = await dumpDatabase(databaseUrl);
      const [counts, dbInfo] = await Promise.all([tableCounts(pool), databaseInfo(pool)]);
      const safetyName = `pre-import-${stamp()}.rcbackup`;
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await writeFile(
        path.join(dataDir, safetyName),
        createBundle({
          appVersion: ctx.appVersion,
          schemaVersion: (await latestMigration(ctx.migrationsDir)) ?? null,
          publicUrl: ctx.publicUrl,
          masterKey,
          cookieSecure: ctx.cookieSecure,
          counts,
          database: dbInfo,
          dump: currentDump,
          passphrase,
        }),
        { mode: 0o600 },
      );

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'deploy.import',
        targetType: 'instance',
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          safety_file: safetyName,
          source_public_url: manifest.public_url,
          source_created_at: manifest.created_at,
          source_counts: manifest.counts,
          source_master_key_fingerprint: manifest.master_key_fingerprint,
        },
      });

      reply.code(202);
      reply.send({ ok: true, safety_file: safetyName, restart: true });

      setMaintenance('Импорт данных: сервер перезапускается');
      setTimeout(() => {
        void runImport({
          pool,
          databaseUrl,
          dataDir,
          masterKeyFile: ctx.masterKeyFile,
          masterKey,
          secrets,
          dump,
          currentDump,
          manifest,
          log: ctx.log,
        });
      }, 500);
      return reply;
    },
  );

  // Диагностика: куда сейчас указывает домен. Помогает при переезде.
  app.get('/api/v1/deploy/domain', async (request) => {
    requireSuperadmin(request);
    return domainInfo(ctx.publicUrl);
  });

  // Проверка после импорта: схема, счётчики, мастер-ключ, файлы зеркала.
  app.get('/api/v1/deploy/verify', async (request) => {
    requireSuperadmin(request);
    const [counts, migrations, backups, domain] = await Promise.all([
      tableCounts(pool),
      latestMigration(ctx.migrationsDir),
      safetyBackups(dataDir),
      domainInfo(ctx.publicUrl),
    ]);
    const versionRow = await pool.query<{ value: { version?: number } }>(
      "select value from settings where key = 'schema_version'",
    );
    const schemaVersion = versionRow.rows[0]?.value?.version ?? null;

    let mirrorRows = 0;
    let missingMirrorFiles = 0;
    try {
      const mirror = await pool.query<{ total: number }>(
        'select count(*)::int as total from package_mirror',
      );
      mirrorRows = mirror.rows[0]?.total ?? 0;
      missingMirrorFiles = await checkMirrorFiles(pool, dataDir, false);
    } catch {
      // Схема без зеркала — не считаем это ошибкой переноса.
    }

    const problems: string[] = [];
    if (String(schemaVersion ?? '') !== String(migrations ?? '')) {
      problems.push(`версия схемы ${schemaVersion ?? '—'} не совпадает с миграциями ${migrations ?? '—'}`);
    }
    if (missingMirrorFiles > 0) {
      problems.push(
        `в зеркале ${missingMirrorFiles} записей без файлов: перенесите том rc_data или запустите синхронизацию пакетов`,
      );
    }
    if (domain.error) problems.push(`домен не разрешается: ${domain.error}`);

    return {
      ok: problems.length === 0,
      problems,
      schema_version: schemaVersion == null ? null : String(schemaVersion),
      migrations_version: migrations,
      public_url: ctx.publicUrl,
      master_key: {
        fingerprint: fingerprint(masterKey),
        source: ctx.masterKeySource,
      },
      counts,
      mirror: { rows: mirrorRows, missing_files: missingMirrorFiles },
      database: await databaseInfo(pool),
      domain,
      safety_backups: backups,
      uptime_seconds: Math.round(process.uptime()),
    };
  });

  // Обновление агента на клиентских роутерах из панели.
  app.post(
    '/api/v1/deploy/agent-update',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireManager(request);
      const body = z
        .object({ router_ids: z.array(z.string().uuid()).min(1).max(100) })
        .strict()
        .parse(request.body);
      const ids = [...new Set(body.router_ids)];
      const isSuperadmin = auth.role === 'superadmin';
      const isAdmin = auth.role === 'admin';

      const routers = await pool.query<{ id: string }>(
        `select id from routers
          where id = any($1::uuid[]) and archived_at is null
            and (
              $2::boolean
              or owner_id = $3
              or ($4::boolean and owner_id in (select id from users where parent_id = $3))
            )`,
        [ids, isSuperadmin, auth.userId, isAdmin],
      );
      if (routers.rowCount !== ids.length) {
        throw badRequest('router_not_found', 'Один или несколько роутеров не найдены');
      }

      const jobs: Array<{ router_id: string; job_id: string }> = [];
      for (const router of routers.rows) {
        const job = await enqueueJob(pool, {
          type: 'agent_update',
          routerId: router.id,
          requestedBy: auth.userId,
          timeoutSeconds: 180,
          maxAttempts: 1,
          payload: {},
        });
        jobs.push({ router_id: router.id, job_id: job.id });
      }

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'deploy.agent_update',
        targetType: 'instance',
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { routers: ids, jobs: jobs.map((item) => item.job_id) },
      });

      reply.code(202);
      return { jobs };
    },
  );
}

async function runImport(args: {
  pool: Pool;
  databaseUrl: string;
  dataDir: string;
  masterKeyFile: string;
  masterKey: string;
  secrets: { master_key: string };
  dump: Buffer;
  currentDump: Buffer;
  manifest: DeployManifest;
  log: FastifyInstance['log'];
}): Promise<void> {
  try {
    // Отпускаем соединения приложения, иначе DROP в pg_restore упрётся в блокировки.
    await args.pool
      .query(
        `select pg_terminate_backend(pid)
           from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()`,
      )
      .catch(() => undefined);
    await args.pool.end();
    await new Promise((resolve) => setTimeout(resolve, 300));

    args.log.info({ source: args.manifest.public_url }, 'начинаем восстановление базы');

    await restoreDatabase(args.databaseUrl, args.dump);

    if (args.secrets.master_key && args.secrets.master_key !== args.masterKey) {
      await mkdir(path.dirname(args.masterKeyFile), { recursive: true, mode: 0o700 });
      await writeFile(args.masterKeyFile, `${args.secrets.master_key}\n`, { mode: 0o600 });
    }

    const client = new Client({ connectionString: args.databaseUrl });
    await client.connect();
    let removedMirrorRows = 0;
    try {
      removedMirrorRows = await checkMirrorFiles(client, args.dataDir, true);
      if (removedMirrorRows > 0) {
        args.log.warn(
          { removed: removedMirrorRows },
          'зеркало пакетов: удалены записи без файлов на диске',
        );
      }
    } catch (error) {
      args.log.warn({ err: error }, 'не удалось проверить файлы зеркала после импорта');
    }
    try {
      await client.query(
        `insert into audit_log (actor_role, action, result, metadata)
         values ('system', 'deploy.import_applied', 'ok', $1::jsonb)`,
        [
          JSON.stringify({
            source_public_url: args.manifest.public_url,
            source_created_at: args.manifest.created_at,
            source_counts: args.manifest.counts,
            mirror_rows_removed: removedMirrorRows,
          }),
        ],
      );
    } finally {
      await client.end().catch(() => undefined);
    }

    args.log.info(
      { source: args.manifest.public_url, counts: args.manifest.counts },
      'импорт завершён, перезапуск',
    );

    // Docker перезапустит контейнер (restart: unless-stopped), миграции
    // применятся при старте.
    setTimeout(() => process.exit(0), 300);
  } catch (error) {
    args.log.error({ err: error }, 'импорт не удался, откатываем базу');
    try {
      await restoreDatabase(args.databaseUrl, args.currentDump);
    } catch (rollbackError) {
      args.log.error({ err: rollbackError }, 'откат базы тоже не удался');
    }
    setTimeout(() => process.exit(1), 300);
  }
}
