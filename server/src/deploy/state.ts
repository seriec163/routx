/**
 * Режим обслуживания на время импорта базы.
 * Пока он включён, API отвечает 503, а /readyz сообщает о переносе —
 * по нему интерфейс понимает, что сервер перезапускается.
 */
export interface MaintenanceState {
  since: string;
  reason: string;
}

let current: MaintenanceState | null = null;

export function getMaintenance(): MaintenanceState | null {
  return current;
}

export function setMaintenance(reason: string): void {
  current = { since: new Date().toISOString(), reason };
}

export function clearMaintenance(): void {
  current = null;
}
