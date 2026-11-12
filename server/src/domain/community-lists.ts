/**
 * Списки сообществ RoutX.
 *
 * Источник истины — Dushnilin/tachyon-lists. Внутри храним канонические ID
 * Tachyon, а для конкретного продукта раскладываем их:
 * - Tachyon — нативно;
 * - Forkop 2.x — в родные имена (facebook/x/gemini/...) либо rule-set JSON;
 * - Prokop/Forkop 1.x — нативно либо rule-set SRS;
 * - Podkop — нативно либо domains/subnets из tachyon-lists.
 */

import { isIP } from 'node:net';
import {
  canonicalListId,
  domainsUrl,
  nativeListIds,
  ruleSetUrl,
  subnetsUrl,
} from './list-catalog.js';

export function isForkop2(
  product: string | null | undefined,
  version: string | null | undefined,
): boolean {
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

export interface NormalizedLists {
  lists: string[];
  dropped: string[];
}

/** Приводит любые исторические имена к каноническим ID tachyon-lists. */
export function normalizeCommunityLists(
  lists: readonly string[],
  _product: string | null | undefined,
  _version: string | null | undefined,
): NormalizedLists {
  const result: string[] = [];
  const dropped: string[] = [];
  for (const raw of lists) {
    const id = String(raw).trim();
    if (id === '') continue;
    const canonical = canonicalListId(id);
    if (!canonical) {
      if (!dropped.includes(id)) dropped.push(id);
      continue;
    }
    if (!result.includes(canonical)) result.push(canonical);
  }
  return { lists: result, dropped };
}

/** Канонические ID для интерфейса (каталог тоже канонический). */
export function displayCommunityLists(
  lists: readonly string[],
  product: string | null | undefined,
  version: string | null | undefined,
): string[] {
  return normalizeCommunityLists(lists, product, version).lists;
}

interface ListEntries {
  domains: string[];
  subnets: string[];
}

const listCache = new Map<string, { at: number; entries: ListEntries }>();
const LIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_FALLBACK_DOMAINS = 20000;
const MAX_FALLBACK_SUBNETS = 5000;

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'RoutX/1.0 list fallback',
        accept: 'text/plain, */*',
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function classifyLine(raw: string): { kind: 'domain' | 'subnet'; value: string } | null {
  const line = raw.trim();
  if (line === '' || line.startsWith('#') || line.startsWith('//')) return null;
  const value = line.replace(/^\+\./, '.').replace(/^\./, '');
  if (value === '') return null;
  const address = value.includes('/') ? value.split('/')[0]! : value;
  if (isIP(address) !== 0) return { kind: 'subnet', value };
  return { kind: 'domain', value };
}

async function fetchListEntries(id: string): Promise<ListEntries> {
  const cached = listCache.get(id);
  if (cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) return cached.entries;

  const [domainsText, subnetsText] = await Promise.all([
    fetchText(domainsUrl(id)),
    fetchText(subnetsUrl(id)),
  ]);
  if (domainsText == null && subnetsText == null) {
    throw new Error(`list ${id} not found`);
  }
  const domains: string[] = [];
  const subnets: string[] = [];
  for (const text of [domainsText, subnetsText]) {
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      const entry = classifyLine(line);
      if (!entry) continue;
      const target = entry.kind === 'subnet' ? subnets : domains;
      if (!target.includes(entry.value)) target.push(entry.value);
      if (
        domains.length >= MAX_FALLBACK_DOMAINS &&
        subnets.length >= MAX_FALLBACK_SUBNETS
      ) {
        break;
      }
    }
  }
  const entries = {
    domains: domains.slice(0, MAX_FALLBACK_DOMAINS),
    subnets: subnets.slice(0, MAX_FALLBACK_SUBNETS),
  };
  listCache.set(id, { at: Date.now(), entries });
  return entries;
}

export interface ListResolution {
  native: string[];
  ruleSets: string[];
  domains: string[];
  subnets: string[];
  dropped: string[];
}

/**
 * Раскладывает канонические списки под конкретный продукт.
 * Всё, что продукт не знает нативно, уходит в rule-set или domains/subnets.
 */
export async function resolveCommunityLists(
  lists: readonly string[],
  product: string | null | undefined,
  version: string | null | undefined,
): Promise<ListResolution> {
  const normalized = normalizeCommunityLists(lists, product, version);
  const native: string[] = [];
  const ruleSets: string[] = [];
  const domains: string[] = [];
  const subnets: string[] = [];
  const dropped = [...normalized.dropped];
  const isPodkop = product === 'podkop';

  for (const id of normalized.lists) {
    const nativeIds = nativeListIds(id, product, version);
    if (nativeIds.length > 0) {
      for (const nativeId of nativeIds) {
        if (!native.includes(nativeId)) native.push(nativeId);
      }
      continue;
    }

    if (isPodkop) {
      try {
        const entries = await fetchListEntries(id);
        for (const item of entries.domains) if (!domains.includes(item)) domains.push(item);
        for (const item of entries.subnets) if (!subnets.includes(item)) subnets.push(item);
      } catch {
        if (!dropped.includes(id)) dropped.push(id);
      }
      continue;
    }

    const url = ruleSetUrl(product, version, id);
    if (!ruleSets.includes(url)) ruleSets.push(url);
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
    const base: Record<string, unknown> = { ...options };
    delete base.outbound_jsons;
    delete base.outbound_json;
    const value = base.community_lists;
    if (value === undefined) {
      sections[name] = base;
      continue;
    }
    const source = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
    const resolved = await resolveCommunityLists(source, product, version);
    for (const item of resolved.domains) if (!fallbackDomains.includes(item)) fallbackDomains.push(item);
    for (const item of resolved.subnets) if (!fallbackSubnets.includes(item)) fallbackSubnets.push(item);
    const next: Record<string, unknown> = {
      ...base,
      community_lists: resolved.native.length > 0 ? resolved.native : null,
    };
    if (resolved.ruleSets.length > 0) {
      next.rule_set = mergeListOption(options.rule_set, resolved.ruleSets);
    }
    sections[name] = next;
  }

  let resources = payload.resources;
  if (resources) {
    resources = { ...resources };
    delete resources.outbound_jsons;
    delete resources.outbound_json;
  }
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
