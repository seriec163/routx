import { describe, expect, it } from 'vitest';
import { validateProposal } from '../src/routers/dns.js';

describe('DNS proposal validation', () => {
  it('accepts UDP IP servers and bootstrap', () => {
    const result = validateProposal({
      dns_type: 'udp',
      dns_server: ['9.9.9.9', '1.1.1.1'],
      bootstrap_dns_server: ['77.88.8.8'],
    });
    expect(result.dns_type).toBe('udp');
    expect(result.dns_server).toEqual(['9.9.9.9', '1.1.1.1']);
  });

  it('accepts DoH https URLs', () => {
    const result = validateProposal({
      dns_type: 'doh',
      dns_server: ['https://cloudflare-dns.com/dns-query'],
      bootstrap_dns_server: ['1.1.1.1'],
    });
    expect(result.dns_type).toBe('doh');
  });

  it('rejects a non-IP UDP server', () => {
    expect(() =>
      validateProposal({
        dns_type: 'udp',
        dns_server: ['dns.example.com'],
        bootstrap_dns_server: ['1.1.1.1'],
      }),
    ).toThrow();
  });

  it('rejects non-HTTPS DoH URLs', () => {
    expect(() =>
      validateProposal({
        dns_type: 'doh',
        dns_server: ['http://cloudflare-dns.com/dns-query'],
        bootstrap_dns_server: ['1.1.1.1'],
      }),
    ).toThrow();
  });

  it('rejects a non-IP bootstrap server', () => {
    expect(() =>
      validateProposal({
        dns_type: 'udp',
        dns_server: ['9.9.9.9'],
        bootstrap_dns_server: ['bootstrap.example.com'],
      }),
    ).toThrow();
  });

  it('deduplicates server lists', () => {
    const result = validateProposal({
      dns_type: 'udp',
      dns_server: ['9.9.9.9', '9.9.9.9'],
      bootstrap_dns_server: ['1.1.1.1', '1.1.1.1'],
    });
    expect(result.dns_server).toEqual(['9.9.9.9']);
    expect(result.bootstrap_dns_server).toEqual(['1.1.1.1']);
  });
});
