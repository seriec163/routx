import { useEffect, useMemo, useState } from 'react';
import { Link } from '../components/link';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBanner,
  Field,
  InfoBanner,
  Modal,
  PageHeader,
  Panel,
  Spinner,
  Stat,
  StatusBadge,
  Switch,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { copyText } from '../lib/clipboard';
import {
  formatDate,
  formatMs,
  formatRelative,
  JOB_STATUS,
  PRODUCT_LABEL,
  proxyHealth,
  ROUTER_STATUS,
} from '../lib/format';
import { navigate, useRoute } from '../lib/router';
import type {
  BindingToken,
  Job,
  MonitoringItem,
  MonitoringOverview,
  RouterRecord,
} from '../lib/types';
import { useApi } from '../lib/useApi';
import { useSession } from '../session';

const HEALTH_LABEL: Record<string, string> = {
  ok: 'Норма',
  recovered: 'Восстановлено',
  degraded: 'Деградация',
  failed: 'Ошибка',
  unknown: 'Неизвестно',
  running: 'Работает',
  stopped: 'Остановлен',
  transitioning: 'Переходное состояние',
  'running but disabled': 'Работает, автозапуск выключен',
  'stopped & disabled': 'Остановлен и отключён',
  'stopped but enabled': 'Остановлен, автозапуск включён',
};

type ProxyFilter = 'all' | 'healthy' | 'degraded' | 'dead' | 'attention';

interface BulkUpdateResult {
  batch_id: string;
  jobs: Array<{ router_id: string; job_id: string }>;
  skipped: Array<{ router_id: string; reason: string }>;
}

/**
 * Единая страница парка и мониторинга.
 *
 * Раньше «Роутеры» и «Мониторинг» показывали почти один и тот же список.
 * Теперь это одна таблица: устройство, продукт/платформа, доступность,
 * служба, прокси, задержка, связь и действия. Данные мониторинга
 * подмешиваются к записи роутера по id.
 */
