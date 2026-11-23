import { notifyRouterOwner } from '../../notifications.js';
import { JobFailure } from '../errors.js';
import {
  asString,
  requireRouter,
  runCommand,
  type HandlerContext,
  type Json,
} from '../helpers.js';
import type { JobRow } from '../queue.js';

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

    await runCommand(ctx, job, 'reload', {}, 300_000);
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
        await runCommand(ctx, job, 'reload', {}, 300_000);
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

