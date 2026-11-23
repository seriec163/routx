import { sanitizeReport } from '../../audit.js';
import { maskSecrets, sha256Hex } from '../../lib/crypto.js';
import { uuidv7 } from '../../lib/ids.js';
import { JobFailure } from '../errors.js';
import {
  asNumber,
  asString,
  requireRouter,
  runCommand,
  type HandlerContext,
  type Json,
} from '../helpers.js';
import type { JobRow } from '../queue.js';
import { readState, recomputeDrift, saveState } from '../state.js';

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

  // Каталогизируем не только отчёт, но и сами логи/ошибки. Иначе, чтобы
  // посмотреть причину сбоя, приходится каждый раз заново идти на роутер.
  try {
    const checks = Array.isArray((report as { checks?: unknown }).checks)
      ? ((report as { checks: Array<{ name?: unknown; state?: unknown; details?: unknown }> })
          .checks)
      : [];
    const product = router.rows[0]?.product ?? 'unknown';
    for (const check of checks) {
      const name = typeof check.name === 'string' ? check.name : '';
      const state = typeof check.state === 'string' ? check.state : '';
      const details = typeof check.details === 'string' ? check.details : '';
      if (!details) continue;
      // У Tachyon свой движок tachyon-core, а не отдельный sing-box.
      // Эти проверки для него не применимы и только засоряют журнал.
      if (
        product === 'tachyon' &&
        (name === 'sing_box_service' ||
          name === 'sing_box_version' ||
          name === 'tachyon_sing_box_status')
      ) {
        continue;
      }
      const isLog = name === 'tachyon_logs' || name === 'sing_box_logs';
      if (!isLog && state === 'ok') continue;
      const level = state === 'error' ? 'error' : state === 'warning' ? 'warn' : 'info';
      await ctx.pool.query(
        `insert into router_logs (id, router_id, source, level, message, context, job_id)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [
          uuidv7(),
          routerId,
          name || 'diagnostics',
          level,
          details.slice(0, 200_000),
          JSON.stringify({ kind, state }),
          job.id,
        ],
      );
    }
  } catch (error) {
    ctx.log.warn({ err: error, job: job.id }, 'не удалось сохранить логи диагностики');
  }

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
  await runCommand(ctx, job, 'reload', {}, 300_000);
  const raw = await runCommand(ctx, job, 'read_state', {}, 60_000);
  await saveState(ctx.pool, routerId, raw, 'restore');

  return { restored: snapshotId };
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

export async function rebootRouter(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const raw = await runCommand(ctx, job, 'reboot', {}, 30_000);
  // Метка нужна, чтобы отличить «роутер вернулся после ребута» от обычного
  // восстановления связи и показать соответствующий попап.
  await ctx.pool.query('update routers set reboot_requested_at = now() where id = $1', [routerId]);
  return { scheduled: true, result: raw };
}

export async function accessCheck(ctx: HandlerContext, job: JobRow): Promise<Json> {
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

export async function siteCheck(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const targets = Array.isArray(job.payload.targets)
    ? job.payload.targets.map((value) => asString(value)).filter(Boolean)
    : [];
  if (targets.length === 0) {
    throw new JobFailure('no_targets', 'Нет адресов для проверки');
  }

  const raw = await runCommand(ctx, job, 'site_probe', { targets }, 90_000);
  if (raw.ok === false) {
    throw new JobFailure(
      asString(raw.error) || 'site_check_failed',
      asString(raw.message) || 'Не удалось проверить сайты',
    );
  }

  const results = Array.isArray(raw.results) ? raw.results : [];
  return { router_id: routerId, results };
}

