import { describe, expect, it } from 'vitest';
import {
  displayCommunityLists,
  isForkop2,
  normalizeCommunityLists,
  resolveCommunityLists,
} from '../src/domain/community-lists.js';
import { catalogForRouter } from '../src/domain/list-catalog.js';
import { isKnownRoutingService } from '../src/domain/routing.js';

const RELEASES = 'https://github.com/Dushnilin/tachyon-lists/releases/download/latest';

describe('community lists', () => {
  it('recognises catalog and legacy list ids', () => {
    expect(isKnownRoutingService('facebook')).toBe(true);
    expect(isKnownRoutingService('x')).toBe(true);
    expect(isKnownRoutingService('ru_blocked_all')).toBe(true);
    expect(isKnownRoutingService('meta')).toBe(true);
    expect(isKnownRoutingService('openrouter')).toBe(true);
    expect(isKnownRoutingService('cursor')).toBe(true);
  });

  it('normalises legacy names to canonical tachyon-lists ids', () => {
    const result = normalizeCommunityLists(
      ['facebook', 'instagram', 'x', 'gemini', 'chatgpt', 'claude', 'ads'],
      'forkop',
      '2.0.0',
    );
    expect(result.lists).toEqual([
      'meta',
      'twitter',
      'google_ai',
      'openai',
      'anthropic',
      'ads_hagezi_pro',
    ]);
    expect(result.dropped).toEqual([]);
  });

  it('keeps canonical ids for the UI catalog', () => {
    const result = normalizeCommunityLists(['facebook', 'x', 'ru_blocked_all'], 'forkop', '2.0.0');
    expect(result.lists).toEqual(['meta', 'twitter', 'ru_blocked_all']);
    expect(displayCommunityLists(result.lists, 'forkop', '2.0.0')).toEqual([
      'meta',
      'twitter',
      'ru_blocked_all',
    ]);
  });

  it('keeps catalog ids for Prokop and Forkop 1.x', () => {
    const result = normalizeCommunityLists(
      ['facebook', 'x', 'gemini', 'ru_blocked_all', 'spotify'],
      'prokop',
      '1.0.0',
    );
    expect(result.lists).toEqual(['meta', 'twitter', 'google_ai', 'ru_blocked_all', 'spotify']);
    expect(result.dropped).toEqual([]);
  });

  it('drops only truly unknown lists', () => {
    const result = normalizeCommunityLists(['unknown_service', 'meta'], 'forkop', '2.0.0');
    expect(result.lists).toEqual(['meta']);
    expect(result.dropped).toEqual(['unknown_service']);
  });

  it('uses native Forkop 2.x names and rule-set JSON for unsupported lists', async () => {
    const result = await resolveCommunityLists(
      ['digitalocean', 'hetzner', 'ovh', 'cloudflare', 'meta'],
      'forkop',
      '2.0.0',
    );
    expect(result.native).toEqual(['cloudflare', 'facebook', 'instagram']);
    expect(result.ruleSets).toEqual([
      `${RELEASES}/digitalocean.json`,
      `${RELEASES}/hetzner.json`,
      `${RELEASES}/ovh.json`,
    ]);
    expect(result.dropped).toEqual([]);

    const newer = await resolveCommunityLists(['digitalocean', 'hetzner'], 'forkop', '2.1.0');
    expect(newer.native).toEqual(['digitalocean', 'hetzner']);
    expect(newer.ruleSets).toEqual([]);
  });

  it('uses Tachyon native ids and rule-set for internal geo lists', async () => {
    const native = await resolveCommunityLists(
      ['meta', 'openai', 'youtube', 'geoblock'],
      'tachyon',
      '1.7.12',
    );
    expect(native.native).toEqual(['meta', 'openai', 'youtube', 'geoblock']);
    expect(native.ruleSets).toEqual([]);

    const internal = await resolveCommunityLists(['geosite_ru'], 'tachyon', '1.7.12');
    expect(internal.native).toEqual([]);
    expect(internal.ruleSets).toEqual([`${RELEASES}/geosite_ru.srs`]);
  });

  it('uses rule-set SRS for Prokop lists that are not built in', async () => {
    const result = await resolveCommunityLists(['meta', 'spotify', 'netflix'], 'prokop', '1.0.0');
    expect(result.native).toEqual(['meta']);
    expect(result.ruleSets).toEqual([`${RELEASES}/spotify.srs`, `${RELEASES}/netflix.srs`]);
  });

  it('builds a product-aware catalog from tachyon-lists', () => {
    const tachyon = catalogForRouter('tachyon', '1.7.12');
    expect(tachyon.length).toBeGreaterThan(100);
    expect(tachyon.find((item) => item.id === 'openai')?.delivery).toBe('native');
    expect(tachyon.find((item) => item.id === 'geosite_ru')?.delivery).toBe('rule_set');

    const prokop = catalogForRouter('prokop', '1.0.0');
    expect(prokop.find((item) => item.id === 'meta')?.delivery).toBe('native');
    expect(prokop.find((item) => item.id === 'spotify')?.delivery).toBe('rule_set');

    const forkop = catalogForRouter('forkop', '2.0.0');
    expect(forkop.find((item) => item.id === 'meta')?.native).toBe(true);
    expect(forkop.find((item) => item.id === 'digitalocean')?.delivery).toBe('rule_set');

    const podkop = catalogForRouter('podkop', '0.7.24');
    expect(podkop.find((item) => item.id === 'meta')?.delivery).toBe('native');
    expect(podkop.find((item) => item.id === 'spotify')?.delivery).toBe('domains');
  });

  it('detects Forkop 2.x by version', () => {
    expect(isForkop2('forkop', '2.0.0')).toBe(true);
    expect(isForkop2('forkop', 'v2.1.0')).toBe(true);
    expect(isForkop2('forkop', '1.0.5')).toBe(false);
    expect(isForkop2('prokop', '2.0.0')).toBe(false);
  });
});
