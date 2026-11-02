import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
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
              Роутеров пока нет. Отсканируйте QR на странице RoutX роутера или вставьте ссылку.
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

        <button
          type="button"
          className="m-link m-link-center"
          onClick={() => navigate('/install')}
        >
          Как установить приложение на телефон
        </button>

        <p className="m-footnote">
          QR создаётся на самом роутере: LuCI → Служба → RoutX. Ссылка одноразовая и действует
          5 минут.
        </p>

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
              placeholder="https://routx.example/#/install?token=…&router=…"
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
  const doneRef = useRef(false);
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
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
  }

  // jsQR работает во всех браузерах, включая Safari на iPhone,
  // где BarcodeDetector отсутствует. Кадр уменьшаем, чтобы не грузить телефон.
  function decodeWithJsQr(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
  ): string | null {
    if (!video.videoWidth || !video.videoHeight) return null;
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    return jsQR(image.data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  }

  async function start(): Promise<void> {
    setError(null);
    doneRef.current = false;
    stop();

    if (!window.isSecureContext) {
      setError('Камера работает только по HTTPS. Откройте панель по защищённому адресу.');
      setState('error');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Браузер не даёт доступ к камере. Откройте RoutX в Chrome или Safari.');
      setState('error');
      return;
    }

    setState('starting');
    try {
      // Сначала запрашиваем камеру: браузер покажет разрешение пользователю.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('Видео недоступно');
      video.srcObject = stream;
      await video.play();
      if (doneRef.current) return;
      setState('scanning');

      const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      const detector = Ctor ? new Ctor({ formats: ['qr_code'] }) : null;
      let detectorBroken = false;

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });

      timerRef.current = window.setInterval(() => {
        if (doneRef.current || video.readyState < 2) return;

        const read = async (): Promise<string | null> => {
          if (detector && !detectorBroken) {
            try {
              const codes = await detector.detect(video);
              return codes[0]?.rawValue ?? null;
            } catch {
              // API есть, но не работает с этим форматом — дальше читаем через jsQR.
              detectorBroken = true;
            }
          }
          return context ? decodeWithJsQr(video, canvas, context) : null;
        };

        void read()
          .then((value) => {
            if (!value || doneRef.current) return;
            doneRef.current = true;
            stop();
            setState('done');
            props.onResult(value);
          })
          .catch(() => undefined);
      }, 300);
    } catch (caught) {
      stop();
      const name = caught instanceof DOMException ? caught.name : '';
      let message: string;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        message =
          'Доступ к камере запрещён. Разрешите камеру для этого сайта в настройках браузера и нажмите «Попробовать снова».';
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        message = 'Камера не найдена. Проверьте, что она не закрыта чехлом и доступна браузеру.';
      } else if (name === 'NotReadableError') {
        message = 'Камера занята другим приложением. Закройте его и нажмите «Попробовать снова».';
      } else {
        message = `Не удалось включить камеру: ${caught instanceof Error ? caught.message : String(caught)}`;
      }
      setError(message);
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

      {state === 'starting' ? (
        <p className="m-note">Запрашиваем доступ к камере… Разрешите его в браузере.</p>
      ) : null}
      {state === 'scanning' ? (
        <p className="m-note">Наведите камеру на QR-код на странице RoutX.</p>
      ) : null}
      {state === 'done' ? <p className="m-note">QR распознан, подключаем…</p> : null}
    </div>
  );
}
