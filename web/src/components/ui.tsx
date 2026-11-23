import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { statusTone, type Tone } from '../lib/format';
import type { Job } from '../lib/types';

/* -------------------------------------------------------------------------- */
/* Тосты                                                                      */
/* -------------------------------------------------------------------------- */

type ToastKind = 'ok' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  push: (kind: ToastKind, message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      counter.current += 1;
      const id = counter.current;
      setItems((current) => [...current.slice(-3), { id, kind, message }]);
      window.setTimeout(() => remove(id), kind === 'error' ? 8000 : 4500);
    },
    [remove],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      success: (message) => push('ok', message),
      error: (message) => push('error', message),
      info: (message) => push('info', message),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.kind}`}>
            <span>{item.message}</span>
            <button type="button" onClick={() => remove(item.id)} aria-label="Закрыть">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast требует ToastProvider');
  return context;
}

/* -------------------------------------------------------------------------- */
/* Базовые элементы                                                           */
/* -------------------------------------------------------------------------- */

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={statusTone(status)}>{label ?? status}</Badge>;
}

export function PageHeader(props: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="page-header">
      <div>
        {props.eyebrow ? <p className="eyebrow">{props.eyebrow}</p> : null}
        <h1>{props.title}</h1>
        {props.subtitle ? <p className="page-sub">{props.subtitle}</p> : null}
      </div>
      {props.actions ? <div className="page-actions">{props.actions}</div> : null}
    </header>
  );
}

export function Panel(props: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${props.className ?? ''}`}>
      {props.title || props.actions ? (
        <header className="panel-head">
          <div>
            {props.title ? <h2>{props.title}</h2> : null}
            {props.subtitle ? <p>{props.subtitle}</p> : null}
          </div>
          {props.actions ? <div className="panel-actions">{props.actions}</div> : null}
        </header>
      ) : null}
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

export function Stat(props: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="stat">
      <p className="stat-label">
        <span className={`dot dot-${props.tone ?? 'muted'}`} aria-hidden="true" />
        {props.label}
      </p>
      <p className="stat-value">{props.value}</p>
      {props.hint ? <p className="stat-hint">{props.hint}</p> : null}
    </div>
  );
}

export function Spinner({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" aria-hidden="true" />
      {label}
    </div>
  );
}

export function ProgressBar(props: {
  value?: number | null;
  label?: string;
  tone?: 'accent' | 'warn' | 'danger';
}) {
  const indeterminate = props.value == null;
  const value = indeterminate ? 0 : Math.max(0, Math.min(100, props.value ?? 0));
  return (
    <div
      className={`progress progress-${props.tone ?? 'accent'} ${
        indeterminate ? 'progress-indeterminate' : ''
      }`}
      role="progressbar"
      aria-label={props.label ?? 'Выполняется'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : value}
    >
      <span
        className="progress-fill"
        style={indeterminate ? undefined : { width: `${value}%` }}
      />
    </div>
  );
}

const JOB_PHASE: Record<string, string> = {
  queued: 'Ожидает выполнения',
  read_state: 'Читаем состояние роутера',
  plan: 'Строим план изменений',
  snapshot: 'Создаём снимок конфигурации',
  apply: 'Записываем настройки',
  connections: 'Применяем подключения',
  reload: 'Перезагружаем Prokop',
  verify: 'Проверяем состояние',
  rollback: 'Откатываем изменения',
  rolled_back: 'Изменения откачены',
  init: 'Готовим тест DNS',
  udp: 'Проверяем UDP DNS',
  doh: 'Проверяем DoH',
  done: 'Готово',
  failed: 'Ошибка',
};

const JOB_STATUS_TEXT: Record<string, string> = {
  queued: 'В очереди',
  running: 'Выполняется',
  success: 'Готово',
  failed: 'Ошибка',
  cancelled: 'Отменено',
  timeout: 'Таймаут',
};

