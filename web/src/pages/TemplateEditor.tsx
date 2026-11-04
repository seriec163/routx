import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  ErrorBanner,
  Field,
  InfoBanner,
  Modal,
  PageHeader,
  Panel,
  Select,
  Spinner,
  Switch,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import { navigate } from '../lib/router';
import type {
  RoutingAction,
  RoutingService,
  TemplateFull,
  TemplateRevision,
} from '../lib/types';
import { useApi } from '../lib/useApi';
import { useSession } from '../session';

/**
 * Шаблон — это пресет: действие, ресурсы и глобальные настройки.
 * Имени секции в шаблоне нет. Пользователь выбирает секцию на роутере,
 * открывает её правило и заполняет форму из шаблона.
 */

const ACTION_FALLBACK: RoutingAction[] = [
  { id: 'connection', label: 'Через VPN-подключение' },
  { id: 'bypass', label: 'В обход VPN' },
  { id: 'block', label: 'Блокировать' },
  { id: 'dns', label: 'Только DNS' },
];

const SERVICE_ICONS: Record<string, string> = {
  youtube: '▶',
  discord: '💬',
  telegram: '✈',
  meta: '◎',
  twitter: '𝕏',
  tiktok: '♪',
  google_ai: '✦',
  google_play: '▷',
  cloudflare: '☁',
  github: '⌘',
  roblox: '▣',
  anime: '★',
  news: '▤',
  porn: '18+',
  hdrezka: 'HD',
  geoblock: '🌐',
  block: '⛔',
  ads_hagezi_pro: '🚫',
  russia_inside: '🇷🇺',
  russia_outside: '🇷🇺',
  ukraine_inside: '🇺🇦',
  openai: '🤖',
  anthropic: '🅰',
};

const RESOURCE_EDIT_KEYS = [
  'community_lists',
  'domain',
  'rule_set',
  'remote_domain_lists',
  'remote_subnet_lists',
];

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function asText(value: unknown): string {
  if (value == null) return '';
  return Array.isArray(value) ? value.join('\n') : String(value);
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim() !== '') return [value];
  return [];
}

function trimmedOrNull(value: string): string | null {
  const text = value.trim();
  return text === '' ? null : text;
}

