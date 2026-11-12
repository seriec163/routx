import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { audit } from '../audit.js';
import { requireUser } from '../auth/service.js';
import { notFound } from '../lib/errors.js';
import { enqueueJob, jobJson } from '../jobs/queue.js';
import { assertOnline, getRouter } from '../routers/service.js';
import { loadSettings } from '../settings.js';

interface RouteContext {
  pool: Pool;
}

export async function registerMonitoringRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): Promise<void> {
  const { pool } = ctx;

  app.get('/api/v1/monitoring/overview', async (request) => {
    const auth = requireUser(request);
    const scope = auth.role === 'superadmin' ? null : auth.userId;

    const routers = await pool.query(
      `select r.id, r.name, r.status, r.product, r.product_version, r.agent_version,
              r.sing_box_version, r.last_seen_at, r.last_error, r.monitoring_enabled,
              a.offline_since, a.online_since,
              s.health, s.proxy_health, s.latency_ms, s.failed_tags, s.total_tags, s.ts,
              s.detail, s.service_state, s.direct_ip, s.vpn_ip,
              r.owner_id, u.email as owner_email,
              nullif(btrim(concat_ws(' ', u.last_name, u.first_name, u.middle_name)), '') as owner_name
         from routers r
         left join users u on u.id = r.owner_id
         left join router_availability a on a.router_id = r.id
         left join lateral (
           select health, proxy_health, latency_ms, failed_tags, total_tags, ts, detail, service_state,
                  direct_ip, vpn_ip
             from monitoring_samples ms where ms.router_id = r.id
            order by ts desc limit 1
         ) s on true
        where r.archived_at is null and ($1::uuid is null or r.owner_id = $1)
        order by r.name`,
      [scope],
    );

    const items = routers.rows.map((row) => ({
      ...row,
      detail:
        row.detail && typeof row.detail === 'object' && 'detail' in row.detail
          ? (row.detail as { detail?: unknown }).detail ?? null
          : null,
    }));
    const summary = {
      total: items.length,
      online: items.filter((row) => row.status === 'online').length,
      offline: items.filter((row) => row.status === 'offline').length,
      pending: items.filter((row) => row.status === 'pending').length,
      conflict: items.filter((row) => row.status === 'conflict').length,
      unsupported: items.filter((row) => row.status === 'unsupported').length,
      proxy_healthy: items.filter((row) => row.proxy_health === 'healthy').length,
      proxy_degraded: items.filter((row) => row.proxy_health === 'degraded').length,
      proxy_dead: items.filter((row) => row.proxy_health === 'dead').length,
    };

    return { summary, items };
  });

  app.post(
    '/api/v1/routers/:id/monitor',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const router = await getRouter(pool, auth, params.id);
      assertOnline(router);

      const job = await enqueueJob(pool, {
        type: 'monitor',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 60,
        maxAttempts: 1,
        idempotencyKey: `manual_monitor:${router.id}:${Date.now()}`,
        // Ручной тест должен мерить заново, а не отдавать кэш агента.
        payload: { force: true },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'monitor.check',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { job_id: job.id },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );

  app.post(
    '/api/v1/routers/:id/sites/check',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireUser(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          targets: z.array(z.string().trim().url().max(512)).min(1).max(8),
        })
        .strict()
        .parse(request.body);

      const router = await getRouter(pool, auth, params.id);
      assertOnline(router);
      const targets = [...new Set(body.targets)];

      const job = await enqueueJob(pool, {
        type: 'site_check',
        routerId: router.id,
        requestedBy: auth.userId,
        timeoutSeconds: 120,
        maxAttempts: 1,
        payload: { targets },
      });

      await audit(pool, {
        actorId: auth.userId,
        actorRole: auth.role,
        action: 'router.sites_check',
        targetType: 'router',
        targetId: router.id,
        routerId: router.id,
        result: 'ok',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: { targets: targets.length, job_id: job.id },
      });

      reply.code(202);
      return { job: jobJson(job) };
    },
  );

  app.get('/api/v1/routers/:id/connection-losses', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z
      .object({ hours: z.coerce.number().int().min(1).max(168).default(24) })
      .parse(request.query);

    await getRouter(pool, auth, params.id);

    const settings = await loadSettings(pool);
    // Соседние неудачные замеры считаем одним эпизодом, пока между ними
    // не пропущено больше трёх интервалов мониторинга.
    const gapSeconds = Math.max(180, settings.monitoring.intervalSeconds * 3);

    const result = await pool.query(
      `with samples as (
         select ts, coalesce(detail->'failed_tag_names', '[]'::jsonb) as failed
           from monitoring_samples
          where router_id = $1
            and ts > now() - ($2::int * interval '1 hour')
            and detail ? 'failed_tag_names'
            and reachable
            and proxy_health is distinct from 'unknown'
       ),
       totals as (select count(*)::int as samples from samples),
       tags as (
         select distinct t.value as tag
           from samples s
           cross join lateral jsonb_array_elements_text(s.failed) as t(value)
       ),
       series as (
         select s.ts, t.tag,
                exists (
                  select 1
                    from jsonb_array_elements_text(s.failed) as f(value)
                   where f.value = t.tag
                ) as bad
           from samples s
           cross join tags t
       ),
       marked as (
         select tag, ts, bad,
                lag(bad) over (partition by tag order by ts) as prev_bad,
                lag(ts) over (partition by tag order by ts) as prev_ts
           from series
       ),
       episodes as (
         select tag,
                count(*) filter (
                  where bad and (
                    coalesce(prev_bad, false) = false
                    or ts - prev_ts > ($3::int * interval '1 second')
                  )
                )::int as losses,
                count(*) filter (where bad)::int as failed_samples,
                max(ts) filter (where bad) as last_failure
           from marked
          group by tag
       )
       select e.tag, e.losses, e.failed_samples, t.samples as total_samples, e.last_failure
         from episodes e cross join totals t
        order by e.losses desc, e.failed_samples desc, e.tag
        limit 10`,
      [params.id, query.hours, gapSeconds],
    );

    const latest = await pool.query<{ failed: string[] | null }>(
      `select detail->'failed_tag_names' as failed
         from monitoring_samples
        where router_id = $1 and detail ? 'failed_tag_names'
        order by ts desc limit 1`,
      [params.id],
    );
    const downNow = new Set(latest.rows[0]?.failed ?? []);

    return {
      hours: query.hours,
      items: result.rows.map((row) => ({
        ...row,
        down_now: downNow.has(row.tag as string),
      })),
    };
  });

  app.get('/api/v1/routers/:id/metrics', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z
      .object({
        hours: z.coerce.number().int().min(1).max(720).default(24),
        granularity: z.enum(['raw', 'hour', 'day']).default('raw'),
      })
      .parse(request.query);

    await getRouter(pool, auth, params.id);

    if (query.granularity === 'raw') {
      const result = await pool.query(
        `select ts, reachable, service_state, health, proxy_health, latency_ms,
                failed_tags, total_tags, sing_box_version, direct_ip, vpn_ip
           from monitoring_samples
          where router_id = $1 and ts > now() - ($2 || ' hours')::interval
          order by ts asc
          limit 5000`,
        [params.id, query.hours],
      );
      return { granularity: 'raw', items: result.rows };
    }

    const result = await pool.query(
      `select bucket_start, samples, reachable_pct, avg_latency_ms, p95_latency_ms, unhealthy_pct
         from monitoring_rollups
        where router_id = $1 and granularity = $2
          and bucket_start > now() - ($3 || ' hours')::interval
        order by bucket_start asc`,
      [params.id, query.granularity, query.hours],
    );
    return { granularity: query.granularity, items: result.rows };
  });

  app.get('/api/v1/routers/:id/availability', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await getRouter(pool, auth, params.id);

    const result = await pool.query(
      `select offline_since, online_since, last_transition, misses from router_availability where router_id = $1`,
      [params.id],
    );

    const daily = await pool.query(
      `select bucket_start, reachable_pct, samples
         from monitoring_rollups
        where router_id = $1 and granularity = 'day'
        order by bucket_start desc limit 30`,
      [params.id],
    );

    return { availability: result.rows[0] ?? null, daily: daily.rows };
  });

  app.get('/api/v1/routers/:id/diagnostics/latest', async (request) => {
    const auth = requireUser(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    await getRouter(pool, auth, params.id);
    const result = await pool.query(
      `select id, kind, product, agent_version, sha256, size_bytes, created_at, expires_at
         from diagnostics_reports where router_id = $1 order by created_at desc limit 1`,
      [params.id],
    );
    if (!result.rows[0]) throw notFound('Диагностических отчётов пока нет');
    return { report: result.rows[0] };
  });
}
