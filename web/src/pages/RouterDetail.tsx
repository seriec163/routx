import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '../components/link';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBanner,
  Field,
  InfoBanner,
  JobProgress,
  Modal,
  PageHeader,
  Panel,
  Select,
  Spinner,
  Stat,
  StatusBadge,
  Tabs,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { copyText } from '../lib/clipboard';
import {
  formatDate,
  formatRelative,
  PRODUCT_LABEL,
  proxyHealth,
  ROUTER_STATUS,
  statusTone,
} from '../lib/format';
import { navigate } from '../lib/router';
import { RouterRulesPanel } from './RouterRules';
import { CompactSecretForm } from './router-detail/CompactSecretForm';
import { CredentialPanel } from './router-detail/CredentialPanel';
import { DiffFlowModal } from './router-detail/DiffFlowModal';
import { DnsTab } from './router-detail/DnsTab';
import { DiagnosticsTab } from './router-detail/DiagnosticsTab';
import { JobsTab } from './router-detail/JobsTab';
import { MetricsTab } from './router-detail/MetricsTab';
import { OverviewTab } from './router-detail/OverviewTab';
import { TACHYON_COMPONENTS, versionAtLeast, type TachyonComponentInfo } from './router-detail/tachyon';
import { UpdatesTab } from './router-detail/UpdatesTab';
import { SnapshotsTab } from './router-detail/SnapshotsTab';
import { SingBoxTab } from './router-detail/SingBoxTab';
import type {
  BindingToken,
  CatalogSubscription,
  ConnectionsResponse,
  DiagnosticReportSummary,
  DnsBenchmarkState,
  DnsCandidateResult,
  DnsStatus,
  ExternalConnections,
  Job,
  MetricSample,
  MetricsResponse,
  RouterDetail,
  RouterConnection,
  RouterListExtras,
  RouterSnapshot,
  RotateCredential,
  SingBoxVariant,
  SingBoxVersion,
  TemplateAssignment,
  TemplateListItem,
  TemplateRevision,
} from '../lib/types';
import { useApi } from '../lib/useApi';
import { useSession } from '../session';

type TabId =
  | 'overview'
  | 'updates'
  | 'dns'
  | 'connections'
  | 'lists'
  | 'templates'
  | 'snapshots'
  | 'metrics'
  | 'diagnostics'
  | 'singbox'
  | 'jobs'
  | 'settings';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Обзор' },
  { id: 'updates', label: 'Обновления' },
  { id: 'dns', label: 'DNS' },
  { id: 'connections', label: 'Правила и подключения' },
  { id: 'snapshots', label: 'Снимки' },
  { id: 'metrics', label: 'Метрики' },
  { id: 'diagnostics', label: 'Диагностика' },
  { id: 'singbox', label: 'sing-box' },
  { id: 'jobs', label: 'Задачи' },
  { id: 'settings', label: 'Настройки' },
];

const CONNECTION_ACTIONS = new Set(['connection', 'proxy', 'outbound', 'vpn']);

const SING_BOX_VARIANT_IDS = new Set(['tiny', 'extended', 'extended_compressed', 'stable']);

function normalizeSingBoxVariant(value: string | null | undefined): string {
  if (value === 'extended-compressed') return 'extended_compressed';
  return value && SING_BOX_VARIANT_IDS.has(value) ? value : '';
}

function serviceText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.status === 'string') return record.status;
    for (const key of ['prokop', 'forkop', 'podkop', 'tachyon']) {
      const child = record[key];
      if (child && typeof child === 'object' && typeof (child as { status?: unknown }).status === 'string') {
        return `${key}: ${String((child as { status: string }).status)}`;
      }
    }
  }
  return '—';
}

interface ProductCatalogItem {
  product: 'tachyon' | 'forkop' | 'podkop' | 'prokop';
  label: string;
  repo: string;
  current_version: string | null;
  latest_version: string | null;
  update_available: boolean;
  releases: Array<{
    version: string;
    tag: string;
    name: string;
    published_at: string | null;
    prerelease: boolean;
  }>;
  error: string | null;
}

interface ProductServiceInfo {
  present: boolean;
  running: boolean | null;
  enabled: boolean | null;
  status: string | null;
}

interface WifiRadio {
  name: string;
  type?: string;
  path?: string;
  band?: string;
  channel?: string;
  htmode?: string;
  country?: string;
  txpower?: string;
  disabled: boolean;
}

interface WifiInterface {
  name: string;
  device: string;
  mode: string;
  network: string;
  ssid: string;
  encryption: string;
  key_set: boolean;
  hidden: boolean;
  disabled: boolean;
  isolate: boolean;
  ifname?: string;
  wds?: boolean;
}

interface WifiState {
  radios: WifiRadio[];
  interfaces: WifiInterface[];
  hardware?: {
    present: boolean;
    phys?: string[];
    interfaces?: string[];
    configured_radios?: string[];
  };
}

const WIFI_KEY_ENCRYPTIONS = new Set([
  'psk',
  'psk2',
  'psk-mixed',
  'sae',
  'sae-mixed',
]);

function wifiEncryptionLabel(value: string): string {
  switch (value) {
    case 'none':
      return 'без пароля';
    case 'psk':
      return 'WPA-PSK';
    case 'psk2':
      return 'WPA2-PSK';
    case 'psk-mixed':
      return 'WPA/WPA2 mixed';
    case 'sae':
      return 'WPA3-SAE';
    case 'sae-mixed':
      return 'WPA2/WPA3 mixed';
    default:
      return value || 'не задано';
  }
}

function flagValue(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

function asDnsBenchmarkState(value: unknown): DnsBenchmarkState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Partial<DnsBenchmarkState>;
  if (!Array.isArray(state.results) || !Array.isArray(state.domains)) return null;
  if (!state.recommendations || typeof state.recommendations !== 'object') return null;
  return state as DnsBenchmarkState;
}

function productService(value: unknown, product: string): ProductServiceInfo {
  const empty: ProductServiceInfo = {
    present: false,
    running: null,
    enabled: null,
    status: null,
  };
  if (!value || typeof value !== 'object') return empty;
  const record = value as Record<string, unknown>;
  const child = record[product];
  if (!child || typeof child !== 'object') return empty;
  const service = child as Record<string, unknown>;
  return {
    present: true,
    running: flagValue(service.running),
    enabled: flagValue(service.enabled),
    status: typeof service.status === 'string' ? service.status : null,
  };
}

function healthText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const overall = (value as { overall?: unknown }).overall;
    if (typeof overall === 'string') return overall;
  }
  return '—';
}

