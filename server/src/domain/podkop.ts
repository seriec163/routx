import { badRequest } from '../lib/errors.js';
import { sha256Hex } from '../lib/crypto.js';
import { z } from 'zod';
import { ROUTING_SERVICE_IDS } from './routing.js';
import { uciValueSchema, type DiffItem, type UciValue } from './uci.js';

/**
 * Редактирование секций Podkop.
 *
 * В отличие от шаблонов Forkop/Prokop, здесь нет общего payload на весь
 * конфиг: пользователь меняет одну секцию, а остальные опции Podkop не
 * трогаются. Это важно, потому что у Podkop другой набор полей и своя
 * генерация sing-box.
 */

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export const PODKOP_CONNECTION_TYPES = ['proxy', 'vpn', 'block', 'exclusion'] as const;
export const PODKOP_PROXY_MODES = ['url', 'selector', 'urltest'] as const;

export type PodkopConnectionType = (typeof PODKOP_CONNECTION_TYPES)[number];
export type PodkopProxyMode = (typeof PODKOP_PROXY_MODES)[number];

export interface PodkopSectionInput {
  section: string;
  label?: string;
  create: boolean;
  enabled: boolean;
  connection_type: PodkopConnectionType;
  proxy_config_type?: PodkopProxyMode;
  community_lists?: string[];
  manual_domains?: string[];
  manual_ips?: string[];
  options?: Record<string, UciValue>;
}

export interface PodkopPlan {
  items: DiffItem[];
  createSections: string[];
  desiredHash: string;
}

export const podkopSectionInputSchema = z
  .object({
    section: z.string().regex(NAME_RE),
    label: z.string().trim().max(120).optional(),
    create: z.boolean().default(false),
    enabled: z.boolean().default(true),
    connection_type: z.enum(PODKOP_CONNECTION_TYPES),
    proxy_config_type: z.enum(PODKOP_PROXY_MODES).optional(),
    community_lists: z.array(z.string().max(80)).max(200).default([]),
    manual_domains: z.array(z.string().max(512)).max(5000).default([]),
    manual_ips: z.array(z.string().max(64)).max(5000).default([]),
    options: z.record(z.string(), uciValueSchema).default({}),
  })
  .strict();

const OPTION_KEYS = new Set([
  'enable_udp_over_tcp',
  'urltest_check_interval',
  'urltest_tolerance',
  'urltest_testing_url',
  'mixed_proxy_enabled',
  'mixed_proxy_port',
  'domain_resolver_enabled',
  'resolve_real_ip_for_routing',
]);

const BOOLEAN_OPTIONS = new Set([
  'enable_udp_over_tcp',
  'mixed_proxy_enabled',
  'domain_resolver_enabled',
  'resolve_real_ip_for_routing',
]);

const INTEGER_OPTIONS = new Set(['urltest_tolerance', 'mixed_proxy_port']);

function cleanLines(values: string[] | undefined): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const raw of values ?? []) {
    const value = String(raw).trim();
    if (value === '' || value.startsWith('#')) continue;
    if (value.length > 255) {
      throw badRequest('invalid_manual_entry', `Слишком длинное значение: ${value.slice(0, 40)}…`);
    }
    if (/\s/.test(value)) {
      throw badRequest('invalid_manual_entry', `Значение не должно содержать пробелы: ${value}`);
    }
    if (seen.has(value)) continue;
    seen.add(value);
    output.push(value);
    if (output.length > 5000) {
      throw badRequest('too_many_manual_entries', 'Слишком много ручных доменов или IP');
    }
  }
  return output;
}

function normalizeBoolean(value: UciValue, option: string): string {
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'on') return '1';
  if (text === '0' || text === 'false' || text === 'off') return '0';
  throw badRequest('invalid_option', `Ожидается 0/1 для ${option}`);
}

function normalizeInteger(value: UciValue, option: string): string {
  const text = String(value).trim();
  if (!/^\d{1,6}$/.test(text)) {
    throw badRequest('invalid_option', `Ожидается число для ${option}`);
  }
  return text;
}

