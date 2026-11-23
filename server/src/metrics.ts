import { timingSafeEqual } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export interface MetricsContext {
  pool: Pool;
  dataDir: string;
  token?: string;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function line(name: string, help: string, type: 'gauge' | 'counter', samples: Array<[Record<string, string>, number]>): string {
  const rows = [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    ...samples.map(([labels, value]) => {
      const rendered = Object.entries(labels)
        .map(([key, label]) => `${key}="${escapeLabel(label)}"`)
        .join(',');
      return `${name}${rendered ? `{${rendered}}` : ''} ${value}`;
    }),
  ];
  return rows.join('\n');
}

export async function collectMetrics(pool: Pool, dataDir: string): Promise<string> {
  const [routerStatus, jobStatus, failedByType, oldest, dbSize] = await Promise.all([
    pool.query<{ status: string; count: number }>(
      'select status, count(*)::int as count from routers where archived_at is null group by status',
    ),
    pool.query<{ status: string; count: number }>(
      'select status, count(*)::int as count from jobs group by status',
    ),
    pool.query<{ type: string; count: number }>(
      `select type, count(*)::int as count
         from jobs
        where status = 'failed' and created_at > now() - interval '24 hours'
        group by type`,
    ),
    pool.query<{ seconds: number | null }>(
      'select extract(epoch from now() - min(created_at))::int as seconds from jobs where status = $1',
      ['queued'],
    ),
    pool.query<{ bytes: string }>('select pg_database_size(current_database())::text as bytes'),
  ]);

  let diskFree: number | null = null;
  let diskTotal: number | null = null;
  try {
    const info = await statfs(dataDir);
    diskFree = Number(info.bavail) * Number(info.bsize);
    diskTotal = Number(info.blocks) * Number(info.bsize);
  } catch {
    // Каталог данных может быть недоступен в тестах/локально.
  }

  const blocks: string[] = [];
  blocks.push(
    line(
      'routx_routers',
      'Роутеры по статусу',
      'gauge',
      routerStatus.rows.map((row) => [{ status: row.status }, row.count]),
    ),
  );
  blocks.push(
    line(
      'routx_jobs',
      'Задачи по статусу',
      'gauge',
      jobStatus.rows.map((row) => [{ status: row.status }, row.count]),
    ),
  );
  blocks.push(
    line(
      'routx_jobs_failed_24h',
      'Неуспешные задачи за 24 часа по типу',
      'gauge',
      failedByType.rows.map((row) => [{ type: row.type }, row.count]),
    ),
  );
  blocks.push(
    line('routx_jobs_oldest_queued_seconds', 'Возраст самой старой задачи в очереди', 'gauge', [
      [{}, oldest.rows[0]?.seconds ?? 0],
    ]),
  );
  blocks.push(
    line('routx_db_size_bytes', 'Размер базы данных', 'gauge', [
      [{}, Number(dbSize.rows[0]?.bytes ?? 0)],
    ]),
  );
  if (diskFree !== null && diskTotal !== null) {
    blocks.push(
      line('routx_disk_free_bytes', 'Свободно на разделе с данными', 'gauge', [[{}, diskFree]]),
    );
    blocks.push(line('routx_disk_total_bytes', 'Размер раздела с данными', 'gauge', [[{}, diskTotal]]));
  }
  const online = routerStatus.rows.find((row) => row.status === 'online')?.count ?? 0;
  blocks.push(line('routx_routers_online', 'Роутеров онлайн', 'gauge', [[{}, online]]));
  blocks.push(
    line('routx_uptime_seconds', 'Время работы процесса', 'gauge', [[{}, Math.round(process.uptime())]]),
  );
  blocks.push(
    line('routx_process_memory_bytes', 'RSS процесса', 'gauge', [[{}, process.memoryUsage().rss]]),
  );
  return `${blocks.join('\n\n')}\n`;
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  const prefix = 'Bearer ';
  if (!header?.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

export function registerMetricsRoute(app: FastifyInstance, ctx: MetricsContext): void {
  app.get('/metrics', { config: { public: true } }, async (request, reply) => {
    if (ctx.token && !tokenMatches(ctx.token, request.headers.authorization)) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const body = await collectMetrics(ctx.pool, ctx.dataDir);
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return body;
  });
}
