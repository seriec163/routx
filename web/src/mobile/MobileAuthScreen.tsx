import { useState } from 'react';
import { BrandMark } from '../pages/Auth';
import { Button, ErrorBanner, InfoBanner, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { navigate } from '../lib/router';
import { useSession } from '../session';
import { getDeviceId, markMobileBound } from './deviceId';
import { parseLink, QrScanner } from './qr';

/**
 * Экран для телефона, когда сессии ещё нет или она истекла.
 * Главный путь — QR с роутера: он и создаёт привязку устройства.
 */
export function MobileAuthScreen() {
  const { reload } = useSession();
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(value: string): Promise<void> {
    const parsed = parseLink(value);
    if (!parsed) {
      setError('Не нашли токен. Отсканируйте QR на странице RoutX роутера или вставьте ссылку целиком.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api<{ router_id: string }>('/api/v1/mobile/exchange', {
        method: 'POST',
        body: { token: parsed.token, device_id: getDeviceId() || undefined },
      });
      const routerId = result.router_id || parsed.routerId;
      if (routerId) window.localStorage.setItem('rc.mobile.router', routerId);
      markMobileBound();
      const me = await reload();
      if (!me) {
        setError('Не удалось сохранить сессию. Разрешите cookie для этого сайта и повторите.');
        setBusy(false);
        return;
      }
      navigate('/app', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
      setScanning(false);
      setBusy(false);
    }
  }

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

          <h2>Подключите телефон к роутеру</h2>
          <p className="page-sub">
            Отсканируйте QR на самом роутере: LuCI → Служба → RoutX. Ссылка действует 5 минут.
            Если приложение уже было подключено и сессия истекла, этот скан вернёт доступ.
          </p>

          {error ? <ErrorBanner message={error} /> : null}

          {busy ? <Spinner label="Проверяем QR и входим…" /> : null}

          {scanning && !busy ? (
            <div className="stack" style={{ marginBottom: 12 }}>
              <QrScanner disabled={busy} onResult={(value) => void connect(value)} />
              <Button variant="ghost" onClick={() => setScanning(false)}>
                Закрыть сканер
              </Button>
            </div>
          ) : null}

          {!scanning && !busy ? (
            <div className="stack">
              <Button onClick={() => setScanning(true)}>Сканировать QR</Button>
              <Button variant="ghost" onClick={() => navigate('/login')}>
                Войти по паролю
              </Button>
            </div>
          ) : null}

          <InfoBanner>
            После подключения сессия продлевается сама, пока вы пользуетесь приложением.
            Привязка хранится на телефоне и удаляется вместе с приложением; отозвать её можно
            на роутере.
          </InfoBanner>

          <button
            type="button"
            className="link auth-link-left"
            onClick={() => navigate('/install')}
          >
            Как установить приложение на телефон
          </button>
        </div>
      </main>
    </div>
  );
}
