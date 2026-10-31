import type { DiffItem } from '../lib/types';
import { Badge } from './ui';

const OP_TONE = {
  add: 'ok',
  change: 'warn',
  delete: 'bad',
} as const;

const OP_LABEL = {
  add: 'добавить',
  change: 'изменить',
  delete: 'удалить',
} as const;

function renderValue(value: DiffItem['before']): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length === 0 ? '[] (пустой список)' : value.join('\n');
  return value;
}

export function DiffView({ items }: { items: DiffItem[] }) {
  if (items.length === 0) {
    return <p className="empty">Различий нет — конфигурация уже совпадает.</p>;
  }

  const counts = {
    add: items.filter((item) => item.op === 'add').length,
    change: items.filter((item) => item.op === 'change').length,
    delete: items.filter((item) => item.op === 'delete').length,
  };

  return (
    <div className="diff">
      <div className="diff-summary">
        <Badge tone="ok">{counts.add} добавить</Badge>
        <Badge tone="warn">{counts.change} изменить</Badge>
        <Badge tone="bad">{counts.delete} удалить</Badge>
        <span className="muted-text">Всего параметров: {items.length}</span>
      </div>
      <div className="diff-list">
        {items.map((item) => (
          <div key={`${item.op}:${item.path}`} className={`diff-item diff-${item.op}`}>
            <header>
              <Badge tone={OP_TONE[item.op]}>{OP_LABEL[item.op]}</Badge>
              <code>{item.path}</code>
            </header>
            <div className="diff-values">
              {item.op !== 'add' ? (
                <div className="diff-side">
                  <span className="diff-label">Было</span>
                  <pre>{renderValue(item.before)}</pre>
                </div>
              ) : null}
              {item.op !== 'delete' ? (
                <div className="diff-side">
                  <span className="diff-label">Станет</span>
                  <pre>{renderValue(item.after)}</pre>
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DiffBadge({ items }: { items: DiffItem[] }) {
  const counts = {
    add: items.filter((item) => item.op === 'add').length,
    change: items.filter((item) => item.op === 'change').length,
    delete: items.filter((item) => item.op === 'delete').length,
  };
  return (
    <span className="diff-badge">
      <span className="diff-add">+{counts.add}</span>
      <span className="diff-change">~{counts.change}</span>
      <span className="diff-delete">−{counts.delete}</span>
    </span>
  );
}
