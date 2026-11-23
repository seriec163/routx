import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import { createCommand, waitForCommand } from '../agent/service.js';
import { featureForOp, supportsFeature } from '../agent/features.js';
import { bundledAgentVersion } from '../agent/version.js';
import type { PlatformSettings } from '../settings.js';
import { isCancelRequested, type JobRow } from './queue.js';
import { JobFailure } from './errors.js';

export interface HandlerContext {
  pool: Pool;
  settings: PlatformSettings;
  log: FastifyBaseLogger;
  workerId: string;
  masterKey: string;
  publicUrl: string;
  /** Отменяется по таймауту задачи; обработчики должны прекращать ожидание. */
  signal?: AbortSignal;
}

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function requireRouter(job: JobRow): string {
  if (!job.router_id) throw new JobFailure('no_router', 'Задача не привязана к роутеру');
  return job.router_id;
}

/**
 * Prokop возвращает в лог понятную причину, но CLI-ответ при reload может быть
 * просто JSON. Добавляем подсказку для самых частых случаев.
 */
export function prokopReloadHint(message: string): string {
  if (/no enabled sections/i.test(message)) {
    return `${message}. В Prokop не осталось ни одного включённого правила: включите другое правило или добавьте источник подключения.`;
  }
  if (/has no connection/i.test(message)) {
    return `${message}. У правила «через VPN» нет источника подключения: добавьте подписку или VLESS-ссылку.`;
  }
  if (/reload_failed|config/i.test(message) && message.trim().startsWith('{')) {
    return `${message}. Prokop не перезагрузил конфигурацию: проверьте, что осталось включённое правило с источником подключения.`;
  }
  return message;
}

export async function runCommand(
  ctx: HandlerContext,
  job: JobRow,
  op: string,
  args: Json,
  timeoutMs?: number,
): Promise<Json> {
  const routerId = requireRouter(job);
  const feature = featureForOp(op);
  if (feature) {
    const versionRow = await ctx.pool.query<{ agent_version: string | null }>(
      'select agent_version from routers where id = $1',
      [routerId],
    );
    const version = versionRow.rows[0]?.agent_version ?? null;
    if (!supportsFeature(version, feature)) {
      throw new JobFailure(
        'agent_outdated',
        `Агент RoutX${version ? ` ${version}` : ''} не поддерживает ${feature.label}. ` +
          `Нужна версия ${feature.minVersion} или новее — обновите агент.`,
      );
    }
  }
  const effectiveTimeout = timeoutMs ?? Math.max(15_000, job.timeout_seconds * 1000 - 5_000);
  const command = await createCommand(ctx.pool, {
    routerId,
    jobId: job.id,
    op,
    args,
    settings: ctx.settings,
    ttlSeconds: Math.ceil(effectiveTimeout / 1000) + 120,
    masterKey: ctx.masterKey,
  });

  const outcome = await waitForCommand(ctx.pool, command.id, {
    timeoutMs: effectiveTimeout,
    isCancelled: () => isCancelRequested(ctx.pool, job.id),
    signal: ctx.signal,
  });

  if (outcome.status === 'cancelled') {
    throw new JobFailure('cancelled', 'Задача отменена', 'cancelled');
  }
  if (outcome.status === 'timeout') {
    throw new JobFailure('agent_timeout', 'Агент не ответил вовремя', 'timeout');
  }
  if (outcome.status !== 'success') {
    throw new JobFailure(
      outcome.error?.code ?? 'agent_failed',
      outcome.error?.message ?? 'Агент сообщил об ошибке',
    );
  }
  return asRecord(outcome.result);
}

/** Обновляет фазу задачи для прогресс-бара в интерфейсе. */
export async function setJobPhase(
  ctx: HandlerContext,
  jobId: string,
  phase: string,
  progress?: number,
): Promise<void> {
  const value = progress == null ? { phase } : { phase, progress };
  await ctx.pool
    .query(
      `update jobs set result = coalesce(result, '{}'::jsonb) || $2::jsonb where id = $1`,
      [jobId, JSON.stringify(value)],
    )
    .catch(() => undefined);
}

export async function agentVersionOf(
  ctx: HandlerContext,
  routerId: string,
): Promise<string | null> {
  const row = await ctx.pool.query<{ agent_version: string | null }>(
    'select agent_version from routers where id = $1',
    [routerId],
  );
  return row.rows[0]?.agent_version ?? null;
}

/**
 * Ждёт, пока роутер пришлёт новую версию агента после self_update. Успехом
 * считаем и смену версии, и совпадение с версией из образа панели: агент мог
 * уже быть последним, тогда переустановка ничего не меняет.
 */
export async function waitForAgentVersion(
  ctx: HandlerContext,
  routerId: string,
  previous: string | null,
  timeoutMs: number,
): Promise<string | null> {
  const expected = bundledAgentVersion();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ctx.signal?.aborted) return null;
    const current = await agentVersionOf(ctx, routerId);
    if (current && (current !== previous || (expected !== null && current === expected))) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}
