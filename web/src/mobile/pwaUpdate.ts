const SW_URL = '/sw.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Обновляет установленное PWA без удаления с домашнего экрана.
 * Service worker получает свежий sw.js, активируется и приложение
 * перезагружается. Cookies, localStorage и привязка устройства сохраняются.
 */
export async function updatePwa(): Promise<void> {
  if (!navigator.onLine) {
    throw new Error('Нет подключения к интернету');
  }

  let registration = await navigator.serviceWorker.getRegistration('/').catch(() => null);
  if (!registration) {
    registration = await navigator.serviceWorker.register(SW_URL);
  }

  let controllerChanged = false;
  const onControllerChange = () => {
    controllerChanged = true;
  };
  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

  try {
    await registration.update();

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !controllerChanged) {
      const worker = registration.installing ?? registration.waiting;
      if (!worker) break;
      if (worker.state === 'installed') {
        registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
      }
      await wait(200);
    }

    if (!controllerChanged) await wait(300);
  } finally {
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
  }

  // Перезагрузка загрузит свежий index.html и новые хэши ассетов.
  // Сессия и данные приложения не очищаются.
  window.location.reload();
}
