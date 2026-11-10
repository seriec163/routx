import { describe, expect, it } from 'vitest';
import {
  canManageBranchUser,
  isManagerRole,
  isMfaRequired,
  requireSuperadmin,
} from '../src/auth/service.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

describe('уровни доступа', () => {
  it('различает три роли', () => {
    expect(isManagerRole('superadmin')).toBe(true);
    expect(isManagerRole('admin')).toBe(true);
    expect(isManagerRole('user')).toBe(false);
  });

  it('суперадминистратор управляет любым пользователем', () => {
    expect(
      canManageBranchUser('superadmin', 'sa', { role: 'user', parent_id: null }),
    ).toBe(true);
    expect(
      canManageBranchUser('superadmin', 'sa', { role: 'admin', parent_id: 'other' }),
    ).toBe(true);
  });

  it('администратор управляет только пользователями своей ветки', () => {
    expect(
      canManageBranchUser('admin', 'a1', { role: 'user', parent_id: 'a1' }),
    ).toBe(true);
    expect(
      canManageBranchUser('admin', 'a1', { role: 'user', parent_id: 'a2' }),
    ).toBe(false);
    expect(
      canManageBranchUser('admin', 'a1', { role: 'admin', parent_id: 'a1' }),
    ).toBe(false);
    expect(
      canManageBranchUser('admin', 'a1', { role: 'superadmin', parent_id: null }),
    ).toBe(false);
  });

  it('пользователь не управляет другими учётными записями', () => {
    expect(
      canManageBranchUser('user', 'u1', { role: 'user', parent_id: 'u1' }),
    ).toBe(false);
  });

  it('политика 2FA для администраторов распространяется на оба уровня', () => {
    const settings = { ...DEFAULT_SETTINGS, mfaPolicy: 'admins' as const };
    expect(isMfaRequired(settings, 'superadmin')).toBe(true);
    expect(isMfaRequired(settings, 'admin')).toBe(true);
    expect(isMfaRequired(settings, 'user')).toBe(false);
  });

  it('входить под пользователем может только суперадминистратор', () => {
    const base = {
      sessionId: 'session',
      userId: 'actor',
      email: 'actor@example.com',
      mfaPassed: true,
    };
    expect(() =>
      requireSuperadmin({ auth: { ...base, role: 'admin' } } as never),
    ).toThrow();
    expect(() =>
      requireSuperadmin({ auth: { ...base, role: 'user' } } as never),
    ).toThrow();
    expect(
      requireSuperadmin({ auth: { ...base, role: 'superadmin' } } as never).role,
    ).toBe('superadmin');
  });
});
