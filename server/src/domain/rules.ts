import { isIP } from 'node:net';
import { sha256Hex } from '../lib/crypto.js';
import type { UciValue } from './uci.js';
import { displayCommunityLists } from './community-lists.js';
import { isCommentLine, type RouterListExtras } from './uci.js';

/**
 * Представление правил (секций) роутера для интерфейса.
 *
 * Источник истины — роутер. Из живого чтения берутся action, enabled,
 * community_lists, домены, подписки и ссылки. Серверная таблица
 * router_connections нужна только для секретов и стабильных идентификаторов,
 * поэтому она дополняет живое чтение, а не заменяет его.
 */

export interface StoredConnection {
  id: string;
  kind: 'subscription' | 'vless';
  label: string;
  section: string;
  /** Расшифрованное значение. В ответ API не попадает. */
  value: string;
  enabled: boolean;
}

export interface AgentSubscription {
  name: string;
  host: string;
  tail: string;
}

export interface AgentLink {
  hash: string;
  scheme: string;
  host: string;
  tail: string;
  label: string;
  proxy_tag?: string;
  proxy_group?: string;
  delay_ms?: number | null;
  alive?: boolean | null;
  active?: boolean;
  selectable?: boolean;
  synthetic?: boolean;
  native?: boolean;
}

export interface AgentSection {
  section: string;
  options: Record<string, UciValue>;
  subscriptions: AgentSubscription[];
  links: AgentLink[];
  lists: Record<string, string[]>;
}

export interface RuleConnectionView {
  kind: 'subscription' | 'link';
  /** Идентификатор router_connections, если подключение ведёт RoutX. */
  id: string | null;
  /** Имя UCI-секции подписки (для внешних подписок). */
  name: string | null;
  /** SHA-256 ссылки (для внешних прямых ссылок). */
  hash: string | null;
  label: string;
  masked: string;
  host: string;
  tail: string;
  managed: boolean;
  enabled: boolean;
  /** Подключение сохранено в RoutX, но не найдено на роутере. */
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
  resources: Record<string, UciValue>;
  manual_domains: string[];
  manual_ips: string[];
  subscriptions: RuleConnectionView[];
  links: RuleConnectionView[];
  source: 'live' | 'cache';
  warnings: string[];
}

const CONNECTION_ACTIONS = new Set(['connection', 'proxy', 'outbound', 'vpn']);
const RESOURCE_SKIP = new Set([
  'label',
  'action',
  'enabled',
  'domain_ip_lists',
  'domain_suffix',
  'domain_keyword',
  'domain_regex',
]);

function asString(value: UciValue | undefined): string {
  if (value == null) return '';
  return Array.isArray(value) ? value.join('\n') : String(value);
}

function decodeLinkLabel(value: string): string {
  if (!value.includes('%')) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function asList(value: UciValue | undefined): string[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [String(value)])
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function maskValue(value: string): string {
  const separator = value.indexOf('://');
  const scheme = separator >= 0 ? value.slice(0, separator + 3) : '';
  const tail = value.slice(-4);
  return `${scheme}••••••••${tail}`;
}

function connectionMask(value: string): { scheme: string; host: string; tail: string } {
  const separator = value.indexOf('://');
  const scheme = separator >= 0 ? value.slice(0, separator) : '';
  const rest = separator >= 0 ? value.slice(separator + 3) : value;
  let stop = rest.length;
  for (const char of ['/', '?', '#']) {
    const index = rest.indexOf(char);
    if (index >= 0 && index < stop) stop = index;
  }
  let host = rest.slice(0, stop);
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  return { scheme, host, tail: value.slice(-4) };
}

export function subscriptionUciName(id: string): string {
  return `rc_sub_${id.replace(/-/g, '').slice(0, 12)}`;
}

function isIpEntry(value: string): boolean {
  const text = value.trim();
  if (text === '' || isCommentLine(text)) return false;
  const slash = text.indexOf('/');
  if (slash === -1) return isIP(text) !== 0;
  return isIP(text.slice(0, slash)) !== 0 && /^\d{1,3}$/.test(text.slice(slash + 1));
}

/**
 * Локальный .lst содержит суффиксные домены и IP/CIDR. Полные домены,
 * keyword: и regex: лежат в combined-опции `domain`, поэтому здесь их нет.
 */
function parseLocalList(lines: string[]): { domains: string[]; ips: string[] } {
  const domains: string[] = [];
  const ips: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || isCommentLine(line)) continue;
    if (isIpEntry(line)) ips.push(line);
    else domains.push(line);
  }
  return { domains, ips };
}

