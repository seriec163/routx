import { z } from 'zod';
import { isIP } from 'node:net';
import { canonicalJson, sha256Hex } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { ROUTING_ACTION_IDS, ROUTING_SERVICE_IDS } from './routing.js';

/**
 * Единый источник истины по управляемым UCI-параметрам.
 * Тот же allowlist продублирован в агенте RoutX (agent/files/usr/lib/routx-agent/allowlist.uc).
 * Секретные пути запрещены на уровне сервера ДО любых операций.
 */

export type UciValue = string | string[] | null;

export const SETTINGS_OPTIONS = new Set([
  'dns_type',
  'dns_server',
  'bootstrap_dns_server',
  'dns_strategy',
  'dns_check_interval',
  'dns_failover_failure_threshold',
  'dns_rewrite_ttl',
  'dns_detour_enabled',
  'dns_detour_section',
  'source_network_interfaces',
  'enable_output_network_interface',
  'output_network_interface',
  'enable_badwan_interface_monitoring',
  'badwan_monitored_interfaces',
  'badwan_reload_delay',
  'dont_touch_dhcp',
  'log_level',
  'exclude_ntp',
  'intercept_client_dns',
  'tproxy_low_memory',
  'nfqws_first_packets',
  'list_update_enabled',
  'update_interval',
  'component_update_check_enabled',
  'component_update_check_interval',
  'disable_quic',
  'latency_test_url',
  'download_lists_via_proxy',
  'device_traffic',
  'exclude_bittorrent',
]);

export const SETTINGS_LIST_OPTIONS = new Set([
  'dns_server',
  'bootstrap_dns_server',
  'source_network_interfaces',
  'badwan_monitored_interfaces',
]);

export const SECTION_OPTIONS = new Set([
  'label',
  'enabled',
  'action',
  'dns_type',
  'dns_server',
  'dns_detour_enabled',
  'dns_detour_section',
  'community_lists',
  'rule_set',
  'rule_set_with_subnets',
  'fully_routed_ips',
  'excluded_source_ip_cidr',
  'domain',
  'domain_suffix',
  'domain_keyword',
  'domain_regex',
  'domain_ip_lists',
  'remote_domain_lists',
  'remote_subnet_lists',
  'outbound_detour_enabled',
  'outbound_detour_section',
  'sort_by_latency',
  // Podkop: тип секции и параметры прокси/маршрутизации.
  'connection_type',
  'proxy_config_type',
  'interface',
  'user_domain_list_type',
  'user_domains',
  'user_domains_text',
  'user_subnet_list_type',
  'user_subnets',
  'user_subnets_text',
  'local_domain_lists',
  'local_subnet_lists',
  'enable_udp_over_tcp',
  'urltest_check_interval',
  'urltest_tolerance',
  'urltest_testing_url',
  'mixed_proxy_enabled',
  'mixed_proxy_port',
  'domain_resolver_enabled',
  'resolve_real_ip_for_routing',
]);

export const SECTION_LIST_OPTIONS = new Set([
  'community_lists',
  'rule_set',
  'rule_set_with_subnets',
  'fully_routed_ips',
  'excluded_source_ip_cidr',
  'domain_suffix',
  'domain_keyword',
  'domain_regex',
  'domain_ip_lists',
  'remote_domain_lists',
  'remote_subnet_lists',
  // Podkop: списки доменов, подсетей и правил.
  'user_domains',
  'user_subnets',
  'local_domain_lists',
  'local_subnet_lists',
]);

/**
 * Домены в Prokop/Forkop теперь хранятся в одном текстовом option `domain`
 * с префиксами full:/keyword:/regex:. Старые list-опции остаются только для
 * чтения и удаления при следующем apply.
 */
export const LEGACY_DOMAIN_OPTIONS = new Set([
  'domain',
  'domain_suffix',
  'domain_keyword',
  'domain_regex',
]);

export const URLTEST_OPTIONS = new Set([
  'section',
  'name',
  'check_interval',
  'tolerance',
  'testing_url',
  'idle_timeout',
  'interrupt_exist_connections',
  'pin_dashboard',
  'filter_mode',
  'detect_server_country',
  'exclude_countries',
  'exclude_outbounds',
  'exclude_regex',
  'include_countries',
  'include_outbounds',
  'include_regex',
]);

export const URLTEST_LIST_OPTIONS = new Set([
  'exclude_countries',
  'exclude_outbounds',
  'include_countries',
  'include_outbounds',
]);

export const SECTION_INTERFACE_OPTIONS = new Set([  'name',
  'domain_resolver_enabled',
  'domain_resolver_dns_type',
  'domain_resolver_dns_server',
]);

export const SECTION_INTERFACE_LIST_OPTIONS = new Set(['domain_resolver_dns_server']);

export const SUBSCRIPTION_OPTIONS = new Set([
  'section',
  'user_agent',
  'subscription_update_enabled',
  'subscription_update_interval',
  'download_via_proxy_enabled',
  'show_dashboard_metadata',
  'prefix_nodes',
  'node_prefix',
  'include_urltest_groups',
  'url_tail',
  'url_host',
]);

/** Полностью запрещённые типы секций и опции (fail closed). */
export const FORBIDDEN_TYPES = new Set(['server']);
export const SECRET_OPTIONS = new Set([
  'selector_proxy_links',
  'urltest_proxy_links',
  'urltest_fallback_links',
  'proxy_string',
  'outbound_jsons',
  'outbound_json',
  'url',
]);
export const SECRET_OPTION_PATTERN =
  /(selector_proxy|outbound_json|private[_-]?key|password|passwd|secret|token|api[_-]?key|subscription.*url|^url$|auth)/i;
export const HARD_EXCLUDED_SETTINGS = [
  'config_version',
  'applied_migrations',
  'mirror_base_url',
  'sing_box_pinned_version',
  'enable_yacd',
  'config_path',
  'cache_path',
];
export const HARD_EXCLUDED_SETTINGS_PREFIXES = ['direct_proxy_', 'torrserver_'];

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_LIST_DIR = '/etc/routx-agent/lists';
const MAX_MANUAL_ENTRIES = 5000;

export interface RouterListExtrasEntry {
  rule_set?: string[];
  remote_domain_lists?: string[];
  remote_subnet_lists?: string[];
  manual_domains?: string[];
  manual_ips?: string[];
}

