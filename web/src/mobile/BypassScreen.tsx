import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { applyRuleBody, waitForJob } from '../lib/jobs';
import type { Job, RuleView, RulesResponse } from '../lib/types';
import { useApi } from '../lib/useApi';
import { JobProgress, useToast } from '../components/ui';
import { MobileHeader, useMobile } from './MobileApp';

type Kind = 'domain' | 'ip' | 'subnet';

const KIND_LABEL: Record<Kind, string> = {
  domain: 'Домен',
  ip: 'IP',
  subnet: 'Подсеть',
};

const DOMAIN_RE = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function isIpv4(value: string): boolean {
  return IPV4_RE.test(value) && value.split('.').every((part) => Number(part) <= 255);
}

function isIpv6(value: string): boolean {
  return value.includes(':') && /^[0-9a-f:]+$/i.test(value);
}

/** Приводим ввод к каноническому виду: ссылка → домен, IP → проверка. */
function normalize(input: string, kind: Kind): string | null {
  let value = input.trim();
  if (value === '') return null;

  if (kind === 'domain') {
    if (/^https?:\/\//i.test(value)) {
      try {
        value = new URL(value).hostname;
      } catch {
        return null;
      }
    }
    value = value.replace(/^\./, '').replace(/\.$/, '').toLowerCase();
    return DOMAIN_RE.test(value) ? value : null;
  }

  if (kind === 'ip') {
    return isIpv4(value) || isIpv6(value) ? value : null;
  }

  // Подсеть: адрес/префикс.
  const [address, prefix, ...rest] = value.split('/');
  if (rest.length > 0 || !address || !prefix) return null;
  const bits = Number(prefix);
  if (!Number.isInteger(bits)) return null;
  if (isIpv4(address)) return bits >= 0 && bits <= 32 ? `${address}/${bits}` : null;
  if (isIpv6(address)) return bits >= 0 && bits <= 128 ? `${address}/${bits}` : null;
  return null;
}

function entryKind(value: string): Kind {
  if (value.includes('/')) return 'subnet';
  if (isIpv4(value) || isIpv6(value)) return 'ip';
  return 'domain';
}

