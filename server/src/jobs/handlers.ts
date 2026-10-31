import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import { maskSecrets, sha256Hex, decryptSecret } from '../lib/crypto.js';
import { uuidv7 } from '../lib/ids.js';
import { sanitizeReport } from '../audit.js';
import {
  computePlan,
  creatableSections,
  diffHash,
  applySectionMap,
  mapTemplateSections,
  sanitizeAgentState,
  stateHash,
  templatePayloadSchema,
  validateExclusions,
  type DiffItem,
  type RouterListExtras,
  type TemplatePayload,
  type UciValue,
} from '../domain/uci.js';
import type { PlatformSettings } from '../settings.js';
import { createCommand, waitForCommand } from '../agent/service.js';
import { isCancelRequested } from './queue.js';
import type { JobRow } from './queue.js';
import { notifyRouterOwner } from '../notifications.js';

export class JobFailure extends Error {
  readonly code: string;
  readonly terminal: 'failed' | 'timeout' | 'cancelled';

  constructor(code: string, message: string, terminal: 'failed' | 'timeout' | 'cancelled' = 'failed') {
    super(message);
    this.name = 'JobFailure';
    this.code = code;
    this.terminal = terminal;
  }
}

export interface HandlerContext {
  pool: Pool;
  settings: PlatformSettings;
  log: FastifyBaseLogger;
  workerId: string;
  masterKey: string;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireRouter(job: JobRow): string {
  if (!job.router_id) throw new JobFailure('no_router', 'Задача не привязана к роутеру');
  return job.router_id;
}

async function runCommand(
  ctx: HandlerContext,
  job: JobRow,
  op: string,
  args: Json,
  timeoutMs?: number,
): Promise<Json> {
  const routerId = requireRouter(job);
  const command = await createCommand(ctx.pool, {
    routerId,
    jobId: job.id,
    op,
    args,
    settings: ctx.settings,
  });

  const outcome = await waitForCommand(ctx.pool, command.id, {
    timeoutMs: timeoutMs ?? Math.max(15_000, job.timeout_seconds * 1000 - 5_000),
    isCancelled: () => isCancelRequested(ctx.pool, job.id),
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

async function saveState(
  pool: Pool,
  routerId: string,
  raw: Json,
  source: string,
): Promise<Record<string, UciValue>> {
  const managed = sanitizeAgentState(raw.managed ?? raw);
  const hash = stateHash(managed);

  await pool.query(
    `insert into router_state (router_id, managed, state_hash, health, service, capabilities, collected_at, source)
     values ($1,$2::jsonb,$3,$4::jsonb,$5::jsonb,$6::jsonb, now(), $7)
     on conflict (router_id) do update
       set managed = excluded.managed, state_hash = excluded.state_hash,
           health = coalesce(excluded.health, router_state.health),
           service = coalesce(excluded.service, router_state.service),
           capabilities = coalesce(excluded.capabilities, router_state.capabilities),
           collected_at = now(), source = excluded.source`,
    [
      routerId,
      JSON.stringify(managed),
      hash,
      JSON.stringify(raw.health ?? null),
      JSON.stringify(raw.service ?? null),
      JSON.stringify(raw.capabilities ?? null),
      source,
    ],
  );

  return managed;
}

async function readState(
  ctx: HandlerContext,
  job: JobRow,
  timeoutMs?: number,
): Promise<Record<string, UciValue>> {
  const raw = await runCommand(ctx, job, 'read_state', {}, timeoutMs);
  return saveState(ctx.pool, requireRouter(job), raw, 'command');
}

export async function loadListExtras(pool: Pool, routerId: string): Promise<RouterListExtras> {
  const result = await pool.query<{ list_extras: unknown }>(
    'select list_extras from routers where id = $1',
    [routerId],
  );
  const raw = result.rows[0]?.list_extras;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as RouterListExtras) : {};
}

async function loadRevision(
  pool: Pool,
  templateId: string,
  revision: number,
): Promise<{ payload: TemplatePayload; exclusions: string[] }> {
  const result = await pool.query<{ payload: unknown; exclusions: unknown }>(
    'select payload, exclusions from template_revisions where template_id = $1 and revision = $2',
    [templateId, revision],
  );
  const row = result.rows[0];
  if (!row) throw new JobFailure('revision_missing', 'Ревизия шаблона не найдена');
  return {
    payload: templatePayloadSchema.parse(row.payload),
    exclusions: validateExclusions(Array.isArray(row.exclusions) ? row.exclusions.map(String) : []),
  };
}

export async function refreshState(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const managed = await readState(ctx, job);
  const drift = await recomputeDrift(ctx.pool, routerId, managed);
  return { paths: Object.keys(managed).length, state_hash: stateHash(managed), drift };
}

export async function recomputeDrift(
  pool: Pool,
  routerId: string,
  current: Record<string, UciValue>,
): Promise<Record<string, string>> {
  const assignments = await pool.query<{
    template_id: string;
    revision: number;
    payload: unknown;
    exclusions: unknown;
  }>(
    `select a.template_id, a.revision, r.payload, r.exclusions
       from template_assignments a
       join template_revisions r on r.template_id = a.template_id and r.revision = a.revision
       join templates t on t.id = a.template_id and t.archived_at is null
      where a.router_id = $1`,
    [routerId],
  );

  const result: Record<string, string> = {};
  const extras = await loadListExtras(pool, routerId);
  for (const assignment of assignments.rows) {
    try {
      const payload = templatePayloadSchema.parse(assignment.payload);
      const exclusions = Array.isArray(assignment.exclusions)
        ? assignment.exclusions.map(String)
        : [];
      const mapped = mapTemplateSections(payload, current);
      const plan = computePlan(mapped.payload, current, exclusions, extras);
      const drift = plan.items.length === 0 ? 'in_sync' : 'drift';
      result[assignment.template_id] = drift;
      await pool.query(
        `update template_assignments
            set drift = $3, last_checked_at = now(), desired_hash = $4,
                applied_hash = case when $3 = 'in_sync' then $4 else applied_hash end,
                applied_at = case when $3 = 'in_sync' then now() else applied_at end
          where router_id = $1 and template_id = $2`,
        [routerId, assignment.template_id, drift, plan.desiredHash],
      );
    } catch {
      result[assignment.template_id] = 'incompatible';
      await pool.query(
        `update template_assignments set drift = 'incompatible', last_checked_at = now()
          where router_id = $1 and template_id = $2`,
        [routerId, assignment.template_id],
      );
    }
  }
  return result;
}

export async function diffTemplate(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const templateId = asString(job.payload.template_id);
  const revision = asNumber(job.payload.revision);
  if (!templateId || revision === null) {
    throw new JobFailure('invalid_payload', 'Не указан шаблон или ревизия');
  }

  const { payload, exclusions } = await loadRevision(ctx.pool, templateId, revision);
  const current = await readState(ctx, job);
  const provided = asRecord(job.payload.section_map ?? {});
  const providedMap = Object.fromEntries(
    Object.entries(provided).filter(([, value]) => typeof value === 'string'),
  ) as Record<string, string>;

  let mapped;
  if (Object.keys(providedMap).length > 0) {
    for (const target of Object.values(providedMap)) {
      const exists = Object.keys(current).some((path) => path.startsWith(`section.${target}.`));
      if (!exists) {
        throw new JobFailure(
          'section_missing',
          `Секция «${target}» из сопоставления не найдена на роутере. Прочитайте состояние или измените сопоставление.`,
        );
      }
    }
    try {
      mapped = {
        payload: applySectionMap(payload, providedMap),
        sectionMap: providedMap,
        warnings: [],
      };
    } catch (error) {
      throw new JobFailure('section_map_invalid', (error as Error).message.slice(0, 500));
    }
  } else {
    mapped = mapTemplateSections(payload, current);
  }

  const extras = await loadListExtras(ctx.pool, routerId);
  const plan = computePlan(mapped.payload, current, exclusions, extras);
  const items = plan.items;
  const hash = diffHash(items);
  const baseHash = stateHash(current);
  const desiredHash = plan.desiredHash;

  const runId = uuidv7();
  await ctx.pool.query(
    `insert into apply_runs
       (id, router_id, template_id, revision, diff, diff_hash, base_state_hash, desired_hash,
        local_lists, section_map, status, requested_by)
     values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,'awaiting_confirmation',$11)`,
    [
      runId,
      routerId,
      templateId,
      revision,
      JSON.stringify(items),
      hash,
      baseHash,
      desiredHash,
      JSON.stringify(plan.localLists),
      JSON.stringify(mapped.sectionMap),
      job.requested_by,
    ],
  );

  let seq = 1;
  for (const item of items) {
    await ctx.pool.query(
      `insert into apply_items (apply_run_id, seq, op, path, value_before, value_after)
       values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [
        runId,
        seq++,
        item.op,
        item.path,
        item.before === null ? null : JSON.stringify(item.before),
        item.after === null ? null : JSON.stringify(item.after),
      ],
    );
  }

  const counts = {
    add: items.filter((item) => item.op === 'add').length,
    change: items.filter((item) => item.op === 'change').length,
    delete: items.filter((item) => item.op === 'delete').length,
  };

  await recomputeDrift(ctx.pool, routerId, current);

  return {
    apply_run_id: runId,
    diff_hash: hash,
    base_state_hash: baseHash,
    desired_hash: desiredHash,
    counts,
    total: items.length,
    section_map: mapped.sectionMap,
    warnings: mapped.warnings,
  };
}

function expectedState(items: DiffItem[]): Map<string, UciValue> {
  const expected = new Map<string, UciValue>();
  for (const item of items) {
    if (item.after !== null) expected.set(item.path, item.after);
  }
  return expected;
}

function verifyApplied(expected: Map<string, UciValue>, current: Record<string, UciValue>): string[] {
  const mismatched: string[] = [];
  for (const [path, value] of expected) {
    const actual = current[path];
    if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(value)) {
      mismatched.push(path);
    }
  }
  return mismatched;
}

export async function applyRun(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const applyRunId = asString(job.payload.apply_run_id);
  if (!applyRunId) throw new JobFailure('invalid_payload', 'Не указан идентификатор применения');

  const runResult = await ctx.pool.query<{
    id: string;
    router_id: string;
    template_id: string | null;
    revision: number | null;
    diff: unknown;
    diff_hash: string;
    base_state_hash: string | null;
    desired_hash: string | null;
    local_lists: unknown;
    status: string;
    backup_ok: boolean;
  }>('select * from apply_runs where id = $1', [applyRunId]);
  const run = runResult.rows[0];
  if (!run) throw new JobFailure('apply_run_missing', 'Применение не найдено');
  if (run.router_id !== routerId) throw new JobFailure('apply_run_mismatch', 'Применение относится к другому роутеру');
  if (run.status !== 'awaiting_confirmation' && run.status !== 'queued') {
    throw new JobFailure('apply_run_state', `Применение уже в состоянии «${run.status}»`);
  }

  const items = Array.isArray(run.diff) ? (run.diff as DiffItem[]) : [];
  await ctx.pool.query(
    `update apply_runs set status = 'running', started_at = now(), confirmed_at = coalesce(confirmed_at, now())
      where id = $1`,
    [applyRunId],
  );

  // 1. Обязательный снимок перед любыми изменениями.
  let snapshotRef: string | null = null;
  try {
    const snapshot = await runCommand(ctx, job, 'snapshot_create', { reason: 'apply' }, 90_000);
    snapshotRef =
      asString(snapshot.external_id) ?? asString(snapshot.id) ?? `local-${Date.now()}`;
    await ctx.pool.query(
      `insert into router_snapshots
         (id, router_id, kind, external_id, reason, sha256, size_bytes, product_version, expires_at)
       values ($1,$2,$3,$4,'apply',$5,$6,$7, now() + ($8 || ' days')::interval)`,
      [
        uuidv7(),
        routerId,
        asString(snapshot.kind) === 'native' ? 'native' : 'local',
        snapshotRef,
        asString(snapshot.sha256),
        asNumber(snapshot.size_bytes),
        asString(snapshot.product_version),
        ctx.settings.retention.days,
      ],
    );
    await ctx.pool.query(
      'update apply_runs set snapshot_ref = $2, backup_ok = true where id = $1',
      [applyRunId, snapshotRef],
    );
  } catch (error) {
    await ctx.pool.query(
      `update apply_runs set status = 'failed', finished_at = now(),
              error_code = 'backup_failed', error_detail = $2
        where id = $1`,
      [applyRunId, (error as Error).message.slice(0, 500)],
    );
    throw new JobFailure(
      'backup_failed',
      `Не удалось создать резервный снимок, изменения не применены: ${(error as Error).message}`,
    );
  }

  // 2. Запись UCI с проверкой базового состояния на агенте.
  try {
    let createSections: string[] = [];
    if (run.template_id && run.revision !== null) {
      const revision = await loadRevision(ctx.pool, run.template_id, run.revision);
      createSections = creatableSections(revision.payload);
    }
    await runCommand(
      ctx,
      job,
      'apply_uci',
      {
        items,
        base_state_hash: run.base_state_hash,
        create_sections: createSections,
        local_lists: Array.isArray(run.local_lists) ? run.local_lists : [],
      },
      Math.max(60_000, job.timeout_seconds * 1000 - 10_000),
    );

    // 3. Перезагрузка и проверка результата чтением состояния.
    await runCommand(ctx, job, 'reload', {}, 90_000);
    const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
    const current = await saveState(ctx.pool, routerId, raw, 'verify');
    const mismatched = verifyApplied(expectedState(items), current);

    if (mismatched.length > 0) {
      throw new JobFailure(
        'verify_mismatch',
        `После применения не совпадают параметры: ${mismatched.slice(0, 5).join(', ')}`,
      );
    }

    await ctx.pool.query(
      `update apply_runs set status = 'success', finished_at = now(), error_code = null, error_detail = null
        where id = $1`,
      [applyRunId],
    );
    await ctx.pool.query(
      `update apply_items set result = 'ok' where apply_run_id = $1`,
      [applyRunId],
    );
    if (run.template_id && run.desired_hash) {
      await ctx.pool.query(
        `update template_assignments
            set applied_hash = $3, applied_at = now(), drift = 'in_sync', last_checked_at = now()
          where router_id = $1 and template_id = $2`,
        [routerId, run.template_id, run.desired_hash],
      );
    }

    await notifyRouterOwner(ctx.pool, routerId, {
      kind: 'apply.success',
      severity: 'info',
      message: `Конфигурация применена: ${items.length} изменений`,
      dedupeKey: `apply:${applyRunId}`,
    });

    return {
      apply_run_id: applyRunId,
      applied: items.length,
      snapshot: snapshotRef,
      verified: true,
    };
  } catch (error) {
    const failure =
      error instanceof JobFailure
        ? error
        : new JobFailure('apply_failed', (error as Error).message.slice(0, 500));
    await ctx.pool.query(
      `update apply_items set result = 'failed', error_code = $2 where apply_run_id = $1`,
      [applyRunId, failure.code],
    );

    let rollback: 'ok' | 'failed' | 'skipped' = 'skipped';
    let rollbackError: string | null = null;
    if (snapshotRef) {
      try {
        await runCommand(ctx, job, 'snapshot_restore', { snapshot: snapshotRef, kind: 'local' }, 180_000);
        await runCommand(ctx, job, 'reload', {}, 90_000);
        const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
        await saveState(ctx.pool, routerId, raw, 'rollback');
        rollback = 'ok';
      } catch (restoreError) {
        rollback = 'failed';
        rollbackError = (restoreError as Error).message.slice(0, 500);
      }
    }

    const status = rollback === 'ok' ? 'rolled_back' : rollback === 'failed' ? 'rollback_failed' : 'needs_attention';
    await ctx.pool.query(
      `update apply_runs set status = $2, finished_at = now(), error_code = $3, error_detail = $4
        where id = $1`,
      [applyRunId, status, failure.code, failure.message.slice(0, 500)],
    );

    await notifyRouterOwner(ctx.pool, routerId, {
      kind: rollback === 'ok' ? 'apply.rolled_back' : 'apply.failed',
      severity: 'critical',
      message:
        rollback === 'ok'
          ? `Применение не удалось и было откачено: ${failure.message}`
          : `Применение не удалось (${failure.message}). Требуется ручная проверка.`,
      dedupeKey: `apply:${applyRunId}:${status}`,
    });

    // Задача должна завершиться failed, даже если откат прошёл успешно.
    throw new JobFailure(
      failure.code,
      `${failure.message} (${rollback === 'ok' ? 'изменения откачены' : rollback === 'failed' ? `откат не удался: ${rollbackError ?? 'ошибка'}` : 'требуется ручная проверка'})`,
      failure.terminal,
    );
  }
}

function proxyHealthOf(sample: Json, settings: PlatformSettings): 'healthy' | 'degraded' | 'dead' | 'unknown' {
  const explicit = asString(sample.proxy_health);
  if (explicit === 'healthy' || explicit === 'degraded' || explicit === 'dead') {
    const explicitLatency = asNumber(sample.latency_ms);
    if (
      explicit === 'healthy' &&
      explicitLatency !== null &&
      explicitLatency > settings.monitoring.latencyDegradedMs
    ) {
      return 'degraded';
    }
    return explicit;
  }
  const failed = asNumber(sample.failed_tags) ?? 0;
  const total = asNumber(sample.total_tags) ?? 0;
  const latency = asNumber(sample.latency_ms);
  if (total > 0 && failed >= total) return 'dead';
  if (failed >= 1) return 'degraded';
  if (latency !== null && latency > settings.monitoring.latencyDegradedMs) return 'degraded';
  return total > 0 ? 'healthy' : 'unknown';
}

export async function monitorProbe(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const raw = await runCommand(ctx, job, 'monitor_probe', {}, 45_000);

  const reachable = raw.reachable !== false;
  const proxyHealth = proxyHealthOf(raw, ctx.settings);
  const serviceHealth = asString(raw.health) || asString(raw.service_state) || null;
  const latency = asNumber(raw.latency_ms);
  const failed = asNumber(raw.failed_tags);
  const total = asNumber(raw.total_tags);

  await ctx.pool.query(
    `insert into monitoring_samples
       (router_id, ts, reachable, service_state, health, proxy_health, latency_ms,
        failed_tags, total_tags, sing_box_version, agent_version, detail)
     values ($1, now(), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     on conflict (router_id, ts) do nothing`,
    [
      routerId,
      reachable,
      asString(raw.service_state),
      serviceHealth,
      proxyHealth,
      latency,
      failed,
      total,
      asString(raw.sing_box_version),
      asString(raw.agent_version),
      JSON.stringify(asString(raw.detail ?? null) ? { detail: raw.detail } : {}),
    ],
  );

  await ctx.pool.query(
    `update routers set sing_box_version = coalesce($2, sing_box_version), updated_at = now()
      where id = $1`,
    [routerId, asString(raw.sing_box_version)],
  );

  if (!reachable) {
    const availability = await ctx.pool.query<{ misses: number; offline_since: Date | null }>(
      `insert into router_availability (router_id, misses, last_transition)
       values ($1, 1, now())
       on conflict (router_id) do update
         set misses = router_availability.misses + 1, last_transition = now()
       returning misses, offline_since`,
      [routerId],
    );
    const misses = availability.rows[0]?.misses ?? 1;
    if (misses >= ctx.settings.monitoring.offlineAfterMisses) {
      const changed = await ctx.pool.query(
        `update router_availability
            set offline_since = coalesce(offline_since, now()), online_since = null
          where router_id = $1 and offline_since is null`,
        [routerId],
      );
      await ctx.pool.query(`update routers set status = 'offline', updated_at = now() where id = $1`, [
        routerId,
      ]);
      if ((changed.rowCount ?? 0) > 0) {
        await notifyRouterOwner(ctx.pool, routerId, {
          kind: 'router.offline',
          severity: 'critical',
          message: 'Роутер недоступен: пропущено подряд проверок — ' + misses,
          dedupeKey: `offline:${routerId}:${new Date().toISOString().slice(0, 13)}`,
        });
      }
    }
  } else {
    const changed = await ctx.pool.query(
      `insert into router_availability (router_id, online_since, misses, last_transition)
       values ($1, now(), 0, now())
       on conflict (router_id) do update
         set online_since = now(), offline_since = null, misses = 0, last_transition = now()
       returning (xmax = 0) as inserted`,
      [routerId],
    );
    void changed;
    await ctx.pool.query(
      `update routers set status = 'online', updated_at = now()
        where id = $1 and status in ('offline','pending')`,
      [routerId],
    );
  }

  return {
    reachable,
    service_health: serviceHealth,
    proxy_health: proxyHealth,
    latency_ms: latency,
    failed_tags: failed,
    total_tags: total,
  };
}

export async function accessCheck(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const target =
    asString(job.payload.target) || 'https://www.youtube.com/generate_204';
  const raw = await runCommand(ctx, job, 'access_check', { target }, 45_000);

  if (raw.ok === false) {
    throw new JobFailure(
      asString(raw.error) || 'access_check_failed',
      asString(raw.message) || 'Запрос через прокси не прошёл',
    );
  }

  return {
    ok: true,
    target: asString(raw.target) || target,
    proxy_tag: asString(raw.proxy_tag),
    group: asString(raw.group),
    latency_ms: asNumber(raw.latency_ms),
  };
}

export async function diagnostics(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const kind = job.payload.kind === 'full' ? 'full' : 'quick';
  const op = kind === 'full' ? 'diagnostics_full' : 'diagnostics_quick';
  const raw = await runCommand(ctx, job, op, {}, kind === 'full' ? 180_000 : 90_000);

  const router = await ctx.pool.query<{ product: string; agent_version: string | null }>(
    'select product, agent_version from routers where id = $1',
    [routerId],
  );

  const report = sanitizeReport(raw.report ?? raw) as Json;
  const text = asString(raw.text);
  const sanitizedText = text ? maskSecrets(text).slice(0, 1_000_000) : null;
  const json = JSON.stringify(report);
  const digest = sha256Hex(json + (sanitizedText ?? ''));

  const id = uuidv7();
  await ctx.pool.query(
    `insert into diagnostics_reports
       (id, router_id, job_id, kind, product, agent_version, report, report_text, sha256, size_bytes, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10, now() + ($11 || ' days')::interval)`,
    [
      id,
      routerId,
      job.id,
      kind,
      router.rows[0]?.product ?? 'unknown',
      router.rows[0]?.agent_version,
      JSON.stringify(report),
      sanitizedText,
      digest,
      Buffer.byteLength(json + (sanitizedText ?? ''), 'utf8'),
      ctx.settings.retention.days,
    ],
  );

  return { report_id: id, kind, sha256: digest };
}

export async function snapshot(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const reason = asString(job.payload.reason) ?? 'manual';
  const raw = await runCommand(ctx, job, 'snapshot_create', { reason }, 120_000);

  const externalId = asString(raw.external_id) ?? asString(raw.id);
  const id = uuidv7();
  await ctx.pool.query(
    `insert into router_snapshots
       (id, router_id, kind, external_id, reason, sha256, size_bytes, product_version, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' days')::interval)`,
    [
      id,
      routerId,
      asString(raw.kind) === 'native' ? 'native' : 'local',
      externalId,
      reason,
      asString(raw.sha256),
      asNumber(raw.size_bytes),
      asString(raw.product_version),
      ctx.settings.retention.days,
    ],
  );

  return { snapshot_id: id, external_id: externalId };
}

export async function restoreSnapshot(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const snapshotId = asString(job.payload.snapshot_id);
  if (!snapshotId) throw new JobFailure('invalid_payload', 'Не указан снимок');

  const found = await ctx.pool.query<{
    external_id: string | null;
    kind: string;
  }>('select external_id, kind from router_snapshots where id = $1 and router_id = $2', [
    snapshotId,
    routerId,
  ]);
  const snap = found.rows[0];
  if (!snap) throw new JobFailure('snapshot_missing', 'Снимок не найден');

  await runCommand(
    ctx,
    job,
    'snapshot_restore',
    { snapshot: snap.external_id ?? snapshotId, kind: snap.kind },
    180_000,
  );
  await runCommand(ctx, job, 'reload', {}, 90_000);
  const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
  await saveState(ctx.pool, routerId, raw, 'restore');

  return { restored: snapshotId };
}

export async function singBoxCheck(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const raw = await runCommand(ctx, job, 'sb_check_update', {}, 120_000);
  const routerId = requireRouter(job);
  const version = asString(raw.version) ?? asString(raw.current_version);
  const variant = asString(raw.variant);
  if (version || variant) {
    await ctx.pool.query(
      `update routers set
          sing_box_version = coalesce($2, sing_box_version),
          sing_box_variant = coalesce($3, sing_box_variant),
          updated_at = now()
        where id = $1`,
      [routerId, version, variant],
    );
  }

  return {
    current_version: asString(raw.current_version) ?? version,
    latest_version: asString(raw.latest_version),
    status: asString(raw.status),
    release_url: asString(raw.release_url),
    message: asString(raw.message),
    variant,
  };
}

export async function singBoxInstall(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const variant = asString(job.payload.variant);
  const versionTag = asString(job.payload.version_tag);
  if (!variant && !versionTag) {
    throw new JobFailure('invalid_payload', 'Не указан вариант или версия sing-box');
  }

  const normalizeVersion = (value: string | null | undefined): string =>
    (value ?? '').trim().replace(/-r\d+$/, '');
  const normalizeVariant = (value: string | null | undefined): string =>
    (value ?? '').trim().replace(/-/g, '_');

  const before = await ctx.pool.query<{
    sing_box_version: string | null;
    sing_box_variant: string | null;
  }>('select sing_box_version, sing_box_variant from routers where id = $1', [routerId]);
  let previous = before.rows[0]?.sing_box_version ?? null;
  let previousVariant = before.rows[0]?.sing_box_variant ?? null;

  // Сверяемся с фактическим бинарником перед удалением: БД может быть
  // устаревшей, а без точной предыдущей версии откат будет неполным.
  try {
    const current = await runCommand(ctx, job, 'verify', {}, 20_000);
    const actualVersion = asString(current.version);
    const actualVariant = asString(current.variant);
    if (actualVersion) previous = actualVersion;
    if (actualVariant) previousVariant = actualVariant;
  } catch (error) {
    ctx.log.warn({ err: error, routerId }, 'не удалось прочитать текущую версию sing-box перед установкой');
  }
  const timeout = 300_000;

  try {
    const installed = await runCommand(
      ctx,
      job,
      'sb_install',
      { variant, version_tag: versionTag },
      timeout,
    );

    await runCommand(ctx, job, 'reload', {}, 90_000);
    const verify = await runCommand(ctx, job, 'verify', {}, 60_000);
    if (verify.ok === false) {
      throw new JobFailure('post_install_verify_failed', 'Проверка после установки не пройдена');
    }

    const newVersion =
      asString(verify.version) ?? asString(installed.version) ?? versionTag ?? 'unknown';
    const newVariant =
      asString(verify.variant) ?? asString(installed.variant) ?? variant ?? null;

    await ctx.pool.query(
      `update routers set
          sing_box_previous_version = sing_box_version,
          sing_box_previous_variant = sing_box_variant,
          sing_box_version = $2,
          sing_box_variant = $3,
          sing_box_installed_at = now(),
          updated_at = now()
        where id = $1`,
      [routerId, newVersion, newVariant],
    );

    if (asString(job.payload.rollout_id)) {
      await ctx.pool.query(
        `update rollout_targets set status = 'success', finished_at = now(), previous_version = $3
          where rollout_id = $1 and router_id = $2`,
        [job.payload.rollout_id, routerId, previous],
      );
    }

    return {
      version: newVersion,
      variant: newVariant,
      previous,
      previous_variant: previousVariant,
      action: asString(installed.action),
    };
  } catch (error) {
    const failure =
      error instanceof JobFailure
        ? error
        : new JobFailure('sb_install_failed', (error as Error).message.slice(0, 500));

    // Проверяем, изменился ли реальный вариант/версия. Если upstream отказал
    // до удаления текущего пакета (например, не хватило места), откат не нужен
    // и только тратит место/время.
    let currentVersion = previous;
    let currentVariant = previousVariant;
    let verifyOk = false;
    try {
      const current = await runCommand(ctx, job, 'verify', {}, 20_000);
      const actualVersion = asString(current.version);
      const actualVariant = asString(current.variant);
      if (actualVersion) {
        currentVersion = actualVersion;
        verifyOk = true;
      }
      if (actualVariant) currentVariant = actualVariant;
    } catch (verifyError) {
      ctx.log.warn({ err: verifyError, routerId }, 'не удалось проверить sing-box после ошибки установки');
    }
    const unchanged =
      verifyOk &&
      Boolean(previousVariant || previous) &&
      normalizeVariant(currentVariant) === normalizeVariant(previousVariant) &&
      normalizeVersion(currentVersion) === normalizeVersion(previous);

    // Возвращаем предыдущий вариант/версию. Prokop при смене варианта сначала
    // удаляет текущий пакет, поэтому без этого шага роутер может остаться без sing-box.
    let rollback: 'ok' | 'failed' | 'skipped' = 'skipped';
    let rollbackError: string | null = null;
    if (!unchanged && (previousVariant || previous)) {
      const rollbackVariant = previousVariant ?? 'stable';
      const rollbackVersion = previous ? previous.replace(/-r\d+$/, '') : null;
      try {
        await runCommand(
          ctx,
          job,
          'sb_install',
          { variant: rollbackVariant, version_tag: rollbackVersion },
          timeout,
        );
        await runCommand(ctx, job, 'reload', {}, 90_000);
        const verify = await runCommand(ctx, job, 'verify', {}, 60_000);
        if (verify.ok === false) {
          rollback = 'failed';
          rollbackError = 'предыдущий вариант установлен, но проверка не пройдена';
        } else {
          rollback = 'ok';
          await ctx.pool.query(
            `update routers set
                sing_box_version = coalesce($2, sing_box_version),
                sing_box_variant = coalesce($3, sing_box_variant),
                updated_at = now()
              where id = $1`,
            [
              routerId,
              asString(verify.version) ?? previous,
              asString(verify.variant) ?? previousVariant,
            ],
          );
        }
      } catch (rollbackFailure) {
        rollback = 'failed';
        rollbackError = (rollbackFailure as Error).message.slice(0, 500);
      }
    }

    // После неудачной установки Prokop мог остаться остановленным. Запускаем
    // его, если бинарник на месте; повторный start идемпотентен.
    let serviceRestarted = false;
    try {
      await runCommand(ctx, job, 'service_action', { action: 'start' }, 90_000);
      serviceRestarted = true;
    } catch (startError) {
      ctx.log.warn({ err: startError, routerId }, 'не удалось запустить службу после ошибки sing-box');
    }

    const outcome = unchanged
      ? 'текущий вариант не изменён'
      : rollback === 'ok'
        ? `восстановлен предыдущий вариант ${previousVariant ?? 'stable'} ${previous ?? ''}`.trim()
        : rollback === 'failed'
          ? `откат не удался: ${rollbackError ?? 'неизвестная ошибка'}`
          : 'откат недоступен: не известен предыдущий вариант';

    if (asString(job.payload.rollout_id)) {
      await ctx.pool.query(
        `update rollout_targets set status = 'failed', finished_at = now(), error_code = $3,
                previous_version = $4
          where rollout_id = $1 and router_id = $2`,
        [job.payload.rollout_id, routerId, failure.code, previous],
      );
    }

    await notifyRouterOwner(ctx.pool, routerId, {
      kind: rollback === 'ok' ? 'singbox.install_rolled_back' : 'singbox.install_failed',
      severity: 'critical',
      message:
        rollback === 'ok'
          ? `Не удалось установить sing-box (${variant || versionTag}), предыдущий вариант восстановлен`
          : `Не удалось установить sing-box (${variant || versionTag}): ${failure.message} (${outcome})`,
      dedupeKey: `sb:${routerId}:${variant || versionTag}:${failure.code}`,
    });

    throw new JobFailure(
      failure.code,
      `${failure.message} (${outcome}${serviceRestarted ? '' : '; служба не запущена'})`,
      failure.terminal,
    );
  }
}

export async function serviceAction(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const action = asString(job.payload.action) ?? '';
  if (!['restart', 'start', 'stop', 'enable', 'disable'].includes(action)) {
    throw new JobFailure(
      'invalid_payload',
      'Допустимые действия: restart, start, stop, enable, disable',
    );
  }
  const routerId = requireRouter(job);
  const raw = await runCommand(ctx, job, 'service_action', { action }, 90_000);

  // После действия обновляем состояние, чтобы UI сразу показал новый статус
  // и автозапуск, не требуя отдельной кнопки «Прочитать состояние».
  try {
    const managed = await readState(ctx, job, 20_000);
    await recomputeDrift(ctx.pool, routerId, managed);
  } catch (error) {
    ctx.log.warn(
      { err: error, routerId, action },
      'не удалось обновить состояние после действия со службой',
    );
  }

  return { action, result: raw };
}

export async function reconcile(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  if (!ctx.settings.features.autoReconcile) {
    return { skipped: true, reason: 'auto_reconcile_disabled' };
  }
  const current = await readState(ctx, job);
  const drift = await recomputeDrift(ctx.pool, routerId, current);
  return { drift };
}

export async function applyRouterConnections(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const routerResult = await ctx.pool.query<{ managed_section: string | null }>(
    'select managed_section from routers where id = $1',
    [routerId],
  );
  const router = routerResult.rows[0];
  if (!router) throw new JobFailure('router_missing', 'Роутер не найден');
  const section = router.managed_section || 'router_control';

  const result = await ctx.pool.query<{
    id: string;
    kind: 'subscription' | 'vless';
    label: string;
    secret_enc: string;
    enabled: boolean;
  }>(
    `select id, kind, label, secret_enc, enabled
       from router_connections where router_id = $1 order by created_at asc`,
    [routerId],
  );

  const links: string[] = [];
  const subscriptions: Array<{ name: string; url: string }> = [];
  for (const row of result.rows) {
    if (!row.enabled) continue;
    const value = decryptSecret(row.secret_enc, ctx.masterKey);
    if (row.kind === 'vless') links.push(value);
    else {
      subscriptions.push({
        name: `rc_sub_${row.id.replace(/-/g, '').slice(0, 12)}`,
        url: value,
      });
    }
  }

  let snapshotRef: string | null = null;
  try {
    const snapshot = await runCommand(ctx, job, 'snapshot_create', { reason: 'connections' }, 90_000);
    snapshotRef = asString(snapshot.external_id) ?? asString(snapshot.id) ?? `local-${Date.now()}`;
    await ctx.pool.query(
      `insert into router_snapshots
         (id, router_id, kind, external_id, reason, sha256, size_bytes, product_version, expires_at)
       values ($1,$2,$3,$4,'connections',$5,$6,$7, now() + ($8 || ' days')::interval)`,
      [
        uuidv7(),
        routerId,
        asString(snapshot.kind) === 'native' ? 'native' : 'local',
        snapshotRef,
        asString(snapshot.sha256),
        asNumber(snapshot.size_bytes),
        asString(snapshot.product_version),
        ctx.settings.retention.days,
      ],
    );
  } catch (error) {
    throw new JobFailure(
      'backup_failed',
      `Не удалось создать снимок перед изменением подключений: ${(error as Error).message}`,
    );
  }

  try {
    await runCommand(
      ctx,
      job,
      'apply_connections',
      {
        section,
        action: 'connection',
        enabled: links.length + subscriptions.length > 0,
        links,
        subscriptions,
      },
      120_000,
    );
    await runCommand(ctx, job, 'reload', {}, 90_000);
    const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
    const current = await saveState(ctx.pool, routerId, raw, 'connections');
    const enabledPath = `section.${section}.enabled`;
    const actual = current[enabledPath];
    const expectEnabled = links.length + subscriptions.length > 0;
    if (expectEnabled && String(actual) !== '1') {
      throw new JobFailure('verify_mismatch', 'Секция подключений не включилась после применения');
    }
  } catch (error) {
    let rollback: 'ok' | 'failed' = 'failed';
    if (snapshotRef) {
      try {
        await runCommand(ctx, job, 'snapshot_restore', { snapshot: snapshotRef, kind: 'local' }, 180_000);
        await runCommand(ctx, job, 'reload', {}, 90_000);
        const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
        await saveState(ctx.pool, routerId, raw, 'connections_rollback');
        rollback = 'ok';
      } catch {
        rollback = 'failed';
      }
    }
    const failure = error as JobFailure;
    await ctx.pool.query(
      `update routers set last_error = $2, updated_at = now() where id = $1`,
      [routerId, failure.message?.slice(0, 500) ?? 'Ошибка применения подключений'],
    );
    throw new JobFailure(
      failure.code ?? 'connections_failed',
      `${failure.message} (${rollback === 'ok' ? 'изменения откачены' : 'требуется ручная проверка'})`,
    );
  }

  await ctx.pool.query('update routers set last_error = null, updated_at = now() where id = $1', [
    routerId,
  ]);

  return {
    section,
    links: links.length,
    subscriptions: subscriptions.length,
    snapshot: snapshotRef,
  };
}

export async function listConnections(ctx: HandlerContext, job: JobRow): Promise<Json> {
  requireRouter(job);
  const section = asString(job.payload.section) || 'router_control';
  return runCommand(ctx, job, 'list_connections', { section }, 30_000);
}

export async function manageConnection(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const action = asString(job.payload.action);
  const kind = asString(job.payload.kind);
  if (action !== 'delete' && action !== 'replace') {
    throw new JobFailure('invalid_payload', 'Не указано действие с подключением');
  }
  if (kind !== 'subscription' && kind !== 'link') {
    throw new JobFailure('invalid_payload', 'Не указан тип подключения');
  }

  const routerResult = await ctx.pool.query<{ managed_section: string | null }>(
    'select managed_section from routers where id = $1',
    [routerId],
  );
  const section = routerResult.rows[0]?.managed_section || 'router_control';
  const name = asString(job.payload.name);
  const hash = asString(job.payload.hash);
  const editId = asString(job.payload.edit_id);

  let value: string | null = null;
  try {
    if (editId) {
      const edit = await ctx.pool.query<{ secret_enc: string }>(
        'select secret_enc from connection_edits where id = $1 and router_id = $2',
        [editId, routerId],
      );
      if (!edit.rows[0]) {
        throw new JobFailure('edit_missing', 'Новое значение подключения не найдено');
      }
      value = decryptSecret(edit.rows[0].secret_enc, ctx.masterKey);
    }

    let snapshotRef: string | null = null;
    try {
      const snapshot = await runCommand(ctx, job, 'snapshot_create', { reason: 'connection_manage' }, 90_000);
      snapshotRef =
        asString(snapshot.external_id) ?? asString(snapshot.id) ?? `local-${Date.now()}`;
      await ctx.pool.query(
        `insert into router_snapshots
           (id, router_id, kind, external_id, reason, sha256, size_bytes, product_version, expires_at)
         values ($1,$2,$3,$4,'connection_manage',$5,$6,$7, now() + ($8 || ' days')::interval)`,
        [
          uuidv7(),
          routerId,
          asString(snapshot.kind) === 'native' ? 'native' : 'local',
          snapshotRef,
          asString(snapshot.sha256),
          asNumber(snapshot.size_bytes),
          asString(snapshot.product_version),
          ctx.settings.retention.days,
        ],
      );
    } catch (error) {
      throw new JobFailure(
        'backup_failed',
        `Не удалось создать снимок перед изменением подключения: ${(error as Error).message}`,
      );
    }

    try {
      const applied = await runCommand(
        ctx,
        job,
        'manage_connection',
        { section, action, kind, name, hash, value },
        60_000,
      );
      await runCommand(ctx, job, 'reload', {}, 90_000);
      const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
      await saveState(ctx.pool, routerId, raw, 'connection_manage');

      // Для удаления проверяем, что элемент действительно исчез.
      if (action === 'delete') {
        const listed = await runCommand(ctx, job, 'list_connections', { section }, 30_000);
        const subscriptions = Array.isArray(listed.subscriptions) ? listed.subscriptions : [];
        const links = Array.isArray(listed.links) ? listed.links : [];
        if (kind === 'subscription' && subscriptions.some((item) => asString((item as Json).name) === name)) {
          throw new JobFailure('verify_mismatch', 'Подписка осталась на роутере после удаления');
        }
        if (kind === 'link' && links.some((item) => asString((item as Json).hash) === hash)) {
          throw new JobFailure('verify_mismatch', 'Ссылка осталась на роутере после удаления');
        }
      }

      await ctx.pool.query('update routers set last_error = null, updated_at = now() where id = $1', [
        routerId,
      ]);
      return {
        action,
        kind,
        section,
        snapshot: snapshotRef,
        disabled: applied.disabled === true,
      };
    } catch (error) {
      let rollback: 'ok' | 'failed' = 'failed';
      if (snapshotRef) {
        try {
          await runCommand(ctx, job, 'snapshot_restore', { snapshot: snapshotRef, kind: 'local' }, 180_000);
          await runCommand(ctx, job, 'reload', {}, 90_000);
          const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
          await saveState(ctx.pool, routerId, raw, 'connection_manage_rollback');
          rollback = 'ok';
        } catch {
          rollback = 'failed';
        }
      }
      const failure = error as JobFailure;
      await ctx.pool.query(
        `update routers set last_error = $2, updated_at = now() where id = $1`,
        [routerId, failure.message?.slice(0, 500) ?? 'Ошибка изменения подключения'],
      );
      throw new JobFailure(
        failure.code ?? 'connection_manage_failed',
        `${failure.message} (${rollback === 'ok' ? 'изменения откачены' : 'требуется ручная проверка'})`,
      );
    }
  } finally {
    if (editId) {
      await ctx.pool.query('delete from connection_edits where id = $1', [editId]).catch(() => undefined);
    }
  }
}

export async function dnsBenchmark(ctx: HandlerContext, job: JobRow): Promise<Json> {
  requireRouter(job);
  let state: Json = {};
  try {
    const started = await runCommand(ctx, job, 'dns_benchmark', { mode: 'start' }, 30_000);
    state = asRecord(started.state);
    const deadline = Date.now() + Math.max(60_000, Math.min(job.timeout_seconds * 1000 - 10_000, 840_000));

    while (state.running === true) {
      if (await isCancelRequested(ctx.pool, job.id)) {
        await runCommand(ctx, job, 'dns_benchmark', { mode: 'stop' }, 30_000).catch(() => undefined);
        throw new JobFailure('cancelled', 'Задача отменена', 'cancelled');
      }
      if (Date.now() > deadline) {
        await runCommand(ctx, job, 'dns_benchmark', { mode: 'stop' }, 30_000).catch(() => undefined);
        throw new JobFailure(
          'dns_benchmark_timeout',
          'Тест DNS не завершился за отведённое время',
          'timeout',
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const status = await runCommand(ctx, job, 'dns_benchmark', { mode: 'status' }, 30_000);
      state = asRecord(status.state);
      await ctx.pool.query('update jobs set result = $2::jsonb where id = $1', [
        job.id,
        JSON.stringify({
          progress: asNumber(state.progress) ?? 0,
          phase: asString(state.phase),
          current: asString(state.current),
          results_count: Array.isArray(state.results) ? state.results.length : 0,
        }),
      ]);
    }

    const error = asString(state.error);
    if (error) throw new JobFailure('dns_benchmark_failed', error);
    return state;
  } finally {
    if (state.running === true) {
      await runCommand(ctx, job, 'dns_benchmark', { mode: 'stop' }, 30_000).catch(() => undefined);
    }
  }
}

export type JobHandler = (ctx: HandlerContext, job: JobRow) => Promise<Json>;

export const HANDLERS: Record<string, JobHandler> = {
  refresh_state: refreshState,
  diff: diffTemplate,
  apply: applyRun,
  monitor: monitorProbe,
  access_check: accessCheck,
  diagnostics,
  snapshot,
  restore: restoreSnapshot,
  sb_check: singBoxCheck,
  sb_install: singBoxInstall,
  service_action: serviceAction,
  dns_benchmark: dnsBenchmark,
  connections_apply: applyRouterConnections,
  list_connections: listConnections,
  manage_connection: manageConnection,
  reconcile,
};
