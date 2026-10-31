import type { Pool } from 'pg';

/** Свёртка сырых замеров в часовые и суточные бакеты. Идемпотентна. */
export async function rollupMonitoring(pool: Pool): Promise<{ hours: number; days: number }> {
  const hours = await pool.query(
    `insert into monitoring_rollups
       (router_id, bucket_start, granularity, samples, reachable_pct, avg_latency_ms,
        p95_latency_ms, unhealthy_pct)
     select router_id, date_trunc('hour', ts) as bucket_start, 'hour',
            count(*)::int,
            round(100.0 * count(*) filter (where reachable) / count(*), 2),
            round(avg(latency_ms))::int,
            percentile_disc(0.95) within group (order by latency_ms)::int,
            round(100.0 * count(*) filter (where proxy_health in ('degraded','dead')) / count(*), 2)
       from monitoring_samples
      where ts >= date_trunc('hour', now()) - interval '3 hours'
        and ts < date_trunc('hour', now())
      group by router_id, date_trunc('hour', ts)
     on conflict (router_id, granularity, bucket_start) do update
       set samples = excluded.samples, reachable_pct = excluded.reachable_pct,
           avg_latency_ms = excluded.avg_latency_ms, p95_latency_ms = excluded.p95_latency_ms,
           unhealthy_pct = excluded.unhealthy_pct`,
  );

  const days = await pool.query(
    `insert into monitoring_rollups
       (router_id, bucket_start, granularity, samples, reachable_pct, avg_latency_ms,
        p95_latency_ms, unhealthy_pct)
     select router_id, date_trunc('day', ts) as bucket_start, 'day',
            count(*)::int,
            round(100.0 * count(*) filter (where reachable) / count(*), 2),
            round(avg(latency_ms))::int,
            percentile_disc(0.95) within group (order by latency_ms)::int,
            round(100.0 * count(*) filter (where proxy_health in ('degraded','dead')) / count(*), 2)
       from monitoring_samples
      where ts >= date_trunc('day', now()) - interval '3 days'
        and ts < date_trunc('day', now())
      group by router_id, date_trunc('day', ts)
     on conflict (router_id, granularity, bucket_start) do update
       set samples = excluded.samples, reachable_pct = excluded.reachable_pct,
           avg_latency_ms = excluded.avg_latency_ms, p95_latency_ms = excluded.p95_latency_ms,
           unhealthy_pct = excluded.unhealthy_pct`,
  );

  return { hours: hours.rowCount ?? 0, days: days.rowCount ?? 0 };
}
