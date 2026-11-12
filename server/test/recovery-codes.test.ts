import { describe, expect, it } from 'vitest';
import {
  formatRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
} from '../src/auth/recovery.js';

describe('резервные коды', () => {
  it('форматирует код группами по четыре символа', () => {
    expect(formatRecoveryCode('ABCDEFGHIJKLMNOP')).toBe('ABCD-EFGH-IJKL-MNOP');
  });

  it('нормализует ввод: регистр, дефисы и пробелы', () => {
    expect(normalizeRecoveryCode(' abcd-efgh ijkl ')).toBe('ABCDEFGHIJKL');
  });

  it('создаёт 10 уникальных кодов правильного формата', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    }
  });
});
