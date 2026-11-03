/**
 * Встроенные списки Forkop 2.x отличаются от Prokop/Forkop 1.x.
 * Старые шаблоны и правила хранят привычные ID (meta, twitter, google_ai),
 * а Forkop 2.x знает facebook/instagram/whatsapp, x и gemini. Здесь
 * приводим списки к тому набору, который понимает установленный продукт.
 */

import { ROUTING_SERVICES } from './routing.js';
import { PODKOP_COMMUNITY_SERVICES } from './podkop.js';

const LEGACY_SERVICE_IDS = new Set(ROUTING_SERVICES.map((item) => item.id));

const FORKOP2_LISTS = new Set([
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

// В Forkop 2.0.0 этих списков ещё нет; они появились в следующих релизах.
const FORKOP2_200_LISTS = new Set(
  [...FORKOP2_LISTS].filter((id) => !['digitalocean', 'hetzner', 'ovh'].includes(id)),
);

const LEGACY_TO_FORKOP2: Record<string, string[]> = {
  youtube: ['youtube'],
  discord: ['discord'],
  telegram: ['telegram'],
  meta: ['facebook', 'instagram', 'whatsapp'],
  twitter: ['x'],
  tiktok: ['tiktok'],
  google_ai: ['gemini'],
  google_play: ['google_play'],
  cloudflare: ['cloudflare'],
  digitalocean: ['digitalocean'],
  hetzner: ['hetzner'],
  ovh: ['ovh'],
  github: ['github'],
  roblox: ['roblox'],
  supercell: ['supercell'],
  ads_hagezi_pro: ['ads'],
  block: ['ads'],
  russia_inside: ['ru_only'],
  russia_outside: ['ru_blocked_all'],
  ukraine_inside: ['ua_blocked'],
  geoblock: ['ru_blocked_geo'],
};

const FORKOP2_TO_LEGACY: Record<string, string> = {
  youtube: 'youtube',
  discord: 'discord',
  telegram: 'telegram',
  facebook: 'meta',
  instagram: 'meta',
  whatsapp: 'meta',
  x: 'twitter',
  tiktok: 'tiktok',
  gemini: 'google_ai',
  ai: 'google_ai',
  google_play: 'google_play',
  cloudflare: 'cloudflare',
  digitalocean: 'digitalocean',
  hetzner: 'hetzner',
  ovh: 'ovh',
  github: 'github',
  roblox: 'roblox',
  supercell: 'supercell',
  ads: 'ads_hagezi_pro',
  ru_only: 'russia_inside',
  ru_blocked_all: 'russia_outside',
  ru_blocked_geo: 'geoblock',
  ua_blocked: 'ukraine_inside',
};

export function isForkop2(product: string | null | undefined, version: string | null | undefined): boolean {
  if (product !== 'forkop') return false;
  const match = /^v?(\d+)/.exec(String(version ?? '').trim());
  return match != null && Number(match[1]) >= 2;
}

export function isForkop20(
  product: string | null | undefined,
  version: string | null | undefined,
): boolean {
  if (!isForkop2(product, version)) return false;
  const match = /^v?(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  return match != null && Number(match[1]) === 2 && Number(match[2]) === 0;
}

function forkop2Set(version: string | null | undefined): Set<string> {
  return isForkop20('forkop', version) ? FORKOP2_200_LISTS : FORKOP2_LISTS;
}

export interface NormalizedLists {
  lists: string[];
  dropped: string[];
}

/** Legacy/Prokop ID → набор списков Forkop 2.x. */
export function normalizeCommunityLists(
  lists: readonly string[],
  product: string | null | undefined,
  version: string | null | undefined,
): NormalizedLists {
  const result: string[] = [];
  const dropped: string[] = [];
  if (!isForkop2(product, version)) {
    for (const raw of lists) {
      const id = String(raw).trim();
      if (id === '') continue;
      if (LEGACY_SERVICE_IDS.has(id)) {
        if (!result.includes(id)) result.push(id);
        continue;
      }
      const mapped = FORKOP2_TO_LEGACY[id];
      if (!mapped) {
        dropped.push(id);
        continue;
      }
      if (!result.includes(mapped)) result.push(mapped);
    }
    return { lists: result, dropped };
  }
  const allowed = forkop2Set(version);
  for (const raw of lists) {
    const id = String(raw).trim();
    if (id === '') continue;
    if (allowed.has(id)) {
      if (!result.includes(id)) result.push(id);
      continue;
    }
    const mapped = LEGACY_TO_FORKOP2[id];
    if (!mapped) {
      dropped.push(id);
      continue;
    }
    const targets = mapped.filter((target) => allowed.has(target));
    if (targets.length === 0) {
      dropped.push(id);
      continue;
    }
    for (const target of targets) {
      if (!result.includes(target)) result.push(target);
    }
  }
  return { lists: result, dropped };
}

/** Приводит список к ID, которые понимает каталог интерфейса. */
export function displayCommunityLists(
  lists: readonly string[],
  product: string | null | undefined,
  version: string | null | undefined,
): string[] {
  const result: string[] = [];
  for (const raw of lists) {
    const id = String(raw).trim();
    if (id === '') continue;
    const mapped = isForkop2(product, version) ? id : FORKOP2_TO_LEGACY[id] ?? id;
    if (!result.includes(mapped)) result.push(mapped);
  }
  return result;
}

const LIST_BASE = 'https://github.com/ushan0v/forkop-lists/releases/latest/download';
const LIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_FALLBACK_DOMAINS = 12000;
const MAX_FALLBACK_SUBNETS = 3000;

interface ListEntries {
  domains: string[];
  subnets: string[];
}

const listCache = new Map<string, { at: number; entries: ListEntries }>();

function assetTargets(id: string): string[] {
  if (FORKOP2_LISTS.has(id)) return [id];
  return (LEGACY_TO_FORKOP2[id] ?? []).filter((target) => FORKOP2_LISTS.has(target));
}

function listUrl(asset: string): string {
  return `${LIST_BASE}/${asset.replace(/_/g, '-')}.json`;
}

function extractEntries(value: unknown): ListEntries {
  const domains: string[] = [];
  const subnets: string[] = [];
  const seen = new Set<string>();
  const add = (target: string[], item: unknown): void => {
    const text = String(item ?? '').trim();
    if (text === '' || seen.has(text)) return;
    seen.add(text);
    target.push(text);
  };
  const rules =
    value && typeof value === 'object' && Array.isArray((value as { rules?: unknown }).rules)
      ? ((value as { rules: unknown[] }).rules ?? [])
      : [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const item = rule as Record<string, unknown>;
    for (const [key, target] of [
      ['domain', domains],
      ['domain_suffix', domains],
      ['domain_keyword', domains],
      ['domain_regex', domains],
      ['ip_cidr', subnets],
      ['ip', subnets],
    ] as const) {
      const values = item[key];
      if (!Array.isArray(values)) continue;
      for (const entry of values) {
        if (key === 'domain') add(target, `full:${String(entry).trim()}`);
        else if (key === 'domain_keyword') add(target, `keyword:${String(entry).trim()}`);
        else if (key === 'domain_regex') add(target, `regex:${String(entry).trim()}`);
        else add(target, entry);
      }
    }
    if (domains.length >= MAX_FALLBACK_DOMAINS && subnets.length >= MAX_FALLBACK_SUBNETS) break;
  }
  return {
    domains: domains.slice(0, MAX_FALLBACK_DOMAINS),
    subnets: subnets.slice(0, MAX_FALLBACK_SUBNETS),
  };
}

async function fetchListEntries(asset: string): Promise<ListEntries> {
  const cached = listCache.get(asset);
  if (cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) return cached.entries;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(listUrl(asset), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'RoutX/1.0 list fallback',
        accept: 'application/json, */*',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const entries = extractEntries(body);
    listCache.set(asset, { at: Date.now(), entries });
    return entries;
  } finally {
    clearTimeout(timer);
  }
}

export interface ListResolution {
  native: string[];
  ruleSets: string[];
  domains: string[];
  subnets: string[];
  dropped: string[];
}

function nativeForId(
  product: string | null | undefined,
  version: string | null | undefined,
  id: string,
): boolean {
  const mapped = normalizeCommunityLists([id], product, version).lists;
  if (mapped.length === 0) return false;
  if (product === 'podkop') return mapped.every((item) => PODKOP_COMMUNITY_SERVICES.has(item));
  return true;
}

/**
 * Универсальная замена встроенных списков:
 * - продукт знает список — оставляем ID;
 * - продукт умеет rule_set — добавляем URL списка;
 * - Podkop не умеет URL — скачиваем JSON и переносим адреса в user_domains/user_subnets.
 */
export async function resolveCommunityLists(
  lists: readonly string[],
  product: string | null | undefined,
  version: string | null | undefined,
): Promise<ListResolution> {
  const normalized = normalizeCommunityLists(lists, product, version);
  const native =
    product === 'podkop'
      ? normalized.lists.filter((id) => PODKOP_COMMUNITY_SERVICES.has(id))
      : [...normalized.lists];
  const ruleSets: string[] = [];
  const domains: string[] = [];
  const subnets: string[] = [];
  const dropped: string[] = [];
  const assets = new Set<string>();
  const isPodkop = product === 'podkop';

  for (const raw of lists) {
    const id = String(raw).trim();
    if (id === '') continue;
    if (nativeForId(product, version, id)) continue;

    const targets = assetTargets(id);
    if (targets.length === 0) {
      if (!dropped.includes(id)) dropped.push(id);
      continue;
    }
    for (const target of targets) assets.add(target);
  }

  for (const asset of assets) {
    if (!isPodkop) {
      const url = listUrl(asset);
      if (!ruleSets.includes(url)) ruleSets.push(url);
      continue;
    }
    try {
      const entries = await fetchListEntries(asset);
      for (const item of entries.domains) if (!domains.includes(item)) domains.push(item);
      for (const item of entries.subnets) if (!subnets.includes(item)) subnets.push(item);
    } catch {
      if (!dropped.includes(asset)) dropped.push(asset);
    }
  }

  return { native, ruleSets, domains, subnets, dropped };
}

function mergeListOption(existing: unknown, additions: string[]): string[] {
  const values = Array.isArray(existing)
    ? existing.map(String)
    : existing == null
      ? []
      : [String(existing)];
  for (const item of additions) if (!values.includes(item)) values.push(item);
  return values;
}

function textLines(value: unknown): string[] {
  return typeof value === 'string'
    ? value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

/** Копия payload с нормализованными community_lists во всех секциях. */
export async function normalizeTemplateLists<
  T extends {
    sections: Record<string, Record<string, unknown>>;
    podkop?: Record<string, unknown>;
    resources?: Record<string, unknown>;
  },
>(payload: T, product: string | null | undefined, version: string | null | undefined): Promise<T> {
  const sections: Record<string, Record<string, unknown>> = {};
  const fallbackDomains: string[] = [];
  const fallbackSubnets: string[] = [];
  for (const [name, options] of Object.entries(payload.sections)) {
    const value = options.community_lists;
    if (value === undefined) {
      sections[name] = options;
      continue;
    }
    const source = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
    const resolved = await resolveCommunityLists(source, product, version);
    for (const item of resolved.domains) if (!fallbackDomains.includes(item)) fallbackDomains.push(item);
    for (const item of resolved.subnets) if (!fallbackSubnets.includes(item)) fallbackSubnets.push(item);
    const next: Record<string, unknown> = {
      ...options,
      community_lists: resolved.native.length > 0 ? resolved.native : null,
    };
    if (resolved.ruleSets.length > 0) {
      next.rule_set = mergeListOption(options.rule_set, resolved.ruleSets);
    }
    sections[name] = next;
  }

  let resources = payload.resources;
  if (resources && resources.community_lists !== undefined) {
    const value = resources.community_lists;
    const source = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
    const resolved = await resolveCommunityLists(source, product, version);
    for (const item of resolved.domains) if (!fallbackDomains.includes(item)) fallbackDomains.push(item);
    for (const item of resolved.subnets) if (!fallbackSubnets.includes(item)) fallbackSubnets.push(item);
    resources = {
      ...resources,
      community_lists: resolved.native.length > 0 ? resolved.native : null,
    };
    if (resolved.ruleSets.length > 0 && product !== 'podkop') {
      resources.rule_set = mergeListOption(resources.rule_set, resolved.ruleSets);
    }
  }

  const result: T = { ...payload, sections, ...(resources ? { resources } : {}) };
  if (product === 'podkop' && (fallbackDomains.length > 0 || fallbackSubnets.length > 0)) {
    const preset: Record<string, unknown> = { ...(payload.podkop ?? {}) };
    const firstSection = Object.values(payload.sections)[0] ?? {};
    if (fallbackDomains.length > 0) {
      const existing = [
        ...textLines(preset.user_domains_text),
        ...textLines(firstSection.user_domains_text),
        ...(Array.isArray(firstSection.user_domains) ? firstSection.user_domains.map(String) : []),
      ];
      const lines = [...new Set([...existing, ...fallbackDomains])];
      preset.user_domains_text = lines.join('\n');
      preset.user_domain_list_type = 'text';
    }
    if (fallbackSubnets.length > 0) {
      const existing = [
        ...textLines(preset.user_subnets_text),
        ...textLines(firstSection.user_subnets_text),
        ...(Array.isArray(firstSection.user_subnets) ? firstSection.user_subnets.map(String) : []),
      ];
      const lines = [...new Set([...existing, ...fallbackSubnets])];
      preset.user_subnets_text = lines.join('\n');
      preset.user_subnet_list_type = 'text';
    }
    result.podkop = preset;
  }
  return result;
}
