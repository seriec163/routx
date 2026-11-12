import { useEffect, useRef, useState } from 'react';
import { DiffView } from '../components/diff';
import { ServicePicker } from '../components/ServicePicker';
import { ServiceInfoButton, ServiceTooltip } from '../components/ServiceTooltip';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBanner,
  Field,
  InfoBanner,
  JobProgress,
  Modal,
  Panel,
  ProgressBar,
  Select,
  Spinner,
  StatusBadge,
  Switch,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { APPLY_STATUS, formatRelative, PRODUCT_LABEL } from '../lib/format';
import type {
  ApplyRunDetail,
  CatalogSubscription,
  Job,
  RuleConnectionView,
  RuleView,
  RulesResponse,
  RouterRecord,
  RouterState,
  RoutingAction,
  RoutingGroup,
  RoutingService,
  TemplateFull,
  TemplateListItem,
} from '../lib/types';
import { useApi } from '../lib/useApi';

const ACTION_FALLBACK: RoutingAction[] = [
  { id: 'connection', label: 'Через VPN-подключение' },
  { id: 'bypass', label: 'В обход VPN' },
  { id: 'block', label: 'Блокировать' },
  { id: 'dns', label: 'Только DNS' },
];

const ACTION_SHORT: Record<string, string> = {
  connection: 'через VPN',
  proxy: 'через VPN',
  outbound: 'через VPN',
  vpn: 'через VPN',
  bypass: 'в обход VPN',
  block: 'блокировка',
  dns: 'только DNS',
};

const CONNECTION_ACTIONS = new Set(['connection', 'proxy', 'outbound', 'vpn']);

const PODKOP_OPTION_KEYS = new Set([
  'enable_udp_over_tcp',
  'urltest_check_interval',
  'urltest_tolerance',
  'urltest_testing_url',
  'mixed_proxy_enabled',
  'mixed_proxy_port',
  'domain_resolver_enabled',
  'resolve_real_ip_for_routing',
]);

function pickPodkopOptions(
  source: Record<string, string | string[] | null> | undefined,
): Record<string, string | string[] | null> {
  const output: Record<string, string | string[] | null> = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (PODKOP_OPTION_KEYS.has(key)) output[key] = value;
  }
  return output;
}
const LINK_PREFIX_RE =
  /^(vless|vmess|trojan|ss|ssr|hysteria|hysteria2|hy2|tuic|anytls|socks|socks4|socks4a|socks5|socks5h):\/\//i;

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