function foldLegacyDomains(options: Record<string, UciValue>): string {
  const lines: string[] = [];
  for (const line of asString(options.domain).split('\n')) {
    const text = line.trim();
    if (text !== '' && !lines.includes(text)) lines.push(text);
  }
  for (const line of asList(options.domain_suffix)) {
    if (!lines.includes(line)) lines.push(line);
  }
  for (const line of asList(options.domain_keyword)) {
    const value = line.startsWith('keyword:') ? line : `keyword:${line}`;
    if (!lines.includes(value)) lines.push(value);
  }
  for (const line of asList(options.domain_regex)) {
    const value = line.startsWith('regex:') ? line : `regex:${line}`;
    if (!lines.includes(value)) lines.push(value);
  }
  return lines.join('\n');
}

function extractOptions(
  managed: Record<string, UciValue>,
  sectionNames: Set<string>,
): Map<string, Record<string, UciValue>> {
  const result = new Map<string, Record<string, UciValue>>();
  for (const [path, value] of Object.entries(managed)) {
    const match = /^section\.([A-Za-z0-9_.-]{1,64})\.([A-Za-z0-9_]{1,64})$/.exec(path);
    if (!match) continue;
    const name = match[1]!;
    sectionNames.add(name);
    const options = result.get(name) ?? {};
    options[match[2]!] = value;
    result.set(name, options);
  }
  return result;
}

function subscriptionsFromState(
  managed: Record<string, UciValue>,
): Map<string, AgentSubscription[]> {
  const result = new Map<string, AgentSubscription[]>();
  for (const [path, value] of Object.entries(managed)) {
    const match = /^subscription_url\.([A-Za-z0-9_.-]{1,64})\.section$/.exec(path);
    if (!match || typeof value !== 'string' || value === '') continue;
    const name = match[1]!;
    const target = value;
    const host = managed[`subscription_url.${name}.url_host`];
    const tail = managed[`subscription_url.${name}.url_tail`];
    const entry: AgentSubscription = {
      name,
      host: typeof host === 'string' ? host : '',
      tail: typeof tail === 'string' ? tail : '',
    };
    const list = result.get(target) ?? [];
    list.push(entry);
    result.set(target, list);
  }
  return result;
}

