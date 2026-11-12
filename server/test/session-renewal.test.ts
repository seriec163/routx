import { describe, expect, it } from 'vitest';
import { shouldRenewSession } from '../src/auth/service.js';

const DAY = 24 * 60 * 60 * 1000;

function session(totalDays: number, remainingDays: number, impersonatedBy: string | null = null) {
  const now = Date.now();
  return {
    createdAt: new Date(now - (totalDays - remainingDays) * DAY),
    expiresAt: new Date(now + remainingDays * DAY),
    impersonatedBy,
  };
}

describe('продление активной сессии', () => {
  it('не продлевает свежую сессию', () => {
    expect(shouldRenewSession(session(45, 30))).toBe(false);
  });

  it('продлевает, когда осталось меньше половины срока', () => {
    expect(shouldRenewSession(session(45, 20))).toBe(true);
  });

  it('продлевает сессию перед самым истечением', () => {
    expect(shouldRenewSession(session(45, 1))).toBe(true);
  });

  it('не продлевает короткий вход под пользователем', () => {
    expect(shouldRenewSession(session(2 / 24, 1 / 24))).toBe(false);
  });

  it('не продлевает режим «войти как пользователь»', () => {
    expect(shouldRenewSession(session(45, 1, 'admin-id'))).toBe(false);
  });
});
