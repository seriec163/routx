export interface TachyonComponentInfo {
  component: string;
  current_version?: string;
  latest_version?: string;
  status?: string;
  message?: string;
  release_url?: string;
  release_notes?: string;
  current_sha?: string;
  latest_sha?: string;
  success?: boolean;
}

export const TACHYON_COMPONENTS: Array<{
  id: 'tachyon' | 'tachyon-core';
  title: string;
  description: string;
}> = [
  {
    id: 'tachyon',
    title: 'Модуль Tachyon',
    description: 'LuCI-интерфейс, CLI и вспомогательные ucode-модули.',
  },
  {
    id: 'tachyon-core',
    title: 'Ядро Tachyon Core',
    description: 'Движок маршрутизации, который держит VPN и правила секций.',
  },
];

export function componentStatusLabel(info: TachyonComponentInfo | undefined): {
  status: 'success' | 'warning' | 'error';
  label: string;
} {
  if (!info) return { status: 'warning', label: 'нет данных' };
  if (info.status === 'latest') return { status: 'success', label: 'актуально' };
  if (info.status === 'outdated' || info.status === 'outdated_same_release') {
    return { status: 'warning', label: `доступно ${info.latest_version ?? ''}`.trim() };
  }
  if (info.status === 'dev') return { status: 'warning', label: 'новее релиза' };
  return { status: 'warning', label: info.status || 'неизвестно' };
}

export function versionAtLeast(value: string | null | undefined, minimum: string): boolean {
  const parse = (input: string): number[] =>
    input
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const current = parse(value ?? '0');
  const required = parse(minimum);
  for (let index = 0; index < Math.max(current.length, required.length); index += 1) {
    const left = current[index] ?? 0;
    const right = required[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}
