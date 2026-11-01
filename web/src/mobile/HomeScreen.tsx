import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { waitForJob } from '../lib/jobs';
import type { Job, MonitoringItem, RulesResponse } from '../lib/types';
import { useApi } from '../lib/useApi';
import { JobProgress, useToast } from '../components/ui';
import { navigate } from '../lib/router';
import { MobileHeader, useMobile } from './MobileApp';

const STATUS: Record<string, { label: string; tone: string }> = {
  online: { label: 'Подключено', tone: 'ok' },
  offline: { label: 'Нет связи', tone: 'bad' },
  pending: { label: 'Ожидает привязки', tone: 'warn' },
  unsupported: { label: 'Не поддерживается', tone: 'warn' },
  conflict: { label: 'Конфликт продуктов', tone: 'bad' },
};

export function HomeScreen() {
  const { routers, selected, selectedId, select, reload, loading } = useMobile();
  const toast = useToast();
  const [now, setNow] = useState(() => new Date());
  const [sheet, setSheet] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [action, setAction] = useState<'idle' | 'ping' | 'vpn' | 'reboot'>('idle');

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

  return (
    <div className="m-screen">
      <MobileHeader
        right={
          <button
            type="button"
            className="m-iconbtn"
            aria-label="Добавить роутер"
            onClick={() => navigate('/app/routers')}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="4" y="4" width="6" height="6" rx="1.5" />
              <rect x="14" y="4" width="6" height="6" rx="1.5" />
              <rect x="4" y="14" width="6" height="6" rx="1.5" />
              <path d="M14 17h6M17 14v6" />
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

        <section className="m-card m-latency">
          <div>
            <div className="m-label">Задержка</div>
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