export function BypassScreen() {
  const { selected } = useMobile();
  const toast = useToast();
  const rules = useApi<RulesResponse>(
    selected ? `/api/v1/routers/${selected.id}/rules` : null,
  );

  const [kind, setKind] = useState<Kind>('domain');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [readJob, setReadJob] = useState<Job | null>(null);
  const readOnce = useRef<string | null>(null);

  const bypassRule: RuleView | null = useMemo(
    () => rules.data?.rules.find((rule) => rule.action === 'bypass') ?? null,
    [rules.data],
  );

  const entries = useMemo(() => {
    if (!bypassRule) return [];
    return [
      ...bypassRule.manual_domains.map((item) => ({ value: item, kind: entryKind(item) })),
      ...bypassRule.manual_ips.map((item) => ({ value: item, kind: entryKind(item) })),
    ];
  }, [bypassRule]);

  // Свежий список с роутера при входе на экран.
  const refreshFromRouter = useCallback(async (): Promise<void> => {
    if (!selected || selected.status !== 'online') {
      await rules.reload();
      return;
    }
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${selected.id}/rules/read`, {
        method: 'POST',
      });
      setReadJob(started.job);
      const done = await waitForJob(started.job, setReadJob);
      if (done.status === 'success') await rules.reload();
    } catch {
      // Кэш правил остаётся доступным — молча продолжаем.
    } finally {
      setReadJob(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status]);

  useEffect(() => {
    if (!selected || selected.status !== 'online') return;
    if (readOnce.current === selected.id) return;
    readOnce.current = selected.id;
    void refreshFromRouter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status]);

  function nextSection(): string {
    const used = new Set((rules.data?.rules ?? []).map((rule) => rule.section));
    if (!used.has('bypass')) return 'bypass';
    for (let index = 2; index < 100; index += 1) {
      if (!used.has(`bypass${index}`)) return `bypass${index}`;
    }
    return `bypass${Date.now() % 1000}`;
  }

  async function save(nextDomains: string[], nextIps: string[]): Promise<void> {
    if (!selected) return;
    setBusy(true);
    try {
      await applyRuleBody(
        selected.id,
        {
          section: bypassRule?.section ?? nextSection(),
          label: bypassRule?.label ?? 'Обход',
          action: 'bypass',
          enabled: bypassRule?.enabled ?? true,
          create: !bypassRule,
          resources: bypassRule?.resources ?? {},
          settings: {},
          manual_domains: nextDomains,
          manual_ips: nextIps,
        },
        setJob,
      );
      // Кэш ручных списков обновляется отдельным чтением с роутера.
      await refreshFromRouter();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
      setJob(null);
    }
  }

  async function add(): Promise<void> {
    const normalized = normalize(value, kind);
    if (!normalized) {
      toast.error(
        kind === 'domain'
          ? 'Проверьте домен: например sberbank.ru или *.example.com'
          : kind === 'ip'
            ? 'Проверьте IP: например 8.8.8.8'
            : 'Проверьте подсеть: например 192.168.50.0/24',
      );
      return;
    }

    const domains = [...(bypassRule?.manual_domains ?? [])];
    const ips = [...(bypassRule?.manual_ips ?? [])];
    if (entryKind(normalized) === 'domain') {
      if (domains.includes(normalized)) {
        toast.info('Такой домен уже есть в списке');
        return;
      }
      domains.push(normalized);
    } else {
      if (ips.includes(normalized)) {
        toast.info('Такой адрес уже есть в списке');
        return;
      }
      ips.push(normalized);
    }

    await save(domains, ips);
    setValue('');
    toast.success('Адрес добавлен в обход');
  }

  async function remove(entry: { value: string; kind: Kind }): Promise<void> {
    if (!bypassRule) return;
    if (!window.confirm(`Убрать «${entry.value}» из обхода?`)) return;
    const domains = bypassRule.manual_domains.filter((item) => item !== entry.value);
    const ips = bypassRule.manual_ips.filter((item) => item !== entry.value);
    await save(domains, ips);
    toast.success('Адрес убран из обхода');
  }

  if (!selected) {
    return (
      <div className="m-screen">
        <MobileHeader title="Обход VPN" back="/app" />
        <div className="m-body">
          <div className="m-card m-empty">
            <p>Сначала выберите роутер.</p>
          </div>
        </div>
      </div>
    );
  }

  const offline = selected.status !== 'online';

  return (
    <div className="m-screen">
      <MobileHeader title="Обход VPN" back="/app" />

      <div className="m-body">
        <p className="m-lead">
          Эти адреса будут открываться напрямую, минуя VPN. Изменения применяются на роутере
          «{selected.name}» без перезагрузки VPN.
        </p>

        <div className="m-tabs" role="tablist">
          {(['domain', 'ip', 'subnet'] as Kind[]).map((item) => (
            <button
              type="button"
              key={item}
              role="tab"
              aria-selected={kind === item}
              className={`m-tab ${kind === item ? 'm-tab-active' : ''}`}
              onClick={() => setKind(item)}
            >
              {KIND_LABEL[item]}
            </button>
          ))}
        </div>

        <div className="m-card m-addbox">
          <label className="m-inputlabel" htmlFor="bypass-value">
            Адрес
          </label>
          <input
            id="bypass-value"
            className="m-input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add();
            }}
            placeholder={
              kind === 'domain'
                ? 'sberbank.ru'
                : kind === 'ip'
                  ? '8.8.8.8'
                  : '192.168.50.0/24'
            }
            autoComplete="off"
            spellCheck={false}
            disabled={busy || offline}
          />
          <button
            type="button"
            className="m-action m-action-sm"
            onClick={() => void add()}
            disabled={busy || offline || value.trim() === ''}
          >
            {busy ? 'Применяем…' : 'Добавить'}
          </button>
          {offline ? (
            <p className="m-note m-note-warn">
              Роутер не в сети — изменения применить нельзя.
            </p>
          ) : null}
        </div>

        <JobProgress job={job} label="Применяем на роутере" />
        {readJob ? <JobProgress job={readJob} label="Читаем правила" /> : null}

        <div className="m-card m-list">
          <div className="m-list-head">
            <span className="m-label">В списке · {entries.length}</span>
            <button
              type="button"
              className="m-mini"
              onClick={() => void refreshFromRouter()}
              disabled={rules.loading || readJob !== null}
            >
              Обновить
            </button>
          </div>

          {entries.length === 0 ? (
            <p className="m-empty-text">
              Список пуст. Добавьте домен или адрес — он сразу начнёт открываться напрямую.
            </p>
          ) : (
            entries.map((entry) => (
              <div className="m-listrow" key={entry.value}>
                <span className="m-listrow-value">{entry.value}</span>
                <span className="m-tag">{KIND_LABEL[entry.kind].toUpperCase()}</span>
                <button
                  type="button"
                  className="m-remove"
                  aria-label={`Убрать ${entry.value}`}
                  onClick={() => void remove(entry)}
                  disabled={busy || offline}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        <p className="m-footnote">
          Правило обхода: {bypassRule ? `«${bypassRule.label}»` : 'будет создано при первом адресе'}.
        </p>
      </div>
    </div>
  );
}
