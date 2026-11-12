import { useState } from 'react';
import { Link } from '../components/link';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBanner,
  Field,
  Modal,
  PageHeader,
  Panel,
  Spinner,
  TextInput,
  useToast,
} from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate } from '../lib/format';
import { navigate } from '../lib/router';
import type { TemplateListItem } from '../lib/types';
import { useApi } from '../lib/useApi';
import { useSession } from '../session';

export function TemplatesPage() {
  const toast = useToast();
  const { me } = useSession();
  const templates = useApi<{ items: TemplateListItem[] }>('/api/v1/templates?include_archived=true');
  const [view, setView] = useState<'active' | 'archive'>('active');
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<TemplateListItem | null>(null);
  const [purging, setPurging] = useState<TemplateListItem | null>(null);
  const [purgeName, setPurgeName] = useState('');

  const allItems = templates.data?.items ?? [];
  const activeItems = allItems.filter((item) => !item.archived_at);
  const archivedItems = allItems.filter((item) => item.archived_at);
  const items = view === 'active' ? activeItems : archivedItems;

  function canManage(template: TemplateListItem): boolean {
    return me?.permissions.is_superadmin === true || template.owner_id === me?.user.id;
  }

  function isMine(template: TemplateListItem): boolean {
    return template.owner_id === me?.user.id;
  }

  async function toggleShare(template: TemplateListItem): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/v1/templates/${template.id}`, {
        method: 'PATCH',
        body: { shared: !template.shared },
      });
      toast.success(
        template.shared
          ? 'Шаблон больше не виден другим пользователям'
          : 'Шаблон открыт всем пользователям панели',
      );
      await templates.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ template: { id: string } }>('/api/v1/templates', {
        method: 'POST',
        body: {
          name,
          description: description || null,
          payload: {
            action: 'connection',
            enabled: '1',
            resources: {},
            manual_domains: [],
            manual_ips: [],
            settings: {},
            sections: {},
            urltest: {},
            section_interface: {},
            subscription_url: {},
            create_urltest: [],
            create_sections: [],
            manual_entries: {},
          },
          exclusions: [],
        },
      });
      toast.success('Шаблон создан');
      setCreateOpen(false);
      setName('');
      setDescription('');
      navigate(`/templates/${created.template.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function archive(): Promise<void> {
    if (!archiving) return;
    setBusy(true);
    try {
      await api(`/api/v1/templates/${archiving.id}`, { method: 'DELETE' });
      toast.success('Шаблон перемещён в архив');
      setArchiving(null);
      await templates.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function restore(template: TemplateListItem): Promise<void> {
    setBusy(true);
    try {
      await api(`/api/v1/templates/${template.id}/restore`, { method: 'POST' });
      toast.success('Шаблон восстановлен из архива');
      await templates.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function purge(): Promise<void> {
    if (!purging || purgeName.trim() !== purging.name) return;
    setBusy(true);
    try {
      await api(`/api/v1/templates/${purging.id}?purge=true`, { method: 'DELETE' });
      toast.success('Шаблон удалён навсегда');
      setPurging(null);
      setPurgeName('');
      await templates.reload();
    } catch (caught) {
      toast.error(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Шаблоны"
        subtitle="Готовые наборы действия и настроек. Ресурсы можно добавить в шаблон или выбрать уже в правиле на роутере. Имени секции в шаблоне нет."
        actions={<Button onClick={() => setCreateOpen(true)}>Новый шаблон</Button>}
      />

      {templates.error ? <ErrorBanner message={templates.error} onRetry={() => void templates.reload()} /> : null}

      <Panel
        title="Шаблоны и общий доступ"
        actions={
          <div className="toolbar">
            <div className="segmented">
              <button
                type="button"
                className={view === 'active' ? 'seg-active' : ''}
                onClick={() => setView('active')}
              >
                Активные ({activeItems.length})
              </button>
              <button
                type="button"
                className={view === 'archive' ? 'seg-active' : ''}
                onClick={() => setView('archive')}
              >
                Архив ({archivedItems.length})
              </button>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void templates.reload()} busy={templates.loading}>
              Обновить
            </Button>
          </div>
        }
      >
        {templates.loading && !templates.data ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty>
            {view === 'archive'
              ? 'Архив пуст. Архивированные шаблоны появятся здесь.'
              : 'Шаблонов пока нет. Создайте первый и опишите желаемые параметры.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Доступ</th>
                  <th>Ревизия</th>
                  <th>{view === 'archive' ? 'В архиве' : 'Обновлён'}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((template) => (
                  <tr key={template.id}>
                    <td>
                      {template.archived_at ? (
                        template.name
                      ) : (
                        <Link to={`/templates/${template.id}`}>{template.name}</Link>
                      )}
                      {template.description ? (
                        <div className="muted-text small">{template.description}</div>
                      ) : null}
                    </td>
                    <td>
                      {template.shared ? (
                        <span className="badge badge-ok">Общий</span>
                      ) : (
                        <span className="badge">Личный</span>
                      )}
                      {template.shared && !isMine(template) && template.owner_email ? (
                        <div className="muted-text small">{template.owner_email}</div>
                      ) : null}
                    </td>
                    <td>{template.current_revision}</td>
                    <td className="muted-text small">
                      {formatDate(template.archived_at ?? template.updated_at)}
                    </td>
                    <td className="row-actions">
                      {template.archived_at ? (
                        canManage(template) ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => void restore(template)} busy={busy}>
                              Восстановить
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => {
                                setPurging(template);
                                setPurgeName('');
                              }}
                            >
                              Удалить навсегда
                            </Button>
                          </>
                        ) : null
                      ) : (
                        <>
                          <Link className="btn btn-ghost btn-sm" to={`/templates/${template.id}`}>
                            {canManage(template) ? 'Открыть' : 'Посмотреть'}
                          </Link>
                          {canManage(template) ? (
                            <>
                              <Button
                                size="sm"
                                variant="subtle"
                                onClick={() => void toggleShare(template)}
                                busy={busy}
                              >
                                {template.shared ? 'Сделать личным' : 'Сделать общим'}
                              </Button>
                              <Button size="sm" variant="subtle" onClick={() => setArchiving(template)}>
                                В архив
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => {
                                  setPurging(template);
                                  setPurgeName('');
                                }}
                              >
                                Удалить
                              </Button>
                            </>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Как это работает">
        <ul className="bullets">
          <li>
            Шаблон — это действие (через VPN, в обход, блок, только DNS), список ресурсов и
            глобальные настройки. Имени секции в нём нет.
          </li>
          <li>
            На странице роутера откройте «Правила и подключения», создайте правило и выберите
            шаблон — форма заполнится его значениями.
          </li>
          <li>
            Подписки и VLESS-ссылки хранятся отдельно от шаблона и никогда им не перезаписываются.
          </li>
          <li>
            Кнопка «Сделать общим» открывает шаблон всем пользователям панели. Они видят его в
            списке и могут применять к своим роутерам, но редактировать и удалять может только
            владелец.
          </li>
          <li>
            Старые назначения шаблонов на роутеры больше не используются: шаблон применяется к
            выбранному правилу, а не ко всему роутеру.
          </li>
          <li>Перед применением правила показывается diff; перед записью создаётся снимок.</li>
        </ul>
      </Panel>

      {createOpen ? (
        <Modal
          title="Новый шаблон"
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={busy}>
                Отмена
              </Button>
              <Button onClick={() => void create()} busy={busy} disabled={!name.trim()}>
                Создать
              </Button>
            </>
          }
        >
          <p className="page-sub">
            Создаётся пустой шаблон с ревизией 1. Параметры добавите в редакторе.
          </p>
          {error ? <ErrorBanner message={error} /> : null}
          <Field label="Название">
            <TextInput value={name} onChange={setName} placeholder="Базовая конфигурация" required />
          </Field>
          <Field label="Описание" hint="Необязательно">
            <TextInput value={description} onChange={setDescription} placeholder="Для чего этот шаблон" />
          </Field>
        </Modal>
      ) : null}

      {archiving ? (
        <ConfirmDialog
          title="Архивировать шаблон?"
          danger
          busy={busy}
          confirmLabel="В архив"
          onCancel={() => setArchiving(null)}
          onConfirm={() => void archive()}
          message={
            <>
              <p>
                Шаблон <strong>{archiving.name}</strong> будет архивирован. Назначения на роутерах
                перестанут отображаться, но уже применённая конфигурация на устройствах не изменится.
              </p>
              <p className="muted-text">
                Шаблон можно будет восстановить из архива вместе с назначениями и ревизиями.
              </p>
            </>
          }
        />
      ) : null}

      {purging ? (
        <Modal
          title="Удалить шаблон навсегда?"
          onClose={() => {
            setPurging(null);
            setPurgeName('');
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setPurging(null);
                  setPurgeName('');
                }}
                disabled={busy}
              >
                Отмена
              </Button>
              <Button
                variant="danger"
                onClick={() => void purge()}
                busy={busy}
                disabled={purgeName.trim() !== purging.name}
              >
                Удалить навсегда
              </Button>
            </>
          }
        >
          <p>
            Шаблон <strong>{purging.name}</strong>, все его ревизии и назначения будут удалены из
            базы. Это действие необратимо.
          </p>
          <p className="muted-text">
            Уже применённая конфигурация на роутерах не изменится. История применений останется, но
            потеряет ссылку на шаблон.
          </p>
          <Field label={`Для подтверждения введите имя «${purging.name}»`}>
            <TextInput value={purgeName} onChange={setPurgeName} placeholder={purging.name} />
          </Field>
        </Modal>
      ) : null}
    </div>
  );
}
