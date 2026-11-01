import type { Pool } from 'pg';
import type { PlatformSettings } from '../settings.js';

export interface RetentionSummary {
  monitoring_samples: number;
  monitoring_rollups: number;
  diagnostics_reports: number;
  jobs: number;
  job_events: number;
  audit_log: number;
  notifications: number;
  agent_commands: number;
  nonces: number;
  sessions: number;
  mfa_tickets: number;
  router_snapshots: number;
  agent_reports: number;
  invites: number;
  mobile_tokens: number;
}

const DAY = ' days';

/**
 * Политика хранения (максимум 30 дней для метрик, отчётов, задач и аудита).
 * Снимки: сохраняются последние N на роутер, но не дольше общего срока.
 */
export async function runRetention(
  pool: Pool,
  settings: PlatformSettings,
): Promise<RetentionSummary> {
  const days = Math.min(30, Math.max(1, settings.retention.days));
  const commandDays = Math.min(7, Math.max(1, settings.retention.commandsDays));
  const keepSnapshots = Math.max(1, settings.retention.snapshotsLocal);

  const summary: RetentionSummary = {
    monitoring_samples: 0,
    monitoring_rollups: 0,
    diagnostics_reports: 0,
    jobs: 0,
    job_events: 0,
    audit_log: 0,
    notifications: 0,
    agent_commands: 0,
    nonces: 0,
    sessions: 0,
    mfa_tickets: 0,
    router_snapshots: 0,
    agent_reports: 0,
    invites: 0,
    mobile_tokens: 0,
  };

  const run = async (
    key: keyof RetentionSummary,
    sql: string,
    values: unknown[],
  ): Promise<void> => {
    try {
      const result = await pool.query(sql, values);
      summary[key] += result.rowCount ?? 0;
    } catch {
      // Отдельная таблица может отсутствовать на промежуточной миграции.
    }
  };

  await run('monitoring_samples', `delete from monitoring_samples where ts < now() - ($1 || '${DAY}')::interval`, [days]);
  await run('monitoring_rollups', `delete from monitoring_rollups where bucket_start < now() - interval '180 days'`, []);
  await run('diagnostics_reports', 'delete from diagnostics_reports where expires_at < now()', []);
  await run('agent_reports', `delete from agent_reports where created_at < now() - ($1 || '${DAY}')::interval`, [days]);

  await run('job_events', `delete from job_events where job_id in (
      select id from jobs where status in ('success','failed','cancelled','timeout')
        and finished_at < now() - ($1 || '${DAY}')::interval
    )`, [days]);
  await run('jobs', `delete from jobs where status in ('success','failed','cancelled','timeout')
      and finished_at < now() - ($1 || '${DAY}')::interval`, [days]);

  await run('audit_log', `delete from audit_log where at < now() - ($1 || '${DAY}')::interval`, [days]);
  // История приглашений: использованные и истёкшие ссылки храним не дольше
  // общего retention. Активные приглашения не удаляем.
  await run('invites', `delete from invites
      where (used_at is not null or expires_at < now())
        and created_at < now() - ($1 || '${DAY}')::interval`, [days]);
  await run('notifications', `delete from notifications where read_at is not null
      and created_at < now() - ($1 || '${DAY}')::interval`, [days]);

  await run('agent_commands', `delete from agent_commands
      where status in ('acked','failed','expired')
        and coalesce(acked_at, created_at) < now() - ($1 || '${DAY}')::interval`, [commandDays]);

  await run('nonces', `delete from nonces where seen_at < now() - interval '10 minutes'`, []);
  await run('sessions', `delete from sessions where expires_at < now() - interval '7 days'
      or (revoked_at is not null and revoked_at < now() - interval '7 days')`, []);
  await run('mfa_tickets', `delete from mfa_tickets where expires_at < now() - interval '1 day'`, []);
  await run('mobile_tokens', `delete from mobile_tokens
      where (used_at is not null or expires_at < now())
        and created_at < now() - interval '1 day'`, []);

  await run('router_snapshots', `delete from router_snapshots rs
      where rs.id in (
        select id from (
          select id, row_number() over (partition by router_id order by created_at desc) as rn
            from router_snapshots
        ) ranked where ranked.rn > $1
      )
      or rs.expires_at < now()`, [keepSnapshots]);

  return summary;
}
