import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  ErrorBanner,
  Field,
  InfoBanner,
  Panel,
  PageHeader,
  ProgressBar,
  Spinner,
  useToast,
} from '../components/ui';
import { apiDownload, apiUploadBinary, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import { useApi } from '../lib/useApi';
import { useSession } from '../session';
import { AgentUpdates } from './AgentUpdates';

interface DeployStatus {
  app_version: string;
  schema_version: string | null;
  migrations_version: string | null;
  public_url: string;
  master_key: { fingerprint: string; source: 'file' | 'env'; file: string };
  database: { size_bytes: number; server_version: string; name: string | null };
  counts: Record<string, number>;
  uptime_seconds: number;
  safety_backups: Array<{ name: string; size_bytes: number; at: string }>;
  domain: { host: string; addresses: string[]; error: string | null };
}

interface BundleManifest {
  format: number;
  created_at: string;
  app_version: string;
  schema_version: string | null;
  public_url: string;
  master_key_fingerprint: string;
  counts: Record<string, number>;
  database: { size_bytes: number; server_version: string };
}

interface InspectResult {
  manifest: BundleManifest;
  compatible: boolean;
  current_migrations_version: string | null;
  same_domain: boolean;
  master_key_matches: boolean;
}

const COUNT_LABEL: Record<string, string> = {
  users: 'Пользователи',
  routers: 'Роутеры',
  templates: 'Шаблоны',
  subscriptions: 'Подписки',
  jobs: 'Задачи',
  audit: 'Записи аудита',
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} МБ`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function b64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function DeployPage() {
  const toast = useToast();
  const { me } = useSession();
  const isSuperadmin = me?.permissions.is_superadmin === true;
  const status = useApi<DeployStatus>(isSuperadmin ? '/api/v1/deploy/status' : null);

  const [passphrase, setPassphrase] = useState('');
  const [passphraseRepeat, setPassphraseRepeat] = useState('');
  const [exporting, setExporting] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [preview, setPreview] = useState<InspectResult | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [importing, setImporting] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'waiting' | 'failed'>('idle');
  const [phaseText, setPhaseText] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);

  const passOk = passphrase.trim().length >= 12;
  const repeatOk = passphraseRepeat === passphrase;
  const canImport = Boolean(preview) && passOk && confirmText.trim().toUpperCase() === 'ПЕРЕНЕСТИ';

  const totals = useMemo(() => {
    const counts = status.data?.counts ?? {};
    return Object.entries(counts).map(([key, value]) => ({
      key,
      label: COUNT_LABEL[key] ?? key,
      value,
    }));
  }, [status.data]);

  useEffect(() => {
    if (phase !== 'waiting') return;
    let cancelled = false;

    (async () => {
      for (let attempt = 0; attempt < 120 && !cancelled; attempt += 1) {
        await sleep(2000);
        try {
          const response = await fetch('/readyz', { cache: 'no-store' });
          if (response.ok) {
            setPhaseText('Готово. Перезагружаем страницу…');
            await sleep(600);
            window.location.reload();
            return;
          }
          const payload = (await response.json().catch(() => null)) as
            | { status?: string; reason?: string }
            | null;
          setPhaseText(
            payload?.status === 'maintenance'
              ? 'Переносим базу данных…'
              : 'Сервер перезапускается…',
          );
        } catch {
          setPhaseText('Сервер перезапускается…');
        }
      }
      if (!cancelled) {
        setPhase('failed');
        setPhaseText('Сервер не ответил за 4 минуты. Проверьте контейнеры и журнал.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [phase]);

  async function doExport(): Promise<void> {
    if (!passOk || !repeatOk) {
      toast.error('Парольная фраза должна быть не короче 12 символов и совпадать');
      return;
    }
    setExporting(true);
    try {
      const result = await apiDownload('/api/v1/deploy/export', {
        method: 'POST',
        body: { passphrase: passphrase.trim() },
        filenameHint: 'routx.rcbackup',
      });
      toast.success(`Файл переноса сохранён (${formatBytes(result.size)})`);
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setExporting(false);
    }
  }

  async function doInspect(): Promise<void> {
    if (!file) {
      toast.error('Выберите файл переноса');
      return;
    }
    if (!passOk) {
      toast.error('Укажите парольную фразу, с которой создавался файл');
      return;
    }
    setInspecting(true);
    setPreview(null);
    try {
      const result = await apiUploadBinary<InspectResult>('/api/v1/deploy/inspect', file, {
        'x-rc-passphrase': b64(passphrase.trim()),
      });
      setPreview(result);
      toast.success('Файл прочитан');
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setInspecting(false);
    }
  }

  async function doImport(): Promise<void> {
    if (!file || !preview || !canImport) return;
    if (
      !window.confirm(
        'Текущие данные на этом сервере будут заменены.\n\nПеред импортом сохраним страховочную копию. Продолжить?',
      )
    ) {
      return;
    }
    setImporting(true);
    setPhaseText('Готовим страховочную копию…');
    try {
      await apiUploadBinary(
        `/api/v1/deploy/import?confirm=${encodeURIComponent(confirmText.trim().toUpperCase())}`,
        file,
        { 'x-rc-passphrase': b64(passphrase.trim()) },
      );
      setPhase('restarting');
      setPhaseText('Данные приняты. Сервер перезапускается…');
      setPhase('waiting');
    } catch (caught) {
      toast.error(errorMessage(caught));
      setImporting(false);
      setPhase('idle');
      setPhaseText('');
    }
  }

  if (!isSuperadmin) {
    return (
      <div className="page">
        <PageHeader
          title="Развёртывание"
          subtitle="Обновление агента RoutX на ваших роутерах и роутерах пользователей вашей ветки."
        />
        <AgentUpdates />
      </div>
    );
  }

  if (status.error) {
    return (
      <div className="page">
        <PageHeader title="Развёртывание и перенос" />
        <ErrorBanner message={status.error} onRetry={() => void status.reload()} />
      </div>
    );
  }

  if (status.loading && !status.data) {
    return (
      <div className="page">
        <PageHeader title="Развёртывание и перенос" />
        <Spinner label="Читаем состояние…" />
      </div>
    );
  }

  const data = status.data!;
  const busy = importing || phase === 'restarting' || phase === 'waiting';

  return (
    <div className="page">
      <PageHeader
        title="Развёртывание и перенос"
        subtitle="Экспорт всех данных, переезд на другой сервер и проверка готовности. Доступно только суперадминистратору."
        actions={
          <Button variant="ghost" onClick={() => void status.reload()} busy={status.loading}>
            Обновить
          </Button>
        }
      />

      <AgentUpdates />

      {busy ? (
        <Panel title="Идёт перенос">
          <p className="page-sub">{phaseText}</p>
          <ProgressBar />
          {phase === 'failed' ? (
            <InfoBanner tone="warn">
              Автоматическое ожидание остановлено. Откройте журнал контейнера `app` и проверьте,
              что база восстановилась. Страховочная копия лежит в томе `rc_data`.
            </InfoBanner>
          ) : null}
        </Panel>
      ) : null}

      <div className="grid-2">
        <Panel title="Состояние экземпляра">
          <div className="kv">
            <span>Версия</span>
            <strong>{data.app_version}</strong>
            <span>Схема БД</span>
            <strong>
              {data.schema_version ?? '—'}
              {data.migrations_version ? ` (код: ${data.migrations_version})` : ''}
            </strong>
            <span>Публичный адрес</span>
            <strong className="mono small" style={{ wordBreak: 'break-all' }}>
              {data.public_url}
            </strong>
            <span>Домен указывает на</span>
            <strong className="mono small">
              {data.domain.error
                ? `ошибка: ${data.domain.error}`
                : data.domain.addresses.join(', ') || '—'}
            </strong>
            <span>База данных</span>
            <strong>
              {data.database.name ?? '—'} · PostgreSQL {data.database.server_version} ·{' '}
              {formatBytes(data.database.size_bytes)}
            </strong>
            <span>Ключ шифрования</span>
            <strong className="mono small">
              {data.master_key.fingerprint} · {data.master_key.source === 'file' ? 'файл' : 'env'}
            </strong>
            <span>Uptime</span>
            <strong>{Math.round(data.uptime_seconds / 60)} мин</strong>
          </div>
          <div className="row wrap">
            {totals.map((item) => (
              <span className="pill" key={item.key}>
                {item.label}: {item.value}
              </span>
            ))}
          </div>
        </Panel>

        <Panel title="Экспорт всех данных">
          <p className="page-sub">
            Один файл: база данных, мастер-ключ для расшифровки секретов, настройки экземпляра.
            Файл зашифрован парольной фразой — без неё восстановить данные нельзя.
          </p>
          <Field label="Парольная фраза (минимум 12 символов)">
            <input
              className="input"
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
              disabled={exporting || busy}
            />
          </Field>
          <Field label="Повторите парольную фразу">
            <input
              className="input"
              type="password"
              value={passphraseRepeat}
              onChange={(event) => setPassphraseRepeat(event.target.value)}
              autoComplete="new-password"
              disabled={exporting || busy}
            />
          </Field>
          {!repeatOk && passphraseRepeat.length > 0 ? (
            <p className="field-error small">Парольные фразы не совпадают</p>
          ) : null}
          <div className="row">
            <Button onClick={() => void doExport()} busy={exporting} disabled={!passOk || !repeatOk || busy}>
              Скачать файл переноса
            </Button>
          </div>
          <InfoBanner tone="warn">
            Храните файл и парольную фразу отдельно. Файл содержит ключ шифрования секретов
            роутеров.
          </InfoBanner>
        </Panel>
      </div>

      <Panel title="Импорт на этом сервере">
        <p className="page-sub">
          Загрузите файл переноса, проверьте, что он от нужного экземпляра, и подтвердите замену
          данных. Перед импортом автоматически сохраняется страховочная копия текущей базы.
        </p>

        {data.safety_backups.length > 0 ? (
          <div className="kv">
            <span>Последние страховочные копии</span>
            <strong className="small">
              {data.safety_backups
                .map((item) => `${item.name} · ${formatBytes(item.size_bytes)}`)
                .join('; ')}
            </strong>
          </div>
        ) : null}

        <div className="grid-2">
          <div className="stack">
            <Field label="Файл переноса (.rcbackup)">
              <input
                ref={fileInput}
                className="input"
                type="file"
                accept=".rcbackup,application/octet-stream"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null);
                  setPreview(null);
                  setConfirmText('');
                }}
                disabled={busy}
              />
            </Field>
            <Field label="Парольная фраза файла">
              <input
                className="input"
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                autoComplete="new-password"
                disabled={busy}
              />
            </Field>
            <div className="row">
              <Button
                variant="ghost"
                onClick={() => void doInspect()}
                busy={inspecting}
                disabled={!file || !passOk || busy}
              >
                Проверить файл
              </Button>
            </div>
          </div>

          <div className="stack">
            {preview ? (
              <>
                <div className="kv">
                  <span>Создан</span>
                  <strong>{formatDate(preview.manifest.created_at)}</strong>
                  <span>Источник</span>
                  <strong className="mono small" style={{ wordBreak: 'break-all' }}>
                    {preview.manifest.public_url}
                  </strong>
                  <span>Версия источника</span>
                  <strong>
                    {preview.manifest.app_version} · схема{' '}
                    {preview.manifest.schema_version ?? '—'}
                  </strong>
                  <span>Ключ источника</span>
                  <strong className="mono small">{preview.manifest.master_key_fingerprint}</strong>
                  <span>Содержимое</span>
                  <strong className="small">
                    {Object.entries(preview.manifest.counts)
                      .map(([key, value]) => `${COUNT_LABEL[key] ?? key}: ${value}`)
                      .join(', ')}
                  </strong>
                </div>

                {!preview.compatible ? (
                  <InfoBanner tone="warn">
                    Файл создан более новой версией панели. Обновите RoutX на этом
                    сервере и повторите.
                  </InfoBanner>
                ) : null}
                {!preview.same_domain ? (
                  <InfoBanner tone="warn">
                    Домен источника отличается от текущего. Для бесшовного переезда оставьте тот же
                    адрес в RC_PUBLIC_URL и переключите DNS после импорта.
                  </InfoBanner>
                ) : null}
                {!preview.master_key_matches ? (
                  <InfoBanner>
                    Мастер-ключ источника отличается. После импорта сервер перейдёт на ключ из
                    файла переноса — секреты роутеров останутся читаемыми.
                  </InfoBanner>
                ) : null}

                <Field label="Введите ПЕРЕНЕСТИ, чтобы заменить данные">
                  <input
                    className="input"
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    placeholder="ПЕРЕНЕСТИ"
                    disabled={busy || !preview.compatible}
                  />
                </Field>
                <div className="row">
                  <Button
                    variant="danger"
                    onClick={() => void doImport()}
                    busy={importing}
                    disabled={!canImport || !preview.compatible || busy}
                  >
                    Перенести данные
                  </Button>
                </div>
              </>
            ) : (
              <p className="muted-text small">
                После проверки здесь появится состав файла: дата, источник, количество роутеров,
                пользователей и шаблонов.
              </p>
            )}
          </div>
        </div>
      </Panel>

      <Panel title="Как переехать без простоя">
        <ol className="bullets">
          <li>
            На новом сервере установите RoutX с тем же доменом в <code>RC_PUBLIC_URL</code>{' '}
            и тем же <code>POSTGRES_PASSWORD</code>. Панель поднимется с пустой базой.
          </li>
          <li>
            На старом сервере сделайте экспорт и скачайте файл. Парольную фразу передайте
            администратору нового сервера отдельно.
          </li>
          <li>
            На новом сервере войдите в панель и импортируйте файл. Данные заменятся, сервер
            перезапустится, ключ шифрования переедет вместе с данными.
          </li>
          <li>
            Проверьте, что роутеры онлайн и задачи проходят. Агенты подключаются исходящим
            соединением к домену, поэтому после переключения DNS они переподключатся сами.
          </li>
          <li>
            Переключите DNS на новый сервер (TTL лучше снизить заранее). Старый сервер оставьте
            включённым на сутки как страховку.
          </li>
          <li>
            После проверки остановите старый сервер. Сессии пользователей сохраняются в базе,
            повторный вход не нужен.
          </li>
        </ol>
        <InfoBanner>
          Перенос не требует скриптов: экспорт, импорт и перезапуск выполняются из панели. Если
          импорт прервётся, база откатится автоматически из дампа, снятого перед заменой.
        </InfoBanner>
      </Panel>
    </div>
  );
}
