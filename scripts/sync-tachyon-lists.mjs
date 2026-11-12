#!/usr/bin/env node
/**
 * Синхронизирует каталог списков RoutX с Dushnilin/tachyon-lists.
 *
 * Использование:
 *   node scripts/sync-tachyon-lists.mjs
 *
 * Скрипт скачивает release/catalog.json и генерирует
 * server/src/domain/tachyon-catalog.ts. Запускать при обновлении каталога
 * tachyon-lists (например, в CI или вручную перед релизом).
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE =
  process.env.TACHYON_LISTS_CATALOG ??
  'https://raw.githubusercontent.com/Dushnilin/tachyon-lists/main/release/catalog.json';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'server', 'src', 'domain', 'tachyon-catalog.ts');

const response = await fetch(SOURCE, {
  headers: { 'user-agent': 'RoutX catalog sync', accept: 'application/json' },
});
if (!response.ok) {
  throw new Error(`Не удалось скачать каталог: HTTP ${response.status}`);
}
const catalog = await response.json();
if (!Array.isArray(catalog.lists)) {
  throw new Error('В каталоге нет массива lists');
}

const lists = catalog.lists.map((item) => ({
  id: String(item.id),
  group: String(item.group ?? 'other'),
  kind: String(item.kind ?? 'domains'),
  recommended_action: String(item.recommended_action ?? 'proxy'),
  title: String(item.title ?? item.id),
  description: String(item.description ?? ''),
  counts: {
    domain: Number(item.counts?.domain ?? 0),
    domain_suffix: Number(item.counts?.domain_suffix ?? 0),
    domain_keyword: Number(item.counts?.domain_keyword ?? 0),
    domain_regex: Number(item.counts?.domain_regex ?? 0),
    ipv4_cidr: Number(item.counts?.ipv4_cidr ?? 0),
    ipv6_cidr: Number(item.counts?.ipv6_cidr ?? 0),
  },
  files: {
    trs: item.files?.trs ?? null,
    srs: item.files?.srs ?? null,
    json: item.files?.json ?? null,
    domains: item.files?.domains ?? null,
    subnets: item.files?.subnets ?? null,
  },
  fallback_srs: item.fallback_srs ?? null,
}));

const content = `/**
 * Каталог списков Dushnilin/tachyon-lists.
 *
 * Сгенерировано scripts/sync-tachyon-lists.mjs.
 * Не редактировать вручную — обновите каталог и запустите скрипт снова.
 *
 * Источник: ${catalog.repository ?? 'https://github.com/Dushnilin/tachyon-lists'}
 * Версия каталога: ${catalog.version ?? 'unknown'}
 * Сгенерирован: ${catalog.generated_at ?? 'unknown'}
 */

export interface TachyonListCounts {
  domain: number;
  domain_suffix: number;
  domain_keyword: number;
  domain_regex: number;
  ipv4_cidr: number;
  ipv6_cidr: number;
}

export interface TachyonListFiles {
  trs: string | null;
  srs: string | null;
  json: string | null;
  domains: string | null;
  subnets: string | null;
}

export interface TachyonList {
  id: string;
  group: string;
  kind: string;
  recommended_action: string;
  title: string;
  description: string;
  counts: TachyonListCounts;
  files: TachyonListFiles;
  fallback_srs: string | null;
}

export const TACHYON_CATALOG_GENERATED_AT = ${JSON.stringify(catalog.generated_at ?? null)};
export const TACHYON_CATALOG_VERSION = ${JSON.stringify(catalog.version ?? null)};
export const TACHYON_CATALOG: TachyonList[] = ${JSON.stringify(lists, null, 2)};
`;

await writeFile(outFile, content, 'utf8');
console.log(`Записано ${lists.length} списков в ${path.relative(root, outFile)}`);
