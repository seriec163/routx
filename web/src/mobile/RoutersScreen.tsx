import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useToast } from '../components/ui';
import { navigate } from '../lib/router';
import { useSession } from '../session';
import { MobileHeader, useMobile } from './MobileApp';
import { StatusDot } from './HomeScreen';

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

function parseLink(text: string): { token: string; routerId: string | null } | null {
  const value = text.trim();
  if (value === '') return null;

  const tokenMatch = value.match(/(?:^|[?&#&])token=([A-Za-z0-9_-]{20,})/);
  const routerMatch = value.match(/router=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);

  if (tokenMatch) {
    return { token: tokenMatch[1]!, routerId: routerMatch?.[1] ?? null };
  }
  if (/^[A-Za-z0-9_-]{20,}$/.test(value)) {
    return { token: value, routerId: null };
  }
  return null;
}

export function RoutersScreen() {
  const { routers, selectedId, select, reload, loading } = useMobile();
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="m-screen">
      <MobileHeader title="Роутеры" back="/app" />

      <div className="m-body">
        <button type="button" className="m-action" onClick={() => setAddOpen(true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Добавить роутер
        </button>

        <div className="m-card m-list">
          <div className="m-list-head">
            <span className="m-label">Подключено · {routers.length}</span>
            <button type="button" className="m-mini" onClick={() => void reload()} disabled={loading}>
              Обновить
            </button>
          </div>

          {routers.length === 0 && !loading ? (
            <p className="m-empty-text">
              Роутеров пока нет. Отсканируйте QR на странице JanusNew роутера или вставьте ссылку.
            </p>
          ) : (
            routers.map((router) => (
              <button
                type="button"
                key={router.id}
                className={`m-routerrow ${router.id === selectedId ? 'm-routerrow-active' : ''}`}
                onClick={() => {
                  select(router.id);
                  navigate('/app');
                }}
              >
                <StatusDot item={router} />
                <span className="m-routerrow-main">
                  <span className="m-routerrow-name">{router.name}</span>
                  <span className="m-routerrow-meta">
                    {router.product === 'prokop' ? 'Prokop' : 'Forkop'}
                    {router.product_version ? ` ${router.product_version}` : ''}
                    {router.latency_ms != null ? ` · ${Math.round(router.latency_ms)} мс` : ''}
                  </span>
                </span>
                {router.id === selectedId ? (
                  <svg className="m-check" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m5 12.5 4.5 4.5L19 7" />
                  </svg>
                ) : null}
              </button>
            ))
          )}
        </div>

        <p className="m-footnote">
          QR создаётся на самом роутере: LuCI → Служба → JanusNew. Ссылка одноразовая и действует
          5 минут.
        </p>

        {selectedId ? (
          <button
            type="button"
            className="m-link m-link-center"
            onClick={() => navigate(`/routers/${selectedId}`)}
          >
            Открыть полную панель роутера
          </button>
        ) : null}
      </div>

      {addOpen ? (
        <AddRouterSheet onClose={() => setAddOpen(false)} />
      ) : null}
    </div>
  );
}

function AddRouterSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const { reload } = useSession();
  const { select } = useMobile();
  const [tab, setTab] = useState<'scan' | 'link'>('scan');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function submit(payload: string): Promise<void> {
    const parsed = parseLink(payload);
    if (!parsed) {
      toast.error('Не нашли токен: отсканируйте QR или вставьте ссылку целиком');
      return;
    }
    setBusy(true);
    setStatus('Проверяем ссылку…');
    try {
      const result = await api<{ router_id: string }>('/api/v1/mobile/exchange', {
        method: 'POST',
        body: { token: parsed.token },
      });
      setStatus('Входим и выбираем роутер…');
      await reload();
      select(result.router_id || parsed.routerId || '');
      toast.success('Роутер добавлен');
      onClose();
      navigate('/app');
    } catch (caught) {
      toast.error(errorMessage(caught));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="m-overlay" role="dialog" aria-modal="true" onClick={busy ? undefined : onClose}>
      <div className="m-sheet m-sheet-tall" onClick={(event) => event.stopPropagation()}>
        <div className="m-sheet-grip" />
        <div className="m-sheet-head">
          <h2 className="m-sheet-title">Новый роутер</h2>
          <button
            type="button"
            className="m-iconbtn"
            aria-label="Закрыть"
            onClick={onClose}
            disabled={busy}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="m-tabs">
          <button
            type="button"
            className={`m-tab ${tab === 'scan' ? 'm-tab-active' : ''}`}
            onClick={() => setTab('scan')}
          >
            Сканер QR
          </button>
          <button
            type="button"
            className={`m-tab ${tab === 'link' ? 'm-tab-active' : ''}`}
            onClick={() => setTab('link')}
          >
            Ссылка
          </button>
        </div>

        {tab === 'scan' ? (
          <QrScanner
            disabled={busy}
            onResult={(value) => {
              if (busy) return;
              setStatus('QR распознан');
              void submit(value);
            }}
          />
        ) : (
          <div className="m-card m-addbox">
            <label className="m-inputlabel" htmlFor="router-link">
              Ссылка или токен с роутера
            </label>
            <textarea
              id="router-link"
              className="m-input m-textarea"
              rows={4}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="http://192.168.2.230/#/install?token=…&router=…"
              spellCheck={false}
              disabled={busy}
            />
            <button
              type="button"
              className="m-action m-action-sm"
              disabled={busy || text.trim() === ''}
              onClick={() => void submit(text)}
            >
              {busy ? 'Подключаем…' : 'Подключить'}
            </button>
          </div>
        )}

        {status ? <p className="m-note">{status}</p> : null}

        <button type="button" className="m-link m-link-center" onClick={onClose} disabled={busy}>
          Закрыть
        </button>
      </div>
    </div>
  );
}

function QrScanner(props: { onResult: (value: string) => void; disabled: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const [state, setState] = useState<'idle' | 'starting' | 'scanning' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stop(): void {
    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }

  async function start(): Promise<void> {
    setError(null);

    if (!window.isSecureContext) {
      setError('Камера работает только по HTTPS. Откройте панель по защищённому адресу.');
      setState('error');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Браузер не даёт доступ к камере.');
      setState('error');
      return;
    }
    const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (!Ctor) {
      setError(
        'Этот браузер не умеет распознавать QR. Откройте вкладку «Ссылка» и вставьте ссылку с роутера.',
      );
      setState('error');
      return;
    }

    setState('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('Видео недоступно');
      video.srcObject = stream;
      await video.play();
      setState('scanning');

      const detector = new Ctor({ formats: ['qr_code'] });
      timerRef.current = window.setInterval(() => {
        if (!video || video.readyState < 2) return;
        void detector
          .detect(video)
          .then((codes) => {
            const value = codes[0]?.rawValue;
            if (!value) return;
            stop();
            setState('done');
            props.onResult(value);
          })
          .catch(() => undefined);
      }, 350);
    } catch (caught) {
      stop();
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        /NotAllowed|Permission/i.test(message)
          ? 'Доступ к камере запрещён. Разрешите его в настройках браузера.'
          : `Не удалось включить камеру: ${message}`,
      );
      setState('error');
    }
  }

  return (
    <div className="m-scanner">
      <div className="m-scanframe">
        <video ref={videoRef} playsInline muted className="m-scanvideo" />
        {state !== 'scanning' ? (
          <div className="m-scanplaceholder">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3" />
              <path d="M4 12h16" />
            </svg>
          </div>
        ) : (
          <div className="m-scanline" aria-hidden="true" />
        )}
      </div>

      {error ? <p className="m-note m-note-warn">{error}</p> : null}

      {state === 'idle' || state === 'error' ? (
        <button type="button" className="m-ghost m-ghost-wide" onClick={() => void start()}>
          {state === 'error' ? 'Попробовать снова' : 'Включить камеру'}
        </button>
      ) : null}

      {state === 'starting' ? <p className="m-note">Включаем камеру…</p> : null}
      {state === 'scanning' ? (
        <p className="m-note">Наведите камеру на QR-код на странице JanusNew.</p>
      ) : null}
      {state === 'done' ? <p className="m-note">QR распознан, подключаем…</p> : null}
    </div>
  );
}
