import { Button, Empty, InfoBanner, Panel, TextInput } from '../../components/ui';
import { formatDate, PRODUCT_LABEL } from '../../lib/format';
import type { MetricSample, RouterRecord, RouterState } from '../../lib/types';

export function OverviewTab(props: {
  router: RouterRecord;
  state: RouterState | null | undefined;
  managedEntries: Array<[string, string | string[] | null]>;
  stateQuery: string;
  onStateQueryChange: (value: string) => void;
  latest: MetricSample | null;
  serviceLabel: string;
  healthLabel: string;
  proxyLabel: string;
  productSvc: { present: boolean; enabled: boolean | null };
  productLabel: string;
  singBoxAutostartLabel: string;
  autostartEnabled: boolean;
  autostartPartial: boolean;
  serviceAction: (action: 'restart' | 'start' | 'stop' | 'enable' | 'disable') => void;
  serviceBusy: string | null;
  canMutate: boolean;
}) {
  const { state, latest, productSvc, productLabel } = props;
  return (
    <div className="grid-2">
      <Panel
        title="Управляемые параметры"
        subtitle={`${Object.keys(state?.managed ?? {}).length} путей в снимке состояния. Это технические пути UCI: секции в Prokop и панели показываются по label.`}
        actions={
          <TextInput
            value={props.stateQuery}
            onChange={props.onStateQueryChange}
            placeholder="Фильтр по пути"
            type="search"
          />
        }
      >
        {!state ? (
          <Empty>Состояние ещё не собрано. Нажмите «Прочитать состояние».</Empty>
        ) : props.managedEntries.length === 0 ? (
          <Empty>Параметров не найдено.</Empty>
        ) : (
          <div className="state-list">
            {props.managedEntries.slice(0, 200).map(([path, value]) => (
              <div key={path} className="state-row">
                <code>{path}</code>
                <span>{Array.isArray(value) ? value.join(', ') : value ?? '—'}</span>
              </div>
            ))}
            {props.managedEntries.length > 200 ? (
              <p className="muted-text small">Показаны первые 200 из {props.managedEntries.length}.</p>
            ) : null}
          </div>
        )}
      </Panel>

      <div className="stack">
        <Panel title="Служба и доступность">
          <div className="kv">
            <span>Состояние</span>
            <strong>{props.serviceLabel}</strong>
            <span>Health</span>
            <strong>{props.healthLabel}</strong>
            <span>Прокси</span>
            <strong>{props.proxyLabel}</strong>
            <span>Последний замер</span>
            <strong>{latest ? formatDate(latest.ts) : '—'}</strong>
            <span>Источник состояния</span>
            <strong>{state?.source ?? '—'}</strong>
            <span>Собрано</span>
            <strong>{formatDate(state?.collected_at)}</strong>
            <span>Автозапуск {PRODUCT_LABEL[props.router.product] ?? ''}</span>
            <strong>
              {!productSvc.present
                ? 'нет данных'
                : productSvc.enabled === null
                  ? 'неизвестно'
                  : productSvc.enabled
                    ? 'включён'
                    : 'выключен'}
            </strong>
            <span>Автозапуск sing-box</span>
            <strong>{props.singBoxAutostartLabel}</strong>
            <span>Автозапуск пары</span>
            <strong>
              {props.autostartEnabled ? 'включён' : props.autostartPartial ? 'частично' : 'выключен'}
            </strong>
          </div>
          <div className="row">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => props.serviceAction('restart')}
              disabled={!props.canMutate || props.serviceBusy !== null}
              busy={props.serviceBusy === 'restart'}
            >
              Перезапустить
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => props.serviceAction('start')}
              disabled={!props.canMutate || props.serviceBusy !== null}
              busy={props.serviceBusy === 'start'}
            >
              Запустить
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (window.confirm('Остановить службу прокси на роутере?')) {
                  props.serviceAction('stop');
                }
              }}
              disabled={!props.canMutate || props.serviceBusy !== null}
              busy={props.serviceBusy === 'stop'}
            >
              Остановить
            </Button>
          </div>
          {props.autostartPartial ? (
            <InfoBanner tone="warn">
              Отдельный автозапуск sing-box включён, но автозапуск {productLabel} выключен.
              После перезагрузки sing-box может подняться без управления продуктом. Включите
              автостарт {productLabel}, чтобы поднимались обе службы.
            </InfoBanner>
          ) : null}
          {productSvc.present ? (
            <div className="row" style={{ marginTop: 8 }}>
              {props.autostartEnabled ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Выключить автозапуск ${productLabel}? После перезагрузки роутера прокси и sing-box не запустятся автоматически. Сейчас службы продолжат работать.`,
                      )
                    ) {
                      props.serviceAction('disable');
                    }
                  }}
                  disabled={!props.canMutate || props.serviceBusy !== null}
                  busy={props.serviceBusy === 'disable'}
                >
                  Выключить автостарт
                </Button>
              ) : (
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => props.serviceAction('enable')}
                  disabled={!props.canMutate || props.serviceBusy !== null}
                  busy={props.serviceBusy === 'enable'}
                >
                  Включить автостарт
                </Button>
              )}
            </div>
          ) : null}
          <p className="muted-text small" style={{ margin: '8px 0 0' }}>
            Автозапуск включает {productLabel}. При старте {productLabel} сам запускает
            sing-box и намеренно отключает отдельный автозапуск sing-box — так устроены Prokop
            и Forkop. Поэтому после перезагрузки поднимаются обе службы, а отдельная галочка
            sing-box не нужна. Включение не запускает службы сразу, выключение не
            останавливает их.
          </p>
        </Panel>

        <Panel title="Возможности агента">
          {state?.capabilities ? (
            <pre className="code-block small">{JSON.stringify(state.capabilities, null, 2)}</pre>
          ) : (
            <Empty>Агент ещё не сообщал о возможностях.</Empty>
          )}
        </Panel>
      </div>
    </div>
  );
}
