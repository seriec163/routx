import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { waitForJob } from '../lib/jobs';
import type { Job } from '../lib/types';
import { JobProgress, useToast } from '../components/ui';
import { haptic, hapticMove, hapticTap } from './haptics';

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
const RESULTS_PREFIX = 'rc.mobile.site-results.';
const RESULTS_TTL_MS = 60_000;

interface CachedResults {
  at: number;
  results: Record<string, SiteResult>;
}

function loadResults(routerId: string | null): CachedResults | null {
  if (!routerId) return null;
  try {
    const raw = window.localStorage.getItem(`${RESULTS_PREFIX}${routerId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedResults>;
    if (!parsed || typeof parsed.at !== 'number' || !parsed.results) return null;
    return { at: parsed.at, results: parsed.results };
  } catch {
    return null;
  }
}

function saveResults(routerId: string, results: Record<string, SiteResult>): void {
  try {
    window.localStorage.setItem(
      `${RESULTS_PREFIX}${routerId}`,
      JSON.stringify({ at: Date.now(), results } satisfies CachedResults),
    );
  } catch {
    // localStorage может быть недоступен — не критично.
  }
}

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
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
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
      saveResults(routerId, next);
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
    const cached = loadResults(routerId);
    if (cached) setResults(cached.results);
    if (cached && Date.now() - cached.at < RESULTS_TTL_MS) return;
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

  function moveSiteTo(from: number, to: number): void {
    if (from === to || to < 0 || to >= sites.length) return;
    const next = [...sites];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    setSites(next);
  }

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    hapticTap();
    setDragIndex(index);
    setDragOver(index);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (dragIndex == null) return;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-site-index]');
    if (!target) return;
    const over = Number(target.dataset.siteIndex);
    if (Number.isInteger(over) && over !== dragOver) {
      haptic(6);
      setDragOver(over);
    }
  }

  function endDrag(event: ReactPointerEvent<HTMLButtonElement>): void {
    if (dragIndex != null && dragOver != null) {
      moveSiteTo(dragIndex, dragOver);
      hapticMove();
    }
    setDragIndex(null);
    setDragOver(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // pointer уже отпущен
    }
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
          <div
            className={`m-sitelrow ${dragIndex === index ? 'm-dragging' : ''} ${
              dragOver === index && dragIndex !== index ? 'm-drag-over' : ''
            }`}
            key={site.id}
            data-site-index={index}
          >
            <span className={`m-dot ${tone ? `m-dot-${tone}` : ''}`} aria-hidden="true" />
            <span className="m-site-main">
              <span className="m-site-label">{site.label}</span>
              <span className="m-site-url">{site.url.replace(/^https?:\/\//i, '')}</span>
            </span>
            {editing ? (
              <span className="m-site-actions">
                <button
                  type="button"
                  className="m-drag"
                  aria-label={`Перетащить ${site.label}`}
                  title="Перетащите, чтобы изменить порядок"
                  onPointerDown={(event) => beginDrag(event, index)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={() => {
                    setDragIndex(null);
                    setDragOver(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      moveSiteTo(index, index - 1);
                      hapticMove();
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      moveSiteTo(index, index + 1);
                      hapticMove();
                    }
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="9" cy="9" r="1.4" />
                    <circle cx="15" cy="9" r="1.4" />
                    <circle cx="9" cy="15" r="1.4" />
                    <circle cx="15" cy="15" r="1.4" />
                  </svg>
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
            До {MAX_SITES} адресов. Перетаскивайте за ⠿, чтобы менять порядок. × убирает сайт.
          </p>
        </div>
      ) : null}

      <p className="m-footnote">
        Проверка идёт через активный VPN-сервер. Зелёный — сайт доступен, красный — нет.
      </p>
    </section>
  );
}
