import { useEffect, useRef, useState } from 'react';
import { BrandMark } from './Auth';
import { Button, ErrorBanner, InfoBanner, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { navigate } from '../lib/router';
import { getDeviceId, markMobileBound } from '../mobile/deviceId';
import { useSession } from '../session';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface ExchangeResponse {
  router_id: string;
}

/**
 * Страница, на которую ведёт QR. Токен лежит во фрагменте URL и сразу
 * обменивается на обычную сессию. После этого можно установить PWA.
 * Без токена страница тоже работает: показывает инструкцию по установке.
 */
export function InstallPage({
  token,
  routerId,
  onLoggedIn,
}: {
  token: string | null;
  routerId: string | null;
  onLoggedIn: () => void | Promise<unknown>;
}) {
  const [status, setStatus] = useState<'idle' | 'exchanging' | 'ready' | 'error'>(
    token ? 'exchanging' : 'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [targetRouter, setTargetRouter] = useState<string | null>(routerId);
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [secureContext, setSecureContext] = useState(true);
  const { me } = useSession();
  const onLoggedInRef = useRef(onLoggedIn);
  const exchangeStarted = useRef(false);

  useEffect(() => {
    onLoggedInRef.current = onLoggedIn;
  }, [onLoggedIn]);

  useEffect(() => {
    setSecureContext(window.isSecureContext);
    setStandalone(
      window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true,
    );
    const handler = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    const installedHandler = () => {
      setInstalled(true);
      setPromptEvent(null);
    };
    window.addEventListener('appinstalled', installedHandler);
    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', installedHandler);
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    if (exchangeStarted.current) return;
    exchangeStarted.current = true;
    let active = true;
    (async () => {
      try {
        const response = await api<ExchangeResponse>('/api/v1/mobile/exchange', {
          method: 'POST',
          body: { token, device_id: getDeviceId() || undefined },
        });
        if (!active) return;
        await onLoggedInRef.current();
        setTargetRouter(response.router_id || routerId);
        if (response.router_id) {
          window.localStorage.setItem('rc.mobile.router', response.router_id);
        }
        markMobileBound();
        // Сразу в приложение: инструкция по установке живёт в верхней плашке
        // на главном экране, а не отдельной страницей после QR.
        navigate('/app', { replace: true });
      } catch (caught) {
        if (!active) return;
        setError(errorMessage(caught));
        setStatus('error');
      }
    })();
    return () => {
      active = false;
    };
  }, [token, routerId]);

  async function install(): Promise<void> {
    if (!promptEvent) return;
    await promptEvent.prompt();
    await promptEvent.userChoice;
    setPromptEvent(null);
  }

  const openTarget = '/app';
  const isInstalled = standalone || installed;

  return (
    <div className="auth-shell auth-shell-single">
      <main className="auth-main">
        <div className="auth-card">
          <div className="brand auth-brand-inline">
            <BrandMark />
            <div>
              <p className="brand-name">RoutX</p>
              <p className="brand-sub">Мобильное приложение</p>
            </div>
          </div>

          {status === 'exchanging' ? (
            <Spinner label="Входим по одноразовой ссылке…" />
          ) : null}

          {status === 'error' ? (
            <>
              <ErrorBanner message={error ?? 'Ссылка недействительна'} />
              <p className="page-sub">
                Ссылка действует 5 минут и используется один раз. Создайте новый QR на роутере:
                LuCI → Служба → RoutX, — или войдите обычным способом. Установить приложение можно
                и без ссылки — инструкция ниже.
              </p>
            </>
          ) : null}

          {status === 'ready' ? (
            <InfoBanner>
              Готово: вы вошли. Роутер добавлен в приложение — теперь его можно установить на
              телефон.
            </InfoBanner>
          ) : null}

          {!secureContext ? (
            <InfoBanner tone="warn">
              Страница открыта по HTTP. Установка приложения на iPhone/Android может не работать —
              откройте панель по HTTPS-домену.
            </InfoBanner>
          ) : null}

          {status !== 'exchanging' ? (
            <>
              <h2>
                {isInstalled ? 'Приложение установлено' : 'Установите RoutX на телефон'}
              </h2>
              <p className="page-sub">
                {isInstalled
                  ? 'Открывайте RoutX с домашнего экрана: адресной строки нет, вход сохраняется. Обновления приходят автоматически.'
                  : 'RoutX работает как PWA — это обычное приложение с иконкой на домашнем экране. Магазин приложений не нужен.'}
              </p>

              {promptEvent && !isInstalled ? (
                <div className="stack" style={{ marginBottom: 12 }}>
                  <Button onClick={() => void install()}>Установить приложение</Button>
                  <p className="muted-text small" style={{ margin: 0 }}>
                    Если кнопка не сработала, используйте шаги ниже.
                  </p>
                </div>
              ) : null}

              {!isInstalled ? (
                <ol className="steps">
                  <li>
                    <strong>Откройте страницу в браузере.</strong> Если она открылась внутри
                    Telegram, WhatsApp или другого приложения, нажмите «Открыть в браузере»:
                    из встроенного окна установка не работает.
                  </li>
                  <li>
                    <strong>Android (Chrome):</strong> меню ⋮ → «Установить приложение» или
                    «Добавить на главный экран» → «Установить».
                  </li>
                  <li>
                    <strong>iPhone / iPad (Safari):</strong> «Поделиться» → «На экран „Домой“» →
                    «Добавить». В Chrome на iPhone установка PWA недоступна — нужен Safari.
                  </li>
                  <li>
                    <strong>Компьютер (Chrome или Edge):</strong> значок установки в адресной
                    строке либо меню → «Установить RoutX».
                  </li>
                  <li>
                    Откройте RoutX с домашнего экрана. Вход сохранится, адресная строка исчезнет.
                  </li>
                </ol>
              ) : null}

              <div className="row" style={{ marginTop: 12 }}>
                <Button onClick={() => navigate(openTarget)}>
                  {targetRouter ? 'Открыть роутер' : 'Открыть приложение'}
                </Button>
                {(status === 'idle' || status === 'error') && !me ? (
                  <Button variant="ghost" onClick={() => navigate('/login')}>
                    Войти
                  </Button>
                ) : null}
              </div>

              {token ? (
                <p className="muted-text small" style={{ marginTop: 12 }}>
                  Ссылка одноразовая и действует 5 минут. После входа она больше не работает.
                  Инструкция по установке остаётся доступной по адресу{' '}
                  <code>/#/install</code>.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}
