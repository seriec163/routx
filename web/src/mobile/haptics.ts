/**
 * Короткая вибрация для действий, где важно «почувствовать» результат.
 * iOS Safari не поддерживает navigator.vibrate — там вызов просто игнорируется.
 */
export function haptic(pattern: number | number[] = 8): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    // вибрация не критична для работы интерфейса
  }
}

export function hapticTap(): void {
  haptic(8);
}

export function hapticMove(): void {
  haptic(12);
}

export function hapticSuccess(): void {
  haptic([10, 24, 14]);
}
