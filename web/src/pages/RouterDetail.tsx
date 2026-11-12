import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffView, DiffBadge } from '../components/diff';
import { Link } from '../components/link';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBanner,
  Field,
  InfoBanner,
  JobProgress,
  LatencyChart,
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
  APPLY_STATUS,
  DRIFT,
  formatBytes,
  formatDate,
  formatRelative,
  JOB_STATUS,
  JOB_TYPE,
  PRODUCT_LABEL,
  proxyHealth,
  ROUTER_STATUS,
  statusTone,
} from '../lib/format';
import { navigate } from '../lib/router';
import { RouterRulesPanel } from './RouterRules';
import type {
  ApplyItem,
  ApplyRunDetail,
  BindingToken,
  CatalogSubscription,
  ConnectionSecretPreview,
  ConnectionsResponse,
  CredentialInfo,
  DiagnosticReportSummary,
  DiffItem,
  DnsBenchmarkState,
  DnsCandidateResult,
  DnsStatus,
  ExternalConnections,
  ExternalLink,
  ExternalSubscription,
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

function normalizeValue(value: unknown): string | string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => String(item));
  return typeof value === 'string' ? value : JSON.stringify(value);
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

function versionAtLeast(value: string | null | undefined, minimum: string): boolean {
  const parse = (input: string): number[] =>
    input
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const current = parse(value ?? '0');
  const required = parse(minimum);
  for (let index = 0; index < Math.max(current.length, required.length); index += 1) {
    const left = current[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
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

function itemsToDiff(items: ApplyItem[]): DiffItem[] {
  return items.map((item) => ({
    op: item.op === 'add' ? 'add' : item.op === 'delete' ? 'delete' : 'change',
    path: item.path,
    before: normalizeValue(item.value_before),
    after: normalizeValue(item.value_after),
  }));
}

function CompactSecretForm(props: {
  kind: 'subscription' | 'vless';
  onGenerated: (secret: string) => void;
}) {
  const toast = useToast();
  const [host, setHost] = useState('');
  const [port, setPort] = useState('443');
  const [credential, setCredential] = useState('');
  const [path, setPath] = useState('');
  const [sni, setSni] = useState('');
  const [transport, setTransport] = useState<'tcp' | 'ws' | 'grpc' | 'http'>('ws');
  const [security, setSecurity] = useState<'tls' | 'none'>('tls');
  const [flow, setFlow] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    secret: string;
    length: number;
    preview: ConnectionSecretPreview;
  } | null>(null);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{
        secret: string;
        length: number;
        preview: ConnectionSecretPreview;
      }>('/api/v1/connection-secrets', {
        method: 'POST',
        body: {
          kind: props.kind,
          host: host.trim(),
          port: Number(port),
          credential: credential.trim() || undefined,
          path: path.trim() || undefined,
          sni: sni.trim() || undefined,
          flow: props.kind === 'vless' ? flow.trim() || undefined : undefined,
          transport: props.kind === 'vless' ? transport : undefined,
          security: props.kind === 'vless' ? security : undefined,
        },
      });
      setResult(response);
      props.onGenerated(response.secret);
    } catch (caught) {
      setError(errorMessage(caught));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <InfoBanner>
        Секрет шифруется AES-256-GCM и содержит только домен/IP, порт и учётные данные.
        Ссылка на провайдера при этом не нужна.
      </InfoBanner>
      <div className="grid-2 grid-2-compact">
        <Field label="Домен или IP" hint="Куда подключаться.">
          <TextInput value={host} onChange={setHost} placeholder="vpn.example.com или 203.0.113.10" />
        </Field>
        <Field label="Порт" hint="1–65535.">
          <TextInput type="number" min={1} max={65535} value={port} onChange={setPort} />
        </Field>
        <Field
          label={props.kind === 'subscription' ? 'Токен подписки' : 'UUID или пароль'}
          hint={props.kind === 'subscription' ? 'Необязательно, если токен уже в пути.' : 'Обязательно для VLESS.'}
        >
          <TextInput
            value={credential}
            onChange={setCredential}
            placeholder={props.kind === 'subscription' ? 'Токен провайдера' : 'UUID или пароль'}
          />
        </Field>
        <Field
          label="Путь"
          hint={
            props.kind === 'subscription'
              ? 'Например, /sub/abc?token=…'
              : 'Путь для ws/http или serviceName для grpc.'
          }
        >
          <TextInput value={path} onChange={setPath} placeholder="/sub/abc или /ws" />
        </Field>
        {props.kind === 'vless' ? (
          <>
            <Field label="SNI" hint="По умолчанию равен домену.">
              <TextInput value={sni} onChange={setSni} placeholder="vpn.example.com" />
            </Field>
            <Field label="Транспорт">
              <Select
                value={transport}
                onChange={(value) => setTransport(value as 'tcp' | 'ws' | 'grpc' | 'http')}
              >
                <option value="ws">WebSocket</option>
                <option value="tcp">TCP</option>
                <option value="grpc">gRPC</option>
                <option value="http">HTTP/2</option>
              </Select>
            </Field>
            <Field label="Безопасность">
              <Select value={security} onChange={(value) => setSecurity(value as 'tls' | 'none')}>
                <option value="tls">TLS</option>
                <option value="none">Без TLS</option>
              </Select>
            </Field>
            <Field label="Flow" hint="Например, xtls-rprx-vision. Обычно пусто.">
              <TextInput value={flow} onChange={setFlow} placeholder="xtls-rprx-vision" />
            </Field>
          </>
        ) : null}
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      <div className="row">
        <Button
          size="sm"
          onClick={() => void generate()}
          busy={busy}
          disabled={!host.trim() || (props.kind === 'vless' && !credential.trim())}
        >
          Сгенерировать секрет
        </Button>
        {result ? (
          <span className="muted-text small">
            {result.length} символов · {result.preview.host}:{result.preview.port}
          </span>
        ) : null}
      </div>
      {result ? (
        <>
          <div className="row">
            <code className="code-block small inline-code compact-secret-value">{result.secret}</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void copyText(result.secret).then((ok) => {
                  if (ok) toast.success('Секрет скопирован');
                  else toast.error('Не удалось скопировать секрет');
                });
              }}
            >
              Скопировать
            </Button>
          </div>
          <p className="muted-text small">
            {result.preview.kind === 'subscription' ? 'Подписка' : 'VLESS'} ·{' '}
            {result.preview.credential_masked}
            {result.preview.path ? ` · ${result.preview.path}` : ''}
          </p>
        </>
      ) : null}
    </div>
  );
}

