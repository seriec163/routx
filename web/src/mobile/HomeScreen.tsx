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

const STATUS: Record<string, { label: string; tone: string }> = {
  online: { label: 'РџРѕРґРєР»СЋС‡РµРЅРѕ', tone: 'ok' },
  offline: { label: 'РќРµС‚ СЃРІСЏР·Рё', tone: 'bad' },
  pending: { label: 'РћР¶РёРґР°РµС‚ РїСЂРёРІСЏР·РєРё', tone: 'warn' },
  unsupported: { label: 'РќРµ РїРѕРґРґРµСЂР¶РёРІР°РµС‚СЃСЏ', tone: 'warn' },
  conflict: { label: 'РљРѕРЅС„Р»РёРєС‚ РїСЂРѕРґСѓРєС‚РѕРІ', tone: 'bad' },
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
        // РљСЌС€ СѓР¶Рµ РїРѕРєР°Р·Р°РЅ; РѕС€РёР±РєР° live-С‡С‚РµРЅРёСЏ РЅРµ Р±Р»РѕРєРёСЂСѓРµС‚ СЌРєСЂР°РЅ.
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
      if (rule.subscriptions.length > 0) chips.add('РџРѕРґРїРёСЃРєР°');
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

  const selectGroups = useMemo(() => {
    const map = new Map<
      string,
      { section: string; sectionLabel: string; items: ConnectionEntry[] }
    >();
    for (const connection of connections) {
      if (!connection.selectable || !connection.proxy_tag) continue;
      const group = map.get(connection.section) ?? {
        section: connection.section,
        sectionLabel: connection.sectionLabel,
        items: [],
      };
      group.items.push(connection);
      map.set(connection.section, group);
    }
    return [...map.values()];
  }, [connections]);

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
        throw new Error(done.error?.message ?? 'РќРµ СѓРґР°Р»РѕСЃСЊ РїРµСЂРµРєР»СЋС‡РёС‚СЊ РїРѕРґРєР»СЋС‡РµРЅРёРµ');
      }
      await reload();
      toast.success('РђРєС‚РёРІРЅРѕРµ РїРѕРґРєР»СЋС‡РµРЅРёРµ РїРµСЂРµРєР»СЋС‡РµРЅРѕ');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setAction('idle');
      setJob(null);
    }
  }

  function openSubscription(section?: string): void {
    const first = section ?? rules.data?.rules[0]?.section ?? 'main';
    setSubscriptionSection(first);
    setSubscriptionUrl('');
    setSubscriptionMode('replace');
    setSubscriptionError(null);
    setSubscriptionJob(null);
    setSubscriptionOpen(true);
  }

  async function saveSubscription(): Promise<void> {
    if (!selected || subscriptionUrl.trim() === '') return;
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
            url: subscriptionUrl.trim(),
          },
        },
      );
      setSubscriptionJob(started.job);
      const done = await waitForJob(started.job, undefined, 600_000);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'РќРµ СѓРґР°Р»РѕСЃСЊ РїСЂРёРјРµРЅРёС‚СЊ РїРѕРґРїРёСЃРєСѓ');
      }
      toast.success('РџРѕРґРїРёСЃРєР° СЂР°Р·РѕР±СЂР°РЅР° РЅР° РїРѕРґРєР»СЋС‡РµРЅРёСЏ');
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
        throw new Error(done.error?.message ?? 'РќРµ СѓРґР°Р»РѕСЃСЊ СЃРѕС…СЂР°РЅРёС‚СЊ outbound JSON');
      }
      toast.success('Outbound JSON СЃРѕС…СЂР°РЅС‘РЅ');
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
        throw new Error(done.error?.message ?? 'РџСЂРѕРІРµСЂРєР° РЅРµ СѓРґР°Р»Р°СЃСЊ');
      }
      await reload();
      toast.success('Р—Р°РґРµСЂР¶РєР° РѕР±РЅРѕРІР»РµРЅР°');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setAction('idle');
      setJob(null);
    }
  }

  async function restartVpn(): Promise<void> {
    if (!selected || action !== 'idle') return;
    if (!window.confirm(`РџРµСЂРµР·Р°РїСѓСЃС‚РёС‚СЊ VPN РЅР° СЂРѕСѓС‚РµСЂРµ В«${selected.name}В»?`)) return;
    setAction('vpn');
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${selected.id}/service`, {
        method: 'POST',
        body: { action: 'restart' },
      });
      setJob(started.job);
      const done = await waitForJob(started.job, setJob);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'РЎР»СѓР¶Р±Р° РЅРµ РїРµСЂРµР·Р°РїСѓСЃС‚РёР»Р°СЃСЊ');
      }
      await reload();
      toast.success('VPN РїРµСЂРµР·Р°РїСѓС‰РµРЅ');
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
      `РџРµСЂРµР·Р°РіСЂСѓР·РёС‚СЊ СЂРѕСѓС‚РµСЂ В«${selected.name}В»?\n\nРЎРІСЏР·СЊ РїСЂРѕРїР°РґС‘С‚ РїСЂРёРјРµСЂРЅРѕ РЅР° РјРёРЅСѓС‚Сѓ. VPN, РїСЂР°РІРёР»Р° Рё РїРѕРґРєР»СЋС‡РµРЅРёСЏ СЃРѕС…СЂР°РЅСЏС‚СЃСЏ.`,
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
        throw new Error(done.error?.message ?? 'Р РѕСѓС‚РµСЂ РЅРµ РїСЂРёРЅСЏР» РєРѕРјР°РЅРґСѓ');
      }
      toast.info('Р РѕСѓС‚РµСЂ РїРµСЂРµР·Р°РіСЂСѓР¶Р°РµС‚СЃСЏ. Р­С‚Рѕ Р·Р°Р№РјС‘С‚ РѕРєРѕР»Рѕ РјРёРЅСѓС‚С‹.');
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
          ? 'Р’СЃС‚Р°РІСЊС‚Рµ РЅРѕРІСѓСЋ СЃСЃС‹Р»РєСѓ РїРѕРґРїРёСЃРєРё https://вЂ¦'
          : 'Р’СЃС‚Р°РІСЊС‚Рµ РЅРѕРІСѓСЋ СЃСЃС‹Р»РєСѓ РїРѕРґРєР»СЋС‡РµРЅРёСЏ',
      );
      return;
    }
    if (replaceTarget.kind === 'subscription' && !/^https?:\/\//i.test(value)) {
      setReplaceError('РЎСЃС‹Р»РєР° РїРѕРґРїРёСЃРєРё РґРѕР»Р¶РЅР° РЅР°С‡РёРЅР°С‚СЊСЃСЏ СЃ http:// РёР»Рё https://');
      return;
    }
    if (!replaceTarget.id && !replaceTarget.name && !replaceTarget.hash) {
      setReplaceError('РќРµ СѓРґР°Р»РѕСЃСЊ РѕРїСЂРµРґРµР»РёС‚СЊ РїРѕРґРєР»СЋС‡РµРЅРёРµ РЅР° СЂРѕСѓС‚РµСЂРµ. РћР±РЅРѕРІРёС‚Рµ СЃРїРёСЃРѕРє.');
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
        throw new Error(done.error?.message ?? 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РјРµРЅРёС‚СЊ РїРѕРґРєР»СЋС‡РµРЅРёРµ');
      }
      await rules.reload();
      toast.success('РџРѕРґРєР»СЋС‡РµРЅРёРµ Р·Р°РјРµРЅРµРЅРѕ');
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
    // Р—Р°РїСЂР°С€РёРІР°РµРј РєР°РјРµСЂСѓ РїСЂСЏРјРѕ РёР· Р¶РµСЃС‚Р°, С‡С‚РѕР±С‹ РЅРµ С‚СЂРµР±РѕРІР°Р»РѕСЃСЊ РІС‚РѕСЂРѕРµ РЅР°Р¶Р°С‚РёРµ.
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
            aria-label="РЎРєР°РЅРёСЂРѕРІР°С‚СЊ QR"
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
              <strong>РЈСЃС‚Р°РЅРѕРІРёС‚СЊ RoutX</strong>
              <span>РРєРѕРЅРєР° РЅР° РґРѕРјР°С€РЅРµРј СЌРєСЂР°РЅРµ, Р±РµР· Р°РґСЂРµСЃРЅРѕР№ СЃС‚СЂРѕРєРё</span>
            </div>
            <button type="button" className="m-mini" onClick={() => setGuideOpen(true)}>
              РРЅСЃС‚СЂСѓРєС†РёСЏ
            </button>
            <button
              type="button"
              className="m-installbar-close"
              aria-label="РЎРєСЂС‹С‚СЊ"
              onClick={() => setInstallBannerHidden(true)}
            >
              Г—
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className="m-routerchip"
          onClick={() => setSheet(true)}
          aria-haspopup="listbox"
        >
          <span>{selected?.name ?? (loading ? 'Р—Р°РіСЂСѓР·РєР°вЂ¦' : 'РќРµС‚ СЂРѕСѓС‚РµСЂРѕРІ')}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 10 5 5 5-5" />
          </svg>
        </button>

        <section className="m-card m-hero">
          <span className={`m-status m-status-${status?.tone ?? 'warn'}`}>
            <span className="m-dot" />
            {status?.label ?? 'РќРµС‚ РґР°РЅРЅС‹С…'}
          </span>
          <div className="m-clock">{time}</div>
          <div className="m-date">{date}</div>
          {selected ? (
            <button type="button" className="m-link" onClick={() => navigate('/app/routers')}>
              {PRODUCT_LABEL[selected.product] ?? selected.product}
              {selected.product_version ? ` ${selected.product_version}` : ''}
              {selected.sing_box_version ? ` В· sing-box ${selected.sing_box_version}` : ''}
            </button>
          ) : (
            <button type="button" className="m-link" onClick={() => navigate('/app/routers')}>
              Р”РѕР±Р°РІСЊС‚Рµ СЂРѕСѓС‚РµСЂ, С‡С‚РѕР±С‹ РЅР°С‡Р°С‚СЊ
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
              <span className="m-label">РџРѕРґРєР»СЋС‡РµРЅРёСЏ В· {connections.length}</span>
              <div className="m-list-actions">
                <button
                  type="button"
                  className="m-mini"
                  onClick={() => void rules.reload()}
                  disabled={rules.loading}
                >
                  РћР±РЅРѕРІРёС‚СЊ
                </button>
                {selected?.product === 'podkop' ? (
                  <button type="button" className="m-mini" onClick={() => openSubscription()}>
                    РџРѕРґРїРёСЃРєР°
                  </button>
                ) : null}
              </div>
            </div>
            {selectGroups.map((group) => {
              const active = group.items.find((item) => item.active);
              return (
                <div className="m-select-row" key={group.section}>
                  <span className="m-label">РђРєС‚РёРІРЅРѕРµ В· {group.sectionLabel}</span>
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
                          ? ` В· ${Math.round(connection.delay_ms)} РјСЃ`
                          : ''}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
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
                    {connection.synthetic
                      ? 'JSON outbound'
                      : connection.kind === 'subscription'
                        ? 'РџРѕРґРїРёСЃРєР°'
                        : 'VLESS'}{' '}
                    В· {connection.sectionLabel} В·{' '}
                    {connection.synthetic ? connection.host : connection.masked}
                    {connection.missing ? ' В· РЅРµС‚ РЅР° СЂРѕСѓС‚РµСЂРµ' : ''}
                    {!connection.enabled ? ' В· РІС‹РєР»СЋС‡РµРЅРѕ' : ''}
                    {connection.kind === 'link' && connection.active ? ' В· Р°РєС‚РёРІРЅРѕ' : ''}
                    {connection.kind === 'link' && connection.delay_ms != null
                      ? ` В· ${Math.round(connection.delay_ms)} РјСЃ`
                      : connection.kind === 'link' && connection.alive === false
                        ? ' В· РЅРµ РѕС‚РІРµС‡Р°РµС‚'
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
                    {action === 'select' ? 'РџРµСЂРµРєР»СЋС‡Р°РµРјвЂ¦' : 'Р’С‹Р±СЂР°С‚СЊ'}
                  </button>
                ) : null}
                {connection.synthetic ? (
                  <button
                    type="button"
                    className="m-mini"
                    onClick={() => openOutbound(connection)}
                    disabled={!selected || selected.status !== 'online'}
                  >
                    РР·РјРµРЅРёС‚СЊ JSON
                  </button>
                ) : selected?.product === 'podkop' && connection.kind === 'subscription' ? (
                  <button
                    type="button"
                    className="m-mini"
                    onClick={() => openSubscription(connection.section)}
                    disabled={!selected || selected.status !== 'online'}
                  >
                    РР·РјРµРЅРёС‚СЊ РїРѕРґРїРёСЃРєСѓ
                  </button>
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
                    Р—Р°РјРµРЅРёС‚СЊ
                  </button>
                )}
              </div>
            ))}
          </section>
        ) : null}

        <section className="m-card m-latency">
          <div>
            <div className="m-label">Р—Р°РґРµСЂР¶РєР° В· Р°РєС‚РёРІРЅС‹Р№ СЃРµСЂРІРµСЂ</div>
            <div className="m-latency-value">
              {latency != null ? Math.round(latency) : 'вЂ”'} <small>РјСЃ</small>
            </div>
          </div>
          <button
            type="button"
            className="m-ghost m-ghost-sm"
            onClick={() => void testPing()}
            disabled={!selected || action !== 'idle'}
          >
            {action === 'ping' ? 'РџСЂРѕРІРµСЂСЏРµРјвЂ¦' : 'РўРµСЃС‚ РїРёРЅРіР°'}
          </button>
        </section>

        <section className="m-card m-ipcard">
          <div className="m-iprow">
            <span className="m-label">IP Р±РµР· VPN</span>
            <code className="m-ip">{selected?.direct_ip ?? 'вЂ”'}</code>
          </div>
          <div className="m-iprow">
            <span className="m-label">IP С‡РµСЂРµР· VPN</span>
            <code className="m-ip">{selected?.vpn_ip ?? 'вЂ”'}</code>
          </div>
          <p className="m-footnote">
            Р‘РµР· VPN вЂ” РїСЂСЏРјРѕР№ РІС‹С…РѕРґ СЂРѕСѓС‚РµСЂР°, С‡РµСЂРµР· VPN вЂ” РІС‹С…РѕРґ Р°РєС‚РёРІРЅРѕРіРѕ СЃРµСЂРІРµСЂР°.
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
            <span className="m-label">РџСЂРёР»РѕР¶РµРЅРёРµ RoutX</span>
            <strong>РћР±РЅРѕРІРёС‚СЊ Р±РµР· РїРµСЂРµСѓСЃС‚Р°РЅРѕРІРєРё</strong>
            <p className="m-note">
              Р—Р°РіСЂСѓР·РёС‚ СЃРІРµР¶СѓСЋ РІРµСЂСЃРёСЋ Рё РїРµСЂРµР·Р°РїСѓСЃС‚РёС‚ РїСЂРёР»РѕР¶РµРЅРёРµ. Р’С…РѕРґ, РЅР°СЃС‚СЂРѕР№РєРё Рё РїСЂРёРІСЏР·РєР°
              СЃРѕС…СЂР°РЅСЏС‚СЃСЏ вЂ” QR СЃРєР°РЅРёСЂРѕРІР°С‚СЊ Р·Р°РЅРѕРІРѕ РЅРµ РЅСѓР¶РЅРѕ.
            </p>
            <span className="m-build">
              РЎР±РѕСЂРєР°{' '}
              {new Date(__BUILD_TIME__).toLocaleString('ru-RU', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
              {' В· '}
              {standalone ? 'PWA' : 'Р±СЂР°СѓР·РµСЂ'}
              {' В· '}
              {window.innerHeight} px
            </span>
          </div>
          <button
            type="button"
            className="m-mini"
            onClick={() => void refreshPwa()}
            disabled={pwaBusy}
          >
            {pwaBusy ? 'РћР±РЅРѕРІР»СЏРµРјвЂ¦' : 'РћР±РЅРѕРІРёС‚СЊ'}
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
          Р”РѕР±Р°РІРёС‚СЊ Р°РґСЂРµСЃ РґР»СЏ РѕР±С…РѕРґР°
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
            <span>{action === 'vpn' ? 'РџРµСЂРµР·Р°РїСѓСЃРєвЂ¦' : 'РџРµСЂРµР·Р°РіСЂСѓР·РёС‚СЊ VPN'}</span>
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
            <span>{action === 'reboot' ? 'РџРµСЂРµР·Р°РіСЂСѓР·РєР°вЂ¦' : 'РџРµСЂРµР·Р°РіСЂСѓР·РёС‚СЊ СЂРѕСѓС‚РµСЂ'}</span>
          </button>
        </div>

        <JobProgress job={job} label="Р’С‹РїРѕР»РЅСЏРµРј РЅР° СЂРѕСѓС‚РµСЂРµ" />

        {routers.length === 0 && !loading ? (
          <div className="m-card m-empty">
            <p>Р РѕСѓС‚РµСЂРѕРІ РїРѕРєР° РЅРµС‚.</p>
            <button type="button" className="m-link" onClick={() => navigate('/app/routers')}>
              Р”РѕР±Р°РІРёС‚СЊ СЂРѕСѓС‚РµСЂ
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
            <h2 className="m-sheet-title">Р—Р°РјРµРЅРёС‚СЊ РїРѕРґРєР»СЋС‡РµРЅРёРµ</h2>
            <p className="m-note">
              РЎРµРєС†РёСЏ В«{replaceTarget.sectionLabel}В». РЎРµР№С‡Р°СЃ РёСЃРїРѕР»СЊР·СѓРµС‚СЃСЏ:{' '}
              <strong>{replaceTarget.label}</strong> В· {replaceTarget.masked}
            </p>
            {replaceError ? <p className="m-note m-note-warn">{replaceError}</p> : null}
            <label className="m-inputlabel" htmlFor="replace-value">
              {replaceTarget.kind === 'subscription' ? 'РќРѕРІР°СЏ СЃСЃС‹Р»РєР° РїРѕРґРїРёСЃРєРё' : 'РќРѕРІР°СЏ СЃСЃС‹Р»РєР° VLESS'}
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
                  : 'vless://вЂ¦'
              }
              spellCheck={false}
              disabled={replaceBusy}
            />
            <p className="m-note">
              РќРѕРІР°СЏ СЃСЃС‹Р»РєР° Р·Р°РјРµРЅРёС‚ С‚РµРєСѓС‰СѓСЋ РІ СЃРµРєС†РёРё В«{replaceTarget.sectionLabel}В». РЎС‚Р°СЂС‹Р№ СЃРµСЂРІРµСЂ
              РїРµСЂРµСЃС‚Р°РЅРµС‚ РёСЃРїРѕР»СЊР·РѕРІР°С‚СЊСЃСЏ.
            </p>
            <JobProgress job={replaceJob} label="Р—Р°РјРµРЅСЏРµРј РЅР° СЂРѕСѓС‚РµСЂРµ" />
            <button
              type="button"
              className="m-action m-action-sm"
              onClick={() => void replaceConnection()}
              disabled={replaceBusy || replaceValue.trim() === ''}
            >
              {replaceBusy ? 'Р—Р°РјРµРЅСЏРµРјвЂ¦' : 'Р—Р°РјРµРЅРёС‚СЊ'}
            </button>
            <button
              type="button"
              className="m-link m-link-center"
              onClick={() => setReplaceTarget(null)}
              disabled={replaceBusy}
            >
              РћС‚РјРµРЅР°
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
            <h2 className="m-sheet-title">РџРѕРґРїРёСЃРєР° Podkop</h2>
            <p className="m-note">
              RoutX СЃРєР°С‡Р°РµС‚ РїРѕРґРїРёСЃРєСѓ Рё СЃРѕС…СЂР°РЅРёС‚ СЃСЃС‹Р»РєРё РєР°Рє РѕС‚РґРµР»СЊРЅС‹Рµ РїРѕРґРєР»СЋС‡РµРЅРёСЏ. URL РїРѕРґРїРёСЃРєРё
              РЅР° СЂРѕСѓС‚РµСЂ РЅРµ РїРµСЂРµРґР°С‘С‚СЃСЏ.
            </p>
            <label className="m-inputlabel" htmlFor="sub-section">
              РЎРµРєС†РёСЏ
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
              Р РµР¶РёРј
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
              <option value="add">Р”РѕР±Р°РІРёС‚СЊ Рє С‚РµРєСѓС‰РёРј</option>
              <option value="replace">Р—Р°РјРµРЅРёС‚СЊ РІСЃРµ РїРѕРґРєР»СЋС‡РµРЅРёСЏ</option>
            </select>
            <label className="m-inputlabel" htmlFor="sub-url">
              URL РїРѕРґРїРёСЃРєРё
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
                РўРµРєСѓС‰РёРµ СЃСЃС‹Р»РєРё РІС‹Р±СЂР°РЅРЅРѕР№ СЃРµРєС†РёРё Р±СѓРґСѓС‚ Р·Р°РјРµРЅРµРЅС‹ СЃСЃС‹Р»РєР°РјРё РёР· РїРѕРґРїРёСЃРєРё.
              </p>
            ) : null}
            {subscriptionError ? (
              <p className="m-note m-note-warn">{subscriptionError}</p>
            ) : null}
            <JobProgress job={subscriptionJob} label="Р Р°Р·Р±РёСЂР°РµРј РїРѕРґРїРёСЃРєСѓ" />
            <button
              type="button"
              className="m-action m-action-sm"
              onClick={() => void saveSubscription()}
              disabled={subscriptionBusy || subscriptionUrl.trim() === ''}
            >
              {subscriptionBusy ? 'РџСЂРёРјРµРЅСЏРµРјвЂ¦' : 'РџСЂРёРјРµРЅРёС‚СЊ РїРѕРґРїРёСЃРєСѓ'}
            </button>
            <button
              type="button"
              className="m-link m-link-center"
              onClick={() => setSubscriptionOpen(false)}
              disabled={subscriptionBusy}
            >
              РћС‚РјРµРЅР°
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
              РЎРµРєС†РёСЏ В«{outboundTarget.sectionLabel}В». РўРµРєСѓС‰РёР№ JSON СЃРєСЂС‹С‚; РІСЃС‚Р°РІСЊС‚Рµ РѕР±СЉРµРєС‚
              С†РµР»РёРєРѕРј. РџСЂРё РѕС€РёР±РєРµ Podkop РѕС‚РєР°С‚РёС‚ РєРѕРЅС„РёРіСѓСЂР°С†РёСЋ.
            </p>
            <textarea
              className="m-input m-textarea"
              rows={10}
              value={outboundValue}
              onChange={(event) => setOutboundValue(event.target.value)}
              placeholder={'{"type":"vless","server":"example.com",вЂ¦}'}
              spellCheck={false}
              disabled={outboundBusy}
            />
            {outboundError ? <p className="m-note m-note-warn">{outboundError}</p> : null}
            <JobProgress job={outboundJob} label="РџСЂРѕРІРµСЂСЏРµРј Рё РїСЂРёРјРµРЅСЏРµРј" />
            <button
              type="button"
              className="m-action m-action-sm"
              onClick={() => void saveOutbound()}
              disabled={outboundBusy || outboundValue.trim() === ''}
            >
              {outboundBusy ? 'РџСЂРёРјРµРЅСЏРµРјвЂ¦' : 'РЎРѕС…СЂР°РЅРёС‚СЊ JSON'}
            </button>
            <button
              type="button"
              className="m-link m-link-center"
              onClick={() => setOutboundTarget(null)}
              disabled={outboundBusy}
            >
              РћС‚РјРµРЅР°
            </button>
          </div>
        </div>
      ) : null}

      {sheet ? (
        <div className="m-overlay" role="dialog" aria-modal="true" onClick={() => setSheet(false)}>
          <div className="m-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="m-sheet-grip" />
            <h2 className="m-sheet-title">Р’С‹Р±РµСЂРёС‚Рµ СЂРѕСѓС‚РµСЂ</h2>
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
                  {PRODUCT_LABEL[router.product] ?? router.product}
                  {router.latency_ms != null ? ` В· ${Math.round(router.latency_ms)} РјСЃ` : ''}
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
              + Р”РѕР±Р°РІРёС‚СЊ СЂРѕСѓС‚РµСЂ
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
