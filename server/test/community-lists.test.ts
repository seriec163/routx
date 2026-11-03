import { describe, expect, it } from 'vitest';
import {
  displayCommunityLists,
  isForkop2,
  normalizeCommunityLists,
  resolveCommunityLists,
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

  it('keeps Forkop 2.x lists in the UI catalog', () => {
    const result = normalizeCommunityLists(['facebook', 'x', 'ru_blocked_all'], 'forkop', '2.0.0');
    expect(result.lists).toEqual(['facebook', 'x', 'ru_blocked_all']);
    expect(displayCommunityLists(result.lists, 'forkop', '2.0.0')).toEqual([
      'facebook',
      'x',
      'ru_blocked_all',
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

  it('drops lists that Forkop 2.0.0 does not know yet', () => {
    const result = normalizeCommunityLists(
      ['digitalocean', 'hetzner', 'ovh', 'cloudflare', 'facebook'],
      'forkop',
      '2.0.0',
    );
    expect(result.lists).toEqual(['cloudflare', 'facebook']);
    expect(result.dropped).toEqual(['digitalocean', 'hetzner', 'ovh']);
    const newer = normalizeCommunityLists(['digitalocean', 'hetzner'], 'forkop', '2.1.0');
    expect(newer.lists).toEqual(['digitalocean', 'hetzner']);
  });

  it('adds a rule-set URL when Forkop 2.0.0 has no built-in list', async () => {
    const result = await resolveCommunityLists(
      ['facebook', 'digitalocean'],
      'forkop',
      '2.0.0',
    );
    expect(result.native).toEqual(['facebook']);
    expect(result.ruleSets).toEqual([
      'https://github.com/ushan0v/forkop-lists/releases/latest/download/digitalocean.json',
    ]);
    expect(result.dropped).toEqual([]);
  });

  it('detects Forkop 2.x by version', () => {
    expect(isForkop2('forkop', '2.0.0')).toBe(true);
    expect(isForkop2('forkop', 'v2.1.0')).toBe(true);
    expect(isForkop2('forkop', '1.0.5')).toBe(false);
    expect(isForkop2('prokop', '2.0.0')).toBe(false);
  });
});