export type RouterListExtras = Record<string, RouterListExtrasEntry>;

export interface LocalList {
  path: string;
  entries: string[];
}

export interface DesiredPlan {
  desired: Map<string, UciValue>;
  localLists: LocalList[];
  createSections: string[];
  exclusions: string[];
  desiredHash: string;
}

export type ManualDomainKind = 'suffix' | 'full' | 'keyword' | 'regex';

export interface ManualDomainEntry {
  kind: ManualDomainKind;
  value: string;
}

export function isCommentLine(value: string): boolean {
  const text = value.trim();
  return text === '' || text.startsWith('//') || text.startsWith('#');
}

function normalizeDomainBody(value: string): string | null {
  let domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (domain.startsWith('*.')) domain = domain.slice(2);
  if (!DOMAIN_RE.test(domain)) return null;
  return domain;
}

/**
 * Разбирает строку ручного домена так же, как Prokop/Forkop:
 * обычный домен = domain_suffix (домен и поддомены), full: = точное
 * совпадение, keyword: = подстрока, regex: = регулярное выражение.
 */
export function parseManualDomain(raw: string): ManualDomainEntry | null {
  let text = raw.trim();
  if (text === '') return null;
  let kind: ManualDomainKind = 'suffix';
  const match = /^(full|keyword|regex):/i.exec(text);
  if (match) {
    kind = match[1]!.toLowerCase() as ManualDomainKind;
    text = text.slice(match[0].length).trim();
    // Prokop допускает повторный префикс; убираем его.
    while (new RegExp(`^${kind}:`, 'i').test(text)) {
      text = text.replace(new RegExp(`^${kind}:`, 'i'), '').trim();
    }
  }
  if (text === '') return null;

  if (kind === 'suffix' || kind === 'full') {
    const value = normalizeDomainBody(text);
    return value ? { kind, value } : null;
  }
  if (kind === 'keyword') {
    if (text.length > 256 || /[\r\n]/.test(text)) return null;
    return { kind, value: text };
  }
  if (text.length > 512 || /[\r\n]/.test(text)) return null;
  try {
    // Проверяем синтаксис regex; семантику окончательно проверит upstream.
    new RegExp(text);
  } catch {
    return null;
  }
  return { kind, value: text };
}

function normalizeIp(value: string): string | null {
  const text = value.trim();
  const slash = text.indexOf('/');
  if (slash === -1) return isIP(text) ? text : null;
  const address = text.slice(0, slash);
  const prefix = Number(text.slice(slash + 1));
  const family = isIP(address);
  if (!family || !Number.isInteger(prefix)) return null;
  if (family === 4 && (prefix < 0 || prefix > 32)) return null;
  if (family === 6 && (prefix < 0 || prefix > 128)) return null;
  return `${address}/${prefix}`;
}

/** Проверяет ручные домены и IP так же, как это сделает buildPlan. */
export function validateManualEntries(domains: string[], ips: string[]): void {
  for (const raw of domains) {
    if (isCommentLine(raw)) continue;
    if (!parseManualDomain(raw)) {
      throw badRequest('invalid_domain', `Некорректный домен: ${raw}`, { value: raw });
    }
  }
  for (const raw of ips) {
    if (isCommentLine(raw)) continue;
    if (!normalizeIp(raw)) {
      throw badRequest('invalid_ip', `Некорректный IP/CIDR: ${raw}`, { value: raw });
    }
  }
}

function validRemoteReference(value: string, kind: 'rule_set' | 'plain'): boolean {
  const text = value.trim();
  if (text === '') return false;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }
  if (!text.startsWith('/')) return false;
  return kind === 'rule_set' ? /\.(srs|json)$/i.test(text) : /\.lst$/i.test(text);
}

function listPathForSection(section: string, entries: string[]): string {
  const hash = sha256Hex(entries.join('\n')).slice(0, 12);
  return `${LOCAL_LIST_DIR}/${section}-${hash}.lst`;
}

function pushListValue(desired: Map<string, UciValue>, path: string, values: string[]) {
  if (values.length === 0) return;
  const current = desired.get(path);
  const existing = Array.isArray(current) ? current : current == null ? [] : [String(current)];
  const merged = [...new Set([...existing, ...values])];
  desired.set(path, merged);
}

/**
 * Добавляет строки в текстовый option (не list). Нужно для нового формата
 * `domain`, где строки разделены переводом строки и имеют префиксы
 * full:/keyword:/regex:.
 */
function pushTextValue(desired: Map<string, UciValue>, path: string, values: string[]) {
  const clean = values.map((value) => value.trim()).filter(Boolean);
  if (clean.length === 0) return;
  const current = desired.get(path);
  const existing =
    current == null
      ? []
      : Array.isArray(current)
        ? current.map((item) => String(item).trim())
        : String(current)
            .split('\n')
            .map((item) => item.trim());
  const merged = [...new Set([...existing.filter(Boolean), ...clean])];
  if (merged.length > 0) desired.set(path, merged.join('\n'));
}

const DOMAIN_PREFIX_RE = /^(full|keyword|regex):/i;

function textLines(value: UciValue): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value)
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function domainOptionLines(option: string, value: UciValue): string[] {
  const lines = textLines(value);
  if (option === 'domain_suffix') return lines;
  if (option === 'domain_keyword') {
    return lines.map((line) => (line.startsWith('keyword:') ? line : `keyword:${line}`));
  }
  if (option === 'domain_regex') {
    return lines.map((line) => (line.startsWith('regex:') ? line : `regex:${line}`));
  }
  // option === 'domain': массив — старый точный list, строка — новый
  // combined-текст с префиксами.
  if (Array.isArray(value)) {
    return lines.map((line) => (DOMAIN_PREFIX_RE.test(line) ? line : `full:${line}`));
  }
  return lines;
}

/**
 * Секции, которые агент должен создать, если их нет. Любая секция шаблона
 * с заданным action создаётся автоматически; явный create_sections сохраняется
 * для обратной совместимости.
 */
export function creatableSections(payload: TemplatePayload): string[] {
  const names = new Set(payload.create_sections);
  for (const [name, options] of Object.entries(payload.sections)) {
    if (typeof options.action === 'string' && options.action.trim() !== '') names.add(name);
  }
  return [...names];
}