function normalizeOptions(options: Record<string, UciValue> | undefined): Map<string, UciValue> {
  const output = new Map<string, UciValue>();
  for (const [key, raw] of Object.entries(options ?? {})) {
    if (!OPTION_KEYS.has(key)) {
      throw badRequest('option_not_allowed', `Параметр Podkop <${key}> нельзя менять через RoutX`);
    }
    if (raw === null || raw === undefined) {
      output.set(key, null);
      continue;
    }
    if (BOOLEAN_OPTIONS.has(key)) {
      output.set(key, normalizeBoolean(raw, key));
      continue;
    }
    if (INTEGER_OPTIONS.has(key)) {
      output.set(key, normalizeInteger(raw, key));
      continue;
    }
    if (key === 'urltest_check_interval') {
      const text = String(raw).trim();
      if (!/^\d{1,5}[smh]?$/.test(text)) {
        throw badRequest('invalid_option', 'Интервал urltest: например 3m или 180s');
      }
      output.set(key, text);
      continue;
    }
    if (key === 'urltest_testing_url') {
      const text = String(raw).trim();
      if (!/^https?:\/\/\S+$/i.test(text)) {
        throw badRequest('invalid_option', 'URL проверки должен начинаться с http:// или https://');
      }
      output.set(key, text);
      continue;
    }
    output.set(key, String(raw));
  }
  return output;
}

function desiredValue(
  current: Record<string, UciValue>,
  path: string,
  after: UciValue,
): DiffItem | null {
  const before = current[path] ?? null;
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  const op = before === null ? 'add' : after === null ? 'delete' : 'change';
  return { op, path, before, after };
}

export function computePodkopPlan(
  input: PodkopSectionInput,
  current: Record<string, UciValue>,
): PodkopPlan {
  if (!NAME_RE.test(input.section)) {
    throw badRequest('invalid_section', `Некорректное имя секции <${input.section}>`);
  }
  if (!PODKOP_CONNECTION_TYPES.includes(input.connection_type)) {
    throw badRequest('invalid_connection_type', 'Неизвестный тип секции Podkop');
  }

  const desired = new Map<string, UciValue>();
  const put = (option: string, value: UciValue): void => {
    desired.set(`section.${input.section}.${option}`, value);
  };

  put('enabled', input.enabled ? '1' : '0');
  put('connection_type', input.connection_type);

  if (input.connection_type === 'proxy' || input.connection_type === 'vpn') {
    const currentMode = current[`section.${input.section}.proxy_config_type`];
    const mode =
      input.proxy_config_type ??
      (typeof currentMode === 'string' && PODKOP_PROXY_MODES.includes(currentMode as PodkopProxyMode)
        ? (currentMode as PodkopProxyMode)
        : 'url');
    put('proxy_config_type', mode);
  }

  if (input.community_lists !== undefined) {
    const ids: string[] = [];
    for (const raw of input.community_lists) {
      const id = String(raw).trim();
      if (id === '') continue;
      if (!ROUTING_SERVICE_IDS.has(id)) {
        throw badRequest('unknown_community_list', `Неизвестный список <${id}>`);
      }
      if (!ids.includes(id)) ids.push(id);
    }
    put('community_lists', ids.length > 0 ? ids : null);
  }

  if (input.manual_domains !== undefined) {
    const domains = cleanLines(input.manual_domains);
    put('user_domains', domains.length > 0 ? domains : null);
    put('user_domain_list_type', domains.length > 0 ? 'dynamic' : null);
    put('user_domains_text', null);
  }

  if (input.manual_ips !== undefined) {
    const ips = cleanLines(input.manual_ips);
    put('user_subnets', ips.length > 0 ? ips : null);
    put('user_subnet_list_type', ips.length > 0 ? 'dynamic' : null);
    put('user_subnets_text', null);
  }

  for (const [key, value] of normalizeOptions(input.options)) {
    put(key, value);
  }

  const items: DiffItem[] = [];
  for (const [path, after] of desired) {
    const item = desiredValue(current, path, after);
    if (item) items.push(item);
  }
  items.sort((a, b) => a.path.localeCompare(b.path));

  const desiredHash = sha256Hex(
    JSON.stringify([...desired.entries()].sort(([a], [b]) => a.localeCompare(b))),
  );

  return {
    items,
    createSections: input.create ? [input.section] : [],
    desiredHash,
  };
}
