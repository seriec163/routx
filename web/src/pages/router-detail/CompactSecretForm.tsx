import { useState } from 'react';
import {
  Button,
  ErrorBanner,
  Field,
  InfoBanner,
  Select,
  TextInput,
  useToast,
} from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import type { ConnectionSecretPreview } from '../../lib/types';

export function CompactSecretForm(props: {
  kind: 'subscription' | 'vless';
  onGenerated: (secret: string) => void;
}) {
  const toast = useToast();
  const [host, setHost] = useState('');
  const [port, setPort] = useState('443');
  const [credential, setCredential] = useState('');
  const [path, setPath] = useState('');
  const [sni, setSni] = useState('');
  const [transport, setTransport] = useState<'tcp' | 'ws' | 'grpc' | 'http'>('ws');
  const [security, setSecurity] = useState<'tls' | 'none'>('tls');
  const [flow, setFlow] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    secret: string;
    length: number;
    preview: ConnectionSecretPreview;
  } | null>(null);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{
        secret: string;
        length: number;
        preview: ConnectionSecretPreview;
      }>('/api/v1/connection-secrets', {
        method: 'POST',
        body: {
          kind: props.kind,
          host: host.trim(),
          port: Number(port),
          credential: credential.trim() || undefined,
          path: path.trim() || undefined,
          sni: sni.trim() || undefined,
          flow: props.kind === 'vless' ? flow.trim() || undefined : undefined,
          transport: props.kind === 'vless' ? transport : undefined,
          security: props.kind === 'vless' ? security : undefined,
        },
      });
      setResult(response);
      props.onGenerated(response.secret);
    } catch (caught) {
      setError(errorMessage(caught));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <InfoBanner>
        Секрет шифруется AES-256-GCM и содержит только домен/IP, порт и учётные данные.
        Ссылка на провайдера при этом не нужна.
      </InfoBanner>
      <div className="grid-2 grid-2-compact">
        <Field label="Домен или IP" hint="Куда подключаться.">
          <TextInput value={host} onChange={setHost} placeholder="vpn.example.com или 203.0.113.10" />
        </Field>
        <Field label="Порт" hint="1–65535.">
          <TextInput type="number" min={1} max={65535} value={port} onChange={setPort} />
        </Field>
        <Field
          label={props.kind === 'subscription' ? 'Токен подписки' : 'UUID или пароль'}
          hint={props.kind === 'subscription' ? 'Необязательно, если токен уже в пути.' : 'Обязательно для VLESS.'}
        >
          <TextInput
            value={credential}
            onChange={setCredential}
            placeholder={props.kind === 'subscription' ? 'Токен провайдера' : 'UUID или пароль'}
          />
        </Field>
        <Field
          label="Путь"
          hint={
            props.kind === 'subscription'
              ? 'Например, /sub/abc?token=…'
              : 'Путь для ws/http или serviceName для grpc.'
          }
        >
          <TextInput value={path} onChange={setPath} placeholder="/sub/abc или /ws" />
        </Field>
        {props.kind === 'vless' ? (
          <>
            <Field label="SNI" hint="По умолчанию равен домену.">
              <TextInput value={sni} onChange={setSni} placeholder="vpn.example.com" />
            </Field>
            <Field label="Транспорт">
              <Select
                value={transport}
                onChange={(value) => setTransport(value as 'tcp' | 'ws' | 'grpc' | 'http')}
              >
                <option value="ws">WebSocket</option>
                <option value="tcp">TCP</option>
                <option value="grpc">gRPC</option>
                <option value="http">HTTP/2</option>
              </Select>
            </Field>
            <Field label="Безопасность">
              <Select value={security} onChange={(value) => setSecurity(value as 'tls' | 'none')}>
                <option value="tls">TLS</option>
                <option value="none">Без TLS</option>
              </Select>
            </Field>
            <Field label="Flow" hint="Например, xtls-rprx-vision. Обычно пусто.">
              <TextInput value={flow} onChange={setFlow} placeholder="xtls-rprx-vision" />
            </Field>
          </>
        ) : null}
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      <div className="row">
        <Button
          size="sm"
          onClick={() => void generate()}
          busy={busy}
          disabled={!host.trim() || (props.kind === 'vless' && !credential.trim())}
        >
          Сгенерировать секрет
        </Button>
        {result ? (
          <span className="muted-text small">
            {result.length} символов · {result.preview.host}:{result.preview.port}
          </span>
        ) : null}
      </div>
      {result ? (
        <>
          <div className="row">
            <code className="code-block small inline-code compact-secret-value">{result.secret}</code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void copyText(result.secret).then((ok) => {
                  if (ok) toast.success('Секрет скопирован');
                  else toast.error('Не удалось скопировать секрет');
                });
              }}
            >
              Скопировать
            </Button>
          </div>
          <p className="muted-text small">
            {result.preview.kind === 'subscription' ? 'Подписка' : 'VLESS'} ·{' '}
            {result.preview.credential_masked}
            {result.preview.path ? ` · ${result.preview.path}` : ''}
          </p>
        </>
      ) : null}
    </div>
  );
}
