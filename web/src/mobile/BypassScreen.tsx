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

const ACTION_LABEL: Record<string, string> = {
  connection: 'через VPN',
  bypass: 'напрямую',
  block: 'блокировка',
  dns: 'только DNS',
};

const ACTION_HINT: Record<string, string> = {
  connection: 'пойдут через VPN-подключение',
  bypass: 'будут открываться напрямую, минуя VPN',
  block: 'будут заблокированы',
  dns: 'будут использоваться только для DNS',
};

// Мобильный редактор поддерживает только действия, которые принимает API.
const EDITABLE_ACTIONS = new Set(Object.keys(ACTION_LABEL));
const SECTION_KEY_PREFIX = 'rc.mobile.section.';

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

  const [sectionName, setSectionName] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('domain');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [readJob, setReadJob] = useState<Job | null>(null);
  const readOnce = useRef<string | null>(null);

  const sections = useMemo(
    () => (rules.data?.rules ?? []).filter((rule) => EDITABLE_ACTIONS.has(rule.action)),
    [rules.data],
  );

  const selectedRule: RuleView | null = useMemo(() => {
    const stored = sectionName ? sections.find((rule) => rule.section === sectionName) : null;
    return stored ?? sections.find((rule) => rule.action === 'bypass') ?? sections[0] ?? null;
  }, [sections, sectionName]);

  const sectionStorageKey = selected ? `${SECTION_KEY_PREFIX}${selected.id}` : null;

  const entries = useMemo(() => {
    if (!selectedRule) return [];
    return [
      ...selectedRule.manual_domains.map((item) => ({ value: item, kind: entryKind(item) })),
      ...selectedRule.manual_ips.map((item) => ({ value: item, kind: entryKind(item) })),
    ];
  }, [selectedRule]);

  useEffect(() => {
    if (!sectionStorageKey) {
      setSectionName(null);
      return;
    }
    setSectionName(window.localStorage.getItem(sectionStorageKey));
  }, [sectionStorageKey]);

  useEffect(() => {
    if (!selectedRule) return;
    if (sectionName === selectedRule.section) return;
    setSectionName(selectedRule.section);
  }, [sectionName, selectedRule]);

  /** Свежее чтение правил с роутера. Возвращает актуальный список секций. */
  const readLiveRules = useCallback(async (): Promise<RuleView[] | null> => {
    if (!selected || selected.status !== 'online') return null;
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${selected.id}/rules/read`, {
        method: 'POST',
      });
      setReadJob(started.job);
      const done = await waitForJob(started.job, setReadJob);
      if (done.status !== 'success') return null;
      const fresh = await rules.reload();
      return fresh?.rules ?? null;
    } catch {
      return null;
    } finally {
      setReadJob(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status]);

  const refreshFromRouter = useCallback(async (): Promise<void> => {
    if (!selected) return;
    if (selected.status !== 'online') {
      await rules.reload();
      return;
    }
    const fresh = await readLiveRules();
    if (!fresh) await rules.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status, readLiveRules]);

  useEffect(() => {
    if (!selected) return;
    if (readOnce.current === selected.id && selected.status === 'online') return;
    readOnce.current = selected.id;
    void refreshFromRouter();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.status]);

  async function applyEntries(
    target: RuleView,
    nextDomains: string[],
    nextIps: string[],
  ): Promise<void> {
    if (!selected) return;
    await applyRuleBody(
      selected.id,
      {
        section: target.section,
        label: target.label,
        action: target.action,
        enabled: target.enabled,
        create: false,
        resources: target.resources,
        settings: {},
        manual_domains: nextDomains,
        manual_ips: nextIps,
      },
      setJob,
    );
  }

  async function add(): Promise<void> {
    if (!selected || !selectedRule) {
      toast.error('Сначала выберите существующую секцию');
      return;
    }

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

    setBusy(true);
    try {
      // Перед изменением читаем роутер, чтобы не затереть чужие правки
      // и не создать секцию, которая уже существует.
      const fresh = await readLiveRules();
      const target = fresh?.find((rule) => rule.section === selectedRule.section);
      if (!fresh || !target) {
        toast.error('Не удалось прочитать актуальные правила. Попробуйте ещё раз.');
        return;
      }

      const domains = [...target.manual_domains];
      const ips = [...target.manual_ips];
      if (entryKind(normalized) === 'domain') {
        if (domains.includes(normalized)) {
          toast.info('Такой домен уже есть в этой секции');
          return;
        }
        domains.push(normalized);
      } else {
        if (ips.includes(normalized)) {
          toast.info('Такой адрес уже есть в этой секции');
          return;
        }
        ips.push(normalized);
      }

      await applyEntries(target, domains, ips);
      await refreshFromRouter();
      setValue('');
      toast.success(`Адрес добавлен в «${target.label}»`);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
      setJob(null);
    }
  }

  async function remove(entry: { value: string; kind: Kind }): Promise<void> {
    if (!selected || !selectedRule) return;
    if (!window.confirm(`Убрать «${entry.value}» из секции «${selectedRule.label}»?`)) return;

    setBusy(true);
    try {
      const fresh = await readLiveRules();
      const target = fresh?.find((rule) => rule.section === selectedRule.section);
      if (!fresh || !target) {
        toast.error('Не удалось прочитать актуальные правила. Попробуйте ещё раз.');
        return;
      }
      const domains = target.manual_domains.filter((item) => item !== entry.value);
      const ips = target.manual_ips.filter((item) => item !== entry.value);
      await applyEntries(target, domains, ips);
      await refreshFromRouter();
      toast.success(`Адрес убран из «${target.label}»`);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
      setJob(null);
    }
  }

  function chooseSection(name: string): void {
    setSectionName(name);
    if (sectionStorageKey) window.localStorage.setItem(sectionStorageKey, name);
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
  const loadingRules = rules.loading && !rules.data;
  const actionHint = selectedRule ? ACTION_HINT[selectedRule.action] : null;
  const addDisabled =
    busy || offline || loadingRules || readJob !== null || !selectedRule || value.trim() === '';

  return (
    <div className="m-screen">
      <MobileHeader title="Обход VPN" back="/app" />

      <div className="m-body">
        <p className="m-lead">
          {actionHint
            ? `Эти адреса ${actionHint}. Изменения применяются на роутере «${selected.name}» без перезагрузки VPN.`
            : `Выберите существующую секцию на роутере «${selected.name}».`}
        </p>

        {sections.length > 0 ? (
          <div className="m-card m-addbox">
            <label className="m-inputlabel" htmlFor="bypass-section">
              Секция
            </label>
            <select
              id="bypass-section"
              className="m-input"
              value={selectedRule?.section ?? ''}
              onChange={(event) => chooseSection(event.target.value)}
              disabled={busy || offline || readJob !== null}
            >
              {sections.map((rule) => (
                <option key={rule.section} value={rule.section}>
                  {rule.label} ({rule.section}) — {ACTION_LABEL[rule.action] ?? rule.action}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {sections.length > 0 && selectedRule ? (
          <>
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
                disabled={addDisabled}
              >
                {busy ? 'Применяем…' : 'Добавить'}
              </button>
              {offline ? (
                <p className="m-note m-note-warn">
                  Роутер не в сети — изменения применить нельзя.
                </p>
              ) : null}
            </div>
          </>
        ) : null}

        {!loadingRules && sections.length === 0 ? (
          <div className="m-card m-empty">
            <p>
              На роутере нет секций, которые можно редактировать. Создайте секцию в полной
              панели RoutX, затем обновите список.
            </p>
            <button
              type="button"
              className="m-link"
              onClick={() => void refreshFromRouter()}
              disabled={readJob !== null || offline}
            >
              Обновить
            </button>
          </div>
        ) : null}

        <JobProgress job={job} label="Применяем на роутере" />
        {readJob ? <JobProgress job={readJob} label="Читаем правила" /> : null}
        {loadingRules ? <p className="m-note">Читаем правила с роутера…</p> : null}

        <div className="m-card m-list">
          <div className="m-list-head">
            <span className="m-label">В списке · {entries.length}</span>
            <button
              type="button"
              className="m-mini"
              onClick={() => void refreshFromRouter()}
              disabled={rules.loading || readJob !== null || offline}
            >
              Обновить
            </button>
          </div>

          {entries.length === 0 ? (
            <p className="m-empty-text">
              Список секции пуст. Добавьте домен или адрес — он появится в выбранной секции.
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
          {selectedRule
            ? `Секция «${selectedRule.label}» (${selectedRule.section}), действие: ${
                ACTION_LABEL[selectedRule.action] ?? selectedRule.action
              }.`
            : 'Секция не выбрана.'}
        </p>
      </div>
    </div>
  );
}
