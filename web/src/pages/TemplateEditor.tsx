import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  InfoBanner,
  Modal,
  PageHeader,
  Panel,
  Select,
  Spinner,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import { navigate } from '../lib/router';
import type {
  RoutingAction,
  RoutingService,
  RouterSectionSummary,
  RouterSectionsResponse,
  TemplateFull,
  TemplatePayload,
  TemplateRevision,
} from '../lib/types';
import { useApi } from '../lib/useApi';

const EMPTY_PAYLOAD: TemplatePayload = {
  settings: {},
  sections: {},
  urltest: {},
  section_interface: {},
  subscription_url: {},
  create_urltest: [],
  create_sections: [],
  manual_entries: {},
};

const SECTION_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function payloadWithDefaults(value: unknown): TemplatePayload {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const merged = { ...EMPTY_PAYLOAD, ...(source as Partial<TemplatePayload>) };

  // Любая секция с действием должна создаваться на роутере, если её там нет.
  // Это делает поведение «если секции нет — создать» одинаковым для всех шаблонов.
  const sections = merged.sections && typeof merged.sections === 'object' ? merged.sections : {};
  const creatable = Object.entries(sections)
    .filter(([, options]) => {
      const action = options?.action;
      return typeof action === 'string' && action.trim() !== '';
    })
    .map(([name]) => name);
  const createSections = Array.isArray(merged.create_sections) ? merged.create_sections : [];

  return {
    ...merged,
    sections,
    create_sections: [...new Set([...createSections, ...creatable])],
    manual_entries:
      merged.manual_entries && typeof merged.manual_entries === 'object' ? merged.manual_entries : {},
  };
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim() !== '') return [value];
  return [];
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export function TemplateEditorPage({ id }: { id: string }) {
  const toast = useToast();
  const template = useApi<{ template: TemplateFull }>(`/api/v1/templates/${id}`);
  const revisions = useApi<{ items: TemplateRevision[] }>(`/api/v1/templates/${id}/revisions`);
  const catalog = useApi<{ services: RoutingService[]; actions: RoutingAction[] }>(
    '/api/v1/settings/routing-catalog',
  );
  const routerSections = useApi<RouterSectionsResponse>('/api/v1/router-sections');

  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [payload, setPayload] = useState<TemplatePayload>(EMPTY_PAYLOAD);
  const [exclusionsText, setExclusionsText] = useState('');
  const [section, setSection] = useState('router_control');
  const [newSection, setNewSection] = useState('');
  const [advancedText, setAdvancedText] = useState('{}');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<{
    paths: Array<{ path: string; value: unknown }>;
    desired_hash: string;
  } | null>(null);
  const [viewRevision, setViewRevision] = useState<TemplateRevision | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeName, setPurgeName] = useState('');
  const [purgeBusy, setPurgeBusy] = useState(false);

  useEffect(() => {
    const data = template.data?.template;
    if (!data || loadedId === data.id) return;
    setLoadedId(data.id);
    setName(data.name);
    setDescription(data.description ?? '');
    const loaded = payloadWithDefaults(data.payload);
    setPayload(loaded);
    setExclusionsText((data.exclusions ?? []).join('\n'));
    const first =
      loaded.create_sections[0] ??
      Object.keys(loaded.sections)[0] ??
      'router_control';
    setSection(first);
    setAdvancedText(JSON.stringify(loaded, null, 2));
  }, [template.data, loadedId]);

  const services = catalog.data?.services ?? [];
  const actions = catalog.data?.actions ?? [];
  const discoveredSections = routerSections.data?.sections ?? [];
  const sectionOptions = useMemo(() => {
    const names = new Set([...Object.keys(payload.sections), ...payload.create_sections]);
    for (const item of routerSections.data?.sections ?? []) names.add(item.name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [payload.sections, payload.create_sections, routerSections.data]);
  const sectionPayload = payload.sections[section] ?? {};
  const sectionInTemplate = Boolean(payload.sections[section]);
  const discoveredCurrent = discoveredSections.find((item) => item.name === section) ?? null;
  const selectedServices = asStringList(sectionPayload.community_lists);
  const manual = payload.manual_entries[section] ?? { domains: [], ips: [] };

  function sectionValue(option: string): string {
    const value = sectionPayload[option];
    if (value == null) return '';
    return Array.isArray(value) ? value.join('\n') : String(value);
  }

  function settingValue(option: string): string {
    const value = payload.settings[option];
    if (value == null) return '';
    return Array.isArray(value) ? value.join('\n') : String(value);
  }

  function updateSetting(option: string, value: string | string[] | null) {
    setPayload((current) => {
      const settings = { ...current.settings };
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
        delete settings[option];
      } else {
        settings[option] = value;
      }
      return { ...current, settings };
    });
    setValidation(null);
  }

  function setSettingList(option: string, text: string) {
    updateSetting(option, lines(text));
  }

  function loadSectionFromRouter(target: RouterSectionSummary | null = discoveredCurrent): void {
    if (!target) return;
    const values = { ...(target.values ?? {}) };
    if (values.action == null) values.action = target.action ?? 'connection';
    if (values.enabled == null) values.enabled = target.enabled ?? '1';
    if (values.label == null) values.label = target.label ?? target.name;
    const name = target.name;
    setPayload((current) => ({
      ...current,
      sections: { ...current.sections, [name]: values },
      create_sections: [...new Set([...current.create_sections, name])],
    }));
    setSection(name);
    setValidation(null);
    toast.info(`Значения секции «${name}» загружены в шаблон`);
  }

  function updateSection(patch: Record<string, string | string[] | null>) {
    setPayload((current) => {
      const existed = Boolean(current.sections[section]);
      const base = current.sections[section] ?? {
        action: 'connection',
        enabled: '1',
        label: section,
      };
      return {
        ...current,
        sections: {
          ...current.sections,
          [section]: { ...base, ...patch },
        },
        create_sections: existed
          ? current.create_sections
          : [...new Set([...current.create_sections, section])],
      };
    });
    setValidation(null);
  }

  function toggleService(serviceId: string, checked: boolean) {
    const next = checked
      ? [...new Set([...selectedServices, serviceId])]
      : selectedServices.filter((item) => item !== serviceId);
    updateSection({ community_lists: next });
  }

  function setListOption(option: string, text: string) {
    const values = lines(text);
    updateSection({ [option]: values.length > 0 ? values : null });
  }

  function setManual(kind: 'domains' | 'ips', text: string) {
    setPayload((current) => {
      const existed = Boolean(current.sections[section]);
      return {
        ...current,
        sections: existed
          ? current.sections
          : {
              ...current.sections,
              [section]: { action: 'connection', enabled: '1', label: section },
            },
        create_sections: existed
          ? current.create_sections
          : [...new Set([...current.create_sections, section])],
        manual_entries: {
          ...current.manual_entries,
          [section]: {
            domains: current.manual_entries[section]?.domains ?? [],
            ips: current.manual_entries[section]?.ips ?? [],
            [kind]: lines(text),
          },
        },
      };
    });
    setValidation(null);
  }

  function ensureSectionExists() {
    setPayload((current) => ({
      ...current,
      sections: {
        ...current.sections,
        [section]: current.sections[section] ?? { action: 'connection', enabled: '1', label: section },
      },
      create_sections: [...new Set([...current.create_sections, section])],
    }));
    setValidation(null);
  }

  function addSection() {
    const value = newSection.trim();
    if (!SECTION_NAME_RE.test(value)) {
      setError('Имя секции: латиница, цифры, точка, дефис или подчёркивание, до 64 символов.');
      return;
    }
    setPayload((current) => ({
      ...current,
      sections: {
        ...current.sections,
        [value]: current.sections[value] ?? {
          action: 'connection',
          enabled: '1',
          label: value,
          community_lists: [],
        },
      },
      create_sections: [...new Set([...current.create_sections, value])],
    }));
    setSection(value);
    setNewSection('');
    setValidation(null);
  }

  function removeSection() {
    setPayload((current) => {
      const sections = { ...current.sections };
      delete sections[section];
      const manualEntries = { ...current.manual_entries };
      delete manualEntries[section];
      return {
        ...current,
        sections,
        manual_entries: manualEntries,
        create_sections: current.create_sections.filter((item) => item !== section),
      };
    });
    setSection('router_control');
    setValidation(null);
  }

  function toggleCreateSection(checked: boolean) {
    setPayload((current) => ({
      ...current,
      create_sections: checked
        ? [...new Set([...current.create_sections, section])]
        : current.create_sections.filter((item) => item !== section),
    }));
    setValidation(null);
  }

  function parse(): { payload: TemplatePayload; exclusions: string[] } {
    return {
      payload,
      exclusions: lines(exclusionsText),
    };
  }

  async function saveMeta(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/templates/${id}`, {
        method: 'PATCH',
        body: { name: name.trim(), description: description.trim() || null },
      });
      toast.success('Название и описание сохранены');
      await template.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function validate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{
        ok: boolean;
        desired_hash: string;
        paths: Array<{ path: string; value: unknown }>;
        exclusions: string[];
      }>('/api/v1/templates/validate', { method: 'POST', body: parse() });
      setValidation({ paths: result.paths, desired_hash: result.desired_hash });
      toast.success(`Проверка пройдена: ${result.paths.length} параметров`);
    } catch (caught) {
      setValidation(null);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveRevision(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ revision: number }>(`/api/v1/templates/${id}/revisions`, {
        method: 'POST',
        body: parse(),
      });
      toast.success(`Создана ревизия ${result.revision}. Назначенные роутеры увидят её после сравнения.`);
      await Promise.all([template.reload(), revisions.reload()]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function loadDraft(revision: TemplateRevision): void {
    const loaded = payloadWithDefaults(revision.payload);
    setPayload(loaded);
    setExclusionsText((revision.exclusions ?? []).join('\n'));
    setSection(loaded.create_sections[0] ?? Object.keys(loaded.sections)[0] ?? 'router_control');
    setAdvancedText(JSON.stringify(loaded, null, 2));
    setValidation(null);
    setViewRevision(null);
    toast.info(`Ревизия ${revision.revision} загружена в редактор. Сохраните как новую ревизию.`);
  }

  function applyAdvanced(): void {
    try {
      const parsed = JSON.parse(advancedText);
      const loaded = payloadWithDefaults(parsed);
      setPayload(loaded);
      setSection(loaded.create_sections[0] ?? Object.keys(loaded.sections)[0] ?? 'router_control');
      setValidation(null);
      toast.success('JSON применён к редактору');
    } catch (caught) {
      setError(`JSON не разобран: ${(caught as Error).message}`);
    }
  }

  async function purgeTemplate(): Promise<void> {
    const currentName = template.data?.template.name ?? '';
    if (purgeName.trim() !== currentName) return;
    setPurgeBusy(true);
    try {
      await api(`/api/v1/templates/${id}?purge=true`, { method: 'DELETE' });
      toast.success('Шаблон удалён навсегда');
      navigate('/templates');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setPurgeBusy(false);
    }
  }

  if (template.loading && !template.data) return <Spinner />;
  if (template.error && !template.data) {
    return <ErrorBanner message={template.error} onRetry={() => void template.reload()} />;
  }
  const data = template.data?.template;
  if (!data) return <Empty>Шаблон не найден.</Empty>;

  return (
    <div className="page">
      <PageHeader
        eyebrow={`Ревизия ${data.current_revision}`}
        title={data.name}
        subtitle={data.description ?? 'Описание не задано'}
        actions={
          <>
            <Button variant="ghost" onClick={() => void saveMeta()} busy={busy} disabled={!name.trim()}>
              Сохранить описание
            </Button>
            <Button variant="ghost" onClick={() => void validate()} busy={busy}>
              Проверить
            </Button>
            <Button onClick={() => void saveRevision()} busy={busy}>
              Сохранить ревизию
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setPurgeName('');
                setPurgeOpen(true);
              }}
            >
              Удалить навсегда
            </Button>
          </>
        }
      />

      {error ? <ErrorBanner message={error} /> : null}
      {validation ? (
        <InfoBanner>
          Проверка пройдена: {validation.paths.length} управляемых путей. Желаемый хеш{' '}
          <code>{validation.desired_hash.slice(0, 16)}…</code>
        </InfoBanner>
      ) : null}

      <div className="grid-2">
        <div className="stack">
          <Panel title="Метаданные">
            <Field label="Название">
              <TextInput value={name} onChange={setName} required />
            </Field>
            <Field label="Описание">
              <TextInput value={description} onChange={setDescription} placeholder="Необязательно" />
            </Field>
          </Panel>

          <Panel
            title="Секция правил"
            subtitle="Секции считываются из состояния роутеров. Любую можно открыть в шаблоне; если на роутере её нет — она будет создана."
          >
            <Field label="Секция">
              <div className="row">
                <Select value={section} onChange={(value) => setSection(value)}>
                  {sectionOptions.length === 0 ? <option value="router_control">router_control</option> : null}
                  {sectionOptions.map((item) => {
                    const found = discoveredSections.some((entry) => entry.name === item);
                    return (
                      <option key={item} value={item}>
                        {item}
                        {found ? ' — на роутере' : payload.sections[item] ? ' — в шаблоне' : ''}
                      </option>
                    );
                  })}
                </Select>
              </div>
            </Field>

            {!sectionInTemplate && discoveredCurrent ? (
              <InfoBanner tone="warn">
                Секция «{section}» есть на роутере ({discoveredCurrent.routers.map((entry) => entry.name).join(', ')}),
                но ещё не в шаблоне. Загрузите её значения как основу.
                <div className="row" style={{ marginTop: 8 }}>
                  <Button size="sm" onClick={() => loadSectionFromRouter()}>
                    Загрузить с роутера
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => ensureSectionExists()}>
                    Добавить пустую
                  </Button>
                </div>
              </InfoBanner>
            ) : null}

            {!sectionInTemplate && !discoveredCurrent ? (
              <InfoBanner>
                Секции «{section}» нет в прочитанном состоянии роутеров. Она будет создана при применении,
                если отмечено «Создать секцию на роутере».
                <div className="row" style={{ marginTop: 8 }}>
                  <Button size="sm" onClick={() => ensureSectionExists()}>
                    Добавить в шаблон
                  </Button>
                </div>
              </InfoBanner>
            ) : null}

            <div className="row">
              <TextInput value={newSection} onChange={setNewSection} placeholder="Новая секция, например guest" />
              <Button size="sm" variant="subtle" onClick={addSection} disabled={!newSection.trim()}>
                Создать секцию
              </Button>
              <Button size="sm" variant="danger" onClick={removeSection} disabled={!sectionInTemplate}>
                Убрать из шаблона
              </Button>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={payload.create_sections.includes(section)}
                onChange={(event) => toggleCreateSection(event.target.checked)}
              />
              <span>Создать секцию на роутере, если её нет</span>
            </label>

            {sectionInTemplate ? (
              <>
                <div className="grid-2">
                  <Field label="Действие">
                    <Select
                      value={String(sectionPayload.action ?? 'connection')}
                      onChange={(value) => updateSection({ action: value })}
                    >
                      {actions.map((action) => (
                        <option key={action.id} value={action.id}>
                          {action.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Подпись">
                    <TextInput
                      value={String(sectionPayload.label ?? '')}
                      onChange={(value) => updateSection({ label: value })}
                      placeholder="Router Control"
                    />
                  </Field>
                </div>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={String(sectionPayload.enabled ?? '1') === '1'}
                    onChange={(event) => updateSection({ enabled: event.target.checked ? '1' : '0' })}
                  />
                  <span>Секция включена</span>
                </label>

                {['connection', 'proxy', 'outbound', 'vpn'].includes(
                  String(sectionPayload.action ?? 'connection'),
                ) && payload.create_sections.includes(section) ? (
                  <InfoBanner tone="warn">
                    Для действия «{String(sectionPayload.action ?? 'connection')}» на роутере уже должно
                    быть подключение. Сначала добавьте подписку или VLESS во вкладке «Подключения»
                    роутера — иначе применение будет отклонено upstream-валидатором.
                  </InfoBanner>
                ) : null}

                {String(sectionPayload.action ?? '') === 'dns' ? (
                  <div className="stack" style={{ marginTop: 10 }}>
                    <InfoBanner>
                      Для DNS-правила можно задать отдельный DNS-сервер и завернуть его запросы через
                      другую секцию. Пустое значение означает «не управлять».
                    </InfoBanner>
                    <div className="grid-2">
                      <Field label="DNS-протокол">
                        <Select
                          value={sectionValue('dns_type')}
                          onChange={(value) => updateSection({ dns_type: value || null })}
                        >
                          <option value="">Не задано</option>
                          <option value="udp">UDP</option>
                          <option value="dot">DNS over TLS (DoT)</option>
                          <option value="doh">DNS over HTTPS (DoH)</option>
                          <option value="doq">DNS over QUIC (DoQ)</option>
                        </Select>
                      </Field>
                      <Field label="DNS-сервер">
                        <TextInput
                          value={sectionValue('dns_server')}
                          onChange={(value) => updateSection({ dns_server: value || null })}
                          placeholder="1.1.1.1 или https://dns.example/dns-query"
                        />
                      </Field>
                    </div>
                    <div className="grid-2">
                      <Field label="DNS через другую секцию">
                        <Select
                          value={sectionValue('dns_detour_enabled')}
                          onChange={(value) =>
                            updateSection({ dns_detour_enabled: value || null })
                          }
                        >
                          <option value="">Не задано</option>
                          <option value="1">Включено</option>
                          <option value="0">Выключено</option>
                        </Select>
                      </Field>
                      <Field label="Секция для DNS">
                        <Select
                          value={sectionValue('dns_detour_section')}
                          onChange={(value) =>
                            updateSection({ dns_detour_section: value || null })
                          }
                        >
                          <option value="">Не задано</option>
                          {sectionOptions
                            .filter((item) => item !== section)
                            .map((item) => (
                              <option key={item} value={item}>
                                {item}
                              </option>
                            ))}
                        </Select>
                      </Field>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </Panel>

          <Panel
            title="DNS"
            subtitle="Глобальные DNS-настройки Prokop/Forkop. Пустое поле означает, что шаблон не управляет параметром."
          >
            <div className="grid-2">
              <Field label="DNS-протокол">
                <Select
                  value={settingValue('dns_type')}
                  onChange={(value) => updateSetting('dns_type', value || null)}
                >
                  <option value="">Не управлять</option>
                  <option value="udp">UDP</option>
                  <option value="dot">DNS over TLS (DoT)</option>
                  <option value="doh">DNS over HTTPS (DoH)</option>
                  <option value="doq">DNS over QUIC (DoQ)</option>
                </Select>
              </Field>
              <Field label="Стратегия">
                <Select
                  value={settingValue('dns_strategy')}
                  onChange={(value) => updateSetting('dns_strategy', value || null)}
                >
                  <option value="">Не управлять</option>
                  <option value="prefer_ipv4">Предпочитать IPv4</option>
                  <option value="prefer_ipv6">Предпочитать IPv6</option>
                  <option value="ipv4_only">Только IPv4</option>
                  <option value="ipv6_only">Только IPv6</option>
                </Select>
              </Field>
            </div>
            <Field
              label="DNS-серверы"
              hint="По одному на строку. Для DoH/DoT можно указывать URL и порт."
            >
              <textarea
                className="input code-area"
                rows={3}
                value={settingValue('dns_server')}
                onChange={(event) => setSettingList('dns_server', event.target.value)}
                placeholder={'77.88.8.8\nhttps://dns.google/dns-query'}
              />
            </Field>
            <Field
              label="Bootstrap DNS"
              hint="Только IP-адреса, нужны для разрешения имён DoH/DoT-серверов и прокси."
            >
              <textarea
                className="input code-area"
                rows={2}
                value={settingValue('bootstrap_dns_server')}
                onChange={(event) => setSettingList('bootstrap_dns_server', event.target.value)}
                placeholder="77.88.8.8"
              />
            </Field>
            <div className="grid-2">
              <Field label="Интервал проверки" hint="Например, 10s или 30s.">
                <TextInput
                  value={settingValue('dns_check_interval')}
                  onChange={(value) => updateSetting('dns_check_interval', value || null)}
                  placeholder="10s"
                />
              </Field>
              <Field label="Порог failover" hint="Сколько неудач до переключения на резервный DNS.">
                <TextInput
                  value={settingValue('dns_failover_failure_threshold')}
                  onChange={(value) =>
                    updateSetting('dns_failover_failure_threshold', value || null)
                  }
                  placeholder="3"
                />
              </Field>
              <Field label="TTL ответов" hint="В секундах.">
                <TextInput
                  value={settingValue('dns_rewrite_ttl')}
                  onChange={(value) => updateSetting('dns_rewrite_ttl', value || null)}
                  placeholder="60"
                />
              </Field>
              <Field label="DNS через прокси">
                <Select
                  value={settingValue('dns_detour_enabled')}
                  onChange={(value) => updateSetting('dns_detour_enabled', value || null)}
                >
                  <option value="">Не управлять</option>
                  <option value="1">Включено</option>
                  <option value="0">Выключено</option>
                </Select>
              </Field>
            </div>
            <div className="grid-2">
              <Field label="Секция для DNS">
                <Select
                  value={settingValue('dns_detour_section')}
                  onChange={(value) => updateSetting('dns_detour_section', value || null)}
                >
                  <option value="">Не управлять</option>
                  {sectionOptions.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Перехватывать DNS клиентов">
                <Select
                  value={settingValue('intercept_client_dns')}
                  onChange={(value) => updateSetting('intercept_client_dns', value || null)}
                >
                  <option value="">Не управлять</option>
                  <option value="1">Включено</option>
                  <option value="0">Выключено</option>
                </Select>
              </Field>
              <Field label="Отключить QUIC">
                <Select
                  value={settingValue('disable_quic')}
                  onChange={(value) => updateSetting('disable_quic', value || null)}
                >
                  <option value="">Не управлять</option>
                  <option value="1">Включено</option>
                  <option value="0">Выключено</option>
                </Select>
              </Field>
            </div>
          </Panel>

          <Panel
            title="Какие ресурсы идут через VPN"
            subtitle="Списки Prokop/Forkop. Отмеченные ресурсы попадают в community_lists выбранной секции."
            actions={
              <span className="muted-text small">
                выбрано {selectedServices.length} из {services.length}
              </span>
            }
          >
            {catalog.loading && !catalog.data ? <Spinner /> : null}
            {catalog.error ? <ErrorBanner message={catalog.error} /> : null}
            <div className="checklist">
              {services.map((service) => (
                <label key={service.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={selectedServices.includes(service.id)}
                    onChange={(event) => toggleService(service.id, event.target.checked)}
                  />
                  <span>{service.label}</span>
                  <code className="muted-text small">{service.id}</code>
                </label>
              ))}
            </div>
            <Field
              label="Дополнительные ID списков"
              hint="По одному ID на строку. Допустимы только ID из каталога Prokop/Forkop."
            >
              <textarea
                className="input code-area"
                rows={3}
                value={selectedServices.join('\n')}
                onChange={(event) => updateSection({ community_lists: lines(event.target.value) })}
              />
            </Field>
          </Panel>

          <Panel
            title="Свои URL-списки"
            subtitle="Ссылки на .srs/.json или .lst. Списки добавляются к выбранной секции."
          >
            <Field label="rule_set (.srs/.json, домены/IP)" hint="По одной ссылке на строку.">
              <textarea
                className="input code-area"
                rows={3}
                value={asStringList(sectionPayload.rule_set).join('\n')}
                onChange={(event) => setListOption('rule_set', event.target.value)}
              />
            </Field>
            <Field label="rule_set_with_subnets (.srs/.json с подсетями)">
              <textarea
                className="input code-area"
                rows={2}
                value={asStringList(sectionPayload.rule_set_with_subnets).join('\n')}
                onChange={(event) => setListOption('rule_set_with_subnets', event.target.value)}
              />
            </Field>
            <Field label="remote_domain_lists (.lst, только домены)">
              <textarea
                className="input code-area"
                rows={2}
                value={asStringList(sectionPayload.remote_domain_lists).join('\n')}
                onChange={(event) => setListOption('remote_domain_lists', event.target.value)}
              />
            </Field>
            <Field label="remote_subnet_lists (.lst, только IP/подсети)">
              <textarea
                className="input code-area"
                rows={2}
                value={asStringList(sectionPayload.remote_subnet_lists).join('\n')}
                onChange={(event) => setListOption('remote_subnet_lists', event.target.value)}
              />
            </Field>
          </Panel>

          <Panel
            title="Ручные адреса"
            subtitle="Домены и IP/CIDR. JanusNew соберёт локальный .lst на роутере и добавит его в domain_ip_lists."
          >
            <Field
              label="Домены"
              hint="Домен = он и все поддомены. full: — точное совпадение, keyword: — слово, regex: — регулярка. // и # — комментарии."
            >
              <textarea
                className="input code-area"
                rows={6}
                value={manual.domains.join('\n')}
                onChange={(event) => setManual('domains', event.target.value)}
                placeholder={
                  '// Для Seedance / CapCut / ByteDance\nexample.com\nfull:api.example.com\nkeyword:htv-hydaelyn\nregex:^ads\\.'
                }
              />
            </Field>
            <Field label="IP и подсети" hint="IPv4/IPv6, можно с префиксом. // и # — комментарии.">
              <textarea
                className="input code-area"
                rows={4}
                value={manual.ips.join('\n')}
                onChange={(event) => setManual('ips', event.target.value)}
                placeholder={'// офис\n203.0.113.10\n2001:db8::/32'}
              />
            </Field>
          </Panel>

          <Panel
            title="Исключения"
            subtitle="По одному пути на строку. Исключённые параметры не управляются и не изменяются."
          >
            <textarea
              className="input code-area"
              spellCheck={false}
              rows={6}
              value={exclusionsText}
              onChange={(event) => {
                setExclusionsText(event.target.value);
                setValidation(null);
              }}
              placeholder={'settings.log_level\nsection.group.detour'}
            />
          </Panel>

          <Panel
            title="Дополнительно: JSON"
            subtitle="Для экзотических параметров. Галочки выше — основной режим."
            actions={
              <Button size="sm" variant="ghost" onClick={() => setAdvancedOpen((value) => !value)}>
                {advancedOpen ? 'Скрыть' : 'Показать'}
              </Button>
            }
          >
            {advancedOpen ? (
              <>
                <textarea
                  className="input code-area"
                  spellCheck={false}
                  rows={16}
                  value={advancedText}
                  onChange={(event) => setAdvancedText(event.target.value)}
                />
                <div className="row">
                  <Button size="sm" variant="ghost" onClick={applyAdvanced}>
                    Применить JSON
                  </Button>
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={() => setAdvancedText(JSON.stringify(payload, null, 2))}
                  >
                    Загрузить текущее
                  </Button>
                </div>
              </>
            ) : (
              <p className="muted-text small">
                Скрыто. Обычные настройки — галочки, URL-списки и ручные адреса.
              </p>
            )}
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Итог по секции">
            <div className="kv">
              <span>Секция</span>
              <strong>{section}</strong>
              <span>Действие</span>
              <strong>{String(sectionPayload.action ?? 'connection')}</strong>
              <span>Списков сообщества</span>
              <strong>{selectedServices.length}</strong>
              <span>URL-списков</span>
              <strong>
                {['rule_set', 'rule_set_with_subnets', 'remote_domain_lists', 'remote_subnet_lists']
                  .map((key) => asStringList(sectionPayload[key]).length)
                  .reduce((sum, value) => sum + value, 0)}
              </strong>
              <span>Ручных адресов</span>
              <strong>{manual.domains.length + manual.ips.length}</strong>
              <span>На роутере</span>
              <strong>
                {discoveredCurrent
                  ? discoveredCurrent.routers.map((entry) => entry.name).join(', ')
                  : 'не найдена'}
              </strong>
              <span>Создать секцию</span>
              <strong>{payload.create_sections.includes(section) ? 'да' : 'нет'}</strong>
            </div>
          </Panel>

          <Panel
            title="Секции на роутерах"
            subtitle="Прочитано из состояния роутеров. Любую секцию можно открыть в шаблоне; если её нет — она будет создана."
            actions={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void routerSections.reload()}
                busy={routerSections.loading}
              >
                Обновить
              </Button>
            }
          >
            {routerSections.loading && !routerSections.data ? <Spinner /> : null}
            {routerSections.error ? (
              <ErrorBanner message={routerSections.error} onRetry={() => void routerSections.reload()} />
            ) : null}
            {routerSections.data ? (
              routerSections.data.routers.length === 0 ? (
                <Empty>
                  Нет прочитанного состояния. Добавьте роутер и нажмите «Прочитать состояние».
                </Empty>
              ) : discoveredSections.length === 0 ? (
                <Empty>На роутерах пока нет секций правил.</Empty>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Секция</th>
                        <th>Действие</th>
                        <th>Роутеры</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {discoveredSections.map((item) => {
                        const inTemplate = Boolean(payload.sections[item.name]);
                        return (
                          <tr key={item.name}>
                            <td>
                              <code>{item.name}</code>
                              {item.label ? (
                                <div className="muted-text small">{item.label}</div>
                              ) : null}
                            </td>
                            <td>{item.action ?? '—'}</td>
                            <td className="muted-text small">
                              {item.routers.map((entry) => entry.name).join(', ')}
                            </td>
                            <td className="row-actions">
                              <Button
                                size="sm"
                                variant={inTemplate ? 'ghost' : 'subtle'}
                                onClick={() => {
                                  if (inTemplate) setSection(item.name);
                                  else loadSectionFromRouter(item);
                                }}
                              >
                                {inTemplate ? 'Открыть' : 'В шаблон'}
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )
            ) : null}
            {routerSections.data &&
            (routerSections.data.other.urltest.length > 0 ||
              routerSections.data.other.section_interface.length > 0 ||
              routerSections.data.other.subscription_url.length > 0) ? (
              <p className="muted-text small">
                Кроме правил: urltest — {routerSections.data.other.urltest.length}, интерфейсы —{' '}
                {routerSections.data.other.section_interface.length}, подписки —{' '}
                {routerSections.data.other.subscription_url.length}. Ими управляют через JSON-редактор.
              </p>
            ) : null}
          </Panel>

          <Panel title="Ревизии">
            {revisions.loading && !revisions.data ? (
              <Spinner />
            ) : (revisions.data?.items.length ?? 0) === 0 ? (
              <Empty>Ревизий нет.</Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Ред.</th>
                    <th>Создана</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {revisions.data!.items.map((revision) => (
                    <tr key={revision.revision}>
                      <td>
                        {revision.revision}
                        {revision.revision === data.current_revision ? (
                          <span className="muted-text small"> · текущая</span>
                        ) : null}
                      </td>
                      <td className="muted-text small">{formatDate(revision.created_at)}</td>
                      <td className="row-actions">
                        <Button size="sm" variant="ghost" onClick={() => setViewRevision(revision)}>
                          Просмотр
                        </Button>
                        <Button size="sm" variant="subtle" onClick={() => loadDraft(revision)}>
                          В редактор
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel title="Семантика">
            <ul className="bullets">
              <li>Списки заменяются полностью, а не дополняются.</li>
              <li>
                <code>null</code> удаляет параметр из конфигурации.
              </li>
              <li>
                Секция создаётся автоматически, если её нет на роутере и отмечено «Создать секцию
                на роутере».
              </li>
              <li>Пустое поле DNS означает, что шаблон не управляет этим параметром.</li>
              <li>Подписки и VLESS-ссылки хранятся отдельно и не перезаписываются шаблоном.</li>
              <li>Перед применением обязательны diff, подтверждение и снимок.</li>
            </ul>
          </Panel>
        </div>
      </div>

      {viewRevision ? (
        <Modal
          title={`Ревизия ${viewRevision.revision}`}
          wide
          onClose={() => setViewRevision(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setViewRevision(null)}>
                Закрыть
              </Button>
              <Button onClick={() => loadDraft(viewRevision)}>Загрузить в редактор</Button>
            </>
          }
        >
          <p className="muted-text">
            Создана {formatDate(viewRevision.created_at)} ·{' '}
            {viewRevision.exclusions.length} исключений
          </p>
          <h3>Payload</h3>
          <pre className="code-block small">{JSON.stringify(viewRevision.payload, null, 2)}</pre>
          <h3>Исключения</h3>
          {viewRevision.exclusions.length === 0 ? (
            <Empty>Нет исключений.</Empty>
          ) : (
            <pre className="code-block small">{viewRevision.exclusions.join('\n')}</pre>
          )}
        </Modal>
      ) : null}
      {purgeOpen ? (
        <Modal
          title="Удалить шаблон навсегда?"
          onClose={() => setPurgeOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPurgeOpen(false)} disabled={purgeBusy}>
                Отмена
              </Button>
              <Button
                variant="danger"
                onClick={() => void purgeTemplate()}
                busy={purgeBusy}
                disabled={purgeName.trim() !== data.name}
              >
                Удалить навсегда
              </Button>
            </>
          }
        >
          <p>
            Шаблон <strong>{data.name}</strong>, все его ревизии и назначения будут удалены из базы.
            Это действие необратимо.
          </p>
          <p className="muted-text">
            Уже применённая конфигурация на роутерах не изменится. История применений останется, но
            потеряет ссылку на шаблон.
          </p>
          <Field label={`Для подтверждения введите имя «${data.name}»`}>
            <TextInput value={purgeName} onChange={setPurgeName} placeholder={data.name} />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
