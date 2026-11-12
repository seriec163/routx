import { describe, expect, it } from 'vitest';
import { computePodkopPlan, podkopSectionInputSchema, podkopTemplateInput } from '../src/domain/podkop.js';
import { templatePayloadSchema } from '../src/domain/uci.js';

function input(overrides: Record<string, unknown> = {}) {
  return podkopSectionInputSchema.parse({
    section: 'youtube',
    create: true,
    enabled: true,
    connection_type: 'proxy',
    proxy_config_type: 'url',
    community_lists: ['youtube'],
    manual_domains: ['example.com'],
    manual_ips: ['203.0.113.10'],
    options: {},
    ...overrides,
  });
}

describe('Podkop section plan', () => {
  it('creates a section with type, lists and domains', () => {
    const plan = computePodkopPlan(input(), {});
    const paths = new Map(plan.items.map((item) => [item.path, item.after]));

    expect(plan.createSections).toEqual(['youtube']);
    expect(paths.get('section.youtube.enabled')).toBe('1');
    expect(paths.get('section.youtube.connection_type')).toBe('proxy');
    expect(paths.get('section.youtube.proxy_config_type')).toBe('url');
    expect(paths.get('section.youtube.community_lists')).toEqual(['youtube']);
    expect(paths.get('section.youtube.user_domains')).toEqual(['example.com']);
    expect(paths.get('section.youtube.user_domain_list_type')).toBe('dynamic');
    expect(paths.get('section.youtube.user_subnets')).toEqual(['203.0.113.10']);
    expect(paths.get('section.youtube.user_subnet_list_type')).toBe('dynamic');
  });

  it('does not touch unrelated options when clearing domains', () => {
    const current = {
      'section.youtube.enabled': '1',
      'section.youtube.connection_type': 'proxy',
      'section.youtube.proxy_config_type': 'selector',
      'section.youtube.community_lists': ['youtube'],
      'section.youtube.user_domains': ['old.example'],
      'section.youtube.user_domain_list_type': 'dynamic',
      'section.youtube.mixed_proxy_enabled': '1',
    };
    const plan = computePodkopPlan(
      input({ create: false, manual_domains: [], manual_ips: [], proxy_config_type: undefined }),
      current,
    );
    const paths = new Map(plan.items.map((item) => [item.path, item.after]));

    expect(paths.get('section.youtube.user_domains')).toBeNull();
    expect(paths.get('section.youtube.user_domain_list_type')).toBe('disabled');
    expect(paths.has('section.youtube.mixed_proxy_enabled')).toBe(false);
    expect(paths.has('section.youtube.proxy_config_type')).toBe(false);
    expect(plan.createSections).toEqual([]);
  });

  it('rejects unknown options and community lists', () => {
    expect(() =>
      computePodkopPlan(input({ options: { config_path: '/tmp/x' } }), {}),
    ).toThrow(/нельзя менять/);
    expect(() =>
      computePodkopPlan(input({ community_lists: ['unknown-list'] }), {}),
    ).toThrow(/Неизвестный список/);
  });

  it('stores text lists in user_domains_text and user_subnets_text', () => {
    const plan = computePodkopPlan(
      input({
        user_domain_list_type: 'text',
        user_domains_text: 'example.com\nexample.net',
        user_subnet_list_type: 'text',
        user_subnets_text: '203.0.113.10, 203.0.113.11',
        manual_domains: [],
        manual_ips: [],
      }),
      {
        'section.youtube.user_domains': ['old.example'],
        'section.youtube.user_domain_list_type': 'dynamic',
      },
    );
    const paths = new Map(plan.items.map((item) => [item.path, item.after]));
    expect(paths.get('section.youtube.user_domains_text')).toBe(
      'example.com\nexample.net',
    );
    expect(paths.get('section.youtube.user_domains')).toBeNull();
    expect(paths.get('section.youtube.user_domain_list_type')).toBe('text');
    expect(paths.get('section.youtube.user_subnets_text')).toBe(
      '203.0.113.10, 203.0.113.11',
    );
    expect(paths.get('section.youtube.user_subnet_list_type')).toBe('text');
  });

  it('maps a shared template to a Podkop section', () => {
    const payload = templatePayloadSchema.parse({
      action: 'connection',
      resources: { community_lists: ['youtube'] },
      manual_domains: [],
      manual_ips: [],
      podkop: {
        connection_type: 'vpn',
        user_domain_list_type: 'text',
        user_domains_text: 'example.com',
        user_subnet_list_type: 'dynamic',
      },
    });
    const converted = podkopTemplateInput(payload, 'main');
    expect(converted.connection_type).toBe('vpn');
    expect(converted.community_lists).toEqual(['youtube']);
    expect(converted.user_domain_list_type).toBe('text');
    expect(converted.user_domains_text).toBe('example.com');
    expect(converted.user_subnet_list_type).toBe('dynamic');
  });

  it('uses text list for a Prokop-style template with comment lines', () => {
    const payload = templatePayloadSchema.parse({
      action: 'connection',
      resources: { community_lists: ['youtube'] },
      manual_domains: ['//Для Seedance / CapCut', 'api.capcut.com', 'keyword:freebuff'],
      manual_ips: [],
    });
    const converted = podkopTemplateInput(payload, 'main');
    expect(converted.user_domain_list_type).toBe('text');
    expect(converted.user_domains_text).toContain('//Для Seedance / CapCut');
    expect(converted.user_domains_text).toContain('api.capcut.com');
  });
});
