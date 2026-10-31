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

export function TemplatesPage() {
  const toast = useToast();
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
        title="Шаблоны конфигурации"
        subtitle="Полный набор управляемых параметров с явными исключениями. Ревизии неизменяемы, применение — только через diff."
        actions={<Button onClick={() => setCreateOpen(true)}>Новый шаблон</Button>}
      />

      {templates.error ? <ErrorBanner message={templates.error} onRetry={() => void templates.reload()} /> : null}

      <Panel
        title="Мои шаблоны"
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
                  <th>Ревизия</th>
                  <th>Назначен</th>
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
                    <td>{template.current_revision}</td>
                    <td>{template.assignment_count > 0 ? `${template.assignment_count} шт.` : '—'}</td>
                    <td className="muted-text small">
                      {formatDate(template.archived_at ?? template.updated_at)}
                    </td>
                    <td className="row-actions">
                      {template.archived_at ? (
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
                      ) : (
                        <>
                          <Link className="btn btn-ghost btn-sm" to={`/templates/${template.id}`}>
                            Открыть
                          </Link>
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
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Правила шаблонов">
        <ul className="bullets">
          <li>
            Шаблон описывает только управляемые параметры. Секретные пути (ключи, пароли, URL
            подписок) в шаблон не попадают.
          </li>
          <li>Списки заменяются целиком; значение <code>null</code> удаляет параметр.</li>
          <li>
            Индивидуальные VLESS/Sub-подключения никогда не перезаписываются: создавать и удалять
            можно только секции <code>urltest</code>.
          </li>
          <li>Перед применением обязательны diff, подтверждение и снимок.</li>
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
