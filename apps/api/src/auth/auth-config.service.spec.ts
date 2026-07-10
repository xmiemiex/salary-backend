import { parseSessionTtlHours, parseSessionTtlSeconds, parseWebOrigin } from './auth-config.service';

describe('auth configuration', () => {
  it('validates TTL', () => {
    expect(parseSessionTtlHours(undefined)).toBe(12);
    expect(parseSessionTtlHours('1')).toBe(1);
    expect(parseSessionTtlHours('168')).toBe(168);
    for (const value of ['0', '169', '1.5', '-1', 'abc']) expect(() => parseSessionTtlHours(value)).toThrow();
  });

  it('validates the seconds-based session TTL', () => {
    expect(parseSessionTtlSeconds(undefined)).toBe(43200);
    expect(parseSessionTtlSeconds('60')).toBe(60);
    expect(parseSessionTtlSeconds('604800')).toBe(604800);
    for (const value of ['0', '59', '604801', '60.5', '-1', 'abc']) {
      expect(() => parseSessionTtlSeconds(value)).toThrow();
    }
  });

  it('accepts only an explicit http(s) origin', () => {
    expect(parseWebOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    for (const value of ['*', 'localhost:5173', 'http://localhost:5173/', 'http://localhost:5173/path']) expect(() => parseWebOrigin(value)).toThrow();
  });
});
