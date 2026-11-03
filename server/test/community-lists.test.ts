import { describe, expect, it } from 'vitest';
import {
  displayCommunityLists,
  isForkop2,
  normalizeCommunityLists,
} from '../src/domain/community-lists.js';
import { isKnownRoutingService } from '../src/domain/routing.js';

describe('community lists', () => {
  it('recognises Forkop 2.x lists in templates', () => {
    expect(isKnownRoutingService('facebook')).toBe(true);
    expect(isKnownRoutingService('x')).toBe(true);
    expect(isKnownRoutingService('ru_blocked_all')).toBe(true);
    expect(isKnownRoutingService('meta')).toBe(true);
  });

  it('maps Prokop lists to Forkop 2.x', () => {
    const result = normalizeCommunityLists(
      ['meta', 'twitter', 'google_ai', 'cloudfront'],
      'forkop',
      '2.0.0',
    );
    expect(result.lists).toEqual(['facebook', 'instagram', 'whatsapp', 'x', 'gemini']);
    expect(result.dropped).toEqual(['cloudfront']);
  });

  it('keeps Forkop 2.x lists and shows them as familiar IDs', () => {
    const result = normalizeCommunityLists(['facebook', 'x', 'ru_blocked_all'], 'forkop', '2.0.0');
    expect(result.lists).toEqual(['facebook', 'x', 'ru_blocked_all']);
    expect(displayCommunityLists(result.lists, 'forkop', '2.0.0')).toEqual([
      'meta',
      'twitter',
      'russia_outside',
    ]);
  });

  it('maps Forkop 2.x lists back for Prokop and Forkop 1.x', () => {
    const result = normalizeCommunityLists(
      ['facebook', 'x', 'gemini', 'ru_blocked_all', 'spotify'],
      'prokop',
      '1.0.0',
    );
    expect(result.lists).toEqual(['meta', 'twitter', 'google_ai', 'russia_outside']);
    expect(result.dropped).toEqual(['spotify']);
  });

  it('detects Forkop 2.x by version', () => {
    expect(isForkop2('forkop', '2.0.0')).toBe(true);
    expect(isForkop2('forkop', 'v2.1.0')).toBe(true);
    expect(isForkop2('forkop', '1.0.5')).toBe(false);
    expect(isForkop2('prokop', '2.0.0')).toBe(false);
  });
});
