import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '../components/link';
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  InfoBanner,
  PageHeader,
  Select,
  Spinner,
  StatusBadge,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { PRODUCT_LABEL, ROUTER_STATUS } from '../lib/format';
import { navigate } from '../lib/router';
import type {
  ApplyRunDetail,
  BindingToken,
  CatalogSubscription,
  DiagnosticReportDetail,
  Job,
  RouterRecord,
  TemplateListItem,
  UserRow,
} from '../lib/types';
import { useApi } from '../lib/useApi';
import { useSession } from '../session';

type Step = 1 | 2 | 3 | 4;
type PipelineKey = 'subscription' | 'template' | 'access' | 'diagnostics';
type ItemStatus = 'pending' | 'running' | 'success' | 'skipped' | 'error';

interface PipelineItem {
  status: ItemStatus;
  detail: string;
}

interface AccessResult {
  ok: boolean;
  target: string;
  proxy_tag: string;
  group: string;
  latency_ms: number | null;
}

const STEPS: Array<{ id: Step; title: string; hint: string }> = [
  { id: 1, title: 'Имя и владелец', hint: 'Как называть роутер' },
  { id: 2, title: 'Подключение', hint: 'Одна команда по SSH' },
  { id: 3, title: 'Подписка и шаблон', hint: 'Что включить' },
  { id: 4, title: 'Проверка', hint: 'Сайт и диагностика' },
];

const ACCESS_TARGET = 'https://www.youtube.com/generate_204';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitJob(id: string, timeoutMs = 240_000): Promise<Job> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await api<{ job: Job }>(`/api/v1/jobs/${id}`);
    if (['success', 'failed', 'cancelled', 'timeout'].includes(payload.job.status)) {
      if (payload.job.status !== 'success') {
        throw new Error(payload.job.error?.message ?? `Задача завершилась: ${payload.job.status}`);
      }
      return payload.job;
    }
    await sleep(1500);
  }
  throw new Error('Не дождались выполнения задачи');
}

function toneOf(state: string | undefined): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (state === 'ok' || state === 'success') return 'ok';
  if (state === 'warning' || state === 'warn' || state === 'degraded') return 'warn';
  if (state === 'error' || state === 'failed') return 'bad';
  return 'neutral';
}

