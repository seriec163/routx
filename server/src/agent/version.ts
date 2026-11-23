import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Версия агента, собранная в текущем образе панели. Нужна, чтобы отличить
 * «обновление не применилось» от «агент уже был последней версии».
 */
export function bundledAgentVersion(): string | null {
  const dist =
    (globalThis as { __RC_AGENT_DIST?: string }).__RC_AGENT_DIST ??
    process.env.RC_AGENT_DIST;
  if (!dist) return null;
  const file = join(dist, 'routx-agent.version');
  if (!existsSync(file)) return null;
  const value = readFileSync(file, 'utf8').trim();
  return value === '' ? null : value;
}
