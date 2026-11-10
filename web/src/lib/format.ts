export const ROLE_LABEL: Record<string, string> = {
  superadmin: 'Суперадминистратор',
  admin: 'Администратор',
  user: 'Пользователь',
};

export function roleLabel(role: string | null | undefined): string {
  return role ? (ROLE_LABEL[role] ?? role) : '—';
}

const dateTime = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const shortTime = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return dateTime.format(date);
}

export function formatShort(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return shortTime.format(date);
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return 'никогда';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'никогда';
  const diff = Date.now() - date.getTime();
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'назад' : 'вперёд';

  if (abs < 45_000) return diff >= 0 ? 'только что' : 'меньше минуты';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} мин ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} ч ${suffix}`;
  return `${Math.round(abs / 86_400_000)} дн ${suffix}`;
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КиБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МиБ`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value} мс`;
}

export const ROUTER_STATUS: Record<string, string> = {
  pending: 'Ожидает привязки',
  online: 'В сети',
  offline: 'Не в сети',
  error: 'Ошибка',
  conflict: 'Конфликт продукта',
  unsupported: 'Не поддерживается',
};

export const PRODUCT_LABEL: Record<string, string> = {
  forkop: 'Forkop',
  prokop: 'Prokop',
  podkop: 'Podkop',
  tachyon: 'Tachyon',
  unknown: 'Не определён',
  conflict: 'Конфликт продуктов',
};

export const JOB_STATUS: Record<string, string> = {
  queued: 'В очереди',
  running: 'Выполняется',
  success: 'Успешно',
  failed: 'Ошибка',
  cancelled: 'Отменена',
  timeout: 'Таймаут',
};

export const JOB_TYPE: Record<string, string> = {
  precheck: 'Проверка',
  refresh_state: 'Чтение состояния',
  diff: 'Сравнение',
  diff_custom: 'Сравнение правила',
  read_rules: 'Чтение правил',
  apply: 'Применение',
  monitor: 'Мониторинг',
  diagnostics: 'Диагностика',
  snapshot: 'Снимок',
  restore: 'Восстановление',
  sb_check: 'Каталог sing-box',
  sb_versions: 'Версии sing-box',
  sb_install: 'Установка sing-box',
  service_action: 'Служба',
  connections_apply: 'Подключения',
  list_connections: 'Чтение подключений',
  manage_connection: 'Изменение подключения',
  rollout: 'Rollout',
  retention: 'Очистка',
  reconcile: 'Сверка',
};

export const APPLY_STATUS: Record<string, string> = {
  awaiting_confirmation: 'Ждёт подтверждения',
  queued: 'В очереди',
  running: 'Выполняется',
  success: 'Успешно',
  failed: 'Ошибка',
  rolled_back: 'Откатано',
  rollback_failed: 'Откат не удался',
  needs_attention: 'Нужна проверка',
  cancelled: 'Отменено',
  stale: 'Устарело',
};

export const DRIFT: Record<string, string> = {
  unknown: 'Не проверено',
  in_sync: 'Совпадает',
  drift: 'Расхождение',
  incompatible: 'Несовместимо',
  blocked: 'Заблокировано',
};

export const SEVERITY: Record<string, string> = {
  info: 'Информация',
  warning: 'Предупреждение',
  critical: 'Критично',
};

export type Tone = 'ok' | 'bad' | 'warn' | 'pending' | 'muted';

export function statusTone(status: string): Tone {
  switch (status) {
    case 'online':
    case 'success':
    case 'in_sync':
    case 'healthy':
    case 'completed':
    case 'ok':
      return 'ok';
    case 'failed':
    case 'timeout':
    case 'offline':
    case 'error':
    case 'conflict':
    case 'dead':
    case 'rollback_failed':
    case 'needs_attention':
    case 'drift':
      return 'bad';
    case 'pending':
    case 'running':
    case 'queued':
    case 'installing':
    case 'verifying':
    case 'draft':
    case 'paused':
    case 'degraded':
    case 'warning':
    case 'awaiting_confirmation':
    case 'rolled_back':
      return 'warn';
    case 'cancelled':
    case 'stale':
    case 'unsupported':
    case 'unknown':
    case 'skipped':
      return 'muted';
    default:
      return 'muted';
  }
}

export function proxyHealth(value: string | null | undefined): string {
  switch (value) {
    case 'healthy':
      return 'Прокси в норме';
    case 'degraded':
      return 'Прокси деградировал';
    case 'dead':
      return 'Прокси не работает';
    default:
      return 'Нет данных о прокси';
  }
}