export const CONNECTION_ACTIONS = new Set(['connection', 'proxy', 'outbound', 'vpn']);

export interface SectionState {
  action: string;
  enabled: boolean;
}

/** Разбирает `section.<name>.action/enabled` из состояния агента. */
export function sectionStates(managed: Record<string, UciValue>): Map<string, SectionState> {
  const sections = new Map<string, SectionState>();
  for (const [path, value] of Object.entries(managed ?? {})) {
    const match = /^section\.([A-Za-z0-9_.-]{1,64})\.(action|enabled)$/.exec(path);
    if (!match) continue;
    const name = match[1]!;
    const entry = sections.get(name) ?? { action: '', enabled: true };
    if (match[2] === 'action') entry.action = typeof value === 'string' ? value : '';
    else entry.enabled = !(typeof value === 'string' && value === '0');
    sections.set(name, entry);
  }
  return sections;
}

/**
 * Выбирает основную секцию роутера без привязки к конкретному имени.
 *
 * Если текущая секция существует и включена — оставляем её. Если она пустая,
 * выключенная или её больше нет, а на роутере ровно одна включённая секция
 * с подключением, переключаемся на неё. При нескольких кандидатах ничего не
 * меняем: решение должен принять пользователь.
 */
export function resolveManagedSection(
  managed: Record<string, UciValue>,
  current: string | null | undefined,
): string | null {
  const sections = sectionStates(managed);
  const currentName = (current ?? '').trim();
  if (sections.size === 0) return currentName || null;
  const currentState = currentName ? sections.get(currentName) : undefined;
  if (currentState?.enabled && CONNECTION_ACTIONS.has(currentState.action)) return currentName;

  const candidates = [...sections.entries()]
    .filter(([, state]) => state.enabled && CONNECTION_ACTIONS.has(state.action))
    .map(([name]) => name);
  if (candidates.length === 1) return candidates[0]!;
  return currentName || null;
}


export interface SectionMappingResult {
  payload: TemplatePayload;
  sectionMap: Record<string, string>;
  warnings: string[];
}

/**
 * Применяет явно заданное сопоставление секций шаблона с секциями роутера.
 * Используется, когда пользователь выбрал целевые секции при назначении
 * шаблона. В отличие от автоматического mapTemplateSections, здесь нет догадок.
 */
export function applySectionMap(
  payload: TemplatePayload,
  sectionMap: Record<string, string>,
): TemplatePayload {
  const entries = Object.entries(sectionMap ?? {});
  if (entries.length === 0) return payload;

  const sections = { ...payload.sections };
  const manualEntries = { ...payload.manual_entries };
  const createSections = new Set(payload.create_sections);

  for (const [from, to] of entries) {
    if (!NAME_RE.test(from) || !NAME_RE.test(to)) {
      throw badRequest('invalid_section_map', 'Некорректное имя секции в сопоставлении');
    }
    if (from === to) continue;
    const source = sections[from];
    if (!source) {
      throw badRequest(
        'unknown_template_section',
        `В шаблоне нет секции «${from}», указанной в сопоставлении`,
      );
    }

    sections[to] = { ...(sections[to] ?? {}), ...source };
    delete sections[from];

    if (manualEntries[from]) {
      const currentTarget = manualEntries[to];
      manualEntries[to] = {
        domains: [...(currentTarget?.domains ?? []), ...manualEntries[from]!.domains],
        ips: [...(currentTarget?.ips ?? []), ...manualEntries[from]!.ips],
      };
      delete manualEntries[from];
    }

    createSections.delete(from);
    createSections.add(to);
  }

  return {
    ...payload,
    sections,
    manual_entries: manualEntries,
    create_sections: [...createSections],
  };
}

/**
 * Привязывает секцию шаблона к существующей секции роутера, если одноимённой
 * секции нет. Например, шаблон создан для router_control, а подписки на
 * роутере лежат в gga: без этого получается правило connection без подключения
 * и Prokop отказывается загружать конфигурацию.
 *
 * Если подходящей секции нет или их несколько, возвращается понятная ошибка —
 * лучше остановиться, чем записать невалидный UCI.
 */
