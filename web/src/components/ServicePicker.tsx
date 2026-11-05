import { useMemo, useState } from 'react';
import type { RoutingGroup, RoutingService } from '../lib/types';

const POPULAR_ICONS: Record<string, string> = {
  youtube: '▶',
  discord: '💬',
  telegram: '✈',
  meta: '◎',
  twitter: '𝕏',
  whatsapp: '✆',
  tiktok: '♪',
  spotify: '♫',
  twitch: '🎮',
  netflix: '🎬',
  github: '⌘',
  cloudflare: '☁',
  openai: '🤖',
  anthropic: '🅰',
  google_ai: '✦',
  steam: '🎮',
  roblox: '▣',
  speedtest: '⚡',
  crypto: '₿',
  torrent: '⇣',
};

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace('.0', '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace('.0', '')}k`;
  return String(value);
}

function deliveryLabel(service: RoutingService): string {
  if (service.delivery === 'native') return 'встроен';
  if (service.delivery === 'domains') return 'домены';
  if (service.delivery === 'unsupported') return 'недоступен';
  return 'rule-set';
}

function actionLabel(value: string | undefined): string {
  if (value === 'direct') return 'напрямую';
  if (value === 'block') return 'блок';
  return 'в прокси';
}

function countLabel(service: RoutingService): string {
  const counts = service.counts;
  if (!counts) return '';
  const parts: string[] = [];
  if (counts.domains > 0) parts.push(`${formatCount(counts.domains)} дом.`);
  if (counts.subnets > 0) parts.push(`${formatCount(counts.subnets)} подс.`);
  return parts.join(' · ');
}

export function ServicePicker(props: {
  services: RoutingService[];
  groups?: RoutingGroup[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [activeGroup, setActiveGroup] = useState('all');

  const groups = useMemo(() => {
    if (props.groups && props.groups.length > 0) return props.groups;
    const seen = new Map<string, RoutingGroup>();
    for (const service of props.services) {
      if (!service.group || seen.has(service.group)) continue;
      seen.set(service.group, {
        id: service.group,
        label: service.group_label ?? service.group,
        icon: service.group_icon ?? '•',
      });
    }
    return [...seen.values()];
  }, [props.groups, props.services]);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const service of props.services) {
      if (!service.group) continue;
      counts.set(service.group, (counts.get(service.group) ?? 0) + 1);
    }
    return counts;
  }, [props.services]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return props.services.filter((service) => {
      if (activeGroup !== 'all' && service.group !== activeGroup) return false;
      if (needle === '') return true;
      return [service.id, service.label, service.title, service.description, service.note]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [props.services, activeGroup, query]);

  const selectedSet = new Set(props.selected);

  function toggle(id: string): void {
    props.onChange(
      selectedSet.has(id) ? props.selected.filter((item) => item !== id) : [...props.selected, id],
    );
  }

  return (
    <div className="service-picker">
      <div className="service-picker-toolbar">
        <input
          className="input service-picker-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Поиск: ChatGPT, YouTube, игры, регионы…"
          aria-label="Поиск списка"
        />
        <span className="service-picker-count">
          {props.selected.length > 0 ? `Выбрано: ${props.selected.length}` : 'Ничего не выбрано'}
        </span>
        {props.selected.length > 0 ? (
          <button
            type="button"
            className="service-picker-clear"
            onClick={() => props.onChange([])}
          >
            Сбросить
          </button>
        ) : null}
      </div>

      <div className="service-picker-groups" role="tablist" aria-label="Категории списков">
        <button
          type="button"
          role="tab"
          aria-selected={activeGroup === 'all'}
          className={`service-group-tab ${activeGroup === 'all' ? 'service-group-tab-on' : ''}`}
          onClick={() => setActiveGroup('all')}
        >
          Все <span>{props.services.length}</span>
        </button>
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            role="tab"
            aria-selected={activeGroup === group.id}
            className={`service-group-tab ${activeGroup === group.id ? 'service-group-tab-on' : ''}`}
            onClick={() => setActiveGroup(group.id)}
          >
            <span aria-hidden="true">{group.icon}</span> {group.label}
            <span>{groupCounts.get(group.id) ?? 0}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="muted-text small">По запросу «{query}» ничего не найдено.</p>
      ) : (
        <div className="service-picker-grid">
          {filtered.map((service) => {
            const active = selectedSet.has(service.id);
            const icon =
              POPULAR_ICONS[service.id] ?? service.group_icon ?? '•';
            return (
              <button
                key={service.id}
                type="button"
                className={`service-card ${active ? 'service-card-on' : ''}`}
                onClick={() => toggle(service.id)}
                title={service.title ?? service.label}
                aria-pressed={active}
              >
                <span className="service-card-head">
                  <span className="service-card-icon" aria-hidden="true">
                    {icon}
                  </span>
                  <span className="service-card-title">{service.label}</span>
                  <span className="service-card-check" aria-hidden="true">
                    {active ? '✓' : ''}
                  </span>
                </span>
                {service.description ? (
                  <span className="service-card-desc">{service.description}</span>
                ) : null}
                <span className="service-card-meta">
                  <span className={`service-pill service-pill-${service.delivery ?? 'native'}`}>
                    {deliveryLabel(service)}
                  </span>
                  <span className="service-pill service-pill-action">
                    {actionLabel(service.recommended_action)}
                  </span>
                  {countLabel(service) ? (
                    <span className="service-pill service-pill-count">{countLabel(service)}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {props.selected.length > 0 ? (
        <div className="service-picker-selected">
          {props.selected.map((id) => {
            const service = props.services.find((item) => item.id === id);
            return (
              <span key={id} className="service-selected-chip">
                {service?.label ?? id}
                <button
                  type="button"
                  aria-label={`Убрать ${service?.label ?? id}`}
                  onClick={() => toggle(id)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
