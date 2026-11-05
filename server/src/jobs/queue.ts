import type { Pool, PoolClient } from 'pg';
import { badRequest } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';

export type JobStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'timeout';
export type JobType =
  | 'precheck'
  | 'refresh_state'
  | 'diff'
  | 'diff_custom'
  | 'diff_podkop'
  | 'podkop_outbound'
  | 'proxy_select'
  | 'apply'
  | 'read_rules'
  | 'monitor'
  | 'access_check'
  | 'site_check'
  | 'agent_update'
  | 'product_switch'
  | 'remove_packages'
  | 'diagnostics'
  | 'snapshot'
  | 'restore'
  | 'sb_check'
  | 'sb_versions'
  | 'sb_install'
  | 'service_action'
  | 'reboot'
  | 'dns_benchmark'
  | 'connections_apply'
  | 'list_connections'
  | 'manage_connection'
  | 'section_delete'
  | 'rollout'
  | 'retention'
  | 'reconcile';

export interface JobRow {
  id: string;
  type: JobType;
  router_id: string | null;
  batch_id: string | null;
  requested_by: string | null;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attempt: number;
  max_attempts: number;
  timeout_seconds: number;
  idempotency_key: string | null;
  scheduled_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: Date;
}

export interface EnqueueInput {
  type: JobType;
  routerId?: string | null;
  batchId?: string | null;
  requestedBy?: string | null;
  priority?: number;
  payload?: Record<string, unknown>;
  timeoutSeconds?: number;
  maxAttempts?: number;
  idempotencyKey?: string | null;
  scheduledAt?: Date;
}

export function jobJson(row: JobRow & { events?: unknown[] }) {
  return {
    id: row.id,
    type: row.type,
    router_id: row.router_id,
    batch_id: row.batch_id,
    requested_by: row.requested_by,
    status: row.status,
    priority: row.priority,
    payload: row.payload,
    result: row.result,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    timeout_seconds: row.timeout_seconds,
    scheduled_at: row.scheduled_at.toISOString(),
    started_at: row.started_at?.toISOString() ?? null,
    finished_at: row.finished_at?.toISOString() ?? null,
    error: row.error_code
      ? { code: row.error_code, message: row.error_detail ?? row.error_code }
      : null,
    created_at: row.created_at.toISOString(),
    events: row.events,
  };
}

export async function enqueueJob(pool: Pool, input: EnqueueInput): Promise<JobRow> {
  const key = input.idempotencyKey ?? null;

  if (key) {
    const existing = await pool.query<JobRow>('select * from jobs where idempotency_key = $1', [key]);
    if (existing.rows[0]) return existing.rows[0];
  }

  const result = await pool.query<JobRow>(
    `insert into jobs
       (id, type, router_id, batch_id, requested_by, priority, payload, timeout_seconds,
        max_attempts, idempotency_key, scheduled_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
     on conflict do nothing
     returning *`,
    [
      uuidv7(),
      input.type,
      input.routerId ?? null,
      input.batchId ?? null,
      input.requestedBy ?? null,
      input.priority ?? 100,
      JSON.stringify(input.payload ?? {}),
      input.timeoutSeconds ?? 120,
      input.maxAttempts ?? 3,
      key,
      input.scheduledAt ?? new Date(),
    ],
  );

  if (result.rows[0]) {
    await addJobEvent(pool, result.rows[0].id, 'queued', null, 'Задача поставлена в очередь');
    return result.rows[0];
  }

  const fallback = await pool.query<JobRow>('select * from jobs where idempotency_key = $1', [key]);
  if (!fallback.rows[0]) throw badRequest('job_not_created', 'Не удалось создать задачу');
  return fallback.rows[0];
}

export async function addJobEvent(
  pool: Pool | PoolClient,
  jobId: string,
  status: JobStatus | null,
  code: string | null,
  message: string | null,
  data?: unknown,
): Promise<void> {
  await pool.query(
    `insert into job_events (job_id, seq, status, code, message, data)
     select $1, coalesce(max(seq),0) + 1, $2, $3, $4, $5::jsonb from job_events where job_id = $1`,
    [jobId, status, code, message, data === undefined ? null : JSON.stringify(data)],
  );
}

