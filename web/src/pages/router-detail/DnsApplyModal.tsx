import { useEffect, useRef, useState } from 'react';
import { DiffView } from '../../components/diff';
import {
  Button,
  ErrorBanner,
  InfoBanner,
  JobProgress,
  Modal,
  Spinner,
  useToast,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import type { DiffItem, Job } from '../../lib/types';

export function DnsApplyModal(props: {
  routerId: string;
  proposal: {
    dns_type: 'udp' | 'doh';
    dns_server: string[];
    bootstrap_dns_server: string[];
  };
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<'preparing' | 'ready' | 'applying' | 'success' | 'error'>(
    'preparing',
  );
  const [run, setRun] = useState<{
    apply_run_id: string;
    diff: DiffItem[];
    diff_hash: string;
    warnings: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const onAppliedRef = useRef(props.onApplied);

  useEffect(() => {
    onAppliedRef.current = props.onApplied;
  }, [props.onApplied]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await api<{
          apply_run_id: string;
          diff: DiffItem[];
          diff_hash: string;
          warnings: string[];
        }>(`/api/v1/routers/${props.routerId}/dns/diff`, {
          method: 'POST',
          body: props.proposal,
        });
        if (!active) return;
        setRun(response);
        setPhase(response.diff.length === 0 ? 'success' : 'ready');
        if (response.diff.length === 0) await onAppliedRef.current();
      } catch (caught) {
        if (active) {
          setError(errorMessage(caught));
          setPhase('error');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [props.routerId, props.proposal]);

  async function confirm(): Promise<void> {
    if (!run) return;
    setPhase('applying');
    setError(null);
    try {
      const response = await api<{ job: Job }>(
        `/api/v1/apply-runs/${run.apply_run_id}/confirm`,
        {
          method: 'POST',
          body: { diff_hash: run.diff_hash },
        },
      );
      setJob(response.job);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const status = await api<{ job: Job }>(`/api/v1/jobs/${response.job.id}`);
        setJob(status.job);
        if (status.job.status !== 'queued' && status.job.status !== 'running') {
          if (status.job.status === 'success') {
            setPhase('success');
            toast.success('DNS применён');
            await onAppliedRef.current();
          } else {
            setError(status.job.error?.message ?? 'Применение DNS не завершилось');
            setPhase('error');
          }
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      setError('Применение DNS выполняется дольше обычного');
      setPhase('error');
    } catch (caught) {
      setError(errorMessage(caught));
      setPhase('error');
    }
  }

  async function cancelRun(): Promise<void> {
    if (run && phase === 'ready') {
      await api(`/api/v1/apply-runs/${run.apply_run_id}/cancel`, { method: 'POST' }).catch(
        () => undefined,
      );
    }
    props.onClose();
  }

  return (
    <Modal
      title="Применить DNS"
      wide
      onClose={cancelRun}
      footer={
        phase === 'success' ? (
          <Button onClick={props.onClose}>Готово</Button>
        ) : phase === 'error' ? (
          <Button onClick={props.onClose}>Закрыть</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => void cancelRun()} disabled={phase === 'applying'}>
              Отмена
            </Button>
            <Button
              onClick={() => void confirm()}
              busy={phase === 'applying'}
              disabled={!run || phase !== 'ready'}
            >
              Применить
            </Button>
          </>
        )
      }
    >
      {phase === 'preparing' ? <Spinner label="Сравниваем DNS-настройки…" /> : null}
      {phase === 'applying' ? (
        <JobProgress job={job} label="Применяем DNS-настройки" />
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
      {run?.warnings.map((warning) => (
        <InfoBanner key={warning} tone="warn">
          {warning}
        </InfoBanner>
      ))}
      {run ? (
        <>
          <InfoBanner>
            Будет создан снимок, затем изменены только глобальные DNS-настройки Prokop/Forkop.
            После применения выполнится проверка; при ошибке — откат.
          </InfoBanner>
          <div className="kv">
            <span>Тип</span>
            <strong>{props.proposal.dns_type.toUpperCase()}</strong>
            <span>Серверы</span>
            <strong>{props.proposal.dns_server.join(' · ')}</strong>
            <span>Bootstrap</span>
            <strong>{props.proposal.bootstrap_dns_server.join(' · ')}</strong>
            <span>Изменений</span>
            <strong>{run.diff.length}</strong>
          </div>
          {run.diff.length > 0 ? <DiffView items={run.diff} /> : null}
        </>
      ) : null}
      {phase === 'success' ? (
        <InfoBanner>DNS-настройки применены. Проверьте статус службы и доступность интернета.</InfoBanner>
      ) : null}
    </Modal>
  );
}
