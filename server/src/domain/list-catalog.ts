import { TACHYON_CATALOG } from './tachyon-catalog.js';
import { ROUTING_SERVICES } from './routing.js';
import { PODKOP_COMMUNITY_SERVICES } from './podkop.js';

/**
 * Единый каталог списков RoutX.
 *
 * Источник истины — Dushnilin/tachyon-lists. Для Tachyon списки используются
 * нативно, для Prokop/Forkop добавляются как rule-set, для Podkop
 * разворачиваются в user_domains/user_subnets.
 */

export interface CatalogGroup {
  id: string;
  label: string;
  icon: string;
}

export const CATALOG_GROUPS: CatalogGroup[] = [
  { id: 'ai', label: 'Нейросети', icon: '✦' },
  { id: 'media', label: 'Медиа', icon: '▶' },
  { id: 'social', label: 'Соцсети', icon: '💬' },
  { id: 'gaming', label: 'Игры', icon: '🎮' },
  { id: 'tech', label: 'Технологии', icon: '⌘' },
  { id: 'infra', label: 'Инфраструктура', icon: '☁' },
  { id: 'regional', label: 'Регионы', icon: '🌍' },
  { id: 'direct', label: 'Напрямую', icon: '➡' },
  { id: 'block', label: 'Блокировки', icon: '⛔' },
  { id: 'other', label: 'Разное', icon: '•' },
  { id: 'internal', label: 'Служебные', icon: '⚙' },
];

export const CATALOG_GROUP_MAP = new Map(CATALOG_GROUPS.map((group) => [group.id, group]));

export type Delivery = 'native' | 'rule_set' | 'domains' | 'unsupported';

export interface CatalogService {
  id: string;
  label: string;
  title: string;
  description: string;
  note: string;
  group: string;
  group_label: string;
  group_icon: string;
  kind: string;
  recommended_action: string;
  counts: {
    domains: number;
    subnets: number;
    domain: number;
    domain_suffix: number;
    domain_keyword: number;
    domain_regex: number;
    ipv4_cidr: number;
    ipv6_cidr: number;
  };
  native: boolean;
  delivery: Delivery;
  url: string | null;
}

export const TACHYON_CATALOG_BY_ID = new Map(TACHYON_CATALOG.map((item) => [item.id, item]));

// Четыре служебных geo-списка tachyon-lists не входят в COMMUNITY_SERVICES
// Tachyon 1.7.x — для них используем rule-set.
const TACHYON_INTERNAL = new Set(['geosite_ru', 'geoip_ru', 'geoip_us', 'geoip_cn']);

const PROKOP_NATIVE = new Set(ROUTING_SERVICES.map((item) => item.id));

// Нативные имена Forkop 2.x.
const FORKOP2_NATIVE = new Set([
  'ru_blocked_all',
  'ru_blocked_rkn',
  'ru_blocked_geo',
  'ru_only',
  'ua_blocked',
  'ai',
  'chatgpt',
  'claude',
  'cloudflare',
  'digitalocean',
  'discord',
  'facebook',
  'gemini',
  'github',
  'google_play',
  'hetzner',
  'instagram',
  'ovh',
  'roblox',
  'spotify',
  'supercell',
  'telegram',
  'tiktok',
  'twitch',
  'whatsapp',
  'x',
  'youtube',
  'ads',
]);

const FORKOP2_ASN_LISTS = new Set(['digitalocean', 'hetzner', 'ovh']);

const FORKOP2_FROM_CANONICAL: Record<string, string[]> = {
  meta: ['facebook', 'instagram'],
  twitter: ['x'],
  google_ai: ['gemini'],
  openai: ['chatgpt'],
  anthropic: ['claude'],
  ai_all: ['ai'],
  ads_hagezi_pro: ['ads'],
  geoblock: ['ru_blocked_geo'],
  russia_inside: ['ru_only'],
  russia_outside: ['ru_blocked_all'],
  ukraine_inside: ['ua_blocked'],
};

const ALIASES: Record<string, string> = {
  facebook: 'meta',
  instagram: 'meta',
  x: 'twitter',
  gemini: 'google_ai',
  chatgpt: 'openai',
  claude: 'anthropic',
  ads: 'ads_hagezi_pro',
  ru_blocked_geo: 'geoblock',
  ru_blocked_rkn: 'ru_blocked',
  ru_only: 'russia_inside',
  ua_blocked: 'ukraine_inside',
  ai: 'ai_all',
};