export async function claimJob(
  pool: Pool,
  workerId: string,
  leaseSeconds: number,
): Promise<JobRow | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const candidate = await client.query<{ id: string }>(
      `select j.id
         from jobs j
        where j.status = 'queued'
          and j.scheduled_at <= now()
          and (j.next_retry_at is null or j.next_retry_at <= now())
          and (
            j.type = 'monitor'
            or not exists (
              select 1 from jobs active
               where active.router_id = j.router_id
                 and active.status = 'running'
                 and active.type <> 'monitor'
            )
          )
        order by j.priority asc, j.scheduled_at asc
        limit 1
        for update skip locked`,
    );

    const id = candidate.rows[0]?.id;
    if (!id) {
      await client.query('commit');
      return null;
    }

    const claimed = await client.query<JobRow>(
      `update jobs
          set status = 'running',
              attempt = attempt + 1,
              started_at = coalesce(started_at, now()),
              lease_owner = $2,
              lease_expires_at = now() + ($3 || ' seconds')::interval
        where id = $1
        returning *`,
      [id, workerId, leaseSeconds],
    );
    await client.query('commit');

    const job = claimed.rows[0]!;
    await addJobEvent(pool, job.id, 'running', null, 'Задача выполняется', {
      worker: workerId,
      attempt: job.attempt,
    });
    return job;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function renewLease(pool: Pool, jobId: string, seconds: number): Promise<void> {
  await pool.query(
    `update jobs set lease_expires_at = now() + ($2 || ' seconds')::interval
      where id = $1 and status = 'running'`,
    [jobId, seconds],
  );
}

export async function finishJob(
  pool: Pool,
  jobId: string,
  status: Exclude<JobStatus, 'queued' | 'running'>,
  result?: unknown,
  error?: { code: string; message: string } | null,
): Promise<void> {
  await pool.query(
    `update jobs
        set status = $2, result = $3::jsonb, finished_at = now(),
            lease_owner = null, lease_expires_at = null,
            error_code = $4, error_detail = $5
      where id = $1 and status = 'running'`,
    [
      jobId,
      status,
      result === undefined ? null : JSON.stringify(result),
      error?.code ?? null,
      error?.message ?? null,
    ],
  );
  await addJobEvent(
    pool,
    jobId,
    status,
    error?.code ?? null,
    error?.message ?? (status === 'success' ? 'Задача завершена' : null),
  );
}

export async function requeueJob(
  pool: Pool,
  jobId: string,
  attempt: number,
  delaySeconds: number,
  error: { code: string; message: string },
): Promise<void> {
  await pool.query(
    `update jobs
        set status = 'queued', lease_owner = null, lease_expires_at = null,
            next_retry_at = now() + ($2 || ' seconds')::interval,
            error_code = $3, error_detail = $4
      where id = $1 and status = 'running'`,
    [jobId, delaySeconds, error.code, error.message],
  );
  await addJobEvent(pool, jobId, 'queued', error.code, `${error.message} (попытка ${attempt})`);
}

export async function requestCancel(pool: Pool, job: JobRow): Promise<void> {
  if (job.status === 'queued') {
    await pool.query(
      `update jobs set status = 'cancelled', finished_at = now(), error_code = 'cancelled',
              error_detail = 'Отменено пользователем' where id = $1 and status = 'queued'`,
      [job.id],
    );
    await addJobEvent(pool, job.id, 'cancelled', 'cancelled', 'Отменено до запуска');
    return;
  }
  if (job.status === 'running') {
    if (job.type === 'apply' || job.type === 'restore' || job.type === 'sb_install') {
      throw badRequest(
        'cannot_cancel_running_mutation',
        'Операцию изменения конфигурации нельзя прервать на середине. Дождитесь завершения или таймаута.',
      );
    }
    await addJobEvent(pool, job.id, null, 'cancel_requested', 'Запрошена отмена задачи');
    return;
  }
  throw badRequest('job_finished', 'Задача уже завершена');
}

