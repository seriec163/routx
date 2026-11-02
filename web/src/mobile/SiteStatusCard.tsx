import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { waitForJob } from '../lib/jobs';
import type { Job } from '../lib/types';
import { JobProgress, useToast } from '../components/ui';

interface Site {
  id: string;
  label: string;
  url: string;
}

interface SiteResult {
  ok: boolean;
  latency_ms: number | null;
}

const MAX_SITES = 8;
const STORAGE_PREFIX = 'rc.mobile.sites.';

const DEFAULT_SITES: Site[] = [
  { id: 'instagram', label: 'Instagram', url: 'https://www.instagram.com/' },
  { id: 'youtube', label: 'YouTube', url: 'https://www.youtube.com/' },
  { id: 'linkedin', label: 'LinkedIn', url: 'https://www.linkedin.com/' },
];

function sanitizeSite(value: unknown): Site | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as { id?: unknown; label?: unknown; url?: unknown };
  if (typeof item.url !== 'string' || typeof item.label !== 'string') return null;
  try {
    const url = new URL(item.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return {
      id: typeof item.id === 'string' && item.id !== '' ? item.id : url.toString(),
      label: item.label.trim().slice(0, 60) || url.hostname,
      url: url.toString(),
    };
  } catch {
    return null;
  }
}

