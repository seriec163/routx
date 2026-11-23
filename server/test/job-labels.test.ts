import { describe, expect, it } from 'vitest';
import { jobActionLabel } from '../src/jobs/labels.js';

describe('названия действий в журнале', () => {
  it('переводит известные типы задач', () => {
    expect(jobActionLabel('wifi_create')).toBe('Создание Wi-Fi');
    expect(jobActionLabel('agent_update')).toBe('Обновление агента');
  });

  it('не теряет неизвестный тип', () => {
    expect(jobActionLabel('custom_op')).toBe('custom_op');
  });
});
