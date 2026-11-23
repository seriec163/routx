import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { uuidv7 } from '../lib/ids.js';

const ARCH = process.env.RC_MIRROR_ARCH?.trim() || 'aarch64_cortex-a53';
const GITHUB_API = 'https://api.github.com';
const GITHUB_RAW = 'https://raw.githubusercontent.com';
const GITHUB_DOWNLOAD = 'https://github.com';
const USER_AGENT = 'routx-panel/package-mirror';
const REQUEST_TIMEOUT_MS = 300_000;

type Product = 'tachyon' | 'forkop' | 'podkop';
type AssetFilter = 'all' | 'arch' | 'tachyon-core';

interface RepoConfig {
  product: Product;
  owner: string;
  repo: string;
  filter: AssetFilter;
}

const REPOS: RepoConfig[] = [
  { product: 'tachyon', owner: 'Dushnilin', repo: 'tachyon', filter: 'all' },
  { product: 'tachyon', owner: 'Dushnilin', repo: 'tachyon-core', filter: 'tachyon-core' },
  { product: 'forkop', owner: 'ushan0v', repo: 'forkop', filter: 'all' },
  { product: 'forkop', owner: 'ushan0v', repo: 'sing-box-forkop', filter: 'arch' },
  { product: 'podkop', owner: 'itdoginfo', repo: 'podkop', filter: 'all' },
];

const INSTALLERS: Array<{
  product: Product;
  owner: string;
  repo: string;
  name: 'install.sh' | 'uninstall.sh';
  ref: string;
}> = [
  { product: 'tachyon', owner: 'Dushnilin', repo: 'tachyon', name: 'install.sh', ref: 'main' },
  { product: 'tachyon', owner: 'Dushnilin', repo: 'tachyon', name: 'uninstall.sh', ref: 'main' },
  { product: 'forkop', owner: 'ushan0v', repo: 'forkop', name: 'install.sh', ref: 'main' },
  { product: 'podkop', owner: 'itdoginfo', repo: 'podkop', name: 'install.sh', ref: 'main' },
];

const RAW_FILES: Array<{
  product: Product;
  owner: string;
  repo: string;
  ref: string;
  filePath: string;
  name: string;
}> = [
  {
    product: 'podkop',
    owner: 'itdoginfo',
    repo: 'podkop',
    ref: 'main',
    filePath: 'podkop/files/etc/config/podkop',
    name: 'podkop.config',
  },
];

interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  content_type?: string;
  browser_download_url: string;
  url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets?: GitHubAsset[];
}

interface PackageRow {
  id: string;
  product: string;
  repo: string;
  kind: 'installer' | 'asset' | 'release_json' | 'raw';
  name: string;
  tag: string;
  source_url: string;
  storage_path: string;
  sha256: string;
  size_bytes: string;
  metadata: Record<string, unknown>;
  fetched_at: Date;
}

let syncPromise: Promise<SyncSummary> | null = null;
let lastStarted: Date | null = null;
let lastFinished: Date | null = null;
let lastError: string | null = null;
let syncProgress: string | null = null;

export interface SyncSummary {
  products: Array<{ product: Product; files: number; bytes: number; tags: Record<string, string> }>;
  errors: string[];
}

export interface PackageStatus {
  total_files: number;
  total_bytes: number;
  products: Array<{ product: string; files: number; bytes: number; fetched_at: string | null }>;
  releases: Array<{ repo: string; tag: string; fetched_at: string }>;
  syncing: boolean;
  progress: string | null;
  last_started: string | null;
  last_finished: string | null;
  last_error: string | null;
}

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

function isAllowedRepo(owner: string, repo: string): boolean {
  return REPOS.some((item) => item.owner === owner && item.repo === repo);
}

function productForRepo(owner: string, repo: string): Product | null {
  return REPOS.find((item) => item.owner === owner && item.repo === repo)?.product ?? null;
}

async function fetchBuffer(url: string, headers: Record<string, string> = {}): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} при загрузке ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/vnd.github+json',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} при запросе ${url}`);
  }
  return (await response.json()) as T;
}

function assetMatches(filter: AssetFilter, name: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'arch') return name.includes(ARCH);
  return name.startsWith('tachyon-core-aarch64');
}

