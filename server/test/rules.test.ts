import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  computePlan,
  materializePresetForSection,
  presetFromPayload,
  sectionRulePayload,
  templatePayloadSchema,
} from '../src/domain/uci.js';
import { buildRuleViews } from '../src/domain/rules.js';

function parsed(overrides: Record<string, unknown> = {}) {
  return templatePayloadSchema.parse(overrides);
}

describe('пресет шаблона без имени секции', () => {
  it('читает новый формат и отбрасывает комментарии', () => {
    const preset = presetFromPayload(
      parsed({
        action: 'block',
        enabled: '1',
        resources: { community_lists: ['youtube'], domain: 'keyword:ads' },
        manual_domains: ['// комментарий', 'example.com'],
        manual_ips: ['# комментарий', '203.0.113.10'],
        settings: { log_level: 'warn' },
      }),
    );

    expect(preset.action).toBe('block');
    expect(preset.resources.community_lists).toEqual(['youtube']);
    expect(preset.resources.domain).toBe('keyword:ads');
    expect(preset.manual_domains).toEqual(['example.com']);
    expect(preset.manual_ips).toEqual(['203.0.113.10']);
    expect(preset.settings.log_level).toBe('warn');
  });

  it('читает старый шаблон с одной секцией как пресет', () => {
    const preset = presetFromPayload(
      parsed({
        sections: {
          router_control: {
            action: 'bypass',
            enabled: '1',
            label: 'RoutX',
            community_lists: ['youtube'],
          },
        },
        manual_entries: {
          router_control: { domains: ['example.com'], ips: [] },
        },
      }),
    );

    expect(preset.action).toBe('bypass');
    expect(preset.resources.community_lists).toEqual(['youtube']);
    expect(preset.resources.label).toBeUndefined();
    expect(preset.resources.action).toBeUndefined();
    expect(preset.manual_domains).toEqual(['example.com']);
  });

  it('не угадывает секцию в старом шаблоне с несколькими секциями', () => {
    expect(() =>
      presetFromPayload(
        parsed({
          sections: {
            first: { action: 'connection' },
            second: { action: 'connection' },
          },
        }),
      ),
    ).toThrow(/несколько секций/);
  });

  it('отклоняет некорректный домен в шаблоне', () => {
    expect(() => presetFromPayload(parsed({ manual_domains: ['not a domain!'] }))).toThrow(
      /Некорректный домен/,
    );
  });

  it('разворачивает пресет в конкретную секцию', () => {
    const preset = presetFromPayload(
      parsed({
        action: 'connection',
        resources: { community_lists: ['youtube'] },
        manual_domains: ['example.com'],
      }),
    );
    const plan = buildPlan(materializePresetForSection(preset, 'youtube', true), []);

    expect(plan.createSections).toEqual(['youtube']);
    expect(plan.desired.get('section.youtube.action')).toBe('connection');
    expect(plan.desired.get('section.youtube.community_lists')).toEqual(['youtube']);
    expect(plan.localLists[0]?.path).toMatch(/^\/etc\/routx-agent\/lists\/youtube-[a-f0-9]{12}\.lst$/);
  });

  it('строит правило с выключенным действием и ручными адресами', () => {
    const payload = sectionRulePayload({
      section: 'youtube',
      label: 'YouTube',
      action: 'connection',
      enabled: false,
      resources: { community_lists: ['youtube'] },
      manual_domains: ['example.com'],
      create: true,
    });
    const plan = computePlan(payload, {}, []);

    expect(plan.createSections).toEqual(['youtube']);
    expect(plan.items.find((item) => item.path === 'section.youtube.enabled')?.after).toBe('0');
    expect(plan.items.find((item) => item.path === 'section.youtube.label')?.after).toBe('YouTube');
    expect(
      plan.items.some(
        (item) => item.path === 'section.youtube.domain_ip_lists' && item.op === 'add',
      ),
    ).toBe(true);
  });

  it('запрещает служебные поля в ресурсах правила', () => {
    expect(() =>
      sectionRulePayload({
        section: 'youtube',
        action: 'block',
        resources: { domain_ip_lists: ['/tmp/evil.lst'] },
      }),
    ).toThrow(/задаётся отдельно/);
  });
});

describe('представление правил', () => {
  it('сопоставляет сохранённую подписку с внешней по хвосту URL', () => {
    const rules = buildRuleViews({
      managed: {
        'section.gga.action': 'connection',
        'section.gga.label': 'router_control',
      },
      agentSections: [
        {
          section: 'gga',
          options: { action: 'connection', label: 'router_control' },
          subscriptions: [
            { name: 'cfg046a7c', host: 'myvpnb.duckdns.org', tail: '8g4u' },
          ],
          links: [],
          lists: {},
        },
      ],
      connections: [
        {
          id: '01a18f24-cda3-7424-9a1e-9b1fa413e6ab',
          kind: 'subscription',
          label: 'Шопен',
          section: 'gga',
          value: 'https://myvpnb.duckdns.org/sub/8g4u',
          enabled: true,
        },
      ],
      source: 'live',
    });

    expect(rules).toHaveLength(1);
    expect(rules[0]?.subscriptions).toHaveLength(1);
    expect(rules[0]?.warnings.join(' ')).toContain('внешней подпиской');
  });

  it('показывает локальный список как свои домены и IP', () => {
    const rules = buildRuleViews({
      managed: {
        'section.youtube.action': 'connection',
        'section.youtube.label': 'YouTube',
        'section.youtube.domain': 'keyword:ads',
        'section.youtube.domain_ip_lists': ['/etc/routx-agent/lists/youtube-abc.lst'],
      },
      agentSections: [
        {
          section: 'youtube',
          options: {
            action: 'connection',
            label: 'YouTube',
            domain: 'keyword:ads',
            domain_ip_lists: ['/etc/routx-agent/lists/youtube-abc.lst'],
          },
          subscriptions: [],
          links: [],
          lists: {
            '/etc/routx-agent/lists/youtube-abc.lst': [
              'example.com',
              '203.0.113.10',
              '2001:db8::/32',
            ],
          },
        },
      ],
      connections: [],
      source: 'live',
    });

    expect(rules[0]?.resources.domain).toBe('keyword:ads');
    expect(rules[0]?.manual_domains).toEqual(['example.com']);
    expect(rules[0]?.manual_ips).toEqual(['203.0.113.10', '2001:db8::/32']);
  });
});
