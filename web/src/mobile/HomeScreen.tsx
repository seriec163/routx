import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { waitForJob } from '../lib/jobs';
import type { Job, MonitoringItem, RuleConnectionView, RulesResponse } from '../lib/types';
import { useApi } from '../lib/useApi';
import { JobProgress, useToast } from '../components/ui';
import { navigate } from '../lib/router';
import { MobileHeader, useMobile } from './MobileApp';
import { SiteStatusCard } from './SiteStatusCard';
import { requestCamera } from './camera';

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
  const { routers, selected, selectedId, select, reload, loading } = useMobile();
  const toast = useToast();
  const [now, setNow] = useState(() => new Date());
  const [sheet, setSheet] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [action, setAction] = useState<'idle' | 'ping' | 'vpn' | 'reboot'>('idle');
  const [replaceTarget, setReplaceTarget] = useState<ConnectionEntry | null>(null);
  const [replaceValue, setReplaceValue] = useState('');
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [replaceJob, setReplaceJob] = useState<Job | null>(null);

  const rules = useApi<RulesResponse>(
    selected ? `/api/v1/routers/${selected.id}/rules` : null,
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

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

  const status = selected ? STATUS[selected.status] ?? { label: selected.status, tone: 'warn' } : null;
  const latency = selected?.latency_ms;
  const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

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
              {selected.product === 'prokop' ? 'Prokop' : 'Forkop'}
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
              <span className="m-label">Подключения · {connections.length}</span>
              <button
                type="button"
                className="m-mini"
                onClick={() => void rules.reload()}
                disabled={rules.loading}
              >
                Обновить
              </button>
            </div>
            {connections.map((connection) => (
              <div
                className="m-listrow"
                key={`${connection.section}:${connection.kind}:${
                  connection.id ?? connection.name ?? connection.hash
                }`}
              >
                <span className="m-conn">
                  <span className="m-conn-label">{connection.label}</span>
                  <span className="m-conn-meta">
                    {connection.kind === 'subscription' ? 'Подписка' : 'VLESS'} ·{' '}
                    {connection.sectionLabel} · {connection.masked}
                    {connection.missing ? ' · нет на роутере' : ''}
                    {!connection.enabled ? ' · выключено' : ''}
                  </span>
                </span>
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
              </div>
            ))}
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

      {sheet ? (
        <div className="m-overlay" role="dialog" aria-modal="true" onClick={() => setSheet(false)}>
          <div className="m-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="m-sheet-grip" />
            <h2 className="m-sheet-title">Выберите роутер</h2>
            {routers.map((router) => (
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
                  {router.product === 'prokop' ? 'Prokop' : 'Forkop'}
                  {router.latency_ms != null ? ` · ${Math.round(router.latency_ms)} мс` : ''}
                </span>
              </button>
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