function loadSites(routerId: string | null): Site[] {
  if (!routerId) return DEFAULT_SITES;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${routerId}`);
    if (!raw) return DEFAULT_SITES;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_SITES;
    const items = parsed
      .map(sanitizeSite)
      .filter((item): item is Site => item !== null)
      .slice(0, MAX_SITES);
    return items.length > 0 ? items : DEFAULT_SITES;
  } catch {
    return DEFAULT_SITES;
  }
}

function normalizeSite(input: string): Site | null {
  let value = input.trim();
  if (value === '') return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return {
      id: url.toString(),
      label: url.hostname.replace(/^www\./i, ''),
      url: url.toString(),
    };
  } catch {
    return null;
  }
}

function latencyLabel(result: SiteResult | undefined, checking: boolean): string {
  if (checking) return '…';
  if (!result) return '—';
  if (!result.ok) return 'недоступен';
  return result.latency_ms != null ? `${Math.round(result.latency_ms)} мс` : 'доступен';
}

export function SiteStatusCard({
  routerId,
  online,
}: {
  routerId: string | null;
  online: boolean;
}) {
  const toast = useToast();
  const [sites, setSites] = useState<Site[]>(() => loadSites(routerId));
  const [results, setResults] = useState<Record<string, SiteResult>>({});
  const [editing, setEditing] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [checking, setChecking] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const checkedOnce = useRef(false);

  useEffect(() => {
    if (!routerId) return;
    try {
      window.localStorage.setItem(`${STORAGE_PREFIX}${routerId}`, JSON.stringify(sites));
    } catch {
      // localStorage может быть недоступен в приватном режиме — не критично.
    }
  }, [routerId, sites]);

  async function checkSites(list: Site[]): Promise<void> {
    if (!routerId || !online || list.length === 0 || checking) return;
    setChecking(true);
    try {
      const started = await api<{ job: Job }>(
        `/api/v1/routers/${routerId}/sites/check`,
        {
          method: 'POST',
          body: { targets: list.map((site) => site.url) },
        },
      );
      setJob(started.job);
      const done = await waitForJob(started.job, setJob);
      if (done.status !== 'success') {
        throw new Error(done.error?.message ?? 'Не удалось проверить сайты');
      }
      const raw = done.result?.results;
      const next: Record<string, SiteResult> = {};
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (!item || typeof item !== 'object') continue;
          const row = item as { target?: unknown; ok?: unknown; latency_ms?: unknown };
          if (typeof row.target !== 'string') continue;
          next[row.target] = {
            ok: row.ok === true,
            latency_ms:
              typeof row.latency_ms === 'number' && Number.isFinite(row.latency_ms)
                ? row.latency_ms
                : null,
          };
        }
      }
      setResults(next);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setChecking(false);
      setJob(null);
    }
  }

  useEffect(() => {
    if (!routerId || !online || checkedOnce.current) return;
    checkedOnce.current = true;
    void checkSites(sites);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerId, online]);

  function addSite(): void {
    const site = normalizeSite(newUrl);
    if (!site) {
      toast.error('Проверьте адрес: например https://example.com');
      return;
    }
    if (sites.length >= MAX_SITES) {
      toast.info(`Можно добавить не больше ${MAX_SITES} сайтов`);
      return;
    }
    if (sites.some((item) => item.url === site.url)) {
      toast.info('Такой сайт уже есть в списке');
      return;
    }
    const next = [...sites, site];
    setSites(next);
    setNewUrl('');
    void checkSites(next);
  }

  function removeSite(site: Site): void {
    if (sites.length <= 1) {
      toast.info('Оставьте хотя бы один сайт');
      return;
    }
    const next = sites.filter((item) => item.id !== site.id);
    setSites(next);
    void checkSites(next);
  }

  function moveSite(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= sites.length) return;
    const next = [...sites];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(target, 0, item);
    setSites(next);
  }

  return (
    <section className="m-card m-sites">
      <div className="m-list-head">
        <span className="m-label">Сайты · через VPN</span>
        <div className="m-head-actions">
          <button
            type="button"
            className="m-mini"
            onClick={() => void checkSites(sites)}
            disabled={checking || !online || !routerId}
          >
            {checking ? 'Проверяем…' : 'Проверить'}
          </button>
          <button type="button" className="m-mini" onClick={() => setEditing((value) => !value)}>
            {editing ? 'Готово' : 'Настроить'}
          </button>
        </div>
      </div>

      {!online ? (
        <p className="m-note m-note-warn">Роутер не в сети — проверить доступность нельзя.</p>
      ) : null}

      {job ? <JobProgress job={job} label="Проверяем сайты" /> : null}

      {sites.map((site, index) => {
        const result = results[site.url];
        const tone = result ? (result.ok ? 'ok' : 'bad') : '';
        return (
          <div className="m-sitelrow" key={site.id}>
            <span className={`m-dot ${tone ? `m-dot-${tone}` : ''}`} aria-hidden="true" />
            <span className="m-site-main">
              <span className="m-site-label">{site.label}</span>
              <span className="m-site-url">{site.url.replace(/^https?:\/\//i, '')}</span>
            </span>
            {editing ? (
              <span className="m-site-actions">
                <button
                  type="button"
                  className="m-mini"
                  onClick={() => moveSite(index, -1)}
                  disabled={index === 0}
                  aria-label={`Поднять ${site.label}`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="m-mini"
                  onClick={() => moveSite(index, 1)}
                  disabled={index === sites.length - 1}
                  aria-label={`Опустить ${site.label}`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="m-mini m-mini-danger"
                  onClick={() => removeSite(site)}
                  aria-label={`Убрать ${site.label}`}
                >
                  ×
                </button>
              </span>
            ) : (
              <span className={`m-site-latency ${result && !result.ok ? 'm-site-down' : ''}`}>
                {latencyLabel(result, checking)}
              </span>
            )}
          </div>
        );
      })}

      {editing ? (
        <div className="m-sites-add">
          <label className="m-inputlabel" htmlFor="site-url">
            Добавить любой адрес
          </label>
          <input
            id="site-url"
            className="m-input"
            value={newUrl}
            onChange={(event) => setNewUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') addSite();
            }}
            placeholder="https://example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={checking}
          />
          <button
            type="button"
            className="m-action m-action-sm"
            onClick={addSite}
            disabled={checking || newUrl.trim() === '' || sites.length >= MAX_SITES}
          >
            Добавить
          </button>
          <p className="m-note">
            До {MAX_SITES} адресов. ↑ и ↓ меняют порядок, × убирает сайт.
          </p>
        </div>
      ) : null}

      <p className="m-footnote">
        Проверка идёт через активный VPN-сервер. Зелёный — сайт доступен, красный — нет.
      </p>
    </section>
  );
}
