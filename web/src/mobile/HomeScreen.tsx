import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { PRODUCT_LABEL } from '../lib/format';
import { waitForJob } from '../lib/jobs';
import type { Job, MonitoringItem, RuleConnectionView, RulesResponse } from '../lib/types';
import { useApi } from '../lib/useApi';
import { JobProgress, useToast } from '../components/ui';
import { navigate } from '../lib/router';
import { MobileHeader, useMobile } from './MobileApp';
import { SiteStatusCard } from './SiteStatusCard';
import { InstallGuide } from './InstallGuide';
import { requestCamera } from './camera';
import { updatePwa } from './pwaUpdate';
import { hapticSuccess, hapticTap } from './haptics';

const STATUS: Record<string, { label: string; tone: string }> = {
  online: { label: 'Подключено', tone: 'ok' },
  offline: { label: 'Нет связи', tone: 'bad' },
  pending: { label: 'Ожидает привязки', tone: 'warn' },
  unsupported: { label: 'Не поддерживается', tone: 'warn' },
  conflict: { label: 'Конфликт продуктов', tone: 'bad' },
};

interface ConnectionEntry extends RuleConnectionView {
  section: string;
  sectionLabel: string;
}

export function HomeScreen() {
  const { routers, routerGroups, selected, selectedId, select, reload, loading } = useMobile();
  const toast = useToast();
  const [now, setNow] = useState(() => new Date());
  const [sheet, setSheet] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [action, setAction] = useState<'idle' | 'ping' | 'vpn' | 'reboot' | 'select'>('idle');
  const [replaceTarget, setReplaceTarget] = useState<ConnectionEntry | null>(null);
  const [replaceValue, setReplaceValue] = useState('');
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [replaceJob, setReplaceJob] = useState<Job | null>(null);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [subscriptionMode, setSubscriptionMode] = useState<'add' | 'replace'>('replace');
  const [subscriptionSection, setSubscriptionSection] = useState('');
  const [subscriptionUrl, setSubscriptionUrl] = useState('');
  const [subscriptionBusy, setSubscriptionBusy] = useState(false);
  const [subscriptionJob, setSubscriptionJob] = useState<Job | null>(null);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);
  const [subscriptionSource, setSubscriptionSource] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [subscriptionView, setSubscriptionView] = useState<ConnectionEntry | null>(null);
  const [outboundTarget, setOutboundTarget] = useState<ConnectionEntry | null>(null);
  const [outboundValue, setOutboundValue] = useState('');
  const [outboundBusy, setOutboundBusy] = useState(false);
  const [outboundJob, setOutboundJob] = useState<Job | null>(null);
  const [outboundError, setOutboundError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [installBannerHidden, setInstallBannerHidden] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [pwaBusy, setPwaBusy] = useState(false);

  const rules = useApi<RulesResponse>(
    selected ? `/api/v1/routers/${selected.id}/rules` : null,
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setStandalone(
      window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true,
    );
  }, []);

  useEffect(() => {
    if (!selected || selected.status !== 'online') return;
    let cancelled = false;
    void (async () => {
      try {
        const started = await api<{ job: Job }>(
          `/api/v1/routers/${selected.id}/rules/read`,
          { method: 'POST' },
        );
        await waitForJob(started.job);
        if (!cancelled) await rules.reload();
      } catch {
        // Кэш уже показан; ошибка live-чтения не блокирует экран.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const protocolChips = useMemo(() => {
    const chips = new Set<string>();
    for (const rule of rules.data?.rules ?? []) {
      if (rule.subscriptions.length > 0) chips.add('Подписка');
      if (rule.links.length > 0) chips.add('VLESS');
    }
    return [...chips];
  }, [rules.data]);

  const connections = useMemo<ConnectionEntry[]>(() => {
    const items: ConnectionEntry[] = [];
    for (const rule of rules.data?.rules ?? []) {
      for (const connection of [...rule.subscriptions, ...rule.links]) {
        items.push({
          ...connection,
          section: rule.section,
          sectionLabel: rule.label,
        });
      }
    }
    return items;
  }, [rules.data]);

  const subscriptionBySection = useMemo(() => {
    const map = new Map<string, ConnectionEntry>();
    for (const connection of connections) {
      if (connection.kind !== 'subscription' || connection.synthetic) continue;
      if (!map.has(connection.section)) map.set(connection.section, connection);
    }
    return map;
  }, [connections]);

  const subscriptionItems = useMemo(() => {
    const map = new Map<string, ConnectionEntry[]>();
    for (const connection of connections) {
      if (connection.kind !== 'link' || connection.synthetic) continue;
      if (!subscriptionBySection.has(connection.section)) continue;
      const items = map.get(connection.section) ?? [];
      items.push(connection);
      map.set(connection.section, items);
    }
    return map;
  }, [connections, subscriptionBySection]);

  const mainConnections = useMemo(
    () =>
      connections.filter(
        (connection) =>
          connection.kind === 'subscription' ||
          connection.synthetic ||
          !subscriptionBySection.has(connection.section),
      ),
    [connections, subscriptionBySection],
  );

  const selectGroups = useMemo(() => {
    const map = new Map<
      string,
      { section: string; sectionLabel: string; items: ConnectionEntry[] }
    >();
    for (const connection of connections) {
      if (!connection.selectable || !connection.proxy_tag) continue;
      if (subscriptionBySection.has(connection.section)) continue;
      const group = map.get(connection.section) ?? {
        section: connection.section,
        sectionLabel: connection.sectionLabel,
        items: [],
      };
      group.items.push(connection);
      map.set(connection.section, group);
    }
    return [...map.values()];
  }, [connections, subscriptionBySection]);

  const subscriptionViewItems = subscriptionView
    ? subscriptionItems.get(subscriptionView.section) ?? []
    : [];
  const subscriptionViewActive = subscriptionViewItems.find((item) => item.active) ?? null;
  const connectionCount = connections.filter((item) => item.kind === 'link').length;

  const status = selected ? STATUS[selected.status] ?? { label: selected.status, tone: 'warn' } : null;
  const latency = selected?.latency_ms;
  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  async function selectConnection(connection: ConnectionEntry): Promise<void> {
    if (
      !selected ||
      action !== 'idle' ||
      !connection.proxy_group ||
      !connection.proxy_tag
    )
      return;
    setAction('select');
    hapticTap();
    try {
      const started = await api<{ job: Job }>(
        `/api/v1/routers/${selected.id}/proxies/select`,
        {
          method: 'POST',
          body: { group: connection.proxy_group, tag: connection.proxy_tag },
        },
      );
      setJob(started.job);
      const done = await waitForJob(started.job, setJob);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'Не удалось переключить подключение');
      }
      await Promise.all([reload(), rules.reload()]);
      hapticSuccess();
      toast.success('Активное подключение переключено');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setAction('idle');
      setJob(null);
    }
  }

  function openSubscription(section?: string, connection?: ConnectionEntry): void {
    const first = section ?? rules.data?.rules[0]?.section ?? 'main';
    setSubscriptionSection(first);
    setSubscriptionUrl('');
    setSubscriptionMode('replace');
    setSubscriptionError(null);
    setSubscriptionJob(null);
    setSubscriptionSource(
      connection?.kind === 'subscription' && connection.id
        ? { id: connection.id, label: connection.label }
        : null,
    );
    setSubscriptionOpen(true);
  }

  async function saveSubscription(useExisting = false): Promise<void> {
    if (!selected || (!useExisting && subscriptionUrl.trim() === '')) return;
    setSubscriptionBusy(true);
    setSubscriptionError(null);
    setSubscriptionJob(null);
    try {
      const started = await api<{ job: Job }>(
        `/api/v1/routers/${selected.id}/podkop/subscription`,
        {
          method: 'POST',
          body: {
            section: subscriptionSection,
            mode: subscriptionMode,
            ...(useExisting
              ? { connection_id: subscriptionSource?.id }
              : { url: subscriptionUrl.trim() }),
          },
        },
      );
      setSubscriptionJob(started.job);
      const done = await waitForJob(started.job, undefined, 600_000);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'Не удалось применить подписку');
      }
      toast.success('Подписка разобрана на подключения');
      setSubscriptionOpen(false);
      await rules.reload();
    } catch (caught) {
      setSubscriptionError(errorMessage(caught));
    } finally {
      setSubscriptionBusy(false);
    }
  }

  function openOutbound(connection: ConnectionEntry): void {
    setOutboundTarget(connection);
    setOutboundValue('');
    setOutboundError(null);
    setOutboundJob(null);
  }

  async function saveOutbound(): Promise<void> {
    if (!selected || !outboundTarget || outboundValue.trim() === '') return;
    setOutboundBusy(true);
    setOutboundError(null);
    setOutboundJob(null);
    try {
      const started = await api<{ job: Job }>(
        `/api/v1/routers/${selected.id}/podkop/outbound`,
        {
          method: 'PUT',
          body: {
            section: outboundTarget.section,
            outbound_json: outboundValue.trim(),
          },
        },
      );
      setOutboundJob(started.job);
      const done = await waitForJob(started.job, undefined, 300_000);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'Не удалось сохранить outbound JSON');
      }
      toast.success('Outbound JSON сохранён');
      setOutboundTarget(null);
      await rules.reload();
    } catch (caught) {
      setOutboundError(errorMessage(caught));
    } finally {
      setOutboundBusy(false);
    }
  }

  async function testPing(): Promise<void> {
    if (!selected || action !== 'idle') return;
    setAction('ping');
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${selected.id}/monitor`, {
        method: 'POST',
      });
      setJob(started.job);
      const done = await waitForJob(started.job, setJob);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'Проверка не удалась');
      }
      await reload();
      toast.success('Задержка обновлена');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setAction('idle');
      setJob(null);
    }
  }

  async function restartVpn(): Promise<void> {
    if (!selected || action !== 'idle') return;
    if (!window.confirm(`Перезапустить VPN на роутере «${selected.name}»?`)) return;
    setAction('vpn');
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${selected.id}/service`, {
        method: 'POST',
        body: { action: 'restart' },
      });
      setJob(started.job);
      const done = await waitForJob(started.job, setJob);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'Служба не перезапустилась');
      }
      await reload();
      toast.success('VPN перезапущен');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setAction('idle');
      setJob(null);
    }
  }

  async function rebootRouter(): Promise<void> {
    if (!selected || action !== 'idle') return;
    const confirmed = window.confirm(
      `Перезагрузить роутер «${selected.name}»?\n\nСвязь пропадёт примерно на минуту. VPN, правила и подключения сохранятся.`,
    );
    if (!confirmed) return;
    setAction('reboot');
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${selected.id}/reboot`, {
        method: 'POST',
      });
      setJob(started.job);
      const done = await waitForJob(started.job, setJob);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'Роутер не принял команду');
      }
      toast.info('Роутер перезагружается. Это займёт около минуты.');
      await reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setAction('idle');
      setJob(null);
    }
  }

  async function replaceConnection(): Promise<void> {
    if (!selected || !replaceTarget) return;
    const value = replaceValue.trim();
    if (value === '') {
      setReplaceError(
        replaceTarget.kind === 'subscription'
          ? 'Вставьте новую ссылку подписки https://…'
          : 'Вставьте новую ссылку подключения',
      );
      return;
    }
    if (replaceTarget.kind === 'subscription' && !/^https?:\/\//i.test(value)) {
      setReplaceError('Ссылка подписки должна начинаться с http:// или https://');
      return;
    }
    if (!replaceTarget.id && !replaceTarget.name && !replaceTarget.hash) {
      setReplaceError('Не удалось определить подключение на роутере. Обновите список.');
      return;
    }

    setReplaceBusy(true);
    setReplaceError(null);
    try {
      let response: { job: Job };
      if (replaceTarget.managed && replaceTarget.id) {
        response = await api<{ job: Job }>(
          `/api/v1/routers/${selected.id}/connections/${replaceTarget.id}`,
          {
            method: 'PATCH',
            body: { label: replaceTarget.label, value },
          },
        );
      } else {
        response = await api<{ job: Job }>(
          `/api/v1/routers/${selected.id}/connections/manage`,
          {
            method: 'POST',
            body: {
              action: 'replace',
              kind: replaceTarget.kind === 'subscription' ? 'subscription' : 'link',
              name: replaceTarget.name ?? undefined,
              hash: replaceTarget.hash ?? undefined,
              value,
              section: replaceTarget.section,
            },
          },
        );
      }

      setReplaceJob(response.job);
      const done = await waitForJob(response.job, setReplaceJob);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'Не удалось заменить подключение');
      }
      await rules.reload();
      toast.success('Подключение заменено');
      setReplaceTarget(null);
      setReplaceValue('');
    } catch (caught) {
      setReplaceError(errorMessage(caught));
    } finally {
      setReplaceBusy(false);
      setReplaceJob(null);
    }
  }

  async function openQrScanner(): Promise<void> {
    // Запрашиваем камеру прямо из жеста, чтобы не требовалось второе нажатие.
    await requestCamera();
    navigate('/app/routers?add=1');
  }

  async function refreshPwa(): Promise<void> {
    if (pwaBusy) return;
    setPwaBusy(true);
    try {
      await updatePwa();
    } catch (caught) {
      toast.error(errorMessage(caught));
      setPwaBusy(false);
    }
  }

  return (
    <div className="m-screen">
      <MobileHeader
        right={
          <button
            type="button"
            className="m-iconbtn"
            aria-label="Сканировать QR"
            onClick={() => void openQrScanner()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3" />
              <path d="M4 12h16" />
            </svg>
          </button>
        }
      />

      <div className="m-body">
        {!standalone && !installBannerHidden ? (
          <div className="m-installbar">
            <div className="m-installbar-text">
              <strong>Установить RoutX</strong>
              <span>Иконка на домашнем экране, без адресной строки</span>
            </div>
            <button type="button" className="m-mini" onClick={() => setGuideOpen(true)}>
              Инструкция
            </button>
            <button
              type="button"
              className="m-installbar-close"
              aria-label="Скрыть"
              onClick={() => setInstallBannerHidden(true)}
            >
              ×
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className="m-routerchip"
          onClick={() => setSheet(true)}
          aria-haspopup="listbox"
        >
          <span>{selected?.name ?? (loading ? 'Загрузка…' : 'Нет роутеров')}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 10 5 5 5-5" />
          </svg>
        </button>

        <section className="m-card m-hero">
          <span className={`m-status m-status-${status?.tone ?? 'warn'}`}>
            <span className="m-dot" />
            {status?.label ?? 'Нет данных'}
          </span>
          <div className="m-clock">{time}</div>
          <div className="m-date">{date}</div>
          {selected ? (
            <button type="button" className="m-link" onClick={() => navigate('/app/routers')}>
              {PRODUCT_LABEL[selected.product] ?? selected.product}
              {selected.product_version ? ` ${selected.product_version}` : ''}
              {selected.sing_box_version ? ` · sing-box ${selected.sing_box_version}` : ''}
            </button>
          ) : (
            <button type="button" className="m-link" onClick={() => navigate('/app/routers')}>
              Добавьте роутер, чтобы начать
            </button>
          )}
        </section>

        {protocolChips.length > 0 ? (
          <div className="m-chips">
            {protocolChips.map((chip) => (
              <span className="m-chip" key={chip}>
                {chip}
              </span>
            ))}
          </div>
        ) : null}

        {connections.length > 0 ? (
          <section className="m-card m-list">
            <div className="m-list-head">
              <span className="m-label">Подключения · {connectionCount}</span>
              <div className="m-list-actions">
                <button
                  type="button"
                  className="m-mini"
                  onClick={() => void rules.reload()}
                  disabled={rules.loading}
                >
                  Обновить
                </button>
                {selected?.product === 'podkop' ? (
                  <button type="button" className="m-mini" onClick={() => openSubscription()}>
                    Подписка
                  </button>
                ) : null}
              </div>
            </div>
            {selectGroups.map((group) => {
              const active = group.items.find((item) => item.active);
              return (
                <div className="m-select-row" key={group.section}>
                  <span className="m-label">Активное · {group.sectionLabel}</span>
                  <select
                    className="m-select"
                    value={active?.proxy_tag ?? ''}
                    onChange={(event) => {
                      const connection = group.items.find(
                        (item) => item.proxy_tag === event.target.value,
                      );
                      if (connection) void selectConnection(connection);
                    }}
                    disabled={!selected || selected.status !== 'online' || action !== 'idle'}
                  >
                    {group.items.map((connection) => (
                      <option key={connection.proxy_tag} value={connection.proxy_tag}>
                        {connection.label}
                        {connection.delay_ms != null
                          ? ` · ${Math.round(connection.delay_ms)} мс`
                          : ''}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
            {mainConnections.map((connection) => {
              if (connection.kind === 'subscription') {
                const items = subscriptionItems.get(connection.section) ?? [];
                const active = items.find((item) => item.active);
                const title =
                  connection.label === 'Подписка' && connection.host
                    ? connection.host
                    : connection.label;
                const open = () => {
                  hapticTap();
                  setSubscriptionView(connection);
                };
                return (
                  <div
                    className="m-listrow m-listrow-tap"
                    key={`sub:${connection.section}:${connection.id ?? connection.name ?? ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={open}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        open();
                      }
                    }}
                  >
                    <span className="m-conn">
                      <span className="m-conn-label">{title}</span>
                      <span className="m-conn-meta">
                        Подписка · {connection.sectionLabel} · {items.length} подключений
                        {active ? ` · активно: ${active.label}` : ''}
                        {connection.missing && selected?.product !== 'podkop'
                          ? ' · нет на роутере'
                          : ''}
                      </span>
                    </span>
                    <svg className="m-chevron" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </div>
                );
              }
              return (
                <div
                  className="m-listrow"
                  key={`${connection.section}:${connection.kind}:${
                    connection.id ?? connection.name ?? connection.hash
                  }`}
                >
                  <span className="m-conn">
                    <span className="m-conn-label">{connection.label}</span>
                    <span className="m-conn-meta">
                      {connection.synthetic ? 'JSON outbound' : 'VLESS'} ·{' '}
                      {connection.sectionLabel} ·{' '}
                      {connection.synthetic ? connection.host : connection.masked}
                      {connection.missing ? ' · нет на роутере' : ''}
                      {!connection.enabled ? ' · выключено' : ''}
                      {connection.kind === 'link' && connection.active ? ' · активно' : ''}
                      {connection.kind === 'link' && connection.delay_ms != null
                        ? ` · ${Math.round(connection.delay_ms)} мс`
                        : connection.kind === 'link' && connection.alive === false
                          ? ' · не отвечает'
                          : ''}
                    </span>
                  </span>
                  {connection.selectable && !connection.active ? (
                    <button
                      type="button"
                      className="m-mini"
                      onClick={() => void selectConnection(connection)}
                      disabled={!selected || selected.status !== 'online' || action !== 'idle'}
                    >
                      {action === 'select' ? 'Переключаем…' : 'Выбрать'}
                    </button>
                  ) : null}
                  {connection.synthetic ? (
                    selected?.product === 'podkop' ||
                    selected?.product === 'forkop' ||
                    selected?.product === 'tachyon' ? (
                      <button
                        type="button"
                        className="m-mini"
                        onClick={() => openSubscription(connection.section)}
                        disabled={!selected || selected.status !== 'online'}
                      >
                        Подписка
                      </button>
                    ) : null
                  ) : (
                    <button
                      type="button"
                      className="m-mini"
                      onClick={() => {
                        setReplaceTarget(connection);
                        setReplaceValue('');
                        setReplaceError(null);
                      }}
                      disabled={
                        !selected ||
                        selected.status !== 'online' ||
                        (!connection.id && !connection.name && !connection.hash)
                      }
                    >
                      Заменить
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        ) : null}

        <section className="m-card m-latency">
          <div>
            <div className="m-label">Задержка · активный сервер</div>
            <div className="m-latency-value">
              {latency != null ? Math.round(latency) : '—'} <small>мс</small>
            </div>
          </div>
          <button
            type="button"
            className="m-ghost m-ghost-sm"
            onClick={() => void testPing()}
            disabled={!selected || action !== 'idle'}
          >
            {action === 'ping' ? 'Проверяем…' : 'Тест пинга'}
          </button>
        </section>

        <section className="m-card m-ipcard">
          <div className="m-iprow">
            <span className="m-label">IP без VPN</span>
            <code className="m-ip">{selected?.direct_ip ?? '—'}</code>
          </div>
          <div className="m-iprow">
            <span className="m-label">IP через VPN</span>
            <code className="m-ip">{selected?.vpn_ip ?? '—'}</code>
          </div>
          <p className="m-footnote">
            Без VPN — прямой выход роутера, через VPN — выход активного сервера.
          </p>
        </section>

        {selected ? (
          <SiteStatusCard
            key={selected.id}
            routerId={selected.id}
            online={selected.status === 'online'}
          />
        ) : null}

        <section className="m-card m-update-card">
          <div className="m-update-main">
            <span className="m-label">Приложение RoutX</span>
            <strong>Обновить без переустановки</strong>
            <p className="m-note">
              Загрузит свежую версию и перезапустит приложение. Вход, настройки и привязка
              сохранятся — QR сканировать заново не нужно.
            </p>
            <span className="m-build">
              Сборка{' '}
              {new Date(__BUILD_TIME__).toLocaleString('ru-RU', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
              {' · '}
              {standalone ? 'PWA' : 'браузер'}
              {' · '}
              {window.innerHeight} px
            </span>
          </div>
          <button
            type="button"
            className="m-mini"
            onClick={() => void refreshPwa()}
            disabled={pwaBusy}
          >
            {pwaBusy ? 'Обновляем…' : 'Обновить'}
          </button>
        </section>

        <button
          type="button"
          className="m-action"
          onClick={() => navigate('/app/bypass')}
          disabled={!selected}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Добавить адрес для обхода
        </button>

        <div className="m-row2">
          <button
            type="button"
            className="m-ghost"
            onClick={() => void restartVpn()}
            disabled={!selected || action !== 'idle'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 12a8 8 0 1 0 2.6-5.9" />
              <path d="M4 4v4h4" />
            </svg>
            <span>{action === 'vpn' ? 'Перезапуск…' : 'Перезагрузить VPN'}</span>
          </button>
          <button
            type="button"
            className="m-ghost"
            onClick={() => void rebootRouter()}
            disabled={!selected || action !== 'idle'}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3v9" />
              <path d="M6.5 7a8 8 0 1 0 11 0" />
            </svg>
            <span>{action === 'reboot' ? 'Перезагрузка…' : 'Перезагрузить роутер'}</span>
          </button>
        </div>

        <JobProgress job={job} label="Выполняем на роутере" />

        {routers.length === 0 && !loading ? (
          <div className="m-card m-empty">
            <p>Роутеров пока нет.</p>
            <button type="button" className="m-link" onClick={() => navigate('/app/routers')}>
              Добавить роутер
            </button>
          </div>
        ) : null}
      </div>

      <InstallGuide open={guideOpen} onClose={() => setGuideOpen(false)} />

      {replaceTarget ? (
        <div
          className="m-overlay"
          role="dialog"
          aria-modal="true"
          onClick={replaceBusy ? undefined : () => setReplaceTarget(null)}
        >
          <div className="m-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="m-sheet-grip" />
            <h2 className="m-sheet-title">Заменить подключение</h2>
            <p className="m-note">
              Секция «{replaceTarget.sectionLabel}». Сейчас используется:{' '}
              <strong>{replaceTarget.label}</strong> · {replaceTarget.masked}
            </p>
            {replaceError ? <p className="m-note m-note-warn">{replaceError}</p> : null}
            <label className="m-inputlabel" htmlFor="replace-value">
              {replaceTarget.kind === 'subscription' ? 'Новая ссылка подписки' : 'Новая ссылка VLESS'}
            </label>
            <textarea
              id="replace-value"
              className="m-input m-textarea"
              rows={4}
              value={replaceValue}
              onChange={(event) => setReplaceValue(event.target.value)}
              placeholder={
                replaceTarget.kind === 'subscription'
                  ? 'https://example.com/subscription'
                  : 'vless://…'
              }
              spellCheck={false}
              disabled={replaceBusy}
            />
            <p className="m-note">
              Новая ссылка заменит текущую в секции «{replaceTarget.sectionLabel}». Старый сервер
              перестанет использоваться.
            </p>
            <JobProgress job={replaceJob} label="Заменяем на роутере" />
            <button
              type="button"
              className="m-action m-action-sm"
              onClick={() => void replaceConnection()}
              disabled={replaceBusy || replaceValue.trim() === ''}
            >
              {replaceBusy ? 'Заменяем…' : 'Заменить'}
            </button>
            <button
              type="button"
              className="m-link m-link-center"
              onClick={() => setReplaceTarget(null)}
              disabled={replaceBusy}
            >
              Отмена
            </button>
          </div>
        </div>
      ) : null}

      {subscriptionView ? (
        <div
          className="m-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setSubscriptionView(null)}
        >
          <div className="m-sheet m-sheet-tall" onClick={(event) => event.stopPropagation()}>
            <div className="m-sheet-grip" />
            <div className="m-sheet-head">
              <h2 className="m-sheet-title">
                {subscriptionView.label === 'Подписка' && subscriptionView.host
                  ? subscriptionView.host
                  : subscriptionView.label}
              </h2>
              <button
                type="button"
                className="m-iconbtn"
                aria-label="Закрыть"
                onClick={() => setSubscriptionView(null)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            <p className="m-note">
              Подписка · {subscriptionView.sectionLabel} · {subscriptionViewItems.length}{' '}
              подключений
              {subscriptionViewActive ? ` · сейчас активно: ${subscriptionViewActive.label}` : ''}
            </p>

            {subscriptionViewItems.length === 0 ? (
              <p className="m-note m-note-warn">
                В этой подписке пока нет подключений на роутере. Обновите подписку или
                дождитесь чтения состояния.
              </p>
            ) : (
              <div className="m-card m-list">
                {subscriptionViewItems.map((item) => (
                  <div
                    className={`m-listrow ${item.active ? 'm-listrow-active' : ''}`}
                    key={item.id ?? item.hash ?? item.label}
                  >
                    <span className="m-conn">
                      <span className="m-conn-label">{item.label}</span>
                      <span className="m-conn-meta">
                        {item.host}
                        {item.delay_ms != null
                          ? ` · ${Math.round(item.delay_ms)} мс`
                          : item.alive === false
                            ? ' · не отвечает'
                            : ''}
                        {item.missing ? ' · нет на роутере' : ''}
                      </span>
                    </span>
                    {item.active ? (
                      <span className="m-active-pill">активно</span>
                    ) : item.selectable ? (
                      <button
                        type="button"
                        className="m-mini"
                        onClick={() => void selectConnection(item)}
                        disabled={!selected || selected.status !== 'online' || action !== 'idle'}
                      >
                        {action === 'select' ? 'Переключаем…' : 'Выбрать'}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            <button
              type="button"
              className="m-action m-action-sm"
              onClick={() => void rules.reload()}
              disabled={rules.loading}
            >
              {rules.loading ? 'Обновляем…' : 'Обновить список'}
            </button>
            {selected?.product === 'podkop' ? (
              <button
                type="button"
                className="m-action m-action-sm"
                onClick={() => {
                  const current = subscriptionView;
                  setSubscriptionView(null);
                  openSubscription(current.section, current);
                }}
                disabled={!selected || selected.status !== 'online'}
              >
                Изменить подписку
              </button>
            ) : null}
            <button
              type="button"
              className="m-link m-link-center"
              onClick={() => setSubscriptionView(null)}
            >
              Закрыть
            </button>
          </div>
        </div>
      ) : null}

      {subscriptionOpen ? (
        <div
          className="m-overlay"
          role="dialog"
          aria-modal="true"
          onClick={subscriptionBusy ? undefined : () => setSubscriptionOpen(false)}
        >
          <div className="m-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="m-sheet-grip" />
            <h2 className="m-sheet-title">Подписка Podkop</h2>
            <p className="m-note">
              RoutX скачает подписку и сохранит ссылки как отдельные подключения. URL подписки
              на роутер не передаётся.
            </p>
            {subscriptionSource ? (
              <p className="m-note">
                Текущая подписка: «{subscriptionSource.label}». Кнопка «Обновить текущую»
                перечитает её по сохранённой ссылке.
              </p>
            ) : null}
            <label className="m-inputlabel" htmlFor="sub-section">
              Секция
            </label>
            <select
              id="sub-section"
              className="m-input"
              value={subscriptionSection}
              onChange={(event) => setSubscriptionSection(event.target.value)}
              disabled={subscriptionBusy}
            >
              {(rules.data?.rules ?? []).map((rule) => (
                <option key={rule.section} value={rule.section}>
                  {rule.label} ({rule.section})
                </option>
              ))}
            </select>
            <label className="m-inputlabel" htmlFor="sub-mode">
              Режим
            </label>
            <select
              id="sub-mode"
              className="m-input"
              value={subscriptionMode}
              onChange={(event) =>
                setSubscriptionMode(event.target.value as 'add' | 'replace')
              }
              disabled={subscriptionBusy}
            >
              <option value="add">Добавить к текущим</option>
              <option value="replace">Заменить все подключения</option>
            </select>
            <label className="m-inputlabel" htmlFor="sub-url">
              URL подписки
            </label>
            <textarea
              id="sub-url"
              className="m-input m-textarea"
              rows={3}
              value={subscriptionUrl}
              onChange={(event) => setSubscriptionUrl(event.target.value)}
              placeholder="https://example.com/subscription"
              spellCheck={false}
              disabled={subscriptionBusy}
            />
            {subscriptionMode === 'replace' ? (
              <p className="m-note m-note-warn">
                Текущие ссылки выбранной секции будут заменены ссылками из подписки.
              </p>
            ) : null}
            {subscriptionError ? (
              <p className="m-note m-note-warn">{subscriptionError}</p>
            ) : null}
            <JobProgress job={subscriptionJob} label="Разбираем подписку" />
            {subscriptionSource ? (
              <button
                type="button"
                className="m-action m-action-sm"
                onClick={() => void saveSubscription(true)}
                disabled={subscriptionBusy}
              >
                {subscriptionBusy ? 'Применяем…' : 'Обновить текущую подписку'}
              </button>
            ) : null}
            <button
              type="button"
              className="m-action m-action-sm"
              onClick={() => void saveSubscription(false)}
              disabled={subscriptionBusy || subscriptionUrl.trim() === ''}
            >
              {subscriptionBusy ? 'Применяем…' : 'Применить подписку'}
            </button>
            <button
              type="button"
              className="m-link m-link-center"
              onClick={() => setSubscriptionOpen(false)}
              disabled={subscriptionBusy}
            >
              Отмена
            </button>
          </div>
        </div>
      ) : null}

      {outboundTarget ? (
        <div
          className="m-overlay"
          role="dialog"
          aria-modal="true"
          onClick={outboundBusy ? undefined : () => setOutboundTarget(null)}
        >
          <div className="m-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="m-sheet-grip" />
            <h2 className="m-sheet-title">Outbound JSON</h2>
            <p className="m-note">
              Секция «{outboundTarget.sectionLabel}». Текущий JSON скрыт; вставьте объект
              целиком. При ошибке Podkop откатит конфигурацию.
            </p>
            <textarea
              className="m-input m-textarea"
              rows={10}
              value={outboundValue}
              onChange={(event) => setOutboundValue(event.target.value)}
              placeholder={'{"type":"vless","server":"example.com",…}'}
              spellCheck={false}
              disabled={outboundBusy}
            />
            {outboundError ? <p className="m-note m-note-warn">{outboundError}</p> : null}
            <JobProgress job={outboundJob} label="Проверяем и применяем" />
            <button
              type="button"
              className="m-action m-action-sm"
              onClick={() => void saveOutbound()}
              disabled={outboundBusy || outboundValue.trim() === ''}
            >
              {outboundBusy ? 'Применяем…' : 'Сохранить JSON'}
            </button>
            <button
              type="button"
              className="m-link m-link-center"
              onClick={() => setOutboundTarget(null)}
              disabled={outboundBusy}
            >
              Отмена
            </button>
          </div>
        </div>
      ) : null}

      {sheet ? (
        <div className="m-overlay" role="dialog" aria-modal="true" onClick={() => setSheet(false)}>
          <div className="m-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="m-sheet-grip" />
            <h2 className="m-sheet-title">Выберите роутер</h2>
            {routerGroups.map((group) => (
              <div className="m-router-group" key={group.id}>
                <div className="m-router-group-head">
                  <span className="m-label">{group.label}</span>
                  <span className="m-router-group-count">{group.items.length}</span>
                </div>
                {group.items.map((router) => (
                  <button
                    type="button"
                    key={router.id}
                    className={`m-pick ${router.id === selectedId ? 'm-pick-active' : ''}`}
                    onClick={() => {
                      select(router.id);
                      setSheet(false);
                    }}
                  >
                    <StatusDot item={router} />
                    <span className="m-pick-name">{router.name}</span>
                    <span className="m-pick-meta">
                      {PRODUCT_LABEL[router.product] ?? router.product}
                      {router.latency_ms != null ? ` · ${Math.round(router.latency_ms)} мс` : ''}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            <button
              type="button"
              className="m-sheet-add"
              onClick={() => {
                setSheet(false);
                navigate('/app/routers');
              }}
            >
              + Добавить роутер
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function StatusDot({ item }: { item: MonitoringItem }) {
  const tone =
    item.status === 'online' ? 'ok' : item.status === 'offline' ? 'bad' : 'warn';
  return <span className={`m-dot m-dot-${tone}`} aria-hidden="true" />;
}
