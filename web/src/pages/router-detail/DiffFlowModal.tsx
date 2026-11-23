import { useEffect, useState } from 'react';
import { DiffBadge, DiffView } from '../../components/diff';
import {
  Button,
  ErrorBanner,
  InfoBanner,
  Modal,
  Spinner,
  useToast,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { APPLY_STATUS, formatRelative } from '../../lib/format';
import type { ApplyItem, ApplyRunDetail, DiffItem, Job } from '../../lib/types';

function normalizeValue(value: unknown): string | string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function itemsToDiff(items: ApplyItem[]): DiffItem[] {
  return items.map((item) => ({
    op: item.op === 'add' ? 'add' : item.op === 'delete' ? 'delete' : 'change',
    path: item.path,
    before: normalizeValue(item.value_before),
    after: normalizeValue(item.value_after),
  }));
}

export function DiffFlowModal(props: {
  routerId: string;
  templateId: string;
  revision: number;
  templateName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'loading' | 'ready' | 'applying' | 'error'>(
    'starting',
  );
  const [job, setJob] = useState<Job | null>(null);
  const [run, setRun] = useState<ApplyRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function poll(jobId: string): Promise<void> {
      if (cancelled) return;
      try {
        const res = await api<{ job: Job }>(`/api/v1/jobs/${jobId}`);
        if (cancelled) return;
        setJob(res.job);
        if (res.job.status === 'queued' || res.job.status === 'running') {
          timer = window.setTimeout(() => void poll(jobId), 1500);
          return;
        }
        if (res.job.status !== 'success') {
          setPhase('error');
          setError(res.job.error?.message ?? 'Сравнение не завершилось успешно');
          return;
        }
        const applyRunId =
          typeof res.job.result?.apply_run_id === 'string' ? res.job.result.apply_run_id : null;
        if (!applyRunId) {
          setPhase('error');
          setError('Сервер не вернул результат сравнения');
          return;
        }
        setPhase('loading');
        const detail = await api<ApplyRunDetail>(`/api/v1/apply-runs/${applyRunId}`);
        if (cancelled) return;
        setRun(detail);
        setPhase('ready');
      } catch (caught) {
        if (!cancelled) {
          setPhase('error');
          setError(errorMessage(caught));
        }
      }
    }

    (async () => {
      try {
        const res = await api<{ job: Job }>(`/api/v1/routers/${props.routerId}/diff`, {
          method: 'POST',
          body: { template_id: props.templateId, revision: props.revision },
        });
        if (cancelled) return;
        setJob(res.job);
        setPhase('waiting');
        void poll(res.job.id);
      } catch (caught) {
        if (!cancelled) {
          setPhase('error');
          setError(errorMessage(caught));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [props.routerId, props.templateId, props.revision]);

  async function confirm(): Promise<void> {
    if (!run) return;
    setPhase('applying');
    try {
      await api(`/api/v1/apply-runs/${run.apply_run.id}/confirm`, {
        method: 'POST',
        body: { diff_hash: run.apply_run.diff_hash },
      });
      toast.success('Применение запущено. Снимок создаётся автоматически.');
      props.onChanged();
      props.onClose();
    } catch (caught) {
      toast.error(errorMessage(caught));
      setPhase('ready');
    }
  }

  const items = run ? itemsToDiff(run.items) : [];
  const noChanges = run ? items.length === 0 : false;
  const canConfirm = run?.apply_run.status === 'awaiting_confirmation';

  return (
    <Modal
      title={`Сравнение: ${props.templateName} (ред. ${props.revision})`}
      wide
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={phase === 'applying'}>
            Закрыть
          </Button>
          <Button
            onClick={() => void confirm()}
            busy={phase === 'applying'}
            disabled={!canConfirm || noChanges || phase !== 'ready'}
          >
            {noChanges ? 'Изменений нет' : 'Подтвердить и применить'}
          </Button>
        </>
      }
    >
      {phase === 'starting' || phase === 'waiting' || phase === 'loading' ? (
        <Spinner
          label={
            phase === 'loading'
              ? 'Загружаем различия…'
              : 'Читаем состояние роутера и строим diff…'
          }
        />
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}

      {run ? (
        <>
          {run.apply_run.section_map &&
          Object.keys(run.apply_run.section_map).length > 0 ? (
            <InfoBanner tone="warn">
              Секции шаблона привязаны к существующим секциям роутера:{' '}
              {Object.entries(run.apply_run.section_map)
                .map(([from, to]) => `«${from}» → «${to}»`)
                .join(', ')}
              . Это защищает от правила connection без подключения.
            </InfoBanner>
          ) : null}
          <div className="diff-head">
            <DiffBadge items={items} />
            <span className="muted-text">
              Статус: {APPLY_STATUS[run.apply_run.status] ?? run.apply_run.status} · хеш{' '}
              <code>{run.apply_run.diff_hash.slice(0, 12)}…</code>
            </span>
          </div>
          {noChanges ? (
            <InfoBanner>Конфигурация уже соответствует шаблону — применение не требуется.</InfoBanner>
          ) : (
            <InfoBanner tone="warn">
              Проверьте список. Будут перечисленные параметры; списки заменяются полностью, удаление
              помечено отдельно.
            </InfoBanner>
          )}
          <DiffView items={items} />
          {job ? (
            <p className="muted-text small">
              Задача {job.id.slice(0, 8)} · создана {formatRelative(job.created_at)}
            </p>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
