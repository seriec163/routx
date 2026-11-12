import { useEffect, useState } from 'react';
import {
  Button,
  ConfirmDialog,
  ErrorBanner,
  Field,
  InfoBanner,
  PageHeader,
  Panel,
  Select,
  Spinner,
  Stat,
  Switch,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatBytes, formatDate } from '../lib/format';
import type {
  SettingsEffective,
  SettingsResponse,
  SettingsStorage,
  UpdateStatus,
} from '../lib/types';
import { useApi } from '../lib/useApi';

interface FormState {
  mfaPolicy: 'all' | 'admins';
  sessionDays: number;
  limits: SettingsEffective['limits'];
  monitoring: SettingsEffective['monitoring'];
  retention: SettingsEffective['retention'];
  agent: SettingsEffective['agent'];
  singbox: SettingsEffective['singbox'];
  features: SettingsEffective['features'];
}

function toForm(effective: SettingsEffective): FormState {
  return {
    mfaPolicy: effective.mfaPolicy,
    sessionDays: effective.sessionDays,
    limits: { ...effective.limits },
    monitoring: { ...effective.monitoring },
    retention: { ...effective.retention },
    agent: { ...effective.agent },
    singbox: { ...effective.singbox },
    features: { ...effective.features },
  };
}

function StatusBadge({ tone, children }: { tone: 'ok' | 'warn' | 'muted' | 'bad'; children: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const UPDATE_STATE_LABEL: Record<string, string> = {
  pulling: 'Скачиваю образ',
  restarting: 'Перезапускаю панель',
  rolling_back: 'Откатываю версию',
  rolled_back: 'Откат выполнен',
  success: 'Обновление установлено',
  failed: 'Ошибка обновления',
  rollback_failed: 'Ошибка отката',
};

function updateTone(state: string | undefined): 'ok' | 'warn' | 'muted' | 'bad' {
  if (state === 'success' || state === 'rolled_back') return 'ok';
  if (state === 'failed' || state === 'rollback_failed') return 'bad';
  if (state) return 'warn';
  return 'muted';
}

export function SettingsPage() {
  const toast = useToast();
  const settings = useApi<SettingsResponse>('/api/v1/settings');
  const storage = useApi<SettingsStorage>('/api/v1/settings/storage');
  const updates = useApi<UpdateStatus>('/api/v1/updates');
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateAction, setUpdateAction] = useState<'check' | 'apply' | 'rollback' | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState<'apply' | 'rollback' | null>(null);

  useEffect(() => {
    if (settings.data?.effective && !form) setForm(toForm(settings.data.effective));
  }, [settings.data, form]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void updates.reload();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [updates.reload]);

  async function checkUpdates(): Promise<void> {
    setUpdateAction('check');
    try {
      await api('/api/v1/updates/check', { method: 'POST' });
      await updates.reload();
      toast.success('Проверка обновлений выполнена');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setUpdateAction(null);
    }
  }

  async function runUpdate(action: 'apply' | 'rollback'): Promise<void> {
    setUpdateAction(action);
    try {
      await api(`/api/v1/updates/${action}`, { method: 'POST' });
      setConfirmUpdate(null);
      toast.success(action === 'apply' ? 'Обновление запущено' : 'Откат запущен');
      await updates.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setUpdateAction(null);
    }
  }

  function numberField<K extends keyof FormState>(key: K, value: number): void {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  function nested<K extends 'limits' | 'monitoring' | 'retention' | 'agent' | 'singbox'>(
    group: K,
    key: keyof FormState[K],
    value: number,
  ): void {
    setForm((current) =>
      current ? { ...current, [group]: { ...current[group], [key]: value } } : current,
    );
  }

  function flag<K extends 'monitoring' | 'singbox' | 'features'>(
    group: K,
    key: keyof FormState[K],
    value: boolean,
  ): void {
    setForm((current) =>
      current ? { ...current, [group]: { ...current[group], [key]: value } } : current,
    );
  }

  async function resetForm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const fresh = await api<SettingsResponse>('/api/v1/settings');
      setForm(toForm(fresh.effective));
      toast.success('Несохранённые изменения отменены');
      await settings.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ effective: SettingsEffective }>('/api/v1/settings', {
        method: 'PATCH',
        body: {
          mfa_policy: form.mfaPolicy,
          session_days: form.sessionDays,
          limits: {
            routers_per_user: form.limits.routersPerUser,
            users_per_instance: form.limits.usersPerInstance,
            routers_per_instance: form.limits.routersPerInstance,
            batch_size: form.limits.batchSize,
            templates_per_user: form.limits.templatesPerUser,
          },
          monitoring: {
            interval_seconds: form.monitoring.intervalSeconds,
            offline_after_misses: form.monitoring.offlineAfterMisses,
            latency_degraded_ms: form.monitoring.latencyDegradedMs,
            stagger_seconds: form.monitoring.staggerSeconds,
            degraded_after_samples: form.monitoring.degradedAfterSamples,
            degraded_cooldown_minutes: form.monitoring.degradedCooldownMinutes,
            recovery_notify: form.monitoring.recoveryNotify,
          },
          retention: {
            days: form.retention.days,
            commands_days: form.retention.commandsDays,
            snapshots_local: form.retention.snapshotsLocal,
          },
          agent: {
            poll_hold_seconds: form.agent.pollHoldSeconds,
            command_ttl_read_seconds: form.agent.commandTtlReadSeconds,
            command_ttl_mutate_seconds: form.agent.commandTtlMutateSeconds,
            min_version: form.agent.minVersion,
          },
          singbox: {
            user_install: form.singbox.userInstall,
            user_cooldown_hours: form.singbox.userCooldownHours,
            staged_rollout: form.singbox.stagedRollout === 'off' ? 'off' : 'superadmin',
          },
          features: {
            mtls: form.features.mtls,
            logread: form.features.logread,
            auto_reconcile: form.features.autoReconcile,
            api_tokens: form.features.apiTokens,
          },
        },
      });
      setForm(toForm(result.effective));
      toast.success('Настройки сохранены');
      await settings.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (settings.loading && !settings.data) return <Spinner />;
  if (settings.error) {
    return <ErrorBanner message={settings.error} onRetry={() => void settings.reload()} />;
  }
  if (!form) return <Spinner />;

  return (
    <div className="page settings-page">
      <PageHeader
        title="Настройки сервера"
        subtitle="Параметры всего инстанса: безопасность, лимиты, мониторинг, хранение и функции. Наведите курсор на значок ⓘ рядом с параметром — появится объяснение, что изменится."
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() => void resetForm()}
              busy={busy}
              disabled={busy}
              title="Вернуть значения, которые уже сохранены на сервере"
            >
              Отменить правки
            </Button>
            <Button onClick={() => void save()} busy={busy}>
              Сохранить
            </Button>
          </>
        }
      />

      {error ? <ErrorBanner message={error} /> : null}

      <InfoBanner>
        Сохранение действует сразу для всех пользователей и роутеров, каждое изменение попадает в
        журнал аудита. Отключить второй фактор полностью нельзя: первый суперадминистратор обязан
        настроить TOTP при первом входе.
      </InfoBanner>

      <Panel
        title="Обновления"
        subtitle="Проверка GitHub и обновление панели из опубликованного образа."
      >
        {updates.error ? (
          <ErrorBanner message={updates.error} onRetry={() => void updates.reload()} />
        ) : null}
        {updates.data?.error ? <InfoBanner>{updates.data.error}</InfoBanner> : null}
        {updates.data ? (
          <>
            <div className="kv">
              <span>Текущая версия</span>
              <strong>
                {updates.data.current.version} ·{' '}
                {updates.data.current.build === 'dev'
                  ? 'dev'
                  : updates.data.current.build.slice(0, 7)}
              </strong>
              <span>Последняя в GitHub</span>
              <strong>
                {updates.data.latest
                  ? `${updates.data.latest.sha.slice(0, 7)} · ${updates.data.latest.message}`
                  : '—'}
              </strong>
              <span>Проверено</span>
              <strong>{formatDate(updates.data.checked_at)}</strong>
              <span>Updater</span>
              <strong>
                {updates.data.updater_installed ? 'установлен' : 'не установлен'}
              </strong>
            </div>
            {updates.data.status?.state ? (
              <p>
                <StatusBadge tone={updateTone(updates.data.status.state)}>
                  {UPDATE_STATE_LABEL[updates.data.status.state] ?? updates.data.status.state}
                </StatusBadge>{' '}
                <span className="muted-text small">
                  {updates.data.status.message ?? ''}{' '}
                  {updates.data.status.updated_at
                    ? `· ${formatDate(updates.data.status.updated_at)}`
                    : ''}
                </span>
              </p>
            ) : null}
            <div className="toolbar">
              <Button
                variant="ghost"
                onClick={() => void checkUpdates()}
                busy={updateAction === 'check'}
                disabled={updateAction !== null}
              >
                Проверить обновления
              </Button>
              <Button
                onClick={() => setConfirmUpdate('apply')}
                disabled={
                  updateAction !== null ||
                  !updates.data.updater_installed ||
                  !updates.data.update_available
                }
              >
                {updates.data.update_available ? 'Обновить панель' : 'Обновлений нет'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmUpdate('rollback')}
                disabled={updateAction !== null || !updates.data.updater_installed}
              >
                Откатить
              </Button>
            </div>
            {!updates.data.updater_installed ? (
              <InfoBanner>
                Чтобы обновлять панель из интерфейса, установите host-службу на сервере:{' '}
                <code>sudo routx updater install</code>.
              </InfoBanner>
            ) : null}
            {updates.data.latest?.url ? (
              <p className="muted-text small">
                <a href={updates.data.latest.url} target="_blank" rel="noreferrer">
                  Изменения в GitHub
                </a>
              </p>
            ) : null}
          </>
        ) : (
          <Spinner />
        )}
      </Panel>

      <div className="grid-2">
        <div className="stack">
          <Panel title="Безопасность" subtitle="Кто обязан использовать 2FA и сколько живёт вход в браузере.">
            <Field
              label="Политика 2FA"
              hint="Кого обязать настраивать TOTP при входе."
              tip="«Для всех» — второй фактор обязателен каждому пользователю. «Только для администраторов» — обычные пользователи входят по паролю, а суперадминистраторы обязаны настроить TOTP. Полностью отключить 2FA нельзя."
            >
              <Select
                value={form.mfaPolicy}
                onChange={(value) =>
                  setForm((current) =>
                    current ? { ...current, mfaPolicy: value as 'all' | 'admins' } : current,
                  )
                }
              >
                <option value="all">Для всех пользователей</option>
                <option value="admins">Только для администраторов</option>
              </Select>
            </Field>
            <Field
              label="Срок сессии, дней"
              hint="1–365. Сессия продлевается автоматически, пока вы ею пользуетесь."
              tip="Сколько дней живёт сессия после входа. Пока вы открываете панель или приложение, срок автоматически продлевается. Для мобильного приложения дополнительно хранится привязка устройства: она возвращает сессию, пока приложение не удалено или устройство не отозвано на роутере. На работу агентов роутеров не влияет."
            >
              <TextInput
                type="number"
                min={1}
                max={365}
                value={String(form.sessionDays)}
                onChange={(value) => numberField('sessionDays', Number(value))}
              />
            </Field>
          </Panel>

          <Panel
            title="Лимиты"
            subtitle="Сколько объектов можно создать. Проверяется при создании: уже существующие объекты не удаляются."
          >
            <div className="grid-2 grid-2-compact">
              <Field
                label="Роутеров на пользователя"
                hint="Максимум роутеров у одного владельца."
                tip="Сколько роутеров один пользователь может добавить. При снижении лимита уже добавленные роутеры остаются, но новые создать нельзя, пока их количество не станет ниже лимита."
              >
                <TextInput
                  type="number"
                  min={1}
                  max={1000}
                  value={String(form.limits.routersPerUser)}
                  onChange={(value) => nested('limits', 'routersPerUser', Number(value))}
                />
              </Field>
              <Field
                label="Учётных записей на сервере"
                hint="Всего аккаунтов, включая открытые приглашения."
                tip="Общий лимит учётных записей и ещё не использованных приглашений на этом сервере. Это не число одновременно онлайн-пользователей и не число роутеров. Когда лимит достигнут, новые приглашения не создаются; существующие аккаунты продолжают работать."
              >
                <TextInput
                  type="number"
                  min={1}
                  max={1000}
                  value={String(form.limits.usersPerInstance)}
                  onChange={(value) => nested('limits', 'usersPerInstance', Number(value))}
                />
              </Field>
              <Field
                label="Роутеров на сервере"
                hint="Общий потолок для всех владельцев."
                tip="Сколько всего роутеров может быть на сервере, включая роутеры разных пользователей. Уже подключённые роутеры продолжают работать, но добавление новых блокируется до снижения количества."
              >
                <TextInput
                  type="number"
                  min={1}
                  max={5000}
                  value={String(form.limits.routersPerInstance)}
                  onChange={(value) => nested('limits', 'routersPerInstance', Number(value))}
                />
              </Field>
              <Field
                label="Роутеров в пакетной диагностике"
                hint="Максимум за один запуск диагностики."
                tip="Сколько роутеров можно проверить одной командой диагностики. Не влияет на применение шаблонов, обновления и другие операции. Большой размер ускоряет разбор парка, но создаёт больше одновременных задач."
              >
                <TextInput
                  type="number"
                  min={1}
                  max={50}
                  value={String(form.limits.batchSize)}
                  onChange={(value) => nested('limits', 'batchSize', Number(value))}
                />
              </Field>
              <Field
                label="Шаблонов на пользователя"
                hint="Максимум шаблонов у одного владельца."
                tip="Сколько шаблонов может создать один пользователь. При снижении лимита уже созданные шаблоны не удаляются, но новые создать нельзя, пока количество не станет ниже лимита."
              >
                <TextInput
                  type="number"
                  min={1}
                  max={1000}
                  value={String(form.limits.templatesPerUser)}
                  onChange={(value) => nested('limits', 'templatesPerUser', Number(value))}
                />
              </Field>
            </div>
          </Panel>

          <Panel title="Мониторинг" subtitle="Как сервер проверяет роутеры и определяет проблемы.">
            <div className="grid-2 grid-2-compact">
              <Field
                label="Интервал опроса, секунд"
                hint="30–600. По умолчанию 60."
                tip="Как часто сервер отправляет проверку каждому роутеру. Меньше интервал — быстрее видно проблемы, но выше нагрузка на сервер и роутеры."
              >
                <TextInput
                  type="number"
                  min={30}
                  max={600}
                  value={String(form.monitoring.intervalSeconds)}
                  onChange={(value) => nested('monitoring', 'intervalSeconds', Number(value))}
                />
              </Field>
              <Field
                label="Пропусков до «офлайн»"
                hint="2–20. По умолчанию 3."
                tip="Сколько проверок подряд роутер может не ответить, прежде чем он станет «офлайн». При интервале 60 секунд и 3 пропусках это примерно 3 минуты. Слишком маленькое значение даёт ложные тревоги."
              >
                <TextInput
                  type="number"
                  min={2}
                  max={20}
                  value={String(form.monitoring.offlineAfterMisses)}
                  onChange={(value) => nested('monitoring', 'offlineAfterMisses', Number(value))}
                />
              </Field>
              <Field
                label="Порог деградации, мс"
                hint="Выше порога — статус «деградация»."
                tip="Если задержка прокси выше этого значения, прокси считается деградировавшим, даже когда он отвечает. Влияет только на статус и предупреждения: трафик не блокируется и правила не меняются."
              >
                <TextInput
                  type="number"
                  min={100}
                  max={30000}
                  value={String(form.monitoring.latencyDegradedMs)}
                  onChange={(value) => nested('monitoring', 'latencyDegradedMs', Number(value))}
                />
              </Field>
              <Field
                label="Разброс проверок, секунд"
                hint="Разносит проверки роутеров во времени."
                tip="Сдвиг проверки внутри интервала, чтобы все роутеры не проверялись одновременно. Снижает пиковую нагрузку на сервер и канал. Значение 0 — проверять без разброса. Не может быть больше интервала опроса."
              >
                <TextInput
                  type="number"
                  min={0}
                  max={120}
                  value={String(form.monitoring.staggerSeconds)}
                  onChange={(value) => nested('monitoring', 'staggerSeconds', Number(value))}
                />
              </Field>
              <Field
                label="Проверок до деградации"
                hint="2–20. По умолчанию 3."
                tip="Сколько проверок подряд должны показать деградацию, прежде чем появится уведомление. Защищает от одиночных выбросов задержки и лишних тревог. Статус в панели обновляется сразу, ждёт только уведомление."
              >
                <TextInput
                  type="number"
                  min={2}
                  max={20}
                  value={String(form.monitoring.degradedAfterSamples)}
                  onChange={(value) =>
                    nested('monitoring', 'degradedAfterSamples', Number(value))
                  }
                />
              </Field>
              <Field
                label="Пауза уведомлений о деградации, минут"
                hint="30–10080. По умолчанию 360 (6 часов)."
                tip="После предупреждения о деградации следующее по этому роутеру придёт не раньше чем через указанное время. Внутри одного непрерывного эпизода уведомление отправляется один раз. Проверки и статус в панели продолжают обновляться."
              >
                <TextInput
                  type="number"
                  min={30}
                  max={10080}
                  value={String(form.monitoring.degradedCooldownMinutes)}
                  onChange={(value) =>
                    nested('monitoring', 'degradedCooldownMinutes', Number(value))
                  }
                />
              </Field>
            </div>
            <Switch
              label="Сообщать о восстановлении"
              hint="Одно сообщение, когда связь вернулась после тревоги."
              tip="Отправлять «VPN снова работает» после устранения деградации или отказа. Уведомление приходит один раз на эпизод и только если до этого было отправлено предупреждение."
              checked={form.monitoring.recoveryNotify}
              onChange={(value) => flag('monitoring', 'recoveryNotify', value)}
            />
          </Panel>
        </div>

        <div className="stack">
          <Panel title="Хранение" subtitle="Сколько хранить историю. Настройки, шаблоны и роутеры не удаляются.">
            <div className="grid-2 grid-2-compact">
              <Field
                label="Срок хранения истории, дней"
                hint="1–30. Старые записи удаляются автоматически."
                tip="Срок хранения метрик, отчётов и истории заданий. По истечении записи удаляются, но текущее состояние роутеров, шаблоны и настройки остаются."
              >
                <TextInput
                  type="number"
                  min={1}
                  max={30}
                  value={String(form.retention.days)}
                  onChange={(value) => nested('retention', 'days', Number(value))}
                />
              </Field>
              <Field
                label="Журнал команд агента, дней"
                hint="1–7 после подтверждения."
                tip="Сколько дней хранить журнал команд, отправленных агентам. Он нужен для разбора инцидентов и не влияет на работу роутеров."
              >
                <TextInput
                  type="number"
                  min={1}
                  max={7}
                  value={String(form.retention.commandsDays)}
                  onChange={(value) => nested('retention', 'commandsDays', Number(value))}
                />
              </Field>
              <Field
                label="Снимков на роутер"
                hint="Последних снимков в истории сервера."
                tip="Сколько последних снимков состояния хранить для каждого роутера на сервере. Снимок создаётся перед изменениями и нужен для отката; более старые удаляются автоматически."
              >
                <TextInput
                  type="number"
                  min={1}
                  max={50}
                  value={String(form.retention.snapshotsLocal)}
                  onChange={(value) => nested('retention', 'snapshotsLocal', Number(value))}
                />
              </Field>
            </div>
          </Panel>

          <Panel
            title="Логи и история"
            subtitle="Сколько места занимают журналы, история заданий, мониторинг и отчёты в PostgreSQL."
            actions={
              <Button
                variant="ghost"
                onClick={() => void storage.reload()}
                busy={storage.loading}
                disabled={storage.loading}
              >
                Обновить
              </Button>
            }
          >
            {storage.loading && !storage.data ? <Spinner label="Считаем размер…" /> : null}
            {storage.error ? (
              <ErrorBanner message={storage.error} onRetry={() => void storage.reload()} />
            ) : null}
            {storage.data ? (
              <>
                <div className="grid-2 grid-2-compact">
                  <Stat label="Журналы и история" value={formatBytes(storage.data.log_bytes)} />
                  <Stat label="Вся база" value={formatBytes(storage.data.database_bytes)} />
                </div>
                <p className="field-hint">
                  Срок хранения истории: {storage.data.retention.days} дн., журнал команд агента:{' '}
                  {storage.data.retention.commandsDays} дн., снимков на роутер:{' '}
                  {storage.data.retention.snapshotsLocal}.
                </p>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Таблица</th>
                        <th>Строк</th>
                        <th>Размер</th>
                      </tr>
                    </thead>
                    <tbody>
                      {storage.data.tables.map((table) => (
                        <tr key={table.name}>
                          <td className="mono small">{table.name}</td>
                          <td>{table.rows.toLocaleString('ru-RU')}</td>
                          <td>{formatBytes(table.bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="field-hint">
                  Сырые логи контейнера Docker сюда не входят: они лежат вне PostgreSQL и смотрятся
                  через <span className="mono">docker compose logs</span>. Таблица показывает
                  журналы и историю, которые RoutX хранит в базе.
                </p>
              </>
            ) : null}
          </Panel>

          <Panel
            title="Агент"
            subtitle="Связь с агентами на роутерах. Меняйте только при проблемах с доставкой команд."
          >
            <div className="grid-2 grid-2-compact">
              <Field
                label="Ожидание команды (long-poll), секунд"
                hint="1–25. По умолчанию 25."
                tip="Сколько секунд сервер держит запрос агента открытым в ожидании команды. Больше значение — быстрее доставка и меньше пустых запросов, но выше нагрузка. Не должно превышать таймауты прокси и reverse proxy."
              >
                <TextInput
                  type="number"
                  min={1}
                  max={25}
                  value={String(form.agent.pollHoldSeconds)}
                  onChange={(value) => nested('agent', 'pollHoldSeconds', Number(value))}
                />
              </Field>
              <Field
                label="Срок команды чтения, секунд"
                hint="15–600. По умолчанию 120."
                tip="Сколько секунд команда чтения состояния остаётся актуальной. Если агент не забрал её вовремя, задача завершится ошибкой, и её нужно запустить снова."
              >
                <TextInput
                  type="number"
                  min={15}
                  max={600}
                  value={String(form.agent.commandTtlReadSeconds)}
                  onChange={(value) => nested('agent', 'commandTtlReadSeconds', Number(value))}
                />
              </Field>
              <Field
                label="Срок команды изменения, секунд"
                hint="60–3600. По умолчанию 600."
                tip="Сколько секунд команда изменения (применение шаблона, снимок, перезапуск) ждёт выполнения. Слишком маленькое значение обрывает долгие операции, слишком большое задерживает повторный запуск."
              >
                <TextInput
                  type="number"
                  min={60}
                  max={3600}
                  value={String(form.agent.commandTtlMutateSeconds)}
                  onChange={(value) => nested('agent', 'commandTtlMutateSeconds', Number(value))}
                />
              </Field>
              <Field
                label="Рекомендуемая версия агента"
                hint="Справочно, например 1.0.0."
                tip="Значение хранится как рекомендация для администратора. Сервер не отключает агентов старше этой версии и не блокирует их команды — используйте его при ручном планировании обновлений."
              >
                <TextInput
                  value={form.agent.minVersion}
                  onChange={(value) =>
                    setForm((current) =>
                      current ? { ...current, agent: { ...current.agent, minVersion: value } } : current,
                    )
                  }
                />
              </Field>
            </div>
          </Panel>

          <Panel title="sing-box" subtitle="Установка, переключение вариантов и поэтапные обновления.">
            <Switch
              label="Разрешить пользователям ставить sing-box"
              hint="Из каталога вариантов, с паузой между установками, снимком и подтверждением."
              tip="Если включено, обычные пользователи могут сами устанавливать и переключать sing-box из каталога. Отключение не удаляет уже установленный sing-box и не меняет текущий вариант."
              checked={form.singbox.userInstall}
              onChange={(value) => flag('singbox', 'userInstall', value)}
            />
            <Field
              label="Пауза между установками, часов"
              hint="1–720. По умолчанию 24."
              tip="Минимальное время между установкой или переключением sing-box одним пользователем. Защищает роутер и канал от частых перезапусков и повторных скачиваний."
            >
              <TextInput
                type="number"
                min={1}
                max={720}
                value={String(form.singbox.userCooldownHours)}
                onChange={(value) => nested('singbox', 'userCooldownHours', Number(value))}
              />
            </Field>
            <Field
              label="Поэтапное обновление"
              hint="Кто создаёт волны; «Отключено» блокирует новые."
              tip="«Только суперадминистратор» — создавать новые волны может только суперадминистратор. «Отключено» — создание новых волн блокируется, но уже начатые обновления можно завершить или отменить. На обычную установку sing-box это не влияет."
            >
              <Select
                value={form.singbox.stagedRollout === 'off' ? 'off' : 'superadmin'}
                onChange={(value) =>
                  setForm((current) =>
                    current ? { ...current, singbox: { ...current.singbox, stagedRollout: value } } : current,
                  )
                }
              >
                <option value="superadmin">Только суперадминистратор</option>
                <option value="off">Отключено</option>
              </Select>
            </Field>
          </Panel>

          <Panel
            title="Функции"
            subtitle="Дополнительные возможности. Пометка рядом с названием показывает, работает ли переключатель сейчас."
          >
            <Switch
              label="mTLS для агентов"
              badge={<StatusBadge tone="muted">Не подключено</StatusBadge>}
              hint="Планируется. Сейчас агенты используют токен и подпись запроса."
              tip="Взаимная TLS-аутентификация агентов пока не реализована: сервер не выдаёт клиентские сертификаты. Переключатель хранит намерение, но на работу не влияет. Включить его можно только после появления поддержки в агенте."
              checked={form.features.mtls}
              disabled={!form.features.mtls}
              onChange={(value) => flag('features', 'mtls', value)}
            />
            <Switch
              label="Сбор системного журнала (logread)"
              badge={<StatusBadge tone="muted">Не подключено</StatusBadge>}
              hint="Планируется. Журналы роутеров сейчас не собираются."
              tip="Автоматический сбор системного журнала роутера пока не реализован. Даже при включённом флаге данные не передаются. Когда появится, журналы могут содержать чувствительные данные — включайте осознанно."
              checked={form.features.logread}
              disabled={!form.features.logread}
              onChange={(value) => flag('features', 'logread', value)}
            />
            <Switch
              label="Автоматическая сверка"
              badge={<StatusBadge tone="warn">Экспериментально</StatusBadge>}
              hint="Разрешает автосверку, но периодический запуск пока не включён."
              tip="Флаг разрешает серверу запускать сверку без кнопки «Прочитать состояние». Сейчас отдельный периодический запуск ещё не включён: расхождения пересчитываются при чтении состояния и после применения шаблона. Автоматического применения изменений нет — при расхождении вы увидите diff и подтвердите его."
              checked={form.features.autoReconcile}
              onChange={(value) => flag('features', 'autoReconcile', value)}
            />
            <Switch
              label="API-токены"
              badge={<StatusBadge tone="muted">Не подключено</StatusBadge>}
              hint="Планируется. Сейчас вход только через браузерную сессию."
              tip="Выпуск API-токенов для внешних интеграций пока не реализован. Переключатель хранит намерение, но не открывает доступ. Вход возможен только через сессию браузера; включить флаг можно будет после появления API."
              checked={form.features.apiTokens}
              disabled={!form.features.apiTokens}
              onChange={(value) => flag('features', 'apiTokens', value)}
            />
          </Panel>
        </div>
      </div>

      <details className="settings-debug">
        <summary>Технические детали хранения (для отладки)</summary>
        <div className="settings-debug-body">
          <p className="field-hint">
            Это не отдельные настройки, а те же значения из форм выше в том виде, в котором они
            лежат в базе: ключ, JSON и время последнего изменения. Раздел нужен для диагностики и
            поддержки. Менять значения здесь нельзя — используйте формы выше и кнопку «Сохранить».
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Ключ</th>
                  <th>Значение</th>
                  <th>Обновлено</th>
                </tr>
              </thead>
              <tbody>
                {(settings.data?.values ?? []).map((row) => (
                  <tr key={row.key}>
                    <td className="mono small">{row.key}</td>
                    <td>
                      <pre className="code-block small inline-code">
                        {JSON.stringify(row.value, null, 2)}
                      </pre>
                    </td>
                    <td className="muted-text small">{new Date(row.updated_at).toLocaleString('ru-RU')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      {confirmUpdate ? (
        <ConfirmDialog
          title={confirmUpdate === 'apply' ? 'Обновить панель?' : 'Откатить панель?'}
          confirmLabel={confirmUpdate === 'apply' ? 'Обновить' : 'Откатить'}
          danger={confirmUpdate === 'rollback'}
          busy={updateAction === 'apply' || updateAction === 'rollback'}
          onCancel={() => setConfirmUpdate(null)}
          onConfirm={() => void runUpdate(confirmUpdate)}
          message={
            confirmUpdate === 'apply' ? (
              <>
                <p>
                  Панель скачает свежий образ из GitHub Container Registry, перезапустится и
                  применит миграции базы.
                </p>
                <p>
                  Если новая версия не пройдёт healthcheck, updater автоматически вернёт
                  предыдущий образ. Панель будет недоступна примерно 1–3 минуты.
                </p>
              </>
            ) : (
              <>
                <p>
                  Панель вернётся к предыдущему Docker-образу, сохранённому перед последним
                  обновлением.
                </p>
                <p>
                  Миграции базы автоматически не откатываются. Схема обычно совместима с прошлой
                  версией; при серьёзной ошибке используйте резервную копию базы.
                </p>
              </>
            )
          }
        />
      ) : null}
    </div>
  );
}
