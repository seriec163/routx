import { useEffect, useMemo, useState } from 'react';
import { Button, ErrorBanner, InfoBanner, Panel, Spinner, useToast } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import type { RouterRecord } from '../lib/types';
import { useApi } from '../lib/useApi';

const SELF_UPDATE_MIN = '1.5.0';

function versionAtLeast(value: string | null | undefined, min: string): boolean {
  if (!value) return false;
  const left = value.split('.').map((part) => Number(part) || 0);
  const right = min.split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function AgentUpdates() {
  const toast = useToast();
  const routers = useApi<{ items: RouterRecord[] }>(
    '/api/v1/routers?include_archived=false&scope=branch',
  );
  const [targetVersion, setTargetVersion] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch('/agent/routx-agent.version', { cache: 'no-store' });
        if (!response.ok) throw new Error('Пакет агента не собран в этом образе');
        const text = (await response.text()).trim();
        if (active) setTargetVersion(text || null);
      } catch (caught) {
        if (active) setVersionError(errorMessage(caught));
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const items = routers.data?.items ?? [];

  useEffect(() => {
    if (!targetVersion) return;
    setSelected(
      new Set(
        items
          .filter(
            (router) =>
              router.status !== 'offline' &&
              router.agent_version !== targetVersion &&
              versionAtLeast(router.agent_version, SELF_UPDATE_MIN),
          )
          .map((router) => router.id),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routers.data, targetVersion]);

  const selectable = useMemo(
    () =>
      items.filter(
        (router) =>
          router.agent_version !== targetVersion &&
          versionAtLeast(router.agent_version, SELF_UPDATE_MIN),
      ),
    [items, targetVersion],
  );

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function updateSelected(): Promise<void> {
    if (!targetVersion || selected.size === 0 || updating) return;
    const ids = [...selected];
    setUpdating(true);
    setError(null);
    setStatus(`Отправляем обновление на ${ids.length} роутер(ов)…`);
    try {
      await api<{ jobs: Array<{ router_id: string; job_id: string }> }>(
        '/api/v1/deploy/agent-update',
        { method: 'POST', body: { router_ids: ids } },
      );

      const deadline = Date.now() + 3 * 60 * 1000;
      let last = '';
      while (Date.now() < deadline) {
        await sleep(2500);
        const data = await routers.reload();
        const list = data?.items ?? [];
        const done = ids.filter(
          (id) => list.find((router) => router.id === id)?.agent_version === targetVersion,
        ).length;
        last = `Обновлено ${done} из ${ids.length}. Агент перезапускается…`;
        setStatus(last);
        if (done === ids.length) break;
      }

      const data = await routers.reload();
      const list = data?.items ?? [];
      const failed = ids.filter(
        (id) => list.find((router) => router.id === id)?.agent_version !== targetVersion,
      );
      if (failed.length > 0) {
        setError(
          `Не подтвердили версию ${targetVersion}: ${failed
            .map((id) => list.find((router) => router.id === id)?.name ?? id)
            .join(', ')}. Проверьте связь и журнал агента.`,
        );
      } else {
        toast.success(`Агент обновлён до ${targetVersion}`);
        setStatus(`Готово: ${ids.length} роутер(ов) на версии ${targetVersion}.`);
      }
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus(null);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <Panel
      title="Агент RoutX на клиентских роутерах"
      subtitle="Обновление пакета агента из панели. Панель раздаёт собранный в её образе пакет."
    >
      {versionError ? <ErrorBanner message={versionError} /> : null}
      {error ? <ErrorBanner message={error} /> : null}
      {targetVersion ? (
        <InfoBanner>
          Доступная версия агента: <strong>{targetVersion}</strong>. Обновление идёт по HTTPS,
          пакет проверяется по SHA-256, после установки агент перезапускается сам.
        </InfoBanner>
      ) : null}
      {!versionError && !targetVersion ? <Spinner label="Читаем версию пакета…" /> : null}

      {items.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Роутер</th>
                <th>Агент</th>
                <th>Состояние</th>
              </tr>
            </thead>
            <tbody>
              {items.map((router) => {
                const current = router.agent_version;
                const actual = targetVersion != null && current === targetVersion;
                const canUpdate = versionAtLeast(current, SELF_UPDATE_MIN);
                return (
                  <tr key={router.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(router.id)}
                        onChange={() => toggle(router.id)}
                        disabled={updating || actual || !canUpdate}
                        aria-label={`Выбрать ${router.name}`}
                      />
                    </td>
                    <td>
                      <strong>{router.name}</strong>
                      <div className="muted-text small">{router.status}</div>
                      {router.owner_email ? (
                        <div className="muted-text small">владелец: {router.owner_email}</div>
                      ) : null}
                    </td>
                    <td className="mono small">{current ?? '—'}</td>
                    <td className="small">
                      {actual
                        ? 'актуально'
                        : !canUpdate
                          ? `нужно один раз обновить вручную (нужен ${SELF_UPDATE_MIN}+)`
                          : 'можно обновить'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {status ? <p className="muted-text small">{status}</p> : null}

      <div className="row" style={{ marginTop: 12 }}>
        <Button
          onClick={() => void updateSelected()}
          busy={updating}
          disabled={!targetVersion || selected.size === 0 || updating}
        >
          Обновить выбранные ({selected.size})
        </Button>
        <Button variant="ghost" onClick={() => void routers.reload()} disabled={updating}>
          Обновить список
        </Button>
        <span className="muted-text small">
          {selectable.length > 0
            ? `Доступно к обновлению: ${selectable.length}`
            : 'Все роутеры уже на доступной версии'}
        </span>
      </div>
    </Panel>
  );
}