export function TemplateEditorPage({ id }: { id: string }) {
  const toast = useToast();
  const { me } = useSession();
  const template = useApi<{ template: TemplateFull }>(`/api/v1/templates/${id}`);
  const revisions = useApi<{ items: TemplateRevision[] }>(`/api/v1/templates/${id}/revisions`);
  const catalog = useApi<{ services: RoutingService[]; actions: RoutingAction[] }>(
    '/api/v1/settings/routing-catalog',
  );

  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [action, setAction] = useState('connection');
  const [services, setServices] = useState<string[]>([]);
  const [domainText, setDomainText] = useState('');
  const [manualDomains, setManualDomains] = useState('');
  const [manualIps, setManualIps] = useState('');
  const [podkopConnectionType, setPodkopConnectionType] = useState('');
  const [podkopProxyMode, setPodkopProxyMode] = useState('');
  const [podkopDomainType, setPodkopDomainType] = useState('');
  const [podkopDomainsText, setPodkopDomainsText] = useState('');
  const [podkopSubnetType, setPodkopSubnetType] = useState('');
  const [podkopSubnetsText, setPodkopSubnetsText] = useState('');
  const [ruleSets, setRuleSets] = useState('');
  const [domainLists, setDomainLists] = useState('');
  const [subnetLists, setSubnetLists] = useState('');
  const [extraResources, setExtraResources] = useState<Record<string, string | string[] | null>>({});
  const [settings, setSettings] = useState<Record<string, string | string[] | null>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedText, setAdvancedText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeName, setPurgeName] = useState('');

  useEffect(() => {
    const data = template.data?.template;
    if (!data || loadedRevision === data.revision) return;
    setLoadedRevision(data.revision);
    setName(data.name);
    setDescription(data.description ?? '');
    const preset = data.preset;
    if (preset) {
      setAction(preset.action);
      setServices(asStringList(preset.resources.community_lists));
      setDomainText(asText(preset.resources.domain));
      setManualDomains((preset.manual_domains ?? []).join('\n'));
      setManualIps((preset.manual_ips ?? []).join('\n'));
      setPodkopConnectionType(preset.podkop?.connection_type ?? '');
      setPodkopProxyMode(preset.podkop?.proxy_config_type ?? '');
      setPodkopDomainType(preset.podkop?.user_domain_list_type ?? '');
      setPodkopDomainsText(preset.podkop?.user_domains_text ?? '');
      setPodkopSubnetType(preset.podkop?.user_subnet_list_type ?? '');
      setPodkopSubnetsText(preset.podkop?.user_subnets_text ?? '');
      setRuleSets(lines(asText(preset.resources.rule_set)).join('\n'));
      setDomainLists(lines(asText(preset.resources.remote_domain_lists)).join('\n'));
      setSubnetLists(lines(asText(preset.resources.remote_subnet_lists)).join('\n'));
      const extra = { ...preset.resources };
      for (const key of RESOURCE_EDIT_KEYS) delete extra[key];
      setExtraResources(extra);
      setSettings(preset.settings ?? {});
    } else {
      setAction('connection');
      setServices([]);
      setDomainText('');
      setManualDomains('');
      setManualIps('');
      setPodkopConnectionType('');
      setPodkopProxyMode('');
      setPodkopDomainType('');
      setPodkopDomainsText('');
      setPodkopSubnetType('');
      setPodkopSubnetsText('');
      setRuleSets('');
      setDomainLists('');
      setSubnetLists('');
      setExtraResources({});
      setSettings({});
    }
    if (data.preset_error) setError(data.preset_error);
  }, [template.data, loadedRevision]);

  const actions = catalog.data?.actions?.length ? catalog.data.actions : ACTION_FALLBACK;
  const serviceList = catalog.data?.services ?? [];

  function buildPodkopPreset(): Record<string, unknown> {
    const preset: Record<string, unknown> = {};
    if (podkopConnectionType) preset.connection_type = podkopConnectionType;
    if (podkopProxyMode) preset.proxy_config_type = podkopProxyMode;
    if (podkopDomainType) preset.user_domain_list_type = podkopDomainType;
    if (podkopDomainType === 'text') preset.user_domains_text = podkopDomainsText;
    if (podkopSubnetType) preset.user_subnet_list_type = podkopSubnetType;
    if (podkopSubnetType === 'text') preset.user_subnets_text = podkopSubnetsText;
    return preset;
  }

  const settingsPreview = useMemo(() => {
    const payload = {
      action,
      enabled: '1',
      resources: {
        ...extraResources,
        community_lists: services,
        domain: trimmedOrNull(domainText),
        rule_set: lines(ruleSets),
        remote_domain_lists: lines(domainLists),
        remote_subnet_lists: lines(subnetLists),
      },
      manual_domains: lines(manualDomains),
      manual_ips: lines(manualIps),
      podkop: buildPodkopPreset(),
      settings,
      sections: {},
      urltest: {},
      section_interface: {},
      subscription_url: {},
      create_urltest: [],
      create_sections: [],
      manual_entries: {},
    };
    return JSON.stringify(payload, null, 2);
  }, [
    action,
    extraResources,
    services,
    domainText,
    ruleSets,
    domainLists,
    subnetLists,
    manualDomains,
    manualIps,
    podkopConnectionType,
    podkopProxyMode,
    podkopDomainType,
    podkopDomainsText,
    podkopSubnetType,
    podkopSubnetsText,
    settings,
  ]);

  useEffect(() => {
    if (advancedOpen) setAdvancedText(settingsPreview);
  }, [advancedOpen, settingsPreview]);

  function toggleService(id: string): void {
    setServices((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }

  function setting(option: string): string {
    return asText(settings[option]);
  }

  function updateSetting(option: string, value: string | string[] | null): void {
    setSettings((current) => {
      const next = { ...current };
      if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
        delete next[option];
      } else {
        next[option] = value;
      }
      return next;
    });
  }

  function switchSetting(option: string, value: boolean): void {
    updateSetting(option, value ? '1' : '0');
  }

  function buildPayload(): Record<string, unknown> {
    return {
      action,
      enabled: '1',
      resources: {
        ...extraResources,
        community_lists: services,
        domain: trimmedOrNull(domainText),
        rule_set: lines(ruleSets),
        remote_domain_lists: lines(domainLists),
        remote_subnet_lists: lines(subnetLists),
      },
      manual_domains: lines(manualDomains),
      manual_ips: lines(manualIps),
      podkop: buildPodkopPreset(),
      settings,
      sections: {},
      urltest: {},
      section_interface: {},
      subscription_url: {},
      create_urltest: [],
      create_sections: [],
      manual_entries: {},
    };
  }

  async function save(): Promise<void> {
    if (name.trim() === '') {
      setError('Укажите название шаблона');
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const payload = buildPayload();
      await api('/api/v1/templates/validate', {
        method: 'POST',
        body: { payload, exclusions: [] },
      });
      const response = await api<{ revision: number }>(`/api/v1/templates/${id}/revisions`, {
        method: 'POST',
        body: { payload, exclusions: [] },
      });
      const current = template.data?.template;
      if (current && (current.name !== name.trim() || (current.description ?? '') !== description)) {
        await api(`/api/v1/templates/${id}`, {
          method: 'PATCH',
          body: { name: name.trim(), description: description || null },
        });
      }
      setSaved(`Сохранена ревизия ${response.revision}`);
      toast.success(`Ревизия ${response.revision} сохранена`);
      await Promise.all([template.reload(), revisions.reload()]);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function archive(): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/v1/templates/${id}`, { method: 'DELETE' });
      toast.success('Шаблон перемещён в архив');
      navigate('/templates');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function purge(): Promise<void> {
    const current = template.data?.template;
    if (!current || purgeName.trim() !== current.name) return;
    setBusy(true);
    try {
      await api(`/api/v1/templates/${id}?purge=true`, { method: 'DELETE' });
      toast.success('Шаблон удалён навсегда');
      navigate('/templates');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (template.loading && !template.data) return <Spinner />;
  if (template.error && !template.data)
    return <ErrorBanner message={template.error} onRetry={() => void template.reload()} />;
  if (!template.data) return <ErrorBanner message="Шаблон не найден" />;

  const current = template.data.template;
  const revision = current.revision ?? current.current_revision;
  const canEdit =
    me?.permissions.is_superadmin === true ||
    (me != null && current.owner_id === me.user.id);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Шаблон без имени секции"
        title={current.name}
        subtitle={`Ревизия ${revision}. Шаблон задаёт действие, ресурсы и настройки. Секцию и подключения вы выбираете на странице роутера.`}
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate('/templates')}>
              К шаблонам
            </Button>
            {canEdit ? (
              <>
                <Button variant="ghost" onClick={() => setArchiveOpen(true)} disabled={busy}>
                  В архив
                </Button>
                <Button onClick={() => void save()} busy={busy}>
                  Сохранить ревизию
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {!canEdit ? (
        <InfoBanner>
          Общий шаблон{current.owner_email ? ` пользователя ${current.owner_email}` : ''}. Его можно
          применять к своим роутерам, но редактировать и удалять может только владелец.
        </InfoBanner>
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}
      {saved ? <InfoBanner>{saved}</InfoBanner> : null}
      {!current.preset && current.preset_error ? (
        <InfoBanner tone="warn">
          Шаблон сохранён в старом формате с несколькими секциями. Ниже показаны пустые значения;
          настройте его заново и сохраните новую ревизию.
        </InfoBanner>
      ) : null}

      <fieldset className="template-locked" disabled={!canEdit}>
        <div className="stack">
        <Panel title="Основное" subtitle="Название видно только в панели; в UCI оно не попадает.">
          <Field label="Название">
            <TextInput value={name} onChange={setName} placeholder="YouTube через VPN" required />
          </Field>
          <Field label="Описание" hint="Необязательно">
            <TextInput
              value={description}
              onChange={setDescription}
              placeholder="Для чего этот шаблон"
            />
          </Field>
          <Field
            label="Действие"
            hint="Именно это действие получит правило, к которому вы примените шаблон."
          >
            <Select value={action} onChange={setAction}>
              {actions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
        </Panel>

        <Panel
          title="Ресурсы"
          subtitle="Необязательно. Если ничего не выбрать, ресурсы задаются в правиле на роутере. Выбранные здесь сервисы и домены добавляются в правило вместе с действием."
        >
          <Field label="Сервисы">
            <div className="chip-grid">
              {serviceList.map((service) => {
                const active = services.includes(service.id);
                return (
                  <button
                    key={service.id}
                    type="button"
                    className={`chip-toggle ${active ? 'chip-toggle-on' : ''}`}
                    onClick={() => toggleService(service.id)}
                  >
                    <span aria-hidden="true">{SERVICE_ICONS[service.id] ?? '•'}</span>
                    {service.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="grid-2">
            <Field
              label="Свои домены"
              hint="По одному на строку. Домен = он и все поддомены."
            >
              <textarea
                className="input code-area"
                rows={5}
                value={manualDomains}
                onChange={(event) => setManualDomains(event.target.value)}
                placeholder={'example.com\nyoutube.com'}
              />
            </Field>
            <Field
              label="Точные домены, keyword и regex"
              hint="full:api.example.com, keyword:freebuff, regex:\\.ai$"
            >
              <textarea
                className="input code-area"
                rows={5}
                value={domainText}
                onChange={(event) => setDomainText(event.target.value)}
                placeholder={'full:api.example.com\nkeyword:freebuff\nregex:\\.ai$'}
              />
            </Field>
          </div>

          <Field label="Свои IP и подсети" hint="IPv4/IPv6, можно с префиксом.">
            <textarea
              className="input code-area"
              rows={3}
              value={manualIps}
              onChange={(event) => setManualIps(event.target.value)}
              placeholder={'203.0.113.10\n2001:db8::/32'}
            />
          </Field>

          <details className="advanced">
            <summary>Дополнительные списки</summary>
            <Field label="URL-списки rule_set (.srs/.json)" hint="По одной ссылке на строку.">
              <textarea
                className="input code-area"
                rows={3}
                value={ruleSets}
                onChange={(event) => setRuleSets(event.target.value)}
              />
            </Field>
            <Field label="URL-списки доменов (.lst)">
              <textarea
                className="input code-area"
                rows={2}
                value={domainLists}
                onChange={(event) => setDomainLists(event.target.value)}
              />
            </Field>
            <Field label="URL-списки подсетей (.lst)">
              <textarea
                className="input code-area"
                rows={2}
                value={subnetLists}
                onChange={(event) => setSubnetLists(event.target.value)}
              />
            </Field>
          </details>
        </Panel>

        <Panel
          title="Podkop"
          subtitle="Необязательно. Эти поля используются только при применении шаблона к Podkop; для Prokop/Forkop они игнорируются."
        >
          <div className="grid-2">
            <Field
              label="Тип секции Podkop"
              hint="Авто — по действию: connection→proxy, bypass→exclusion, block→block."
            >
              <Select value={podkopConnectionType} onChange={setPodkopConnectionType}>
                <option value="">Авто (по действию)</option>
                <option value="proxy">Прокси</option>
                <option value="vpn">VPN</option>
                <option value="block">Блокировать</option>
                <option value="exclusion">Исключить из маршрутизации</option>
              </Select>
            </Field>
            <Field label="Режим прокси" hint="Пусто — не менять существующий режим.">
              <Select value={podkopProxyMode} onChange={setPodkopProxyMode}>
                <option value="">Не менять</option>
                <option value="url">Одна ссылка (url)</option>
                <option value="selector">Список selector</option>
                <option value="urltest">Список urltest</option>
                <option value="outbound">JSON outbound</option>
              </Select>
            </Field>
            <Field label="Домены: способ задания">
              <Select value={podkopDomainType} onChange={setPodkopDomainType}>
                <option value="">Не задавать</option>
                <option value="disabled">Не использовать</option>
                <option value="dynamic">Список (dynamic)</option>
                <option value="text">Текст (text list)</option>
              </Select>
            </Field>
            <Field label="Подсети: способ задания">
              <Select value={podkopSubnetType} onChange={setPodkopSubnetType}>
                <option value="">Не задавать</option>
                <option value="disabled">Не использовать</option>
                <option value="dynamic">Список (dynamic)</option>
                <option value="text">Текст (text list)</option>
              </Select>
            </Field>
          </div>

          {podkopDomainType === 'text' ? (
            <Field
              label="Домены текстом"
              hint="Домены через запятую или по одному на строку. Сохраняется в user_domains_text."
            >
              <textarea
                className="input code-area"
                rows={6}
                value={podkopDomainsText}
                onChange={(event) => setPodkopDomainsText(event.target.value)}
                placeholder={'example.com\nyoutube.com'}
              />
            </Field>
          ) : null}
          {podkopSubnetType === 'text' ? (
            <Field
              label="Подсети текстом"
              hint="IPv4/IPv6 через запятую или по одному на строку. Сохраняется в user_subnets_text."
            >
              <textarea
                className="input code-area"
                rows={4}
                value={podkopSubnetsText}
                onChange={(event) => setPodkopSubnetsText(event.target.value)}
                placeholder={'203.0.113.10\n2001:db8::/32'}
              />
            </Field>
          ) : null}
          <p className="muted-text small">
            Для режима «Список (dynamic)» значения берутся из полей «Свои домены» и «Свои IP и
            подсети» выше.
          </p>
        </Panel>

        <Panel
          title="Настройки"
          subtitle="Глобальные параметры Prokop/Forkop. Пустое поле означает «не менять»."
        >
          <div className="grid-2">
            <Field label="Тип DNS" hint="Пусто — не менять">
              <Select value={setting('dns_type')} onChange={(value) => updateSetting('dns_type', value)}>
                <option value="">Не менять</option>
                <option value="udp">UDP</option>
                <option value="doh">DoH</option>
              </Select>
            </Field>
            <Field label="Уровень логов">
              <Select value={setting('log_level')} onChange={(value) => updateSetting('log_level', value)}>
                <option value="">Не менять</option>
                <option value="error">error</option>
                <option value="warn">warn</option>
                <option value="info">info</option>
                <option value="debug">debug</option>
              </Select>
            </Field>
          </div>

          <Field label="Основные DNS-серверы" hint="По одному на строку. Пусто — не менять.">
            <textarea
              className="input code-area"
              rows={2}
              value={setting('dns_server')}
              onChange={(event) => updateSetting('dns_server', lines(event.target.value))}
              placeholder={'8.8.8.8\n1.1.1.1'}
            />
          </Field>
          <Field label="Bootstrap DNS" hint="По одному на строку. Пусто — не менять.">
            <textarea
              className="input code-area"
              rows={2}
              value={setting('bootstrap_dns_server')}
              onChange={(event) => updateSetting('bootstrap_dns_server', lines(event.target.value))}
              placeholder={'77.88.8.8\n8.8.4.4'}
            />
          </Field>

          <div className="settings-grid">
            <Switch
              checked={setting('disable_quic') === '1'}
              onChange={(value) => switchSetting('disable_quic', value)}
              label="Отключать QUIC"
            />
            <Switch
              checked={setting('exclude_ntp') === '1'}
              onChange={(value) => switchSetting('exclude_ntp', value)}
              label="Исключить NTP"
            />
            <Switch
              checked={setting('intercept_client_dns') === '1'}
              onChange={(value) => switchSetting('intercept_client_dns', value)}
              label="Перехватывать DNS клиентов"
            />
            <Switch
              checked={setting('download_lists_via_proxy') === '1'}
              onChange={(value) => switchSetting('download_lists_via_proxy', value)}
              label="Скачивать списки через прокси"
            />
            <Switch
              checked={setting('device_traffic') === '1'}
              onChange={(value) => switchSetting('device_traffic', value)}
              label="Учитывать трафик устройств"
            />
          </div>

          <details className="advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}>
            <summary>JSON шаблона</summary>
            <p className="muted-text small">
              Только для проверки. Чтобы изменить редкие параметры, используйте поля выше.
            </p>
            <pre className="code-block small">{advancedText || settingsPreview}</pre>
          </details>
        </Panel>

        <Panel
          title="История ревизий"
          subtitle="Ревизии неизменяемы. Применение всегда создаёт diff, снимок и проверку."
        >
          {revisions.loading && !revisions.data ? <Spinner /> : null}
          {(revisions.data?.items.length ?? 0) === 0 ? (
            <p className="empty">Ревизий нет.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Ревизия</th>
                    <th>Создана</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {revisions.data!.items.map((item) => (
                    <tr key={item.revision}>
                      <td>{item.revision}</td>
                      <td className="muted-text small">{formatDate(item.created_at)}</td>
                      <td>
                        {item.revision === revision ? (
                          <span className="badge badge-ok">текущая</span>
                        ) : (
                          <span className="muted-text small">история</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        </div>
      </fieldset>

      {archiveOpen ? (
        <ConfirmDialog
          title="Архивировать шаблон?"
          danger
          busy={busy}
          confirmLabel="В архив"
          onCancel={() => setArchiveOpen(false)}
          onConfirm={() => void archive()}
          message={
            <p>
              Шаблон <strong>{current.name}</strong> будет архивирован. Уже применённые на роутерах
              правила не изменятся.
            </p>
          }
        />
      ) : null}

      {purgeOpen ? (
        <Modal
          title="Удалить шаблон навсегда?"
          onClose={() => setPurgeOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPurgeOpen(false)} disabled={busy}>
                Отмена
              </Button>
              <Button
                variant="danger"
                onClick={() => void purge()}
                busy={busy}
                disabled={purgeName.trim() !== current.name}
              >
                Удалить навсегда
              </Button>
            </>
          }
        >
          <p>
            Шаблон <strong>{current.name}</strong> и все его ревизии будут удалены. Уже применённые
            правила на роутерах не изменятся.
          </p>
          <Field label={`Для подтверждения введите имя «${current.name}»`}>
            <TextInput value={purgeName} onChange={setPurgeName} placeholder={current.name} />
          </Field>
        </Modal>
      ) : null}

      {current.archived_at ? (
        <InfoBanner tone="warn">
          Шаблон находится в архиве с {formatDate(current.archived_at)}. Восстановить его можно на
          странице «Шаблоны».
        </InfoBanner>
      ) : null}

      {purgeOpen ? null : canEdit && !current.archived_at ? (
        <p className="muted-text small" style={{ marginTop: 12 }}>
          <button type="button" className="link-button" onClick={() => setPurgeOpen(true)}>
            Удалить шаблон навсегда
          </button>
        </p>
      ) : null}
    </div>
  );
}