export function mapTemplateSections(
  payload: TemplatePayload,
  current: Record<string, UciValue>,
): SectionMappingResult {
  const existing = new Set<string>();
  const subscriptionSections = new Set<string>();

  for (const [path, value] of Object.entries(current)) {
    const section = /^section\.([A-Za-z0-9_.-]{1,64})\./.exec(path);
    if (section) existing.add(section[1]!);
    const subscription =
      /^(?:subscription_url|outbound_source)\.[A-Za-z0-9_.-]{1,64}\.section$/.exec(path);
    if (subscription && typeof value === 'string' && value.trim() !== '') {
      subscriptionSections.add(value.trim());
    }
  }

  function enabledConnectionSections(): string[] {
    const enabled = (name: string): boolean => {
      const value = current[`section.${name}.enabled`];
      return value == null || String(value) !== '0';
    };
    const withSubscriptions = [...subscriptionSections].filter(
      (name) => existing.has(name) && enabled(name),
    );
    if (withSubscriptions.length > 0) return withSubscriptions;
    return [...existing].filter((name) => {
      if (!enabled(name)) return false;
      const action = current[`section.${name}.action`];
      return typeof action === 'string' && CONNECTION_ACTIONS.has(action);
    });
  }

  const payloadConnections = Object.entries(payload.sections)
    .filter(
      ([, options]) =>
        typeof options.action === 'string' && CONNECTION_ACTIONS.has(options.action),
    )
    .map(([name]) => name);

  // Шаблон может ссылаться на выключенную/пустую секцию — типичный след
  // старого имени router_control после смены продукта. Если на роутере ровно
  // одна активная секция с подключением, переносим правило в неё, а не
  // создаём/заполняем пустую.
  if (payloadConnections.length === 1) {
    const sourceName = payloadConnections[0]!;
    const sourceEnabled = current[`section.${sourceName}.enabled`];
    const sourceDisabled = sourceEnabled != null && String(sourceEnabled) === '0';
    if (existing.has(sourceName) && sourceDisabled) {
      const targets = enabledConnectionSections().filter((name) => name !== sourceName);
      if (targets.length === 1) {
        const target = targets[0]!;
        return {
          payload: applySectionMap(payload, { [sourceName]: target }),
          sectionMap: { [sourceName]: target },
          warnings: [
            `Секция «${sourceName}» на роутере выключена; правило привязано к активной секции «${target}».`,
          ],
        };
      }
    }
  }

  const missing = Object.entries(payload.sections).filter(([name, options]) => {
    const action = typeof options.action === 'string' ? options.action : '';
    return CONNECTION_ACTIONS.has(action) && !existing.has(name);
  });

  if (missing.length === 0) {
    return { payload, sectionMap: {}, warnings: [] };
  }
  if (missing.length > 1) {
    throw badRequest(
      'section_mapping_required',
      'В шаблоне несколько новых секций с подключением. Сначала добавьте подключения на роутер или оставьте одну такую секцию.',
    );
  }

  const [sourceName, sourceOptions] = missing[0]!;
  const options = enabledConnectionSections();
  if (options.length === 0) {
    throw badRequest(
      'section_without_connection',
      `Секция «${sourceName}» с действием «${String(sourceOptions.action)}» не существует на роутере, и нет секции с подключением, к которой её можно привязать. Добавьте подписку или VLESS, затем повторите сравнение.`,
    );
  }
  if (options.length > 1) {
    throw badRequest(
      'section_ambiguous',
      `На роутере несколько секций с подключением: ${options.join(', ')}. Укажите нужную секцию в шаблоне или оставьте только одну.`,
    );
  }

  const target = options[0]!;
  const sections = { ...payload.sections };
  sections[target] = { ...(sections[target] ?? {}), ...sourceOptions };
  delete sections[sourceName];

  const manualEntries = { ...payload.manual_entries };
  if (manualEntries[sourceName]) {
    const source = manualEntries[sourceName]!;
    const currentTarget = manualEntries[target];
    manualEntries[target] = {
      domains: [...(currentTarget?.domains ?? []), ...source.domains],
      ips: [...(currentTarget?.ips ?? []), ...source.ips],
    };
    delete manualEntries[sourceName];
  }

  const createSections = new Set(payload.create_sections);
  createSections.delete(sourceName);
  createSections.add(target);

  return {
    payload: {
      ...payload,
      sections,
      manual_entries: manualEntries,
      create_sections: [...createSections],
    },
    sectionMap: { [sourceName]: target },
    warnings: [
      `Секция «${sourceName}» применена к существующей секции «${target}»: на роутере нет «${sourceName}», но подключение уже настроено в «${target}».`,
    ],
  };
}

/**
 * Собирает полный желаемый набор: шаблон + серверные дополнения роутера.
 * Ручные домены/IP превращаются в локальный .lst, который агент запишет
 * перед apply; путь содержит хэш содержимого, поэтому изменение списка
 * всегда видно в diff.
 */
export function buildPlan(
  payload: TemplatePayload,
  exclusions: string[],
  extras: RouterListExtras = {},
): DesiredPlan {
  const desired = templateToDesired(payload);
  const exclusionSet = new Set(validateExclusions(exclusions));
  const createSections = creatableSections(payload);
  const localEntries = new Map<string, { domains: Set<string>; ips: Set<string> }>();

  function entriesFor(section: string) {
    let entry = localEntries.get(section);
    if (!entry) {
      entry = { domains: new Set(), ips: new Set() };
      localEntries.set(section, entry);
    }
    return entry;
  }

  function addManual(section: string, domains: string[] = [], ips: string[] = []) {
    if (!NAME_RE.test(section)) {
      throw badRequest('invalid_section', `Некорректное имя секции «${section}»`);
    }
    const target = entriesFor(section);
    for (const raw of domains) {
      if (isCommentLine(raw)) continue;
      const parsed = parseManualDomain(raw);
      if (!parsed) throw badRequest('invalid_domain', `Некорректный домен: ${raw}`, { value: raw });
      if (parsed.kind === 'suffix') {
        target.domains.add(parsed.value);
      } else {
        const prefix =
          parsed.kind === 'full' ? 'full:' : parsed.kind === 'keyword' ? 'keyword:' : 'regex:';
        pushTextValue(desired, `section.${section}.domain`, [`${prefix}${parsed.value}`]);
      }
    }
    for (const raw of ips) {
      if (isCommentLine(raw)) continue;
      const value = normalizeIp(raw);
      if (!value) throw badRequest('invalid_ip', `Некорректный IP/CIDR: ${raw}`, { value: raw });
      target.ips.add(value);
    }
    if (target.domains.size + target.ips.size > MAX_MANUAL_ENTRIES) {
      throw badRequest('list_too_large', `Слишком много ручных адресов в секции «${section}»`);
    }
  }

  for (const [section, entry] of Object.entries(payload.manual_entries)) {
    if (!payload.sections[section] && !createSections.includes(section)) {
      throw badRequest(
        'section_not_managed',
        `Секция «${section}» с ручными адресами не объявлена в шаблоне`,
      );
    }
    addManual(section, entry.domains, entry.ips);
  }

  for (const name of createSections) {
    const section = payload.sections[name];
    if (!section || typeof section.action !== 'string' || section.action.trim() === '') {
      throw badRequest(
        'section_action_required',
        `Для создаваемой секции «${name}» укажите действие (action)`,
      );
    }
  }

  const allowedExtras = new Set([
    ...Object.keys(payload.sections),
    ...createSections,
  ]);

  const replaceManual = payload.manual_entries_mode === 'replace';

  for (const [section, entry] of Object.entries(extras ?? {})) {
    if (!NAME_RE.test(section)) continue;
    if (!allowedExtras.has(section)) continue;

    for (const value of entry.rule_set ?? []) {
      if (!validRemoteReference(value, 'rule_set')) {
        throw badRequest('invalid_rule_set', `Некорректная ссылка rule-set: ${value}`);
      }
      pushListValue(desired, `section.${section}.rule_set`, [value.trim()]);
    }
    for (const value of entry.remote_domain_lists ?? []) {
      if (!validRemoteReference(value, 'plain')) {
        throw badRequest('invalid_domain_list', `Некорректная ссылка списка доменов: ${value}`);
      }
      pushListValue(desired, `section.${section}.remote_domain_lists`, [value.trim()]);
    }
    for (const value of entry.remote_subnet_lists ?? []) {
      if (!validRemoteReference(value, 'plain')) {
        throw badRequest('invalid_subnet_list', `Некорректная ссылка списка подсетей: ${value}`);
      }
      pushListValue(desired, `section.${section}.remote_subnet_lists`, [value.trim()]);
    }
    // Если секция явно описана в payload.manual_entries, кэш list_extras
    // не должен возвращать уже удалённые адреса.
    if (replaceManual && Object.prototype.hasOwnProperty.call(payload.manual_entries, section)) continue;
    addManual(section, entry.manual_domains, entry.manual_ips);
  }

  const localLists: LocalList[] = [];
  for (const [section, entry] of localEntries) {
    const entries = [...entry.domains, ...entry.ips].sort();
    if (entries.length === 0) continue;
    const path = listPathForSection(section, entries);
    localLists.push({ path, entries });
    pushListValue(desired, `section.${section}.domain_ip_lists`, [path]);
  }

  const desiredHash = hashCanonical({
    payload: Object.fromEntries(desired),
    exclusions,
    local_lists: localLists.map((list) => ({ path: list.path, sha256: sha256Hex(list.entries.join('\n')) })),
  });

  return { desired, localLists, createSections, exclusions, desiredHash };
}

