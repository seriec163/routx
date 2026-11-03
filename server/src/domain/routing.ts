/**
 * Каталог ресурсов Prokop/Forkop для шаблонов и ручного ввода.
 * Источник: Prokop `prokop/files/usr/lib/singbox/rulesets.uc`
 * (COMMUNITY_SERVICES) и LuCI `section.js` (подписи).
 */
export interface RoutingService {
  id: string;
  label: string;
}

export const ROUTING_SERVICES: RoutingService[] = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'discord', label: 'Discord' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'meta', label: 'Meta (Facebook, Instagram)' },
  { id: 'twitter', label: 'Twitter / X' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'google_ai', label: 'Google AI' },
  { id: 'google_play', label: 'Google Play' },
  { id: 'cloudflare', label: 'Cloudflare' },
  { id: 'cloudfront', label: 'CloudFront (ASN)' },
  { id: 'digitalocean', label: 'DigitalOcean (ASN)' },
  { id: 'hetzner', label: 'Hetzner (ASN)' },
  { id: 'ovh', label: 'OVH (ASN)' },
  { id: 'github', label: 'GitHub' },
  { id: 'roblox', label: 'Roblox' },
  { id: 'supercell', label: 'Supercell' },
  { id: 'anime', label: 'Аниме' },
  { id: 'news', label: 'Новости' },
  { id: 'porn', label: '18+' },
  { id: 'hdrezka', label: 'HDRezka' },
  { id: 'hodca', label: 'H.O.D.C.A.' },
  { id: 'geoblock', label: 'Geo Block' },
  { id: 'block', label: 'Block' },
  { id: 'ads_hagezi_pro', label: 'Реклама (Hagezi Pro)' },
  { id: 'russia_inside', label: 'Россия (внутри)' },
  { id: 'russia_outside', label: 'Россия (снаружи)' },
  { id: 'ukraine_inside', label: 'Украина' },
];

/** Списки, которых нет в старом каталоге Prokop, но которые понимает Forkop 2.x. */
export const FORKOP2_SERVICES: RoutingService[] = [
  { id: 'ru_blocked_all', label: 'RU Blocked (All) · Forkop 2' },
  { id: 'ru_blocked_rkn', label: 'RU Blocked (RKN) · Forkop 2' },
  { id: 'ru_blocked_geo', label: 'RU Blocked (Geo) · Forkop 2' },
  { id: 'ru_only', label: 'RU Only · Forkop 2' },
  { id: 'ua_blocked', label: 'UA Blocked · Forkop 2' },
  { id: 'ai', label: 'AI-сервисы · Forkop 2' },
  { id: 'chatgpt', label: 'ChatGPT · Forkop 2' },
  { id: 'claude', label: 'Claude · Forkop 2' },
  { id: 'facebook', label: 'Facebook · Forkop 2' },
  { id: 'gemini', label: 'Gemini · Forkop 2' },
  { id: 'instagram', label: 'Instagram · Forkop 2' },
  { id: 'spotify', label: 'Spotify · Forkop 2' },
  { id: 'twitch', label: 'Twitch · Forkop 2' },
  { id: 'whatsapp', label: 'WhatsApp · Forkop 2' },
  { id: 'x', label: 'X / Twitter · Forkop 2' },
  { id: 'ads', label: 'Реклама (Ads) · Forkop 2' },
];

const ROUTING_SERVICE_IDS = new Set(
  [...ROUTING_SERVICES, ...FORKOP2_SERVICES].map((item) => item.id),
);

export { ROUTING_SERVICE_IDS };

export function isKnownRoutingService(value: string): boolean {
  return ROUTING_SERVICE_IDS.has(value);
}

/** Действия секции, которые поддерживают Prokop/Forkop. */
export const ROUTING_ACTIONS = [
  { id: 'connection', label: 'Через VPN-подключение' },
  { id: 'bypass', label: 'В обход VPN' },
  { id: 'block', label: 'Блокировать' },
  { id: 'dns', label: 'Только DNS' },
] as const;

export const ROUTING_ACTION_IDS = new Set(ROUTING_ACTIONS.map((item) => item.id));

/** Действия, для которых обязательны источники подключения. */
export const CONNECTION_ACTIONS = new Set(['connection', 'proxy', 'outbound', 'vpn']);
