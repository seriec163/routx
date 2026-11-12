import { api } from './api';
import type { ApplyRunDetail, Job } from './types';

/** Ожидание задачи с обновлением состояния — прогресс нужен всем экранам. */
export async function waitForJob(
  job: Job,
  onUpdate?: (job: Job) => void,
  timeoutMs = 300_000,
): Promise<Job> {
  let current = job;
  const deadline = Date.now() + timeoutMs;
  while (
    (current.status === 'queued' || current.status === 'running') &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    current = (await api<{ job: Job }>(`/api/v1/jobs/${current.id}`)).job;
    onUpdate?.(current);
  }
  return current;
}

export interface RuleApplyBody {
  section: string;
  label?: string;
  action: string;
  enabled: boolean;
  create: boolean;
  resources: Record<string, string | string[] | null>;
  manual_domains: string[];
  manual_ips: string[];
  settings: Record<string, string | string[] | null>;
}

/**
 * Полный цикл применения правила: diff → подтверждение → apply.
 * Используется мобильным приложением, где пользователь не разбирает diff вручную.
 */
export async function applyRuleBody(
  routerId: string,
  body: RuleApplyBody,
  onJob?: (job: Job) => void,
): Promise<void> {
  const started = await api<{ job: Job }>(`/api/v1/routers/${routerId}/rules/diff`, {
    method: 'POST',
    body,
  });
  onJob?.(started.job);

  const diffJob = await waitForJob(started.job, onJob);
  if (diffJob.status !== 'success') {
    throw new Error(diffJob.error?.message ?? 'Не удалось сравнить правило');
  }

  const applyRunId =
    typeof diffJob.result?.apply_run_id === 'string' ? diffJob.result.apply_run_id : null;
  if (!applyRunId) throw new Error('Сервер не вернул результат сравнения');

  const detail = await api<ApplyRunDetail>(`/api/v1/apply-runs/${applyRunId}`);
  if (detail.items.length === 0) return;

  const confirmed = await api<{ job: Job }>(
    `/api/v1/apply-runs/${applyRunId}/confirm`,
    { method: 'POST', body: { diff_hash: detail.apply_run.diff_hash } },
  );
  onJob?.(confirmed.job);

  const applied = await waitForJob(confirmed.job, onJob);
  if (applied.status !== 'success') {
    throw new Error(applied.error?.message ?? 'Не удалось применить правило');
  }
}
