import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './diagnostics.css';
import './variants.css';
import './onboarding.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Не найден корневой элемент #root');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: service worker нужен для установки приложения. На HTTP (кроме localhost)
// браузеры его не регистрируют — тогда QR просто открывает панель в браузере.
if ('serviceWorker' in navigator && (window.isSecureContext || window.location.hostname === 'localhost')) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  const checkForUpdate = () => {
    void navigator.serviceWorker
      .getRegistration('/')
      .then((registration) => registration?.update())
      .catch(() => undefined);
  };

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => registration.update())
      .catch(() => undefined);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
}
