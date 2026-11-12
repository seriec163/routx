import { useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { PRODUCT_LABEL } from '../lib/format';
import { useToast } from '../components/ui';
import { navigate, useRoute } from '../lib/router';
import { useSession } from '../session';
import { MobileHeader, useMobile } from './MobileApp';
import { StatusDot } from './HomeScreen';
import { getDeviceId, markMobileBound } from './deviceId';
import { parseLink, QrScanner } from './qr';

export function RoutersScreen() {
  const { routers, routerGroups, selectedId, select, reload, loading } = useMobile();
  const route = useRoute();
  // Переход с главной по кнопке QR сразу открывает добавление роутера.
  const [addOpen, setAddOpen] = useState(() => route.query.get('add') === '1');

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
            <span className="m-label">Роутеры · {routers.length}</span>
            <button type="button" className="m-mini" onClick={() => void reload()} disabled={loading}>
              Обновить
            </button>
          </div>

          {routers.length === 0 && !loading ? (
            <p className="m-empty-text">
              Роутеров пока нет. Отсканируйте QR на странице RoutX роутера или вставьте ссылку.
            </p>
          ) : (
            routerGroups.map((group) => (
              <div className="m-router-group" key={group.id}>
                <div className="m-router-group-head">
                  <span className="m-label">{group.label}</span>
                  <span className="m-router-group-count">{group.items.length}</span>
                </div>
                {group.items.map((router) => (
                  <button
                    type="button"
                    key={router.id}
                    className={`m-routerrow ${
                      router.id === selectedId ? 'm-routerrow-active' : ''
                    }`}
                    onClick={() => {
                      select(router.id);
                      navigate('/app');
                    }}
                  >
                    <StatusDot item={router} />
                    <span className="m-routerrow-main">
                      <span className="m-routerrow-name">{router.name}</span>
                      <span className="m-routerrow-meta">
                        {PRODUCT_LABEL[router.product] ?? router.product}
                        {router.product_version ? ` ${router.product_version}` : ''}
                        {router.latency_ms != null
                          ? ` · ${Math.round(router.latency_ms)} мс`
                          : ''}
                      </span>
                    </span>
                    {router.id === selectedId ? (
                      <svg className="m-check" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m5 12.5 4.5 4.5L19 7" />
                      </svg>
                    ) : null}
                  </button>
                ))}
              </div>
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
        body: { token: parsed.token, device_id: getDeviceId() || undefined },
      });
      setStatus('Входим и выбираем роутер…');
      await reload();
      const routerId = result.router_id || parsed.routerId || '';
      if (routerId) window.localStorage.setItem('rc.mobile.router', routerId);
      markMobileBound();
      select(routerId);
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