export function canonicalListId(value: string): string | null {
  const id = value.trim();
  if (id === '') return null;
  if (TACHYON_CATALOG_BY_ID.has(id)) return id;
  return ALIASES[id] ?? null;
}

export function isCatalogList(value: string): boolean {
  return TACHYON_CATALOG_BY_ID.has(value);
}

function forkop2(product: string | null | undefined, version: string | null | undefined): boolean {
  if (product !== 'forkop') return false;
  const match = /^v?(\d+)/.exec(String(version ?? '').trim());
  return match != null && Number(match[1]) >= 2;
}

function forkop20(version: string | null | undefined): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  return match != null && Number(match[1]) === 2 && Number(match[2]) === 0;
}

export function nativeListIds(
  canonical: string,
  product: string | null | undefined,
  version: string | null | undefined,
): string[] {
  if (product === 'tachyon') {
    return TACHYON_INTERNAL.has(canonical) ? [] : [canonical];
  }
  if (forkop2(product, version)) {
    const direct = FORKOP2_NATIVE.has(canonical) ? [canonical] : [];
    const mapped = FORKOP2_FROM_CANONICAL[canonical] ?? [];
    const all = [...new Set([...direct, ...mapped])];
    return forkop20(version) ? all.filter((id) => !FORKOP2_ASN_LISTS.has(id)) : all;
  }
  if (product === 'podkop') {
    return PODKOP_COMMUNITY_SERVICES.has(canonical) ? [canonical] : [];
  }
  return PROKOP_NATIVE.has(canonical) ? [canonical] : [];
}

const RELEASES = 'https://github.com/Dushnilin/tachyon-lists/releases/download/latest';
const RAW = 'https://raw.githubusercontent.com/Dushnilin/tachyon-lists/main/release';

export function ruleSetUrl(
  product: string | null | undefined,
  version: string | null | undefined,
  id: string,
): string {
  if (forkop2(product, version)) return `${RELEASES}/${id}.json`;
  return `${RELEASES}/${id}.srs`;
}

export function domainsUrl(id: string): string {
  return `${RAW}/domains/${id}.lst`;
}

export function subnetsUrl(id: string): string {
  return `${RAW}/subnets/${id}.lst`;
}

function labelFromTitle(title: string, fallback: string): string {
  let before = title.split(/\s+—\s+/)[0]?.trim() ?? '';
  before = before.replace(/\s*\((?:Block|Direct|Proxy)\)\s*$/i, '').trim();
  if (before === '') return fallback;
  if (before.length <= 56) return before;
  const cut = before.slice(0, 54);
  const index = cut.lastIndexOf(' ');
  return `${(index > 24 ? cut.slice(0, index) : cut).trim()}…`;
}

function splitNote(description: string): { note: string; description: string } {
  const match = /^\[([^\]]+)\]\s*(.*)$/.exec(description.trim());
  if (!match) return { note: '', description: description.trim() };
  return { note: match[1]!.trim(), description: match[2]!.trim() };
}

export function catalogForRouter(
  product: string | null | undefined,
  version: string | null | undefined,
): CatalogService[] {
  return TACHYON_CATALOG.map((item) => {
    const group = CATALOG_GROUP_MAP.get(item.group) ?? CATALOG_GROUP_MAP.get('other')!;
    const nativeIds = nativeListIds(item.id, product, version);
    const isNative = nativeIds.length > 0;
    const delivery: Delivery = isNative
      ? 'native'
      : product === 'podkop'
        ? 'domains'
        : 'rule_set';
    const { note, description } = splitNote(item.description);
    return {
      id: item.id,
      label: labelFromTitle(item.title, item.id),
      title: item.title,
      description,
      note,
      group: group.id,
      group_label: group.label,
      group_icon: group.icon,
      kind: item.kind,
      recommended_action: item.recommended_action,
      counts: {
        domains:
          item.counts.domain +
          item.counts.domain_suffix +
          item.counts.domain_keyword +
          item.counts.domain_regex,
        subnets: item.counts.ipv4_cidr + item.counts.ipv6_cidr,
        domain: item.counts.domain,
        domain_suffix: item.counts.domain_suffix,
        domain_keyword: item.counts.domain_keyword,
        domain_regex: item.counts.domain_regex,
        ipv4_cidr: item.counts.ipv4_cidr,
        ipv6_cidr: item.counts.ipv6_cidr,
      },
      native: isNative,
      delivery,
      url:
        delivery === 'rule_set'
          ? ruleSetUrl(product, version, item.id)
          : delivery === 'domains'
            ? domainsUrl(item.id)
            : null,
    };
  });
}

export { TACHYON_CATALOG };
