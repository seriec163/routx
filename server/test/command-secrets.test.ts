import { describe, expect, it } from 'vitest';
import {
  isSealedCommandArgs,
  openCommandArgs,
  sealCommandArgs,
} from '../src/agent/command-secrets.js';

const KEY = 'test-master-key-0123456789abcdef0123456789abcdef';

describe('секреты аргументов команд', () => {
  it('шифрует аргументы и не оставляет пароль в открытом виде', () => {
    const sealed = sealCommandArgs({ ssid: 'home', key: 'super-secret-psk' }, KEY);

    expect(isSealedCommandArgs(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain('super-secret-psk');
    expect(openCommandArgs(sealed, KEY)).toEqual({ ssid: 'home', key: 'super-secret-psk' });
  });

  it('не трогает пустые аргументы', () => {
    expect(sealCommandArgs({}, KEY)).toEqual({});
  });

  it('читает старые незашифрованные команды после обновления', () => {
    expect(openCommandArgs({ iface: 'wlan0' }, KEY)).toEqual({ iface: 'wlan0' });
  });

  it('не отдаёт секреты при неверном ключе', () => {
    const sealed = sealCommandArgs({ key: 'secret' }, KEY);
    expect(openCommandArgs(sealed, 'another-key-0123456789abcdef0123456789')).toEqual({});
  });

  it('возвращает пустые args, если ключа нет', () => {
    const sealed = sealCommandArgs({ key: 'secret' }, KEY);
    expect(openCommandArgs(sealed)).toEqual({});
  });
});