const SERVICE_GROUP_ORDER = [
  'ai',
  'media',
  'social',
  'gaming',
  'tech',
  'infra',
  'regional',
  'direct',
  'block',
  'other',
  'internal',
];
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .split('')
    .map((char) => TRANSLIT[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

function newSectionName(label: string): string {
  const raw = slugify(label) || 'rule';
  const slug = raw.startsWith('rc_') ? raw.slice(3) : raw;
  return `rc_${slug}_${Math.random().toString(36).slice(2, 6)}`;
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim() !== '') return [value];
  return [];
}

function asText(value: unknown): string {
  if (value == null) return '';
  return Array.isArray(value) ? value.join('\n') : String(value);
}

async function waitForJob(job: Job, timeoutMs = 240_000): Promise<Job> {
  let current = job;
  const deadline = Date.now() + timeoutMs;
  while (
    (current.status === 'queued' || current.status === 'running') &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    current = (await api<{ job: Job }>(`/api/v1/jobs/${current.id}`)).job;
  }
  return current;
}

interface PendingConnection {
  kind: 'subscription' | 'vless';
  label: string;
  value?: string;
  subscription_id?: string;
}

interface RuleBody {
  section: string;
  label: string;
  action: string;
  enabled: boolean;
  create: boolean;
  resources: Record<string, string | string[] | null>;
  manual_domains: string[];
  manual_ips: string[];
  settings: Record<string, string | string[] | null>;
  connection_type?: 'proxy' | 'vpn' | 'block' | 'exclusion';
  proxy_config_type?: 'url' | 'selector' | 'urltest' | 'outbound';
  user_domain_list_type?: 'disabled' | 'dynamic' | 'text';
  user_domains_text?: string;
  user_subnet_list_type?: 'disabled' | 'dynamic' | 'text';
  user_subnets_text?: string;
  outbound_json?: string;
  podkop_options?: Record<string, string | string[] | null>;
}

interface DiffRequest {
  title: string;
  body: RuleBody;
  /** Создаём выключенным, пока в секции нет источника подключения. */
  bootstrap?: boolean;
  finalEnabled?: boolean;
  afterApply?: () => Promise<void>;
}

export function RouterRulesPanel(props: {
  routerId: string;
  router: RouterRecord;
  state: RouterState | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const catalog = useApi<{
    services: RoutingService[];
    groups?: RoutingGroup[];
    actions: RoutingAction[];
  }>(
    `/api/v1/settings/routing-catalog?router_id=${encodeURIComponent(props.routerId)}`,
  );
  const templates = useApi<{ items: TemplateListItem[] }>('/api/v1/templates');
  const [rules, setRules] = useState<RuleView[]>([]);
  const [source, setSource] = useState<'live' | 'cache'>('cache');
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{
    mode: 'create' | 'edit';
    rule: RuleView | null;
  } | null>(null);
  const [diffRequest, setDiffRequest] = useState<DiffRequest | null>(null);
  const [connectionTarget, setConnectionTarget] = useState<{
    rule: RuleView;
    connection: RuleConnectionView | null;
  } | null>(null);
  const [subscriptionTarget, setSubscriptionTarget] = useState<{
    rule: RuleView;
    connection: RuleConnectionView | null;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    rule: RuleView;
    connection: RuleConnectionView;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteJob, setDeleteJob] = useState<Job | null>(null);
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<RuleView | null>(null);
  const [deleteSectionBusy, setDeleteSectionBusy] = useState(false);
  const [deleteSectionJob, setDeleteSectionJob] = useState<Job | null>(null);
  const [managedSection, setManagedSection] = useState(props.router.managed_section ?? '');
  const [toggleTarget, setToggleTarget] = useState<RuleView | null>(null);
  const liveLoaded = useRef(false);

  const online = props.router.status === 'online';
  const isPodkop = props.router.product === 'podkop';
  const productLabel = PRODUCT_LABEL[props.router.product] ?? 'продукт';
  const actions = catalog.data?.actions?.length ? catalog.data.actions : ACTION_FALLBACK;
  const services = catalog.data?.services ?? [];

  useEffect(() => {
    void loadCached();
    if (online) void readLive();
    // Намеренно один раз при открытии вкладки.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadCached(): Promise<void> {
    try {
      const response = await api<RulesResponse>(`/api/v1/routers/${props.routerId}/rules`);
      if (liveLoaded.current) return;
      setRules(response.rules ?? []);
      setSource(response.source ?? 'cache');
      setManagedSection(response.managed_section ?? props.router.managed_section ?? '');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }

  async function readLive(): Promise<void> {
    if (!online) return;
    setReading(true);
    setError(null);
    try {
      const response = await api<{ job: Job }>(`/api/v1/routers/${props.routerId}/rules/read`, {
        method: 'POST',
      });
      const job = await waitForJob(response.job);
      if (job.status !== 'success') {
        throw new Error(job.error?.message ?? 'Не удалось прочитать правила с роутера');
      }
      const result = job.result as unknown as RulesResponse;
      liveLoaded.current = true;
      setRules(result.rules ?? []);
      setSource('live');
      setManagedSection(result.managed_section ?? props.router.managed_section ?? '');
      // Обновляем карточку «Служба»: read_rules пишет health/service в состояние.
      props.onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setReading(false);
    }
  }

  function openCreate(): void {
    setEditor({ mode: 'create', rule: null });
  }

  function openEdit(rule: RuleView): void {
    setEditor({ mode: 'edit', rule });
  }

  const enabledRules = rules.filter((rule) => rule.enabled);

  function requestToggle(rule: RuleView): void {
    if (rule.enabled && enabledRules.length === 1) {
      toast.error(
        'Нельзя выключить последнее включённое правило: Prokop не сможет собрать конфигурацию. Сначала включите другое правило.',
      );
      return;
    }
    setToggleTarget(rule);
  }

  function requestDelete(rule: RuleView, connection: RuleConnectionView): void {
    const sources = rule.subscriptions.length + rule.links.length;
    if (rule.enabled && enabledRules.length === 1 && sources <= 1) {
      toast.error(
        'Это последний источник последнего включённого правила. Prokop не сможет собрать конфигурацию. Сначала включите другое правило или добавьте источник.',
      );
      return;
    }
    setDeleteTarget({ rule, connection });
    setDeleteJob(null);
  }

  function requestDeleteSection(rule: RuleView): void {
    if (rule.section === managedSection) {
      toast.error('Нельзя удалить основную секцию роутера');
      return;
    }
    setDeleteSectionTarget(rule);
    setDeleteSectionJob(null);
  }

  async function deleteSection(): Promise<void> {
    if (!deleteSectionTarget) return;
    setDeleteSectionBusy(true);
    try {
      const started = await api<{ job: Job }>(
        `/api/v1/routers/${props.routerId}/sections/${encodeURIComponent(deleteSectionTarget.section)}`,
        { method: 'DELETE' },
      );
      setDeleteSectionJob(started.job);
      const done = await waitForJob(started.job, 300_000);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'Не удалось удалить секцию');
      }
      toast.success(`Секция «${deleteSectionTarget.label}» удалена`);
      setDeleteSectionTarget(null);
      await readLive();
      props.onChanged();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setDeleteSectionBusy(false);
      setDeleteSectionJob(null);
    }
  }

  async function toggleRule(): Promise<void> {
    if (!toggleTarget) return;
    const rule = toggleTarget;
    setToggleTarget(null);
    setDiffRequest({
      title: rule.enabled ? `Выключить «${rule.label}»` : `Включить «${rule.label}»`,
      body: {
        section: rule.section,
        label: rule.label,
        action: rule.action,
        enabled: !rule.enabled,
        create: false,
        resources: rule.resources,
        manual_domains: rule.manual_domains,
        manual_ips: rule.manual_ips,
        settings: {},
        connection_type:
          props.router.product === 'podkop'
            ? ((rule.resources.connection_type as RuleBody['connection_type']) ??
              (rule.action === 'block'
                ? 'block'
                : rule.action === 'bypass'
                  ? 'exclusion'
                  : 'proxy'))
            : undefined,
        proxy_config_type:
          props.router.product === 'podkop'
            ? ((rule.resources.proxy_config_type as RuleBody['proxy_config_type']) ?? 'url')
            : undefined,
        user_domain_list_type:
          props.router.product === 'podkop'
            ? ((rule.resources.user_domain_list_type as RuleBody['user_domain_list_type']) ??
              (rule.manual_domains.length > 0 ? 'dynamic' : 'disabled'))
            : undefined,
        user_domains_text:
          props.router.product === 'podkop' &&
          rule.resources.user_domain_list_type === 'text'
            ? String(rule.resources.user_domains_text ?? '')
            : undefined,
        user_subnet_list_type:
          props.router.product === 'podkop'
            ? ((rule.resources.user_subnet_list_type as RuleBody['user_subnet_list_type']) ??
              (rule.manual_ips.length > 0 ? 'dynamic' : 'disabled'))
            : undefined,
        user_subnets_text:
          props.router.product === 'podkop' &&
          rule.resources.user_subnet_list_type === 'text'
            ? String(rule.resources.user_subnets_text ?? '')
            : undefined,
        podkop_options:
          props.router.product === 'podkop' ? pickPodkopOptions(rule.resources) : undefined,
      },
    });
  }

  async function waitDeleteJob(start: Job): Promise<Job> {
    let current = start;
    setDeleteJob(current);
    while (current.status === 'queued' || current.status === 'running') {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      current = (await api<{ job: Job }>(`/api/v1/jobs/${current.id}`)).job;
      setDeleteJob(current);
    }
    return current;
  }

  async function deleteConnection(): Promise<void> {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteJob(null);
    try {
      const { rule, connection } = deleteTarget;
      if (connection.managed && connection.id) {
        const response = await api<{ job: Job }>(
          `/api/v1/routers/${props.routerId}/connections/${connection.id}`,
          { method: 'DELETE' },
        );
        const job = await waitDeleteJob(response.job);
        if (job.status !== 'success') {
          throw new Error(job.error?.message ?? 'Не удалось удалить подключение');
        }
      } else {
        const response = await api<{ job: Job }>(
          `/api/v1/routers/${props.routerId}/connections/manage`,
          {
            method: 'POST',
            body: {
              action: 'delete',
              kind: connection.kind === 'subscription' ? 'subscription' : 'link',
              name: connection.name ?? undefined,
              hash: connection.hash ?? undefined,
              section: rule.section,
            },
          },
        );
        const job = await waitDeleteJob(response.job);
        if (job.status !== 'success') {
          throw new Error(job.error?.message ?? 'Не удалось удалить подключение');
        }
      }
      toast.success('Подключение удалено');
      setDeleteTarget(null);
      setDeleteJob(null);
      await readLive();
      props.onChanged();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function addPendingConnections(section: string, pending: PendingConnection[]): Promise<void> {
    for (const item of pending) {
      const response = await api<{ job: Job }>(
        `/api/v1/routers/${props.routerId}/connections`,
        {
          method: 'POST',
          body: {
            kind: item.kind,
            label: item.label,
            section,
            ...(item.subscription_id
              ? { subscription_id: item.subscription_id }
              : { value: item.value }),
          },
        },
      );
      const job = await waitForJob(response.job);
      if (job.status !== 'success') {
        throw new Error(job.error?.message ?? 'Не удалось применить подключение');
      }
    }
  }

  /**
   * Применение правила без отдельного окна diff. Используется только после
   * того, как пользователь уже подтвердил создание, например чтобы вернуть
   * выключенное состояние после добавления подключений.
   */
  async function applyRuleBody(body: RuleBody): Promise<void> {
    const started = await api<{ job: Job }>(
      `/api/v1/routers/${props.routerId}/rules/diff`,
      { method: 'POST', body },
    );
    const diffJob = await waitForJob(started.job);
    if (diffJob.status !== 'success') {
      throw new Error(diffJob.error?.message ?? 'Не удалось сравнить правило');
    }
    const applyRunId =
      typeof diffJob.result?.apply_run_id === 'string' ? diffJob.result.apply_run_id : null;
    if (!applyRunId) throw new Error('Сервер не вернул результат сравнения');
    const detail = await api<ApplyRunDetail>(`/api/v1/apply-runs/${applyRunId}`);
    if (detail.items.length === 0) return;
    const confirmed = await api<{ job: Job }>(
      `/api/v1/apply-runs/${applyRunId}/confirm`,
      {
        method: 'POST',
        body: { diff_hash: detail.apply_run.diff_hash },
      },
    );
    const applied = await waitForJob(confirmed.job, 600_000);
    if (applied.status !== 'success') {
      throw new Error(applied.error?.message ?? 'Не удалось применить правило');
    }
  }

  async function applyPodkopOutbound(section: string, outboundJson: string): Promise<void> {
    const response = await api<{ job: Job }>(
      `/api/v1/routers/${props.routerId}/podkop/outbound`,
      { method: 'PUT', body: { section, outbound_json: outboundJson } },
    );
    const job = await waitForJob(response.job, 300_000);
    if (job.status !== 'success') {
      throw new Error(job.error?.message ?? 'Не удалось сохранить outbound JSON');
    }
  }

  async function selectProxy(
    section: string,
    connection: RuleConnectionView,
  ): Promise<void> {
    if (!connection.proxy_group || !connection.proxy_tag) return;
    try {
      const response = await api<{ job: Job }>(
        `/api/v1/routers/${props.routerId}/proxies/select`,
        {
          method: 'POST',
          body: { group: connection.proxy_group, tag: connection.proxy_tag },
        },
      );
      const job = await waitForJob(response.job, 90_000);
      if (job.status !== 'success') {
        throw new Error(job.error?.message ?? 'Не удалось переключить подключение');
      }
      toast.success('Активное подключение переключено');
      await readLive();
      props.onChanged();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  function submitRule(body: RuleBody, pending: PendingConnection[]): void {
    const userEnabled = body.enabled;
    const hasOutbound =
      props.router.product === 'podkop' && Boolean(body.outbound_json?.trim());
    if (hasOutbound && pending.length > 0) {
      toast.error('Outbound JSON несовместим с добавлением ссылок в этой же форме');
      return;
    }
    const existingRule = rules.find((rule) => rule.section === body.section);
    const existingSources = existingRule
      ? existingRule.subscriptions.length + existingRule.links.length
      : 0;
    const bootstrap =
      CONNECTION_ACTIONS.has(body.action) &&
      pending.length > 0 &&
      existingSources === 0;
    const diffBody = hasOutbound
      ? {
          ...body,
          enabled: bootstrap ? false : body.enabled,
          outbound_json: undefined,
          proxy_config_type: undefined,
        }
      : bootstrap
        ? { ...body, enabled: false }
        : body;
    const afterApply =
      pending.length > 0 || hasOutbound
        ? async () => {
            if (pending.length > 0) {
              await addPendingConnections(body.section, pending);
            }
            if (hasOutbound) {
              await applyPodkopOutbound(body.section, body.outbound_json!.trim());
            }
            // apply_connections/outbound включают секцию, когда появился источник.
            // Если пользователь создавал правило выключенным — возвращаем 0.
            if (!userEnabled) {
              await applyRuleBody({
                ...body,
                create: false,
                enabled: false,
                outbound_json: undefined,
                proxy_config_type: undefined,
              });
            }
            toast.success(
              hasOutbound
                ? 'Outbound JSON сохранён'
                : pending.length === 1
                  ? 'Подключение добавлено'
                  : `Добавлено подключений: ${pending.length}`,
            );
          }
        : undefined;
    setEditor(null);
    setDiffRequest({
      title: body.create ? `Создать правило «${body.label}»` : `Изменить правило «${body.label}»`,
      body: diffBody,
      bootstrap,
      finalEnabled: userEnabled,
      afterApply,
    });
  }

  const totalConnections = rules.reduce(
    (sum, rule) => sum + rule.subscriptions.length + rule.links.length,
    0,
  );

  return (
    <div className="stack">
      <Panel
        title="Правила на роутере"
        subtitle="Одна секция — одно правило: что пустить через VPN, что в обход, что заблокировать. Правила читаются прямо с роутера и редактируются без шаблона."
        actions={
          <div className="toolbar">
            <StatusBadge
              status={source === 'live' ? 'online' : 'neutral'}
              label={source === 'live' ? 'прочитано с роутера' : 'последнее состояние'}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void readLive()}
              busy={reading}
              disabled={!online}
            >
              Прочитать
            </Button>
            <Button size="sm" onClick={openCreate} disabled={!online}>
              Добавить правило
            </Button>
          </div>
        }
      >
        {error ? <ErrorBanner message={error} onRetry={() => void readLive()} /> : null}
        {reading ? (
          <div className="job-progress">
            <div className="job-progress-head">
              <span>Обновляем список правил…</span>
              <span className="muted-text small">выполняется…</span>
            </div>
            <ProgressBar value={null} label="Обновляем список правил" />
          </div>
        ) : null}
        {loading && rules.length === 0 ? <Spinner /> : null}

        {!online ? (
          <InfoBanner tone="warn">
            Роутер не в сети. Показано последнее прочитанное состояние; изменения недоступны.
          </InfoBanner>
        ) : null}

        {isPodkop ? (
          <InfoBanner>
            Podkop: изменения проверяются через <strong>sing-box check</strong> и перезапуск
            Podkop. Если конфигурация не проходит проверку, RoutX автоматически откатит
            <code>/etc/config/podkop</code> и вернёт рабочий sing-box.
          </InfoBanner>
        ) : null}

        {source === 'cache' && props.state ? (
          <p className="muted-text small" style={{ marginTop: 0 }}>
            Состояние от {formatRelative(props.state.collected_at)}. Нажмите «Прочитать», чтобы
            загрузить подписки и ссылки прямо с роутера.
          </p>
        ) : null}

        {rules.length > 0 && enabledRules.length === 1 ? (
          <InfoBanner tone="warn">
            В {productLabel} должно оставаться хотя бы одно включённое правило. Последнее включённое
            правило нельзя выключить или оставить без источника подключения — иначе {productLabel} не
            сможет собрать конфигурацию.
          </InfoBanner>
        ) : null}

        {rules.length === 0 && !loading ? (
          <div className="empty-state">
            <Empty>
              Правил пока нет. Добавьте первое правило: вставьте ссылку на подписку или VLESS,
              выберите ресурс (например, YouTube) и действие.
            </Empty>
            <Button onClick={openCreate} disabled={!online}>
              Добавить правило
            </Button>
          </div>
        ) : (
          <div className="rule-list">
            {rules.map((rule) => (
              <RuleCard
                key={rule.section}
                rule={rule}
                services={services}
                productLabel={productLabel}
                isManaged={rule.section === managedSection}
                onEdit={() => openEdit(rule)}
                onDeleteSection={() => requestDeleteSection(rule)}
                onAddConnection={() =>
                  setConnectionTarget({ rule, connection: null })
                }
                onReplace={(connection) =>
                  setConnectionTarget({ rule, connection })
                }
                onDelete={(connection) => requestDelete(rule, connection)}
                onSelectProxy={selectProxy}
                onManageSubscription={
                  isPodkop
                    ? (connection) => setSubscriptionTarget({ rule, connection: connection ?? null })
                    : undefined
                }
                onToggle={() => requestToggle(rule)}
                disabled={!online}
              />
            ))}
          </div>
        )}

        {rules.length > 0 ? (
          <p className="muted-text small">
            Правил: {rules.length} · источников подключения: {totalConnections}. Изменения
            применяются через diff, снимок и автоматический откат при ошибке.
          </p>
        ) : null}
      </Panel>

      {editor ? (
        <RuleEditorModal
          mode={editor.mode}
          rule={editor.rule}
          actions={actions}
          services={services}
          groups={catalog.data?.groups}
          templates={templates.data?.items ?? []}
          routerId={props.routerId}
          product={props.router.product}
          existingSections={rules.map((rule) => rule.section)}
          onClose={() => setEditor(null)}
          onSubmit={submitRule}
        />
      ) : null}

      {diffRequest ? (
        <RuleDiffModal
          routerId={props.routerId}
          request={diffRequest}
          onClose={() => {
            setDiffRequest(null);
            void readLive();
            props.onChanged();
          }}
          onApplied={async () => {
            if (diffRequest.afterApply) await diffRequest.afterApply();
          }}
        />
      ) : null}

      {subscriptionTarget ? (
        <SubscriptionModal
          routerId={props.routerId}
          rule={subscriptionTarget.rule}
          connection={subscriptionTarget.connection}
          onClose={() => setSubscriptionTarget(null)}
          onDone={async () => {
            setSubscriptionTarget(null);
            await readLive();
            props.onChanged();
          }}
        />
      ) : null}

      {connectionTarget ? (
        <ConnectionModal
          routerId={props.routerId}
          product={props.router.product}
          rule={connectionTarget.rule}
          connection={connectionTarget.connection}
          onClose={() => setConnectionTarget(null)}
          onDone={async () => {
            setConnectionTarget(null);
            await readLive();
            props.onChanged();
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          title="Удалить подключение?"
          danger
          busy={deleteBusy}
          confirmLabel="Удалить"
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteJob(null);
          }}
          onConfirm={() => void deleteConnection()}
          message={
            <>
              <p>
                {deleteTarget.connection.kind === 'subscription' ? 'Подписка' : 'Ссылка'}{' '}
                <strong>{deleteTarget.connection.masked}</strong> будет удалена из секции{' '}
                <strong>{deleteTarget.rule.label}</strong>. Перед изменением создаётся снимок.
              </p>
              {deleteBusy || deleteJob ? (
                <JobProgress job={deleteJob} label="Удаляем подключение" />
              ) : null}
            </>
          }
        />
      ) : null}

      {toggleTarget ? (
        <ConfirmDialog
          title={toggleTarget.enabled ? 'Выключить правило?' : 'Включить правило?'}
          busy={false}
          confirmLabel={toggleTarget.enabled ? 'Выключить' : 'Включить'}
          onCancel={() => setToggleTarget(null)}
          onConfirm={() => void toggleRule()}
          message={
            <p>
              Правило <strong>{toggleTarget.label}</strong>{' '}
              {toggleTarget.enabled
                ? 'перестанет действовать. Подключения и списки сохранятся.'
                : 'снова начнёт действовать.'}
            </p>
          }
        />
      ) : null}

      {deleteSectionTarget ? (
        <ConfirmDialog
          title="Удалить пустую секцию?"
          busy={deleteSectionBusy}
          confirmLabel="Удалить"
          onCancel={() => setDeleteSectionTarget(null)}
          onConfirm={() => void deleteSection()}
          message={
            <>
              <p>
                Секция <strong>{deleteSectionTarget.label}</strong> будет удалена с роутера
                вместе с её дочерними объектами. Перед удалением создаётся снимок; при ошибке
                RoutX восстановит конфигурацию.
              </p>
              <p className="muted-text small">
                Удалять можно только выключенные секции без подписок, ссылок и ресурсов.
              </p>
              {deleteSectionJob ? (
                <JobProgress job={deleteSectionJob} label="Удаляем секцию" />
              ) : null}
            </>
          }
        />
      ) : null}
    </div>
  );
}

function RuleCard(props: {
  rule: RuleView;
  services: RoutingService[];
  productLabel: string;
  disabled: boolean;
  isManaged: boolean;
  onEdit: () => void;
  onDeleteSection: () => void;
  onAddConnection: () => void;
  onReplace: (connection: RuleConnectionView) => void;
  onDelete: (connection: RuleConnectionView) => void;
  onSelectProxy?: (section: string, connection: RuleConnectionView) => void;
  onManageSubscription?: (connection?: RuleConnectionView) => void;
  onToggle: () => void;
}) {
  const { rule } = props;
  const serviceById = new Map(props.services.map((item) => [item.id, item]));
  const selected = asStringList(rule.resources.community_lists);
  const selectedGroups = new Map<
    string,
    { id: string; label: string; icon: string; items: string[] }
  >();
  for (const id of selected) {
    const service = serviceById.get(id);
    const groupId = service?.group ?? 'other';
    const entry = selectedGroups.get(groupId) ?? {
      id: groupId,
      label: service?.group_label ?? 'Разное',
      icon: service?.group_icon ?? '•',
      items: [],
    };
    entry.items.push(id);
    selectedGroups.set(groupId, entry);
  }
  const orderedGroups = [...selectedGroups.values()].sort(
    (a, b) =>
      (SERVICE_GROUP_ORDER.indexOf(a.id) + 1 || 999) -
      (SERVICE_GROUP_ORDER.indexOf(b.id) + 1 || 999),
  );
  const canHaveConnections = CONNECTION_ACTIONS.has(rule.action);
  const domains = Array.isArray(rule.resources.domain)
    ? rule.resources.domain.map(String)
    : String(rule.resources.domain ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
  const manualCount = rule.manual_domains.length + rule.manual_ips.length;
  const selectableLinks = rule.links.filter(
    (connection) => connection.selectable && connection.proxy_tag,
  );
  const activeLink = selectableLinks.find((connection) => connection.active);
  const isEmptySection =
    !rule.enabled &&
    Object.keys(rule.resources).length === 0 &&
    rule.subscriptions.length === 0 &&
    rule.links.length === 0 &&
    rule.manual_domains.length === 0 &&
    rule.manual_ips.length === 0;

  return (
    <article className={`rule-card ${rule.enabled ? '' : 'rule-card-off'}`}>
      <header className="rule-head">
        <div>
          <h3>{rule.label}</h3>
          <p className="rule-uci">UCI-секция: {rule.section}</p>
        </div>
        <div className="rule-badges">
          <StatusBadge
            status={
              rule.action === 'connection'
                ? 'online'
                : rule.action === 'block'
                  ? 'offline'
                  : 'warning'
            }
            label={ACTION_SHORT[rule.action] ?? rule.action}
          />
          <StatusBadge
            status={rule.enabled ? 'success' : 'neutral'}
            label={rule.enabled ? 'включено' : 'выключено'}
          />
          {isEmptySection ? <StatusBadge status="neutral" label="пустая" /> : null}
        </div>
      </header>

      {rule.warnings.map((warning) => (
        <InfoBanner key={warning} tone="warn">
          {warning}
        </InfoBanner>
      ))}

      {canHaveConnections && rule.enabled && rule.subscriptions.length + rule.links.length === 0 ? (
        <InfoBanner tone="warn">
          У правила нет источника подключения. Добавьте подписку или VLESS-ссылку, иначе{' '}
          {props.productLabel} не сможет пустить трафик через VPN.
        </InfoBanner>
      ) : null}

      <div className="rule-grid">
        <div>
          <p className="rule-section-title">Ресурсы</p>
          {selected.length === 0 && domains.length === 0 && manualCount === 0 ? (
            <p className="muted-text small">Не выбраны — правило применяется ко всему трафику.</p>
          ) : (
            <div className="resource-groups">
              {orderedGroups.map((group) => (
                <div key={group.id} className="resource-group">
                  <p className="resource-group-title">
                    <span aria-hidden="true">{group.icon}</span> {group.label}
                  </p>
                  <div className="chip-row">
                    {group.items.map((id) => {
                      const service = serviceById.get(id);
                      const icon = SERVICE_ICONS[id] ?? service?.group_icon ?? '•';
                      if (!service) {
                        return (
                          <span key={id} className="chip">
                            <span aria-hidden="true">{icon}</span> {id}
                          </span>
                        );
                      }
                      return (
                        <ServiceTooltip
                          key={id}
                          service={service}
                          className="service-chip-tooltip"
                        >
                          <span className="chip chip-service">
                            <span aria-hidden="true">{icon}</span>
                            {service.label}
                            <ServiceInfoButton service={service} />
                          </span>
                        </ServiceTooltip>
                      );
                    })}
                  </div>
                </div>
              ))}
              {domains.length > 0 || manualCount > 0 ? (
                <div className="resource-group">
                  <p className="resource-group-title">
                    <span aria-hidden="true">✎</span> Свои адреса
                  </p>
                  <div className="chip-row">
                    {domains.map((domain) => (
                      <span key={domain} className="chip chip-muted" title={domain}>
                        {domain.length > 34 ? `${domain.slice(0, 34)}…` : domain}
                      </span>
                    ))}
                    {manualCount > 0 ? (
                      <span className="chip chip-muted">свои адреса: {manualCount}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div>
          <p className="rule-section-title">Подключения</p>
          {selectableLinks.length > 0 ? (
            <Field
              label="Активное подключение"
              hint="Переключение через Clash API, без перезапуска Podkop."
            >
              <Select
                value={activeLink?.proxy_tag ?? ''}
                onChange={(value) => {
                  const connection = selectableLinks.find(
                    (item) => item.proxy_tag === value,
                  );
                  if (connection) props.onSelectProxy?.(rule.section, connection);
                }}
                disabled={props.disabled || !props.onSelectProxy}
              >
                {selectableLinks.map((connection) => (
                  <option key={connection.proxy_tag} value={connection.proxy_tag}>
                    {connection.label}
                    {connection.delay_ms != null
                      ? ` · ${Math.round(connection.delay_ms)} мс`
                      : ''}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {rule.subscriptions.length + rule.links.length === 0 ? (
            <p className="muted-text small">Нет источников.</p>
          ) : (
            <ul className="connection-list">
              {rule.subscriptions.map((connection) => (
                <ConnectionRow
                  key={`sub:${connection.id ?? connection.name}:${connection.masked}`}
                  connection={connection}
                  disabled={props.disabled}
                  onReplace={() => props.onReplace(connection)}
                  onDelete={() => props.onDelete(connection)}
                  onExpand={() => props.onManageSubscription?.(connection)}
                />
              ))}
              {rule.links.map((connection) => (
                <ConnectionRow
                  key={`link:${connection.id ?? connection.hash}:${connection.masked}`}
                  connection={connection}
                  disabled={props.disabled}
                  onReplace={() => props.onReplace(connection)}
                  onDelete={() => props.onDelete(connection)}
                  onSubscribe={
                    connection.synthetic ? () => props.onManageSubscription?.() : undefined
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <footer className="rule-actions">
        <Button size="sm" variant="subtle" onClick={props.onEdit} disabled={props.disabled}>
          Изменить
        </Button>
        {canHaveConnections ? (
          <Button size="sm" variant="ghost" onClick={props.onAddConnection} disabled={props.disabled}>
            Добавить подключение
          </Button>
        ) : null}
        {props.onManageSubscription ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => props.onManageSubscription?.()}
            disabled={props.disabled}
          >
            Подписка
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={props.onToggle} disabled={props.disabled}>
          {rule.enabled ? 'Выключить' : 'Включить'}
        </Button>
        {isEmptySection && !props.isManaged ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={props.onDeleteSection}
            disabled={props.disabled}
          >
            Удалить пустую
          </Button>
        ) : null}
      </footer>
    </article>
  );
}

function ConnectionRow(props: {
  connection: RuleConnectionView;
  disabled: boolean;
  onReplace: () => void;
  onDelete: () => void;
  onExpand?: () => void;
  onSubscribe?: () => void;
}) {
  const { connection } = props;
  return (
    <li>
      <div className="connection-line">
        <span className="connection-kind">
          {connection.kind === 'subscription' ? 'SUB' : 'VPN'}
        </span>
        <code className="connection-value" title={connection.masked}>
          {connection.masked}
        </code>
        <span className="muted-text small">
          {connection.managed ? 'RoutX' : 'вне RoutX'}
          {connection.missing ? ' · нет на роутере' : ''}
          {connection.kind === 'link' && connection.active ? ' · активно' : ''}
          {connection.kind === 'link' && connection.delay_ms != null
            ? ` · ${Math.round(connection.delay_ms)} мс`
            : connection.kind === 'link' && connection.alive === false
              ? ' · не отвечает'
              : ''}
        </span>
      </div>
      <div className="row-actions">
        {props.onSubscribe ? (
          <Button size="sm" variant="ghost" onClick={props.onSubscribe} disabled={props.disabled}>
            Подписка
          </Button>
        ) : null}
        {props.onExpand ? (
          <Button size="sm" variant="ghost" onClick={props.onExpand} disabled={props.disabled}>
            {connection.kind === 'subscription' ? 'Изменить подписку' : 'Разобрать'}
          </Button>
        ) : null}
        {!connection.synthetic && !connection.native ? (
          <>
            <Button size="sm" variant="ghost" onClick={props.onReplace} disabled={props.disabled}>
              Заменить
            </Button>
            <Button size="sm" variant="subtle" onClick={props.onDelete} disabled={props.disabled}>
              Удалить
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}

function RuleEditorModal(props: {
  mode: 'create' | 'edit';
  rule: RuleView | null;
  actions: RoutingAction[];
  services: RoutingService[];
  groups?: RoutingGroup[];
  templates: TemplateListItem[];
  routerId: string;
  product: string;
  existingSections: string[];
  onClose: () => void;
  onSubmit: (body: RuleBody, pending: PendingConnection[]) => void;
}) {
  const toast = useToast();
  const initial = props.rule;
  const isPodkop = props.product === 'podkop';
  const [label, setLabel] = useState(initial?.label ?? '');
  const [action, setAction] = useState(initial?.action ?? 'connection');
  const [connectionType, setConnectionType] = useState(
    String(
      initial?.resources.connection_type ??
        (initial?.action === 'block'
          ? 'block'
          : initial?.action === 'bypass'
            ? 'exclusion'
            : 'proxy'),
    ),
  );
  const [proxyConfigType, setProxyConfigType] = useState(
    String(initial?.resources.proxy_config_type ?? 'url'),
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [selectedServices, setSelectedServices] = useState<string[]>(
    asStringList(initial?.resources.community_lists),
  );
  const [domainText, setDomainText] = useState(asText(initial?.resources.domain));
  const [manualDomains, setManualDomains] = useState((initial?.manual_domains ?? []).join('\n'));
  const [manualIps, setManualIps] = useState((initial?.manual_ips ?? []).join('\n'));
  const [domainListType, setDomainListType] = useState(
    String(
      initial?.resources.user_domain_list_type ??
        ((initial?.manual_domains?.length ?? 0) > 0 ? 'dynamic' : 'disabled'),
    ),
  );
  const [domainTextList, setDomainTextList] = useState(
    String(initial?.resources.user_domains_text ?? ''),
  );
  const [subnetListType, setSubnetListType] = useState(
    String(
      initial?.resources.user_subnet_list_type ??
        ((initial?.manual_ips?.length ?? 0) > 0 ? 'dynamic' : 'disabled'),
    ),
  );
  const [subnetTextList, setSubnetTextList] = useState(
    String(initial?.resources.user_subnets_text ?? ''),
  );
  const [podkopOptions, setPodkopOptions] = useState<Record<string, string | string[] | null>>(
    () => pickPodkopOptions(initial?.resources),
  );
  const [outboundJson, setOutboundJson] = useState('');
  const [ruleSets, setRuleSets] = useState(lines(asText(initial?.resources.rule_set)).join('\n'));
  const [domainLists, setDomainLists] = useState(
    lines(asText(initial?.resources.remote_domain_lists)).join('\n'),
  );
  const [subnetLists, setSubnetLists] = useState(
    lines(asText(initial?.resources.remote_subnet_lists)).join('\n'),
  );
  const [extraResources, setExtraResources] = useState<Record<string, string | string[] | null>>(
    (() => {
      const source = { ...(initial?.resources ?? {}) };
      for (const key of [
        'community_lists',
        'domain',
        'rule_set',
        'remote_domain_lists',
        'remote_subnet_lists',
        'label',
        'action',
        'enabled',
        'domain_ip_lists',
        'domain_suffix',
        'domain_keyword',
        'domain_regex',
      ]) {
        delete source[key];
      }
      return source;
    })(),
  );
  const [templateSettings, setTemplateSettings] = useState<
    Record<string, string | string[] | null>
  >({});
  const [templateId, setTemplateId] = useState('');
  const [templateBusy, setTemplateBusy] = useState(false);
  const [pending, setPending] = useState<PendingConnection[]>([]);
  const [catalog, setCatalog] = useState<CatalogSubscription[]>([]);
  const [catalogId, setCatalogId] = useState('');
  const [connectionLabel, setConnectionLabel] = useState('');
  const [connectionValue, setConnectionValue] = useState('');
  const [vlessValue, setVlessValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canConnect = isPodkop
    ? (connectionType === 'proxy' || connectionType === 'vpn') && proxyConfigType !== 'outbound'
    : CONNECTION_ACTIONS.has(action);
  const existingSources =
    (props.rule?.subscriptions.length ?? 0) + (props.rule?.links.length ?? 0);

  useEffect(() => {
    if (!canConnect) return;
    void api<{ items: CatalogSubscription[] }>('/api/v1/subscriptions')
      .then((response) => setCatalog(response.items))
      .catch(() => undefined);
  }, [canConnect]);

  async function applyTemplate(id: string): Promise<void> {
    setTemplateId(id);
    if (!id) return;
    setTemplateBusy(true);
    setError(null);
    try {
      const response = await api<{ template: TemplateFull }>(`/api/v1/templates/${id}`);
      const preset = response.template.preset;
      if (!preset) {
        throw new Error(response.template.preset_error ?? 'Шаблон не содержит настроек');
      }
      setAction(preset.action);
      if (preset.podkop) {
        if (preset.podkop.connection_type) setConnectionType(preset.podkop.connection_type);
        if (preset.podkop.proxy_config_type) setProxyConfigType(preset.podkop.proxy_config_type);
        if (preset.podkop.user_domain_list_type) {
          setDomainListType(preset.podkop.user_domain_list_type);
        }
        if (preset.podkop.user_domains_text != null) {
          setDomainTextList(preset.podkop.user_domains_text);
        }
        if (preset.podkop.user_subnet_list_type) {
          setSubnetListType(preset.podkop.user_subnet_list_type);
        }
        if (preset.podkop.user_subnets_text != null) {
          setSubnetTextList(preset.podkop.user_subnets_text);
        }
        if (preset.podkop.options) {
          setPodkopOptions((current) => ({ ...current, ...preset.podkop.options }));
        }
      }
      if (Object.prototype.hasOwnProperty.call(preset.resources, 'community_lists')) {
        setSelectedServices(asStringList(preset.resources.community_lists));
      }
      if (Object.prototype.hasOwnProperty.call(preset.resources, 'domain')) {
        setDomainText(asText(preset.resources.domain));
      }
      if (Object.prototype.hasOwnProperty.call(preset.resources, 'rule_set')) {
        setRuleSets(lines(asText(preset.resources.rule_set)).join('\n'));
      }
      if (Object.prototype.hasOwnProperty.call(preset.resources, 'remote_domain_lists')) {
        setDomainLists(lines(asText(preset.resources.remote_domain_lists)).join('\n'));
      }
      if (Object.prototype.hasOwnProperty.call(preset.resources, 'remote_subnet_lists')) {
        setSubnetLists(lines(asText(preset.resources.remote_subnet_lists)).join('\n'));
      }
      if (preset.manual_domains.length > 0) {
        setManualDomains(preset.manual_domains.join('\n'));
      }
      if (preset.manual_ips.length > 0) {
        setManualIps(preset.manual_ips.join('\n'));
      }
      const extra = { ...preset.resources };
      for (const key of [
        'community_lists',
        'domain',
        'rule_set',
        'remote_domain_lists',
        'remote_subnet_lists',
      ]) {
        delete extra[key];
      }
      setExtraResources((current) => ({ ...current, ...extra }));
      setTemplateSettings(preset.settings ?? {});
      toast.success(`Шаблон «${response.template.name}» применён к форме`);
    } catch (caught) {
      fail(errorMessage(caught));
    } finally {
      setTemplateBusy(false);
    }
  }

  function addSubscription(): void {
    if (catalogId) {
      const entry = catalog.find((item) => item.id === catalogId);
      setPending((current) => [
        ...current,
        {
          kind: 'subscription',
          label: connectionLabel.trim() || entry?.name || 'Подписка',
          subscription_id: catalogId,
        },
      ]);
      setCatalogId('');
      setConnectionLabel('');
      return;
    }
    const value = connectionValue.trim();
    if (value === '') {
      fail('Вставьте URL подписки');
      return;
    }
    if (LINK_PREFIX_RE.test(value)) {
      setPending((current) => [
        ...current,
        {
          kind: 'vless',
          label: connectionLabel.trim() || `VLESS ${current.length + 1}`,
          value,
        },
      ]);
      toast.info('Это прямая ссылка — добавлено как VLESS');
      setConnectionValue('');
      setConnectionLabel('');
      return;
    }
    setPending((current) => [
      ...current,
      {
        kind: 'subscription',
        label: connectionLabel.trim() || `Подписка ${current.length + 1}`,
        value,
      },
    ]);
    setConnectionValue('');
    setConnectionLabel('');
  }

  function addLinks(): void {
    const values = lines(vlessValue);
    if (values.length === 0) {
      fail('Вставьте хотя бы одну VLESS-ссылку');
      return;
    }
    setPending((current) => [
      ...current,
      ...values.map((value, index) => ({
        kind: 'vless' as const,
        label: `VLESS ${current.length + index + 1}`,
        value,
      })),
    ]);
    setVlessValue('');
  }

  function fail(message: string): void {
    setError(message);
    toast.error(message);
  }

  function podkopOption(key: string): string {
    return asText(podkopOptions[key]);
  }

  function updatePodkopOption(key: string, value: string): void {
    setPodkopOptions((current) => {
      const next = { ...current };
      if (value === '') delete next[key];
      else next[key] = value;
      return next;
    });
  }

  function togglePodkopOption(key: string, value: boolean): void {
    updatePodkopOption(key, value ? '1' : '0');
  }

  function submit(): void {
    const trimmed = label.trim();
    if (trimmed === '') {
      fail('Укажите название правила');
      return;
    }

    // Если пользователь вставил URL/VLESS и сразу нажал «Проверить и сохранить»,
    // не заставляем его отдельно нажимать «Добавить». Иначе кажется, что
    // сохранение не произошло.
    const effectivePending: PendingConnection[] = [...pending];
    if (canConnect) {
      const keys = new Set(
        effectivePending.map((entry) =>
          entry.subscription_id
            ? `subscription:${entry.subscription_id}`
            : `${entry.kind}:${entry.value ?? ''}`,
        ),
      );
      const pushPending = (entry: PendingConnection) => {
        const key = entry.subscription_id
          ? `subscription:${entry.subscription_id}`
          : `${entry.kind}:${entry.value ?? ''}`;
        if (keys.has(key)) return;
        keys.add(key);
        effectivePending.push(entry);
      };

      if (catalogId) {
        const entry = catalog.find((item) => item.id === catalogId);
        pushPending({
          kind: 'subscription',
          label: connectionLabel.trim() || entry?.name || 'Подписка',
          subscription_id: catalogId,
        });
      } else if (connectionValue.trim() !== '') {
        const value = connectionValue.trim();
        pushPending(
          LINK_PREFIX_RE.test(value)
            ? { kind: 'vless', label: connectionLabel.trim() || 'VLESS', value }
            : { kind: 'subscription', label: connectionLabel.trim() || 'Подписка', value },
        );
      }
      for (const [index, value] of lines(vlessValue).entries()) {
        pushPending({ kind: 'vless', label: `VLESS ${index + 1}`, value });
      }
    }

    if (canConnect && existingSources + effectivePending.length === 0) {
      fail('Для действия «Через VPN» добавьте подписку или VLESS-ссылку');
      return;
    }
    const resources: Record<string, string | string[] | null> = isPodkop
      ? { community_lists: selectedServices }
      : {
          ...extraResources,
          community_lists: selectedServices,
          rule_set: lines(ruleSets),
          remote_domain_lists: lines(domainLists),
          remote_subnet_lists: lines(subnetLists),
          domain: domainText.trim() === '' ? null : domainText,
        };
    const actionForSubmit = isPodkop
      ? connectionType === 'block'
        ? 'block'
        : connectionType === 'exclusion'
          ? 'bypass'
          : 'connection'
      : action;
    let section = props.rule?.section ?? newSectionName(trimmed);
    if (!props.rule) {
      let attempt = 0;
      while (props.existingSections.includes(section) && attempt < 10) {
        section = newSectionName(trimmed);
        attempt += 1;
      }
    }
    props.onSubmit(
      {
        section,
        label: trimmed,
        action: actionForSubmit,
        enabled,
        create: props.mode === 'create',
        resources,
        manual_domains: isPodkop
          ? domainListType === 'dynamic'
            ? lines(manualDomains)
            : []
          : lines(manualDomains),
        manual_ips: isPodkop
          ? subnetListType === 'dynamic'
            ? lines(manualIps)
            : []
          : lines(manualIps),
        settings: isPodkop ? {} : templateSettings,
        connection_type: isPodkop ? (connectionType as RuleBody['connection_type']) : undefined,
        proxy_config_type: isPodkop
          ? (proxyConfigType as RuleBody['proxy_config_type'])
          : undefined,
        user_domain_list_type: isPodkop
          ? (domainListType as RuleBody['user_domain_list_type'])
          : undefined,
        user_domains_text:
          isPodkop && domainListType === 'text' ? domainTextList : undefined,
        user_subnet_list_type: isPodkop
          ? (subnetListType as RuleBody['user_subnet_list_type'])
          : undefined,
        user_subnets_text:
          isPodkop && subnetListType === 'text' ? subnetTextList : undefined,
        outbound_json:
          isPodkop && outboundJson.trim() !== '' ? outboundJson.trim() : undefined,
        podkop_options: isPodkop ? podkopOptions : undefined,
      },
      canConnect ? effectivePending : [],
    );
  }

  return (
    <Modal
      title={props.mode === 'create' ? 'Новое правило' : `Правило «${initial?.label}»`}
      wide
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Отмена
          </Button>
          <Button onClick={submit}>Проверить и сохранить</Button>
        </>
      }
    >
      <p className="page-sub">
        {isPodkop
          ? 'Секция Podkop: тип, домены, списки и подключение. Изменения проверяются и перезапускают sing-box с автоматическим откатом при ошибке.'
          : 'Правило — это секция на роутере. Название видно в панели и в LuCI Prokop. Имя UCI создаётся автоматически и не требует внимания.'}
      </p>
      <p className="muted-text small" style={{ marginTop: -6 }}>
        Сохранение в два шага: сначала «Проверить и сохранить» — откроется список изменений,
        затем «Подтвердить и применить» — запись на роутер.
      </p>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="grid-2">
        <Field label="Название правила" hint="Например: YouTube, Работа, Игры">
          <TextInput value={label} onChange={setLabel} placeholder="YouTube" required />
        </Field>
        {isPodkop ? (
          <Field label="Тип секции Podkop" hint="Куда направлять трафик этой секции">
            <Select value={connectionType} onChange={setConnectionType}>
              <option value="proxy">Прокси</option>
              <option value="vpn">VPN</option>
              <option value="block">Блокировать</option>
              <option value="exclusion">Исключить из маршрутизации</option>
            </Select>
          </Field>
        ) : (
          <Field label="Действие" hint="Что делать с трафиком этой секции">
            <Select value={action} onChange={setAction}>
              {props.actions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      {isPodkop && proxyConfigType === 'outbound' ? (
        <InfoBanner>
          Секция использует готовый JSON outbound. Такой режим задаётся в LuCI; RoutX
          сохраняет его и позволяет менять домены, списки и тип секции, но не подключение.
        </InfoBanner>
      ) : null}

      {isPodkop && canConnect ? (
        <Field
          label="Режим прокси"
          hint="url — одна ссылка, selector — выбор вручную, urltest — автовыбор по задержке"
        >
          <Select value={proxyConfigType} onChange={setProxyConfigType}>
            <option value="url">Одна ссылка (url)</option>
            <option value="selector">Список selector</option>
            <option value="urltest">Список urltest</option>
            {proxyConfigType === 'outbound' ? (
              <option value="outbound">JSON outbound (устарело, выберите selector)</option>
            ) : null}
          </Select>
        </Field>
      ) : null}

      <Field
        label="Заполнить из шаблона"
        hint="Шаблон — это готовый набор действия, ресурсов и настроек. Имя секции в нём не хранится."
      >
        <div className="row">
          <Select value={templateId} onChange={(value) => void applyTemplate(value)}>
            <option value="">Не использовать</option>
            {props.templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} (ред. {template.current_revision})
              </option>
            ))}
          </Select>
          {templateBusy ? <Spinner label="Загружаем шаблон…" /> : null}
        </div>
      </Field>

      <Field label="Ресурсы" hint="Выберите сервисы, чей трафик попадёт в это правило.">
        <ServicePicker
          services={props.services}
          groups={props.groups}
          selected={selectedServices}
          onChange={setSelectedServices}
        />
      </Field>

      {isPodkop ? (
        <>
          <div className="grid-2">
            <Field
              label="Домены: способ задания"
              hint="dynamic — список UCI, text — многострочный текст, disabled — не использовать"
            >
              <Select value={domainListType} onChange={setDomainListType}>
                <option value="disabled">Не использовать</option>
                <option value="dynamic">Список (dynamic)</option>
                <option value="text">Текст (text list)</option>
              </Select>
            </Field>
            <Field
              label="Подсети: способ задания"
              hint="dynamic — список UCI, text — многострочный текст, disabled — не использовать"
            >
              <Select value={subnetListType} onChange={setSubnetListType}>
                <option value="disabled">Не использовать</option>
                <option value="dynamic">Список (dynamic)</option>
                <option value="text">Текст (text list)</option>
              </Select>
            </Field>
          </div>
          {domainListType === 'text' ? (
            <Field
              label="Домены текстом"
              hint="Домены через запятую или по одному на строку. Podkop сохранит это в user_domains_text."
            >
              <textarea
                className="input code-area"
                rows={7}
                value={domainTextList}
                onChange={(event) => setDomainTextList(event.target.value)}
                placeholder={'example.com\nyoutube.com'}
              />
            </Field>
          ) : domainListType === 'dynamic' ? (
            <Field
              label="Домены списком"
              hint="По одному на строку. Podkop сохранит это в user_domains."
            >
              <textarea
                className="input code-area"
                rows={7}
                value={manualDomains}
                onChange={(event) => setManualDomains(event.target.value)}
                placeholder={'example.com\nyoutube.com'}
              />
            </Field>
          ) : null}
          {subnetListType === 'text' ? (
            <Field
              label="Подсети текстом"
              hint="IPv4/IPv6 через запятую или по одному на строку. Podkop сохранит это в user_subnets_text."
            >
              <textarea
                className="input code-area"
                rows={5}
                value={subnetTextList}
                onChange={(event) => setSubnetTextList(event.target.value)}
                placeholder={'203.0.113.10\n2001:db8::/32'}
              />
            </Field>
          ) : subnetListType === 'dynamic' ? (
            <Field
              label="Подсети списком"
              hint="IPv4/IPv6, можно с префиксом. По одному на строку. Podkop сохранит это в user_subnets."
            >
              <textarea
                className="input code-area"
                rows={5}
                value={manualIps}
                onChange={(event) => setManualIps(event.target.value)}
                placeholder={'203.0.113.10\n2001:db8::/32'}
              />
            </Field>
          ) : null}
        </>
      ) : (
        <>
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
          <Field label="Свои IP и подсети" hint="IPv4/IPv6, можно с префиксом. По одному на строку.">
            <textarea
              className="input code-area"
              rows={2}
              value={manualIps}
              onChange={(event) => setManualIps(event.target.value)}
              placeholder={'203.0.113.10\n2001:db8::/32'}
            />
          </Field>
        </>
      )}

      {isPodkop ? (
        <details className="advanced">
          <summary>Podkop: JSON outbound и параметры</summary>
          {proxyConfigType === 'outbound' ? (
            props.mode === 'edit' ? (
              <Field
                label="Новый outbound JSON"
                hint="Текущее значение скрыто. Вставьте объект целиком, чтобы заменить outbound. После сохранения RoutX проверит JSON, выполнит reload и откатит конфиг при ошибке."
              >
                <textarea
                  className="input code-area"
                  rows={8}
                  value={outboundJson}
                  onChange={(event) => setOutboundJson(event.target.value)}
                  placeholder={'{"type":"vless","server":"example.com","server_port":443,"uuid":"…"}'}
                />
              </Field>
            ) : (
              <InfoBanner tone="warn">
                Outbound JSON задаётся после создания секции. Создайте её с обычной ссылкой,
                затем откройте редактирование и замените на JSON.
              </InfoBanner>
            )
          ) : null}

          <div className="settings-grid">
            <Switch
              checked={podkopOption('enable_udp_over_tcp') === '1'}
              onChange={(value) => togglePodkopOption('enable_udp_over_tcp', value)}
              label="UDP over TCP"
            />
            <Switch
              checked={podkopOption('mixed_proxy_enabled') === '1'}
              onChange={(value) => togglePodkopOption('mixed_proxy_enabled', value)}
              label="Mixed proxy"
            />
            <Switch
              checked={podkopOption('domain_resolver_enabled') === '1'}
              onChange={(value) => togglePodkopOption('domain_resolver_enabled', value)}
              label="Domain resolver"
            />
            <Switch
              checked={podkopOption('resolve_real_ip_for_routing') === '1'}
              onChange={(value) => togglePodkopOption('resolve_real_ip_for_routing', value)}
              label="Resolve real IP"
            />
          </div>
          <div className="grid-2">
            <Field label="Интервал urltest" hint="Например 3m или 180s">
              <TextInput
                value={podkopOption('urltest_check_interval')}
                onChange={(value) => updatePodkopOption('urltest_check_interval', value)}
                placeholder="3m"
              />
            </Field>
            <Field label="Допуск urltest, мс">
              <TextInput
                value={podkopOption('urltest_tolerance')}
                onChange={(value) => updatePodkopOption('urltest_tolerance', value)}
                placeholder="50"
              />
            </Field>
            <Field label="URL проверки urltest">
              <TextInput
                value={podkopOption('urltest_testing_url')}
                onChange={(value) => updatePodkopOption('urltest_testing_url', value)}
                placeholder="https://www.gstatic.com/generate_204"
              />
            </Field>
            <Field label="Порт mixed proxy">
              <TextInput
                value={podkopOption('mixed_proxy_port')}
                onChange={(value) => updatePodkopOption('mixed_proxy_port', value)}
                placeholder="2080"
              />
            </Field>
          </div>
        </details>
      ) : null}

      {!isPodkop ? (
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
      ) : null}

      <Switch
        checked={enabled}
        onChange={setEnabled}
        label="Правило включено"
        hint="Выключенное правило сохраняется на роутере, но не действует."
      />

      {canConnect && existingSources === 0 ? (
        <div className="rule-connection-box">
          <h3>Источники подключения</h3>
          <p className="muted-text small">
            {isPodkop
              ? 'Вставьте VLESS/ss/hysteria2-ссылку. Если сразу нажать «Проверить и сохранить», ссылка добавится автоматически. Несколько ссылок требуют режима selector или urltest.'
              : 'Вставьте URL подписки или VLESS-ссылки. Если сразу нажать «Проверить и сохранить», вставленные значения добавятся автоматически. Кнопки ниже нужны, чтобы добавить несколько источников заранее.'}
          </p>

          {!isPodkop ? (
            <Field label="Подписка из каталога" hint="Необязательно, если вставляете URL вручную.">
              <Select value={catalogId} onChange={setCatalogId}>
                <option value="">Не выбирать</option>
                {catalog.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.masked}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <Field label="Название подключения" hint="Необязательно">
            <TextInput
              value={connectionLabel}
              onChange={setConnectionLabel}
              placeholder="Например: основной провайдер"
            />
          </Field>

          <div className="grid-2">
            {!isPodkop ? (
              <Field label="URL подписки">
                <TextInput
                  value={connectionValue}
                  onChange={setConnectionValue}
                  placeholder="https://…"
                />
                <Button size="sm" variant="subtle" onClick={addSubscription}>
                  Добавить подписку
                </Button>
              </Field>
            ) : null}
            <Field label="VLESS-ссылки" hint="По одной на строку.">
              <textarea
                className="input code-area"
                rows={3}
                value={vlessValue}
                onChange={(event) => setVlessValue(event.target.value)}
                placeholder="vless://…"
              />
              <Button size="sm" variant="subtle" onClick={addLinks}>
                Добавить VLESS
              </Button>
            </Field>
          </div>

          {pending.length > 0 ? (
            <ul className="pending-list">
              {pending.map((item, index) => (
                <li key={`${item.kind}:${index}`}>
                  <span className="connection-kind">
                    {item.kind === 'subscription' ? 'SUB' : 'VPN'}
                  </span>
                  <span>{item.label}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setPending((current) => current.filter((entry) => entry !== item))
                    }
                  >
                    Убрать
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {props.mode === 'edit' && !canConnect ? (
        <InfoBanner>
          {isPodkop
            ? 'Подключение доступно только для типа «Прокси» или «VPN». Для блокировки и исключения источник не нужен.'
            : 'Подключения доступны только для действия «Через VPN-подключение». Для обхода, блокировки или DNS-правила источник не нужен.'}
        </InfoBanner>
      ) : null}
    </Modal>
  );
}

function RuleDiffModal(props: {
  routerId: string;
  request: DiffRequest;
  onClose: () => void;
  onApplied: () => Promise<void>;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<
    'starting' | 'waiting' | 'loading' | 'ready' | 'applying' | 'applied' | 'error'
  >('starting');
  const [job, setJob] = useState<Job | null>(null);
  const [run, setRun] = useState<ApplyRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [postApply, setPostApply] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function poll(jobId: string): Promise<void> {
      if (cancelled) return;
      try {
        const response = await api<{ job: Job }>(`/api/v1/jobs/${jobId}`);
        if (cancelled) return;
        setJob(response.job);
        if (response.job.status === 'queued' || response.job.status === 'running') {
          timer = window.setTimeout(() => void poll(jobId), 1500);
          return;
        }
        if (response.job.status !== 'success') {
          setPhase('error');
          setError(response.job.error?.message ?? 'Сравнение не завершилось');
          return;
        }
        const applyRunId =
          typeof response.job.result?.apply_run_id === 'string'
            ? response.job.result.apply_run_id
            : null;
        const rawWarnings = response.job.result?.warnings;
        setWarnings(
          Array.isArray(rawWarnings) ? rawWarnings.map((item) => String(item)) : [],
        );
        if (!applyRunId) {
          setPhase('error');
          setError('Сервер не вернул результат сравнения');
          return;
        }
        setPhase('loading');
        const detail = await api<ApplyRunDetail>(`/api/v1/apply-runs/${applyRunId}`);
        if (cancelled) return;
        setRun(detail);
        setPhase('ready');
      } catch (caught) {
        if (!cancelled) {
          setPhase('error');
          setError(errorMessage(caught));
        }
      }
    }

    (async () => {
      try {
        const response = await api<{ job: Job }>(
          `/api/v1/routers/${props.routerId}/rules/diff`,
          { method: 'POST', body: props.request.body },
        );
        if (cancelled) return;
        setJob(response.job);
        setPhase('waiting');
        void poll(response.job.id);
      } catch (caught) {
        if (!cancelled) {
          setPhase('error');
          setError(errorMessage(caught));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [props.routerId, props.request]);

  async function waitJobWithUpdates(start: Job): Promise<Job> {
    let current = start;
    setJob(current);
    while (current.status === 'queued' || current.status === 'running') {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      current = (await api<{ job: Job }>(`/api/v1/jobs/${current.id}`)).job;
      setJob(current);
    }
    return current;
  }

  async function confirm(): Promise<void> {
    if (!run) return;
    setPhase('applying');
    try {
      const response = await api<{ job: Job }>(
        `/api/v1/apply-runs/${run.apply_run.id}/confirm`,
        {
          method: 'POST',
          body: { diff_hash: run.apply_run.diff_hash },
        },
      );
      setJob(response.job);
      const applied = await waitJobWithUpdates(response.job);
      if (applied.status !== 'success') {
        setPhase('error');
        setError(applied.error?.message ?? 'Применение не удалось');
        return;
      }
      toast.success('Правило применено');
      setPostApply(true);
      await props.onApplied();
      setPostApply(false);
      setPhase('applied');
      props.onClose();
    } catch (caught) {
      setPostApply(false);
      setPhase('ready');
      toast.error(errorMessage(caught));
    }
  }

  const items =
    run?.items.map((item) => ({
      op: item.op as 'add' | 'change' | 'delete',
      path: item.path,
      before: item.value_before as string | string[] | null,
      after: item.value_after as string | string[] | null,
    })) ?? [];
  const noChanges = run ? items.length === 0 : false;
  const canConfirm = run?.apply_run.status === 'awaiting_confirmation';

  return (
    <Modal
      title={props.request.title}
      wide
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={phase === 'applying'}>
            Закрыть
          </Button>
          <Button
            onClick={() => void confirm()}
            busy={phase === 'applying'}
            disabled={!canConfirm || noChanges || phase !== 'ready'}
          >
            {noChanges ? 'Изменений нет' : 'Подтвердить и применить'}
          </Button>
        </>
      }
    >
      {phase === 'starting' || phase === 'waiting' || phase === 'loading' ? (
        <JobProgress
          job={job}
          label={
            phase === 'loading'
              ? 'Загружаем различия…'
              : 'Читаем состояние роутера и строим diff…'
          }
        />
      ) : null}

      {phase === 'applying' ? (
        <JobProgress job={job} label="Применяем изменения на роутере" />
      ) : null}

      {postApply ? (
        <div className="job-progress">
          <div className="job-progress-head">
            <span>Добавляем подключения…</span>
            <span className="muted-text small">выполняется…</span>
          </div>
          <ProgressBar value={null} label="Добавляем подключения" />
        </div>
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}
      {warnings.map((warning) => (
        <InfoBanner key={warning} tone="warn">
          {warning}
        </InfoBanner>
      ))}

      {run ? (
        <>
          <div className="diff-head">
            <span className="muted-text">
              Статус: {APPLY_STATUS[run.apply_run.status] ?? run.apply_run.status} · хеш{' '}
              <code>{run.apply_run.diff_hash.slice(0, 12)}…</code>
            </span>
          </div>
          {props.request.bootstrap ? (
            <InfoBanner>
              Правило применяется выключенным: Prokop не принимает секцию «через VPN» без источника
              подключения. Сразу после применения будут добавлены подключения, и правило{' '}
              {props.request.finalEnabled ? 'включится автоматически' : 'останется выключенным'}.
            </InfoBanner>
          ) : null}
          {noChanges ? (
            <InfoBanner>Конфигурация уже соответствует — применение не требуется.</InfoBanner>
          ) : (
            <InfoBanner tone="warn">
              Проверьте изменения. Списки заменяются полностью; удаление помечено отдельно. Перед
              записью создаётся снимок, при ошибке выполняется откат.
            </InfoBanner>
          )}
          <DiffView items={items} />
          {job ? (
            <p className="muted-text small">
              Задача {job.id.slice(0, 8)} · создана {formatRelative(job.created_at)}
            </p>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}

function SubscriptionModal(props: {
  routerId: string;
  rule: RuleView;
  connection?: RuleConnectionView | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const source = props.connection ?? null;
  const [catalog, setCatalog] = useState<CatalogSubscription[]>([]);
  const [catalogId, setCatalogId] = useState('');
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'add' | 'replace'>('replace');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ items: CatalogSubscription[] }>('/api/v1/subscriptions')
      .then((response) => setCatalog(response.items))
      .catch(() => undefined);
  }, []);

  async function submit(useExisting = false): Promise<void> {
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      if (!useExisting && !catalogId && url.trim() === '') {
        throw new Error('Выберите подписку из каталога или вставьте URL');
      }
      const response = await api<{
        imported: number;
        total: number;
        skipped: number;
        job: Job;
      }>(`/api/v1/routers/${props.routerId}/podkop/subscription`, {
        method: 'POST',
        body: {
          section: props.rule.section,
          mode,
          ...(useExisting
            ? { connection_id: source?.id }
            : catalogId
              ? { subscription_id: catalogId }
              : { url: url.trim() }),
        },
      });
      setJob(response.job);
      const done = await waitForJob(response.job, 600_000);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'Не удалось применить подписку');
      }
      toast.success(
        `Подписка разобрана: ${response.imported} подключений` +
          (response.skipped > 0 ? `, пропущено: ${response.skipped}` : ''),
      );
      await props.onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Подписка для «${props.rule.label}»`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Отмена
          </Button>
          {source?.id ? (
            <Button variant="subtle" onClick={() => void submit(true)} busy={busy}>
              Обновить текущую
            </Button>
          ) : null}
          <Button onClick={() => void submit(false)} busy={busy}>
            {mode === 'replace' ? 'Заменить ссылки' : 'Добавить ссылки'}
          </Button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      <p className="page-sub">
        Podkop не поддерживает подписки. RoutX скачает её и сохранит ссылки как отдельные
        подключения секции «{props.rule.section}».
      </p>
      {source ? (
        <InfoBanner tone="info">
          Текущая подписка: «{source.label}». «Обновить текущую» перечитает её по сохранённой
          ссылке. Чтобы сменить адрес, выберите каталог или вставьте новый URL.
        </InfoBanner>
      ) : null}
      <Field label="Режим">
        <Select value={mode} onChange={(value) => setMode(value as 'add' | 'replace')}>
          <option value="add">Добавить к текущим подключениям</option>
          <option value="replace">Заменить все подключения секции</option>
        </Select>
      </Field>
      <Field label="Подписка из каталога" hint="Необязательно, если вставляете URL вручную.">
        <Select value={catalogId} onChange={setCatalogId}>
          <option value="">Не выбирать</option>
          {catalog.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.masked}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="URL подписки">
        <TextInput value={url} onChange={setUrl} placeholder="https://…" />
      </Field>
      {mode === 'replace' ? (
        <InfoBanner tone="warn">
          Текущие ссылки секции будут заменены ссылками из подписки. Источник подписки
          сохранится, чтобы её можно было обновить позже.
        </InfoBanner>
      ) : null}
      {job ? <JobProgress job={job} label="Разбираем подписку" /> : null}
    </Modal>
  );
}

function ConnectionModal(props: {
  routerId: string;
  product: string;
  rule: RuleView;
  connection: RuleConnectionView | null;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const editing = props.connection;
  const isPodkop = props.product === 'podkop';
  const [kind, setKind] = useState<'subscription' | 'vless'>(
    isPodkop ? 'vless' : editing?.kind === 'link' ? 'vless' : 'subscription',
  );
  const [label, setLabel] = useState(editing?.label ?? '');
  const [value, setValue] = useState('');
  const [catalogId, setCatalogId] = useState('');
  const [importCatalogId, setImportCatalogId] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [catalog, setCatalog] = useState<CatalogSubscription[]>([]);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isPodkop && kind !== 'subscription') return;
    void api<{ items: CatalogSubscription[] }>('/api/v1/subscriptions')
      .then((response) => setCatalog(response.items))
      .catch(() => undefined);
  }, [editing, kind, isPodkop]);

  async function waitWithProgress(start: Job): Promise<Job> {
    let current = start;
    setJob(current);
    while (current.status === 'queued' || current.status === 'running') {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      current = (await api<{ job: Job }>(`/api/v1/jobs/${current.id}`)).job;
      setJob(current);
    }
    return current;
  }

  async function importSubscription(): Promise<void> {
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      if (!importCatalogId && importUrl.trim() === '') {
        throw new Error('Выберите подписку из каталога или вставьте URL');
      }
      const response = await api<{
        imported: number;
        total: number;
        skipped: number;
        job: Job | null;
      }>(`/api/v1/routers/${props.routerId}/podkop/import-subscription`, {
        method: 'POST',
        body: {
          section: props.rule.section,
          ...(importCatalogId
            ? { subscription_id: importCatalogId }
            : { url: importUrl.trim() }),
        },
      });
      if (response.job) {
        const finished = await waitWithProgress(response.job);
        if (finished.status !== 'success') {
          throw new Error(finished.error?.message ?? 'Не удалось применить импортированные ссылки');
        }
      }
      if (response.imported === 0) {
        toast.info('Новых ссылок в подписке не найдено');
      } else {
        toast.success(
          `Импортировано ссылок: ${response.imported}` +
            (response.skipped > 0 ? `, пропущено: ${response.skipped}` : ''),
        );
      }
      await props.onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      if (editing) {
        if (!catalogId && value.trim() === '') {
          throw new Error('Выберите подписку из сохранённых или вставьте новую ссылку');
        }
        if (editing.managed && editing.id) {
          const response = await api<{ job: Job }>(
            `/api/v1/routers/${props.routerId}/connections/${editing.id}`,
            {
              method: 'PATCH',
              body: {
                label: label.trim() || editing.label,
                ...(catalogId ? { subscription_id: catalogId } : { value: value.trim() }),
              },
            },
          );
          const job = await waitWithProgress(response.job);
          if (job.status !== 'success') throw new Error(job.error?.message ?? 'Не удалось заменить');
        } else {
          const response = await api<{ job: Job }>(
            `/api/v1/routers/${props.routerId}/connections/manage`,
            {
              method: 'POST',
              body: {
                action: 'replace',
                kind: editing.kind === 'subscription' ? 'subscription' : 'link',
                name: editing.name ?? undefined,
                hash: editing.hash ?? undefined,
                section: props.rule.section,
                ...(catalogId ? { subscription_id: catalogId } : { value: value.trim() }),
              },
            },
          );
          const job = await waitWithProgress(response.job);
          if (job.status !== 'success') throw new Error(job.error?.message ?? 'Не удалось заменить');
        }
        toast.success('Подключение заменено');
      } else {
        const body: Record<string, unknown> = {
          kind,
          label: label.trim() || (kind === 'subscription' ? 'Подписка' : 'VLESS'),
          section: props.rule.section,
        };
        if (kind === 'subscription' && catalogId) body.subscription_id = catalogId;
        else body.value = value.trim();
        const response = await api<{ job: Job }>(
          `/api/v1/routers/${props.routerId}/connections`,
          { method: 'POST', body },
        );
        const job = await waitWithProgress(response.job);
        if (job.status !== 'success') throw new Error(job.error?.message ?? 'Не удалось добавить');
        toast.success('Подключение добавлено');
      }
      await props.onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={
        editing
          ? `Заменить ${editing.kind === 'subscription' ? 'подписку' : 'ссылку'}`
          : `Добавить подключение в «${props.rule.label}»`
      }
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} busy={busy}>
            {editing ? 'Заменить' : 'Добавить'}
          </Button>
        </>
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      {busy || job ? <JobProgress job={job} label="Применяем подключение" /> : null}

      {isPodkop && !editing ? (
        <div className="rule-connection-box">
          <h3>Импорт подписки</h3>
          <p className="muted-text small">
            Podkop не поддерживает подписки. RoutX скачает подписку, разберёт её на отдельные
            vless/ss/trojan/hysteria2/socks-ссылки и добавит их в секцию «{props.rule.label}».
          </p>
          <Field label="Подписка из каталога" hint="Необязательно, если вставляете URL вручную.">
            <Select value={importCatalogId} onChange={setImportCatalogId}>
              <option value="">Не выбирать</option>
              {catalog.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.masked}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="URL подписки">
            <TextInput
              value={importUrl}
              onChange={setImportUrl}
              placeholder="https://…"
            />
          </Field>
          <Button onClick={() => void importSubscription()} disabled={busy}>
            Импортировать ссылки
          </Button>
        </div>
      ) : null}
      {!editing && !isPodkop ? (
        <Field label="Тип">
          <Select value={kind} onChange={(next) => setKind(next as 'subscription' | 'vless')}>
            <option value="subscription">Подписка (URL)</option>
            <option value="vless">VLESS / прямая ссылка</option>
          </Select>
        </Field>
      ) : null}
      <Field label="Название">
        <TextInput
          value={label}
          onChange={setLabel}
          placeholder={kind === 'subscription' ? 'Подписка' : 'VLESS'}
        />
      </Field>
      {kind === 'subscription' && !isPodkop ? (
        <Field
          label={editing ? 'Подписка из сохранённых' : 'Подписка из каталога'}
          hint="Или вставьте URL ниже."
        >
          <Select value={catalogId} onChange={setCatalogId}>
            <option value="">Не выбирать</option>
            {catalog.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.masked}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field
        label={editing ? 'Новая ссылка' : kind === 'subscription' ? 'URL подписки' : 'VLESS-ссылка'}
        hint={
          editing
            ? 'Текущее значение показано маской. Выберите сохранённую подписку выше или вставьте новую ссылку.'
            : kind === 'subscription'
              ? 'https://…'
              : 'vless://…, vmess://…, trojan://…, ss://…, hysteria2://…'
        }
      >
        <TextInput
          value={value}
          onChange={setValue}
          placeholder={kind === 'subscription' ? 'https://…' : 'vless://…'}
          disabled={Boolean(kind === 'subscription' && catalogId)}
        />
      </Field>
    </Modal>
  );
}
