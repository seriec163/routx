import {
  Button,
  InfoBanner,
  JobProgress,
  Panel,
  Spinner,
  StatusBadge,
} from '../../components/ui';
import { PRODUCT_LABEL } from '../../lib/format';
import type { Job, RouterRecord } from '../../lib/types';
import {
  componentStatusLabel,
  TACHYON_COMPONENTS,
  versionAtLeast,
  type TachyonComponentInfo,
} from './tachyon';

export function UpdatesTab(props: {
  router: RouterRecord;
  online: boolean;
  componentCheckBusy: boolean;
  componentUpdating: string | null;
  componentCheckedAt: Date | null;
  componentErrors: Array<{ component: string; message: string }>;
  componentResults: TachyonComponentInfo[];
  componentJob: Job | null;
  componentLog: string;
  onCheck: () => void;
  onUpdate: (component: 'tachyon' | 'tachyon-core') => void;
}) {
  const { router, online, componentCheckBusy, componentUpdating } = props;
  return (
    <div className="stack">
      <Panel
        title="Обновления Tachyon"
        subtitle="Версии проверяются штатным механизмом Tachyon. Обновление ядра перезапускает маршрутизацию, обновление модуля — LuCI и CLI."
      >
        {router.product !== 'tachyon' ? (
          <InfoBanner>
            Раздел доступен только для роутеров на Tachyon. Сейчас установлен{' '}
            {PRODUCT_LABEL[router.product] ?? router.product ?? 'другой продукт'}.
          </InfoBanner>
        ) : (
          <>
            {!versionAtLeast(router.agent_version, '1.5.47') ? (
              <InfoBanner tone="warn">
                Агент {router.agent_version ?? 'неизвестной версии'} не умеет управлять
                компонентами Tachyon. Обновите агент до 1.5.47 в разделе «Обновления агентов».
              </InfoBanner>
            ) : null}
            <div className="row">
              <Button
                size="sm"
                variant="ghost"
                onClick={props.onCheck}
                busy={componentCheckBusy}
                disabled={!online || componentCheckBusy || componentUpdating !== null}
              >
                Проверить обновления
              </Button>
              {props.componentCheckedAt ? (
                <span className="muted-text small">
                  Проверено {props.componentCheckedAt.toLocaleTimeString()}
                </span>
              ) : null}
            </div>

            {props.componentErrors.length > 0 ? (
              <div className="stack">
                {props.componentErrors.map((entry) => (
                  <InfoBanner key={entry.component} tone="warn">
                    {TACHYON_COMPONENTS.find((item) => item.id === entry.component)?.title ??
                      entry.component}
                    : {entry.message}
                  </InfoBanner>
                ))}
              </div>
            ) : null}

            {TACHYON_COMPONENTS.map((item) => {
              const info = props.componentResults.find((entry) => entry.component === item.id);
              const badge = componentStatusLabel(info);
              const busy = componentUpdating === item.id;
              const currentVersion = info?.current_version || '—';
              const latestVersion = info?.latest_version || '—';
              const canUpdate =
                online &&
                !componentCheckBusy &&
                componentUpdating === null &&
                versionAtLeast(router.agent_version, '1.5.47') &&
                latestVersion !== '—';
              return (
                <div
                  key={item.id}
                  style={{
                    border: '1px solid var(--line, rgba(120,90,120,.16))',
                    borderRadius: 12,
                    padding: 14,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      gap: 12,
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <strong>{item.title}</strong>
                      <div className="muted-text small">{item.description}</div>
                    </div>
                    <StatusBadge status={badge.status} label={badge.label} />
                  </div>
                  <div className="kv" style={{ marginTop: 10 }}>
                    <span>Установлено</span>
                    <strong>{currentVersion}</strong>
                    <span>Последняя</span>
                    <strong>{latestVersion}</strong>
                  </div>
                  {info?.message ? <p className="muted-text small">{info.message}</p> : null}
                  {info?.release_url ? (
                    <a
                      className="muted-text small"
                      href={info.release_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Страница релиза
                    </a>
                  ) : null}
                  <div className="row" style={{ marginTop: 10 }}>
                    <Button
                      size="sm"
                      onClick={() => props.onUpdate(item.id)}
                      busy={busy}
                      disabled={!canUpdate}
                    >
                      {busy
                        ? 'Обновляем…'
                        : info?.status === 'latest'
                          ? 'Переустановить'
                          : 'Обновить'}
                    </Button>
                  </div>
                </div>
              );
            })}
            {componentCheckBusy ? <Spinner label="Проверяем версии Tachyon…" /> : null}
          </>
        )}
      </Panel>

      {props.componentJob ? (
        <JobProgress
          job={props.componentJob}
          label={
            componentUpdating
              ? `Обновление ${componentUpdating === 'tachyon-core' ? 'ядра Tachyon Core' : 'модуля Tachyon'}`
              : 'Проверка обновлений Tachyon'
          }
        />
      ) : null}

      {props.componentLog ? (
        <Panel
          title="Журнал обновления"
          subtitle="Последние строки штатного журнала Tachyon на роутере."
        >
          <pre
            className="mono small"
            style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto', margin: 0 }}
          >
            {props.componentLog}
          </pre>
        </Panel>
      ) : null}
    </div>
  );
}
