export type Role = 'superadmin' | 'admin' | 'user';

export interface InstalledProduct {
  product: 'forkop' | 'prokop' | 'podkop' | 'tachyon';
  version?: string | null;
  packages?: string[];
}

export interface RouterRecord {
  id: string;
  owner_id: string;
  owner_email?: string | null;
  name: string;
  product: string;
  product_version: string | null;
  agent_version: string | null;
  manifest_version: number | null;
  openwrt_version: string | null;
  arch: string | null;
  model: string | null;
  sing_box_version: string | null;
  sing_box_variant: string | null;
  sing_box_previous_version?: string | null;
  sing_box_previous_variant?: string | null;
  sing_box_installed_at?: string | null;
  installed_products?: InstalledProduct[];
  status: string;
  last_seen_at: string | null;
  last_error: string | null;
  monitoring_enabled: boolean;
  managed_section?: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RouterState {
  managed: Record<string, string | string[] | null>;
  state_hash: string | null;
  health: unknown;
  service: unknown;
  capabilities: unknown;
  collected_at: string | null;
  source: string | null;
}

export interface TemplateAssignment {
  router_id: string;
  template_id: string;
  revision: number;
  desired_hash: string;
  applied_hash: string | null;
  applied_at: string | null;
  drift: string;
  template_name: string;
  section_map?: Record<string, string> | null;
}

export interface RouterSnapshot {
  id: string;
  kind: 'native' | 'local';
  external_id: string | null;
  reason: string;
  sha256: string | null;
  size_bytes: number | null;
  product_version: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface RouterDetail {
  router: RouterRecord;
  state: RouterState | null;
  assignments: TemplateAssignment[];
}

export type JobStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface Job {
  id: string;
  type: string;
  router_id: string | null;
  batch_id: string | null;
  requested_by: string | null;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attempt: number;
  max_attempts: number;
  timeout_seconds: number;
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: { code: string; message: string } | null;
  created_at: string;
}

export interface TemplateListItem {
  id: string;
  owner_id: string;
  owner_email?: string | null;
  name: string;
  description: string | null;
  schema_version: number;
  current_revision: number;
  shared: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  assignment_count: number;
  preset_action?: string | null;
  preset_resources?: number;
}

export interface PodkopTemplate {
  connection_type?: 'proxy' | 'vpn' | 'block' | 'exclusion';
  proxy_config_type?: 'url' | 'selector' | 'urltest' | 'outbound';
  user_domain_list_type?: 'disabled' | 'dynamic' | 'text';
  user_domains_text?: string | null;
  user_subnet_list_type?: 'disabled' | 'dynamic' | 'text';
  user_subnets_text?: string | null;
  options?: Record<string, string | string[] | null>;
}

export interface TemplatePayload {
  action?: string;
  enabled?: string | string[] | null;
  resources?: Record<string, string | string[] | null>;
  manual_domains?: string[];
  manual_ips?: string[];
  podkop?: PodkopTemplate;
  manual_entries_mode?: 'merge' | 'replace';
  settings: Record<string, string | string[] | null>;
  sections: Record<string, Record<string, string | string[] | null>>;
  urltest: Record<string, Record<string, string | string[] | null>>;
  section_interface: Record<string, Record<string, string | string[] | null>>;
  subscription_url: Record<string, Record<string, string | string[] | null>>;
  create_urltest: string[];
  create_sections: string[];
  manual_entries: Record<string, { domains: string[]; ips: string[] }>;
}

export interface TemplatePreset {
  action: string;
  enabled: string;
  resources: Record<string, string | string[] | null>;
  manual_domains: string[];
  manual_ips: string[];
  settings: Record<string, string | string[] | null>;
  podkop: PodkopTemplate;
}

export interface RouterConnection {
  id: string;
  kind: 'subscription' | 'vless';
  label: string;
  masked: string;
  compact: boolean;
  compact_length: number | null;
  enabled: boolean;
  subscription_id?: string | null;
  catalog_name?: string | null;
  section?: string;
  created_at: string;
  updated_at: string;
}

export interface RuleConnectionView {
  kind: 'subscription' | 'link';
  id: string | null;
  name: string | null;
  hash: string | null;
  label: string;
  masked: string;
  host: string;
  tail: string;
  managed: boolean;
  enabled: boolean;
  missing: boolean;
  proxy_tag?: string;
  proxy_group?: string;
  delay_ms?: number | null;
  alive?: boolean | null;
  active?: boolean;
  selectable?: boolean;
  synthetic?: boolean;
  native?: boolean;
}

export interface RuleView {
  section: string;
  label: string;
  action: string;
  enabled: boolean;
  resources: Record<string, string | string[] | null>;
  manual_domains: string[];
  manual_ips: string[];
  subscriptions: RuleConnectionView[];
  links: RuleConnectionView[];
  source: 'live' | 'cache';
  warnings: string[];
}

export interface RulesResponse {
  rules: RuleView[];
  source: 'live' | 'cache';
  managed_section?: string;
  state_collected_at?: string | null;
  state_hash?: string | null;
}

export interface ExternalSubscription {
  name: string;
  host: string;
  tail: string;
}

export interface ExternalLink {
  index: number;
  hash: string;
  scheme: string;
  host: string;
  tail: string;
  label: string;
}

export interface ExternalConnections {
  section: string;
  subscriptions: ExternalSubscription[];
  links: ExternalLink[];
}

export type DnsProtocol = 'udp' | 'doh';

export interface DnsCandidateResult {
  id: string;
  provider: string;
  protocol: DnsProtocol;
  address: string;
  filtered: boolean;
  success: number;
  total: number;
  loss_pct: number;
  min_ms: number | null;
  median_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
  avg_ms: number | null;
  score: number;
  status: string;
  suspect?: boolean;
  error: string | null;
}

export interface DnsBenchmarkState {
  running: boolean;
  progress: number;
  phase: string | null;
  current: string | null;
  started_at: number | null;
  finished_at: number | null;
  cancelled?: boolean;
  error: string | null;
  domains: string[];
  rounds: number;
  results: DnsCandidateResult[];
  recommendations: {
    udp: DnsCandidateResult[];
    doh: DnsCandidateResult[];
  };
  bootstrap: string[];
}

export interface DnsCurrentSettings {
  dns_type: string;
  dns_server: string[];
  bootstrap_dns_server: string[];
  detour_enabled: boolean;
  detour_section: string | null;
}

export interface DnsStatus {
  current: DnsCurrentSettings | null;
  state_available: boolean;
  state_collected_at: string | null;
  template: { id: string; name: string } | null;
  sections: string[];
  warnings: string[];
}

export interface ConnectionSecretPreview {
  kind: 'subscription' | 'vless';
  host: string;
  port: number;
  path: string | null;
  sni: string | null;
  transport: string | null;
  security: string | null;
  flow: string | null;
  credential_masked: string;
}

export interface CatalogSubscription {
  id: string;
  owner_id: string;
  owner_email?: string | null;
  name: string;
  description: string | null;
  masked: string;
  created_at: string;
  updated_at: string;
  is_owner: boolean;
  can_manage: boolean;
  shared_with_count?: number;
}

export interface SubscriptionAccessUser {
  id: string;
  email: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
}

export interface RouterListExtras {
  rule_set: string[];
  remote_domain_lists: string[];
  remote_subnet_lists: string[];
  manual_domains: string[];
  manual_ips: string[];
}

export interface RouterSectionSummary {
  name: string;
  action: string | null;
  label: string | null;
  enabled: string | null;
  values: Record<string, string | string[]>;
  routers: Array<{ id: string; name: string }>;
}

export interface RouterSectionsResponse {
  routers: Array<{ id: string; name: string }>;
  sections: RouterSectionSummary[];
  other: {
    urltest: string[];
    section_interface: string[];
    subscription_url: string[];
  };
}

export interface RoutingGroup {
  id: string;
  label: string;
  icon: string;
}

export interface RoutingService {
  id: string;
  label: string;
  title?: string;
  description?: string;
  note?: string;
  group?: string;
  group_label?: string;
  group_icon?: string;
  kind?: string;
  recommended_action?: string;
  counts?: {
    domains: number;
    subnets: number;
    domain: number;
    domain_suffix: number;
    domain_keyword: number;
    domain_regex: number;
    ipv4_cidr: number;
    ipv6_cidr: number;
  };
  native?: boolean;
  delivery?: 'native' | 'rule_set' | 'domains' | 'unsupported';
  url?: string | null;
}

export interface RoutingAction {
  id: string;
  label: string;
}

export interface TemplateFull extends Omit<TemplateListItem, 'assignment_count'> {
  revision: number;
  payload: TemplatePayload;
  exclusions: string[];
  preset: TemplatePreset | null;
  preset_error: string | null;
}

export interface TemplateRevision {
  revision: number;
  payload: TemplatePayload;
  exclusions: string[];
  created_by: string | null;
  created_at: string;
}

export interface ApplyRun {
  id: string;
  router_id: string;
  router_name?: string;
  template_id: string | null;
  revision: number | null;
  diff: DiffItem[];
  diff_hash: string;
  base_state_hash: string | null;
  desired_hash: string | null;
  section_map?: Record<string, string> | null;
  snapshot_ref: string | null;
  backup_ok: boolean;
  status: string;
  requested_by: string;
  requested_by_email?: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_detail: string | null;
  created_at: string;
}

export interface DiffItem {
  op: 'add' | 'change' | 'delete';
  path: string;
  before: string | string[] | null;
  after: string | string[] | null;
}

export interface ApplyItem {
  seq: number;
  op: string;
  path: string;
  value_before: unknown;
  value_after: unknown;
  result: string;
  error_code: string | null;
}

export interface ApplyRunDetail {
  apply_run: ApplyRun;
  items: ApplyItem[];
}

export interface MonitoringItem {
  id: string;
  name: string;
  status: string;
  product: string;
  product_version: string | null;
  agent_version: string | null;
  sing_box_version: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  monitoring_enabled: boolean;
  offline_since: string | null;
  online_since: string | null;
  health: string | null;
  service_state: string | null;
  proxy_health: string | null;
  latency_ms: number | null;
  failed_tags: number | null;
  total_tags: number | null;
  ts: string | null;
  detail: string | null;
  direct_ip: string | null;
  vpn_ip: string | null;
  owner_id?: string | null;
  owner_name?: string | null;
  owner_email?: string | null;
}

export interface MonitoringOverview {
  summary: {
    total: number;
    online: number;
    offline: number;
    pending: number;
    conflict: number;
    unsupported: number;
    proxy_healthy: number;
    proxy_degraded: number;
    proxy_dead: number;
  };
  items: MonitoringItem[];
}

export interface MetricSample {
  ts: string;
  reachable: boolean;
  service_state: string | null;
  health: string | null;
  proxy_health: string | null;
  latency_ms: number | null;
  failed_tags: number | null;
  total_tags: number | null;
  sing_box_version: string | null;
}

export interface MetricsResponse {
  granularity: string;
  items: Array<Record<string, unknown>>;
}

export interface ConnectionLossItem {
  tag: string;
  losses: number;
  failed_samples: number;
  total_samples: number;
  last_failure: string | null;
  down_now: boolean;
}

export interface ConnectionsResponse {
  hours: number;
  items: ConnectionLossItem[];
}

export interface DiagnosticReportSummary {
  id: string;
  router_id: string;
  router_name?: string;
  job_id?: string | null;
  batch_id?: string | null;
  kind: 'quick' | 'full';
  product: string;
  agent_version: string | null;
  sha256: string;
  size_bytes: number;
  created_at: string;
  expires_at: string;
}

export interface DiagnosticReportDetail extends DiagnosticReportSummary {
  payload: unknown;
  text: string | null;
}

export interface SingBoxVariant {
  id: 'tiny' | 'extended' | 'extended_compressed' | 'stable';
  label: string;
  description: string;
}

export interface SingBoxVersion {
  tag: string;
  release_url: string | null;
  published_at: string | null;
  asset_sha256: string | null;
  is_stable: boolean;
  discovered_at: string;
}

export interface Rollout {
  id: string;
  version_tag: string;
  variant: string | null;
  status: string;
  stage: number;
  stage_started_at: string | null;
  created_by: string;
  created_by_email?: string | null;
  approved_by: string | null;
  created_at: string;
  finished_at: string | null;
  targets: number;
  succeeded: number;
}

export interface RolloutTarget {
  rollout_id: string;
  router_id: string;
  stage: number;
  status: string;
  previous_version: string | null;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  router_name: string;
  router_status: string;
  sing_box_version: string | null;
}

export interface RolloutDetail {
  rollout: Omit<Rollout, 'targets' | 'succeeded'>;
  targets: RolloutTarget[];
}

export interface UserRow {
  id: string;
  email: string;
  role: Role;
  status: string;
  totp_enabled: boolean;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  parent_id?: string | null;
  parent_email?: string | null;
  created_at: string;
  last_login_at: string | null;
  archived_at?: string | null;
  router_count?: number;
}

export interface InviteRow {
  id: string;
  role: Role;
  email: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  created_by_email: string | null;
  used_by_email: string | null;
}

export interface AuditRow {
  id: string;
  at: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  router_id: string | null;
  ip: string | null;
  result: string;
  code: string | null;
  metadata: unknown;
}

export interface NotificationRow {
  id: number;
  router_id: string | null;
  router_name: string | null;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  created_at: string;
  read_at: string | null;
}

export interface SettingsEffective {
  mfaPolicy: 'all' | 'admins';
  sessionDays: number;
  limits: {
    routersPerUser: number;
    usersPerInstance: number;
    routersPerInstance: number;
    batchSize: number;
    templatesPerUser: number;
  };
  monitoring: {
    intervalSeconds: number;
    offlineAfterMisses: number;
    latencyDegradedMs: number;
    staggerSeconds: number;
    degradedAfterSamples: number;
    degradedCooldownMinutes: number;
    recoveryNotify: boolean;
  };
  retention: { days: number; commandsDays: number; snapshotsLocal: number };
  agent: {
    pollHoldSeconds: number;
    commandTtlReadSeconds: number;
    commandTtlMutateSeconds: number;
    minVersion: string;
  };
  singbox: { userInstall: boolean; userCooldownHours: number; stagedRollout: string };
  features: { mtls: boolean; logread: boolean; autoReconcile: boolean; apiTokens: boolean };
}

export interface SettingsResponse {
  effective: SettingsEffective;
  values: Array<{ key: string; value: Record<string, unknown>; updated_at: string }>;
}

export interface SettingsStorageTable {
  name: string;
  bytes: number;
  rows: number;
}

export interface UpdateStatus {
  current: { version: string; build: string };
  latest: { sha: string; message: string; date: string; url: string } | null;
  update_available: boolean;
  checked_at: string | null;
  updater_installed: boolean;
  status: {
    state?: string;
    message?: string;
    updated_at?: string;
    from_build?: string;
    to_build?: string;
  } | null;
  error: string | null;
}

export interface SettingsStorage {
  generated_at: string;
  database_bytes: number;
  log_bytes: number;
  tables: SettingsStorageTable[];
  retention: { days: number; commandsDays: number; snapshotsLocal: number };
}

export interface Allowlist {
  settings: string[];
  section: string[];
  urltest: string[];
  forbidden: string[];
}

export interface BindingToken {
  token: string;
  expires_at: string;
  server_url: string;
  install_command: string;
  warning: string;
}

export interface RotateCredential {
  token: string;
  prefix: string;
  overlap_seconds: number;
  warning: string;
}

export interface CredentialInfo {
  credential: {
    prefix: string;
    created_at: string;
    rotated_at: string | null;
    revoked_at: string | null;
  } | null;
}
