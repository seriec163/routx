import { Empty, Spinner } from '../../components/ui';
import { formatDate } from '../../lib/format';
import type { CredentialInfo } from '../../lib/types';
import { useApi } from '../../lib/useApi';

export function CredentialPanel({ routerId }: { routerId: string }) {
  const info = useApi<CredentialInfo>(`/api/v1/routers/${routerId}/credential-info`);
  const credential = info.data?.credential;
  if (info.loading && !info.data) return <Spinner />;
  if (!credential) return <Empty>Агент ещё не привязан.</Empty>;
  return (
    <div className="kv">
      <span>Префикс токена</span>
      <strong className="mono">{credential.prefix}</strong>
      <span>Создан</span>
      <strong>{formatDate(credential.created_at)}</strong>
      <span>Ротирован</span>
      <strong>{formatDate(credential.rotated_at)}</strong>
      <span>Отозван</span>
      <strong>{formatDate(credential.revoked_at)}</strong>
    </div>
  );
}