function elapsedText(ms: number): string {
  if (ms < 1000) return 'только что';
  if (ms < 60_000) return `${Math.round(ms / 1000)} с`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} мин ${seconds} с`;
}

/**
 * Наглядный прогресс фоновой задачи. Показывает фазу, прошедшее время,
 * полосу прогресса и ошибку. Для задач без числового прогресса полоса
 * анимированная — но пользователь всё равно видит, что работа идёт.
 */
export function JobProgress(props: {
  job: Job | null;
  label?: string;
  phases?: Record<string, string>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const job = props.job;
  const running = job?.status === 'queued' || job?.status === 'running';

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, job?.id]);

  if (!job) return null;

  const phase =
    job.result && typeof job.result.phase === 'string' ? job.result.phase : null;
  const progress =
    job.result && typeof job.result.progress === 'number' ? job.result.progress : null;
  const phaseLabel = phase
    ? (props.phases?.[phase] ?? JOB_PHASE[phase] ?? phase)
    : null;
  const statusLabel =
    job.status === 'running'
      ? (phaseLabel ?? props.label ?? JOB_STATUS_TEXT.running)
      : (JOB_STATUS_TEXT[job.status] ?? props.label ?? job.status);
  const startedAt = Date.parse(job.started_at ?? job.created_at);
  const elapsed = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
  const tone =
    job.status === 'failed' || job.status === 'timeout'
      ? 'danger'
      : job.status === 'cancelled'
        ? 'warn'
        : 'accent';
  const value =
    job.status === 'success'
      ? 100
      : job.status === 'failed' || job.status === 'timeout' || job.status === 'cancelled'
        ? 100
        : progress;

  return (
    <div className="job-progress" role="status" aria-live="polite">
      <div className="job-progress-head">
        <span>{statusLabel}</span>
        <span className="muted-text small">
          {running || job.status === 'queued' ? `${elapsedText(elapsed)} · ` : ''}
          {value != null ? `${Math.round(value)}%` : 'выполняется…'}
        </span>
      </div>
      <ProgressBar value={value} tone={tone} label={statusLabel} />
      {job.error ? (
        <p className="field-error" style={{ marginTop: 6 }}>
          {job.error.message}
        </p>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="alert alert-error" role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Повторить
        </button>
      ) : null}
    </div>
  );
}

export function InfoBanner({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return <div className={`alert ${tone === 'warn' ? 'alert-warn' : 'alert-info'}`}>{children}</div>;
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md';
  disabled?: boolean;
  busy?: boolean;
  title?: string;
}) {
  const variant = props.variant ?? 'primary';
  return (
    <button
      type={props.type ?? 'button'}
      className={`btn btn-${variant} ${props.size === 'sm' ? 'btn-sm' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled || props.busy}
      aria-busy={props.busy}
      title={props.title}
    >
      {props.busy ? <span className="spinner-dot" aria-hidden="true" /> : null}
      {props.children}
    </button>
  );
}

/**
 * Подсказка по наведению или фокусу. Текст дублируется в title и aria-label,
 * чтобы объяснение было доступно и без CSS, и скринридеру.
 */
