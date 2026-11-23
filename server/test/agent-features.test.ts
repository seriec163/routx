import { describe, expect, it } from 'vitest';
import {
  AGENT_FEATURES,
  compareVersions,
  featureForOp,
  supportsFeature,
} from '../src/agent/features.js';

describe('возможности агента', () => {
  it('сравнивает версии по числам, а не строкам', () => {
    expect(compareVersions('1.5.52', '1.5.9')).toBe(1);
    expect(compareVersions('1.5.52', '1.5.52')).toBe(0);
    expect(compareVersions('v1.6.0', '1.5.52')).toBe(1);
    expect(compareVersions('1.5.4', '1.5.52')).toBe(-1);
  });

  it('знает минимальную версию для Wi-Fi операций', () => {
    const feature = featureForOp('wifi_create');
    expect(feature?.minVersion).toBe('1.5.52');
    expect(supportsFeature('1.5.51', feature!)).toBe(false);
    expect(supportsFeature('1.5.52', feature!)).toBe(true);
    expect(supportsFeature(null, feature!)).toBe(false);
  });

  it('не ограничивает операции без явного требования', () => {
    expect(featureForOp('read_state')).toBeNull();
    expect(featureForOp('apply_uci')).toBeNull();
    expect(Object.keys(AGENT_FEATURES).every((op) => op.startsWith('wifi_'))).toBe(true);
  });
});
