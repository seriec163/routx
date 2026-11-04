/**
 * Каталог версий продуктов RoutX.
 * Версии берутся из GitHub Releases; данные кешируются, чтобы панель
 * не упиралась в лимит GitHub при каждом открытии карточки роутера.
 */

export type ProductId = 'tachyon' | 'forkop' | 'podkop' | 'prokop';

export interface ProductRelease {
  version: string;
  tag: string;
  name: string;
  published_at: string | null;
  prerelease: boolean;
}

export interface ProductCatalogItem {
  product: ProductId;
  label: string;
  repo: string;
  current_version: string | null;
  latest_version: string | null;
  update_available: boolean;
  releases: ProductRelease[];
  error: string | null;
}

const PRODUCTS: Array<{ product: ProductId; label: string; repo: string }> = [
  { product: 'tachyon', label: 'Tachyon', repo: 'Dushnilin/tachyon' },
  { product: 'forkop', label: 'Forkop', repo: 'ushan0v/forkop' },
  { product: 'podkop', label: 'Podkop', repo: 'itdoginfo/podkop' },
  { product: 'prokop', label: 'Prokop', repo: 'Asofwar/prokop' },
];

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; releases: ProductRelease[]; error: string | null }>();

function normalizeVersion(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]!;
}

export function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a).split('.').map((part) => Number(part) || 0);
  const right = normalizeVersion(b).split('.').map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function githubReleases(repo: string): Promise<ProductRelease[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
      signal: controller.signal,
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'RoutX/1.0 product catalog',
      },
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const payload = (await response.json()) as Array<Record<string, unknown>>;
    return payload
      .filter((item) => item && item.draft !== true && typeof item.tag_name === 'string')
      .map((item) => ({
        version: normalizeVersion(String(item.tag_name)),
        tag: String(item.tag_name),
        name: String(item.name ?? item.tag_name ?? ''),
        published_at: typeof item.published_at === 'string' ? item.published_at : null,
        prerelease: item.prerelease === true,
      }))
      .filter((item) => /^\d+(\.\d+){1,3}$/.test(item.version));
  } finally {
    clearTimeout(timer);
  }
}

export async function productCatalog(
  currentVersions: Partial<Record<ProductId, string | null>>,
): Promise<ProductCatalogItem[]> {
  const now = Date.now();
  const items: ProductCatalogItem[] = [];
  for (const meta of PRODUCTS) {
    let cached = cache.get(meta.product);
    if (!cached || now - cached.at > CACHE_TTL_MS) {
      try {
        const releases = await githubReleases(meta.repo);
        cached = { at: now, releases, error: null };
      } catch (error) {
        cached = {
          at: now,
          releases: cached?.releases ?? [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      cache.set(meta.product, cached);
    }
    const releases = cached.releases;
    const latest = releases.find((item) => !item.prerelease) ?? releases[0] ?? null;
    const currentRaw = currentVersions[meta.product] ?? null;
    const current = currentRaw ? normalizeVersion(currentRaw) : null;
    items.push({
      product: meta.product,
      label: meta.label,
      repo: meta.repo,
      current_version: current,
      latest_version: latest?.version ?? null,
      update_available:
        current != null && latest != null ? compareVersions(current, latest.version) < 0 : false,
      releases,
      error: cached.error,
    });
  }
  return items;
}