export function RouterDetailPage({ id }: { id: string }) {
  const toast = useToast();
  const { me } = useSession();
  const isAdmin = me?.permissions.can_manage_routers === true;
  const isSuperadmin = me?.permissions.is_superadmin === true;
  const [tab, setTab] = useState<TabId>('overview');
  const [selectedVariantId, setSelectedVariantId] = useState('');

  const detail = useApi<RouterDetail>(`/api/v1/routers/${id}`);
  const snapshots = useApi<{ items: RouterSnapshot[] }>(`/api/v1/routers/${id}/snapshots`);
  const jobs = useApi<{ items: Job[] }>(`/api/v1/routers/${id}/jobs`);
  const templates = useApi<{ items: TemplateListItem[] }>(null);
  const diagnostics = useApi<{ items: DiagnosticReportSummary[] }>(
    tab === 'diagnostics' ? `/api/v1/diagnostics?router_id=${id}` : null,
  );
  const versionsNeeded =
    selectedVariantId === 'extended' || selectedVariantId === 'extended_compressed';
  const versions = useApi<{ items: SingBoxVersion[] }>(
    tab === 'singbox' && versionsNeeded
      ? '/api/v1/singbox/versions?product=sing-box-extended&stable_only=true'
      : null,
  );
  const variants = useApi<{ items: SingBoxVariant[] }>(
    tab === 'singbox' ? '/api/v1/singbox/variants' : null,
  );
  const dnsStatus = useApi<DnsStatus>(tab === 'dns' ? `/api/v1/routers/${id}/dns` : null);
  const dnsLatest = useApi<{ latest: Job | null; active: Job | null }>(
    tab === 'dns' ? `/api/v1/routers/${id}/dns/benchmark/latest` : null,
  );
  const [hours, setHours] = useState(24);
  const metrics = useApi<MetricsResponse>(
    tab === 'metrics' ? `/api/v1/routers/${id}/metrics?hours=${hours}&granularity=raw` : null,
  );
  const connectionLosses = useApi<ConnectionsResponse>(
    tab === 'metrics' ? `/api/v1/routers/${id}/connection-losses?hours=${hours}` : null,
  );

  const [diffFlow, setDiffFlow] = useState<{ templateId: string; revision: number; name: string } | null>(null);
  const [restoring, setRestoring] = useState<RouterSnapshot | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [serviceBusy, setServiceBusy] = useState<string | null>(null);
  const [binding, setBinding] = useState<BindingToken | null>(null);
  const [credential, setCredential] = useState<RotateCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [activeJobLabel, setActiveJobLabel] = useState('');
  const [productSwitchBusy, setProductSwitchBusy] = useState(false);
  const [productOpen, setProductOpen] = useState(false);
  const [productItems, setProductItems] = useState<ProductCatalogItem[]>([]);
  const [productVersions, setProductVersions] = useState<Record<string, string>>({});
  const [productError, setProductError] = useState<string | null>(null);
  const [productJob, setProductJob] = useState<Job | null>(null);
  const [productLoading, setProductLoading] = useState(false);
  const [removePackagesSelected, setRemovePackagesSelected] = useState<string[]>([]);
  const [removePackagesBusy, setRemovePackagesBusy] = useState(false);
  const [productNotice, setProductNotice] = useState<string | null>(null);
  const [restoreRouterBusy, setRestoreRouterBusy] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeName, setPurgeName] = useState('');
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [installVersion, setInstallVersion] = useState<SingBoxVersion | null>(null);
  const [installVariant, setInstallVariant] = useState<SingBoxVariant | null>(null);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [assignTemplateId, setAssignTemplateId] = useState('');
  const [stateQuery, setStateQuery] = useState('');
  const [mappingAssignment, setMappingAssignment] = useState<TemplateAssignment | null>(null);
  const [mappingSources, setMappingSources] = useState<string[]>([]);
  const [mappingTargets, setMappingTargets] = useState<Record<string, string>>({});
  const [mappingBusy, setMappingBusy] = useState(false);
  const [dnsBenchmark, setDnsBenchmark] = useState<DnsBenchmarkState | null>(null);
  const [dnsJob, setDnsJob] = useState<Job | null>(null);
  const [dnsBusy, setDnsBusy] = useState(false);
  const [dnsError, setDnsError] = useState<string | null>(null);
  const [dnsChoice, setDnsChoice] = useState<{
    type: 'udp' | 'doh';
    servers: string[];
  } | null>(null);
  const [dnsApplyOpen, setDnsApplyOpen] = useState(false);
  const [componentResults, setComponentResults] = useState<TachyonComponentInfo[]>([]);
  const [componentErrors, setComponentErrors] = useState<
    Array<{ component: string; message: string }>
  >([]);
  const [componentCheckedAt, setComponentCheckedAt] = useState<Date | null>(null);
  const [componentCheckBusy, setComponentCheckBusy] = useState(false);
  const [componentUpdating, setComponentUpdating] = useState<string | null>(null);
  const [componentJob, setComponentJob] = useState<Job | null>(null);
  const [componentLog, setComponentLog] = useState('');
  const componentCheckStarted = useRef(false);
  const [wifi, setWifi] = useState<WifiState | null>(null);
  const [wifiError, setWifiError] = useState<string | null>(null);
  const [wifiBusy, setWifiBusy] = useState(false);
  const [wifiEdit, setWifiEdit] = useState<WifiInterface | null>(null);
  const [wifiForm, setWifiForm] = useState({
    ssid: '',
    encryption: 'none',
    key: '',
    hidden: false,
    disabled: false,
    isolate: false,
  });
  const [wifiSaveBusy, setWifiSaveBusy] = useState(false);
  const wifiAutoLoaded = useRef(false);
  const [wifiCreateOpen, setWifiCreateOpen] = useState(false);
  const [wifiCreateForm, setWifiCreateForm] = useState({
    ssid: '',
    encryption: 'psk2',
    key: '',
    hidden: false,
    disabled: false,
    isolate: false,
    radios: [] as string[],
  });
  const [wifiCreateBusy, setWifiCreateBusy] = useState(false);
  const [wifiDelete, setWifiDelete] = useState<WifiInterface | null>(null);
  const [wifiDeleteBusy, setWifiDeleteBusy] = useState(false);

  const connections = useApi<{ managed_section: string; items: RouterConnection[] }>(
    tab === 'connections' ? `/api/v1/routers/${id}/connections` : null,
  );
  const extras = useApi<{ managed_section: string; extras: Record<string, RouterListExtras> }>(
    tab === 'lists' ? `/api/v1/routers/${id}/list-extras` : null,
  );
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionKind, setConnectionKind] = useState<'subscription' | 'vless'>('subscription');
  const [connectionLabel, setConnectionLabel] = useState('');
  const [connectionValue, setConnectionValue] = useState('');
  const [connectionCatalogId, setConnectionCatalogId] = useState('');
  const [connectionCompactOpen, setConnectionCompactOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<RouterConnection | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editValue, setEditValue] = useState('');
  const [editCompactOpen, setEditCompactOpen] = useState(false);
  const [copyingSecretId, setCopyingSecretId] = useState<string | null>(null);
  const catalog = useApi<{ items: CatalogSubscription[] }>(
    connectionOpen && connectionKind === 'subscription' ? '/api/v1/subscriptions' : null,
  );
  const [deletingConnection, setDeletingConnection] = useState<RouterConnection | null>(null);
  const [externalConnections, setExternalConnections] = useState<ExternalConnections | null>(null);
  const [externalBusy, setExternalBusy] = useState(false);
  const [externalError, setExternalError] = useState<string | null>(null);
  const [manageTarget, setManageTarget] = useState<{
    action: 'delete' | 'replace';
    kind: 'subscription' | 'link';
    name?: string;
    hash?: string;
    label: string;
  } | null>(null);
  const [manageValue, setManageValue] = useState('');
  const [manageBusy, setManageBusy] = useState(false);
  const [extraSection, setExtraSection] = useState('');
  const [extraRuleSet, setExtraRuleSet] = useState('');
  const [extraDomainLists, setExtraDomainLists] = useState('');
  const [extraSubnetLists, setExtraSubnetLists] = useState('');
  const [extraDomains, setExtraDomains] = useState('');
  const [extraIps, setExtraIps] = useState('');
  const [extrasBusy, setExtrasBusy] = useState(false);

  const router = detail.data?.router;
  const installedProducts = router?.installed_products ?? [];
  const state = detail.data?.state;
  const assignments = detail.data?.assignments ?? [];
  const online = router?.status === 'online';
  const canMutate = router?.status === 'online';
  const canSwitchProduct = router?.status === 'online' || router?.status === 'conflict';

  // При открытии вкладки выбираем установленный вариант; дальше выбор
  // принадлежит пользователю и не сбрасывается при обновлении состояния.
  useEffect(() => {
    if (!router) return;
    setSelectedVariantId((current) => {
      if (current) return current;
      const installed = normalizeSingBoxVariant(router.sing_box_variant);
      return installed || 'extended';
    });
  }, [router?.sing_box_variant]);

  // При первом открытии вкладки «Обновления» сразу проверяем компоненты Tachyon.
  useEffect(() => {
    if (tab !== 'updates' || componentCheckStarted.current) return;
    if (!online) return;
    if (router?.product !== 'tachyon') return;
    if (!versionAtLeast(router?.agent_version, '1.5.47')) return;
    componentCheckStarted.current = true;
    void runComponentCheck();
  }, [tab, online, router?.product, router?.agent_version]);

  // При открытии настроек сразу читаем Wi-Fi, чтобы показать существующие сети.
  useEffect(() => {
    if (tab !== 'settings' || wifiAutoLoaded.current || !online) return;
    wifiAutoLoaded.current = true;
    void readWifi();
  }, [tab, online]);

  const routerSectionNames = useMemo(() => {
    const names = new Set<string>();
    for (const path of Object.keys(state?.managed ?? {})) {
      const match = /^section\.([A-Za-z0-9_.-]{1,64})\./.exec(path);
      if (match) names.add(match[1]!);
    }
    return [...names].sort();
  }, [state]);

  const productSvc = useMemo(
    () => productService(state?.service, router?.product ?? 'unknown'),
    [state, router?.product],
  );
  const singBoxSvc = useMemo(() => productService(state?.service, 'sing_box'), [state]);
  const productLabel = PRODUCT_LABEL[router?.product ?? ''] ?? 'Prokop/Forkop/Podkop';
  // Prokop/Forkop сами запускают sing-box и при каждом старте отключают его
  // отдельный автозапуск. Поэтому автозапуск пары — это автозапуск продукта.
  const autostartEnabled = productSvc.enabled === true;
  const autostartPartial =
    productSvc.enabled !== true && singBoxSvc.present && singBoxSvc.enabled === true;
  const singBoxAutostartLabel = !singBoxSvc.present
    ? 'нет данных'
    : productSvc.enabled
      ? `через ${productLabel}`
      : singBoxSvc.enabled === null
        ? 'неизвестно'
        : singBoxSvc.enabled
          ? 'включён отдельно'
          : 'выключен';

  useEffect(() => {
    if (tab !== 'dns' || !dnsLatest.data) return;
    const active = dnsLatest.data.active;
    if (active && dnsJob?.id !== active.id) {
      setDnsJob(active);
      void pollDnsJob(active.id);
      return;
    }
    const latest = dnsLatest.data.latest;
    if (!active && latest && (!dnsJob || dnsJob.status === 'success') && dnsJob?.id !== latest.id) {
      setDnsJob(latest);
      setDnsBenchmark(asDnsBenchmarkState(latest.result));
    }
  }, [tab, dnsLatest.data, dnsJob]);

  const managedEntries = useMemo(() => {
    const entries = Object.entries(state?.managed ?? {});
    const needle = stateQuery.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(([path]) => path.toLowerCase().includes(needle));
  }, [state, stateQuery]);

  // На роутере есть только физические секции. Логическое имя router_control
  // хранится в routers.managed_section и не должно показываться как отдельная
  // секция: иначе в интерфейсе появляются «router_control» и «gga» одновременно.
  const sectionNames = routerSectionNames;
  const managedSectionName =
    connections.data?.managed_section ?? router?.managed_section ?? routerSectionNames[0] ?? '';
  const sectionLabel = (name: string): string => {
    const raw = state?.managed?.[`section.${name}.label`];
    const label = typeof raw === 'string' ? raw.trim() : '';
    return label || name;
  };
  // В Prokop пользователь видит label секции, а не физическое имя UCI.
  // Панель должна показывать то же самое; физическое имя — только в подсказке.
  const sectionDisplay = (name: string): string => sectionLabel(name);
  const sectionTitle = (name: string): string | undefined => {
    const label = sectionLabel(name);
    return label !== name ? `UCI-секция: ${name}` : undefined;
  };
  const sectionSubscriptionPaths = Object.entries(state?.managed ?? {}).filter(
    ([path, value]) =>
      /^(?:subscription_url|outbound_source)\.[A-Za-z0-9_.-]{1,64}\.section$/.test(path) &&
      value === managedSectionName,
  );
  const managedSubscriptionsOnRouter = sectionSubscriptionPaths.filter(([path]) =>
    /^(?:subscription_url|outbound_source)\.rc_sub_/.test(path),
  ).length;
  const externalSubscriptionsOnRouter =
    sectionSubscriptionPaths.length - managedSubscriptionsOnRouter;
  const controlSubscriptions = (connections.data?.items ?? []).filter(
    (item) => item.kind === 'subscription' && item.enabled,
  ).length;
  const connectionsMissing = managedSubscriptionsOnRouter < controlSubscriptions;
  const connectionsOutOfSync = externalSubscriptionsOnRouter > 0 || connectionsMissing;

  const dnsData = dnsStatus.data;
  const agentSupportsDns = versionAtLeast(router?.agent_version, '1.1.0');
  const dnsRunning = dnsJob?.status === 'queued' || dnsJob?.status === 'running';
  const dnsCurrent =
    dnsJob?.result && typeof dnsJob.result.current === 'string' ? dnsJob.result.current : '';
  const dnsBootstrap = dnsBenchmark?.bootstrap?.length
    ? dnsBenchmark.bootstrap
    : dnsChoice?.type === 'udp'
      ? dnsChoice.servers
      : [];
  const dnsCanApply = Boolean(
    dnsData?.state_available &&
      !dnsData.template &&
      dnsData.current?.detour_enabled !== true &&
      dnsChoice &&
      dnsChoice.servers.length > 0 &&
      dnsBootstrap.length > 0,
  );
  const dnsResults = dnsBenchmark
    ? [...dnsBenchmark.results].sort((a, b) => {
        if (a.protocol !== b.protocol) return a.protocol === 'udp' ? -1 : 1;
        return (a.median_ms ?? 99999) - (b.median_ms ?? 99999);
      })
    : [];
  const dnsProposal = useMemo(
    () =>
      dnsChoice
        ? {
            dns_type: dnsChoice.type,
            dns_server: dnsChoice.servers,
            bootstrap_dns_server: dnsBootstrap,
          }
        : null,
    [dnsChoice, dnsBootstrap],
  );

  useEffect(() => {
    if (router && !newName) setNewName(router.name);
  }, [router, newName]);

  useEffect(() => {
    if (!extras.data) return;
    const section = extras.data.managed_section || routerSectionNames[0] || '';
    setExtraSection(section);
    applyExtrasToForm(extras.data.extras[section]);
  }, [extras.data]);

  function applyExtrasToForm(entry: RouterListExtras | undefined): void {
    setExtraRuleSet((entry?.rule_set ?? []).join('\n'));
    setExtraDomainLists((entry?.remote_domain_lists ?? []).join('\n'));
    setExtraSubnetLists((entry?.remote_subnet_lists ?? []).join('\n'));
    setExtraDomains((entry?.manual_domains ?? []).join('\n'));
    setExtraIps((entry?.manual_ips ?? []).join('\n'));
  }

  function changeExtraSection(value: string): void {
    setExtraSection(value);
    applyExtrasToForm(extras.data?.extras[value]);
  }

  async function saveExtras(): Promise<void> {
    setExtrasBusy(true);
    try {
      await api(`/api/v1/routers/${id}/list-extras`, {
        method: 'PUT',
        body: {
          section: extraSection,
          rule_set: extraRuleSet.split('\n').map((line) => line.trim()).filter(Boolean),
          remote_domain_lists: extraDomainLists.split('\n').map((line) => line.trim()).filter(Boolean),
          remote_subnet_lists: extraSubnetLists.split('\n').map((line) => line.trim()).filter(Boolean),
          manual_domains: extraDomains.split('\n').map((line) => line.trim()).filter(Boolean),
          manual_ips: extraIps.split('\n').map((line) => line.trim()).filter(Boolean),
        },
      });
      toast.success('Свои списки сохранены. Они добавятся к шаблону при следующем сравнении.');
      await extras.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setExtrasBusy(false);
    }
  }

  async function waitJob(job: Job, timeoutMs = 180_000): Promise<Job> {
    let current = job;
    const deadline = Date.now() + timeoutMs;
    while (
      (current.status === 'queued' || current.status === 'running') &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      current = (await api<{ job: Job }>(`/api/v1/jobs/${current.id}`)).job;
    }
    return current;
  }

  /**
   * Показывает прогресс задачи в верхней части страницы роутера. Используется
   * для действий, которые не открывают собственное модальное окно.
   */
  async function trackJob(start: Job, label: string): Promise<Job | null> {
    setActiveJob(start);
    setActiveJobLabel(label);
    let current = start;
    try {
      while (current.status === 'queued' || current.status === 'running') {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        current = (await api<{ job: Job }>(`/api/v1/jobs/${current.id}`)).job;
        setActiveJob(current);
      }
      return current;
    } catch (caught) {
      toast.error(errorMessage(caught));
      return null;
    }
  }

  async function runComponentCheck(): Promise<void> {
    if (!router) return;
    setComponentCheckBusy(true);
    setComponentErrors([]);
    setComponentLog('');
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${id}/components/check`, {
        method: 'POST',
      });
      setComponentJob(started.job);
      const done = await waitJob(started.job, 360_000);
      setComponentJob(done);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? `Проверка завершилась: ${done.status}`);
      }
      const result = (done.result ?? {}) as {
        results?: TachyonComponentInfo[];
        errors?: Array<{ component: string; message: string }>;
      };
      setComponentResults(Array.isArray(result.results) ? result.results : []);
      setComponentErrors(Array.isArray(result.errors) ? result.errors : []);
      setComponentCheckedAt(new Date());
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setComponentCheckBusy(false);
      setComponentJob(null);
    }
  }

  async function updateTachyonComponent(component: 'tachyon' | 'tachyon-core'): Promise<void> {
    if (!router) return;
    const title = TACHYON_COMPONENTS.find((item) => item.id === component)?.title ?? component;
    setComponentUpdating(component);
    setComponentLog('');
    setComponentErrors([]);
    try {
      const started = await api<{ job: Job }>(
        `/api/v1/routers/${id}/components/${component}/update`,
        { method: 'POST' },
      );
      setComponentJob(started.job);
      const done = await waitJob(started.job, 1_260_000);
      setComponentJob(done);
      const result = (done.result ?? {}) as { log?: string };
      if (typeof result.log === 'string') setComponentLog(result.log);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? `Обновление завершилось: ${done.status}`);
      }
      toast.success(`${title}: обновление завершено`);
      setComponentCheckedAt(null);
      await runComponentCheck();
      await detail.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setComponentUpdating(null);
    }
  }

  async function readWifi(): Promise<void> {
    if (!router) return;
    setWifiBusy(true);
    setWifiError(null);
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${id}/wifi/read`, {
        method: 'POST',
      });
      const done = await waitJob(started.job, 600_000);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? `Чтение Wi-Fi завершилось: ${done.status}`);
      }
      const result = (done.result ?? {}) as Partial<WifiState>;
      setWifi({
        radios: Array.isArray(result.radios) ? result.radios : [],
        interfaces: Array.isArray(result.interfaces) ? result.interfaces : [],
        hardware: result.hardware,
      });
    } catch (caught) {
      setWifiError(errorMessage(caught));
    } finally {
      setWifiBusy(false);
    }
  }

  function openWifiEdit(iface: WifiInterface): void {
    setWifiEdit(iface);
    setWifiForm({
      ssid: iface.ssid,
      encryption: iface.encryption || 'none',
      key: '',
      hidden: iface.hidden,
      disabled: iface.disabled,
      isolate: iface.isolate,
    });
  }

  async function saveWifi(): Promise<void> {
    if (!wifiEdit) return;
    const target = wifiEdit;
    const ssid = wifiForm.ssid.trim();
    if (!ssid) {
      toast.error('Укажите SSID');
      return;
    }
    if (ssid.length > 32) {
      toast.error('SSID не может быть длиннее 32 символов');
      return;
    }
    const newKey = wifiForm.key.trim();
    const needsKey = WIFI_KEY_ENCRYPTIONS.has(wifiForm.encryption);
    if (needsKey && newKey && newKey.length < 8) {
      toast.error('Пароль Wi-Fi должен быть не короче 8 символов');
      return;
    }
    if (needsKey && !target.key_set && !newKey) {
      toast.error('Для защищённой сети задайте пароль');
      return;
    }

    const changes: Record<string, unknown> = {};
    if (ssid !== target.ssid) changes.ssid = ssid;
    if (wifiForm.encryption !== target.encryption) changes.encryption = wifiForm.encryption;
    if (wifiForm.encryption !== 'none' && wifiForm.encryption !== 'owe' && newKey) {
      changes.key = newKey;
    }
    if (wifiForm.hidden !== target.hidden) changes.hidden = wifiForm.hidden;
    if (wifiForm.disabled !== target.disabled) changes.disabled = wifiForm.disabled;
    if (wifiForm.isolate !== target.isolate) changes.isolate = wifiForm.isolate;
    if (Object.keys(changes).length === 0) {
      setWifiEdit(null);
      return;
    }

    setWifiSaveBusy(true);
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${id}/wifi/${target.name}`, {
        method: 'PUT',
        body: changes,
      });
      const done = await waitJob(started.job, 600_000);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? `Сохранение Wi-Fi завершилось: ${done.status}`);
      }
      toast.success('Настройки Wi-Fi сохранены');
      setWifiEdit(null);
      setWifi(null);
      await new Promise((resolve) => window.setTimeout(resolve, 3000));
      await readWifi();
      void detail.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setWifiSaveBusy(false);
    }
  }

  function openWifiCreate(): void {
    setWifiCreateForm({
      ssid: '',
      encryption: 'psk2',
      key: '',
      hidden: false,
      disabled: false,
      isolate: false,
      radios: wifi?.radios.map((radio) => radio.name) ?? [],
    });
    setWifiCreateOpen(true);
  }

  async function createWifi(): Promise<void> {
    const ssid = wifiCreateForm.ssid.trim();
    if (!ssid) {
      toast.error('Укажите SSID');
      return;
    }
    if (ssid.length > 32) {
      toast.error('SSID не может быть длиннее 32 символов');
      return;
    }
    const needsKey = WIFI_KEY_ENCRYPTIONS.has(wifiCreateForm.encryption);
    const key = wifiCreateForm.key.trim();
    if (needsKey && !key) {
      toast.error('Для защищённой сети задайте пароль');
      return;
    }
    if (needsKey && key.length < 8) {
      toast.error('Пароль Wi-Fi должен быть не короче 8 символов');
      return;
    }
    if (wifi && wifi.radios.length > 0 && wifiCreateForm.radios.length === 0) {
      toast.error('Выберите хотя бы один радиомодуль');
      return;
    }

    const body: Record<string, unknown> = {
      ssid,
      encryption: wifiCreateForm.encryption,
      hidden: wifiCreateForm.hidden,
      disabled: wifiCreateForm.disabled,
      isolate: wifiCreateForm.isolate,
    };
    if (needsKey && key) body.key = key;
    if (wifiCreateForm.radios.length > 0) body.radios = wifiCreateForm.radios;

    setWifiCreateBusy(true);
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${id}/wifi`, {
        method: 'POST',
        body,
      });
      if (!online) {
        toast.success('Задание в очереди: сеть появится после подключения роутера');
        setWifiCreateOpen(false);
        return;
      }
      const done = await waitJob(started.job, 600_000);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? `Создание Wi-Fi завершилось: ${done.status}`);
      }
      toast.success('Wi-Fi сеть создана');
      setWifiCreateOpen(false);
      await readWifi();
      void detail.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setWifiCreateBusy(false);
    }
  }

  async function deleteWifi(): Promise<void> {
    if (!wifiDelete) return;
    const target = wifiDelete;
    setWifiDeleteBusy(true);
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${id}/wifi/${target.name}`, {
        method: 'DELETE',
      });
      if (!online) {
        toast.success('Задание в очереди: сеть будет удалена после подключения роутера');
        setWifiDelete(null);
        setWifiEdit(null);
        return;
      }
      const done = await waitJob(started.job, 600_000);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? `Удаление Wi-Fi завершилось: ${done.status}`);
      }
      toast.success('Wi-Fi сеть удалена');
      setWifiDelete(null);
      setWifiEdit(null);
      await readWifi();
      void detail.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setWifiDeleteBusy(false);
    }
  }

  async function loadExternalConnections(): Promise<void> {
    setExternalBusy(true);
    setExternalError(null);
    try {
      const response = await api<{ job: Job }>(
        `/api/v1/routers/${id}/connections/list`,
        { method: 'POST' },
      );
      const job = await waitJob(response.job);
      if (job.status !== 'success') {
        throw new Error(job.error?.message ?? 'Не удалось прочитать подключения с роутера');
      }
      setExternalConnections(job.result as unknown as ExternalConnections);
    } catch (caught) {
      setExternalError(errorMessage(caught));
    } finally {
      setExternalBusy(false);
    }
  }

  function startReplace(target: {
    kind: 'subscription' | 'link';
    name?: string;
    hash?: string;
    label: string;
  }): void {
    setManageTarget({ action: 'replace', ...target });
    setManageValue('');
  }

  function startDelete(target: {
    kind: 'subscription' | 'link';
    name?: string;
    hash?: string;
    label: string;
  }): void {
    setManageTarget({ action: 'delete', ...target });
    setManageValue('');
  }

  async function submitManage(): Promise<void> {
    if (!manageTarget) return;
    if (manageTarget.action === 'replace' && manageValue.trim().length < 8) {
      toast.error('Укажите новую ссылку');
      return;
    }
    setManageBusy(true);
    try {
      const response = await api<{ job: Job }>(
        `/api/v1/routers/${id}/connections/manage`,
        {
          method: 'POST',
          body: {
            action: manageTarget.action,
            kind: manageTarget.kind,
            name: manageTarget.name,
            hash: manageTarget.hash,
            value:
              manageTarget.action === 'replace' ? manageValue.trim() : undefined,
          },
        },
      );
      const job = await waitJob(response.job);
      if (job.status !== 'success') {
        throw new Error(job.error?.message ?? 'Не удалось изменить подключение');
      }
      toast.success(
        manageTarget.action === 'delete'
          ? 'Подключение удалено с роутера'
          : 'Подключение заменено',
      );
      setManageTarget(null);
      setManageValue('');
      await Promise.all([loadExternalConnections(), connections.reload(), detail.reload()]);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setManageBusy(false);
    }
  }

  async function addConnection(): Promise<void> {
    setBusy(true);
    try {
      const body = connectionCatalogId
        ? {
            kind: connectionKind,
            label: connectionLabel.trim() || undefined,
            subscription_id: connectionCatalogId,
          }
        : {
            kind: connectionKind,
            label: connectionLabel.trim(),
            value: connectionValue.trim(),
          };
      await api(`/api/v1/routers/${id}/connections`, { method: 'POST', body });
      toast.success('Подключение сохранено, задача на применение поставлена в очередь');
      setConnectionOpen(false);
      setConnectionLabel('');
      setConnectionValue('');
      setConnectionCatalogId('');
      setConnectionCompactOpen(false);
      await Promise.all([connections.reload(), jobs.reload()]);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function updateConnection(): Promise<void> {
    if (!editingConnection) return;
    const label = editLabel.trim();
    const value = editValue.trim();
    if (!label || (label === editingConnection.label && !value)) {
      toast.info('Нет изменений для сохранения');
      return;
    }
    setBusy(true);
    try {
      await api(`/api/v1/routers/${id}/connections/${editingConnection.id}`, {
        method: 'PATCH',
        body: { label, ...(value ? { value } : {}) },
      });
      toast.success('Подключение обновлено, задача на применение поставлена в очередь');
      setEditingConnection(null);
      setEditValue('');
      setEditCompactOpen(false);
      await Promise.all([connections.reload(), jobs.reload()]);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function copyCompactSecret(item: RouterConnection): Promise<void> {
    setCopyingSecretId(item.id);
    try {
      const response = await api<{ secret: string }>(
        `/api/v1/routers/${id}/connections/${item.id}/secret`,
      );
      await copyText(response.secret);
      toast.success('Компактный секрет скопирован');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setCopyingSecretId(null);
    }
  }

  async function pollDnsJob(jobId: string): Promise<void> {
    for (let attempt = 0; attempt < 450; attempt += 1) {
      const response = await api<{ job: Job }>(`/api/v1/jobs/${jobId}`);
      setDnsJob(response.job);
      if (response.job.status !== 'queued' && response.job.status !== 'running') {
        if (response.job.status === 'success') {
          setDnsBenchmark(asDnsBenchmarkState(response.job.result));
          setDnsError(null);
          toast.success('Тест DNS завершён');
        } else {
          setDnsError(response.job.error?.message ?? 'Тест DNS не завершился');
        }
        await dnsLatest.reload();
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
    }
    setDnsError('Тест DNS выполняется дольше обычного');
  }

  async function startDnsBenchmark(): Promise<void> {
    setDnsBusy(true);
    setDnsError(null);
    try {
      const response = await api<{ job: Job }>(`/api/v1/routers/${id}/dns/benchmark`, {
        method: 'POST',
      });
      setDnsJob(response.job);
      await pollDnsJob(response.job.id);
    } catch (caught) {
      setDnsError(errorMessage(caught));
    } finally {
      setDnsBusy(false);
    }
  }

  async function cancelDnsBenchmark(): Promise<void> {
    if (!dnsJob) return;
    try {
      await api(`/api/v1/jobs/${dnsJob.id}/cancel`, { method: 'POST' });
      toast.info('Отмена теста DNS…');
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  function chooseDnsPair(type: 'udp' | 'doh', candidates: DnsCandidateResult[]): void {
    const limit = type === 'doh' ? 3 : 2;
    const servers = candidates.slice(0, limit).map((item) => item.address);
    if (servers.length === 0) return;
    setDnsChoice({ type, servers });
  }

  async function deleteConnection(): Promise<void> {
    if (!deletingConnection) return;
    setBusy(true);
    try {
      await api(`/api/v1/routers/${id}/connections/${deletingConnection.id}`, { method: 'DELETE' });
      toast.success('Подключение удалено, задача на применение поставлена в очередь');
      setDeletingConnection(null);
      await Promise.all([connections.reload(), jobs.reload()]);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function reloadAll(): Promise<void> {
    await Promise.all([detail.reload(), snapshots.reload(), jobs.reload()]);
  }

  async function refreshState(): Promise<void> {
    setBusy(true);
    try {
      const res = await api<{ job: Job }>(`/api/v1/routers/${id}/refresh`, { method: 'POST' });
      const finished = await trackJob(res.job, 'Читаем состояние роутера');
      if (finished?.status === 'success') toast.success('Состояние обновлено');
      else if (finished) toast.error(finished.error?.message ?? 'Не удалось прочитать состояние');
      await reloadAll();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restoreRouter(): Promise<void> {
    setRestoreRouterBusy(true);
    try {
      await api(`/api/v1/routers/${id}/restore`, { method: 'POST' });
      toast.success('Роутер восстановлен из архива');
      await detail.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setRestoreRouterBusy(false);
    }
  }

  async function purgeRouter(): Promise<void> {
    const currentName = detail.data?.router?.name ?? '';
    if (purgeName.trim() !== currentName) return;
    setPurgeBusy(true);
    try {
      await api(`/api/v1/routers/${id}?purge=true`, { method: 'DELETE' });
      toast.success('Роутер удалён навсегда');
      navigate('/routers');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setPurgeBusy(false);
    }
  }

  async function waitForJob(jobId: string): Promise<Job | null> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await api<{ job: Job }>(`/api/v1/jobs/${jobId}`);
      if (response.job.status !== 'queued' && response.job.status !== 'running') {
        return response.job;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
    return null;
  }

  async function openProductManager(): Promise<void> {
    setProductOpen(true);
    setProductLoading(true);
    setProductError(null);
    setProductJob(null);
    setProductNotice(null);
    setRemovePackagesSelected([]);
    void detail.reload();
    try {
      const response = await api<{ items: ProductCatalogItem[] }>(
        `/api/v1/routers/${id}/product-catalog`,
      );
      setProductItems(response.items);
      const defaults: Record<string, string> = {};
      for (const item of response.items) {
        defaults[item.product] = item.latest_version ?? item.releases[0]?.version ?? '';
      }
      setProductVersions(defaults);
    } catch (caught) {
      setProductError(errorMessage(caught));
    } finally {
      setProductLoading(false);
    }
  }

  async function installProduct(item: ProductCatalogItem): Promise<void> {
    const version = productVersions[item.product] ?? item.latest_version ?? '';
    const same = router?.product === item.product;
    const action = same ? 'Переустановить' : 'Установить';
    if (
      !window.confirm(
        `${action} ${item.label}${version ? ` ${version}` : ''}? Текущий продукт будет удалён, настройки RoutX и подписки будут перенесены. Это может занять несколько минут.`,
      )
    ) {
      return;
    }
    setProductSwitchBusy(true);
    setProductError(null);
    setProductJob(null);
    setActiveJob(null);
    setActiveJobLabel(`Установка ${item.label}`);
    try {
      if (!router) throw new Error('Роутер не загружен');
      const started = await api<{ job: Job }>(`/api/v1/routers/${id}/product-switch`, {
        method: 'POST',
        body: {
          product: item.product,
          ...(item.product === 'tachyon' && version ? { version } : {}),
        },
      });
      setProductJob(started.job);
      setActiveJob(started.job);
      let done: Job | null = null;
      for (let attempt = 0; attempt < 1300; attempt += 1) {
        const response = await api<{ job: Job }>(`/api/v1/jobs/${started.job.id}`);
        setProductJob(response.job);
        setActiveJob(response.job);
        if (response.job.status !== 'queued' && response.job.status !== 'running') {
          done = response.job;
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
      }
      if (!done || done.status !== 'success') {
        throw new Error(done?.error?.message ?? 'Смена продукта не завершилась');
      }
      const result = (done.result ?? {}) as {
        removed_products?: string[];
        installed_products?: Array<{ product?: string; version?: string | null }>;
      };
      const removed = (result.removed_products ?? []).filter(Boolean);
      const installed = (result.installed_products ?? [])
        .map((entry) => `${entry.product ?? ''}${entry.version ? ` ${entry.version}` : ''}`.trim())
        .filter(Boolean);
      setProductNotice(
        [
          `Установлено: ${installed.length > 0 ? installed.join(', ') : `${item.label} ${version}`.trim()}`,
          removed.length > 0 ? `Удалено: ${removed.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      );
      toast.success(`${item.label} установлен`);
      await detail.reload();
    } catch (caught) {
      setProductError(errorMessage(caught));
    } finally {
      setProductSwitchBusy(false);
      setActiveJob(null);
      setActiveJobLabel('');
    }
  }

  function toggleRemovePackage(name: string): void {
    setRemovePackagesSelected((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  }

  async function removeSelectedPackages(): Promise<void> {
    if (!router) return;
    const packages = [...new Set(removePackagesSelected)];
    if (packages.length === 0) return;
    if (
      !window.confirm(
        `Удалить пакеты:\n${packages.join('\n')}\n\nЭто может отключить текущий продукт и связь с панелью. Продолжить?`,
      )
    ) {
      return;
    }
    setRemovePackagesBusy(true);
    setProductError(null);
    setProductNotice(null);
    try {
      const started = await api<{ job: Job }>(`/api/v1/routers/${id}/packages/remove`, {
        method: 'POST',
        body: { packages },
      });
      const finished = await trackJob(started.job, 'Удаление пакетов');
      if (!finished || finished.status !== 'success') {
        throw new Error(finished?.error?.message ?? 'Не удалось удалить пакеты');
      }
      const result = (finished.result ?? {}) as { packages?: string[] };
      const removed = result.packages ?? packages;
      setProductNotice(`Удалено: ${removed.join(', ')}`);
      setRemovePackagesSelected([]);
      await detail.reload();
    } catch (caught) {
      setProductError(errorMessage(caught));
    } finally {
      setRemovePackagesBusy(false);
    }
  }

  async function reinstallCurrent(): Promise<void> {
    try {
      const response = await api<{ items: ProductCatalogItem[] }>(
        `/api/v1/routers/${id}/product-catalog`,
      );
      const current = response.items.find((item) => item.product === router?.product);
      if (!current) {
        toast.error('Текущий продукт не найден в каталоге');
        return;
      }
      await installProduct(current);
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function serviceAction(
    action: 'restart' | 'start' | 'stop' | 'enable' | 'disable',
  ): Promise<void> {
    setServiceBusy(action);
    try {
      const response = await api<{ job: Job }>(`/api/v1/routers/${id}/service`, {
        method: 'POST',
        body: { action },
      });
      const label =
        action === 'restart'
          ? 'Перезапускаем службу'
          : action === 'start'
            ? 'Запускаем службу'
            : action === 'stop'
              ? 'Останавливаем службу'
              : action === 'enable'
                ? 'Включаем автозапуск'
                : 'Выключаем автозапуск';
      const finished = await trackJob(response.job, label);
      if (!finished) {
        toast.info('Задача выполняется дольше обычного — следите за ней во вкладке «Задачи»');
      } else if (finished.status !== 'success') {
        toast.error(finished.error?.message ?? 'Служба не выполнила действие');
      } else {
        toast.success(
          action === 'restart'
            ? 'Служба перезапущена'
            : action === 'start'
              ? 'Служба запущена'
              : action === 'stop'
                ? 'Служба остановлена'
                : action === 'enable'
                  ? 'Автозапуск включён'
                  : 'Автозапуск выключен',
        );
        await detail.reload();
      }
      await jobs.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setServiceBusy(null);
    }
  }

  async function createSnapshot(): Promise<void> {
    setSnapshotBusy(true);
    try {
      const res = await api<{ job: Job }>(`/api/v1/routers/${id}/snapshot`, {
        method: 'POST',
        body: { reason: 'manual' },
      });
      const finished = await trackJob(res.job, 'Создаём снимок конфигурации');
      if (finished?.status === 'success') toast.success('Снимок создан');
      else if (finished) toast.error(finished.error?.message ?? 'Не удалось создать снимок');
      await Promise.all([snapshots.reload(), jobs.reload()]);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setSnapshotBusy(false);
    }
  }

  async function restore(): Promise<void> {
    if (!restoring) return;
    setBusy(true);
    try {
      const res = await api<{ job: Job }>(
        `/api/v1/routers/${id}/snapshots/${restoring.id}/restore`,
        { method: 'POST' },
      );
      const finished = await trackJob(res.job, 'Восстанавливаем снимок');
      if (finished?.status === 'success') toast.success('Снимок восстановлен');
      else if (finished) toast.error(finished.error?.message ?? 'Не удалось восстановить снимок');
      setRestoring(null);
      await Promise.all([jobs.reload(), detail.reload()]);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function assignTemplate(): Promise<void> {
    if (!assignTemplateId) return;
    setBusy(true);
    try {
      await api(`/api/v1/routers/${id}/templates/${assignTemplateId}`, { method: 'PUT', body: {} });
      toast.success('Шаблон назначен');
      setAssignTemplateId('');
      await detail.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function unassign(templateId: string): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/v1/routers/${id}/templates/${templateId}`, { method: 'DELETE' });
      toast.success('Шаблон снят с роутера');
      await detail.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function openMapping(assignment: TemplateAssignment): Promise<void> {
    setMappingAssignment(assignment);
    setMappingBusy(true);
    try {
      const revisions = await api<{ items: TemplateRevision[] }>(
        `/api/v1/templates/${assignment.template_id}/revisions`,
      );
      const revision = revisions.items.find((item) => item.revision === assignment.revision);
      const sections = revision?.payload.sections ?? {};
      const connectionSections = Object.entries(sections)
        .filter(([, options]) => {
          const action = options.action;
          return typeof action === 'string' && CONNECTION_ACTIONS.has(action);
        })
        .map(([name]) => name);
      const sources = connectionSections.length > 0 ? connectionSections : Object.keys(sections);
      setMappingSources(sources);

      const existing = assignment.section_map ?? {};
      const targets: Record<string, string> = {};
      for (const source of sources) {
        if (existing[source]) {
          targets[source] = existing[source]!;
          continue;
        }
        // Шаблон хранит логическое имя, Prokop показывает label секции.
        // Сначала ищем секцию с таким label, потом — с таким физическим именем.
        const byLabel = routerSectionNames.find((name) => sectionLabel(name) === source);
        if (byLabel) targets[source] = byLabel;
        else if (routerSectionNames.includes(source)) targets[source] = source;
        else if (routerSectionNames.length === 1) targets[source] = routerSectionNames[0]!;
        else targets[source] = '';
      }
      setMappingTargets(targets);
    } catch (caught) {
      toast.error(errorMessage(caught));
      setMappingAssignment(null);
    } finally {
      setMappingBusy(false);
    }
  }

  async function saveMapping(): Promise<void> {
    if (!mappingAssignment) return;
    const sectionMap = Object.fromEntries(
      Object.entries(mappingTargets).filter(([, target]) => target !== ''),
    );
    setMappingBusy(true);
    try {
      await api(`/api/v1/routers/${id}/templates/${mappingAssignment.template_id}`, {
        method: 'PUT',
        body: { revision: mappingAssignment.revision, section_map: sectionMap },
      });
      toast.success('Сопоставление секций сохранено');
      setMappingAssignment(null);
      await detail.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setMappingBusy(false);
    }
  }

  async function toggleMonitoring(enabled: boolean): Promise<void> {
    try {
      await api(`/api/v1/routers/${id}`, { method: 'PATCH', body: { monitoring_enabled: enabled } });
      toast.success(enabled ? 'Мониторинг включён' : 'Мониторинг выключен');
      await detail.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function rename(): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/v1/routers/${id}`, { method: 'PATCH', body: { name: newName } });
      toast.success('Имя обновлено');
      setRenameOpen(false);
      await detail.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function issueBinding(): Promise<void> {
    try {
      setBinding(await api<BindingToken>(`/api/v1/routers/${id}/binding-token`, { method: 'POST' }));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function rotateCredential(): Promise<void> {
    try {
      setCredential(await api<RotateCredential>(`/api/v1/routers/${id}/rotate-credential`, { method: 'POST' }));
    } catch (caught) {
      toast.error(errorMessage(caught));
    }
  }

  async function checkSingBox(): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/v1/routers/${id}/singbox/check`, { method: 'POST' });
      toast.info('Проверка обновлений sing-box запущена');
      await jobs.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function refreshSingBoxCatalog(): Promise<void> {
    setBusy(true);
    try {
      const result = await api<{ versions: number }>('/api/v1/singbox/refresh', { method: 'POST' });
      toast.success(`Каталог обновлён: ${result.versions} версий`);
      await versions.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function installSingBox(): Promise<void> {
    if (!installVersion) return;
    setBusy(true);
    try {
      const res = await api<{ job: Job }>(`/api/v1/routers/${id}/singbox/install`, {
        method: 'POST',
        body: {
          variant: 'extended',
          version_tag: installVersion.tag,
          acknowledge_risk: true,
        },
      });
      const finished = await trackJob(res.job, `Устанавливаем sing-box ${installVersion.tag}`);
      if (finished?.status === 'success') toast.success(`sing-box ${installVersion.tag} установлен`);
      else if (finished) toast.error(finished.error?.message ?? 'Не удалось установить sing-box');
      setSelectedVariantId('extended');
      setInstallVersion(null);
      await Promise.all([jobs.reload(), detail.reload()]);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function installSingBoxVariant(): Promise<void> {
    if (!installVariant) return;
    setBusy(true);
    try {
      const res = await api<{ job: Job }>(`/api/v1/routers/${id}/singbox/install`, {
        method: 'POST',
        body: { variant: installVariant.id, acknowledge_risk: true },
      });
      const finished = await trackJob(res.job, `Переключаем sing-box на ${installVariant.label}`);
      if (finished?.status === 'success') {
        toast.success(`sing-box переключён на ${installVariant.label}`);
      } else if (finished) {
        toast.error(finished.error?.message ?? 'Не удалось переключить sing-box');
      }
      setSelectedVariantId(installVariant.id);
      setInstallVariant(null);
      await Promise.all([jobs.reload(), detail.reload()]);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function rollbackSingBox(): Promise<void> {
    setBusy(true);
    try {
      const res = await api<{ job: Job }>(`/api/v1/routers/${id}/singbox/rollback`, {
        method: 'POST',
      });
      const finished = await trackJob(res.job, 'Возвращаем предыдущий sing-box');
      if (finished?.status === 'success') toast.success('Предыдущий sing-box восстановлен');
      else if (finished) toast.error(finished.error?.message ?? 'Не удалось откатить sing-box');
      setRollbackOpen(false);
      await Promise.all([jobs.reload(), detail.reload()]);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (detail.loading && !detail.data) return <Spinner />;
  if (detail.error && !detail.data)
    return <ErrorBanner message={detail.error} onRetry={() => void detail.reload()} />;
  if (!router) return <Empty>Роутер не найден.</Empty>;

  const selectedVariant =
    (variants.data?.items ?? []).find((variant) => variant.id === selectedVariantId) ?? null;
  const currentVariantId = normalizeSingBoxVariant(router.sing_box_variant);
  const selectedVariantActive =
    selectedVariantId !== '' && selectedVariantId === currentVariantId;

  const samples: MetricSample[] = (metrics.data?.items ?? []) as unknown as MetricSample[];
  const chartPoints = samples.map((sample) => ({
    x: Date.parse(sample.ts),
    y: sample.latency_ms,
  }));
  const latest = samples.length > 0 ? samples[samples.length - 1] : undefined;

  return (
    <div className="page">
      <PageHeader
        eyebrow={PRODUCT_LABEL[router.product] ?? router.product}
        title={router.name}
        subtitle={
          [
            router.model,
            router.openwrt_version ? `OpenWrt ${router.openwrt_version}` : null,
            router.arch,
            router.product_version ? `${PRODUCT_LABEL[router.product] ?? ''} ${router.product_version}` : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'Сведения о платформе появятся после привязки'
        }
        actions={
          <>
            {isAdmin ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() => void openProductManager()}
                  busy={productSwitchBusy}
                  disabled={!canSwitchProduct || productSwitchBusy}
                >
                  Сменить продукт
                </Button>
                {router.product === 'tachyon' ||
                router.product === 'forkop' ||
                router.product === 'podkop' ||
                router.product === 'prokop' ? (
                  <Button
                    variant="ghost"
                    onClick={() => void reinstallCurrent()}
                    busy={productSwitchBusy}
                    disabled={!canSwitchProduct || productSwitchBusy}
                  >
                    Переустановить
                  </Button>
                ) : null}
              </>
            ) : null}
            <Button variant="ghost" onClick={() => void refreshState()} busy={busy} disabled={!online}>
              Прочитать состояние
            </Button>
            <Button variant="ghost" onClick={() => void createSnapshot()} busy={snapshotBusy} disabled={!canMutate}>
              Снимок
            </Button>
            <Button
              variant="ghost"
              onClick={() => void serviceAction('restart')}
              busy={serviceBusy === 'restart'}
              disabled={!canMutate || serviceBusy !== null}
            >
              Перезапустить
            </Button>
          </>
        }
      />

      {router.archived_at ? (
        <InfoBanner tone="warn">
          Роутер находится в архиве с {formatDate(router.archived_at)}. Мониторинг остановлен, задачи
          не выполняются. Восстановление вернёт тот же токен агента — переустанавливать RoutX не
          нужно.
          <div className="row" style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => void restoreRouter()} busy={restoreRouterBusy}>
              Восстановить из архива
            </Button>
          </div>
        </InfoBanner>
      ) : null}

      {router.status === 'conflict' ? (
        <InfoBanner tone="warn">
          На роутере обнаружено несколько продуктов (Forkop/Prokop/Podkop/Tachyon). Обычные
          изменения заблокированы, но можно нажать «Сменить продукт» и установить один продукт —
          RoutX удалит остальные и попробует перенести настройки.
        </InfoBanner>
      ) : null}
      {router.status === 'unsupported' ? (
        <InfoBanner tone="warn">
          Платформа не поддерживается для записи. Доступен только просмотр собранного состояния.
        </InfoBanner>
      ) : null}
      {router.status === 'pending' ? (
        <InfoBanner>
          Роутер ещё не подключался. Выпустите токен привязки на вкладке «Настройки» и установите
          RoutX на устройство.
        </InfoBanner>
      ) : null}
      {router.last_error ? <InfoBanner tone="warn">Последняя ошибка: {router.last_error}</InfoBanner> : null}

      <div className="stat-grid">
        <Stat
          label="Статус"
          value={<StatusBadge status={router.status} label={ROUTER_STATUS[router.status] ?? router.status} />}
          tone={statusTone(router.status)}
          hint={`Контакт: ${formatRelative(router.last_seen_at)}`}
        />
        <Stat
          label="Служба"
          value={serviceText(state?.service)}
          tone={
            serviceText(state?.service).includes('disabled')
              ? 'warn'
              : serviceText(state?.service).includes('running')
                ? 'ok'
                : 'warn'
          }
          hint={state?.health ? `health: ${healthText(state.health)}` : 'нет данных'}
        />
        <Stat label="Агент" value={router.agent_version ?? '—'} hint={`Manifest: ${router.manifest_version ?? '—'}`} />
        <Stat
          label={router.product === 'tachyon' ? 'Движок' : 'sing-box'}
          value={router.sing_box_version ?? 'не установлен'}
          hint={
            router.product === 'tachyon'
              ? 'tachyon-core'
              : (router.sing_box_variant ?? 'вариант неизвестен')
          }
        />
      </div>

      {activeJob ? (
        <div className="active-job">
          <div className="active-job-head">
            <strong>{activeJobLabel}</strong>
            {activeJob.status !== 'queued' && activeJob.status !== 'running' ? (
              <Button size="sm" variant="ghost" onClick={() => setActiveJob(null)}>
                Скрыть
              </Button>
            ) : null}
          </div>
          <JobProgress job={activeJob} />
        </div>
      ) : null}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {detail.error ? <ErrorBanner message={detail.error} onRetry={() => void detail.reload()} /> : null}

      {tab === 'overview' ? (
        <OverviewTab
          router={router}
          state={state}
          managedEntries={managedEntries}
          stateQuery={stateQuery}
          onStateQueryChange={setStateQuery}
          latest={latest ?? null}
          serviceLabel={serviceText(state?.service)}
          healthLabel={healthText(state?.health)}
          proxyLabel={proxyHealth(latest?.proxy_health)}
          productSvc={productSvc}
          productLabel={productLabel}
          singBoxAutostartLabel={singBoxAutostartLabel}
          autostartEnabled={autostartEnabled}
          autostartPartial={autostartPartial}
          serviceAction={(action) => void serviceAction(action)}
          serviceBusy={serviceBusy}
          canMutate={canMutate}
        />
      ) : null}

      {tab === 'dns' ? (
        <DnsTab
          router={router}
          routerId={id}
          online={online}
          dnsStatus={dnsStatus}
          agentSupportsDns={agentSupportsDns}
          dnsBusy={dnsBusy}
          dnsRunning={dnsRunning}
          dnsJob={dnsJob}
          dnsCurrent={dnsCurrent}
          dnsError={dnsError}
          dnsBenchmark={dnsBenchmark}
          dnsResults={dnsResults}
          dnsChoice={dnsChoice}
          dnsBootstrap={dnsBootstrap}
          dnsCanApply={dnsCanApply}
          dnsApplyOpen={dnsApplyOpen}
          dnsProposal={dnsProposal}
          onStartBenchmark={() => void startDnsBenchmark()}
          onCancelBenchmark={() => void cancelDnsBenchmark()}
          onChoosePair={chooseDnsPair}
          onApplyOpenChange={setDnsApplyOpen}
          onApplied={async () => {
            await Promise.all([dnsStatus.reload(), dnsLatest.reload(), detail.reload()]);
          }}
        />
      ) : null}

      {tab === 'connections' ? (
        <RouterRulesPanel
          routerId={id}
          router={router}
          state={state ?? null}
          onChanged={() => void detail.reload()}
        />
      ) : null}

      {tab === 'snapshots' ? (
        <SnapshotsTab
          snapshots={snapshots}
          busy={snapshotBusy}
          canMutate={canMutate}
          onCreate={() => void createSnapshot()}
          onRestore={setRestoring}
        />
      ) : null}

      {tab === 'metrics' ? (
        <MetricsTab
          hours={hours}
          onHoursChange={setHours}
          metrics={metrics}
          connectionLosses={connectionLosses}
          chartPoints={chartPoints}
          latest={latest ?? null}
        />
      ) : null}

      {tab === 'diagnostics' ? (
        <DiagnosticsTab routerId={id} canMutate={canMutate} diagnostics={diagnostics} />
      ) : null}

      {tab === 'updates' ? (
        <UpdatesTab
          router={router}
          online={online}
          componentCheckBusy={componentCheckBusy}
          componentUpdating={componentUpdating}
          componentCheckedAt={componentCheckedAt}
          componentErrors={componentErrors}
          componentResults={componentResults}
          componentJob={componentJob}
          componentLog={componentLog}
          onCheck={() => void runComponentCheck()}
          onUpdate={(component) => void updateTachyonComponent(component)}
        />
      ) : null}

      {tab === 'singbox' ? (
        <SingBoxTab
          router={router}
          variants={variants}
          versions={versions}
          currentVariantId={currentVariantId}
          selectedVariantId={selectedVariantId}
          onSelectVariant={setSelectedVariantId}
          selectedVariant={selectedVariant}
          selectedVariantActive={selectedVariantActive}
          busy={busy}
          canMutate={canMutate}
          isAdmin={isAdmin}
          isSuperadmin={isSuperadmin}
          onCheck={() => void checkSingBox()}
          onRollback={() => setRollbackOpen(true)}
          onRefreshCatalog={() => void refreshSingBoxCatalog()}
          onInstallVariant={setInstallVariant}
          onInstallVersion={setInstallVersion}
        />
      ) : null}

      {tab === 'jobs' ? <JobsTab jobs={jobs} /> : null}

      {tab === 'settings' ? (
        <div className="stack">
          <Panel
            title="Wi-Fi сети"
            subtitle="Сети читаются через агент из /etc/config/wireless. Текущие пароли не показываются: можно задать новый пароль или оставить поле пустым."
            actions={
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void readWifi()}
                  busy={wifiBusy}
                  disabled={!online}
                >
                  Прочитать Wi-Fi
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={openWifiCreate}
                  disabled={
                    Boolean(router?.archived_at) || wifi?.hardware?.present === false
                  }
                >
                  Добавить сеть
                </Button>
              </>
            }
          >
            {!versionAtLeast(router?.agent_version, '1.5.52') ? (
              <InfoBanner tone="warn">
                Агент {router?.agent_version ?? 'неизвестной версии'} ещё не умеет определять
                наличие Wi-Fi модуля. При первом чтении панель автоматически обновит его до 1.5.52 —
                это может занять около минуты.
              </InfoBanner>
            ) : null}
            {wifi?.hardware ? (
              <div className="row">
                <StatusBadge
                  status={wifi.hardware.present ? 'success' : 'error'}
                  label={wifi.hardware.present ? 'Wi-Fi модуль есть' : 'Wi-Fi модуль не найден'}
                />
                {wifi.hardware.phys && wifi.hardware.phys.length > 0 ? (
                  <span className="muted-text small">
                    phy: {wifi.hardware.phys.join(', ')}
                  </span>
                ) : null}
              </div>
            ) : null}
            {wifi?.hardware && !wifi.hardware.present ? (
              <InfoBanner tone="warn">
                На роутере не обнаружен Wi-Fi модуль. Просмотр оставшихся сетей доступен, но
                создавать и изменять Wi-Fi нельзя.
              </InfoBanner>
            ) : null}
            {wifiError ? <ErrorBanner message={wifiError} /> : null}
            {wifiBusy && !wifi ? <Spinner label="Читаем Wi-Fi…" /> : null}
            {!wifi && !wifiBusy ? (
              <Empty>
                {online
                  ? 'Нажмите «Прочитать Wi-Fi», чтобы загрузить существующие сети.'
                  : 'Роутер не в сети — Wi-Fi можно прочитать после подключения.'}
              </Empty>
            ) : null}
            {wifi ? (
              <div className="stack">
                {wifi.interfaces.length === 0 ? (
                  <Empty>
                    {wifi.hardware?.present === false
                      ? 'Wi-Fi модуль не обнаружен.'
                      : 'Wi-Fi модуль есть, но сети ещё не настроены.'}
                  </Empty>
                ) : (
                  wifi.interfaces.map((iface) => {
                    const radio = wifi.radios.find((item) => item.name === iface.device);
                    return (
                      <div
                        key={iface.name}
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
                            alignItems: 'flex-start',
                            flexWrap: 'wrap',
                          }}
                        >
                          <div>
                            <strong>{iface.ssid || '(без SSID)'}</strong>
                            <div className="muted-text small">
                              {iface.name} · {iface.device}
                              {radio?.band ? ` · ${radio.band}` : ''} · {iface.mode} ·{' '}
                              {iface.network || '—'} · {wifiEncryptionLabel(iface.encryption)}
                              {iface.key_set ? ' · пароль задан' : ''}
                            </div>
                          </div>
                          <div className="row">
                            {iface.hidden ? (
                              <StatusBadge status="warning" label="скрытая" />
                            ) : null}
                            {iface.disabled ? (
                              <StatusBadge status="offline" label="отключена" />
                            ) : null}
                            {radio?.disabled ? (
                              <StatusBadge status="offline" label="радио off" />
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openWifiEdit(iface)}
                            >
                              Изменить
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                {wifi.radios.length > 0 ? (
                  <p className="muted-text small">
                    Радиомодули:{' '}
                    {wifi.radios
                      .map(
                        (radio) =>
                          `${radio.name}${radio.band ? ` (${radio.band})` : ''}${
                            radio.disabled ? ' — off' : ''
                          }`,
                      )
                      .join(' · ')}
                  </p>
                ) : null}
              </div>
            ) : null}
          </Panel>

          <div className="grid-2">
            <div className="stack">
            <Panel title="Имя и мониторинг">
              <div className="kv">
                <span>Текущее имя</span>
                <strong>{router.name}</strong>
                <span>Мониторинг</span>
                <strong>{router.monitoring_enabled ? 'включён' : 'выключен'}</strong>
                <span>Владелец</span>
                <strong>{router.owner_email ?? '—'}</strong>
                <span>Создан</span>
                <strong>{formatDate(router.created_at)}</strong>
              </div>
              <div className="row">
                <Button variant="ghost" size="sm" onClick={() => setRenameOpen(true)}>
                  Переименовать
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void toggleMonitoring(!router.monitoring_enabled)}
                >
                  {router.monitoring_enabled ? 'Выключить мониторинг' : 'Включить мониторинг'}
                </Button>
                <Link className="btn btn-subtle btn-sm" to="/routers">
                  К списку
                </Link>
              </div>
            </Panel>

            <Panel title="Учётные данные агента">
              <CredentialPanel routerId={id} />
              <Button variant="ghost" size="sm" onClick={() => void rotateCredential()}>
                Ротировать токен агента
              </Button>
            </Panel>
          </div>

          <div className="stack">
            <Panel title="Привязка агента">
              <p className="page-sub">
                Токен привязки действует 5 минут и показывается один раз. Роутер сам устанавливает
                исходящее TLS-соединение.
              </p>
              <Button size="sm" onClick={() => void issueBinding()}>
                Выпустить токен привязки
              </Button>
            </Panel>

            <Panel title="Архивирование">
              <p className="page-sub">
                Архив отключает мониторинг и отзывает учётные данные. Forkop/Prokop/Podkop на устройстве
                остаются без изменений.
              </p>
              <div className="row">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={async () => {
                    if (!window.confirm(`Архивировать роутер «${router.name}»?`)) return;
                    try {
                      await api(`/api/v1/routers/${id}`, { method: 'DELETE' });
                      toast.success('Роутер архивирован');
                      navigate('/routers');
                    } catch (caught) {
                      toast.error(errorMessage(caught));
                    }
                  }}
                >
                  Архивировать роутер
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    setPurgeName('');
                    setPurgeOpen(true);
                  }}
                >
                  Удалить навсегда
                </Button>
              </div>
            </Panel>
          </div>
        </div>
        </div>
      ) : null}

      {wifiCreateOpen ? (
        <Modal
          title="Новая Wi-Fi сеть"
          onClose={() => setWifiCreateOpen(false)}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setWifiCreateOpen(false)}
                disabled={wifiCreateBusy}
              >
                Отмена
              </Button>
              <Button
                onClick={() => void createWifi()}
                busy={wifiCreateBusy}
                disabled={wifiCreateBusy}
              >
                {online ? 'Создать' : 'Поставить в очередь'}
              </Button>
            </>
          }
        >
          {!online ? (
            <InfoBanner>
              Роутер не в сети. Задание сохранится в очереди и выполнится автоматически, когда
              роутер подключится.
            </InfoBanner>
          ) : null}
          <InfoBanner tone="warn">
            Создание и применение сети перезапустит Wi-Fi. Подключённые клиенты могут отключиться;
            если панель открыта по Wi-Fi, лучше управлять по кабелю.
          </InfoBanner>

          {wifi && wifi.radios.length > 0 ? (
            <Field label="Радиомодули" hint="На каких радио создать сеть.">
              <div className="stack">
                {wifi.radios.map((radio) => (
                  <label className="check-row" key={radio.name}>
                    <input
                      type="checkbox"
                      checked={wifiCreateForm.radios.includes(radio.name)}
                      onChange={(event) =>
                        setWifiCreateForm((current) => ({
                          ...current,
                          radios: event.target.checked
                            ? [...current.radios, radio.name]
                            : current.radios.filter((name) => name !== radio.name),
                        }))
                      }
                    />
                    <span>
                      {radio.name}
                      {radio.band ? ` · ${radio.band}` : ''}
                      {radio.disabled ? ' · сейчас отключён' : ''}
                    </span>
                  </label>
                ))}
              </div>
            </Field>
          ) : (
            <InfoBanner>
              Радиомодули ещё не прочитаны. Сеть будет создана на всех доступных радио после
              подключения роутера.
            </InfoBanner>
          )}

          <Field label="SSID" hint="Имя новой Wi-Fi сети, до 32 символов.">
            <TextInput
              value={wifiCreateForm.ssid}
              onChange={(value) =>
                setWifiCreateForm((current) => ({ ...current, ssid: value }))
              }
              placeholder="Например, Guest Wi-Fi"
              required
            />
          </Field>
          <Field label="Шифрование">
            <Select
              value={wifiCreateForm.encryption}
              onChange={(value) =>
                setWifiCreateForm((current) => ({ ...current, encryption: value }))
              }
            >
              <option value="none">Без пароля</option>
              <option value="owe">OWE — шифрование без пароля</option>
              <option value="psk">WPA-PSK</option>
              <option value="psk2">WPA2-PSK</option>
              <option value="psk-mixed">WPA/WPA2 mixed</option>
              <option value="sae">WPA3-SAE</option>
              <option value="sae-mixed">WPA2/WPA3 mixed</option>
            </Select>
          </Field>
          {WIFI_KEY_ENCRYPTIONS.has(wifiCreateForm.encryption) ? (
            <Field label="Пароль" hint="Не короче 8 символов.">
              <TextInput
                type="password"
                value={wifiCreateForm.key}
                onChange={(value) =>
                  setWifiCreateForm((current) => ({ ...current, key: value }))
                }
                placeholder="Пароль Wi-Fi"
                autoComplete="new-password"
              />
            </Field>
          ) : null}
          <div className="stack">
            <label className="check-row">
              <input
                type="checkbox"
                checked={wifiCreateForm.hidden}
                onChange={(event) =>
                  setWifiCreateForm((current) => ({
                    ...current,
                    hidden: event.target.checked,
                  }))
                }
              />
              <span>Скрытая сеть (не показывать SSID)</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={wifiCreateForm.disabled}
                onChange={(event) =>
                  setWifiCreateForm((current) => ({
                    ...current,
                    disabled: event.target.checked,
                  }))
                }
              />
              <span>Создать отключённой</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={wifiCreateForm.isolate}
                onChange={(event) =>
                  setWifiCreateForm((current) => ({
                    ...current,
                    isolate: event.target.checked,
                  }))
                }
              />
              <span>Изолировать клиентов друг от друга</span>
            </label>
          </div>
        </Modal>
      ) : null}

      {wifiEdit ? (
        <Modal
          title={`Wi-Fi: ${wifiEdit.ssid || wifiEdit.name}`}
          onClose={() => setWifiEdit(null)}
          footer={
            <>
              <Button
                variant="danger"
                onClick={() => wifiEdit && setWifiDelete(wifiEdit)}
                disabled={wifiSaveBusy || wifiDeleteBusy}
              >
                Удалить
              </Button>
              <Button
                variant="ghost"
                onClick={() => setWifiEdit(null)}
                disabled={wifiSaveBusy}
              >
                Отмена
              </Button>
              <Button onClick={() => void saveWifi()} busy={wifiSaveBusy} disabled={wifiSaveBusy}>
                Сохранить
              </Button>
            </>
          }
        >
          <InfoBanner tone="warn">
            Сохранение SSID или пароля перезапустит Wi-Fi: подключённые клиенты отключатся. Если
            панель открыта по Wi-Fi, связь с ней может прерваться — лучше управлять настройками по
            кабелю.
          </InfoBanner>
          <div className="kv">
            <span>Сеть</span>
            <strong>{wifiEdit.name}</strong>
            <span>Устройство</span>
            <strong>{wifiEdit.device || '—'}</strong>
            <span>Режим</span>
            <strong>{wifiEdit.mode}</strong>
            <span>Интерфейс</span>
            <strong>{wifiEdit.network || '—'}</strong>
            <span>Текущий пароль</span>
            <strong>{wifiEdit.key_set ? 'задан' : 'не задан'}</strong>
          </div>
          <Field label="SSID" hint="Имя Wi-Fi сети, до 32 символов.">
            <TextInput
              value={wifiForm.ssid}
              onChange={(value) => setWifiForm((current) => ({ ...current, ssid: value }))}
              placeholder="Home Wi-Fi"
              required
            />
          </Field>
          <Field label="Шифрование">
            <Select
              value={wifiForm.encryption}
              onChange={(value) =>
                setWifiForm((current) => ({ ...current, encryption: value }))
              }
            >
              <option value="none">Без пароля</option>
              <option value="owe">OWE — шифрование без пароля</option>
              <option value="psk">WPA-PSK</option>
              <option value="psk2">WPA2-PSK</option>
              <option value="psk-mixed">WPA/WPA2 mixed</option>
              <option value="sae">WPA3-SAE</option>
              <option value="sae-mixed">WPA2/WPA3 mixed</option>
              {![
                'none',
                'owe',
                'psk',
                'psk2',
                'psk-mixed',
                'sae',
                'sae-mixed',
              ].includes(wifiForm.encryption) ? (
                <option value={wifiForm.encryption}>{wifiForm.encryption}</option>
              ) : null}
            </Select>
          </Field>
          {wifiForm.encryption !== 'none' && wifiForm.encryption !== 'owe' ? (
            <Field
              label="Новый пароль"
              hint={
                wifiEdit.key_set
                  ? 'Пароль уже задан. Оставьте поле пустым, чтобы не менять.'
                  : 'Для защищённой сети пароль обязателен, не короче 8 символов.'
              }
            >
              <TextInput
                type="password"
                value={wifiForm.key}
                onChange={(value) => setWifiForm((current) => ({ ...current, key: value }))}
                placeholder="Оставьте пустым, чтобы не менять"
                autoComplete="new-password"
              />
            </Field>
          ) : null}
          <div className="stack">
            <label className="check-row">
              <input
                type="checkbox"
                checked={wifiForm.hidden}
                onChange={(event) =>
                  setWifiForm((current) => ({ ...current, hidden: event.target.checked }))
                }
              />
              <span>Скрытая сеть (не показывать SSID)</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={wifiForm.disabled}
                onChange={(event) =>
                  setWifiForm((current) => ({ ...current, disabled: event.target.checked }))
                }
              />
              <span>Отключить эту Wi-Fi сеть</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={wifiForm.isolate}
                onChange={(event) =>
                  setWifiForm((current) => ({ ...current, isolate: event.target.checked }))
                }
              />
              <span>Изолировать клиентов друг от друга</span>
            </label>
          </div>
        </Modal>
      ) : null}

      {wifiDelete ? (
        <ConfirmDialog
          title="Удалить Wi-Fi сеть?"
          danger
          busy={wifiDeleteBusy}
          confirmLabel="Удалить"
          onCancel={() => setWifiDelete(null)}
          onConfirm={() => void deleteWifi()}
          message={
            <>
              <p>
                Сеть <strong>{wifiDelete.ssid || wifiDelete.name}</strong> ({wifiDelete.name}) будет
                удалена из конфигурации роутера.
              </p>
              <p className="muted-text">
                Подключённые к ней клиенты отключатся. Если роутер не в сети, удаление выполнится
                после подключения.
              </p>
            </>
          }
        />
      ) : null}

      {connectionOpen ? (
        <Modal
          title="Новое подключение"
          onClose={() => setConnectionOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConnectionOpen(false)} disabled={busy}>
                Отмена
              </Button>
              <Button
                onClick={() => void addConnection()}
                busy={busy}
                disabled={
                  connectionCatalogId
                    ? false
                    : !connectionLabel.trim() || connectionValue.trim().length < 8
                }
              >
                Добавить
              </Button>
            </>
          }
        >
          <InfoBanner>
            Ссылка или компактный секрет записывается только в отдельную секцию RoutX.
            Существующие правила и подключения не перезаписываются.
          </InfoBanner>
          <Field label="Тип">
            <Select
              value={connectionKind}
              onChange={(value) => {
                setConnectionKind(value as 'subscription' | 'vless');
                setConnectionCatalogId('');
              }}
            >
              <option value="subscription">Подписка (URL или каталог)</option>
              <option value="vless">VLESS/VMess/Trojan и др.</option>
            </Select>
          </Field>

          {connectionKind === 'subscription' ? (
            <Field
              label="Подписка из каталога"
              hint="Можно выбрать готовую подписку или вставить ссылку вручную."
            >
              <Select
                value={connectionCatalogId}
                onChange={(value) => {
                  setConnectionCatalogId(value);
                  if (value) {
                    const item = catalog.data?.items.find((entry) => entry.id === value);
                    if (item) {
                      setConnectionLabel(item.name);
                      setConnectionValue('');
                    }
                  }
                }}
              >
                <option value="">Вставить ссылку вручную</option>
                {(catalog.data?.items ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.owner_email ? ` · ${item.owner_email}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <Field label="Название">
            <TextInput
              value={connectionLabel}
              onChange={setConnectionLabel}
              placeholder="Например, основной провайдер"
            />
          </Field>

          {connectionCatalogId ? (
            <InfoBanner>
              Ссылка подписки берётся из каталога и не показывается. Если владелец обновит ссылку в
              каталоге, уже добавленное подключение на роутере не изменится.
            </InfoBanner>
          ) : (
            <>
              <div className="row">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConnectionCompactOpen((open) => !open)}
                >
                  {connectionCompactOpen ? 'Скрыть конструктор секрета' : 'Создать компактный секрет'}
                </Button>
              </div>
              {connectionCompactOpen ? (
                <CompactSecretForm
                  key={connectionKind}
                  kind={connectionKind}
                  onGenerated={setConnectionValue}
                />
              ) : null}
              <Field
                label={connectionKind === 'subscription' ? 'Ссылка на подписку' : 'Ссылка подключения'}
                hint={
                  connectionKind === 'subscription'
                    ? 'http(s)://… или готовый rc1.… секрет. Значение будет сохранено зашифрованным.'
                    : 'vless://, vmess://, trojan://, ss://, ssr://, hysteria2://, hy2://, tuic://, anytls://, socks:// или rc1.… секрет.'
                }
              >
                <textarea
                  className="input code-area"
                  rows={4}
                  value={connectionValue}
                  onChange={(event) => setConnectionValue(event.target.value)}
                />
              </Field>
            </>
          )}
        </Modal>
      ) : null}

      {editingConnection ? (
        <Modal
          title={`Изменить подключение «${editingConnection.label}»`}
          onClose={() => {
            setEditingConnection(null);
            setEditValue('');
            setEditCompactOpen(false);
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingConnection(null);
                  setEditValue('');
                  setEditCompactOpen(false);
                }}
                disabled={busy}
              >
                Отмена
              </Button>
              <Button
                onClick={() => void updateConnection()}
                busy={busy}
                disabled={
                  !editLabel.trim() ||
                  (editLabel.trim() === editingConnection.label && !editValue.trim())
                }
              >
                Сохранить
              </Button>
            </>
          }
        >
          <InfoBanner>
            Текущий секрет скрыт и не возвращается через API. Вставьте новую ссылку или компактный
            секрет — RoutX заменит его и применит изменения на роутере.
          </InfoBanner>
          <Field label="Название">
            <TextInput value={editLabel} onChange={setEditLabel} />
          </Field>
          <div className="row">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditCompactOpen((open) => !open)}
            >
              {editCompactOpen ? 'Скрыть конструктор секрета' : 'Создать компактный секрет'}
            </Button>
          </div>
          {editCompactOpen ? (
            <CompactSecretForm
              key={editingConnection.kind}
              kind={editingConnection.kind}
              onGenerated={setEditValue}
            />
          ) : null}
          <Field
            label="Новая ссылка или компактный секрет"
            hint="Оставьте поле пустым, чтобы изменить только название. Можно вставить rc1.… секрет."
          >
            <textarea
              className="input code-area"
              rows={4}
              value={editValue}
              onChange={(event) => setEditValue(event.target.value)}
              placeholder="vless://…, vmess://…, trojan://…, ss://…, hysteria2://…, tuic://…, anytls://…, socks://… или rc1.…"
            />
          </Field>
        </Modal>
      ) : null}

      {deletingConnection ? (
        <ConfirmDialog
          title="Удалить подключение?"
          danger
          busy={busy}
          confirmLabel="Удалить"
          onCancel={() => setDeletingConnection(null)}
          onConfirm={() => void deleteConnection()}
          message={
            <p>
              Подключение <strong>{deletingConnection.label}</strong> будет удалено из секции Router
              Control. Ваши собственные секции не изменятся.
            </p>
          }
        />
      ) : null}

      {manageTarget?.action === 'replace' ? (
        <Modal
          title={
            manageTarget.kind === 'subscription'
              ? 'Заменить подписку'
              : 'Заменить ссылку'
          }
          onClose={() => setManageTarget(null)}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setManageTarget(null)}
                disabled={manageBusy}
              >
                Отмена
              </Button>
              <Button
                onClick={() => void submitManage()}
                busy={manageBusy}
                disabled={manageValue.trim().length < 8}
              >
                Сохранить
              </Button>
            </>
          }
        >
          <p>
            Текущее значение: <code>{manageTarget.label}</code>
          </p>
          <Field
            label={
              manageTarget.kind === 'subscription'
                ? 'Новая ссылка на подписку'
                : 'Новая ссылка'
            }
          >
            <textarea
              className="input code-area"
              rows={3}
              value={manageValue}
              onChange={(event) => setManageValue(event.target.value)}
              placeholder={
                manageTarget.kind === 'subscription'
                  ? 'https://example.com/sub/...'
                  : 'vless://…, vmess://…, trojan://…, ss://…, hysteria2://…, tuic://…, anytls://…'
              }
            />
          </Field>
          <p className="muted-text small">
            Перед изменением создаётся снимок. Если применение не удастся, RoutX
            попробует вернуть предыдущую конфигурацию.
          </p>
        </Modal>
      ) : null}

      {manageTarget?.action === 'delete' ? (
        <ConfirmDialog
          title={
            manageTarget.kind === 'subscription'
              ? 'Удалить подписку?'
              : 'Удалить ссылку?'
          }
          danger
          busy={manageBusy}
          confirmLabel="Удалить"
          onCancel={() => setManageTarget(null)}
          onConfirm={() => void submitManage()}
          message={
            <>
              <p>
                Будет удалено: <code>{manageTarget.label}</code>.
              </p>
              <p className="muted-text">
                Перед удалением создаётся снимок. Если в секции не останется подключений,
                она будет выключена.
              </p>
            </>
          }
        />
      ) : null}

      {diffFlow ? (
        <DiffFlowModal
          routerId={id}
          templateId={diffFlow.templateId}
          revision={diffFlow.revision}
          templateName={diffFlow.name}
          onClose={() => setDiffFlow(null)}
          onChanged={() => {
            void detail.reload();
            void jobs.reload();
          }}
        />
      ) : null}

      {restoring ? (
        <ConfirmDialog
          title="Восстановить снимок?"
          danger
          busy={busy}
          confirmLabel="Восстановить"
          onCancel={() => setRestoring(null)}
          onConfirm={() => void restore()}
          message={
            <>
              <p>
                Конфигурация роутера будет заменена снимком от {formatDate(restoring.created_at)}.
                После записи служба перезапустится, состояние будет перечитано.
              </p>
              <p className="muted-text">
                Текущее состояние не сохраняется автоматически — при необходимости сначала создайте
                снимок.
              </p>
            </>
          }
        />
      ) : null}

      {binding ? (
        <Modal
          title="Токен привязки"
          wide
          onClose={() => setBinding(null)}
          footer={<Button onClick={() => setBinding(null)}>Готово</Button>}
        >
          <p className="page-sub">{binding.warning}</p>
          <Field label="Команда установки">
            <pre className="code-block">{binding.install_command}</pre>
          </Field>
          <p className="muted-text small">
            После успешной привязки установщик перезагрузит роутер автоматически.
          </p>
          <div className="row">
            <Button
              variant="ghost"
              onClick={() => {
                void copyText(binding.install_command).then((ok) =>
                  ok ? toast.success('Скопировано') : toast.error('Не удалось скопировать'),
                );
              }}
            >
              Скопировать
            </Button>
            <span className="muted-text">
              до {new Date(binding.expires_at).toLocaleTimeString('ru-RU')}
            </span>
          </div>
        </Modal>
      ) : null}

      {credential ? (
        <Modal
          title="Новый токен агента"
          onClose={() => setCredential(null)}
          footer={<Button onClick={() => setCredential(null)}>Готово</Button>}
        >
          <InfoBanner tone="warn">{credential.warning}</InfoBanner>
          <Field label="Токен" hint={`Префикс: ${credential.prefix}`}>
            <pre className="code-block">{credential.token}</pre>
          </Field>
          <p className="muted-text">
            Обновите токен в конфигурации RoutX на роутере. Старый токен продолжит работать{' '}
            {Math.round(credential.overlap_seconds / 60)} минут.
          </p>
        </Modal>
      ) : null}

      {renameOpen ? (
        <Modal
          title="Переименовать роутер"
          onClose={() => setRenameOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRenameOpen(false)} disabled={busy}>
                Отмена
              </Button>
              <Button onClick={() => void rename()} busy={busy} disabled={!newName.trim()}>
                Сохранить
              </Button>
            </>
          }
        >
          <Field label="Новое имя">
            <TextInput value={newName} onChange={setNewName} required />
          </Field>
        </Modal>
      ) : null}

      {installVersion ? (
        <ConfirmDialog
          title={`Установить sing-box ${installVersion.tag}?`}
          busy={busy}
          confirmLabel="Установить"
          onCancel={() => setInstallVersion(null)}
          onConfirm={() => void installSingBox()}
          message={
            <>
              <p>
                Устанавливается конкретная версия Extended из официального релиза. Текущий пакет
                sing-box будет удалён, затем установлен новый. Пока идёт установка, sing-box может
                быть временно недоступен — это ожидаемо и освобождает место. При неудаче Router
                Control попробует вернуть предыдущую версию/вариант.
              </p>
              <p className="muted-text">
                Это может прервать работу прокси на несколько минут. Пользовательские VLESS/Sub
                подключения не изменяются.
              </p>
            </>
          }
        />
      ) : null}

      {installVariant ? (
        <ConfirmDialog
          title={`Переключить sing-box на ${installVariant.label}?`}
          busy={busy}
          confirmLabel="Переключить"
          onCancel={() => setInstallVariant(null)}
          onConfirm={() => void installSingBoxVariant()}
          message={
            <>
              <p>
                Prokop удалит текущий пакет sing-box, затем установит вариант{' '}
                <strong>{installVariant.label}</strong>. Это освобождает место перед установкой.
                Пока идёт установка, sing-box может быть временно недоступен — это ожидаемо.
              </p>
              <p className="muted-text">
                Если новая версия не запустится, RoutX попробует автоматически вернуть{' '}
                {router.sing_box_previous_variant ?? router.sing_box_variant ?? 'предыдущий вариант'}.
                Пользовательские подключения не изменяются.
              </p>
            </>
          }
        />
      ) : null}

      {rollbackOpen ? (
        <ConfirmDialog
          title="Вернуть предыдущий sing-box?"
          busy={busy}
          confirmLabel="Вернуть"
          onCancel={() => setRollbackOpen(false)}
          onConfirm={() => void rollbackSingBox()}
          message={
            <p>
              Будет установлен предыдущий вариант:{' '}
              <strong>
                {router.sing_box_previous_variant ?? 'stable'}{' '}
                {router.sing_box_previous_version ?? ''}
              </strong>
              . Текущий пакет будет удалён перед установкой.
            </p>
          }
        />
      ) : null}
      {mappingAssignment ? (
        <Modal
          title="Сопоставление секций"
          onClose={() => setMappingAssignment(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setMappingAssignment(null)} disabled={mappingBusy}>
                Отмена
              </Button>
              <Button
                onClick={() => void saveMapping()}
                busy={mappingBusy}
                disabled={mappingSources.some((source) => !mappingTargets[source])}
              >
                Сохранить
              </Button>
            </>
          }
        >
          <p>
            Секции шаблона — логические. Выберите, к какой секции роутера применять каждую из них.
            В списке показаны названия так, как их видно в Prokop; физическое имя UCI —
            в подсказке. Например, логическую <code>router_control</code> можно привязать к
            секции, которая в Prokop тоже называется <code>router_control</code>.
          </p>
          {mappingBusy && mappingSources.length === 0 ? <Spinner /> : null}
          {mappingSources.map((source) => (
            <Field key={source} label={`Секция шаблона «${source}»`}>
              <Select
                value={mappingTargets[source] ?? ''}
                onChange={(value) =>
                  setMappingTargets((current) => ({ ...current, [source]: value }))
                }
              >
                <option value="">Выберите секцию роутера…</option>
                {routerSectionNames.map((name) => (
                  <option key={name} value={name}>
                    {sectionDisplay(name)}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
          {routerSectionNames.length === 0 ? (
            <InfoBanner tone="warn">
              На роутере ещё нет прочитанных секций. Нажмите «Прочитать состояние» и повторите.
            </InfoBanner>
          ) : null}
        </Modal>
      ) : null}

      {productOpen ? (
        <Modal
          title="Смена продукта"
          onClose={() => setProductOpen(false)}
          footer={
            <Button variant="ghost" onClick={() => setProductOpen(false)} disabled={productSwitchBusy}>
              Закрыть
            </Button>
          }
        >
          {productError ? <ErrorBanner message={productError} /> : null}
          {productNotice ? <InfoBanner>{productNotice}</InfoBanner> : null}
          <p className="page-sub">
            Смена продукта удаляет текущий пакет и ставит выбранный. Подписки и подключения RoutX
            переносятся автоматически; перед установкой создаётся резервная копия конфигурации.
          </p>
          {installedProducts.length > 0 ? (
            <div
              style={{
                border: '1px solid var(--line, rgba(120,90,120,.16))',
                borderRadius: 12,
                padding: 14,
                marginBottom: 12,
              }}
            >
              <strong>Установлено на роутере</strong>
              {installedProducts.map((installed) => {
                const active = installed.product === router.product;
                const packages = installed.packages ?? [];
                return (
                  <div key={installed.product} style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong>{PRODUCT_LABEL[installed.product] ?? installed.product}</strong>
                      <span className="muted-text small">
                        {installed.version ?? 'версия не определена'}
                      </span>
                      {active ? <StatusBadge status="success" label="активный" /> : null}
                    </div>
                    <div className="muted-text small">
                      {packages.length > 0
                        ? `Пакеты: ${packages.join(', ')}`
                        : 'Пакеты не определены'}
                    </div>
                    {!active && packages.length > 0 ? (
                      <div style={{ marginTop: 6 }}>
                        {packages.map((pkg) => (
                          <label
                            key={pkg}
                            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}
                          >
                            <input
                              type="checkbox"
                              checked={removePackagesSelected.includes(pkg)}
                              onChange={() => toggleRemovePackage(pkg)}
                              disabled={removePackagesBusy || productSwitchBusy}
                            />
                            {pkg}
                          </label>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={removePackagesBusy || productSwitchBusy}
                  onClick={() =>
                    setRemovePackagesSelected(
                      installedProducts
                        .filter((installed) => installed.product !== router.product)
                        .flatMap((installed) => installed.packages ?? []),
                    )
                  }
                >
                  Выбрать все лишние
                </Button>
                <Button
                  size="sm"
                  onClick={() => void removeSelectedPackages()}
                  busy={removePackagesBusy}
                  disabled={
                    removePackagesBusy || productSwitchBusy || removePackagesSelected.length === 0
                  }
                >
                  Удалить выбранные ({removePackagesSelected.length})
                </Button>
              </div>
              <p className="muted-text small">
                Пакеты активного продукта удалить нельзя. Удаление лишних пакетов помогает
                освободить место и убрать конфликты перед установкой.
              </p>
            </div>
          ) : (
            <p className="muted-text small">
              Список установленных пакетов появится после следующего опроса роутера.
            </p>
          )}
          {productLoading ? <Spinner label="Проверяем версии…" /> : null}
          {productItems.length === 0 && !productLoading ? (
            <p className="muted-text small">Каталог продуктов пуст.</p>
          ) : null}
          {productItems
            .slice()
            .sort(
              (left, right) =>
                Number(right.product === router.product) - Number(left.product === router.product),
            )
            .map((item) => {
            const installed = installedProducts.find((entry) => entry.product === item.product);
            const same = installed != null;
            const installedVersion =
              installed?.version ??
              (router.product === item.product
                ? item.current_version ?? router.product_version
                : null);
            const selected = productVersions[item.product] ?? item.latest_version ?? '';
            return (
              <div
                key={item.product}
                style={{
                  border: '1px solid var(--line, rgba(120,90,120,.16))',
                  borderRadius: 12,
                  padding: 14,
                  marginBottom: 12,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <strong>{item.label}</strong>
                  {same ? <StatusBadge status="success" label="установлен" /> : null}
                  {item.update_available ? (
                    <StatusBadge status="warning" label={`есть ${item.latest_version}`} />
                  ) : null}
                  <span className="muted-text small">{item.repo}</span>
                </div>
                <p className="muted-text small" style={{ margin: '8px 0 4px' }}>
                  Установлено: {same ? installedVersion ?? '—' : '—'} ·
                  Последняя: {item.latest_version ?? '—'}
                </p>
                {installed?.packages && installed.packages.length > 0 ? (
                  <p className="muted-text small">
                    Пакеты: {installed.packages.join(', ')}
                  </p>
                ) : null}
                {item.product === 'tachyon' ? (
                  <Field label="Версия Tachyon">
                    <Select
                      value={selected}
                      onChange={(value) =>
                        setProductVersions((current) => ({ ...current, [item.product]: value }))
                      }
                    >
                      {(item.releases.length > 0 ? item.releases : [{ version: selected, tag: selected, name: '', published_at: null, prerelease: false }]).map(
                        (release) => (
                          <option key={release.version} value={release.version}>
                            {release.version}
                            {release.prerelease ? ' · beta' : ''}
                          </option>
                        ),
                      )}
                    </Select>
                  </Field>
                ) : (
                  <p className="muted-text small">
                    Официальный установщик {item.label} ставит последнюю версию.
                  </p>
                )}
                {item.error ? <p className="muted-text small">GitHub: {item.error}</p> : null}
                <Button
                  size="sm"
                  onClick={() => void installProduct(item)}
                  busy={productSwitchBusy}
                  disabled={productSwitchBusy}
                >
                  {same
                    ? item.update_available
                      ? `Обновить до ${item.latest_version ?? ''}`
                      : 'Переустановить'
                    : `Установить ${item.label}`}
                </Button>
              </div>
            );
          })}
          {activeJob ? <JobProgress job={activeJob} label={activeJobLabel || 'Установка продукта'} /> : null}
        </Modal>
      ) : null}

      {purgeOpen ? (
        <Modal
          title="Удалить роутер навсегда?"
          onClose={() => setPurgeOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPurgeOpen(false)} disabled={purgeBusy}>
                Отмена
              </Button>
              <Button
                variant="danger"
                onClick={() => void purgeRouter()}
                busy={purgeBusy}
                disabled={purgeName.trim() !== router.name}
              >
                Удалить навсегда
              </Button>
            </>
          }
        >
          <p>
            Роутер <strong>{router.name}</strong> и все связанные данные будут удалены из базы:
            мониторинг, снимки, подключения, задания, назначения шаблонов и учётные данные агента.
            Это действие необратимо.
          </p>
          <p className="muted-text">
            На самом роутере Forkop/Prokop/Podkop и RoutX не удаляются. Агент получит отказ и перестанет
            передавать данные.
          </p>
          <Field label={`Для подтверждения введите имя «${router.name}»`}>
            <TextInput value={purgeName} onChange={setPurgeName} placeholder={router.name} />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
