import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { hasPendingCamera, releaseCamera, takeCamera } from './camera';

export function parseLink(text: string): { token: string; routerId: string | null } | null {
  const value = text.trim();
  if (value === '') return null;

  const tokenMatch = value.match(/(?:^|[?&#&])token=([A-Za-z0-9_-]{20,})/);
  const routerMatch = value.match(
    /router=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );

  if (tokenMatch) {
    return { token: tokenMatch[1]!, routerId: routerMatch?.[1] ?? null };
  }
  if (/^[A-Za-z0-9_-]{20,}$/.test(value)) {
    return { token: value, routerId: null };
  }
  return null;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats: string[] }): BarcodeDetectorLike;
}

/**
 * Сканер QR с камеры. Работает в Safari на iPhone через jsQR:
 * BarcodeDetector там отсутствует.
 */
export function QrScanner(props: { onResult: (value: string) => void; disabled: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const doneRef = useRef(false);
  const [state, setState] = useState<'idle' | 'starting' | 'scanning' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Поток мог быть открыт ещё на главном экране, в жесте нажатия QR.
    // Тогда камера стартует сразу, без кнопки «Включить камеру».
    if (hasPendingCamera()) void start();
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
      // Если поток уже открыт кнопкой QR на главной — используем его.
      let stream = takeCamera();
      if (!stream || stream.getVideoTracks().every((track) => track.readyState !== 'live')) {
        releaseCamera(stream);
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      }
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
