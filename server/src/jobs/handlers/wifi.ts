import { decryptSecret } from '../../lib/crypto.js';
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
import type { JobRow } from '../queue.js';

async function selfUpdateForWifi(ctx: HandlerContext, job: JobRow): Promise<void> {
  await setJobPhase(ctx, job.id, 'Агент не поддерживает Wi-Fi — обновляем RoutX', 3);
  const before = await agentVersionOf(ctx, requireRouter(job));
  const base = ctx.publicUrl.replace(/\/+$/, '');
  const update = await runCommand(
    ctx,
    job,
    'self_update',
    { base_url: base, version: bundledAgentVersion() ?? '' },
    180_000,
  );
  if (update.ok === false) {
    throw new JobFailure(
      'agent_update_failed',
      asString(update.message) || 'Агент не принял обновление',
    );
  }
  await setJobPhase(ctx, job.id, 'Ждём перезапуск агента', 5);
  const after = await waitForAgentVersion(ctx, requireRouter(job), before, 90_000);
  if (!after) {
    throw new JobFailure(
      'agent_update_failed',
      'Агент не сообщил новую версию за 90 секунд. Проверьте /var/log/routx-agent-update.log на роутере.',
    );
  }
}

async function runWifiCommand(
  ctx: HandlerContext,
  job: JobRow,
  op: string,
  args: Json,
  timeoutMs: number,
): Promise<Json> {
  try {
    return await runCommand(ctx, job, op, args, timeoutMs);
  } catch (error) {
    if (
      !(error instanceof JobFailure) ||
      (error.code !== 'unknown_op' && error.code !== 'agent_outdated')
    ) {
      throw error;
    }
  }

  // Агент старее 1.5.51 не знает Wi-Fi операций. Обновляем его тем же
  // механизмом self_update, затем повторяем операцию — пользователю не нужно
  // вручную искать версию агента.
  try {
    await selfUpdateForWifi(ctx, job);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'неизвестная ошибка';
    throw new JobFailure(
      'wifi_agent_outdated',
      `Агент RoutX не поддерживает Wi-Fi, автоматически обновить его не удалось: ${message.slice(0, 300)}`,
    );
  }

  await setJobPhase(ctx, job.id, 'Повторяем операцию Wi-Fi', 10);
  try {
    return await runCommand(ctx, job, op, args, timeoutMs);
  } catch (error) {
    if (
      error instanceof JobFailure &&
      (error.code === 'unknown_op' || error.code === 'agent_outdated')
    ) {
      throw new JobFailure(
        'wifi_agent_outdated',
        'Агент RoutX не поддерживает Wi-Fi. Обновите агент до версии 1.5.52.',
      );
    }
    throw error;
  }
}

export async function wifiRead(ctx: HandlerContext, job: JobRow): Promise<Json> {
  requireRouter(job);
  let raw = await runWifiCommand(ctx, job, 'wifi_read', {}, 60_000);
  // 1.5.51 умеет читать Wi-Fi, но ещё не умеет определять наличие модуля.
  // Обновляем такой агент и повторяем чтение, чтобы панель получила hardware.
  if (raw.hardware == null || typeof raw.hardware !== 'object') {
    try {
      await selfUpdateForWifi(ctx, job);
      raw = await runCommand(ctx, job, 'wifi_read', {}, 60_000);
    } catch (error) {
      ctx.log.warn({ err: error, jobId: job.id }, 'не удалось обновить агент для определения Wi-Fi');
    }
  }
  return raw;
}

export async function wifiUpdate(ctx: HandlerContext, job: JobRow): Promise<Json> {
  requireRouter(job);
  const iface = asString(job.payload.iface) ?? '';
  if (!/^[A-Za-z0-9_]{1,64}$/.test(iface)) {
    throw new JobFailure('invalid_payload', 'Некорректное имя Wi-Fi сети');
  }
  const changes = { ...asRecord(job.payload.changes ?? {}) };
  const sealedKey = asString(changes.key_enc);
  if (sealedKey) {
    try {
      changes.key = decryptSecret(sealedKey, ctx.masterKey);
    } catch {
      throw new JobFailure('wifi_key_unreadable', 'Не удалось расшифровать пароль Wi-Fi');
    }
    delete changes.key_enc;
  }
  if (Object.keys(changes).length === 0) {
    throw new JobFailure('invalid_payload', 'Нет изменений Wi-Fi');
  }
  const raw = await runWifiCommand(ctx, job, 'wifi_update', { iface, changes }, 180_000);
  return { name: iface, ...raw };
}

export async function wifiCreate(ctx: HandlerContext, job: JobRow): Promise<Json> {
  requireRouter(job);
  const ssid = asString(job.payload.ssid) ?? '';
  if (!ssid) {
    throw new JobFailure('invalid_payload', 'Не указан SSID новой Wi-Fi сети');
  }
  const radios = Array.isArray(job.payload.radios)
    ? job.payload.radios.filter((item): item is string => typeof item === 'string')
    : [];
  const sealedKey = asString(job.payload.key_enc) ?? asString(job.payload.key);
  let key = '';
  if (sealedKey) {
    try {
      key = job.payload.key_enc ? decryptSecret(sealedKey, ctx.masterKey) : sealedKey;
    } catch {
      throw new JobFailure('wifi_key_unreadable', 'Не удалось расшифровать пароль Wi-Fi');
    }
  }
  const raw = await runWifiCommand(
    ctx,
    job,
    'wifi_create',
    {
      ssid,
      encryption: asString(job.payload.encryption) ?? 'none',
      key,
      hidden: job.payload.hidden === true,
      disabled: job.payload.disabled === true,
      isolate: job.payload.isolate === true,
      radios,
    },
    240_000,
  );
  return raw;
}

export async function wifiDelete(ctx: HandlerContext, job: JobRow): Promise<Json> {
  requireRouter(job);
  const iface = asString(job.payload.iface) ?? '';
  if (!/^[A-Za-z0-9_]{1,64}$/.test(iface)) {
    throw new JobFailure('invalid_payload', 'Некорректное имя Wi-Fi сети');
  }
  const raw = await runWifiCommand(ctx, job, 'wifi_delete', { iface }, 180_000);
  return { name: iface, ...raw };
}