function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function isHardExcludedSetting(option: string): boolean {
  return (
    HARD_EXCLUDED_SETTINGS.includes(option) ||
    HARD_EXCLUDED_SETTINGS_PREFIXES.some((prefix) => option.startsWith(prefix))
  );
}

export interface ParsedPath {
  type: 'settings' | 'section' | 'urltest' | 'section_interface' | 'subscription_url';
  section?: string;
  option: string;
}

export function parseUciPath(path: string): ParsedPath {
  if (typeof path !== 'string' || path.length > 160) {
    throw badRequest('invalid_path', 'Некорректный путь UCI');
  }

  const parts = path.split('.');
  if (parts.length === 2 && parts[0] === 'settings') {
    return { type: 'settings', option: parts[1]! };
  }
  if (parts.length === 3) {
    const [type, section, option] = parts as [string, string, string];
    if (!NAME_RE.test(section)) throw badRequest('invalid_path', 'Некорректное имя секции');
    if (!['section', 'urltest', 'section_interface', 'subscription_url'].includes(type)) {
      throw badRequest('unsupported_path', `Тип секции «${type}» не поддерживается`);
    }
    return { type: type as ParsedPath['type'], section, option };
  }
  throw badRequest('invalid_path', 'Путь должен иметь вид settings.<option> или <type>.<section>.<option>');
}

export interface PathRule {
  allowed: boolean;
  list: boolean;
  reason?: string;
}

export function classifyPath(path: string): PathRule {
  let parsed: ParsedPath;
  try {
    parsed = parseUciPath(path);
  } catch {
    return { allowed: false, list: false, reason: 'invalid_path' };
  }

  const { type, option } = parsed;
  if (FORBIDDEN_TYPES.has(type)) {
    return { allowed: false, list: false, reason: 'forbidden_type' };
  }
  if (SECRET_OPTIONS.has(option) || SECRET_OPTION_PATTERN.test(option)) {
    return { allowed: false, list: false, reason: 'secret_path' };
  }

  switch (type) {
    case 'settings':
      if (isHardExcludedSetting(option)) {
        return { allowed: false, list: false, reason: 'hard_excluded' };
      }
      if (!SETTINGS_OPTIONS.has(option)) {
        return { allowed: false, list: false, reason: 'not_in_allowlist' };
      }
      return { allowed: true, list: SETTINGS_LIST_OPTIONS.has(option) };
    case 'section':
      if (!SECTION_OPTIONS.has(option)) {
        return { allowed: false, list: false, reason: 'not_in_allowlist' };
      }
      return { allowed: true, list: SECTION_LIST_OPTIONS.has(option) };
    case 'urltest':
      if (!URLTEST_OPTIONS.has(option)) {
        return { allowed: false, list: false, reason: 'not_in_allowlist' };
      }
      return { allowed: true, list: URLTEST_LIST_OPTIONS.has(option) };
    case 'section_interface':
      if (!SECTION_INTERFACE_OPTIONS.has(option)) {
        return { allowed: false, list: false, reason: 'not_in_allowlist' };
      }
      return { allowed: true, list: SECTION_INTERFACE_LIST_OPTIONS.has(option) };
    case 'subscription_url':
      if (!SUBSCRIPTION_OPTIONS.has(option)) {
        return { allowed: false, list: false, reason: 'not_in_allowlist' };
      }
      return { allowed: true, list: false };
    default:
      return { allowed: false, list: false, reason: 'unsupported_path' };
  }
}

export function assertAllowedPath(path: string): PathRule {
  const rule = classifyPath(path);
  if (!rule.allowed) {
    throw badRequest(
      rule.reason === 'secret_path' ? 'secret_path_forbidden' : 'path_not_allowed',
      `Параметр «${path}» недоступен для управления`,
      { path, reason: rule.reason },
    );
  }
  return rule;
}

export function normalizeValue(value: UciValue, list: boolean): UciValue {
  if (value === null) return null;
  if (list) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter((item) => item.length > 0).slice(0, 200);
    }
    if (typeof value === 'string') {
      return value
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 200);
    }
    return [String(value)];
  }
  if (Array.isArray(value)) {
    if (value.length > 1) {
      throw badRequest('value_not_list', 'Для скалярного параметра передан массив значений');
    }
    return value[0] !== undefined ? String(value[0]) : null;
  }
  return String(value);
}

export const uciValueSchema = z.union([
  z.string().max(4096),
  z.array(z.string().max(4096)).max(200),
  z.null(),
]);

const valueSchema = uciValueSchema;

const podkopTemplateSchema = z
  .object({
    connection_type: z.enum(['proxy', 'vpn', 'block', 'exclusion']).optional(),
    proxy_config_type: z.enum(['url', 'selector', 'urltest', 'outbound']).optional(),
    user_domain_list_type: z.enum(['disabled', 'dynamic', 'text']).optional(),
    user_domains_text: z.string().max(200000).optional().nullable(),
    user_subnet_list_type: z.enum(['disabled', 'dynamic', 'text']).optional(),
    user_subnets_text: z.string().max(200000).optional().nullable(),
    options: z.record(z.string(), valueSchema).default({}),
  })
  .strict()
  .default({ options: {} });