export function RouterOnboardingPage() {
  const { me } = useSession();
  const toast = useToast();
  const isAdmin = me?.permissions.is_superadmin === true;
  const users = useApi<{ items: UserRow[] }>(isAdmin ? '/api/v1/users' : null);
  const templates = useApi<{ items: TemplateListItem[] }>('/api/v1/templates');

  const [step, setStep] = useState<Step>(1);
  const subscriptions = useApi<{ items: CatalogSubscription[] }>(
    step === 3 ? '/api/v1/subscriptions' : null,
  );
  const [name, setName] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [router, setRouter] = useState<RouterRecord | null>(null);
  const [liveRouter, setLiveRouter] = useState<RouterRecord | null>(null);
  const [token, setToken] = useState<BindingToken | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const advanced = useRef(false);

  const [subscription, setSubscription] = useState('');
  const [catalogId, setCatalogId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [applyTemplate, setApplyTemplate] = useState(true);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);

  const [pipeline, setPipeline] = useState<Record<PipelineKey, PipelineItem>>({
    subscription: { status: 'skipped', detail: 'Подписка не указана' },
    template: { status: 'skipped', detail: 'Шаблон не выбран' },
    access: { status: 'pending', detail: 'Ждёт предыдущих шагов' },
    diagnostics: { status: 'pending', detail: 'Ждёт предыдущих шагов' },
  });
  const [running, setRunning] = useState(false);
  const [pipelineStarted, setPipelineStarted] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [access, setAccess] = useState<AccessResult | null>(null);
  const [report, setReport] = useState<DiagnosticReportDetail | null>(null);

  // Часы для обратного отсчёта токена.
  useEffect(() => {
    if (step !== 2) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  // Ждём, пока установленный агент выйдет на связь.
  useEffect(() => {
    if (step !== 2 || !router) return;
    let cancelled = false;

    async function tick() {
      try {
        const data = await api<{ router: RouterRecord }>(`/api/v1/routers/${router!.id}`);
        if (cancelled) return;
        setLiveRouter(data.router);
        if (data.router.status === 'online' && !advanced.current) {
          advanced.current = true;
          window.setTimeout(() => {
            if (!cancelled) setStep(3);
          }, 900);
        }
      } catch {
        // Сеть могла моргнуть — следующий тик повторит.
      }
    }

    void tick();
    const timer = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [step, router]);

  // Узнаём текущее состояние автозапуска на шаге 3.
  useEffect(() => {
    if (step !== 3 || !router) return;
    let cancelled = false;
    api<{
      router: RouterRecord;
      state: { service?: Record<string, { enabled?: number }> } | null;
    }>(`/api/v1/routers/${router.id}`)
      .then((data) => {
        if (cancelled) return;
        const key = data.router.product || liveRouter?.product || 'prokop';
        const service = data.state?.service?.[key];
        // Prokop/Forkop сами запускают sing-box и отключают его отдельный
        // автозапуск, поэтому автозапуск пары — это автозапуск продукта.
        setAutostart(service ? service.enabled === 1 : null);
      })
      .catch(() => {
        if (!cancelled) setAutostart(null);
      });
    return () => {
      cancelled = true;
    };
  }, [step, router, liveRouter?.product]);

  const templatesList = templates.data?.items ?? [];
  const catalogList = subscriptions.data?.items ?? [];
  const selectedCatalog = catalogList.find((item) => item.id === catalogId) ?? null;
  const selectedTemplate = templatesList.find((item) => item.id === templateId) ?? null;

  const tokenLeft = token
    ? Math.max(0, Math.floor((new Date(token.expires_at).getTime() - now) / 1000))
    : 0;
  const tokenExpired = Boolean(token) && tokenLeft <= 0;

  const summary = useMemo(() => {
    const payload = report?.payload;
    const checks =
      payload && typeof payload === 'object' && Array.isArray((payload as { checks?: unknown }).checks)
        ? ((payload as { checks: Array<{ name?: string; state?: string; details?: string }> }).checks ?? [])
        : [];
    const counts = { ok: 0, warn: 0, bad: 0 };
    const warnings: Array<{ name: string; state: string; details: string }> = [];
    for (const check of checks) {
      const tone = toneOf(check.state);
      if (tone === 'ok') counts.ok += 1;
      else if (tone === 'warn') {
        counts.warn += 1;
        warnings.push({ name: check.name ?? 'проверка', state: 'warning', details: check.details ?? '' });
      } else if (tone === 'bad') {
        counts.bad += 1;
        warnings.push({ name: check.name ?? 'проверка', state: 'error', details: check.details ?? '' });
      }
    }
    return { total: checks.length, counts, warnings: warnings.slice(0, 4) };
  }, [report]);

  const allDone =
    pipelineStarted &&
    !running &&
    ['subscription', 'template', 'access', 'diagnostics'].every(
      (key) => pipeline[key as PipelineKey].status !== 'running' &&
        pipeline[key as PipelineKey].status !== 'pending',
    );
  const hasRowErrors = (Object.keys(pipeline) as PipelineKey[]).some(
    (key) => pipeline[key].status === 'error',
  );
  const hasProblems = Boolean(pipelineError) || hasRowErrors;

  function setItem(key: PipelineKey, status: ItemStatus, detail: string): void {
    setPipeline((current) => ({ ...current, [key]: { status, detail } }));
  }

  async function issueToken(routerId: string): Promise<void> {
    setTokenBusy(true);
    setTokenError(null);
    try {
      const value = await api<BindingToken>(`/api/v1/routers/${routerId}/binding-token`, {
        method: 'POST',
      });
      setToken(value);
      advanced.current = false;
    } catch (caught) {
      setTokenError(errorMessage(caught));
    } finally {
      setTokenBusy(false);
    }
  }

  async function createRouter(): Promise<void> {
    if (!name.trim()) return;
    setCreating(true);
    setFormError(null);
    try {
      const body: Record<string, unknown> = { name: name.trim() };
      if (isAdmin && ownerId) body.owner_id = ownerId;
      const created = await api<{ router: RouterRecord }>('/api/v1/routers', {
        method: 'POST',
        body,
      });
      setRouter(created.router);
      setLiveRouter(created.router);
      advanced.current = false;
      setStep(2);
      await issueToken(created.router.id);
    } catch (caught) {
      setFormError(errorMessage(caught));
    } finally {
      setCreating(false);
    }
  }

  function continueFromStep3(): void {
    if (!router) return;
    const value = subscription.trim();
    if (!catalogId && value !== '' && !/^https?:\/\/\S+$/i.test(value)) {
      setFormError('Ссылка на подписку должна начинаться с http:// или https://');
      return;
    }
    setFormError(null);
    setStep(4);
    setPipelineStarted(true);
    void runPipeline(router.id, value, catalogId, templateId, applyTemplate);
  }

  async function enableAutostart(): Promise<void> {
    if (!router) return;
    setAutostartBusy(true);
    try {
      const response = await api<{ job: Job }>(`/api/v1/routers/${router.id}/service`, {
        method: 'POST',
        body: { action: 'enable' },
      });
      await waitJob(response.job.id, 90_000);
      setAutostart(true);
      toast.success('Автозапуск включён');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setAutostartBusy(false);
    }
  }

  async function runPipeline(
    routerId: string,
    subscriptionValue: string,
    chosenCatalogId: string,
    chosenTemplateId: string,
    applyNow: boolean,
  ): Promise<void> {
    setRunning(true);
    setPipelineError(null);
    setAccess(null);
    setReport(null);
    setPipeline({
      subscription: subscriptionValue || chosenCatalogId
        ? { status: 'pending', detail: 'Ожидает' }
        : { status: 'skipped', detail: 'Подписка не указана' },
      template: chosenTemplateId
        ? { status: 'pending', detail: 'Ожидает' }
        : { status: 'skipped', detail: 'Шаблон не выбран' },
      access: { status: 'pending', detail: 'Ожидает' },
      diagnostics: { status: 'pending', detail: 'Ожидает' },
    });

    let firstError: string | null = null;

    if (subscriptionValue || chosenCatalogId) {
      setItem(
        'subscription',
        'running',
        chosenCatalogId ? 'Добавляем подписку из каталога…' : 'Сохраняем и применяем подписку…',
      );
      try {
        const body = chosenCatalogId
          ? { kind: 'subscription', subscription_id: chosenCatalogId }
          : { kind: 'subscription', label: 'Подписка', value: subscriptionValue };
        const response = await api<{ job: Job }>(`/api/v1/routers/${routerId}/connections`, {
          method: 'POST',
          body,
        });
        await waitJob(response.job.id, 300_000);
        setItem(
          'subscription',
          'success',
          chosenCatalogId ? 'Подписка из каталога добавлена' : 'Подписка сохранена и применена',
        );
      } catch (caught) {
        const message = errorMessage(caught);
        setItem('subscription', 'error', message);
        firstError = firstError ?? message;
      }
    }

    if (chosenTemplateId) {
      setItem('template', 'running', 'Назначаем шаблон…');
      try {
        await api(`/api/v1/routers/${routerId}/templates/${chosenTemplateId}`, {
          method: 'PUT',
          body: {},
        });

        if (!applyNow) {
          setItem('template', 'success', 'Шаблон назначен, применение отключено');
        } else {
          setItem('template', 'running', 'Сравниваем шаблон с роутером…');
          const diff = await api<{ job: Job }>(`/api/v1/routers/${routerId}/diff`, {
            method: 'POST',
            body: { template_id: chosenTemplateId },
          });
          const diffJob = await waitJob(diff.job.id, 180_000);
          const applyRunId =
            typeof diffJob.result?.apply_run_id === 'string' ? diffJob.result.apply_run_id : null;
          if (!applyRunId) throw new Error('Сервер не вернул результат сравнения');

          const detail = await api<ApplyRunDetail>(`/api/v1/apply-runs/${applyRunId}`);
          const items = detail.items?.length ?? 0;
          const sectionMap = detail.apply_run.section_map ?? {};
          const mapText =
            Object.keys(sectionMap).length > 0
              ? ` · ${Object.entries(sectionMap)
                  .map(([from, to]) => `${from} → ${to}`)
                  .join(', ')}`
              : '';
          if (items === 0) {
            setItem('template', 'success', `Изменений нет — шаблон уже соответствует${mapText}`);
          } else {
            setItem('template', 'running', `Применяем ${items} изменений со снимком${mapText}…`);
            const confirm = await api<{ job: Job }>(
              `/api/v1/apply-runs/${applyRunId}/confirm`,
              {
                method: 'POST',
                body: { diff_hash: detail.apply_run.diff_hash },
              },
            );
            await waitJob(confirm.job.id, 300_000);
            setItem('template', 'success', `Шаблон применён: ${items} изменений${mapText}`);
          }
        }
      } catch (caught) {
        const message = errorMessage(caught);
        setItem('template', 'error', message);
        firstError = firstError ?? message;
      }
    }

    setItem('access', 'running', 'Запрашиваем заблокированный сайт через прокси…');
    try {
      const response = await api<{ job: Job }>(`/api/v1/routers/${routerId}/access-check`, {
        method: 'POST',
        body: { target: ACCESS_TARGET },
      });
      const job = await waitJob(response.job.id, 120_000);
      const result = job.result as unknown as AccessResult;
      setAccess(result);
      setItem(
        'access',
        'success',
        `${result.proxy_tag || 'прокси'} · ${result.latency_ms ?? '—'} мс`,
      );
    } catch (caught) {
      const message = errorMessage(caught);
      setItem('access', 'error', message);
      firstError = firstError ?? message;
    }

    setItem('diagnostics', 'running', 'Собираем быструю диагностику…');
    try {
      const response = await api<{ jobs: Job[] }>('/api/v1/diagnostics', {
        method: 'POST',
        body: { router_ids: [routerId], kind: 'quick' },
      });
      const job = await waitJob(response.jobs[0]!.id, 180_000);
      const reportId = typeof job.result?.report_id === 'string' ? job.result.report_id : '';
      if (!reportId) throw new Error('Диагностика не вернула отчёт');
      const detail = await api<{ report: DiagnosticReportDetail }>(
        `/api/v1/diagnostics/${reportId}`,
      );
      setReport(detail.report);
      setItem('diagnostics', 'success', 'Краткая сводка готова');
    } catch (caught) {
      const message = errorMessage(caught);
      setItem('diagnostics', 'error', message);
      firstError = firstError ?? message;
    }

    setPipelineError(firstError);
    setRunning(false);
  }

  function retryChecks(): void {
    if (!router) return;
    setPipeline((current) => ({
      ...current,
      access: { status: 'pending', detail: 'Ожидает' },
      diagnostics: { status: 'pending', detail: 'Ожидает' },
    }));
    void runChecksOnly(router.id);
  }

  async function runChecksOnly(routerId: string): Promise<void> {
    setRunning(true);
    setPipelineError(null);
    setAccess(null);
    setReport(null);
    let firstError: string | null = null;

    setItem('access', 'running', 'Запрашиваем заблокированный сайт через прокси…');
    try {
      const response = await api<{ job: Job }>(`/api/v1/routers/${routerId}/access-check`, {
        method: 'POST',
        body: { target: ACCESS_TARGET },
      });
      const job = await waitJob(response.job.id, 120_000);
      const result = job.result as unknown as AccessResult;
      setAccess(result);
      setItem('access', 'success', `${result.proxy_tag || 'прокси'} · ${result.latency_ms ?? '—'} мс`);
    } catch (caught) {
      const message = errorMessage(caught);
      setItem('access', 'error', message);
      firstError = message;
    }

    setItem('diagnostics', 'running', 'Собираем быструю диагностику…');
    try {
      const response = await api<{ jobs: Job[] }>('/api/v1/diagnostics', {
        method: 'POST',
        body: { router_ids: [routerId], kind: 'quick' },
      });
      const job = await waitJob(response.jobs[0]!.id, 180_000);
      const reportId = typeof job.result?.report_id === 'string' ? job.result.report_id : '';
      if (!reportId) throw new Error('Диагностика не вернула отчёт');
      const detail = await api<{ report: DiagnosticReportDetail }>(
        `/api/v1/diagnostics/${reportId}`,
      );
      setReport(detail.report);
      setItem('diagnostics', 'success', 'Краткая сводка готова');
    } catch (caught) {
      const message = errorMessage(caught);
      setItem('diagnostics', 'error', message);
      firstError = firstError ?? message;
    }

    setPipelineError(firstError);
    setRunning(false);
  }

  const liveStatus = liveRouter?.status ?? router?.status ?? 'pending';
  const online = liveStatus === 'online';

  return (
    <div className="page">
      <PageHeader
        eyebrow="Новый роутер"
        title="Добавить роутер"
        subtitle={
          router
            ? `Роутер «${router.name}» · четыре шага: имя, подключение, подписка и шаблон, проверка.`
            : 'Четыре шага: имя, подключение, подписка и шаблон, проверка.'
        }
      />

      <div className="onb-steps">
        {STEPS.map((item) => {
          const done = step > item.id || (item.id === 2 && online && step >= 3);
          const active = step === item.id;
          return (
            <div
              key={item.id}
              className={`onb-step${active ? ' onb-step-active' : ''}${done ? ' onb-step-done' : ''}`}
            >
              <span className="onb-step-num">{done ? '✓' : item.id}</span>
              <div>
                <strong>{item.title}</strong>
                <span>{item.hint}</span>
              </div>
            </div>
          );
        })}
      </div>

      {step === 1 ? (
        <div className="onb-card">
          <div className="onb-hero">
            <span className="onb-hero-icon">1</span>
            <div>
              <h2>Как назовём роутер?</h2>
              <p>Имя увидите только вы и другие пользователи панели.</p>
            </div>
          </div>
          {formError ? <ErrorBanner message={formError} /> : null}
          <Field label="Имя роутера" hint="Например: «Дом», «Дача» или «Офис 3 этаж»">
            <TextInput value={name} onChange={setName} placeholder="Дом" required />
          </Field>
          {isAdmin ? (
            <Field label="Владелец" hint="По умолчанию роутер принадлежит вам.">
              <Select value={ownerId} onChange={setOwnerId}>
                <option value="">Я ({me?.user.email})</option>
                {(users.data?.items ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.email}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <div className="onb-actions">
            <Button onClick={() => void createRouter()} busy={creating} disabled={!name.trim()}>
              Создать и перейти к установке
            </Button>
            <Link className="btn btn-ghost" to="/routers">
              Отмена
            </Link>
          </div>
          <p className="muted-text small" style={{ marginTop: 10 }}>
            После создания роутер появится во вкладке «Ожидают». В «Активные» он перейдёт
            автоматически после привязки агента.
          </p>
        </div>
      ) : null}

      {step === 2 && router ? (
        <div className="onb-card">
          <div className="onb-hero">
            <span className="onb-hero-icon">2</span>
            <div>
              <h2>Подключите роутер по SSH</h2>
              <p>Одна команда установит агент RoutX и дождётся привязки.</p>
            </div>
          </div>

          <ol className="onb-instruction">
            <li>
              Подключитесь к роутеру по SSH. Обычно адрес — <code>192.168.1.1</code>:
              <pre className="onb-code">ssh root@192.168.1.1</pre>
            </li>
            <li>
              Вставьте команду целиком и нажмите Enter:
              {token ? (
                <>
                  <pre className="onb-code">{token.install_command}</pre>
                  <div className="onb-inline-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        void copyText(token.install_command).then((ok) =>
                          ok
                            ? toast.success('Команда скопирована')
                            : toast.error('Не удалось скопировать команду'),
                        );
                      }}
                    >
                      Скопировать команду
                    </Button>
                    <span className="muted-text small">
                      {tokenExpired
                        ? 'Срок действия команды истёк'
                        : `Команда действует ещё ${Math.floor(tokenLeft / 60)}:${String(tokenLeft % 60).padStart(2, '0')}`}
                    </span>
                  </div>
                </>
              ) : tokenBusy ? (
                <Spinner label="Выпускаем команду…" />
              ) : (
                <InfoBanner tone="warn">Не удалось выпустить команду.</InfoBanner>
              )}
            </li>
            <li>
              Дождитесь сообщения «RoutX установлен и привязан». Обычно это занимает 1–3 минуты.
              После успешной установки установщик сам перезагрузит роутер — это нужно, чтобы LuCI
              и продукт применили изменения.
            </li>
          </ol>

          {tokenError ? <ErrorBanner message={tokenError} /> : null}
          {tokenExpired || (!token && !tokenBusy) ? (
            <div className="onb-inline-actions">
              <Button
                size="sm"
                variant="subtle"
                onClick={() => void issueToken(router.id)}
                busy={tokenBusy}
              >
                Выпустить новую команду
              </Button>
            </div>
          ) : null}

          <div className={`onb-wait onb-wait-${liveStatus}`}>
            <span className={`onb-dot${online ? ' onb-dot-ok' : ''}`} />
            <div>
              <strong>
                {online
                  ? 'Роутер на связи'
                  : liveStatus === 'conflict'
                    ? 'Конфликт продуктов'
                    : liveStatus === 'unsupported'
                      ? 'Неподдерживаемая платформа'
                      : 'Ждём, пока роутер выйдет на связь…'}
              </strong>
              <span>
                {online
                  ? `${PRODUCT_LABEL[liveRouter?.product ?? 'unknown'] ?? 'Продукт'} ${liveRouter?.product_version ?? ''} · ${liveRouter?.model ?? ''}`
                  : 'Страница обновится автоматически, как только агент подключится.'}
              </span>
            </div>
            {online ? <StatusBadge status="online" label="В сети" /> : null}
          </div>

          {liveRouter?.product === 'conflict' || liveStatus === 'conflict' ? (
            <InfoBanner tone="warn">
              На роутере одновременно найдены Prokop и Forkop. Агент не будет менять конфигурацию,
              пока конфликт не устранён вручную.
            </InfoBanner>
          ) : null}

          <div className="onb-actions">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Назад
            </Button>
            <Button variant="ghost" onClick={() => void api(`/api/v1/routers/${router.id}`).then((data) => setLiveRouter((data as { router: RouterRecord }).router))}>
              Проверить снова
            </Button>
            <Button onClick={() => setStep(3)} disabled={!online}>
              Продолжить
            </Button>
          </div>
        </div>
      ) : null}

      {step === 3 && router ? (
        <div className="onb-card">
          <div className="onb-hero">
            <span className="onb-hero-icon">3</span>
            <div>
              <h2>Подписка и шаблон</h2>
              <p>Можно указать одно, оба или пропустить — проверка всё равно запустится.</p>
            </div>
          </div>
          {formError ? <ErrorBanner message={formError} /> : null}

          {catalogList.length > 0 ? (
            <Field
              label="Подписка из каталога"
              hint="Выберите готовую подписку или вставьте ссылку вручную."
            >
              <Select
                value={catalogId}
                onChange={(value) => {
                  setCatalogId(value);
                  if (value) setSubscription('');
                }}
              >
                <option value="">Вставить ссылку вручную</option>
                {catalogList.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.owner_email ? ` · ${item.owner_email}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {selectedCatalog ? (
            <InfoBanner>
              Выбрана подписка <strong>{selectedCatalog.name}</strong> из каталога. Ссылка хранится
              на сервере и не показывается.
            </InfoBanner>
          ) : (
            <Field
              label="Ссылка на подписку"
              hint="Ссылка вида https://… Секрет хранится на сервере в зашифрованном виде."
            >
              <TextInput
                value={subscription}
                onChange={setSubscription}
                placeholder="https://example.com/sub/…"
              />
            </Field>
          )}
          {subscriptions.loading && !subscriptions.data ? (
            <Spinner label="Загружаем каталог подписок…" />
          ) : null}
          {subscriptions.error ? <ErrorBanner message={subscriptions.error} /> : null}

          <Field label="Шаблон" hint="Шаблон задаёт списки, DNS и правила. Его можно изменить позже.">
            <Select value={templateId} onChange={setTemplateId}>
              <option value="">Без шаблона</option>
              {templatesList.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} (ред. {item.current_revision})
                </option>
              ))}
            </Select>
          </Field>

          {templates.loading && !templates.data ? <Spinner label="Загружаем шаблоны…" /> : null}
          {templates.data?.items.length === 0 ? (
            <InfoBanner>
              Шаблонов пока нет. Можно пропустить этот шаг и создать шаблон позже.
            </InfoBanner>
          ) : null}

          {selectedTemplate ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={applyTemplate}
                onChange={(event) => setApplyTemplate(event.target.checked)}
              />
              <span>
                Применить шаблон сразу после проверки (будет создан снимок и выполнен diff)
              </span>
            </label>
          ) : null}

          <div className="onb-autostart">
            <div>
              <strong>
                Автозапуск{' '}
                {PRODUCT_LABEL[liveRouter?.product ?? router.product ?? 'prokop'] ?? 'Prokop'}
              </strong>
              <span>
                {autostart === null
                  ? 'Проверяем текущее состояние…'
                  : autostart
                    ? 'Включён — после перезагрузки роутера Prokop/Forkop запустится сам и поднимет sing-box.'
                    : 'Сейчас выключен: после перезагрузки роутера служба и sing-box могут не подняться.'}
              </span>
            </div>
            <Button
              size="sm"
              variant={autostart ? 'ghost' : 'subtle'}
              onClick={() => void enableAutostart()}
              busy={autostartBusy}
              disabled={autostart === true}
            >
              {autostart ? 'Автостарт включён' : 'Включить автостарт'}
            </Button>
          </div>

          <div className="onb-actions">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Назад
            </Button>
            <Button onClick={continueFromStep3}>
              {subscription.trim() || catalogId || templateId
                ? 'Сохранить и проверить'
                : 'Перейти к проверке'}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 4 && router ? (
        <div className="onb-card">
          <div className="onb-hero">
            <span
              className={`onb-hero-icon ${running ? 'onb-hero-icon-running' : allDone && !hasProblems ? 'onb-hero-icon-ok' : ''}`}
            >
              {running ? '…' : allDone && !hasProblems ? '✓' : '4'}
            </span>
            <div>
              <h2>
                {running
                  ? 'Проверяем роутер'
                  : allDone && !hasProblems
                    ? 'Роутер готов'
                    : allDone
                      ? 'Есть замечания'
                      : 'Проверка'}
              </h2>
              <p>
                {running
                  ? 'Не закрывайте страницу — обычно это занимает меньше минуты.'
                  : allDone && !hasProblems
                    ? 'Заблокированный сайт открывается через прокси, диагностика собрана.'
                    : 'Посмотрите результат ниже. Роутер уже создан и привязан.'}
              </p>
            </div>
          </div>

          <div className="onb-check-list">
            {(
              [
                ['subscription', 'Подписка'],
                ['template', 'Шаблон'],
                ['access', 'Заблокированный сайт'],
                ['diagnostics', 'Быстрая диагностика'],
              ] as Array<[PipelineKey, string]>
            ).map(([key, label]) => {
              const item = pipeline[key];
              return (
                <div key={key} className={`onb-check-row onb-check-${item.status}`}>
                  <span className={`onb-check-icon onb-check-icon-${item.status}`}>
                    {item.status === 'success'
                      ? '✓'
                      : item.status === 'error'
                        ? '×'
                        : item.status === 'skipped'
                          ? '–'
                          : ''}
                  </span>
                  <div>
                    <strong>{label}</strong>
                    <span>{item.detail}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {access ? (
            <div className="onb-result">
              <div>
                <span className="onb-result-label">Проверка сайта</span>
                <strong>{access.target}</strong>
                <span className="muted-text small">
                  {access.proxy_tag || 'активный прокси'} · {access.latency_ms ?? '—'} мс
                </span>
              </div>
              <span className="onb-result-badge">Пройдено</span>
            </div>
          ) : null}

          {report ? (
            <div className="onb-diagnostics">
              <div className="onb-summary">
                <div>
                  <span>Проверок</span>
                  <strong>{summary.total}</strong>
                </div>
                <div>
                  <span>В норме</span>
                  <strong className="onb-ok">{summary.counts.ok}</strong>
                </div>
                <div>
                  <span>Предупреждения</span>
                  <strong className="onb-warn">{summary.counts.warn}</strong>
                </div>
                <div>
                  <span>Ошибки</span>
                  <strong className="onb-bad">{summary.counts.bad}</strong>
                </div>
              </div>
              {summary.warnings.length > 0 ? (
                <ul className="onb-warning-list">
                  {summary.warnings.map((warning) => (
                    <li key={`${warning.name}-${warning.details.slice(0, 20)}`}>
                      <strong>{warning.name.replace(/_/g, ' ')}</strong>
                      <span>
                        {(warning.details || 'нет подробностей').slice(0, 220)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted-text small">Предупреждений и ошибок нет.</p>
              )}
              <Link className="btn btn-ghost btn-sm" to={`/diagnostics/${report.id}`}>
                Открыть полный отчёт
              </Link>
            </div>
          ) : null}

          {pipelineError ? <ErrorBanner message={pipelineError} /> : null}

          <div className="onb-actions">
            {!running ? (
              <Button variant="subtle" onClick={retryChecks}>
                Повторить проверку
              </Button>
            ) : null}
            <Button onClick={() => navigate(`/routers/${router.id}`)}>Открыть роутер</Button>
            <Button variant="ghost" onClick={() => navigate('/routers')}>
              К списку роутеров
            </Button>
          </div>
        </div>
      ) : null}

      {step === 4 && !router ? (
        <Empty>Роутер не создан. Вернитесь на первый шаг.</Empty>
      ) : null}
    </div>
  );
}
