import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { PlatformSettings } from '../settings.js';
import {
  claimJob,
  finishJob,
  renewLease,
  requeueJob,
  timeoutStaleJobs,
  type JobRow,
} from './queue.js';
import { HANDLERS, JobFailure, type HandlerContext } from './handlers.js';
import { expireCommands } from '../agent/service.js';
import { runRetention } from '../retention/service.js';

export interface WorkerOptions {
  pool: Pool;
  settings: PlatformSettings;
  log: FastifyBaseLogger;
  workerId?: string;
  pollIntervalMs?: number;
  leaseSeconds?: number;
  masterKey: string;
}

const RETRYABLE = new Set(['agent_timeout', 'agent_unavailable', 'internal_error', 'db_error']);

/** Фоновый исполнитель задач: один цикл забирает одну задачу. */
export class JobWorker {
  private readonly pool: Pool;
  private settings: PlatformSettings;
  private readonly log: FastifyBaseLogger;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseSeconds: number;
  private readonly masterKey: string;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;

  constructor(options: WorkerOptions) {
    this.pool = options.pool;
    this.settings = options.settings;
    this.log = options.log;
    this.workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.leaseSeconds = options.leaseSeconds ?? 600;
    this.masterKey = options.masterKey;
  }

  updateSettings(settings: PlatformSettings): void {
    this.settings = settings;
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopped = false;
    this.loopPromise = this.loop();
    this.schedulerTimer = setInterval(() => {
      void this.scheduleMonitoring().catch((error) =>
        this.log.warn({ err: error }, 'не удалось запланировать мониторинг'),
      );
    }, 5_000);
    this.maintenanceTimer = setInterval(() => {
      void this.maintenance().catch((error) =>
        this.log.warn({ err: error }, 'ошибка обслуживания'),
      );
    }, 10 * 60_000);

    void this.scheduleMonitoring().catch(() => undefined);
    void this.maintenance().catch(() => undefined);
    this.log.info({ worker: this.workerId }, 'исполнитель задач запущен');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.schedulerTimer = null;
    this.maintenanceTimer = null;
    await this.loopPromise;
    this.loopPromise = null;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let job: JobRow | null = null;
      try {
        job = await claimJob(this.pool, this.workerId, this.leaseSeconds);
      } catch (error) {
        this.log.error({ err: error }, 'не удалось забрать задачу');
      }

      if (!job) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      await this.execute(job);
    }
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = HANDLERS[job.type];
    if (!handler) {
      await finishJob(this.pool, job.id, 'failed', null, {
        code: 'unsupported_job',
        message: `Тип задачи «${job.type}» не поддерживается`,
      });
      return;
    }

    const context: HandlerContext = {
      pool: this.pool,
      settings: this.settings,
      log: this.log,
      workerId: this.workerId,
      masterKey: this.masterKey,
    };

    const renew = setInterval(() => {
      void renewLease(this.pool, job.id, this.leaseSeconds).catch(() => undefined);
    }, 30_000);

    this.log.info({ job: job.id, type: job.type, attempt: job.attempt }, 'задача выполняется');