export const templatePayloadSchema = z
  .object({
    // Новый формат (schema v2): шаблон — это набор настроек и действие,
    // без привязки к имени секции. Ресурсы применяются к той секции,
    // которую пользователь выбрал на роутере.
    action: z.string().max(64).optional(),
    enabled: valueSchema.optional(),
    resources: z.record(z.string(), valueSchema).default({}),
    manual_domains: z.array(z.string().trim().min(1).max(512)).max(MAX_MANUAL_ENTRIES).default([]),
    manual_ips: z.array(z.string().trim().min(1).max(64)).max(MAX_MANUAL_ENTRIES).default([]),
    // Podkop: тип секции, режим прокси и текстовые списки доменов/подсетей.
    podkop: podkopTemplateSchema,
    // Старый формат (schema v1) остаётся для чтения уже сохранённых шаблонов.
    settings: z.record(z.string(), valueSchema).default({}),
    sections: z.record(z.string(), z.record(z.string(), valueSchema)).default({}),
    urltest: z.record(z.string(), z.record(z.string(), valueSchema)).default({}),
    section_interface: z.record(z.string(), z.record(z.string(), valueSchema)).default({}),
    subscription_url: z.record(z.string(), z.record(z.string(), valueSchema)).default({}),
    create_urltest: z.array(z.string().min(1).max(64)).max(50).default([]),
    create_sections: z.array(z.string().regex(NAME_RE)).max(20).default([]),
    // merge: list_extras дополняют ручные списки (шаблоны).
    // replace: ручные списки берутся только из payload (редактирование правила).
    manual_entries_mode: z.enum(['merge', 'replace']).default('merge'),
    manual_entries: z
      .record(
        z.string(),
        z
          .object({
            domains: z.array(z.string().trim().min(1).max(512)).max(MAX_MANUAL_ENTRIES).default([]),
            ips: z.array(z.string().trim().min(1).max(64)).max(MAX_MANUAL_ENTRIES).default([]),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();

export type TemplatePayload = z.infer<typeof templatePayloadSchema>;

export const templateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional().nullable(),
    payload: templatePayloadSchema,
    exclusions: z.array(z.string().min(1).max(160)).max(500).default([]),
  })
  .strict();

export type TemplateInput = z.infer<typeof templateInputSchema>;

/**
 * «Пресет» шаблона — то, что реально применяется к одной секции роутера.
 * В нём нет имени секции: имя выбирается на роутере.
 */
export interface TemplatePreset {
  action: string;
  enabled: string;
  resources: Record<string, UciValue>;
  manual_domains: string[];
  manual_ips: string[];
  settings: Record<string, UciValue>;
  podkop: z.infer<typeof podkopTemplateSchema>;
}

/** Поля, которые задаются отдельно и не должны попадать в resources. */
const PRESET_RESOURCE_RESERVED = new Set([
  'label',
  'action',
  'enabled',
  'domain_ip_lists',
]);

export function emptyTemplatePayload(): TemplatePayload {
  return {
    resources: {},
    manual_domains: [],
    manual_ips: [],
    podkop: { options: {} },
    settings: {},
    sections: {},
    urltest: {},
    section_interface: {},
    subscription_url: {},
    create_urltest: [],
    create_sections: [],
    manual_entries_mode: 'merge',
    manual_entries: {},
  };
}

/**
 * Проверяет ресурсы шаблона/правила теми же правилами, что и обычные пути UCI.
 * Секретные и служебные опции здесь запрещены.
 */
export function validateTemplateResources(resources: Record<string, UciValue>): void {
  for (const [option, value] of Object.entries(resources)) {
    if (PRESET_RESOURCE_RESERVED.has(option)) {
      throw badRequest(
        'invalid_resource_option',
        `Параметр «${option}» задаётся отдельно и не входит в ресурсы`,
        { option },
      );
    }
    const rule = assertAllowedPath(`section.__preset__.${option}`);
    normalizeValue(value, rule.list);
    if (option === 'community_lists') {
      const values = Array.isArray(value) ? value : value == null ? [] : [String(value)];
      for (const item of values) {
        if (!ROUTING_SERVICE_IDS.has(item)) {
          throw badRequest(
            'unknown_community_list',
            `Неизвестный список «${item}». Выберите ресурс из каталога Prokop/Forkop.`,
            { value: item },
          );
        }
      }
    }
  }
}

/**
 * Приводит сохранённый шаблон (старый или новый) к простому пресету.
 * Старый шаблон с одной секцией читается как пресет этой секции.
 */
export function presetFromPayload(payload: TemplatePayload): TemplatePreset {
  const podkopValues = payload.podkop ?? { options: {} };
  const hasPodkop =
    Boolean(podkopValues.connection_type) ||
    Boolean(podkopValues.proxy_config_type) ||
    Boolean(podkopValues.user_domain_list_type) ||
    Boolean(podkopValues.user_domains_text) ||
    Boolean(podkopValues.user_subnet_list_type) ||
    Boolean(podkopValues.user_subnets_text) ||
    Object.keys(podkopValues.options ?? {}).length > 0;
  const hasNewFormat =
    Boolean(payload.action) ||
    Object.keys(payload.resources ?? {}).length > 0 ||
    payload.manual_domains.length > 0 ||
    payload.manual_ips.length > 0 ||
    hasPodkop;

  if (hasNewFormat) {
    validateTemplateResources(payload.resources);
    validateManualEntries(payload.manual_domains, payload.manual_ips);
    const action = payload.action ?? 'connection';
    if (!(ROUTING_ACTION_IDS as Set<string>).has(action)) {
      throw badRequest('invalid_action', `Неизвестное действие «${action}»`);
    }
    return {
      action,
      enabled: payload.enabled == null ? '1' : String(payload.enabled),
      resources: { ...payload.resources },
      manual_domains: payload.manual_domains.filter((line) => !isCommentLine(line)),
      manual_ips: payload.manual_ips.filter((line) => !isCommentLine(line)),
      settings: { ...payload.settings },
      podkop: { ...payload.podkop },
    };
  }

  const entries = Object.entries(payload.sections);
  if (entries.length === 0) {
    return {
      action: 'connection',
      enabled: '1',
      resources: {},
      manual_domains: [],
      manual_ips: [],
      settings: { ...payload.settings },
      podkop: { ...payload.podkop },
    };
  }

  const connectionEntries = entries.filter(([, options]) => {
    const action = options.action;
    return typeof action === 'string' && CONNECTION_ACTIONS.has(action);
  });
  const chosen =
    connectionEntries.length === 1
      ? connectionEntries[0]
      : entries.length === 1
        ? entries[0]
        : null;
  if (!chosen) {
    throw badRequest(
      'legacy_multi_section',
      'Шаблон старого формата содержит несколько секций. Откройте его в редакторе и сохраните как шаблон без имён секций.',
    );
  }

  const [sectionName, options] = chosen;
  const resources: Record<string, UciValue> = {};
  for (const [option, value] of Object.entries(options)) {
    if (PRESET_RESOURCE_RESERVED.has(option)) continue;
    resources[option] = value;
  }
  const manual = payload.manual_entries[sectionName] ?? { domains: [], ips: [] };
  validateManualEntries(manual.domains, manual.ips);
  const action =
    typeof options.action === 'string' && options.action !== '' ? options.action : 'connection';
  if (!(ROUTING_ACTION_IDS as Set<string>).has(action)) {
    throw badRequest('invalid_action', `Неизвестное действие «${action}»`);
  }
  return {
    action,
    enabled: options.enabled == null ? '1' : String(options.enabled),
    resources,
    manual_domains: manual.domains.filter((line) => !isCommentLine(line)),
    manual_ips: manual.ips.filter((line) => !isCommentLine(line)),
    settings: { ...payload.settings },
    podkop: { ...payload.podkop },
  };
}

/**
 * Разворачивает пресет в обычный payload для конкретной секции.
 * Дальше работают уже существующие buildPlan/computePlan/diff/apply.
 */
export function materializePresetForSection(
  preset: TemplatePreset,
  section: string,
  create: boolean,
): TemplatePayload {
  if (!NAME_RE.test(section)) {
    throw badRequest('invalid_section', `Некорректное имя секции «${section}»`);
  }
  if (!(ROUTING_ACTION_IDS as Set<string>).has(preset.action)) {
    throw badRequest('invalid_action', `Неизвестное действие «${preset.action}»`);
  }
  validateTemplateResources(preset.resources);
  return {
    ...emptyTemplatePayload(),
    settings: { ...preset.settings },
    podkop: { ...preset.podkop },
    sections: {
      [section]: {
        ...preset.resources,
        action: preset.action,
        enabled: preset.enabled,
      },
    },
    manual_entries: {
      [section]: {
        domains: [...preset.manual_domains],
        ips: [...preset.manual_ips],
      },
    },
    create_sections: create ? [section] : [],
  };
}

export interface SectionRuleInput {
  section: string;
  label?: string;
  action: string;
  enabled?: boolean;
  resources?: Record<string, UciValue>;
  manual_domains?: string[];
  manual_ips?: string[];
  settings?: Record<string, UciValue>;
  create?: boolean;
}

/**
 * Собирает payload для ручного правила. Все ресурсы передаются полностью:
 * списки в UCI заменяются целиком, поэтому частичный набор удалил бы
 * существующие домены и списки.
 */
export function sectionRulePayload(input: SectionRuleInput): TemplatePayload {
  if (!NAME_RE.test(input.section)) {
    throw badRequest('invalid_section', `Некорректное имя секции «${input.section}»`);
  }
  if (!(ROUTING_ACTION_IDS as Set<string>).has(input.action)) {
    throw badRequest('invalid_action', `Неизвестное действие «${input.action}»`);
  }
  const resources = input.resources ?? {};
  validateTemplateResources(resources);
  validateManualEntries(input.manual_domains ?? [], input.manual_ips ?? []);

  const options: Record<string, UciValue> = { ...resources };
  options.action = input.action;
  options.enabled = input.enabled === false ? '0' : '1';
  if (input.label) options.label = input.label.slice(0, 120);

  return {
    ...emptyTemplatePayload(),
    settings: input.settings ?? {},
    sections: { [input.section]: options },
    manual_entries_mode: 'replace',
    manual_entries: {
      [input.section]: {
        domains: input.manual_domains ?? [],
        ips: input.manual_ips ?? [],
      },
    },
    create_sections: input.create ? [input.section] : [],
  };
}

/** Разворачивает payload в плоскую карту path → значение. */
export function templateToDesired(payload: TemplatePayload): Map<string, UciValue> {
  const desired = new Map<string, UciValue>();

  for (const [option, value] of Object.entries(payload.settings)) {
    const path = `settings.${option}`;
    const rule = assertAllowedPath(path);
    const normalized = normalizeValue(value, rule.list);
    if (normalized !== null) desired.set(path, normalized);
  }

  const groupsByType = {
    section: payload.sections,
    urltest: payload.urltest,
    section_interface: payload.section_interface,
    subscription_url: payload.subscription_url,
  } as const;

  for (const type of ['section', 'urltest', 'section_interface', 'subscription_url'] as const) {
    const groups = groupsByType[type];
    for (const [section, options] of Object.entries(groups)) {
      if (FORBIDDEN_TYPES.has(type)) continue;
      if (!NAME_RE.test(section)) {
        throw badRequest('invalid_section', `Некорректное имя секции «${section}»`);
      }
      for (const [option, value] of Object.entries(options as Record<string, UciValue>)) {
        const path = `${type}.${section}.${option}`;
        const rule = assertAllowedPath(path);
        if (type === 'section' && LEGACY_DOMAIN_OPTIONS.has(option)) {
          pushTextValue(desired, `section.${section}.domain`, domainOptionLines(option, value));
          continue;
        }
        let normalized: UciValue = normalizeValue(value, rule.list);
        if (type === 'section' && rule.list && Array.isArray(normalized)) {
          normalized = normalized.filter((item) => !isCommentLine(item));
          if (normalized.length === 0) normalized = null;
        }
        if (normalized !== null) {
          if (type === 'section' && option === 'community_lists') {
            const values = Array.isArray(normalized) ? normalized : [String(normalized)];
            for (const item of values) {
              if (!ROUTING_SERVICE_IDS.has(item)) {
                throw badRequest(
                  'unknown_community_list',
                  `Неизвестный список «${item}». Выберите ресурс из каталога Prokop/Forkop.`,
                  { value: item },
                );
              }
            }
          }
          desired.set(path, normalized);
        }
      }
    }
  }

  for (const name of payload.create_urltest) {
    if (!NAME_RE.test(name)) {
      throw badRequest('invalid_section', `Некорректное имя urltest-группы «${name}»`);
    }
    if (!desired.has(`urltest.${name}.name`)) {
      desired.set(`urltest.${name}.name`, name);
    }
  }

  if (desired.size > 500) {
    throw badRequest('template_too_large', 'Шаблон содержит более 500 управляемых параметров');
  }
  return desired;
}

/**
 * Кандидаты на удаление: только allowlist-параметры внутри областей, которыми
 * управляет шаблон (settings + явно перечисленные секции/группы), за вычетом
 * exclusions. Секретные пути сюда попасть не могут.
 */
export function deletionCandidates(
  payload: TemplatePayload,
  current: Record<string, UciValue>,
  exclusions: Set<string>,
  extraSections: string[] = [],
): Set<string> {
  const candidates = new Set<string>();
  const sections = new Set([...Object.keys(payload.sections), ...extraSections, ...payload.create_sections]);
  const urltests = new Set([
    ...Object.keys(payload.urltest),
    ...payload.create_urltest,
  ]);
  const interfaces = new Set(Object.keys(payload.section_interface));
  const subscriptions = new Set(Object.keys(payload.subscription_url));

  for (const path of Object.keys(current)) {
    let parsed: ParsedPath;
    try {
      parsed = parseUciPath(path);
    } catch {
      continue;
    }
    const rule = classifyPath(path);
    if (!rule.allowed) continue;
    if (exclusions.has(path)) continue;

    if (parsed.type === 'settings') {
      // Удаление настроек — только явное: option: null в payload.
      if (payload.settings[parsed.option] === null) candidates.add(path);
    } else if (parsed.type === 'section' && parsed.section && sections.has(parsed.section)) {
      // Скалярные опции секции (action, label, enabled, sort_by_latency…)
      // не удаляются «по умолчанию»: шаблон списков не должен их терять.
      // Домены — исключение: старые list-опции и combined `domain`
      // удаляются, если их нет в желаемом наборе.
      if (SECTION_LIST_OPTIONS.has(parsed.option) || LEGACY_DOMAIN_OPTIONS.has(parsed.option)) {
        candidates.add(path);
      }
    } else if (parsed.type === 'urltest' && parsed.section && urltests.has(parsed.section)) {
      candidates.add(path);
    } else if (
      parsed.type === 'section_interface' &&
      parsed.section &&
      interfaces.has(parsed.section)
    ) {
      candidates.add(path);
    } else if (
      parsed.type === 'subscription_url' &&
      parsed.section &&
      subscriptions.has(parsed.section)
    ) {
      candidates.add(path);
    }
  }

  // Явно пустые ручные списки: ссылка на локальный список должна быть удалена,
  // иначе последний удалённый адрес остаётся в конфигурации.
  for (const [section, entry] of Object.entries(payload.manual_entries)) {
    if (entry.domains.length > 0 || entry.ips.length > 0) continue;
    const path = `section.${section}.domain_ip_lists`;
    if (exclusions.has(path)) continue;
    if (classifyPath(path).allowed) candidates.add(path);
  }

  return candidates;
}

export interface DiffItem {
  op: 'add' | 'change' | 'delete';
  path: string;
  before: UciValue | null;
  after: UciValue | null;
}

export interface DiffPlan {
  items: DiffItem[];
  localLists: LocalList[];
  createSections: string[];
  desiredHash: string;
}

export function computePlan(
  payload: TemplatePayload,
  current: Record<string, UciValue>,
  exclusions: string[],
  extras: RouterListExtras = {},
): DiffPlan {
  const plan = buildPlan(payload, exclusions, extras);
  const exclusionSet = new Set(plan.exclusions);

  const items: DiffItem[] = [];
  const paths = new Set<string>([
    ...plan.desired.keys(),
    ...deletionCandidates(payload, current, exclusionSet, plan.createSections),
  ]);

  for (const path of [...paths].sort()) {
    const before = current[path] ?? null;
    const after = plan.desired.get(path) ?? null;

    // Явное исключение не может одновременно управляться шаблоном.
    if (after !== null && exclusionSet.has(path)) {
      throw badRequest(
        'conflicting_exclusion',
        `Параметр «${path}» одновременно задан и исключён`,
        { path },
      );
    }
    if (before === null && after === null) continue;

    if (before === null) {
      items.push({ op: 'add', path, before: null, after });
    } else if (after === null) {
      items.push({ op: 'delete', path, before, after: null });
    } else if (canonicalJson(before) !== canonicalJson(after)) {
      items.push({ op: 'change', path, before, after });
    }
  }

  return { items, localLists: plan.localLists, createSections: plan.createSections, desiredHash: plan.desiredHash };
}

export function computeDiff(
  payload: TemplatePayload,
  current: Record<string, UciValue>,
  exclusions: string[],
  extras: RouterListExtras = {},
): DiffItem[] {
  return computePlan(payload, current, exclusions, extras).items;
}

export function diffHash(items: DiffItem[]): string {
  return sha256Hex(canonicalJson(items));
}

export function stateHash(current: Record<string, UciValue>): string {
  return sha256Hex(canonicalJson(current));
}

export function validateExclusions(exclusions: string[]): string[] {
  const unique = [...new Set(exclusions)];
  for (const path of unique) assertAllowedPath(path);
  return unique;
}

/** Проверка выходных данных агента: никаких запрещённых/секретных путей. */
export function sanitizeAgentState(managed: unknown): Record<string, UciValue> {
  if (!managed || typeof managed !== 'object' || Array.isArray(managed)) {
    throw badRequest('invalid_agent_state', 'Агент вернул некорректное состояние');
  }
  const output: Record<string, UciValue> = {};
  for (const [path, raw] of Object.entries(managed as Record<string, unknown>)) {
    const rule = classifyPath(path);
    if (!rule.allowed) continue;
    if (raw === null || raw === undefined) continue;
    if (Array.isArray(raw)) {
      output[path] = raw.map((item) => String(item)).slice(0, 200);
    } else if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      output[path] = String(raw);
    }
  }
  return output;
}
