/**
 * Встроенные списки Forkop 2.x отличаются от Prokop/Forkop 1.x.
 * Старые шаблоны и правила хранят привычные ID (meta, twitter, google_ai),
 * а Forkop 2.x знает facebook/instagram/whatsapp, x и gemini. Здесь
 * приводим списки к тому набору, который понимает установленный продукт.
 */

import { ROUTING_SERVICES } from './routing.js';

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

/** Копия payload с нормализованными community_lists во всех секциях. */
export function normalizeTemplateLists<T extends { sections: Record<string, Record<string, unknown>> }>(
  payload: T,
  product: string | null | undefined,
  version: string | null | undefined,
): T {
  if (!isForkop2(product, version)) return payload;
  const sections: Record<string, Record<string, unknown>> = {};
  for (const [name, options] of Object.entries(payload.sections)) {
    const value = options.community_lists;
    if (value === undefined) {
      sections[name] = options;
      continue;
    }
    const source = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
    const normalized = normalizeCommunityLists(source, product, version).lists;
    sections[name] = {
      ...options,
      community_lists: normalized.length > 0 ? normalized : null,
    };
  }
  return { ...payload, sections };
}
