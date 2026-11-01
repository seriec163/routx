import { useEffect, useMemo, useState } from 'react';
import { Link } from '../components/link';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBanner,
  Field,
  InfoBanner,
  Modal,
  PageHeader,
  Panel,
  ProgressBar,
  Select,
  Spinner,
  StatusBadge,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate, formatRelative } from '../lib/format';
import { navigate } from '../lib/router';
import type { Rollout, RolloutDetail, RouterRecord, SingBoxVersion } from '../lib/types';
import { useApi } from '../lib/useApi';
import { useSession } from '../session';

const VARIANTS = [
  { id: 'tiny', label: 'Tiny', hint: 'Минимальный пакет, меньше всего места' },
  { id: 'extended', label: 'Extended', hint: 'Расширенная сборка: XHTTP и дополнительные протоколы' },
  {
    id: 'extended_compressed',
    label: 'Extended compressed',
    hint: 'Extended со сжатым бинарником, экономит место',
  },
  { id: 'stable', label: 'Stable', hint: 'Обычная стабильная сборка из пакетного репозитория' },
] as const;

const VARIANT_LABEL: Record<string, string> = Object.fromEntries(
  VARIANTS.map((variant) => [variant.id, variant.label]),
);

const ROLLOUT_STATUS: Record<string, string> = {
  draft: 'Черновик',
  running: 'Идёт',
  paused: 'Пауза',
  completed: 'Завершён',
  cancelled: 'Отменён',
  failed: 'Ошибка',
};

const TARGET_STATUS: Record<string, string> = {
  pending: 'Ожидает',
  installing: 'Устанавливается',
  verifying: 'Проверка',
  success: 'Успешно',
  failed: 'Ошибка',
  skipped: 'Пропущен',
  rolled_back: 'Откат',
};

const STAGE_TITLE: Record<number, string> = {
  1: 'Проверочный роутер',
  2: 'Первая волна',
  3: 'Остальные роутеры',
};

function variantLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return VARIANT_LABEL[value] ?? value;
}

function versionLabel(rollout: { version_tag?: string | null }): string {
  return rollout.version_tag ? rollout.version_tag : 'последняя версия';
}

function stageCounts(total: number): [number, number, number] {
  if (total <= 0) return [0, 0, 0];
  const canary = 1;
  const secondEnd = Math.min(total, Math.max(canary + 1, Math.ceil(total * 0.25)));
  return [canary, secondEnd - canary, total - secondEnd];
}

