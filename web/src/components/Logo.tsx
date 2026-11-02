/**
 * Логотип RoutX: буква R, вычерченная как маршрут — стойка, петля и ножка,
 * которая заканчивается узлом (точкой). Минималистично, читается в 16 px.
 */
export function LogoGlyph({ strokeWidth = 3.4 }: { strokeWidth?: number }) {
  return (
    <g
      transform="translate(24 24) scale(1.5) translate(-24 -24)"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M16 36V12h10.2a7.4 7.4 0 0 1 0 14.8H16" />
      <path d="M25.2 26.2 33.4 34.8" />
      <circle cx="34" cy="35.4" r="2.1" fill="currentColor" stroke="none" />
    </g>
  );
}

export function LogoMark({
  size,
  className = 'brand-mark',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={className}
      style={size == null ? undefined : { width: size, height: size }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 48 48" role="presentation">
        <LogoGlyph />
      </svg>
    </span>
  );
}
