import { Link } from '../components/link';
import {
  Button,
  Empty,
  ErrorBanner,
  InfoBanner,
  PageHeader,
  Panel,
  Spinner,
  StatusBadge,
  Switch,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import type { SingBoxVersion } from '../lib/types';
import { useApi } from '../lib/useApi';
import { useSession } from '../session';
import { useState } from 'react';

export function SingBoxPage() {
  const toast = useToast();
  const { me } = useSession();
  const isAdmin = me?.permissions.is_superadmin === true;
  const [stableOnly, setStableOnly] = useState(true);
  const versions = useApi<{ items: SingBoxVersion[] }>(
    `/api/v1/singbox/versions?stable_only=${stableOnly}`,
  );
  const [busy, setBusy] = useState(false);

  async function refresh(): Promise<void> {
    setBusy(true);
    try {
      const result = await api<{ versions: number }>('/api/v1/singbox/refresh', { method: 'POST' });
      toast.success(`Каталог обновлён: ${result.versions} версий`);
      await versions.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="sing-box"
        subtitle="Версии только из официального источника. Установка — с проверкой SHA-256, подтверждением и откатом."
        actions={
          <>
            <Link className="btn btn-ghost" to="/rollouts">
              Поэтапное обновление
            </Link>
            {isAdmin ? (
              <Button onClick={() => void refresh()} busy={busy}>
                Обновить каталог
              </Button>
            ) : null}
          </>
        }
      />

      <InfoBanner>
        Пользователь может установить sing-box на свой роутер не чаще раза в 24 часа. Поэтапное
        обновление и установка на любой роутер — только суперадминистратор. Вариант (Tiny / Extended /
        Extended compressed / Stable) переключается на странице роутера во вкладке «sing-box».
      </InfoBanner>

      <Panel title="Варианты sing-box">
        <ul className="bullets">
          <li>
            <strong>Tiny</strong> — минимальный пакет из репозитория Prokop/Forkop, меньше всего места.
          </li>
          <li>
            <strong>Extended</strong> — расширенная сборка с дополнительными протоколами и XHTTP.
          </li>
          <li>
            <strong>Extended compressed</strong> — Extended со сжатым бинарником и библиотекой Cronet.
          </li>
          <li>
            <strong>Stable</strong> — обычная стабильная сборка из пакетного репозитория.
          </li>
        </ul>
        <p className="page-sub">
          При смене варианта текущий пакет sing-box сначала удаляется, затем ставится новый. Если
          установка не удалась, Router Control пытается вернуть предыдущий вариант.
        </p>
      </Panel>

      {versions.error ? <ErrorBanner message={versions.error} onRetry={() => void versions.reload()} /> : null}

      <Panel
        title="Каталог версий"
        actions={<Switch checked={stableOnly} onChange={setStableOnly} label="Только стабильные" />}
      >
        {versions.loading && !versions.data ? (
          <Spinner />
        ) : (versions.data?.items.length ?? 0) === 0 ? (
          <Empty>
            Каталог пуст. {isAdmin ? 'Нажмите «Обновить каталог».' : 'Попросите администратора обновить каталог.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Версия</th>
                  <th>Стабильность</th>
                  <th>Опубликована</th>
                  <th>SHA-256 (linux-arm64)</th>
                  <th>Источник</th>
                </tr>
              </thead>
              <tbody>
                {versions.data!.items.map((version) => (
                  <tr key={version.tag}>
                    <td className="mono">{version.tag}</td>
                    <td>
                      <StatusBadge
                        status={version.is_stable ? 'success' : 'warning'}
                        label={version.is_stable ? 'стабильная' : 'pre-release'}
                      />
                    </td>
                    <td className="muted-text small">{formatDate(version.published_at)}</td>
                    <td className="mono small">{version.asset_sha256 ?? '—'}</td>
                    <td>
                      {version.release_url ? (
                        <a href={version.release_url} target="_blank" rel="noreferrer">
                          GitHub Release
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Как выполняется установка">
        <ol className="steps">
          <li>Вариант или версия выбираются из официального источника; сторонние зеркала не используются.</li>
          <li>Текущий пакет sing-box удаляется перед установкой нового — это освобождает место.</li>
          <li>Выполняется установка и проверка версии/варианта после запуска.</li>
          <li>При неудаче Router Control пытается вернуть предыдущий вариант и версию.</li>
          <li>
            Поэтапное обновление идёт волнами: проверочный роутер, затем ~25%, затем остальные — с
            ручным подтверждением между волнами.
          </li>
        </ol>
      </Panel>
    </div>
  );
}