export function RolloutsPage() {
  const toast = useToast();
  const { me } = useSession();
  const isAdmin = me?.permissions.is_superadmin === true;
  const rollouts = useApi<{ items: Rollout[] }>('/api/v1/rollouts');
  const routers = useApi<{ items: RouterRecord[] }>(isAdmin ? '/api/v1/routers?limit=200' : null);

  const [createOpen, setCreateOpen] = useState(false);
  const [variant, setVariant] = useState<(typeof VARIANTS)[number]['id']>('tiny');
  const [versionTag, setVersionTag] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const versions = useApi<{ items: SingBoxVersion[] }>(
    isAdmin && createOpen && variant === 'extended'
      ? '/api/v1/singbox/versions?product=sing-box-extended&stable_only=true'
      : null,
  );

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ rollout_id: string; targets: number }>('/api/v1/rollouts', {
        method: 'POST',
        body: {
          variant,
          ...(variant === 'extended' && versionTag ? { version_tag: versionTag } : {}),
          ...(selected.length > 0 ? { router_ids: selected } : {}),
        },
      });
      toast.success(`Кампания создана: ${result.targets} роутер(ов)`);
      setCreateOpen(false);
      navigate(`/rollouts/${result.rollout_id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const eligible = (routers.data?.items ?? []).filter(
    (router) => router.status === 'online' || router.status === 'offline',
  );

  function openCreate(): void {
    const counts = new Map<string, number>();
    for (const router of eligible) {
      const current =
        router.sing_box_variant && VARIANTS.some((variant) => variant.id === router.sing_box_variant)
          ? router.sing_box_variant
          : 'tiny';
      counts.set(current, (counts.get(current) ?? 0) + 1);
    }
    let best = 'tiny';
    let bestCount = 0;
    for (const [id, count] of counts) {
      if (count > bestCount) {
        best = id;
        bestCount = count;
      }
    }
    setVariant(best as (typeof VARIANTS)[number]['id']);
    setVersionTag('');
    setSelected([]);
    setError(null);
    setCreateOpen(true);
  }

  const previewTotal = selected.length > 0 ? selected.length : eligible.length;
  const [canary, firstWave, rest] = stageCounts(previewTotal);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Staged rollout"
        title="Поэтапное обновление sing-box"
        subtitle="Безопасное обновление сразу на нескольких роутерах: сначала один проверочный, затем первая волна, затем остальные. Между волнами кампания ждёт вашего подтверждения."
        actions={
          isAdmin ? <Button onClick={() => openCreate()}>Новое обновление</Button> : undefined
        }
      />

      {rollouts.error ? (
        <ErrorBanner message={rollouts.error} onRetry={() => void rollouts.reload()} />
      ) : null}

      <Panel title="Что это такое">
        <p className="page-sub">
          Обычно sing-box обновляют на одном роутере. Staged rollout нужен, когда роутеров несколько:
          он не трогает все сразу, а идёт волнами. Если что-то пошло не так на проверочном роутере,
          остальные остаются на старой версии.
        </p>
        <ol className="steps">
          <li>
            <strong>Проверочный роутер.</strong> Обновляется один роутер. Вы проверяете, что прокси и
            интернет работают.
          </li>
          <li>
            <strong>Первая волна.</strong> После вашего подтверждения обновляется примерно четверть
            оставшихся роутеров.
          </li>
          <li>
            <strong>Остальные.</strong> Последнее подтверждение — и обновляются все оставшиеся.
          </li>
        </ol>
        <p className="muted-text small">
          Если роутер один, эта страница не нужна: обновите sing-box во вкладке «sing-box» на
          странице роутера. Ошибка на любой волне останавливает кампанию; уже обновлённые роутеры
          автоматически не откатываются.
        </p>
      </Panel>

      <Panel
        title="Кампании"
        actions={
          <Button variant="ghost" size="sm" onClick={() => void rollouts.reload()} busy={rollouts.loading}>
            Обновить
          </Button>
        }
      >
        {rollouts.loading && !rollouts.data ? (
          <Spinner />
        ) : (rollouts.data?.items.length ?? 0) === 0 ? (
          <Empty>
            Кампаний пока нет. Нажмите «Новое обновление», чтобы обновить sing-box волнами.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Вариант</th>
                  <th>Версия</th>
                  <th>Статус</th>
                  <th>Волна</th>
                  <th>Готово</th>
                  <th>Создана</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rollouts.data!.items.map((rollout) => (
                  <tr key={rollout.id}>
                    <td>{variantLabel(rollout.variant)}</td>
                    <td className="mono small">{versionLabel(rollout)}</td>
                    <td>
                      <StatusBadge
                        status={rollout.status}
                        label={ROLLOUT_STATUS[rollout.status] ?? rollout.status}
                      />
                    </td>
                    <td>{rollout.stage === 0 ? '—' : rollout.stage}</td>
                    <td>
                      {rollout.succeeded}/{rollout.targets}
                    </td>
                    <td className="muted-text small">{formatDate(rollout.created_at)}</td>
                    <td>
                      <Link className="btn btn-ghost btn-sm" to={`/rollouts/${rollout.id}`}>
                        Открыть
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {createOpen ? (
        <Modal
          title="Новое поэтапное обновление"
          wide
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={busy}>
                Отмена
              </Button>
              <Button onClick={() => void create()} busy={busy} disabled={eligible.length === 0}>
                Создать кампанию
              </Button>
            </>
          }
        >
          {error ? <ErrorBanner message={error} /> : null}

          <Field label="Что обновляем" hint="Один вариант для всех роутеров кампании.">
            <Select
              value={variant}
              onChange={(value) => {
                setVariant(value as (typeof VARIANTS)[number]['id']);
                setVersionTag('');
              }}
            >
              {VARIANTS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} — {item.hint}
                </option>
              ))}
            </Select>
          </Field>

          {variant === 'extended' ? (
            <Field
              label="Версия Extended"
              hint="Можно оставить «последняя версия» или выбрать конкретную из каталога."
            >
              <Select value={versionTag} onChange={setVersionTag}>
                <option value="">Последняя версия</option>
                {(versions.data?.items ?? []).map((item) => (
                  <option key={item.tag} value={item.tag}>
                    {item.tag}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <InfoBanner>
              Для варианта {variantLabel(variant)} ставится последняя версия из пакетного
              репозитория Prokop/Forkop. Выбрать конкретную версию можно только для Extended.
            </InfoBanner>
          )}

          <Field label="Роутеры" hint="Если ничего не выбрать, кампания охватит все подходящие.">
            <div className="checklist">
              {eligible.length === 0 ? (
                <p className="muted-text">Нет роутеров в сети или офлайн-состоянии.</p>
              ) : null}
              {eligible.map((router) => (
                <label key={router.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={selected.includes(router.id)}
                    onChange={() =>
                      setSelected((current) =>
                        current.includes(router.id)
                          ? current.filter((value) => value !== router.id)
                          : [...current, router.id],
                      )
                    }
                  />
                  <span>{router.name}</span>
                  <span className="muted-text small">
                    {router.status === 'online' ? 'в сети' : 'офлайн'} ·{' '}
                    {router.sing_box_variant ? `${variantLabel(router.sing_box_variant)} ` : ''}
                    {router.sing_box_version ?? 'sing-box не установлен'}
                  </span>
                </label>
              ))}
            </div>
          </Field>

          <Field label="Как пройдут волны">
            <div className="kv">
              <span>1. Проверочный</span>
              <strong>{canary} роутер(ов)</strong>
              <span>2. Первая волна</span>
              <strong>{firstWave} роутер(ов)</strong>
              <span>3. Остальные</span>
              <strong>{rest} роутер(ов)</strong>
            </div>
          </Field>

          {previewTotal <= 1 ? (
            <InfoBanner tone="warn">
              Выбран один роутер. Поэтапность не даст выигрыша — обновите его на странице роутера
              во вкладке «sing-box». Если всё же создать кампанию, она будет состоять из одной
              проверочной волны.
            </InfoBanner>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

export function RolloutDetailPage({ id }: { id: string }) {
  const toast = useToast();
  const { me } = useSession();
  const isAdmin = me?.permissions.is_superadmin === true;
  const detail = useApi<RolloutDetail>(`/api/v1/rollouts/${id}`);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const rollout = detail.data?.rollout;
  const targets = detail.data?.targets ?? [];

  useEffect(() => {
    if (!rollout || (rollout.status !== 'running' && rollout.status !== 'paused')) return;
    const timer = window.setInterval(() => void detail.reload(), 5_000);
    return () => window.clearInterval(timer);
  }, [rollout?.status, detail.reload]);

  const stages = useMemo(() => {
    const map = new Map<number, RolloutDetail['targets']>();
    for (const target of targets) {
      const list = map.get(target.stage) ?? [];
      list.push(target);
      map.set(target.stage, list);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [targets]);

  const currentTargets = targets.filter((target) => target.stage === rollout?.stage);
  const currentPending = currentTargets.filter(
    (target) => target.status !== 'success' && target.status !== 'skipped',
  ).length;
  const currentFailed = currentTargets.filter((target) => target.status === 'failed').length;
  const currentDone = currentTargets.filter(
    (target) => target.status === 'success' || target.status === 'skipped',
  ).length;

  async function action(path: string, body?: unknown): Promise<void> {
    setBusy(true);
    try {
      await api(path, { method: 'POST', body });
      toast.success('Готово');
      await detail.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (detail.loading && !detail.data) return <Spinner />;
  if (detail.error && !detail.data) {
    return <ErrorBanner message={detail.error} onRetry={() => void detail.reload()} />;
  }
  if (!rollout) return <Empty>Кампания не найдена.</Empty>;

  const canStart = isAdmin && rollout.status === 'draft';
  const canAdvance =
    isAdmin &&
    rollout.status === 'running' &&
    currentPending === 0 &&
    currentFailed === 0;
  const canPause = isAdmin && rollout.status === 'running';
  const canResume = isAdmin && rollout.status === 'paused';
  const canCancel =
    isAdmin && rollout.status !== 'completed' && rollout.status !== 'cancelled';

  const stageHint = (() => {
    if (rollout.status === 'draft') {
      return 'Кампания создана. Нажмите «Запустить проверочный этап» — обновится один роутер.';
    }
    if (rollout.status === 'completed') {
      return 'Кампания завершена: все волны прошли успешно.';
    }
    if (rollout.status === 'cancelled') {
      return 'Кампания отменена. Уже установленные версии остались на роутерах.';
    }
    if (rollout.status === 'failed') {
      return 'Кампания остановлена из-за ошибки. Исправьте роутер и создайте новое обновление.';
    }
    if (currentFailed > 0) {
      return 'На текущей волне есть ошибка. Исправьте роутер и создайте новое обновление.';
    }
    if (currentPending > 0) {
      return `Текущая волна ещё выполняется: осталось ${currentPending}. Кнопка «Следующая волна» станет доступна после завершения.`;
    }
    return `Волна ${rollout.stage} завершена. Проверьте прокси на роутерах и запустите следующую волну.`;
  })();

  return (
    <div className="page">
      <PageHeader
        eyebrow="Поэтапное обновление"
        title={`sing-box ${variantLabel(rollout.variant)} · ${versionLabel(rollout)}`}
        subtitle={`Статус: ${ROLLOUT_STATUS[rollout.status] ?? rollout.status} · волна ${rollout.stage || '—'} · создана ${formatDate(rollout.created_at)}`}
        actions={
          <>
            <Link className="btn btn-ghost" to="/rollouts">
              К списку
            </Link>
            {canStart ? (
              <Button onClick={() => void action(`/api/v1/rollouts/${id}/start`)} busy={busy}>
                Запустить проверочный этап
              </Button>
            ) : null}
            {canPause ? (
              <Button
                variant="subtle"
                onClick={() => void action(`/api/v1/rollouts/${id}/pause`)}
                busy={busy}
              >
                Приостановить
              </Button>
            ) : null}
            {canResume ? (
              <Button onClick={() => void action(`/api/v1/rollouts/${id}/resume`)} busy={busy}>
                Продолжить
              </Button>
            ) : null}
            {canAdvance ? (
              <Button onClick={() => void action(`/api/v1/rollouts/${id}/advance`)} busy={busy}>
                Следующая волна
              </Button>
            ) : null}
            {canCancel ? (
              <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                Отменить
              </Button>
            ) : null}
          </>
        }
      />

      <InfoBanner tone={rollout.status === 'failed' || currentFailed > 0 ? 'warn' : 'info'}>
        {stageHint}
      </InfoBanner>

      <Panel
        title={
          rollout.stage > 0
            ? `Волна ${rollout.stage}${STAGE_TITLE[rollout.stage] ? ` · ${STAGE_TITLE[rollout.stage]}` : ''}`
            : 'План волн'
        }
        subtitle="Внутри волны все роутеры обновляются параллельно. Следующая волна не начнётся сама."
      >
        {rollout.stage > 0 && currentTargets.length > 0 ? (
          <div className="job-progress">
            <div className="job-progress-head">
              <span>Текущая волна {rollout.stage}</span>
              <span className="muted-text small">
                {currentDone}/{currentTargets.length} готово
              </span>
            </div>
            <ProgressBar
              value={Math.round((currentDone / currentTargets.length) * 100)}
              label="Прогресс текущей волны"
            />
          </div>
        ) : null}
        {stages.length === 0 ? (
          <Empty>Целей нет.</Empty>
        ) : (
          <div className="stack">
            {stages.map(([stage, list]) => (
              <div key={stage}>
                <h3>
                  Волна {stage}
                  {STAGE_TITLE[stage] ? ` · ${STAGE_TITLE[stage]}` : ''}{' '}
                  <span className="muted-text small">
                    {list.filter((item) => item.status === 'success').length}/{list.length} успешно
                  </span>
                </h3>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Роутер</th>
                      <th>Статус</th>
                      <th>Было</th>
                      <th>Стало</th>
                      <th>Завершено</th>
                      <th>Ошибка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((target) => (
                      <tr key={target.router_id}>
                        <td>
                          <Link to={`/routers/${target.router_id}`}>{target.router_name}</Link>
                        </td>
                        <td>
                          <StatusBadge
                            status={target.status}
                            label={TARGET_STATUS[target.status] ?? target.status}
                          />
                        </td>
                        <td className="small">{target.previous_version ?? '—'}</td>
                        <td className="small">{target.sing_box_version ?? '—'}</td>
                        <td className="muted-text small">
                          {target.finished_at ? formatRelative(target.finished_at) : '—'}
                        </td>
                        <td className="small">{target.error_code ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Как управлять кампанией">
        <ol className="steps">
          <li>
            <strong>Черновик.</strong> Нажмите «Запустить проверочный этап». Обновится один роутер.
          </li>
          <li>
            <strong>Проверка.</strong> Убедитесь, что на этом роутере работает интернет и прокси.
            Затем нажмите «Следующая волна».
          </li>
          <li>
            <strong>Первая волна и остальные.</strong> Повторите проверку после каждой волны.
          </li>
          <li>
            <strong>Пауза.</strong> Запрещает запуск новых волн, но не останавливает уже начатые
            установки. «Продолжить» снимает паузу.
          </li>
          <li>
            <strong>Отмена.</strong> Отменяет ожидающие задачи. Уже установленные версии не
            откатываются.
          </li>
        </ol>
      </Panel>

      {confirmCancel ? (
        <ConfirmDialog
          title="Отменить кампанию?"
          danger
          busy={busy}
          confirmLabel="Отменить кампанию"
          onCancel={() => setConfirmCancel(false)}
          onConfirm={async () => {
            await action(`/api/v1/rollouts/${id}/cancel`);
            setConfirmCancel(false);
          }}
          message={
            <p>
              Ожидающие задачи будут отменены. Уже установленные версии не откатываются
              автоматически.
            </p>
          }
        />
      ) : null}
    </div>
  );
}
