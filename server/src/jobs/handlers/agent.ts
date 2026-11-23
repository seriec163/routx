import { bundledAgentVersion } from '../../agent/version.js';
import { JobFailure } from '../errors.js';
import {
  agentVersionOf,
  asRecord,
  asString,
  requireRouter,
  runCommand,
  setJobPhase,
  waitForAgentVersion,
  type HandlerContext,
  type Json,
} from '../helpers.js';
import { isCancelRequested, type JobRow } from '../queue.js';
import { readState, recomputeDrift } from '../state.js';

const TACHYON_COMPONENTS = ['tachyon', 'tachyon-core'] as const;

function componentLabel(component: string): string {
  return component === 'tachyon-core' ? 'ядро Tachyon Core' : 'модуль Tachyon';
}

export async function agentUpdate(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const before = await agentVersionOf(ctx, routerId);
  const base = ctx.publicUrl.replace(/\/+$/, '');
  const raw = await runCommand(
    ctx,
    job,
    'self_update',
    { base_url: base, version: bundledAgentVersion() ?? '' },
    120_000,
  );
  if (raw.ok === false) {
    throw new JobFailure(
      asString(raw.error) || 'agent_update_failed',
      asString(raw.message) || 'Агент не принял обновление',
    );
  }

  await setJobPhase(ctx, job.id, 'Ждём перезапуск агента', 60);
  const after = await waitForAgentVersion(ctx, routerId, before, 120_000);
  if (!after) {
    throw new JobFailure(
      'agent_update_not_applied',
      `Агент не сообщил новую версию за 2 минуты (было ${before ?? '—'}). ` +
        'Проверьте /var/log/routx-agent-update.log на роутере.',
    );
  }

  return {
    router_id: routerId,
    scheduled: true,
    kind: asString(raw.kind),
    version: after,
    previous_version: before,
    applied: after !== before,
    sha256: asString(raw.sha256) || null,
  };
}

export async function componentCheck(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const routerId = requireRouter(job);
  const router = await ctx.pool.query<{ product: string }>(
    'select product from routers where id = $1',
    [routerId],
  );
  if (router.rows[0]?.product !== 'tachyon') {
    throw new JobFailure(
      'component_unsupported',
      'Обновления компонентов доступны только для Tachyon',
    );
  }
  const raw = await runCommand(ctx, job, 'component_action', { mode: 'check' }, 240_000);
  return {
    results: Array.isArray(raw.results) ? raw.results : [],
    errors: Array.isArray(raw.errors) ? raw.errors : [],
  };
}

export async function componentUpdate(ctx: HandlerContext, job: JobRow): Promise<Json> {
  const component = asString(job.payload.component) ?? '';
  if (!(TACHYON_COMPONENTS as readonly string[]).includes(component)) {
    throw new JobFailure('invalid_payload', 'Неизвестный компонент Tachyon');
  }
  return runComponentUpdate(ctx, job, component);
}

export async function runComponentUpdate(
  ctx: HandlerContext,
  job: JobRow,
  component: string,
): Promise<Json> {
  const routerId = requireRouter(job);
  const routerRow = await ctx.pool.query<{ product: string }>(
    'select product from routers where id = $1',
    [routerId],
  );
  if (routerRow.rows[0]?.product !== 'tachyon') {
    throw new JobFailure(
      'component_unsupported',
      'Обновления компонентов доступны только для Tachyon',
    );
  }

  const started = await runCommand(
    ctx,
    job,
    'component_action',
    { mode: 'start', component, action: 'update' },
    90_000,
  );
  const nativeJobId = asString(started.job_id) ?? '';
  if (!nativeJobId) {
    throw new JobFailure('component_start_failed', 'Tachyon не вернул идентификатор обновления');
  }

  await setJobPhase(ctx, job.id, `Обновляем ${componentLabel(component)}`, 10);

  const deadline = Date.now() + 840_000;
  let data: Json = {};
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await runCommand(
      ctx,
      job,
      'component_action',
      { mode: 'status', job_id: nativeJobId },
      60_000,
    );
    data = asRecord(status.data ?? {});
    const running = data.running === true || data.running === 1;
    const message = asString(data.message) ?? '';
    if (message) {
      await setJobPhase(
        ctx,
        job.id,
        `Обновляем ${componentLabel(component)}: ${message}`,
        running ? 50 : 90,
      );
    }
    if (!running) break;
    if (await isCancelRequested(ctx.pool, job.id)) {
      throw new JobFailure('cancelled', 'Задача отменена', 'cancelled');
    }
  }

  if (data.running === true || data.running === 1) {
    throw new JobFailure(
      'component_timeout',
      'Обновление не завершилось за отведённое время. Проверьте журнал Tachyon на роутере.',
    );
  }

  const logResult = await runCommand(
    ctx,
    job,
    'component_action',
    { mode: 'log', job_id: nativeJobId, offset: 0 },
    60_000,
  );
  const fullLog = asString(logResult.log) ?? '';
  const log = fullLog.length > 12000 ? fullLog.slice(-12000) : fullLog;

  if (data.success === false) {
    throw new JobFailure(
      'component_update_failed',
      asString(data.message) || `Не удалось обновить ${componentLabel(component)}`,
    );
  }

  // Полные release notes не нужны в результате задачи: они раздувают jobs и
  // дублируют страницу релиза. Оставляем версии, статус и журнал операции.
  const status: Json = { ...data };
  delete status.release_notes;

  // После обновления обновляем прочитанное состояние, чтобы панель сразу
  // показала новую версию продукта, не дожидаясь следующего опроса.
  try {
    const managed = await readState(ctx, job, 30_000);
    await recomputeDrift(ctx.pool, routerId, managed);
  } catch (error) {
    ctx.log.warn({ err: error, routerId, component }, 'не удалось обновить состояние после компонента');
  }

  return {
    component,
    native_job_id: nativeJobId,
    status,
    previous_version: asString(data.previous_version) ?? null,
    current_version: asString(data.current_version) ?? null,
    latest_version: asString(data.latest_version) ?? null,
    log,
  };
}
