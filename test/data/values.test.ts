import { describe, expect, it } from 'vitest';
import { colorOf, hexToRgba, relativeTime, rgbToHsl, valueHints } from '../../src/webview/values';

const kinds = (type: Parameters<typeof valueHints>[0], text: string, key?: string) => valueHints(type, text, key).map((h) => h.kind);

describe('value hints', () => {
  it('recognises colors without mistaking issue numbers for them', () => {
    expect(colorOf('#7c8cff')).toBe('#7c8cff');
    expect(colorOf('#000000')).toBe('#000000');
    expect(colorOf('#fff')).toBe('#fff');
    expect(colorOf('rgb(255, 0, 0)')).toBe('rgb(255, 0, 0)');
    expect(colorOf('rgba(0,0,0,0.5)')).toBe('rgba(0,0,0,0.5)');
    expect(colorOf('hsl(120deg 100% 50% / 50%)')).toBe('hsl(120deg 100% 50% / 50%)');
    expect(colorOf('#123')).toBeNull();
    expect(colorOf('#123', 'color')).toBe('#123');
    expect(colorOf('#12345')).toBeNull();
    expect(colorOf('rgb(1, 2)')).toBeNull();
    expect(colorOf('red')).toBeNull();
  });

  it('recognises images, links and emails', () => {
    expect(kinds('string', 'https://example.com/a/cat.PNG?size=2')).toEqual(['image', 'link']);
    expect(kinds('string', 'https://example.com/u/42', 'avatar_url')).toEqual(['image', 'link']);
    expect(kinds('string', 'https://example.com/docs')).toEqual(['link']);
    expect(kinds('string', 'data:image/png;base64,iVBORw0KGgo=')).toEqual(['image']);
    expect(kinds('string', 'ada@example.com')).toEqual(['email']);
    expect(kinds('string', 'not a url')).toEqual([]);
  });

  it('recognises ISO dates and timestamps only where a key suggests time', () => {
    expect(valueHints('string', '2024-02-29T12:30:00Z')).toEqual([{ kind: 'date', ms: Date.UTC(2024, 1, 29, 12, 30), from: 'iso' }]);
    expect(kinds('string', '2024-02-29')).toEqual(['date']);
    expect(kinds('string', '2024-13-45')).toEqual([]);
    expect(valueHints('number', '1700000000', 'created_at')).toEqual([{ kind: 'date', ms: 1_700_000_000_000, from: 'seconds' }]);
    expect(valueHints('number', '1700000000000', 'updatedAt')[0]).toMatchObject({ kind: 'date', from: 'millis' });
    expect(kinds('number', '1700000000', 'id')).toEqual([]);
    expect(kinds('number', '42', 'timestamp')).toEqual([]);
  });

  it('decodes JWTs and JSON inside strings', () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'ada', name: 'Ada Lövelace', exp: 1700000000 })}.c2lnbmF0dXJl`;
    expect(valueHints('string', jwt)).toEqual([{ kind: 'jwt', header: { alg: 'HS256', typ: 'JWT' }, payload: { sub: 'ada', name: 'Ada Lövelace', exp: 1700000000 } }]);
    expect(valueHints('string', '{"a":[1,2]}')).toEqual([{ kind: 'json', value: { a: [1, 2] } }]);
    expect(kinds('string', '{not json}')).toEqual([]);
    expect(kinds('string', '[]')).toEqual(['json']);
  });

  it('converts and formats', () => {
    expect(hexToRgba('#f80')).toEqual([255, 136, 0, 1]);
    expect(hexToRgba('#00000080')).toEqual([0, 0, 0, 0.5]);
    expect(rgbToHsl(255, 0, 0)).toEqual([0, 100, 50]);
    const now = Date.UTC(2026, 0, 10);
    expect(relativeTime(now - 3 * 86_400_000, now)).toMatch(/3 days ago/);
    expect(relativeTime(now + 2 * 3_600_000, now)).toMatch(/in 2 hours/);
  });
});
