import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { RoutingService } from '../lib/types';

const TOOLTIP_WIDTH = 360;
const TOOLTIP_ESTIMATED_HEIGHT = 300;

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

function countLabel(service: RoutingService): string | null {
  const counts = service.counts;
  if (!counts) return null;
  const parts: string[] = [];
  if (counts.domains > 0) parts.push(`${formatCount(counts.domains)} доменов`);
  if (counts.subnets > 0) parts.push(`${formatCount(counts.subnets)} подсетей`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function TooltipCard({ service }: { service: RoutingService }) {
  const counts = countLabel(service);
  return (
    <div className="service-tooltip-card" role="tooltip">
      <div className="service-tooltip-head">
        <span className="service-tooltip-icon" aria-hidden="true">
          {service.group_icon ?? '•'}
        </span>
        <div>
          <strong>{service.title ?? service.label}</strong>
          {service.group_label ? (
            <span className="service-tooltip-group">{service.group_label}</span>
          ) : null}
        </div>
      </div>
      {service.note ? <p className="service-tooltip-note">{service.note}</p> : null}
      {service.description ? (
        <p className="service-tooltip-desc">{service.description}</p>
      ) : null}
      <div className="service-tooltip-meta">
        <span className={`service-pill service-pill-${service.delivery ?? 'native'}`}>
          {deliveryLabel(service)}
        </span>
        <span className="service-pill service-pill-action">
          {actionLabel(service.recommended_action)}
        </span>
        {counts ? <span className="service-pill service-pill-count">{counts}</span> : null}
      </div>
    </div>
  );
}

function useTooltipPosition() {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  function open(anchor: HTMLElement | null): void {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(TOOLTIP_WIDTH, window.innerWidth - 24);
    let left = rect.left;
    if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
    if (left < 12) left = 12;

    let top = rect.bottom + 8;
    if (top + TOOLTIP_ESTIMATED_HEIGHT > window.innerHeight - 12) {
      top = Math.max(12, rect.top - TOOLTIP_ESTIMATED_HEIGHT - 8);
    }
    setPosition({ top, left });
  }

  function close(): void {
    setPosition(null);
  }

  useEffect(() => {
    if (!position) return;
    const hide = () => setPosition(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [position]);

  return { position, open, close };
}

/** Обёртка для чипа или карточки: подсказка по наведению и фокусу. */
export function ServiceTooltip(props: {
  service: RoutingService;
  children: ReactNode;
  className?: string;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const { position, open, close } = useTooltipPosition();

  return (
    <>
      <span
        ref={anchor}
        className={props.className ?? 'service-tooltip-anchor'}
        onMouseEnter={() => open(anchor.current)}
        onMouseLeave={close}
        onFocus={() => open(anchor.current)}
        onBlur={close}
      >
        {props.children}
      </span>
      {position
        ? createPortal(
            <div
              className="service-tooltip"
              style={{ top: position.top, left: position.left }}
            >
              <TooltipCard service={props.service} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** Кнопка «ⓘ» для тач-устройств: открывает ту же подсказку по нажатию. */
export function ServiceInfoButton(props: { service: RoutingService }) {
  const button = useRef<HTMLButtonElement>(null);
  const { position, open, close } = useTooltipPosition();
  const visible = position != null;

  return (
    <>
      <button
        ref={button}
        type="button"
        className="service-info-button"
        aria-label={`Что входит в «${props.service.label}»`}
        aria-expanded={visible}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (visible) close();
          else open(button.current);
        }}
      >
        ⓘ
      </button>
      {position
        ? createPortal(
            <div
              className="service-tooltip"
              style={{ top: position.top, left: position.left }}
            >
              <TooltipCard service={props.service} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