export function buildRuleViews(input: {
  managed: Record<string, UciValue>;
  agentSections?: AgentSection[];
  connections: StoredConnection[];
  extras?: RouterListExtras;
  source: 'live' | 'cache';
  product?: string;
  productVersion?: string | null;
}): RuleView[] {
  const sectionNames = new Set<string>();
  const optionsFromState = extractOptions(input.managed, sectionNames);
  const agentByName = new Map((input.agentSections ?? []).map((item) => [item.section, item]));
  for (const name of agentByName.keys()) sectionNames.add(name);

  const stateSubscriptions = subscriptionsFromState(input.managed);
  const storedBySection = new Map<string, StoredConnection[]>();
  for (const connection of input.connections) {
    const list = storedBySection.get(connection.section) ?? [];
    list.push(connection);
    storedBySection.set(connection.section, list);
  }

  const rules: RuleView[] = [];
  for (const section of [...sectionNames].sort()) {
    const agent = agentByName.get(section);
    const options = { ...(optionsFromState.get(section) ?? {}), ...(agent?.options ?? {}) };
    const stored = storedBySection.get(section) ?? [];
    const warnings: string[] = [];

    const resources: Record<string, UciValue> = {};
    for (const [option, value] of Object.entries(options)) {
      if (RESOURCE_SKIP.has(option)) continue;
      resources[option] = value;
    }
    const domain = foldLegacyDomains(options);
    if (domain !== '') resources.domain = domain;
    else delete resources.domain;

    if (Array.isArray(resources.community_lists)) {
      resources.community_lists = displayCommunityLists(
        resources.community_lists.map(String),
        input.product,
        input.productVersion,
      );
    } else if (typeof resources.community_lists === 'string') {
      resources.community_lists = displayCommunityLists(
        [resources.community_lists],
        input.product,
        input.productVersion,
      );
    }

    let manualDomains: string[] = [];
    let manualIps: string[] = [];
    if (agent) {
      const paths = asList(options.domain_ip_lists);
      for (const path of paths) {
        const parsed = parseLocalList(agent.lists[path] ?? []);
        manualDomains = [...new Set([...manualDomains, ...parsed.domains])];
        manualIps = [...new Set([...manualIps, ...parsed.ips])];
      }
    } else {
      const extra = input.extras?.[section];
      manualDomains = [...new Set(extra?.manual_domains ?? [])];
      manualIps = [...new Set(extra?.manual_ips ?? [])];
    }

    // Podkop хранит свои домены/IP не в domain_ip_lists, а в user_*.
    if (input.product === 'podkop') {
      const userDomains =
        asString(options.user_domains_text) !== ''
          ? asString(options.user_domains_text)
          : asString(options.user_domains);
      const userSubnets =
        asString(options.user_subnets_text) !== ''
          ? asString(options.user_subnets_text)
          : asString(options.user_subnets);
      manualDomains = [
        ...new Set(
          [...manualDomains, ...userDomains.split('\n').map((line) => line.trim()).filter(Boolean)],
        ),
      ];
      manualIps = [
        ...new Set(
          [...manualIps, ...userSubnets.split('\n').map((line) => line.trim()).filter(Boolean)],
        ),
      ];
    }

    const subscriptions: RuleConnectionView[] = [];
    const links: RuleConnectionView[] = [];
    const storedSubscriptions = stored.filter((item) => item.kind === 'subscription');
    const storedLinks = stored.filter((item) => item.kind === 'vless');
    const usedSubscriptionIds = new Set<string>();
    const usedLinkIds = new Set<string>();

    const agentSubscriptions = agent?.subscriptions ?? stateSubscriptions.get(section) ?? [];
    for (const item of agentSubscriptions) {
      const match = storedSubscriptions.find(
        (connection) => subscriptionUciName(connection.id) === item.name,
      );
      if (match) usedSubscriptionIds.add(match.id);
      subscriptions.push({
        kind: 'subscription',
        id: match?.id ?? null,
        name: item.name,
        hash: null,
        label: match?.label ?? item.host ?? item.name,
        masked: `${item.host ? `${item.host}/` : ''}…${item.tail}`,
        host: item.host,
        tail: item.tail,
        managed: Boolean(match),
        enabled: match?.enabled ?? true,
        missing: false,
      });
    }

    if (agent?.links) {
      for (const item of agent.links) {
        const match = storedLinks.find(
          (connection) => sha256Hex(connection.value) === item.hash,
        );
        if (match) usedLinkIds.add(match.id);
        links.push({
          kind: 'link',
          id: match?.id ?? null,
          name: null,
          hash: item.hash,
          label: match?.label ?? decodeLinkLabel(item.label ?? item.scheme),
          masked: `${item.scheme ? `${item.scheme}://` : ''}••••••••${item.tail}`,
          host: item.host,
          tail: item.tail,
          managed: Boolean(match),
          enabled: match?.enabled ?? true,
          missing: false,
          proxy_tag: item.proxy_tag,
          proxy_group: item.proxy_group,
          delay_ms: item.delay_ms ?? null,
          alive: item.alive ?? null,
          active: item.active === true,
          selectable: item.selectable === true,
          synthetic: item.synthetic === true,
          native: item.native === true,
        });
      }
    } else {
      for (const connection of storedLinks) {
        const mask = connectionMask(connection.value);
        usedLinkIds.add(connection.id);
        links.push({
          kind: 'link',
          id: connection.id,
          name: null,
          hash: sha256Hex(connection.value),
          label: connection.label,
          masked: maskValue(connection.value),
          host: mask.host,
          tail: mask.tail,
          managed: true,
          enabled: connection.enabled,
          missing: false,
        });
      }
    }

    // Сохранённые подключения, которых нет на роутере: показываем, чтобы
    // пользователь видел расхождение, но не удаляем автоматически.
    // Для Podkop в режиме outbound ссылки/подписки не используются
    // (активен JSON outbound), поэтому не засоряем список.
    const podkopOutbound =
      input.product === 'podkop' && asString(options.proxy_config_type) === 'outbound';
    const liveAuthoritative = podkopOutbound || input.product === 'tachyon';
    const externalTails = new Set(
      agentSubscriptions.map((item) => item.tail).filter((tail) => tail !== ''),
    );
    for (const connection of storedSubscriptions) {
      if (liveAuthoritative) continue;
      if (usedSubscriptionIds.has(connection.id)) continue;
      const mask = connectionMask(connection.value);
      if (mask.tail !== '' && externalTails.has(mask.tail)) {
        warnings.push(
          `Подписка «${connection.label}» совпадает с внешней подпиской …${mask.tail}. На роутере она лежит вне RoutX; заменяйте и удаляйте именно внешнюю запись.`,
        );
        continue;
      }
      warnings.push(`Подписка «${connection.label}» сохранена в RoutX, но не найдена на роутере.`);
      subscriptions.push({
        kind: 'subscription',
        id: connection.id,
        name: null,
        hash: null,
        label: connection.label,
        masked: maskValue(connection.value),
        host: mask.host,
        tail: mask.tail,
        managed: true,
        enabled: connection.enabled,
        missing: true,
      });
    }
    for (const connection of storedLinks) {
      if (liveAuthoritative) continue;
      if (usedLinkIds.has(connection.id)) continue;
      const mask = connectionMask(connection.value);
      warnings.push(`Ссылка «${connection.label}» сохранена в RoutX, но не найдена на роутере.`);
      links.push({
        kind: 'link',
        id: connection.id,
        name: null,
        hash: sha256Hex(connection.value),
        label: connection.label,
        masked: maskValue(connection.value),
        host: mask.host,
        tail: mask.tail,
        managed: true,
        enabled: connection.enabled,
        missing: true,
      });
    }

    const hasSources = subscriptions.length + links.length > 0;
    const rawAction = asString(options.action);
    const podkopAction = asString(options.connection_type);
    const action =
      input.product === 'podkop'
        ? podkopAction === 'block'
          ? 'block'
          : podkopAction === 'exclusion'
            ? 'bypass'
            : podkopAction === 'proxy' || podkopAction === 'vpn'
              ? 'connection'
              : hasSources
                ? 'connection'
                : 'bypass'
        : rawAction !== ''
          ? rawAction
          : hasSources
            ? 'connection'
            : 'bypass';

    rules.push({
      section,
      label: asString(options.label) || section,
      action,
      enabled: asString(options.enabled) !== '0',
      resources,
      manual_domains: manualDomains,
      manual_ips: manualIps,
      subscriptions,
      links,
      source: input.source,
      warnings,
    });
  }

  return rules.sort((a, b) => a.label.localeCompare(b.label));
}

export function isConnectionAction(action: string): boolean {
  return CONNECTION_ACTIONS.has(action);
}
