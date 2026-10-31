import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('конфигурация', () => {
  it('подставляет безопасные значения по умолчанию', () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      MIGRATE_ON_START: false,
      TRUST_PROXY: false,
      LOG_LEVEL: 'info',
      isProduction: false,
    });
  });

  it('разбирает булевы переменные и порт', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '8080',
      MIGRATE_ON_START: 'true',
      TRUST_PROXY: 'true',
      LOG_LEVEL: 'debug',
    });

    expect(config.PORT).toBe(8080);
    expect(config.MIGRATE_ON_START).toBe(true);
    expect(config.TRUST_PROXY).toBe(true);
    expect(config.LOG_LEVEL).toBe('debug');
  });

  it('отклоняет некорректный порт', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/Некорректная конфигурация/);
  });

  it('отклоняет неизвестный уровень логирования', () => {
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrow(/Некорректная конфигурация/);
  });

  it('требует RC_MASTER_KEY в production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/RC_MASTER_KEY/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', RC_MASTER_KEY: 'too-short' }),
    ).toThrow(/не менее 32 символов/);
  });

  it('принимает production с длинным ключом', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      RC_MASTER_KEY: 'a'.repeat(32),
    });

    expect(config.isProduction).toBe(true);
  });
});