export function RoutersPage() {
  const { me } = useSession();
  const toast = useToast();
  const route = useRoute();
  const isAdmin = me?.permissions.is_superadmin === true;
  const routers = useApi<{ items: RouterRecord[] }>(
    '/api/v1/routers?limit=200&include_archived=true',
  );
  const overview = useApi<MonitoringOverview>('/api/v1/monitoring/overview');

  const [view, setView] = useState<'active' | 'pending' | 'archive'>('active');
  const [query, setQuery] = useState('');
  const [proxyFilter, setProxyFilter] = useState<ProxyFilter>(() =>
    route.query.get('filter') === 'attention' ? 'attention' : 'all',
  );
  const [auto, setAuto] = useState(true);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState<RouterRecord | null>(null);
  const [binding, setBinding] = useState<{ router: RouterRecord; token: BindingToken } | null>(null);
  const [purging, setPurging] = useState<RouterRecord | null>(null);
  const [purgeName, setPurgeName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkTargets, setBulkTargets] = useState({
    routx: true,
    tachyon: true,
    tachyon_core: true,
  });
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkUpdateResult | null>(null);
  const [bulkJobs, setBulkJobs] = useState<Job[]>([]);

  const monitorById = useMemo(() => {
    const map = new Map<string, MonitoringItem>();
    for (const item of overview.data?.items ?? []) map.set(item.id, item);
    return map;
  }, [overview.data]);

  const allItems = routers.data?.items ?? [];
  const isDraft = (item: RouterRecord) =>
    !item.archived_at && item.status === 'pending' && !item.last_seen_at;
  const pendingItems = allItems.filter(isDraft);
  const activeItems = allItems.filter((item) => !item.archived_at && !isDraft(item));
  const archivedItems = allItems.filter((item) => item.archived_at);

  const filtered = useMemo(() => {
    let items =
      view === 'active' ? activeItems : view === 'pending' ? pendingItems : archivedItems;
    if (view === 'active' && proxyFilter === 'attention') {
      items = items.filter((item) => {
        const monitor = monitorById.get(item.id);
        const status = monitor?.status ?? item.status;
        return (
          status !== 'online' ||
          monitor?.proxy_health === 'degraded' ||
          monitor?.proxy_health === 'dead' ||
          Boolean(item.last_error) ||
          Boolean(monitor?.last_error)
        );
      });
    } else if (view === 'active' && proxyFilter !== 'all') {
      items = items.filter((item) => monitorById.get(item.id)?.proxy_health === proxyFilter);
    }
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        item.product.toLowerCase().includes(needle) ||
        (item.model ?? '').toLowerCase().includes(needle) ||
        (item.owner_email ?? '').toLowerCase().includes(needle),
    );
  }, [activeItems, pendingItems, archivedItems, view, query, proxyFilter, monitorById]);

  const selectableItems = useMemo(
    () => filtered.filter((item) => !item.archived_at),
    [filtered],
  );
  const allSelected =
    selectableItems.length > 0 && selectableItems.every((item) => selected.has(item.id));

  useEffect(() => {
    const filter = route.query.get('filter');
    if (filter === 'attention') {
      setView('active');
      setProxyFilter('attention');
    } else if (route.path === '/routers') {
      setProxyFilter('all');
    }
  }, [route.path, route.query.toString()]);

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => {
      void routers.reload();
      void overview.reload();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [auto, routers.reload, overview.reload]);

  useEffect(() => {
    if (!bulkResult || bulkResult.jobs.length === 0) return;
    let cancelled = false;
    let timer: number | undefined;

    async function tick(): Promise<void> {
      try {
        const jobs = await Promise.all(
          bulkResult!.jobs.map(async (item) => {
            const payload = await api<{ job: Job }>(`/api/v1/jobs/${item.job_id}`);
            return payload.job;
          }),
        );
        if (cancelled) return;
        setBulkJobs(jobs);
        if (
          jobs.every((job) =>
            ['success', 'failed', 'timeout', 'cancelled'].includes(job.status),
          )
        ) {
          void routers.reload();
          void overview.reload();
          const failed = jobs.filter((job) => job.status !== 'success').length;
          if (failed === 0) toast.success('Комплексное обновление завершено');
          else toast.error(`Обновление завершено с ошибками: ${failed}`);
          return;
        }
      } catch {
        // Сеть могла моргнуть — просто повторим.
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), 2500);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [bulkResult]);

  async function checkNow(): Promise<void> {
    const online = (overview.data?.items ?? []).filter((item) => item.status === 'online');
    if (online.length === 0) {
      toast.info('Нет роутеров в сети');
      return;
    }
    setChecking(true);
    try {
      for (const item of online) {
        await api(`/api/v1/routers/${item.id}/monitor`, { method: 'POST' });
      }
      toast.info(`Проверка запущена: ${online.length} роутер(ов)`);
      window.setTimeout(() => {
        void overview.reload();
        void routers.reload();
      }, 5000);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setChecking(false);
    }
  }

  function reloadAll(): void {
    void routers.reload();
    void overview.reload();
  }

  function toggleSelection(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible(): void {
    setSelected((current) => {
      if (allSelected) {
        const next = new Set(current);
        for (const item of selectableItems) next.delete(item.id);
        return next;
      }
      const next = new Set(current);
      for (const item of selectableItems) next.add(item.id);
      return next;
    });
  }

  function clearSelection(): void {
    setSelected(new Set());
  }

  function openBulk(): void {
    setBulkError(null);
    setBulkResult(null);
    setBulkJobs([]);
    setBulkOpen(true);
  }

  async function startBulkUpdate(): Promise<void> {
    if (selected.size === 0) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const result = await api<BulkUpdateResult>('/api/v1/routers/bulk-update', {
        method: 'POST',
        body: {
          router_ids: [...selected],
          targets: bulkTargets,
        },
      });
      setBulkResult(result);
      setBulkJobs([]);
      if (result.jobs.length === 0) {
        setBulkError('Ни один выбранный роутер не подходит для обновления.');
      } else {
        toast.success(`Запущено задач: ${result.jobs.length}`);
        if (result.skipped.length > 0) {
          toast.info(`Пропущено роутеров: ${result.skipped.length}`);
        }
      }
    } catch (caught) {
      setBulkError(errorMessage(caught));
    } finally {
      setBulkBusy(false);
    }
  }

  async function archive(): Promise<void> {
    if (!archiving) return;
    setBusy(true);
    try {
      await api(`/api/v1/routers/${archiving.id}`, { method: 'DELETE' });
      toast.success('Роутер перемещён в архив');
      setArchiving(null);
      reloadAll();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restore(router: RouterRecord): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/v1/routers/${router.id}/restore`, { method: 'POST' });
      toast.success('Роутер восстановлен из архива');
      reloadAll();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function purge(): Promise<void> {
    if (!purging || purgeName.trim() !== purging.name) return;
    setBusy(true);
    try {
      await api(`/api/v1/routers/${purging.id}?purge=true`, { method: 'DELETE' });
      toast.success('Роутер удалён навсегда');
      setPurging(null);
      setPurgeName('');
      reloadAll();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function issueToken(router: RouterRecord): Promise<void> {
    try {
      const token = await api<BindingToken>(`/api/v1/routers/${router.id}/binding-token`, {
        method: 'POST',
      });
      setBinding({ router, token });
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  const summary = overview.data?.summary;
  const proxyProblem = (summary?.proxy_degraded ?? 0) + (summary?.proxy_dead ?? 0);

  return (
    <div className="page">
      <PageHeader
        title="Роутеры и мониторинг"
        subtitle="Парк устройств, доступность, состояние службы и прокси в одном месте. Один роутер — один продукт Forkop, Prokop или Podkop."
        actions={<Button onClick={() => navigate('/routers/new')}>Добавить роутер</Button>}
      />

      {routers.error ? (
        <ErrorBanner message={routers.error} onRetry={() => void routers.reload()} />
      ) : null}
      {overview.error ? (
        <ErrorBanner message={overview.error} onRetry={() => void overview.reload()} />
      ) : null}

      <div className="stat-grid stat-grid-compact">
        <Stat label="Всего" value={summary?.total ?? allItems.filter((item) => !item.archived_at).length} hint="Без архивных" />
        <Stat label="В сети" value={summary?.online ?? 0} tone="ok" hint="Отвечали за последние 3 минуты" />
        <Stat label="Не в сети" value={summary?.offline ?? 0} tone="bad" hint="Пропущено 3 опроса подряд" />
        <Stat label="Ожидают привязки" value={summary?.pending ?? 0} tone="warn" hint="Агент ещё не подключался" />
        <Stat label="Прокси в норме" value={summary?.proxy_healthy ?? 0} tone="ok" hint="Отдельно от доступности" />
        <Stat
          label="Проблемы с прокси"
          value={proxyProblem}
          tone={proxyProblem > 0 ? 'warn' : 'ok'}
          hint="Деградация или мёртвые теги"
        />
      </div>

      <Panel
        title="Парк устройств"
        subtitle="Нажмите на имя, чтобы открыть состояние, правила, шаблоны и снимки."
        actions={
          <div className="toolbar">
            <div className="segmented">
              <button
                type="button"
                className={view === 'active' ? 'seg-active' : ''}
                onClick={() => setView('active')}
              >
                Активные ({activeItems.length})
              </button>
              <button
                type="button"
                className={view === 'pending' ? 'seg-active' : ''}
                onClick={() => setView('pending')}
              >
                Ожидают ({pendingItems.length})
              </button>
              <button
                type="button"
                className={view === 'archive' ? 'seg-active' : ''}
                onClick={() => setView('archive')}
              >
                Архив ({archivedItems.length})
              </button>
            </div>

            {view === 'active' ? (
              <div className="segmented">
                {(['all', 'attention', 'healthy', 'degraded', 'dead'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={proxyFilter === value ? 'seg-active' : ''}
                    onClick={() => setProxyFilter(value)}
                  >
                    {value === 'all'
                      ? 'Все'
                      : value === 'attention'
                        ? 'Проблемные'
                        : value === 'healthy'
                          ? 'В норме'
                          : value === 'degraded'
                            ? 'Деградация'
                            : 'Мёртв'}
                  </button>
                ))}
              </div>
            ) : null}

            <TextInput
              value={query}
              onChange={setQuery}
              placeholder="Поиск по имени, модели или владельцу"
              type="search"
            />
            <Switch checked={auto} onChange={setAuto} label="Авто 30 с" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void checkNow()}
              busy={checking}
              disabled={view !== 'active'}
            >
              Проверить сейчас
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={reloadAll}
              busy={routers.loading || overview.loading}
            >
              Обновить
            </Button>
            {selected.size > 0 ? (
              <>
                <Button size="sm" variant="subtle" onClick={openBulk}>
                  Комплексное обновление ({selected.size})
                </Button>
                <Button size="sm" variant="ghost" onClick={clearSelection}>
                  Снять выбор
                </Button>
              </>
            ) : null}
          </div>
        }
      >
        {routers.loading && !routers.data ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <Empty>
            {view === 'archive'
              ? 'Архив пуст. Архивированные роутеры появятся здесь.'
              : view === 'pending'
                ? 'Нет роутеров, ожидающих привязки.'
                : allItems.length === 0
                  ? 'Роутеров пока нет. Добавьте первый и выпустите токен привязки.'
                  : proxyFilter === 'attention'
                    ? 'Проблемных роутеров нет.'
                    : proxyFilter !== 'all'
                      ? 'Нет роутеров в выбранном фильтре прокси.'
                      : 'Ничего не найдено по запросу.'}
          </Empty>
        ) : (
          <>
            <div className="table-wrap router-table-desktop">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      aria-label="Выбрать все роутеры"
                      checked={allSelected}
                      onChange={toggleAllVisible}
                      disabled={selectableItems.length === 0}
                    />
                  </th>
                  <th>Роутер</th>
                  <th>Продукт и платформа</th>
                  <th>Статус</th>
                  <th>Служба</th>
                  <th>Прокси</th>
                  <th>Ошибка</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((router) => {
                  const monitor = monitorById.get(router.id);
                  const status = monitor?.status ?? router.status;
                  const health = monitor?.health ? HEALTH_LABEL[monitor.health] ?? monitor.health : '—';
                  const serviceState =
                    monitor?.service_state && monitor.service_state !== 'ok'
                      ? HEALTH_LABEL[monitor.service_state] ?? monitor.service_state
                      : null;
                  const tagText =
                    monitor?.total_tags != null && monitor?.failed_tags != null
                      ? `живых: ${monitor.total_tags - monitor.failed_tags}/${monitor.total_tags}`
                      : null;
                  const errorText = router.last_error ?? monitor?.last_error ?? null;
                  return (
                    <tr key={router.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Выбрать ${router.name}`}
                          checked={selected.has(router.id)}
                          onChange={() => toggleSelection(router.id)}
                          disabled={Boolean(router.archived_at)}
                        />
                      </td>
                      <td>
                        <Link to={`/routers/${router.id}`}>{router.name}</Link>
                        {router.model ? <div className="muted-text small">{router.model}</div> : null}
                        {isAdmin && router.owner_email ? (
                          <div className="muted-text small">{router.owner_email}</div>
                        ) : null}
                      </td>
                      <td className="small">
                        <div>
                          {PRODUCT_LABEL[router.product] ?? router.product}
                          {router.product_version ? ` ${router.product_version}` : ''}
                        </div>
                        <div className="muted-text">
                          {router.openwrt_version ? `OpenWrt ${router.openwrt_version}` : 'OpenWrt —'}
                          {router.arch ? ` · ${router.arch}` : ''}
                        </div>
                        <div className="muted-text">
                          sing-box {router.sing_box_version ?? '—'}
                          {router.sing_box_variant ? ` · ${router.sing_box_variant}` : ''}
                        </div>
                      </td>
                      <td>
                        {router.archived_at ? (
                          <StatusBadge status="archived" label="В архиве" />
                        ) : (
                          <StatusBadge
                            status={status}
                            label={ROUTER_STATUS[status] ?? status}
                          />
                        )}
                        {monitor?.offline_since ? (
                          <div className="muted-text small">
                            с {formatRelative(monitor.offline_since)}
                          </div>
                        ) : null}
                        <div className="muted-text small">
                          связь: {formatRelative(router.last_seen_at)}
                        </div>
                      </td>
                      <td className="small">
                        {health}
                        {serviceState ? <div className="muted-text small">{serviceState}</div> : null}
                      </td>
                      <td>
                        {monitor?.proxy_health ? (
                          <>
                            <StatusBadge
                              status={monitor.proxy_health}
                              label={proxyHealth(monitor.proxy_health)}
                            />
                            {tagText || monitor?.latency_ms != null ? (
                              <div className="muted-text small">
                                {tagText ?? ''}
                                {tagText && monitor?.latency_ms != null ? ' · ' : ''}
                                {monitor?.latency_ms != null ? formatMs(monitor.latency_ms) : ''}
                              </div>
                            ) : null}
                            {monitor?.detail ? (
                              <div className="muted-text small">{monitor.detail}</div>
                            ) : null}
                            {monitor?.ts ? (
                              <div className="muted-text small">
                                замер: {formatRelative(monitor.ts)}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="muted-text">—</span>
                        )}
                      </td>
                      <td className="small">
                        {errorText ? (
                          <span className="error-cell" title={errorText}>
                            {errorText}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="row-actions">
                        {router.archived_at ? (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void restore(router)}
                              busy={busy}
                            >
                              Восстановить
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => {
                                setPurging(router);
                                setPurgeName('');
                              }}
                            >
                              Удалить навсегда
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => void issueToken(router)}>
                              Привязка
                            </Button>
                            <Button size="sm" variant="subtle" onClick={() => setArchiving(router)}>
                              В архив
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => {
                                setPurging(router);
                                setPurgeName('');
                              }}
                            >
                              Удалить
                            </Button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="router-mobile-list">
            {filtered.map((router) => {
              const monitor = monitorById.get(router.id);
              const status = monitor?.status ?? router.status;
              const health = monitor?.health ? HEALTH_LABEL[monitor.health] ?? monitor.health : '—';
              const serviceState =
                monitor?.service_state && monitor.service_state !== 'ok'
                  ? HEALTH_LABEL[monitor.service_state] ?? monitor.service_state
                  : null;
              const tagText =
                monitor?.total_tags != null && monitor?.failed_tags != null
                  ? `${monitor.total_tags - monitor.failed_tags}/${monitor.total_tags} тегов`
                  : null;
              const errorText = router.last_error ?? monitor?.last_error ?? null;
              return (
                <article className="router-mobile-card" key={router.id}>
                  <div className="router-mobile-head">
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <input
                        type="checkbox"
                        aria-label={`Выбрать ${router.name}`}
                        checked={selected.has(router.id)}
                        onChange={() => toggleSelection(router.id)}
                        disabled={Boolean(router.archived_at)}
                        style={{ marginTop: 3 }}
                      />
                      <div>
                        <Link to={`/routers/${router.id}`}>{router.name}</Link>
                        <div className="muted-text small">{router.model ?? router.product}</div>
                        {isAdmin && router.owner_email ? (
                          <div className="muted-text small">{router.owner_email}</div>
                        ) : null}
                      </div>
                    </div>
                    {router.archived_at ? (
                      <StatusBadge status="archived" label="В архиве" />
                    ) : (
                      <StatusBadge status={status} label={ROUTER_STATUS[status] ?? status} />
                    )}
                  </div>

                  <div className="router-mobile-stats">
                    <span>
                      Служба: {health}
                      {serviceState ? ` (${serviceState})` : ''}
                    </span>
                    <span>
                      Прокси:{' '}
                      {monitor?.proxy_health ? proxyHealth(monitor.proxy_health) : '—'}
                    </span>
                    {tagText ? <span>{tagText}</span> : null}
                    <span>Задержка: {formatMs(monitor?.latency_ms)}</span>
                    <span>Связь: {formatRelative(router.last_seen_at)}</span>
                  </div>

                  <div className="muted-text small">
                    {PRODUCT_LABEL[router.product] ?? router.product}{' '}
                    {router.product_version ?? ''} · OpenWrt {router.openwrt_version ?? '—'} ·
                    sing-box {router.sing_box_version ?? '—'}
                  </div>

                  {errorText ? <p className="field-error small">{errorText}</p> : null}

                  <div className="router-mobile-actions">
                    {router.archived_at ? (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => void restore(router)} busy={busy}>
                          Восстановить
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            setPurging(router);
                            setPurgeName('');
                          }}
                        >
                          Удалить навсегда
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => void issueToken(router)}>
                          Привязка
                        </Button>
                        <Button size="sm" variant="subtle" onClick={() => setArchiving(router)}>
                          В архив
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => {
                            setPurging(router);
                            setPurgeName('');
                          }}
                        >
                          Удалить
                        </Button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          </>
        )}
      </Panel>

      <details className="advanced">
        <summary>Как считается мониторинг</summary>
        <ul className="bullets">
          <li>
            Раз в 60 секунд сервер просит агент проверить роутер. Кнопка «Проверить сейчас»
            запускает проверку немедленно.
          </li>
          <li>
            Доступность — отвечает ли агент. Роутер считается офлайн после 3 пропущенных проверок
            подряд (около 3 минут).
          </li>
          <li>
            Служба — состояние Prokop/Forkop: норма, деградация или ошибка.
          </li>
          <li>
            Прокси — реальные задержки через Clash API. Если в группе есть хотя бы одно живое
            соединение, группа считается рабочей: переключение на резервный сервер не является
            деградацией. «Мёртв» — ни один тег не ответил. Если Clash API недоступен,
            показывается «нет данных», а не ложное «мёртв».
          </li>
          <li>
            Задержка выше 1500 мс считается деградацией. Нестабильные соединения и число потерь
            связи за 24 часа видны на странице роутера во вкладке «Метрики».
          </li>
          <li>Метрики, отчёты и журналы хранятся не более 30 дней.</li>
        </ul>
      </details>

      {bulkOpen ? (
        <Modal
          title={bulkResult ? 'Комплексное обновление запущено' : 'Комплексное обновление'}
          onClose={() => setBulkOpen(false)}
          footer={
            bulkResult ? (
              <Button variant="ghost" onClick={() => setBulkOpen(false)}>
                Закрыть
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setBulkOpen(false)} disabled={bulkBusy}>
                  Отмена
                </Button>
                <Button
                  onClick={() => void startBulkUpdate()}
                  busy={bulkBusy}
                  disabled={
                    bulkBusy ||
                    selected.size === 0 ||
                    (!bulkTargets.routx && !bulkTargets.tachyon && !bulkTargets.tachyon_core)
                  }
                >
                  Запустить обновление
                </Button>
              </>
            )
          }
        >
          {bulkError ? <ErrorBanner message={bulkError} /> : null}

          {!bulkResult ? (
            <>
              <p className="page-sub">
                Выбрано роутеров: <strong>{selected.size}</strong>. Обновление выполняется
                последовательно: сначала агент RoutX, затем модуль Tachyon, затем ядро Tachyon Core.
              </p>
              <div className="stack">
                <Switch
                  checked={bulkTargets.routx}
                  onChange={(value) => setBulkTargets((current) => ({ ...current, routx: value }))}
                  label="RoutX"
                  hint="Обновить агент RoutX до версии, которая раздаётся панелью."
                />
                <Switch
                  checked={bulkTargets.tachyon}
                  onChange={(value) => setBulkTargets((current) => ({ ...current, tachyon: value }))}
                  label="Tachyon"
                  hint="Обновить модуль Tachyon: LuCI, CLI и вспомогательные ucode-модули."
                />
                <Switch
                  checked={bulkTargets.tachyon_core}
                  onChange={(value) =>
                    setBulkTargets((current) => ({ ...current, tachyon_core: value }))
                  }
                  label="Tachyon Core"
                  hint="Обновить ядро маршрутизации. Tachyon будет кратковременно перезапущен."
                />
              </div>
              <InfoBanner>
                Компоненты Tachyon обновятся только на роутерах с продуктом Tachyon. Офлайн-роутеры
                и роутеры с другими продуктами будут пропущены — их список появится после запуска.
              </InfoBanner>
            </>
          ) : (
            <>
              <p className="page-sub">
                Задач запущено: <strong>{bulkResult.jobs.length}</strong>
                {bulkResult.skipped.length > 0
                  ? ` · пропущено: ${bulkResult.skipped.length}`
                  : ''}
              </p>
              <div className="stack">
                {bulkResult.jobs.map((item) => {
                  const job = bulkJobs.find((entry) => entry.id === item.job_id);
                  const router = allItems.find((entry) => entry.id === item.router_id);
                  const phase =
                    job && typeof job.result?.phase === 'string' ? job.result.phase : null;
                  const progress =
                    job && typeof job.result?.progress === 'number'
                      ? job.result.progress
                      : null;
                  return (
                    <div
                      key={item.job_id}
                      style={{
                        border: '1px solid var(--line, rgba(120,90,120,.16))',
                        borderRadius: 12,
                        padding: 12,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: 12,
                          alignItems: 'center',
                        }}
                      >
                        <strong>{router?.name ?? item.router_id}</strong>
                        {job ? (
                          <StatusBadge
                            status={job.status}
                            label={JOB_STATUS[job.status] ?? job.status}
                          />
                        ) : (
                          <span className="muted-text small">ожидает</span>
                        )}
                      </div>
                      {phase ? (
                        <div className="muted-text small">
                          {phase}
                          {progress != null ? ` · ${progress}%` : ''}
                        </div>
                      ) : null}
                      {job?.error ? (
                        <div className="field-error small">{job.error.message}</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {bulkResult.skipped.length > 0 ? (
                <InfoBanner tone="warn">
                  Пропущены:{' '}
                  {bulkResult.skipped
                    .map((item) => {
                      const router = allItems.find((entry) => entry.id === item.router_id);
                      return `${router?.name ?? item.router_id} — ${item.reason}`;
                    })
                    .join('; ')}
                </InfoBanner>
              ) : null}
            </>
          )}
        </Modal>
      ) : null}

      {archiving ? (
        <ConfirmDialog
          title="Архивировать роутер?"
          danger
          busy={busy}
          confirmLabel="В архив"
          onCancel={() => setArchiving(null)}
          onConfirm={() => void archive()}
          message={
            <>
              <p>
                Роутер <strong>{archiving.name}</strong> будет архивирован: мониторинг отключится,
                учётные данные агента отзываются, очередь задач очищается.
              </p>
              <p className="muted-text">
                Forkop/Prokop/Podkop на самом устройстве не изменяются. Роутер можно будет восстановить из
                архива — агент подключится снова без переустановки.
              </p>
            </>
          }
        />
      ) : null}

      {purging ? (
        <Modal
          title="Удалить роутер навсегда?"
          onClose={() => {
            setPurging(null);
            setPurgeName('');
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setPurging(null);
                  setPurgeName('');
                }}
                disabled={busy}
              >
                Отмена
              </Button>
              <Button
                variant="danger"
                onClick={() => void purge()}
                busy={busy}
                disabled={purgeName.trim() !== purging.name}
              >
                Удалить навсегда
              </Button>
            </>
          }
        >
          <p>
            Роутер <strong>{purging.name}</strong> и все связанные данные будут удалены из базы:
            история мониторинга, снимки, подключения, задания, назначения шаблонов и учётные данные
            агента. Это действие необратимо.
          </p>
          <p className="muted-text">
            На самом роутере Forkop/Prokop/Podkop и RoutX не удаляются. Если агент продолжит работу, он
            получит отказ и перестанет передавать данные.
          </p>
          <Field label={`Для подтверждения введите имя «${purging.name}»`}>
            <TextInput value={purgeName} onChange={setPurgeName} placeholder={purging.name} />
          </Field>
        </Modal>
      ) : null}

      {binding ? (
        <Modal
          title={`Привязка: ${binding.router.name}`}
          wide
          onClose={() => setBinding(null)}
          footer={<Button onClick={() => setBinding(null)}>Готово</Button>}
        >
          <p className="page-sub">{binding.token.warning}</p>
          <Field label="Команда установки" hint="Выполните на роутере по SSH один раз.">
            <pre className="code-block">{binding.token.install_command}</pre>
          </Field>
          <div className="row">
            <Button
              variant="ghost"
              onClick={() => {
                void copyText(binding.token.install_command).then((ok) =>
                  ok
                    ? toast.success('Команда скопирована')
                    : toast.error('Не удалось скопировать команду'),
                );
              }}
            >
              Скопировать команду
            </Button>
            <span className="muted-text">
              Действует до {new Date(binding.token.expires_at).toLocaleTimeString('ru-RU')}
            </span>
          </div>
          <Field label="Сервер" hint="Роутер подключается исходящим TLS-соединением.">
            <pre className="code-block">{binding.token.server_url}</pre>
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