function DnsApplyModal(props: {
  routerId: string;
  proposal: {
    dns_type: 'udp' | 'doh';
    dns_server: string[];
    bootstrap_dns_server: string[];
  };
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<'preparing' | 'ready' | 'applying' | 'success' | 'error'>(
    'preparing',
  );
  const [run, setRun] = useState<{
    apply_run_id: string;
    diff: DiffItem[];
    diff_hash: string;
    warnings: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const onAppliedRef = useRef(props.onApplied);

  useEffect(() => {
    onAppliedRef.current = props.onApplied;
  }, [props.onApplied]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await api<{
          apply_run_id: string;
          diff: DiffItem[];
          diff_hash: string;
          warnings: string[];
        }>(`/api/v1/routers/${props.routerId}/dns/diff`, {
          method: 'POST',
          body: props.proposal,
        });
        if (!active) return;
        setRun(response);
        setPhase(response.diff.length === 0 ? 'success' : 'ready');
        if (response.diff.length === 0) await onAppliedRef.current();
      } catch (caught) {
        if (active) {
          setError(errorMessage(caught));
          setPhase('error');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [props.routerId, props.proposal]);

  async function confirm(): Promise<void> {
    if (!run) return;
    setPhase('applying');
    setError(null);
    try {
      const response = await api<{ job: Job }>(
        `/api/v1/apply-runs/${run.apply_run_id}/confirm`,
        {
          method: 'POST',
          body: { diff_hash: run.diff_hash },
        },
      );
      setJob(response.job);
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const status = await api<{ job: Job }>(`/api/v1/jobs/${response.job.id}`);
        setJob(status.job);
        if (status.job.status !== 'queued' && status.job.status !== 'running') {
          if (status.job.status === 'success') {
            setPhase('success');
            toast.success('DNS применён');
            await onAppliedRef.current();
          } else {
            setError(status.job.error?.message ?? 'Применение DNS не завершилось');
            setPhase('error');
          }
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      setError('Применение DNS выполняется дольше обычного');
      setPhase('error');
    } catch (caught) {
      setError(errorMessage(caught));
      setPhase('error');
    }
  }

  async function cancelRun(): Promise<void> {
    if (run && phase === 'ready') {
      await api(`/api/v1/apply-runs/${run.apply_run_id}/cancel`, { method: 'POST' }).catch(
        () => undefined,
      );
    }
    props.onClose();
  }

  return (
    <Modal
      title="Применить DNS"
      wide
      onClose={cancelRun}
      footer={
        phase === 'success' ? (
          <Button onClick={props.onClose}>Готово</Button>
        ) : phase === 'error' ? (
          <Button onClick={props.onClose}>Закрыть</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => void cancelRun()} disabled={phase === 'applying'}>
              Отмена
            </Button>
            <Button
              onClick={() => void confirm()}
              busy={phase === 'applying'}
              disabled={!run || phase !== 'ready'}
            >
              Применить
            </Button>
          </>
        )
      }
    >
      {phase === 'preparing' ? <Spinner label="Сравниваем DNS-настройки…" /> : null}
      {phase === 'applying' ? (
        <JobProgress job={job} label="Применяем DNS-настройки" />
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
      {run?.warnings.map((warning) => (
        <InfoBanner key={warning} tone="warn">
          {warning}
        </InfoBanner>
      ))}
      {run ? (
        <>
          <InfoBanner>
            Будет создан снимок, затем изменены только глобальные DNS-настройки Prokop/Forkop.
            После применения выполнится проверка; при ошибке — откат.
          </InfoBanner>
          <div className="kv">
            <span>Тип</span>
            <strong>{props.proposal.dns_type.toUpperCase()}</strong>
            <span>Серверы</span>
            <strong>{props.proposal.dns_server.join(' · ')}</strong>
            <span>Bootstrap</span>
            <strong>{props.proposal.bootstrap_dns_server.join(' · ')}</strong>
            <span>Изменений</span>
            <strong>{run.diff.length}</strong>
          </div>
          {run.diff.length > 0 ? <DiffView items={run.diff} /> : null}
        </>
      ) : null}
      {phase === 'success' ? (
        <InfoBanner>DNS-настройки применены. Проверьте статус службы и доступность интернета.</InfoBanner>
      ) : null}
    </Modal>
  );
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
          label="sing-box"
          value={router.sing_box_version ?? 'не установлен'}
          hint={router.sing_box_variant ?? 'вариант неизвестен'}
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
        <div className="grid-2">
          <Panel
            title="Управляемые параметры"
            subtitle={`${Object.keys(state?.managed ?? {}).length} путей в снимке состояния. Это технические пути UCI: секции в Prokop и панели показываются по label.`}
            actions={
              <TextInput
                value={stateQuery}
                onChange={setStateQuery}
                placeholder="Фильтр по пути"
                type="search"
              />
            }
          >
            {!state ? (
              <Empty>Состояние ещё не собрано. Нажмите «Прочитать состояние».</Empty>
            ) : managedEntries.length === 0 ? (
              <Empty>Параметров не найдено.</Empty>
            ) : (
              <div className="state-list">
                {managedEntries.slice(0, 200).map(([path, value]) => (
                  <div key={path} className="state-row">
                    <code>{path}</code>
                    <span>{Array.isArray(value) ? value.join(', ') : value ?? '—'}</span>
                  </div>
                ))}
                {managedEntries.length > 200 ? (
                  <p className="muted-text small">Показаны первые 200 из {managedEntries.length}.</p>
                ) : null}
              </div>
            )}
          </Panel>

          <div className="stack">
            <Panel title="Служба и доступность">
              <div className="kv">
                <span>Состояние</span>
                <strong>{serviceText(state?.service)}</strong>
                <span>Health</span>
                <strong>{healthText(state?.health)}</strong>
                <span>Прокси</span>
                <strong>{proxyHealth(latest?.proxy_health)}</strong>
                <span>Последний замер</span>
                <strong>{latest ? formatDate(latest.ts) : '—'}</strong>
                <span>Источник состояния</span>
                <strong>{state?.source ?? '—'}</strong>
                <span>Собрано</span>
                <strong>{formatDate(state?.collected_at)}</strong>
                <span>Автозапуск {PRODUCT_LABEL[router.product] ?? ''}</span>
                <strong>
                  {!productSvc.present
                    ? 'нет данных'
                    : productSvc.enabled === null
                      ? 'неизвестно'
                      : productSvc.enabled
                        ? 'включён'
                        : 'выключен'}
                </strong>
                <span>Автозапуск sing-box</span>
                <strong>{singBoxAutostartLabel}</strong>
                <span>Автозапуск пары</span>
                <strong>{autostartEnabled ? 'включён' : autostartPartial ? 'частично' : 'выключен'}</strong>
              </div>
              <div className="row">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void serviceAction('restart')}
                  disabled={!canMutate || serviceBusy !== null}
                  busy={serviceBusy === 'restart'}
                >
                  Перезапустить
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void serviceAction('start')}
                  disabled={!canMutate || serviceBusy !== null}
                  busy={serviceBusy === 'start'}
                >
                  Запустить
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (window.confirm('Остановить службу прокси на роутере?')) void serviceAction('stop');
                  }}
                  disabled={!canMutate || serviceBusy !== null}
                  busy={serviceBusy === 'stop'}
                >
                  Остановить
                </Button>
              </div>
              {autostartPartial ? (
                <InfoBanner tone="warn">
                  Отдельный автозапуск sing-box включён, но автозапуск {productLabel} выключен.
                  После перезагрузки sing-box может подняться без управления продуктом. Включите
                  автостарт {productLabel}, чтобы поднимались обе службы.
                </InfoBanner>
              ) : null}
              {productSvc.present ? (
                <div className="row" style={{ marginTop: 8 }}>
                  {autostartEnabled ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Выключить автозапуск ${productLabel}? После перезагрузки роутера прокси и sing-box не запустятся автоматически. Сейчас службы продолжат работать.`,
                          )
                        ) {
                          void serviceAction('disable');
                        }
                      }}
                      disabled={!canMutate || serviceBusy !== null}
                      busy={serviceBusy === 'disable'}
                    >
                      Выключить автостарт
                    </Button>
                  ) : (
                    <Button
                      variant="subtle"
                      size="sm"
                      onClick={() => void serviceAction('enable')}
                      disabled={!canMutate || serviceBusy !== null}
                      busy={serviceBusy === 'enable'}
                    >
                      Включить автостарт
                    </Button>
                  )}
                </div>
              ) : null}
              <p className="muted-text small" style={{ margin: '8px 0 0' }}>
                Автозапуск включает {productLabel}. При старте {productLabel} сам запускает
                sing-box и намеренно отключает отдельный автозапуск sing-box — так устроены Prokop
                и Forkop. Поэтому после перезагрузки поднимаются обе службы, а отдельная галочка
                sing-box не нужна. Включение не запускает службы сразу, выключение не
                останавливает их.
              </p>
            </Panel>

            <Panel title="Возможности агента">
              {state?.capabilities ? (
                <pre className="code-block small">{JSON.stringify(state.capabilities, null, 2)}</pre>
              ) : (
                <Empty>Агент ещё не сообщал о возможностях.</Empty>
              )}
            </Panel>
          </div>
        </div>
      ) : null}

      {tab === 'dns' ? (
        <div className="stack">
          {dnsStatus.error ? (
            <ErrorBanner message={dnsStatus.error} onRetry={() => void dnsStatus.reload()} />
          ) : null}

          <Panel
            title="DNS Prokop/Forkop"
            subtitle="Глобальные DNS-настройки: тип, основные серверы и bootstrap. Секции с собственным DNS здесь не меняются."
            actions={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void dnsStatus.reload()}
                busy={dnsStatus.loading}
              >
                Обновить
              </Button>
            }
          >
            {dnsStatus.loading && !dnsData ? <Spinner /> : null}
            {!agentSupportsDns ? (
              <InfoBanner tone="warn">
                Агент {router.agent_version ?? 'неизвестной версии'} не поддерживает DNS-бенчмарк.
                Нужен агент 1.1.0 или новее.
              </InfoBanner>
            ) : null}
            {dnsData?.warnings.map((warning) => (
              <InfoBanner key={warning} tone="warn">
                {warning}
              </InfoBanner>
            ))}

            {dnsData?.current ? (
              <div className="kv">
                <span>Тип</span>
                <strong>{dnsData.current.dns_type.toUpperCase()}</strong>
                <span>Основные серверы</span>
                <strong>{dnsData.current.dns_server.join(' · ') || '—'}</strong>
                <span>Bootstrap</span>
                <strong>{dnsData.current.bootstrap_dns_server.join(' · ') || '—'}</strong>
                <span>Detour</span>
                <strong>
                  {dnsData.current.detour_enabled
                    ? `включён · ${dnsData.current.detour_section ?? 'секция не выбрана'}`
                    : 'выключен'}
                </strong>
                <span>Состояние прочитано</span>
                <strong>{formatDate(dnsData.state_collected_at)}</strong>
              </div>
            ) : (
              <Empty>
                Состояние ещё не прочитано. Нажмите «Прочитать состояние» на вкладке «Обзор».
              </Empty>
            )}

            <div className="row">
              <Button
                onClick={() => void startDnsBenchmark()}
                busy={dnsBusy}
                disabled={!online || dnsRunning || !agentSupportsDns}
              >
                Проверить DNS
              </Button>
              {dnsRunning ? (
                <Button variant="ghost" onClick={() => void cancelDnsBenchmark()}>
                  Отменить
                </Button>
              ) : null}
            </div>

            {dnsRunning ? (
              <JobProgress job={dnsJob} label={dnsCurrent || 'Проверяем DNS…'} />
            ) : null}

            {dnsError ? <ErrorBanner message={dnsError} /> : null}
          </Panel>

          {dnsBenchmark ? (
            <Panel
              title="Результаты DNS"
              subtitle={`${dnsBenchmark.results.length} серверов · ${dnsBenchmark.domains.length} доменов · ${dnsBenchmark.rounds} замеров${dnsJob?.finished_at ? ` · ${formatDate(dnsJob.finished_at)}` : ''}. Показаны только успешные и частичные результаты; фильтрующие DNS помечены.`}
            >
              {dnsBenchmark.results.some((item) => item.suspect) ? (
                <InfoBanner tone="warn">
                  UDP-ответы быстрее 5 мс часто означают локальный кэш или перехват DNS
                  провайдером. Такие серверы не попадают в рекомендацию по умолчанию, но остаются
                  в таблице.
                </InfoBanner>
              ) : null}
              <div className="grid-2 grid-2-compact">
                {(['udp', 'doh'] as const).map((type) => {
                  const best = dnsBenchmark.recommendations[type] ?? [];
                  return (
                    <div className="dns-best" key={type}>
                      <div className="dns-best-head">
                        <strong>Лучший {type === 'udp' ? 'UDP' : 'DoH'}</strong>
                        {best.length > 0 ? (
                          <span className="muted-text small">
                            {best[0]!.median_ms != null
                              ? `${best[0]!.median_ms.toFixed(1)} мс`
                              : '—'}{' '}
                            · потери {best[0]!.loss_pct}%
                          </span>
                        ) : null}
                      </div>
                      {best.length > 0 ? (
                        <>
                          {best.map((item) => (
                            <p key={item.id} className="small">
                              {item.provider} · <span className="mono">{item.address}</span>
                            </p>
                          ))}
                          <Button
                            size="sm"
                            variant="subtle"
                            onClick={() => chooseDnsPair(type, best)}
                          >
                            Выбрать {type === 'udp' ? 'UDP' : 'DoH'}
                          </Button>
                        </>
                      ) : (
                        <p className="muted-text small">
                          Нет подходящих нефильтрующих серверов. Можно выбрать вручную из таблицы.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Сервер</th>
                      <th>Протокол</th>
                      <th>Медиана</th>
                      <th>p95</th>
                      <th>Потери</th>
                      <th>Статус</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {dnsResults.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {item.provider}
                          {item.filtered ? (
                            <span className="badge badge-warn" style={{ marginLeft: 6 }}>
                              фильтрует
                            </span>
                          ) : null}
                          {item.suspect ? (
                            <span className="badge badge-warn" style={{ marginLeft: 6 }}>
                              возможно перехват
                            </span>
                          ) : null}
                          <div className="mono small muted-text">{item.address}</div>
                          {item.error ? (
                            <div className="small muted-text">ошибка: {item.error}</div>
                          ) : null}
                        </td>
                        <td>{item.protocol.toUpperCase()}</td>
                        <td>
                          {item.median_ms != null ? `${item.median_ms.toFixed(1)} мс` : '—'}
                        </td>
                        <td>{item.p95_ms != null ? `${item.p95_ms.toFixed(1)} мс` : '—'}</td>
                        <td>{item.loss_pct}%</td>
                        <td>
                          <StatusBadge
                            status={
                              item.status === 'healthy'
                                ? 'success'
                                : item.status === 'partial'
                                  ? 'warning'
                                  : 'error'
                            }
                            label={item.status}
                          />
                        </td>
                        <td>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              const sameType = dnsResults
                                .filter(
                                  (candidate) =>
                                    candidate.protocol === item.protocol &&
                                    candidate.id !== item.id,
                                )
                                .slice(0, 1);
                              chooseDnsPair(item.protocol, [item, ...sameType]);
                            }}
                          >
                            Выбрать
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}

          {dnsChoice ? (
            <Panel title="Выбранный DNS" subtitle="Перед применением будет показан diff, создан снимок и запрошено подтверждение.">
              <div className="kv">
                <span>Тип</span>
                <strong>{dnsChoice.type.toUpperCase()}</strong>
                <span>Основной список</span>
                <strong>{dnsChoice.servers.join(' · ')}</strong>
                <span>Bootstrap</span>
                <strong>{dnsBootstrap.join(' · ') || '—'}</strong>
              </div>
              {!dnsCanApply ? (
                <InfoBanner tone="warn">
                  Применение сейчас недоступно: проверьте предупреждения выше, состояние роутера,
                  шаблон и detour.
                </InfoBanner>
              ) : null}
              <Button onClick={() => setDnsApplyOpen(true)} disabled={!dnsCanApply}>
                Применить DNS
              </Button>
            </Panel>
          ) : null}

          {dnsApplyOpen && dnsProposal ? (
            <DnsApplyModal
              routerId={id}
              proposal={dnsProposal}
              onClose={() => setDnsApplyOpen(false)}
              onApplied={async () => {
                await Promise.all([dnsStatus.reload(), dnsLatest.reload(), detail.reload()]);
              }}
            />
          ) : null}
        </div>
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
        <Panel
          title="Снимки конфигурации"
          subtitle="Локальные снимки RoutX и нативные снимки Prokop. Секреты не выгружаются на сервер."
          actions={
            <Button size="sm" onClick={() => void createSnapshot()} busy={snapshotBusy} disabled={!canMutate}>
              Создать снимок
            </Button>
          }
        >
          {snapshots.loading && !snapshots.data ? (
            <Spinner />
          ) : (snapshots.data?.items.length ?? 0) === 0 ? (
            <Empty>Снимков пока нет.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Создан</th>
                    <th>Тип</th>
                    <th>Причина</th>
                    <th>Размер</th>
                    <th>SHA-256</th>
                    <th>Истекает</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {snapshots.data!.items.map((snapshot) => (
                    <tr key={snapshot.id}>
                      <td>{formatDate(snapshot.created_at)}</td>
                      <td>{snapshot.kind === 'native' ? 'Prokop (нативный)' : 'RoutX (локальный)'}</td>
                      <td>{snapshot.reason}</td>
                      <td>{formatBytes(snapshot.size_bytes)}</td>
                      <td className="mono small">{snapshot.sha256?.slice(0, 16) ?? '—'}…</td>
                      <td className="muted-text small">{formatDate(snapshot.expires_at)}</td>
                      <td>
                        <Button
                          size="sm"
                          variant="subtle"
                          disabled={!canMutate}
                          onClick={() => setRestoring(snapshot)}
                        >
                          Восстановить
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}

      {tab === 'metrics' ? (
        <div className="stack">
          <Panel
            title="Задержка прокси"
            subtitle="Прокси-здоровье измеряется отдельно от доступности роутера."
            actions={
              <div className="toolbar">
                <Select value={String(hours)} onChange={(value) => setHours(Number(value))}>
                  <option value="6">6 часов</option>
                  <option value="24">24 часа</option>
                  <option value="72">3 суток</option>
                  <option value="168">7 суток</option>
                </Select>
                <Button size="sm" variant="ghost" onClick={() => void metrics.reload()} busy={metrics.loading}>
                  Обновить
                </Button>
              </div>
            }
          >
            {metrics.error ? <ErrorBanner message={metrics.error} onRetry={() => void metrics.reload()} /> : null}
            {metrics.loading && !metrics.data ? <Spinner /> : <LatencyChart points={chartPoints} />}
            {latest ? (
              <p className="muted-text small">
                Последний замер: {formatDate(latest.ts)} · прокси {proxyHealth(latest.proxy_health)} ·
                живых соединений: {latest.total_tags !== null && latest.failed_tags !== null
                  ? `${latest.total_tags - latest.failed_tags}/${latest.total_tags}`
                  : '—'}
              </p>
            ) : null}
          </Panel>

          <Panel
            title="Нестабильные соединения"
            subtitle="Соединения, которые чаще всего не отвечали. Группа остаётся рабочей, если есть живые резервные соединения."
            actions={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void connectionLosses.reload()}
                busy={connectionLosses.loading}
              >
                Обновить
              </Button>
            }
          >
            {connectionLosses.error ? (
              <ErrorBanner
                message={connectionLosses.error}
                onRetry={() => void connectionLosses.reload()}
              />
            ) : null}
            {connectionLosses.loading && !connectionLosses.data ? (
              <Spinner />
            ) : (connectionLosses.data?.items.length ?? 0) === 0 ? (
              <Empty>За выбранный период потерь связи не было.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Соединение</th>
                      <th>Потерь связи</th>
                      <th>Неудачных проверок</th>
                      <th>Последняя потеря</th>
                      <th>Сейчас</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connectionLosses.data!.items.map((item) => (
                      <tr key={item.tag}>
                        <td>
                          <code>{item.tag}</code>
                        </td>
                        <td>
                          <strong>{item.losses}</strong>
                        </td>
                        <td className="muted-text small">
                          {item.failed_samples} из {item.total_samples}
                        </td>
                        <td className="muted-text small">
                          {item.last_failure ? formatRelative(item.last_failure) : '—'}
                        </td>
                        <td>
                          {item.down_now ? (
                            <StatusBadge status="warning" label="не отвечает" />
                          ) : (
                            <StatusBadge status="success" label="отвечает" />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted-text small">
              Потерей считается эпизод, когда соединение перестало отвечать и затем
              восстановилось. Показаны 10 самых нестабильных соединений за выбранный период.
            </p>
          </Panel>
        </div>
      ) : null}

      {tab === 'diagnostics' ? (
        <Panel
          title="Диагностические отчёты"
          subtitle="Только маскированные отчёты. Полный отчёт включает больше проверок, но не секреты."
          actions={
            <div className="toolbar">
              <Button
                size="sm"
                variant="ghost"
                disabled={!canMutate}
                onClick={async () => {
                  try {
                    await api('/api/v1/diagnostics', {
                      method: 'POST',
                      body: { router_ids: [id], kind: 'quick' },
                    });
                    toast.info('Быстрая диагностика запущена');
                    await diagnostics.reload();
                  } catch (caught) {
                    toast.error(errorMessage(caught));
                  }
                }}
              >
                Быстрая
              </Button>
              <Button
                size="sm"
                disabled={!canMutate}
                onClick={async () => {
                  try {
                    await api('/api/v1/diagnostics', {
                      method: 'POST',
                      body: { router_ids: [id], kind: 'full' },
                    });
                    toast.info('Полная диагностика запущена');
                    await diagnostics.reload();
                  } catch (caught) {
                    toast.error(errorMessage(caught));
                  }
                }}
              >
                Полная
              </Button>
            </div>
          }
        >
          {diagnostics.loading && !diagnostics.data ? (
            <Spinner />
          ) : (diagnostics.data?.items.length ?? 0) === 0 ? (
            <Empty>Отчётов пока нет.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Создан</th>
                  <th>Тип</th>
                  <th>Продукт</th>
                  <th>Размер</th>
                  <th>Истекает</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {diagnostics.data!.items.map((report) => (
                  <tr key={report.id}>
                    <td>{formatDate(report.created_at)}</td>
                    <td>{report.kind === 'full' ? 'Полная' : 'Быстрая'}</td>
                    <td>{PRODUCT_LABEL[report.product] ?? report.product}</td>
                    <td>{formatBytes(report.size_bytes)}</td>
                    <td className="muted-text small">{formatDate(report.expires_at)}</td>
                    <td>
                      <Link className="btn btn-ghost btn-sm" to={`/diagnostics/${report.id}`}>
                        Открыть
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      ) : null}

      {tab === 'singbox' ? (
        <div className="stack">
          <Panel
            title="Вариант sing-box"
            subtitle="Prokop удаляет текущий пакет перед установкой нового варианта, затем ставит новый. При неудаче RoutX попробует вернуть предыдущий."
          >
            <div className="kv">
              <span>Сейчас</span>
              <strong>
                {router.sing_box_variant ? `${router.sing_box_variant} · ` : ''}
                {router.sing_box_version ?? 'не установлен'}
              </strong>
              <span>Предыдущая</span>
              <strong>
                {router.sing_box_previous_variant || router.sing_box_previous_version
                  ? `${router.sing_box_previous_variant ?? ''} ${router.sing_box_previous_version ?? ''}`.trim()
                  : 'нет'}
              </strong>
            </div>
            <div className="variant-grid">
              {(variants.data?.items ?? []).map((variant) => {
                const active = currentVariantId === variant.id;
                const selected = selectedVariantId === variant.id;
                return (
                  <button
                    key={variant.id}
                    type="button"
                    aria-pressed={selected}
                    className={`variant-card ${active ? 'variant-card-active' : ''} ${
                      selected ? 'variant-card-selected' : ''
                    }`}
                    disabled={busy}
                    onClick={() => setSelectedVariantId(variant.id)}
                  >
                    <strong>{variant.label}</strong>
                    <span>{variant.description}</span>
                    {active ? <em>установлен</em> : selected ? <em>выбран</em> : null}
                  </button>
                );
              })}
            </div>
            <p className="muted-text small" style={{ marginTop: 0 }}>
              Выберите вариант — ниже появятся доступные версии или способ установки.
            </p>
            {variants.error ? <ErrorBanner message={variants.error} /> : null}
            <div className="row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void checkSingBox()}
                busy={busy}
                disabled={!canMutate}
              >
                Проверить обновления
              </Button>
              <Button
                size="sm"
                variant="subtle"
                onClick={() => setRollbackOpen(true)}
                disabled={
                  !canMutate ||
                  (!router.sing_box_previous_variant && !router.sing_box_previous_version)
                }
              >
                Вернуть предыдущую
              </Button>
            </div>
          </Panel>

          <Panel
            title="Текущая версия"
            subtitle="Вариант и версия sing-box на роутере."
            actions={
              <Link className="btn btn-ghost btn-sm" to="/rollouts">
                Поэтапное обновление
              </Link>
            }
          >
            <div className="kv">
              <span>Версия</span>
              <strong>{router.sing_box_version ?? 'не установлен'}</strong>
              <span>Вариант</span>
              <strong>{router.sing_box_variant ?? '—'}</strong>
              <span>Проверка обновлений</span>
              <strong>{isAdmin ? 'доступна' : 'только администратор'}</strong>
            </div>
          </Panel>

          <Panel
            title={`Версии для ${selectedVariant?.label ?? 'выбранного варианта'}`}
            subtitle={
              selectedVariantId === 'extended'
                ? 'Доступные версии Extended из официального каталога. При установке текущий пакет удаляется, затем ставится выбранная версия.'
                : selectedVariantId === 'extended_compressed'
                  ? 'Compressed ставится последней сборкой из каталога Extended. Выбор конкретной версии для compressed не поддерживается: Prokop при выборе версии переключает на Extended.'
                  : 'Этот вариант ставится последней версией из пакетного репозитория Prokop/Forkop. Список конкретных версий для него недоступен.'
            }
            actions={
              isSuperadmin && selectedVariantId === 'extended' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void refreshSingBoxCatalog()}
                  busy={busy}
                >
                  Обновить каталог
                </Button>
              ) : null
            }
          >
            {variants.loading && !variants.data ? (
              <Spinner />
            ) : selectedVariantId === 'extended' ? (
              versions.loading && !versions.data ? (
                <Spinner />
              ) : (versions.data?.items.length ?? 0) === 0 ? (
                <div className="stack">
                  <Empty>
                    Каталог пуст. Нажмите «Обновить каталог» или обновите его на странице
                    sing-box.
                  </Empty>
                  <div className="row">
                    <Button
                      size="sm"
                      variant="subtle"
                      disabled={!canMutate || busy}
                      onClick={() => selectedVariant && setInstallVariant(selectedVariant)}
                    >
                      Установить последнюю Extended
                    </Button>
                  </div>
                </div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Версия</th>
                      <th>Опубликована</th>
                      <th>SHA-256</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {versions.data!.items.slice(0, 20).map((version) => (
                      <tr key={version.tag}>
                        <td>
                          {version.tag}
                          {version.tag === router.sing_box_version ? (
                            <span className="muted-text small"> · установлена</span>
                          ) : null}
                        </td>
                        <td className="muted-text small">{formatDate(version.published_at)}</td>
                        <td className="mono small">{version.asset_sha256?.slice(0, 16) ?? '—'}…</td>
                        <td>
                          <Button
                            size="sm"
                            variant={version.tag === router.sing_box_version ? 'ghost' : 'primary'}
                            disabled={!canMutate || version.tag === router.sing_box_version}
                            onClick={() => setInstallVersion(version)}
                          >
                            Установить
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : selectedVariantId === 'extended_compressed' ? (
              <div className="stack">
                {versions.data?.items[0] ? (
                  <p className="muted-text small">
                    Последний релиз Extended в каталоге:{' '}
                    <strong>{versions.data.items[0].tag}</strong>. Compressed-сборка ставится из
                    этого релиза.
                  </p>
                ) : null}
                <div className="row">
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={!canMutate || busy || selectedVariantActive}
                    onClick={() => selectedVariant && setInstallVariant(selectedVariant)}
                  >
                    {selectedVariantActive
                      ? 'Установлен'
                      : `Установить последнюю ${selectedVariant?.label ?? 'compressed'}`}
                  </Button>
                </div>
              </div>
            ) : selectedVariantId ? (
              <div className="row">
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={!canMutate || busy || selectedVariantActive}
                  onClick={() => selectedVariant && setInstallVariant(selectedVariant)}
                >
                  {selectedVariantActive
                    ? 'Установлен'
                    : `Установить последнюю ${selectedVariant?.label ?? ''}`}
                </Button>
              </div>
            ) : (
              <Spinner />
            )}
          </Panel>
        </div>
      ) : null}

      {tab === 'jobs' ? (
        <Panel
          title="История задач"
          actions={
            <Button size="sm" variant="ghost" onClick={() => void jobs.reload()} busy={jobs.loading}>
              Обновить
            </Button>
          }
        >
          {jobs.loading && !jobs.data ? (
            <Spinner />
          ) : (jobs.data?.items.length ?? 0) === 0 ? (
            <Empty>Задач пока нет.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Создана</th>
                  <th>Тип</th>
                  <th>Статус</th>
                  <th>Длительность</th>
                  <th>Ошибка</th>
                </tr>
              </thead>
              <tbody>
                {jobs.data!.items.map((job) => (
                  <tr key={job.id}>
                    <td className="small">{formatDate(job.created_at)}</td>
                    <td>{JOB_TYPE[job.type] ?? job.type}</td>
                    <td>
                      <StatusBadge status={job.status} label={JOB_STATUS[job.status] ?? job.status} />
                    </td>
                    <td className="muted-text small">
                      {job.started_at && job.finished_at
                        ? `${Math.max(
                            0,
                            Math.round(
                              (Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000,
                            ),
                          )} с`
                        : '—'}
                    </td>
                    <td className="small">{job.error?.message ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      ) : null}

      {tab === 'settings' ? (
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

function CredentialPanel({ routerId }: { routerId: string }) {
  const info = useApi<CredentialInfo>(`/api/v1/routers/${routerId}/credential-info`);
  const credential = info.data?.credential;
  if (info.loading && !info.data) return <Spinner />;
  if (!credential) return <Empty>Агент ещё не привязан.</Empty>;
  return (
    <div className="kv">
      <span>Префикс токена</span>
      <strong className="mono">{credential.prefix}</strong>
      <span>Создан</span>
      <strong>{formatDate(credential.created_at)}</strong>
      <span>Ротирован</span>
      <strong>{formatDate(credential.rotated_at)}</strong>
      <span>Отозван</span>
      <strong>{formatDate(credential.revoked_at)}</strong>
    </div>
  );
}

function DiffFlowModal(props: {
  routerId: string;
  templateId: string;
  revision: number;
  templateName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'loading' | 'ready' | 'applying' | 'error'>(
    'starting',
  );
  const [job, setJob] = useState<Job | null>(null);
  const [run, setRun] = useState<ApplyRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function poll(jobId: string): Promise<void> {
      if (cancelled) return;
      try {
        const res = await api<{ job: Job }>(`/api/v1/jobs/${jobId}`);
        if (cancelled) return;
        setJob(res.job);
        if (res.job.status === 'queued' || res.job.status === 'running') {
          timer = window.setTimeout(() => void poll(jobId), 1500);
          return;
        }
        if (res.job.status !== 'success') {
          setPhase('error');
          setError(res.job.error?.message ?? 'Сравнение не завершилось успешно');
          return;
        }
        const applyRunId =
          typeof res.job.result?.apply_run_id === 'string' ? res.job.result.apply_run_id : null;
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
        const res = await api<{ job: Job }>(`/api/v1/routers/${props.routerId}/diff`, {
          method: 'POST',
          body: { template_id: props.templateId, revision: props.revision },
        });
        if (cancelled) return;
        setJob(res.job);
        setPhase('waiting');
        void poll(res.job.id);
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
  }, [props.routerId, props.templateId, props.revision]);

  async function confirm(): Promise<void> {
    if (!run) return;
    setPhase('applying');
    try {
      await api(`/api/v1/apply-runs/${run.apply_run.id}/confirm`, {
        method: 'POST',
        body: { diff_hash: run.apply_run.diff_hash },
      });
      toast.success('Применение запущено. Снимок создаётся автоматически.');
      props.onChanged();
      props.onClose();
    } catch (caught) {
      toast.error(errorMessage(caught));
      setPhase('ready');
    }
  }

  const items = run ? itemsToDiff(run.items) : [];
  const noChanges = run ? items.length === 0 : false;
  const canConfirm = run?.apply_run.status === 'awaiting_confirmation';

  return (
    <Modal
      title={`Сравнение: ${props.templateName} (ред. ${props.revision})`}
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
        <Spinner
          label={
            phase === 'loading'
              ? 'Загружаем различия…'
              : 'Читаем состояние роутера и строим diff…'
          }
        />
      ) : null}

      {error ? <ErrorBanner message={error} /> : null}

      {run ? (
        <>
          {run.apply_run.section_map &&
          Object.keys(run.apply_run.section_map).length > 0 ? (
            <InfoBanner tone="warn">
              Секции шаблона привязаны к существующим секциям роутера:{' '}
              {Object.entries(run.apply_run.section_map)
                .map(([from, to]) => `«${from}» → «${to}»`)
                .join(', ')}
              . Это защищает от правила connection без подключения.
            </InfoBanner>
          ) : null}
          <div className="diff-head">
            <DiffBadge items={items} />
            <span className="muted-text">
              Статус: {APPLY_STATUS[run.apply_run.status] ?? run.apply_run.status} · хеш{' '}
              <code>{run.apply_run.diff_hash.slice(0, 12)}…</code>
            </span>
          </div>
          {noChanges ? (
            <InfoBanner>Конфигурация уже соответствует шаблону — применение не требуется.</InfoBanner>
          ) : (
            <InfoBanner tone="warn">
              Проверьте список. Будут перечисленные параметры; списки заменяются полностью, удаление
              помечено отдельно.
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
