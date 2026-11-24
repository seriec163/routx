/**
 * Минимальные версии агента для операций, которые появились не сразу.
 *
 * Панель проверяет это до отправки команды: вместо `unknown_op` из старого
 * агента пользователь получает понятное «нужна версия X», а обработчики
 * (например, Wi-Fi) могут сначала обновить агент и повторить операцию.
 */
export interface AgentFeature {
  op: string;
  minVersion: string;
  label: string;
}

export const AGENT_FEATURES: Record<string, AgentFeature> = {
  wifi_read: { op: 'wifi_read', minVersion: '1.5.52', label: 'чтение Wi-Fi' },
  wifi_update: { op: 'wifi_update', minVersion: '1.5.52', label: 'изменение Wi-Fi' },
  wifi_create: { op: 'wifi_create', minVersion: '1.5.52', label: 'создание Wi-Fi' },
  wifi_delete: { op: 'wifi_delete', minVersion: '1.5.52', label: 'удаление Wi-Fi' },
  delete_section: { op: 'delete_section', minVersion: '1.5.54', label: 'удаление секции' },
};

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));

  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function featureForOp(op: string): AgentFeature | null {
  return AGENT_FEATURES[op] ?? null;
}

/** Агент без версии считается устаревшим: лучше обновить, чем гадать. */
export function supportsFeature(agentVersion: string | null | undefined, feature: AgentFeature): boolean {
  if (!agentVersion) return false;
  return compareVersions(agentVersion, feature.minVersion) >= 0;
}