    try {
      const result = await withTimeout(
        handler(context, job),
        Math.max(10_000, job.timeout_seconds * 1000),
      );
      await finishJob(this.pool, job.id, 'success', result);
      this.log.info({ job: job.id, type: job.type }, 'задача завершена');
    } catch (error) {
      const failure =
        error instanceof JobFailure
          ? error
          : new JobFailure('internal_error', (error as Error).message.slice(0, 500));

      if (failure.terminal === 'cancelled') {
        await finishJob(this.pool, job.id, 'cancelled', null, {
          code: failure.code,
          message: failure.message,
        });
      } else if (failure.terminal === 'timeout') {
        await finishJob(this.pool, job.id, 'timeout', null, {
          code: failure.code,
          message: failure.message,
        });
      } else if (
        RETRYABLE.has(failure.code) &&
        job.attempt < job.max_attempts &&
        job.type !== 'apply' &&
        job.type !== 'sb_install' &&
        job.type !== 'restore'
      ) {
        await requeueJob(this.pool, job.id, job.attempt, 15 * job.attempt, {
          code: failure.code,
          message: failure.message,
        });
      } else {
        await finishJob(this.pool, job.id, 'failed', null, {
          code: failure.code,
          message: failure.message,
        });
      }
      this.log.warn({ job: job.id, code: failure.code, err: failure.message }, 'задача не выполнена');
    } finally {
      clearInterval(renew);
    }
  }

  /** Ставит мониторинговые задачи со сдвигом фазы на каждом роутере. */
  private async scheduleMonitoring(): Promise<void> {
    const interval = this.settings.monitoring.intervalSeconds;
    const stagger = Math.max(0, this.settings.monitoring.staggerSeconds);
    const staleAfter = interval * this.settings.monitoring.offlineAfterMisses;

    // 1. Пропущенные пульсы: агент не выходит на связь.
    const stale = await this.pool.query<{ id: string; owner_id: string; status: string }>(
      `update routers r
          set status = 'offline', updated_at = now()
        where r.status = 'online'
          and r.archived_at is null
          and r.last_seen_at is not null
          and r.last_seen_at < now() - ($1 || ' seconds')::interval
        returning r.id, r.owner_id, r.status`,
      [staleAfter],
    );

    for (const router of stale.rows) {
      await this.pool.query(
        `insert into router_availability (router_id, offline_since, online_since, last_transition)
         values ($1, now(), null, now())
         on conflict (router_id) do update
           set offline_since = coalesce(router_availability.offline_since, now()),
               online_since = null, last_transition = now()`,
        [router.id],
      );
      const { notify } = await import('../notifications.js');
      await notify(this.pool, {
        userId: router.owner_id,
        routerId: router.id,
        kind: 'router.offline',
        severity: 'critical',
        message: 'Роутер не выходит на связь дольше допустимого времени',
        dedupeKey: `offline:${router.id}:${new Date().toISOString().slice(0, 13)}`,
      });
    }

    // 2. Новая задача мониторинга на текущий интервал (не более одной).
    await this.pool.query(
      `insert into jobs (id, type, router_id, status, payload, timeout_seconds, idempotency_key, scheduled_at)
       select gen_random_uuid(), 'monitor', r.id, 'queued', '{}'::jsonb, 45,
              'monitor:' || r.id || ':' || floor(extract(epoch from now()) / $1),
              to_timestamp(floor(extract(epoch from now()) / $1) * $1
                           + (abs(hashtext(r.id::text)) % greatest(1, least($1::int, $2::int))))
         from routers r
        where r.monitoring_enabled
          and r.archived_at is null
          and r.status in ('online','offline')
          and not exists (
            select 1 from jobs j
             where j.router_id = r.id and j.type = 'monitor'
               and j.status in ('queued','running')
               and j.created_at > now() - interval '90 seconds'
          )
       on conflict (idempotency_key) where idempotency_key is not null do nothing`,
      [interval, stagger],
    );

    await this.pool.query(
      `update jobs set status = 'timeout', finished_at = now(),
              error_code = 'lease_expired', error_detail = 'Задача не была выполнена вовремя'
        where status = 'queued' and created_at < now() - interval '2 hours'`,
    );

    await timeoutStaleJobs(this.pool);
    await expireCommands(this.pool);
  }

  private async maintenance(): Promise<void> {
    await runRetention(this.pool, this.settings);
    const { rollupMonitoring } = await import('../monitoring/service.js');
    await rollupMonitoring(this.pool);
    const { loadSettings } = await import('../settings.js');
    this.settings = await loadSettings(this.pool);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new JobFailure('job_timeout', 'Задача превысила допустимое время выполнения', 'timeout'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
