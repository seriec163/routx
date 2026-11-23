import { Link } from '../../components/link';
import { Button, Empty, ErrorBanner, InfoBanner, Panel, Spinner } from '../../components/ui';
import { formatDate } from '../../lib/format';
import type { RouterRecord, SingBoxVariant, SingBoxVersion } from '../../lib/types';
import type { ApiState } from '../../lib/useApi';

export function SingBoxTab(props: {
  router: RouterRecord;
  variants: ApiState<{ items: SingBoxVariant[] }>;
  versions: ApiState<{ items: SingBoxVersion[] }>;
  currentVariantId: string;
  selectedVariantId: string;
  onSelectVariant: (id: string) => void;
  selectedVariant: SingBoxVariant | null;
  selectedVariantActive: boolean;
  busy: boolean;
  canMutate: boolean;
  isAdmin: boolean;
  isSuperadmin: boolean;
  onCheck: () => void;
  onRollback: () => void;
  onRefreshCatalog: () => void;
  onInstallVariant: (variant: SingBoxVariant) => void;
  onInstallVersion: (version: SingBoxVersion) => void;
}) {
  const { router, variants, versions, busy, canMutate, selectedVariant } = props;
  return (
    <div className="stack">
      {router.product === 'tachyon' ? (
        <InfoBanner>
          Tachyon 1.8 и новее используют собственное ядро <strong>tachyon-core</strong>.
          Варианты sing-box здесь не применяются — обновляйте модуль и ядро на вкладке
          «Обновления».
        </InfoBanner>
      ) : null}
      <Panel
        title="Вариант sing-box"
        subtitle="Prokop удаляет текущий пакет перед установкой нового варианта, затем ставит новый. При неудаче RoutX попробует вернуть предыдущий."
      >
        <div className="kv">
          <span>Сейчас</span>
          <strong>
            {router.sing_box_variant ? `${router.sing_box_variant} · ` : ''}
            {router.sing_box_version ?? 'не установлен'}
          </strong>
          <span>Предыдущая</span>
          <strong>
            {router.sing_box_previous_variant || router.sing_box_previous_version
              ? `${router.sing_box_previous_variant ?? ''} ${router.sing_box_previous_version ?? ''}`.trim()
              : 'нет'}
          </strong>
        </div>
        <div className="variant-grid">
          {(variants.data?.items ?? []).map((variant) => {
            const active = props.currentVariantId === variant.id;
            const selected = props.selectedVariantId === variant.id;
            return (
              <button
                key={variant.id}
                type="button"
                aria-pressed={selected}
                className={`variant-card ${active ? 'variant-card-active' : ''} ${
                  selected ? 'variant-card-selected' : ''
                }`}
                disabled={busy}
                onClick={() => props.onSelectVariant(variant.id)}
              >
                <strong>{variant.label}</strong>
                <span>{variant.description}</span>
                {active ? <em>установлен</em> : selected ? <em>выбран</em> : null}
              </button>
            );
          })}
        </div>
        <p className="muted-text small" style={{ marginTop: 0 }}>
          Выберите вариант — ниже появятся доступные версии или способ установки.
        </p>
        {variants.error ? <ErrorBanner message={variants.error} /> : null}
        <div className="row">
          <Button
            size="sm"
            variant="ghost"
            onClick={props.onCheck}
            busy={busy}
            disabled={!canMutate}
          >
            Проверить обновления
          </Button>
          <Button
            size="sm"
            variant="subtle"
            onClick={props.onRollback}
            disabled={
              !canMutate ||
              (!router.sing_box_previous_variant && !router.sing_box_previous_version)
            }
          >
            Вернуть предыдущую
          </Button>
        </div>
      </Panel>

      <Panel
        title="Текущая версия"
        subtitle="Вариант и версия sing-box на роутере."
        actions={
          <Link className="btn btn-ghost btn-sm" to="/rollouts">
            Поэтапное обновление
          </Link>
        }
      >
        <div className="kv">
          <span>Версия</span>
          <strong>{router.sing_box_version ?? 'не установлен'}</strong>
          <span>Вариант</span>
          <strong>{router.sing_box_variant ?? '—'}</strong>
          <span>Проверка обновлений</span>
          <strong>{props.isAdmin ? 'доступна' : 'только администратор'}</strong>
        </div>
      </Panel>

      <Panel
        title={`Версии для ${selectedVariant?.label ?? 'выбранного варианта'}`}
        subtitle={
          props.selectedVariantId === 'extended'
            ? 'Доступные версии Extended из официального каталога. При установке текущий пакет удаляется, затем ставится выбранная версия.'
            : props.selectedVariantId === 'extended_compressed'
              ? 'Compressed ставится последней сборкой из каталога Extended. Выбор конкретной версии для compressed не поддерживается: Prokop при выборе версии переключает на Extended.'
              : 'Этот вариант ставится последней версией из пакетного репозитория Prokop/Forkop. Список конкретных версий для него недоступен.'
        }
        actions={
          props.isSuperadmin && props.selectedVariantId === 'extended' ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={props.onRefreshCatalog}
              busy={busy}
            >
              Обновить каталог
            </Button>
          ) : null
        }
      >
        {variants.loading && !variants.data ? (
          <Spinner />
        ) : props.selectedVariantId === 'extended' ? (
          versions.loading && !versions.data ? (
            <Spinner />
          ) : (versions.data?.items.length ?? 0) === 0 ? (
            <div className="stack">
              <Empty>
                Каталог пуст. Нажмите «Обновить каталог» или обновите его на странице
                sing-box.
              </Empty>
              <div className="row">
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={!canMutate || busy}
                  onClick={() => selectedVariant && props.onInstallVariant(selectedVariant)}
                >
                  Установить последнюю Extended
                </Button>
              </div>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Версия</th>
                  <th>Опубликована</th>
                  <th>SHA-256</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {versions.data!.items.slice(0, 20).map((version) => (
                  <tr key={version.tag}>
                    <td>
                      {version.tag}
                      {version.tag === router.sing_box_version ? (
                        <span className="muted-text small"> · установлена</span>
                      ) : null}
                    </td>
                    <td className="muted-text small">{formatDate(version.published_at)}</td>
                    <td className="mono small">{version.asset_sha256?.slice(0, 16) ?? '—'}…</td>
                    <td>
                      <Button
                        size="sm"
                        variant={version.tag === router.sing_box_version ? 'ghost' : 'primary'}
                        disabled={!canMutate || version.tag === router.sing_box_version}
                        onClick={() => props.onInstallVersion(version)}
                      >
                        Установить
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : props.selectedVariantId === 'extended_compressed' ? (
          <div className="stack">
            {versions.data?.items[0] ? (
              <p className="muted-text small">
                Последний релиз Extended в каталоге:{' '}
                <strong>{versions.data.items[0].tag}</strong>. Compressed-сборка ставится из
                этого релиза.
              </p>
            ) : null}
            <div className="row">
              <Button
                size="sm"
                variant="subtle"
                disabled={!canMutate || busy || props.selectedVariantActive}
                onClick={() => selectedVariant && props.onInstallVariant(selectedVariant)}
              >
                {props.selectedVariantActive
                  ? 'Установлен'
                  : `Установить последнюю ${selectedVariant?.label ?? 'compressed'}`}
              </Button>
            </div>
          </div>
        ) : props.selectedVariantId ? (
          <div className="row">
            <Button
              size="sm"
              variant="subtle"
              disabled={!canMutate || busy || props.selectedVariantActive}
              onClick={() => selectedVariant && props.onInstallVariant(selectedVariant)}
            >
              {props.selectedVariantActive
                ? 'Установлен'
                : `Установить последнюю ${selectedVariant?.label ?? ''}`}
            </Button>
          </div>
        ) : (
          <Spinner />
        )}
      </Panel>
    </div>
  );
}