export function InfoTip({ text }: { text: string }) {
  return (
    <span
      className="info-tip"
      tabIndex={0}
      role="note"
      aria-label={text}
      onClick={(event) => {
        // Не даём label перевести фокус на поле: иначе подсказка закроется.
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
      }}
    >
      <span className="info-tip-icon" aria-hidden="true">
        i
      </span>
      <span className="info-tip-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}

export function Field(props: {
  label: string;
  hint?: string;
  tip?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <label className="field" htmlFor={props.htmlFor}>
      <span className="field-label-row">
        <span className="field-label">{props.label}</span>
        {props.tip ? <InfoTip text={props.tip} /> : null}
      </span>
      {props.children}
      {props.error ? <span className="field-error">{props.error}</span> : null}
      {!props.error && props.hint ? <span className="field-hint">{props.hint}</span> : null}
    </label>
  );
}

export function TextInput(props: {
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'email' | 'password' | 'number' | 'search';
  placeholder?: string;
  id?: string;
  required?: boolean;
  autoComplete?: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      id={props.id}
      className="input"
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      required={props.required}
      autoComplete={props.autoComplete}
      disabled={props.disabled}
      min={props.min}
      max={props.max}
      step={props.step}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

export function Select(props: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <select
      id={props.id}
      className="input"
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    >
      {props.children}
    </select>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  tip?: string;
  badge?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="switch-row">
      <div>
        <div className="switch-title">
          <label className="switch-label" htmlFor={id}>
            {props.label}
          </label>
          {props.badge}
          {props.tip ? <InfoTip text={props.tip} /> : null}
        </div>
        {props.hint ? <p className="field-hint">{props.hint}</p> : null}
      </div>
      <input
        id={id}
        type="checkbox"
        className="switch"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Модальное окно и подтверждение                                             */
/* -------------------------------------------------------------------------- */

export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);

  useEffect(() => {
    onCloseRef.current = props.onClose;
  }, [props.onClose]);

  // Эффект должен срабатывать один раз при открытии. Если зависеть от props,
  // каждый ввод символа пересоздаёт объект props, эффект снова фокусирует
  // контейнер и выбивает курсор из поля.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={props.onClose}>
      <div
        className={`modal ${props.wide ? 'modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        ref={ref}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{props.title}</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Закрыть">
            ×
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer ? <footer className="modal-foot">{props.footer}</footer> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog(props: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title={props.title}
      onClose={props.onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={props.onCancel} disabled={props.busy}>
            Отмена
          </Button>
          <Button
            variant={props.danger ? 'danger' : 'primary'}
            onClick={props.onConfirm}
            busy={props.busy}
          >
            {props.confirmLabel ?? 'Подтвердить'}
          </Button>
        </>
      }
    >
      <div className="confirm-text">{props.message}</div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Вкладки                                                                    */
/* -------------------------------------------------------------------------- */

export function Tabs<T extends string>(props: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={props.active === tab.id}
          className={`tab ${props.active === tab.id ? 'tab-active' : ''}`}
          onClick={() => props.onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* График задержки (SVG, без внешних библиотек)                               */
/* -------------------------------------------------------------------------- */

export function LatencyChart({
  points,
  height = 160,
}: {
  points: Array<{ x: number; y: number | null }>;
  height?: number;
}) {
  const width = 720;
  const padding = { top: 12, right: 10, bottom: 22, left: 38 };
  const values = points.map((point) => point.y).filter((value): value is number => value !== null);
  const max = Math.max(200, ...values);
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  if (points.length === 0) {
    return <p className="empty">Нет замеров за выбранный период</p>;
  }

  const xAt = (index: number): number =>
    padding.left + (points.length === 1 ? innerW / 2 : (index / (points.length - 1)) * innerW);
  const yAt = (value: number): number =>
    padding.top + innerH - Math.min(1, value / max) * innerH;

  let path = '';
  let started = false;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    if (point.y === null) {
      started = false;
      continue;
    }
    const command = started ? 'L' : 'M';
    path += `${command}${xAt(index).toFixed(1)},${yAt(point.y).toFixed(1)} `;
    started = true;
  }

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="График задержки прокси">
        {[0, 0.5, 1].map((fraction) => {
          const y = padding.top + innerH * fraction;
          return (
            <g key={fraction}>
              <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} className="chart-grid" />
              <text x={4} y={y + 4} className="chart-text">
                {Math.round(max * (1 - fraction))}
              </text>
            </g>
          );
        })}
        <path d={path.trim()} className="chart-line" />
        <text x={padding.left} y={height - 4} className="chart-text">
          {points.length > 0 ? new Date(points[0]!.x).toLocaleString('ru-RU') : ''}
        </text>
        <text x={width - padding.right} y={height - 4} textAnchor="end" className="chart-text">
          {points.length > 0 ? new Date(points[points.length - 1]!.x).toLocaleString('ru-RU') : ''}
        </text>
      </svg>
    </div>
  );
}