export async function isCancelRequested(pool: Pool, jobId: string): Promise<boolean> {
  const result = await pool.query(
    `select 1 from job_events where job_id = $1 and code = 'cancel_requested' limit 1`,
    [jobId],
  );
  return Boolean(result.rows[0]);
}

export async function timeoutStaleJobs(pool: Pool): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `update jobs
        set status = 'timeout', finished_at = now(),
            error_code = 'lease_expired', error_detail = 'Исполнитель потерял задачу'
      where status = 'running' and lease_expires_at < now()
      returning id`,
  );
  for (const row of result.rows as { id: string }[]) {
    await addJobEvent(pool, row.id, 'timeout', 'lease_expired', 'Исполнитель потерял задачу');
  }
  await markDependentState(
    pool,
    (result.rows as { id: string }[]).map((row) => row.id),
    'lease_expired',
    'Задача потеряла исполнителя; проверьте состояние роутера и при необходимости восстановите снимок',
  );
  return result.rowCount ?? 0;
}

/**
 * Завершает задачи, оставшиеся в running от предыдущего процесса сервера.
 * Без этого после рестарта роутер до 10 минут ждёт освобождения очереди,
 * хотя команда агента уже выполнена. Сами изменения не откатываются
 * автоматически: для apply выставляется needs_attention, чтобы оператор
 * проверил состояние и при необходимости восстановил снимок.
 */
export async function recoverOrphanedJobs(pool: Pool, currentWorkerId: string): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `update jobs
        set status = 'timeout', finished_at = now(),
            error_code = 'orphaned_after_restart',
            error_detail = 'Сервер перезапущен во время выполнения задачи; проверьте состояние роутера и при необходимости восстановите снимок',
            lease_owner = null, lease_expires_at = null
      where status = 'running'
        and (lease_owner is null or lease_owner <> $1)
      returning id`,
    [currentWorkerId],
  );
  const ids = (result.rows as { id: string }[]).map((row) => row.id);
  for (const id of ids) {
    await addJobEvent(
      pool,
      id,
      'timeout',
      'orphaned_after_restart',
      'Сервер перезапущен во время выполнения задачи',
    );
  }
  await markDependentState(
    pool,
    ids,
    'orphaned_after_restart',
    'Сервер перезапущен во время выполнения задачи; проверьте состояние роутера и при необходимости восстановите снимок',
  );
  return ids.length;
}

async function markDependentState(
  pool: Pool,
  jobIds: string[],
  code: string,
  detail: string,
): Promise<void> {
  if (jobIds.length === 0) return;

  await pool.query(
    `update apply_runs ar
        set status = 'needs_attention', finished_at = now(),
            error_code = $2, error_detail = $3
       from jobs j
      where j.id = any($1::uuid[])
        and j.type = 'apply'
        and j.payload ? 'apply_run_id'
        and ar.id = (j.payload->>'apply_run_id')::uuid
        and ar.status in ('queued','running')`,
    [jobIds, code, detail],
  );

  await pool.query(
    `update rollout_targets rt
        set status = 'failed', finished_at = now(), error_code = $2
       from jobs j
      where j.id = any($1::uuid[])
        and j.type = 'sb_install'
        and j.payload ? 'rollout_id'
        and rt.rollout_id = (j.payload->>'rollout_id')::uuid
        and rt.router_id = j.router_id
        and rt.status in ('pending','installing','verifying')`,
    [jobIds, code],
  );
}

export async function getJob(pool: Pool, id: string): Promise<(JobRow & { events: unknown[] }) | null> {
  const result = await pool.query<JobRow>('select * from jobs where id = $1', [id]);
  const job = result.rows[0];
  if (!job) return null;
  const events = await pool.query(
    `select seq, at, status, code, message, data from job_events where job_id = $1 order by seq asc`,
    [id],
  );
  return { ...job, events: events.rows };
}
