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

/** Отдельный знак мобильного приложения: роутер + Wi-Fi, а не панельная «R». */
export function MobileGlyph({ strokeWidth = 2.4 }: { strokeWidth?: number }) {
  return (
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 20c6.5-6.5 19-6.5 26 0" />
      <path d="M15.5 24c4.3-4.3 12.6-4.3 17 0" />
      <path d="M20 28.7c1.9-1.9 6.4-1.9 8.2 0" />
      <circle cx="24" cy="32.6" r="1.9" fill="currentColor" stroke="none" />
      <rect x="13.1" y="37.7" width="21.7" height="6.4" rx="3.2" />
      <path d="M17.2 37.7v-1.9M30.7 37.7v-1.9" />
      <circle cx="20.6" cy="40.9" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="24" cy="40.9" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="27.4" cy="40.9" r="0.7" fill="currentColor" stroke="none" />
    </g>
  );
}

export function MobileMark({
  size,
  className = 'm-branddot',
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
        <MobileGlyph />
      </svg>
    </span>
  );
}