async function upsertPackage(
  pool: Pool,
  input: {
    product: Product;
    owner: string;
    repo: string;
    kind: PackageRow['kind'];
    name: string;
    tag: string;
    sourceUrl: string;
    storagePath: string;
    content: Buffer;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `insert into package_mirror
       (id, product, repo, kind, name, tag, source_url, storage_path, sha256, size_bytes, metadata, fetched_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now())
     on conflict (repo, kind, name, tag) do update
       set product = excluded.product,
           source_url = excluded.source_url,
           storage_path = excluded.storage_path,
           sha256 = excluded.sha256,
           size_bytes = excluded.size_bytes,
           metadata = excluded.metadata,
           fetched_at = now()`,
    [
      uuidv7(),
      input.product,
      repoKey(input.owner, input.repo),
      input.kind,
      input.name,
      input.tag,
      input.sourceUrl,
      input.storagePath,
      sha256Hex(input.content),
      input.content.length,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

async function storeFile(
  dataDir: string,
  storagePath: string,
  content: Buffer,
): Promise<void> {
  const target = path.join(dataDir, storagePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function patchTachyonInstaller(source: string, publicUrl: string): string {
  const base = publicUrl.replace(/\/+$/, '');
  let patched = source.replace(
    'GH_MIRRORS="',
    `GH_MIRRORS="${base}/downloads/github/ `,
  );
  patched = patched.split('https://api.github.com').join(`${base}/downloads/github-api`);
  return patched;
}

function patchPodkopInstaller(source: string, publicUrl: string): string {
  const base = publicUrl.replace(/\/+$/, '');
  let patched = source.replace(
    'REPO="https://api.github.com/repos/itdoginfo/podkop/releases/latest"',
    `REPO="${base}/downloads/github-api/repos/itdoginfo/podkop/releases/latest?rewrite=1"`,
  );
  patched = patched
    .split('https://raw.githubusercontent.com/itdoginfo/podkop/refs/heads/main/podkop/files/etc/config/podkop')
    .join(`${base}/downloads/raw/itdoginfo/podkop/main/podkop/files/etc/config/podkop`);
  return patched;
}

async function syncRepo(
  pool: Pool,
  dataDir: string,
  publicUrl: string,
  repo: RepoConfig,
  errors: string[],
): Promise<{ files: number; bytes: number; tag: string | null }> {
  const key = repoKey(repo.owner, repo.repo);
  let release: GitHubRelease;
  try {
    release = await fetchJson<GitHubRelease>(
      `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/releases/latest`,
    );
  } catch (error) {
    errors.push(`${key}: ${(error as Error).message}`);
    return { files: 0, bytes: 0, tag: null };
  }

  const tag = release.tag_name;
  const releaseContent = Buffer.from(JSON.stringify(release));
  const releasePath = `packages/${repo.product}/${repo.owner}-${repo.repo}/${tag}/release.json`;
  await storeFile(dataDir, releasePath, releaseContent);
  await upsertPackage(pool, {
    product: repo.product,
    owner: repo.owner,
    repo: repo.repo,
    kind: 'release_json',
    name: 'release.json',
    tag,
    sourceUrl: `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/releases/latest`,
    storagePath: releasePath,
    content: releaseContent,
  });

  let files = 1;
  let bytes = releaseContent.length;
  for (const asset of release.assets ?? []) {
    if (!assetMatches(repo.filter, asset.name)) continue;
    syncProgress = `${key}/${asset.name}`;
    const existing = await pool.query<{ size_bytes: string; storage_path: string }>(
      `select size_bytes, storage_path from package_mirror
        where repo = $1 and kind = 'asset' and name = $2 and tag = $3`,
      [key, asset.name, tag],
    );
    const existingRow = existing.rows[0];
    let cached = false;
    if (existingRow && Number(existingRow.size_bytes) === asset.size) {
      try {
        const info = await stat(path.join(dataDir, existingRow.storage_path));
        cached = info.isFile() && info.size === asset.size;
      } catch {
        cached = false;
      }
    }
    if (!cached) {
      try {
        const content = await fetchBuffer(asset.browser_download_url);
        const storagePath = `packages/${repo.product}/${repo.owner}-${repo.repo}/${tag}/${asset.name}`;
        await storeFile(dataDir, storagePath, content);
        await upsertPackage(pool, {
          product: repo.product,
          owner: repo.owner,
          repo: repo.repo,
          kind: 'asset',
          name: asset.name,
          tag,
          sourceUrl: asset.browser_download_url,
          storagePath,
          content,
          metadata: { asset_id: asset.id, content_type: asset.content_type ?? null },
        });
        files += 1;
        bytes += content.length;
      } catch (error) {
        errors.push(`${key}/${asset.name}: ${(error as Error).message}`);
        continue;
      }
    }
  }

  // Удаляем пакеты прошлых версий, чтобы зеркало не росло бесконечно.
  const stale = await pool.query<{ id: string; storage_path: string }>(
    `select id, storage_path from package_mirror
      where repo = $1 and kind in ('asset','release_json') and tag <> $2`,
    [key, tag],
  );
  for (const row of stale.rows) {
    await rm(path.join(dataDir, row.storage_path), { force: true }).catch(() => undefined);
  }
  if (stale.rows.length > 0) {
    await pool.query(
      `delete from package_mirror
        where repo = $1 and kind in ('asset','release_json') and tag <> $2`,
      [key, tag],
    );
  }
  return { files, bytes, tag };
}

export async function syncPackages(
  pool: Pool,
  dataDir: string,
  publicUrl: string,
  log?: { warn: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void },
): Promise<SyncSummary> {
  const errors: string[] = [];
  const products = new Map<Product, { files: number; bytes: number; tags: Record<string, string> }>();
  const releaseCached = new Set<string>();

  const syncGroup = async (repos: RepoConfig[]): Promise<void> => {
    for (const repo of repos) {
      syncProgress = `${repo.owner}/${repo.repo}`;
      const result = await syncRepo(pool, dataDir, publicUrl, repo, errors);
      const current = products.get(repo.product) ?? { files: 0, bytes: 0, tags: {} };
      current.files += result.files;
      current.bytes += result.bytes;
      if (result.tag) {
        current.tags[repoKey(repo.owner, repo.repo)] = result.tag;
        releaseCached.add(repoKey(repo.owner, repo.repo));
      }
      products.set(repo.product, current);
    }
  };

  // Сначала небольшие и нужные всем пакеты, установщики и Podkop; тяжёлое
  // ядро Forkop (85 МБ для aarch64) качаем последним, чтобы оно не
  // задерживало появление установщиков.
  const mainRepos = REPOS.filter((repo) => repo.repo !== 'sing-box-forkop');
  const largeRepos = REPOS.filter((repo) => repo.repo === 'sing-box-forkop');
  await syncGroup(mainRepos);

  for (const installer of INSTALLERS) {
    const required =
      installer.product === 'tachyon'
        ? ['Dushnilin/tachyon', 'Dushnilin/tachyon-core']
        : installer.product === 'forkop'
          ? ['ushan0v/forkop']
          : ['itdoginfo/podkop'];
    if (required.some((repo) => !releaseCached.has(repo))) {
      errors.push(`${installer.product}/${installer.name}: нет релиза в зеркале`);
      continue;
    }
    syncProgress = `установщик ${installer.product}/${installer.name}`;
    try {
      const source = await fetchBuffer(
        `${GITHUB_RAW}/${installer.owner}/${installer.repo}/${installer.ref}/${installer.name}`,
      );
      const text = source.toString('utf8');
      const patched =
        installer.product === 'tachyon'
          ? patchTachyonInstaller(text, publicUrl)
          : installer.product === 'podkop'
            ? patchPodkopInstaller(text, publicUrl)
            : text;
      const content = Buffer.from(patched);
      const storagePath = `packages/${installer.product}/${installer.name}`;
      await storeFile(dataDir, storagePath, content);
      await upsertPackage(pool, {
        product: installer.product,
        owner: installer.owner,
        repo: installer.repo,
        kind: 'installer',
        name: installer.name,
        tag: 'main',
        sourceUrl: `${GITHUB_RAW}/${installer.owner}/${installer.repo}/${installer.ref}/${installer.name}`,
        storagePath,
        content,
      });
    } catch (error) {
      errors.push(`${installer.product}/${installer.name}: ${(error as Error).message}`);
    }
  }

  for (const raw of RAW_FILES) {
    syncProgress = `конфигурация ${raw.name}`;
    try {
      const url = `${GITHUB_RAW}/${raw.owner}/${raw.repo}/${raw.ref}/${raw.filePath}`;
      const content = await fetchBuffer(url);
      const storagePath = `packages/${raw.product}/${raw.name}`;
      await storeFile(dataDir, storagePath, content);
      await upsertPackage(pool, {
        product: raw.product,
        owner: raw.owner,
        repo: raw.repo,
        kind: 'raw',
        name: raw.name,
        tag: 'main',
        sourceUrl: url,
        storagePath,
        content,
        metadata: { path: raw.filePath, ref: raw.ref },
      });
    } catch (error) {
      errors.push(`${raw.owner}/${raw.repo}/${raw.filePath}: ${(error as Error).message}`);
    }
  }

  // Тяжёлое ядро Forkop — в конце, чтобы не блокировать установщики.
  await syncGroup(largeRepos);
  syncProgress = null;

  if (errors.length > 0) {
    log?.warn({ errors }, 'зеркало пакетов обновлено с ошибками');
  } else {
    log?.warn({ products: products.size }, 'зеркало пакетов обновлено');
  }

  return {
    products: [...products.entries()].map(([product, value]) => ({ product, ...value })),
    errors,
  };
}

export function startPackageSync(
  pool: Pool,
  dataDir: string,
  publicUrl: string,
  log?: { warn: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void },
): Promise<SyncSummary> {
  if (syncPromise) return syncPromise;
  lastStarted = new Date();
  lastError = null;
  syncPromise = (async () => {
    try {
      const summary = await syncPackages(pool, dataDir, publicUrl, log);
      if (summary.errors.length > 0) {
        lastError = summary.errors.join('; ').slice(0, 2000);
      }
      return summary;
    } catch (error) {
      lastError = (error as Error).message;
      log?.error({ err: error }, 'не удалось обновить зеркало пакетов');
      throw error;
    } finally {
      lastFinished = new Date();
      syncPromise = null;
      syncProgress = null;
    }
  })();
  return syncPromise;
}

export async function getPackageStatus(pool: Pool): Promise<PackageStatus> {
  const [totals, products, releases] = await Promise.all([
    pool.query<{ files: string; bytes: string }>(
      `select count(*)::text as files, coalesce(sum(size_bytes),0)::text as bytes from package_mirror`,
    ),
    pool.query<{ product: string; files: string; bytes: string; fetched_at: Date | null }>(
      `select product, count(*)::text as files, coalesce(sum(size_bytes),0)::text as bytes,
              max(fetched_at) as fetched_at
         from package_mirror group by product order by product`,
    ),
    pool.query<{ repo: string; tag: string; fetched_at: Date }>(
      `select repo, tag, fetched_at from package_mirror
        where kind = 'release_json' order by repo`,
    ),
  ]);
  return {
    total_files: Number(totals.rows[0]?.files ?? 0),
    total_bytes: Number(totals.rows[0]?.bytes ?? 0),
    products: products.rows.map((row) => ({
      product: row.product,
      files: Number(row.files),
      bytes: Number(row.bytes),
      fetched_at: row.fetched_at?.toISOString() ?? null,
    })),
    releases: releases.rows.map((row) => ({
      repo: row.repo,
      tag: row.tag,
      fetched_at: row.fetched_at.toISOString(),
    })),
    syncing: syncPromise !== null,
    progress: syncProgress,
    last_started: lastStarted?.toISOString() ?? null,
    last_finished: lastFinished?.toISOString() ?? null,
    last_error: lastError,
  };
}

export async function loadPackageRow(
  pool: Pool,
  kind: PackageRow['kind'],
  where: { repo?: string; product?: string; name?: string; tag?: string },
): Promise<PackageRow | null> {
  const clauses: string[] = ['kind = $1'];
  const values: unknown[] = [kind];
  if (where.repo !== undefined) {
    values.push(where.repo);
    clauses.push(`repo = $${values.length}`);
  }
  if (where.product !== undefined) {
    values.push(where.product);
    clauses.push(`product = $${values.length}`);
  }
  if (where.name !== undefined) {
    values.push(where.name);
    clauses.push(`name = $${values.length}`);
  }
  if (where.tag !== undefined) {
    values.push(where.tag);
    clauses.push(`tag = $${values.length}`);
  }
  const result = await pool.query<PackageRow>(
    `select * from package_mirror where ${clauses.join(' and ')} order by fetched_at desc limit 1`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function readPackageContent(dataDir: string, row: PackageRow): Promise<Buffer> {
  return readFile(path.join(dataDir, row.storage_path));
}

/**
 * Читает файл зеркала, но не падает, если его нет на диске (например, после
 * переноса панели: метаданные импортированы, а `rc_data` — нет). Отсутствие
 * файла означает «в зеркале нет», и вызывающий код может сходить в GitHub.
 */
export async function readPackageContentOrNull(
  dataDir: string,
  row: PackageRow,
): Promise<Buffer | null> {
  try {
    return await readFile(path.join(dataDir, row.storage_path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function getReleaseJson(
  pool: Pool,
  dataDir: string,
  owner: string,
  repo: string,
  rewrite: boolean,
  publicUrl: string,
): Promise<{ body: string; tag: string } | null> {
  if (!isAllowedRepo(owner, repo)) return null;
  const row = await loadPackageRow(pool, 'release_json', { repo: repoKey(owner, repo) });
  const raw = row ? await readPackageContentOrNull(dataDir, row) : null;

  let release: GitHubRelease;
  let tag: string;
  if (raw) {
    release = JSON.parse(raw.toString('utf8')) as GitHubRelease;
    tag = row!.tag;
  } else {
    // Метаданные есть, а файла на диске нет (перенос без тома `rc_data`).
    // Отдаём релиз с GitHub, чтобы установка/обновление не упали в 500.
    const live = await fetchLatestRelease(owner, repo);
    if (!live) return null;
    release = live;
    tag = live.tag_name || 'latest';
  }

  return { body: rewriteReleaseBody(release, owner, repo, tag, publicUrl, rewrite), tag };
}

async function fetchLatestRelease(owner: string, repo: string): Promise<GitHubRelease | null> {
  try {
    return await fetchJson<GitHubRelease>(`${GITHUB_API}/repos/${owner}/${repo}/releases/latest`);
  } catch {
    return null;
  }
}

function rewriteReleaseBody(
  release: GitHubRelease,
  owner: string,
  repo: string,
  tag: string,
  publicUrl: string,
  rewrite: boolean,
): string {
  if (!rewrite) return JSON.stringify(release);
  const copy = JSON.parse(JSON.stringify(release)) as GitHubRelease;
  for (const asset of copy.assets ?? []) {
    asset.url = `${publicUrl}/downloads/github-api/repos/${owner}/${repo}/releases/assets/${asset.id}`;
    asset.browser_download_url = `${publicUrl}/downloads/github/${owner}/${repo}/releases/download/${tag}/${asset.name}`;
  }
  return JSON.stringify(copy);
}

export async function getAssetByPath(
  pool: Pool,
  dataDir: string,
  owner: string,
  repo: string,
  tag: string,
  file: string,
): Promise<{ row: PackageRow; content: Buffer } | null> {
  if (!isAllowedRepo(owner, repo)) return null;
  const key = repoKey(owner, repo);
  let resolvedTag = tag;
  if (tag === 'latest') {
    const latest = await loadPackageRow(pool, 'release_json', { repo: key });
    if (latest) {
      resolvedTag = latest.tag;
    } else {
      const live = await fetchLatestRelease(owner, repo);
      if (!live?.tag_name) return null;
      resolvedTag = live.tag_name;
    }
  }
  const row = await loadPackageRow(pool, 'asset', {
    repo: key,
    name: file,
    tag: resolvedTag,
  });
  if (row) {
    const content = await readPackageContentOrNull(dataDir, row);
    if (content) return { row, content };
  }

  // Нет в кэше — пробуем GitHub и сохраняем на будущее.
  try {
    const url = `${GITHUB_DOWNLOAD}/${owner}/${repo}/releases/download/${resolvedTag}/${file}`;
    const content = await fetchBuffer(url);
    const product = productForRepo(owner, repo);
    if (!product) return null;
    const storagePath = `packages/${product}/${owner}-${repo}/${resolvedTag}/${file}`;
    await storeFile(dataDir, storagePath, content);
    await upsertPackage(pool, {
      product,
      owner,
      repo,
      kind: 'asset',
      name: file,
      tag: resolvedTag,
      sourceUrl: url,
      storagePath,
      content,
    });
    const saved = await loadPackageRow(pool, 'asset', { repo: key, name: file, tag: resolvedTag });
    return saved ? { row: saved, content } : null;
  } catch {
    return null;
  }
}

export async function getAssetById(
  pool: Pool,
  dataDir: string,
  owner: string,
  repo: string,
  id: string,
): Promise<{ row: PackageRow; content: Buffer } | null> {
  if (!isAllowedRepo(owner, repo)) return null;
  const key = repoKey(owner, repo);
  const cached = await pool.query<PackageRow>(
    `select * from package_mirror
      where repo = $1 and kind = 'asset' and metadata->>'asset_id' = $2
      order by fetched_at desc limit 1`,
    [key, id],
  );
  const row = cached.rows[0];
  if (row) {
    const content = await readPackageContentOrNull(dataDir, row);
    if (content) return { row, content };
  }

  try {
    const content = await fetchBuffer(
      `${GITHUB_API}/repos/${owner}/${repo}/releases/assets/${id}`,
      { accept: 'application/octet-stream' },
    );
    const release = await loadPackageRow(pool, 'release_json', { repo: key });
    const product = productForRepo(owner, repo);
    const rawRelease = release ? await readPackageContentOrNull(dataDir, release) : null;
    const parsed = rawRelease
      ? (JSON.parse(rawRelease.toString('utf8')) as GitHubRelease)
      : await fetchLatestRelease(owner, repo);
    const tag = release?.tag ?? parsed?.tag_name;
    if (!parsed || !tag || !product) return null;
    const asset = (parsed.assets ?? []).find((item) => String(item.id) === id);
    const name = asset?.name ?? `asset-${id}`;
    const storagePath = `packages/${product}/${owner}-${repo}/${tag}/${name}`;
    await storeFile(dataDir, storagePath, content);
    await upsertPackage(pool, {
      product,
      owner,
      repo,
      kind: 'asset',
      name,
      tag,
      sourceUrl: `${GITHUB_API}/repos/${owner}/${repo}/releases/assets/${id}`,
      storagePath,
      content,
      metadata: { asset_id: Number(id), content_type: asset?.content_type ?? null },
    });
    const saved = await loadPackageRow(pool, 'asset', {
      repo: key,
      name,
      tag,
    });
    return saved ? { row: saved, content } : null;
  } catch {
    return null;
  }
}

export async function getRawFile(
  pool: Pool,
  dataDir: string,
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
): Promise<{ row: PackageRow; content: Buffer } | null> {
  const known = RAW_FILES.find(
    (item) =>
      item.owner === owner && item.repo === repo && item.filePath === filePath,
  );
  if (!known) return null;
  const sourceUrl = `${GITHUB_RAW}/${owner}/${repo}/${ref}/${filePath}`;
  const row = await loadPackageRow(pool, 'raw', { repo: repoKey(owner, repo), name: known.name });
  if (row) {
    const content = await readPackageContentOrNull(dataDir, row);
    if (content) return { row, content };
  }

  try {
    const content = await fetchBuffer(sourceUrl);
    const storagePath = `packages/${known.product}/${known.name}`;
    await storeFile(dataDir, storagePath, content);
    await upsertPackage(pool, {
      product: known.product,
      owner,
      repo,
      kind: 'raw',
      name: known.name,
      tag: 'main',
      sourceUrl,
      storagePath,
      content,
      metadata: { path: filePath, ref },
    });
    const saved = await loadPackageRow(pool, 'raw', {
      repo: repoKey(owner, repo),
      name: known.name,
    });
    return saved ? { row: saved, content } : null;
  } catch {
    return null;
  }
}
