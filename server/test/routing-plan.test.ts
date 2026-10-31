import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  computePlan,
  mapTemplateSections,
  templatePayloadSchema,
} from '../src/domain/uci.js';

function payload(overrides: Record<string, unknown> = {}) {
  return templatePayloadSchema.parse({
    settings: {},
    sections: {
      router_control: {
        action: 'connection',
        enabled: '1',
        label: 'Router Control',
        community_lists: ['youtube', 'telegram'],
      },
    },
    urltest: {},
    section_interface: {},
    subscription_url: {},
    create_urltest: [],
    create_sections: ['router_control'],
    manual_entries: {
      router_control: {
        domains: ['example.com'],
        ips: ['203.0.113.10', '2001:db8::/32'],
      },
    },
    ...overrides,
  });
}

describe('план шаблона', () => {
  it('превращает ручные адреса в локальный .lst и добавляет его в domain_ip_lists', () => {
    const plan = buildPlan(payload(), []);

    expect(plan.localLists).toHaveLength(1);
    expect(plan.localLists[0]?.path).toMatch(/^\/etc\/janusnew\/lists\/router_control-[a-f0-9]{12}\.lst$/);
    expect(plan.localLists[0]?.entries).toEqual([
      '2001:db8::/32',
      '203.0.113.10',
      'example.com',
    ]);
    expect(plan.desired.get('section.router_control.domain_ip_lists')).toContain(
      plan.localLists[0]?.path,
    );
  });

  it('подмешивает серверные дополнения роутера', () => {
    const plan = buildPlan(payload(), [], {
      router_control: {
        rule_set: ['https://example.com/extra.srs'],
        manual_domains: ['extra.example.com'],
        manual_ips: ['198.51.100.0/24'],
      },
    });

    expect(plan.desired.get('section.router_control.rule_set')).toContain(
      'https://example.com/extra.srs',
    );
    expect(plan.localLists[0]?.entries).toContain('extra.example.com');
    expect(plan.localLists[0]?.entries).toContain('198.51.100.0/24');
  });

  it('понимает комментарии и префиксы full:, keyword:, regex:', () => {
    const plan = buildPlan(
      payload({
        manual_entries: {
          router_control: {
            domains: [
              '// Для Seedance / CapCut / ByteDance',
              '# ещё комментарий',
              'example.com',
              'full:api.example.com',
              'keyword:htv-hydaelyn',
              'regex:^ads\\.',
            ],
            ips: ['// офис', '203.0.113.10'],
          },
        },
      }),
      [],
    );

    expect(plan.localLists[0]?.entries).toEqual(['203.0.113.10', 'example.com']);
    expect(plan.desired.get('section.router_control.domain')).toEqual(['api.example.com']);
    expect(plan.desired.get('section.router_control.domain_keyword')).toEqual(['htv-hydaelyn']);
    expect(plan.desired.get('section.router_control.domain_regex')).toEqual(['^ads\\.']);
  });

  it('отклоняет неизвестный список сообщества', () => {
    expect(() =>
      buildPlan(
        payload({
          sections: {
            router_control: {
              action: 'connection',
              community_lists: ['unknown_service'],
            },
          },
        }),
        [],
      ),
    ).toThrow(/Неизвестный список/);
  });

  it('требует action для создаваемой секции', () => {
    expect(() =>
      buildPlan(
        payload({
          sections: { router_control: { enabled: '1' } },
          manual_entries: {},
        }),
        [],
      ),
    ).toThrow(/укажите действие/);
  });

  it('управляет глобальным и секционным DNS', () => {
    const plan = buildPlan(
      payload({
        settings: {
          dns_type: 'doh',
          dns_server: ['https://dns.google/dns-query', '1.1.1.1'],
          bootstrap_dns_server: ['77.88.8.8'],
          dns_strategy: 'prefer_ipv4',
          dns_check_interval: '10s',
          dns_failover_failure_threshold: '3',
          dns_rewrite_ttl: '60',
          dns_detour_enabled: '1',
          dns_detour_section: 'router_control',
          intercept_client_dns: '0',
          disable_quic: '1',
        },
        sections: {
          router_control: {
            action: 'dns',
            dns_type: 'dot',
            dns_server: '1.1.1.1',
            dns_detour_enabled: '1',
            dns_detour_section: 'vpn',
          },
        },
        manual_entries: {},
      }),
      [],
    );

    expect(plan.desired.get('settings.dns_type')).toBe('doh');
    expect(plan.desired.get('settings.dns_server')).toEqual([
      'https://dns.google/dns-query',
      '1.1.1.1',
    ]);
    expect(plan.desired.get('settings.bootstrap_dns_server')).toEqual(['77.88.8.8']);
    expect(plan.desired.get('settings.dns_strategy')).toBe('prefer_ipv4');
    expect(plan.desired.get('settings.dns_failover_failure_threshold')).toBe('3');
    expect(plan.desired.get('section.router_control.dns_type')).toBe('dot');
    expect(plan.desired.get('section.router_control.dns_server')).toBe('1.1.1.1');
    expect(plan.desired.get('section.router_control.dns_detour_section')).toBe('vpn');
  });

  it('создаёт любую секцию с action, даже без явного create_sections', () => {
    const plan = buildPlan(payload({ create_sections: [], manual_entries: {} }), []);

    expect(plan.createSections).toContain('router_control');
  });

  it('привязывает новую секцию шаблона к существующей секции с подпиской', () => {
    const current = {
      'section.gga.action': 'connection',
      'section.gga.enabled': '1',
      'subscription_url.cfg1.section': 'gga',
    };
    const mapped = mapTemplateSections(
      payload({
        create_sections: [],
        manual_entries: {
          router_control: { domains: ['example.com'], ips: ['203.0.113.10'] },
        },
      }),
      current,
    );

    expect(mapped.sectionMap).toEqual({ router_control: 'gga' });
    expect(mapped.payload.sections.gga?.action).toBe('connection');
    expect(mapped.payload.sections.router_control).toBeUndefined();
    expect(mapped.payload.create_sections).toContain('gga');
    expect(mapped.payload.create_sections).not.toContain('router_control');
    expect(mapped.payload.manual_entries.gga?.domains).toEqual(['example.com']);
  });

  it('не привязывает секцию, если она уже есть на роутере', () => {
    const mapped = mapTemplateSections(payload({ manual_entries: {} }), {
      'section.router_control.action': 'connection',
      'subscription_url.cfg1.section': 'gga',
    });

    expect(mapped.sectionMap).toEqual({});
    expect(mapped.payload.sections.router_control).toBeDefined();
  });

  it('останавливает diff, если секции с подключением нет', () => {
    expect(() =>
      mapTemplateSections(payload({ create_sections: [], manual_entries: {} }), {
        'section.other.action': 'reject',
      }),
    ).toThrow(/нет секции с подключением/);
  });

  it('останавливает diff, если подходящих секций несколько', () => {
    expect(() =>
      mapTemplateSections(payload({ create_sections: [], manual_entries: {} }), {
        'section.gga.action': 'connection',
        'subscription_url.cfg1.section': 'gga',
        'section.vpn.action': 'connection',
        'subscription_url.cfg2.section': 'vpn',
      }),
    ).toThrow(/несколько секций с подключением/);
  });

  it('строит diff с add для новой секции', () => {
    const plan = computePlan(payload({ manual_entries: {} }), {}, []);

    expect(plan.items.some((item) => item.op === 'add' && item.path === 'section.router_control.action')).toBe(
      true,
    );
    expect(
      plan.items.find((item) => item.path === 'section.router_control.community_lists')?.after,
    ).toEqual(['youtube', 'telegram']);
  });

  it('не удаляет настройки и скалярные опции секции по умолчанию', () => {
    const plan = computePlan(
      payload({
        settings: {},
        sections: { gga: { action: 'connection', community_lists: ['youtube'] } },
        create_sections: [],
        manual_entries: {},
      }),
      {
        'settings.log_level': 'warn',
        'section.gga.action': 'connection',
        'section.gga.community_lists': ['telegram'],
        'section.gga.sort_by_latency': '1',
      },
      [],
    );

    expect(plan.items.some((item) => item.op === 'delete')).toBe(false);
    expect(
      plan.items.find((item) => item.path === 'section.gga.community_lists')?.after,
    ).toEqual(['youtube']);
  });

  it('удаляет настройку только при явном null', () => {
    const plan = computePlan(
      payload({ settings: { log_level: null }, sections: {}, create_sections: [], manual_entries: {} }),
      { 'settings.log_level': 'warn' },
      [],
    );

    expect(plan.items).toEqual([
      { op: 'delete', path: 'settings.log_level', before: 'warn', after: null },
    ]);
  });
});
