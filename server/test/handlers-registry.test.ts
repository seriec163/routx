import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/jobs/handlers.js';

describe('реестр обработчиков задач', () => {
  it('содержит Wi-Fi операции после разбиения файла', () => {
    for (const type of ['wifi_read', 'wifi_update', 'wifi_create', 'wifi_delete'] as const) {
      expect(typeof HANDLERS[type]).toBe('function');
    }
  });
});
