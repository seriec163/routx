import { Link } from '../../components/link';
import {
  Button,
  Empty,
  ErrorBanner,
  InfoBanner,
  Panel,
  Spinner,
  StatusBadge,
} from '../../components/ui';
import { formatDate } from '../../lib/format';
import type { RouterRecord } from '../../lib/types';
import { CredentialPanel } from './CredentialPanel';
import { versionAtLeast } from './tachyon';
import { wifiEncryptionLabel, type WifiInterface, type WifiState } from './wifi';

export function SettingsTab(props: {
  router: RouterRecord;
  routerId: string;
  online: boolean;
  wifi: WifiState | null;
  wifiBusy: boolean;
  wifiError: string | null;
  onReadWifi: () => void;
  onCreateWifi: () => void;
  onEditWifi: (iface: WifiInterface) => void;
  onRename: () => void;
  onToggleMonitoring: (enabled: boolean) => void;
  onRotateCredential: () => void;
  onIssueBinding: () => void;
  onArchive: () => void;
  onPurge: () => void;
}) {
  const { router, wifi } = props;
  return (
    <div className="stack">
      <Panel
        title="Wi-Fi сети"
        subtitle="Сети читаются через агент из /etc/config/wireless. Текущие пароли не показываются: можно задать новый пароль или оставить поле пустым."
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={props.onReadWifi}
              busy={props.wifiBusy}
              disabled={!props.online}
            >
              Прочитать Wi-Fi
            </Button>
            <Button
              size="sm"
              variant="subtle"
              onClick={props.onCreateWifi}
              disabled={Boolean(router.archived_at) || wifi?.hardware?.present === false}
            >
              Добавить сеть
            </Button>
          </>
        }
      >
        {!versionAtLeast(router.agent_version, '1.5.52') ? (
          <InfoBanner tone="warn">
            Агент {router.agent_version ?? 'неизвестной версии'} ещё не умеет определять
            наличие Wi-Fi модуля. При первом чтении панель автоматически обновит его до 1.5.52 —
            это может занять около минуты.
          </InfoBanner>
        ) : null}
        {wifi?.hardware ? (
          <div className="row">
            <StatusBadge
              status={wifi.hardware.present ? 'success' : 'error'}
              label={wifi.hardware.present ? 'Wi-Fi модуль есть' : 'Wi-Fi модуль не найден'}
            />
            {wifi.hardware.phys && wifi.hardware.phys.length > 0 ? (
              <span className="muted-text small">phy: {wifi.hardware.phys.join(', ')}</span>
            ) : null}
          </div>
        ) : null}
        {wifi?.hardware && !wifi.hardware.present ? (
          <InfoBanner tone="warn">
            На роутере не обнаружен Wi-Fi модуль. Просмотр оставшихся сетей доступен, но
            создавать и изменять Wi-Fi нельзя.
          </InfoBanner>
        ) : null}
        {props.wifiError ? <ErrorBanner message={props.wifiError} /> : null}
        {props.wifiBusy && !wifi ? <Spinner label="Читаем Wi-Fi…" /> : null}
        {!wifi && !props.wifiBusy ? (
          <Empty>
            {props.online
              ? 'Нажмите «Прочитать Wi-Fi», чтобы загрузить существующие сети.'
              : 'Роутер не в сети — Wi-Fi можно прочитать после подключения.'}
          </Empty>
        ) : null}
        {wifi ? (
          <div className="stack">
            {wifi.interfaces.length === 0 ? (
              <Empty>
                {wifi.hardware?.present === false
                  ? 'Wi-Fi модуль не обнаружен.'
                  : 'Wi-Fi модуль есть, но сети ещё не настроены.'}
              </Empty>
            ) : (
              wifi.interfaces.map((iface) => {
                const radio = wifi.radios.find((item) => item.name === iface.device);
                return (
                  <div
                    key={iface.name}
                    style={{
                      border: '1px solid var(--line, rgba(120,90,120,.16))',
                      borderRadius: 12,
                      padding: 12,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                        alignItems: 'flex-start',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div>
                        <strong>{iface.ssid || '(без SSID)'}</strong>
                        <div className="muted-text small">
                          {iface.name} · {iface.device}
                          {radio?.band ? ` · ${radio.band}` : ''} · {iface.mode} ·{' '}
                          {iface.network || '—'} · {wifiEncryptionLabel(iface.encryption)}
                          {iface.key_set ? ' · пароль задан' : ''}
                        </div>
                      </div>
                      <div className="row">
                        {iface.hidden ? <StatusBadge status="warning" label="скрытая" /> : null}
                        {iface.disabled ? <StatusBadge status="offline" label="отключена" /> : null}
                        {radio?.disabled ? <StatusBadge status="offline" label="радио off" /> : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => props.onEditWifi(iface)}
                        >
                          Изменить
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            {wifi.radios.length > 0 ? (
              <p className="muted-text small">
                Радиомодули:{' '}
                {wifi.radios
                  .map(
                    (radio) =>
                      `${radio.name}${radio.band ? ` (${radio.band})` : ''}${
                        radio.disabled ? ' — off' : ''
                      }`,
                  )
                  .join(' · ')}
              </p>
            ) : null}
          </div>
        ) : null}
      </Panel>

      <div className="grid-2">
        <div className="stack">
          <Panel title="Имя и мониторинг">
            <div className="kv">
              <span>Текущее имя</span>
              <strong>{router.name}</strong>
              <span>Мониторинг</span>
              <strong>{router.monitoring_enabled ? 'включён' : 'выключен'}</strong>
              <span>Владелец</span>
              <strong>{router.owner_email ?? '—'}</strong>
              <span>Создан</span>
              <strong>{formatDate(router.created_at)}</strong>
            </div>
            <div className="row">
              <Button variant="ghost" size="sm" onClick={props.onRename}>
                Переименовать
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => props.onToggleMonitoring(!router.monitoring_enabled)}
              >
                {router.monitoring_enabled ? 'Выключить мониторинг' : 'Включить мониторинг'}
              </Button>
              <Link className="btn btn-subtle btn-sm" to="/routers">
                К списку
              </Link>
            </div>
          </Panel>

          <Panel title="Учётные данные агента">
            <CredentialPanel routerId={props.routerId} />
            <Button variant="ghost" size="sm" onClick={props.onRotateCredential}>
              Ротировать токен агента
            </Button>
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Привязка агента">
            <p className="page-sub">
              Токен привязки действует 5 минут и показывается один раз. Роутер сам устанавливает
              исходящее TLS-соединение.
            </p>
            <Button size="sm" onClick={props.onIssueBinding}>
              Выпустить токен привязки
            </Button>
          </Panel>

          <Panel title="Архивирование">
            <p className="page-sub">
              Архив отключает мониторинг и отзывает учётные данные. Forkop/Prokop/Podkop на устройстве
              остаются без изменений.
            </p>
            <div className="row">
              <Button variant="danger" size="sm" onClick={props.onArchive}>
                Архивировать роутер
              </Button>
              <Button variant="danger" size="sm" onClick={props.onPurge}>
                Удалить навсегда
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
