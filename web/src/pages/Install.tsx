import { useEffect, useRef, useState } from 'react';
import { BrandMark } from './Auth';
import { Button, ErrorBanner, InfoBanner, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { navigate } from '../lib/router';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface ExchangeResponse {
  user: { email: string; first_name?: string | null };
  router_id: string;
}

/**
 * Страница, на которую ведёт QR. Токен лежит во фрагменте URL и сразу
 * обменивается на обычную сессию. После этого можно установить PWA.
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
  const [email, setEmail] = useState<string | null>(null);
  const [targetRouter, setTargetRouter] = useState<string | null>(routerId);
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [secureContext, setSecureContext] = useState(true);
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
          body: { token },
        });
        if (!active) return;
        await onLoggedInRef.current();
        setEmail(response.user.first_name || response.user.email);
        setTargetRouter(response.router_id || routerId);
        setStatus('ready');
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

  const openTarget = targetRouter ? `/routers/${targetRouter}` : '/routers';

  return (
    <div className="auth-shell auth-shell-single">
      <main className="auth-main">
        <div className="auth-card">
          <div className="brand auth-brand-inline">
            <BrandMark />
            <div>
              <p className="brand-name">Router Control</p>
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
                LuCI → Служба → JanusNew, — или войдите обычным способом.
              </p>
              <div className="row">
                <Button onClick={() => navigate('/login')}>Войти</Button>
                <Button variant="ghost" onClick={() => navigate('/routers')}>
                  К роутерам
                </Button>
              </div>
            </>
          ) : null}

          {status === 'ready' ? (
            <InfoBanner>
              Готово: вы вошли{email ? ` как ${email}` : ''}. Теперь приложение можно установить на
              телефон.
            </InfoBanner>
          ) : null}

          {!secureContext ? (
            <InfoBanner tone="warn">
              Страница открыта по HTTP. Установка приложения на iPhone/Android может не работать —
              откройте панель по HTTPS-домену.
            </InfoBanner>
          ) : null}

          {status !== 'error' ? (
            <>
              <h2>{standalone ? 'Приложение уже открыто' : 'Установить Router Control'}</h2>
              <p className="page-sub">
                {standalone || installed
                  ? 'Приложение установлено. Можно открыть роутер и менять правила, подключения, DNS или перезапускать службу.'
                  : 'Установите приложение на домашний экран — оно откроется без адресной строки и сохранит вход.'}
              </p>

              {promptEvent ? (
                <Button onClick={() => void install()}>Установить приложение</Button>
              ) : null}

              {!standalone && !installed && !promptEvent ? (
                <ul className="bullets">
                  <li>
                    <strong>iPhone / iPad:</strong> откройте в Safari → «Поделиться» → «На экран
                    „Домой“».
                  </li>
                  <li>
                    <strong>Android:</strong> меню браузера → «Установить приложение» или «Добавить
                    на главный экран».
                  </li>
                  <li>
                    <strong>Компьютер:</strong> значок установки в адресной строке Chrome или Edge.
                  </li>
                </ul>
              ) : null}

              <div className="row" style={{ marginTop: 12 }}>
                <Button onClick={() => navigate(openTarget)}>
                  {targetRouter ? 'Открыть роутер' : 'Открыть панель'}
                </Button>
                {status === 'idle' ? (
                  <Button variant="ghost" onClick={() => navigate('/login')}>
                    Войти
                  </Button>
                ) : null}
              </div>

              {token ? (
                <p className="muted-text small" style={{ marginTop: 12 }}>
                  Ссылка одноразовая и действует 5 минут. После входа она больше не работает.
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}
