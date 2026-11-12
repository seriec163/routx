import { useState } from 'react';
import {
  browserSupportsWebAuthn,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import {
  Button,
  ErrorBanner,
  Field,
  InfoBanner,
  Modal,
  Spinner,
  TextInput,
  useToast,
} from '../components/ui';
import { api, downloadText, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import { useApi } from '../lib/useApi';

interface PasskeyItem {
  id: string;
  name: string;
  device_type: string | null;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

interface PasskeyList {
  items: PasskeyItem[];
}

interface RecoveryInfo {
  remaining: number;
  created_at: string | null;
}

export function PasskeyPanel() {
  const toast = useToast();
  const passkeys = useApi<PasskeyList>('/api/v1/auth/webauthn/credentials');
  const [name, setName] = useState('iPhone');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const supported = browserSupportsWebAuthn() && window.isSecureContext;

  async function addPasskey(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { challenge_id, options } = await api<{
        challenge_id: string;
        options: PublicKeyCredentialCreationOptionsJSON;
      }>('/api/v1/auth/webauthn/register/options', {
        method: 'POST',
        body: { password },
      });

      let response;
      try {
        response = await startRegistration({ optionsJSON: options });
      } catch (caught) {
        if (caught instanceof Error && caught.name === 'NotAllowedError') {
          setError('Добавление passkey отменено.');
        } else {
          setError('Не удалось создать passkey. Проверьте Face ID / Touch ID и повторите.');
        }
        return;
      }

      await api('/api/v1/auth/webauthn/register/verify', {
        method: 'POST',
        body: { challenge_id, response, name: name.trim() || 'Passkey' },
      });
      setPassword('');
      toast.success('Passkey добавлен');
      await passkeys.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function removePasskey(item: PasskeyItem): Promise<void> {
    if (!password) {
      setError('Введите текущий пароль, чтобы удалить passkey.');
      return;
    }
    setRemoving(item.id);
    setError(null);
    try {
      await api(`/api/v1/auth/webauthn/credentials/${item.id}/remove`, {
        method: 'POST',
        body: { password },
      });
      toast.success('Passkey удалён');
      setPassword('');
      await passkeys.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setRemoving(null);
    }
  }

  if (!supported) {
    return (
      <InfoBanner tone="warn">
        Passkey работает только по HTTPS в современном браузере. Откройте панель по домену
        `https://…`, а не по IP-адресу.
      </InfoBanner>
    );
  }

  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}

      {passkeys.loading && !passkeys.data ? (
        <Spinner label="Читаем passkey…" />
      ) : passkeys.data && passkeys.data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Устройство</th>
                <th>Добавлен</th>
                <th>Последний вход</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {passkeys.data.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.name}</strong>
                    <div className="muted-text small">
                      {item.backed_up ? 'синхронизируется' : 'только это устройство'}
                    </div>
                  </td>
                  <td className="small">{formatDate(item.created_at)}</td>
                  <td className="small">{formatDate(item.last_used_at)}</td>
                  <td className="row-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={removing === item.id}
                      onClick={() => void removePasskey(item)}
                    >
                      Удалить
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted-text">Passkey пока не добавлен.</p>
      )}

      <p className="page-sub">
        Passkey — дополнительный вход по Face ID / Touch ID. Пароль и 2FA остаются рабочими.
        Добавление и удаление подтверждаются текущим паролем.
      </p>

      <div className="grid-2">
        <Field label="Название устройства">
          <TextInput value={name} onChange={setName} placeholder="iPhone" />
        </Field>
        <Field label="Текущий пароль" hint="Пароль не сохраняется.">
          <TextInput
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
        </Field>
      </div>

      <Button
        onClick={() => void addPasskey()}
        busy={busy}
        disabled={!password || !supported}
      >
        Добавить passkey (Face ID / Touch ID)
      </Button>
    </>
  );
}

export function RecoveryCodesPanel() {
  const toast = useToast();
  const info = useApi<RecoveryInfo>('/api/v1/auth/recovery-codes');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ codes: string[] }>('/api/v1/auth/recovery-codes', {
        method: 'POST',
        body: { password },
      });
      setCodes(response.codes);
      setPassword('');
      toast.success('Резервные коды созданы');
      await info.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function download(): void {
    if (!codes) return;
    downloadText(
      'routx-recovery-codes.txt',
      [
        'RoutX — резервные коды восстановления',
        'Каждый код одноразовый. Храните вне сервера.',
        '',
        ...codes,
        '',
      ].join('\n'),
    );
  }

  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}

      <div className="kv">
        <span>Осталось кодов</span>
        <strong>{info.data?.remaining ?? 0} из 10</strong>
        <span>Созданы</span>
        <strong>{info.data?.created_at ? formatDate(info.data.created_at) : '—'}</strong>
      </div>

      {info.data && info.data.remaining === 0 ? (
        <InfoBanner tone="warn">
          Резервных кодов нет. Создайте набор сейчас — он понадобится, если потеряете passkey и
          телефон с 2FA.
        </InfoBanner>
      ) : null}

      <p className="page-sub">
        Каждый код даёт полное восстановление: сброс пароля, отключение 2FA и удаление всех
        passkey. Коды показываются один раз. Перевыпуск отменяет старые коды.
      </p>

      <Field label="Текущий пароль" hint="Нужен для создания нового набора кодов.">
        <TextInput
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
      </Field>

      <Button onClick={() => void generate()} busy={busy} disabled={!password}>
        {info.data && info.data.remaining > 0 ? 'Перевыпустить 10 кодов' : 'Создать 10 кодов'}
      </Button>

      {codes ? (
        <Modal
          wide
          title="Резервные коды"
          onClose={() => setCodes(null)}
          footer={
            <>
              <Button variant="ghost" onClick={download}>
                Скачать .txt
              </Button>
              <Button onClick={() => setCodes(null)}>Я сохранил</Button>
            </>
          }
        >
          <InfoBanner tone="warn">
            Коды показываются только сейчас. Скопируйте или скачайте их и храните вне сервера.
            После закрытия окна увидеть их снова нельзя.
          </InfoBanner>
          <pre className="code-block">{codes.join('\n')}</pre>
        </Modal>
      ) : null}
    </>
  );
}
