import {
  Button,
  Empty,
  ErrorBanner,
  InfoBanner,
  JobProgress,
  Panel,
  Spinner,
  StatusBadge,
} from '../../components/ui';
import { formatDate } from '../../lib/format';
import type { DnsBenchmarkState, DnsCandidateResult, DnsStatus, Job, RouterRecord } from '../../lib/types';
import type { ApiState } from '../../lib/useApi';
import { DnsApplyModal } from './DnsApplyModal';

export function DnsTab(props: {
  router: RouterRecord;
  routerId: string;
  online: boolean;
  dnsStatus: ApiState<DnsStatus>;
  agentSupportsDns: boolean;
  dnsBusy: boolean;
  dnsRunning: boolean;
  dnsJob: Job | null;
  dnsCurrent: string;
  dnsError: string | null;
  dnsBenchmark: DnsBenchmarkState | null;
  dnsResults: DnsCandidateResult[];
  dnsChoice: { type: 'udp' | 'doh'; servers: string[] } | null;
  dnsBootstrap: string[];
  dnsCanApply: boolean;
  dnsApplyOpen: boolean;
  dnsProposal: {
    dns_type: 'udp' | 'doh';
    dns_server: string[];
    bootstrap_dns_server: string[];
  } | null;
  onStartBenchmark: () => void;
  onCancelBenchmark: () => void;
  onChoosePair: (type: 'udp' | 'doh', results: DnsCandidateResult[]) => void;
  onApplyOpenChange: (open: boolean) => void;
  onApplied: () => Promise<void> | void;
}) {
  const { router, dnsStatus, dnsBenchmark, dnsResults, dnsChoice } = props;
  const dnsData = dnsStatus.data ?? null;

  return (
    <div className="stack">
      {dnsStatus.error ? (
        <ErrorBanner message={dnsStatus.error} onRetry={() => void dnsStatus.reload()} />
      ) : null}

      <Panel
        title="DNS Prokop/Forkop"
        subtitle="Глобальные DNS-настройки: тип, основные серверы и bootstrap. Секции с собственным DNS здесь не меняются."
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void dnsStatus.reload()}
            busy={dnsStatus.loading}
          >
            Обновить
          </Button>
        }
      >
        {dnsStatus.loading && !dnsData ? <Spinner /> : null}
        {!props.agentSupportsDns ? (
          <InfoBanner tone="warn">
            Агент {router.agent_version ?? 'неизвестной версии'} не поддерживает DNS-бенчмарк.
            Нужен агент 1.1.0 или новее.
          </InfoBanner>
        ) : null}
        {dnsData?.warnings.map((warning) => (
          <InfoBanner key={warning} tone="warn">
            {warning}
          </InfoBanner>
        ))}

        {dnsData?.current ? (
          <div className="kv">
            <span>Тип</span>
            <strong>{dnsData.current.dns_type.toUpperCase()}</strong>
            <span>Основные серверы</span>
            <strong>{dnsData.current.dns_server.join(' · ') || '—'}</strong>
            <span>Bootstrap</span>
            <strong>{dnsData.current.bootstrap_dns_server.join(' · ') || '—'}</strong>
            <span>Detour</span>
            <strong>
              {dnsData.current.detour_enabled
                ? `включён · ${dnsData.current.detour_section ?? 'секция не выбрана'}`
                : 'выключен'}
            </strong>
            <span>Состояние прочитано</span>
            <strong>{formatDate(dnsData.state_collected_at)}</strong>
          </div>
        ) : (
          <Empty>
            Состояние ещё не прочитано. Нажмите «Прочитать состояние» на вкладке «Обзор».
          </Empty>
        )}

        <div className="row">
          <Button
            onClick={props.onStartBenchmark}
            busy={props.dnsBusy}
            disabled={!props.online || props.dnsRunning || !props.agentSupportsDns}
          >
            Проверить DNS
          </Button>
          {props.dnsRunning ? (
            <Button variant="ghost" onClick={props.onCancelBenchmark}>
              Отменить
            </Button>
          ) : null}
        </div>

        {props.dnsRunning ? (
          <JobProgress job={props.dnsJob} label={props.dnsCurrent || 'Проверяем DNS…'} />
        ) : null}

        {props.dnsError ? <ErrorBanner message={props.dnsError} /> : null}
      </Panel>

      {dnsBenchmark ? (
        <Panel
          title="Результаты DNS"
          subtitle={`${dnsBenchmark.results.length} серверов · ${dnsBenchmark.domains.length} доменов · ${dnsBenchmark.rounds} замеров${props.dnsJob?.finished_at ? ` · ${formatDate(props.dnsJob.finished_at)}` : ''}. Показаны только успешные и частичные результаты; фильтрующие DNS помечены.`}
        >
          {dnsBenchmark.results.some((item) => item.suspect) ? (
            <InfoBanner tone="warn">
              UDP-ответы быстрее 5 мс часто означают локальный кэш или перехват DNS
              провайдером. Такие серверы не попадают в рекомендацию по умолчанию, но остаются
              в таблице.
            </InfoBanner>
          ) : null}
          <div className="grid-2 grid-2-compact">
            {(['udp', 'doh'] as const).map((type) => {
              const best = dnsBenchmark.recommendations[type] ?? [];
              return (
                <div className="dns-best" key={type}>
                  <div className="dns-best-head">
                    <strong>Лучший {type === 'udp' ? 'UDP' : 'DoH'}</strong>
                    {best.length > 0 ? (
                      <span className="muted-text small">
                        {best[0]!.median_ms != null ? `${best[0]!.median_ms.toFixed(1)} мс` : '—'}{' '}
                        · потери {best[0]!.loss_pct}%
                      </span>
                    ) : null}
                  </div>
                  {best.length > 0 ? (
                    <>
                      {best.map((item) => (
                        <p key={item.id} className="small">
                          {item.provider} · <span className="mono">{item.address}</span>
                        </p>
                      ))}
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => props.onChoosePair(type, best)}
                      >
                        Выбрать {type === 'udp' ? 'UDP' : 'DoH'}
                      </Button>
                    </>
                  ) : (
                    <p className="muted-text small">
                      Нет подходящих нефильтрующих серверов. Можно выбрать вручную из таблицы.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Сервер</th>
                  <th>Протокол</th>
                  <th>Медиана</th>
                  <th>p95</th>
                  <th>Потери</th>
                  <th>Статус</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {dnsResults.map((item) => (
                  <tr key={item.id}>
                    <td>
                      {item.provider}
                      {item.filtered ? (
                        <span className="badge badge-warn" style={{ marginLeft: 6 }}>
                          фильтрует
                        </span>
                      ) : null}
                      {item.suspect ? (
                        <span className="badge badge-warn" style={{ marginLeft: 6 }}>
                          возможно перехват
                        </span>
                      ) : null}
                      <div className="mono small muted-text">{item.address}</div>
                      {item.error ? (
                        <div className="small muted-text">ошибка: {item.error}</div>
                      ) : null}
                    </td>
                    <td>{item.protocol.toUpperCase()}</td>
                    <td>{item.median_ms != null ? `${item.median_ms.toFixed(1)} мс` : '—'}</td>
                    <td>{item.p95_ms != null ? `${item.p95_ms.toFixed(1)} мс` : '—'}</td>
                    <td>{item.loss_pct}%</td>
                    <td>
                      <StatusBadge
                        status={
                          item.status === 'healthy'
                            ? 'success'
                            : item.status === 'partial'
                              ? 'warning'
                              : 'error'
                        }
                        label={item.status}
                      />
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const sameType = dnsResults
                            .filter(
                              (candidate) =>
                                candidate.protocol === item.protocol && candidate.id !== item.id,
                            )
                            .slice(0, 1);
                          props.onChoosePair(item.protocol, [item, ...sameType]);
                        }}
                      >
                        Выбрать
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}

      {dnsChoice ? (
        <Panel
          title="Выбранный DNS"
          subtitle="Перед применением будет показан diff, создан снимок и запрошено подтверждение."
        >
          <div className="kv">
            <span>Тип</span>
            <strong>{dnsChoice.type.toUpperCase()}</strong>
            <span>Основной список</span>
            <strong>{dnsChoice.servers.join(' · ')}</strong>
            <span>Bootstrap</span>
            <strong>{props.dnsBootstrap.join(' · ') || '—'}</strong>
          </div>
          {!props.dnsCanApply ? (
            <InfoBanner tone="warn">
              Применение сейчас недоступно: проверьте предупреждения выше, состояние роутера,
              шаблон и detour.
            </InfoBanner>
          ) : null}
          <Button onClick={() => props.onApplyOpenChange(true)} disabled={!props.dnsCanApply}>
            Применить DNS
          </Button>
        </Panel>
      ) : null}

      {props.dnsApplyOpen && props.dnsProposal ? (
        <DnsApplyModal
          routerId={props.routerId}
          proposal={props.dnsProposal}
          onClose={() => props.onApplyOpenChange(false)}
          onApplied={props.onApplied}
        />
      ) : null}
    </div>
  );
}
