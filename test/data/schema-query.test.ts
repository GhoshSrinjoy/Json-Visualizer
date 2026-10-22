import { describe, expect, it } from 'vitest';
import { parseData } from '../../src/core/data/formats';
import { detectStringFormat, inferSchema, schemaToJsonSchema, schemaToText, schemaToTypeScript } from '../../src/core/data/schema';
import { QueryError, runQuery } from '../../src/core/data/query';
import { searchTree } from '../../src/core/data/search';
import type { DataFormat } from '../../src/core/data/tree';

// ---------------------------------------------------------------- a small JSON Schema checker

// Format checks as ajv-formats' full mode implements them (RFC 3339 with a
// required offset, RFC 3986 URIs, …), independent of the inference code.
const AJV_TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
const AJV_URI =
  /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
const isDate = (s: string) => {
  const m = /^(\d\d\d\d)-(\d\d)-(\d\d)$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= (mo === 2 ? (leap ? 29 : 28) : [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo]);
};
const isTime = (s: string) => {
  const m = AJV_TIME.exec(s);
  return !!m && !!m[4] && +m[1] <= 23 && +m[2] <= 59 && +m[3] < 60 && +(m[6] || 0) <= 23 && +(m[7] || 0) <= 59;
};
const FORMAT_CHECKS: Record<string, (s: string) => boolean> = {
  date: isDate,
  time: isTime,
  'date-time': (s) => {
    const parts = s.split(/t|\s/i);
    return parts.length === 2 && isDate(parts[0]) && isTime(parts[1]);
  },
  email: (s) => /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(s),
  uri: (s) => /\/|:/.test(s) && AJV_URI.test(s),
  uuid: (s) => /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(s),
  ipv4: (s) => /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(s),
};

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  format?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: Schema;
  items?: Schema;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case 'integer':
      return Number.isInteger(v);
    case 'number':
      return typeof v === 'number';
    case 'null':
      return v === null;
    case 'array':
      return Array.isArray(v);
    case 'object':
      return isRecord(v);
    default:
      return typeof v === t;
  }
}

/** Violations of the keywords schemaToJsonSchema emits. */
function violations(s: Schema, v: unknown, path = '$'): string[] {
  const out: string[] = [];
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  if (types.length && !types.some((t) => typeOk(t, v))) out.push(`${path}: ${JSON.stringify(v)} is not ${types.join(' | ')}`);
  if (s.enum && !s.enum.some((e) => e === v)) out.push(`${path}: ${JSON.stringify(v)} is not one of ${JSON.stringify(s.enum)}`);
  if (s.format && typeof v === 'string') {
    if (!FORMAT_CHECKS[s.format]) out.push(`${path}: unexpected format ${s.format}`);
    else if (!FORMAT_CHECKS[s.format](v)) out.push(`${path}: ${JSON.stringify(v)} is not a ${s.format}`);
  }
  if (isRecord(v)) {
    for (const k of s.required ?? []) if (!(k in v)) out.push(`${path}: missing ${k}`);
    for (const [k, x] of Object.entries(v)) {
      const sub = s.properties?.[k] ?? s.additionalProperties;
      if (sub) out.push(...violations(sub, x, `${path}.${k}`));
    }
  }
  if (Array.isArray(v) && s.items) v.forEach((x, i) => out.push(...violations(s.items!, x, `${path}[${i}]`)));
  return out;
}

const users = {
  users: Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `User ${i}`,
    email: i % 10 === 0 ? null : `u${i}@example.com`,
    role: ['admin', 'editor', 'viewer'][i % 3],
    age: 18 + (i % 40),
    tags: i % 2 ? ['x', 'y'] : [],
    ...(i % 5 === 0 ? { nickname: `nick${i}` } : {}),
    created: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
  })),
  byId: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(1000 + i), { score: i * 1.5 }])),
  meta: { version: 3, ok: true },
};
const tree = parseData(JSON.stringify(users), 'json');

describe('inferSchema', () => {
  const result = inferSchema(tree);
  it('merges array items and detects optional fields, enums, formats and maps', () => {
    const u = result.root.fields!.get('users')!;
    expect(u.types.array).toBe(1);
    const item = u.items!;
    expect(item.objects).toBe(50);
    expect(item.fields!.get('nickname')!.count).toBe(10);
    const text = schemaToText(result);
    expect(text).toContain('nickname?: string');
    expect(text).toContain('email: string | null');
    expect(text).toContain('enum "admin" | "editor" | "viewer"');
    expect(text).toContain('format date-time');
    expect(text).toContain('age: integer');
    expect(text).toMatch(/byId: map<string, object>/);
    expect(text).toMatch(/\[key\]: object/);
  });
  it('exports JSON Schema and TypeScript', () => {
    const js = schemaToJsonSchema(result) as any;
    expect(js.properties.users.items.required).toContain('id');
    expect(js.properties.users.items.required).not.toContain('nickname');
    expect(js.properties.users.items.properties.created.format).toBe('date-time');
    expect(js.properties.byId.additionalProperties.properties.score.type).toBe('number');
    const ts = schemaToTypeScript(result);
    expect(ts).toContain('export interface Root {');
    expect(ts).toContain('users: User[];');
    expect(ts).toContain('nickname?: string;');
    expect(ts).toContain('role: "admin" | "editor" | "viewer";');
    expect(ts).toContain('byId: Record<string, ByIdItem>;');
  });
  it('exports JSON Schemas that accept the documents they were inferred from', () => {
    const rep = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
    const formats = rep(8, (i) => ({
      dt: ['2024-01-01T10:00:00Z', '2024-02-29T23:59:59.5+05:30', '2024-03-01t00:00:00z', '2023-12-31T12:00:00-08:00'][i % 4],
      local: ['2024-01-01T10:00', '2024-01-01 10:00:00'][i % 2],
      t: ['10:30:00Z', '23:59:59.999+01:00'][i % 2],
      lt: ['10:30', '07:05:09'][i % 2],
      d: ['2024-02-29', '2023-02-28'][i % 2],
      url: ['https://example.com/a?b=c#d', 'http://user@host:8080/p%20q'][i % 2],
      template: ['https://api.github.com/users/x/followers{/other_user}', 'https://x.org/a'][i % 2],
      mail: ['a.b@example.co.uk', 'x+y@d-e.org'][i % 2],
      ip: ['10.0.0.1', '255.255.255.255'][i % 2],
      notIp: ['999.1.1.1', '1.2.3.4'][i % 2],
      uuid: ['123e4567-e89b-12d3-a456-426614174000', '00000000-0000-0000-0000-000000000000'][i % 2],
      sometimes: i < 7 ? '2024-01-01' : 'n/a',
    }));
    const docs: [string, DataFormat, string][] = [
      ['users', 'json', JSON.stringify(users)],
      ['nullable enum', 'json', JSON.stringify(rep(12, (i) => ({ status: ['open', 'closed', null, true][i % 4], level: [1, 2, 2.5][i % 3] })))],
      ['JSON5 numbers', 'json5', `[${rep(12, (i) => `{v: ${['0x1F', '-0x10', '.5', '+2', 'Infinity', 'NaN'][i % 6]}, h: ${['0x1', '0x2'][i % 2]}}`).join(',')}]`],
      ['CSV', 'csv', 'id,score,label,flag,empty\n' + rep(12, (i) => `${i},${['.5', '1.25', '-3'][i % 3]},"${['a,b', 'say ""hi""', 'plain'][i % 3]}",${i % 2 ? 'true' : 'false'},`).join('\n')],
      ['XML', 'xml', '<lib><shelf id="1"><book>A</book><book>B</book></shelf><shelf id="2"><book>C</book></shelf><note>x &amp; y</note><note>z</note></lib>'],
      ['YAML', 'yaml', 'base:\n  host: db\n  port: 5432\nlist:\n  - 1\n  - two\n  - null\nwhen: 2024-01-01T10:00:00Z\n'],
      ['TOML', 'toml', 'when = 1979-05-27T07:32:00\nday = 1979-05-27\nat = 07:32:00\nstamp = 1979-05-27T07:32:00Z\n[[items]]\nn = 1\n[[items]]\nn = 2\nextra = "x"\n'],
      ['formats', 'json', JSON.stringify(formats)],
      ['duplicate keys', 'json', '[{"a":1,"a":"x"},{"b":1}]'],
      ['mixed', 'json', JSON.stringify([1, 'two', null, [3, [4, 'x']], { k: [] }, { k: [{ z: 1 }] }, true])],
      ['deeper than the schema depth', 'json', '['.repeat(300) + '{"a":1}' + ']'.repeat(300)],
    ];
    for (const [name, format, text] of docs) {
      const t = parseData(text, format);
      const schema = schemaToJsonSchema(inferSchema(t)) as Schema;
      expect(violations(schema, t.toJS()), name).toEqual([]);
    }

    const nullable = schemaToJsonSchema(inferSchema(parseData(docs[1][2], 'json'))) as any;
    expect(nullable.items.properties.status.enum).toEqual(['open', 'closed', true, null]);
    expect(nullable.items.properties.level.enum).toEqual([1, 2, 2.5]);
    const json5 = schemaToJsonSchema(inferSchema(parseData(docs[2][2], 'json5'))) as any;
    expect(json5.items.properties.h).toEqual({ type: 'integer', enum: [1, 2] });
    expect(json5.items.properties.v.enum).toBeUndefined(); // NaN and Infinity have no JSON form
    const f = (schemaToJsonSchema(inferSchema(parseData(docs[7][2], 'json'))) as any).items.properties;
    expect(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, (v as Schema).format]))).toEqual({
      dt: 'date-time',
      local: undefined,
      t: 'time',
      lt: undefined,
      d: 'date',
      url: 'uri',
      template: undefined,
      mail: 'email',
      ip: 'ipv4',
      notIp: undefined,
      uuid: 'uuid',
      sometimes: undefined, // every value is checked, not just the first ones
    });
    const text = schemaToText(inferSchema(parseData(docs[7][2], 'json')));
    expect(text).toContain('local: string  format local-date-time');
    expect(text).toContain('lt: string  format local-time');
  });

  it('detects formats strictly', () => {
    expect(detectStringFormat('2024-01-01T10:00:00Z')).toBe('date-time');
    expect(detectStringFormat('2024-01-01 10:00:00Z')).toBeUndefined(); // RFC 3339 needs the T
    expect(detectStringFormat('2024-01-01T10:00')).toBe('local-date-time');
    expect(detectStringFormat('10:30')).toBe('local-time');
    expect(detectStringFormat('10:30:00+05:30')).toBe('time');
    expect(detectStringFormat('10:30+05:30')).toBeUndefined();
    expect(detectStringFormat('24:00:00Z')).toBeUndefined();
    expect(detectStringFormat('2023-02-29')).toBeUndefined();
    expect(detectStringFormat('2024-13-01')).toBeUndefined();
    expect(detectStringFormat('256.1.1.1')).toBeUndefined();
    expect(detectStringFormat('a..b@example.com')).toBeUndefined();
    expect(detectStringFormat('http://example.com/a b')).toBeUndefined();
  });

  it('describes repeated XML elements as the arrays toJS() makes of them', () => {
    const xml = parseData('<lib><shelf><book>A</book></shelf><shelf><book>B</book><book>C</book></shelf></lib>', 'xml');
    expect(xml.toJS()).toEqual({ shelf: [{ book: { '#text': 'A' } }, { book: [{ '#text': 'B' }, { '#text': 'C' }] }] });
    const r = inferSchema(xml);
    const shelf = r.root.fields!.get('shelf')!;
    expect(shelf.types).toEqual({ array: 1 });
    expect(shelf.items!.count).toBe(2);
    const book = shelf.items!.fields!.get('book')!;
    expect(book.types).toEqual({ object: 1, array: 1 });
    expect(book.count).toBe(2); // present in both shelves
    expect(book.items!.count).toBe(2);
    expect(schemaToText(r)).toContain('shelf: array<object>  2 items');
    expect(schemaToTypeScript(r)).toMatch(/shelf: \w+\[\];/);
  });

  it('counts a key repeated within one object once', () => {
    const r = inferSchema(parseData('[{"a":1,"a":2},{"b":1}]', 'json'));
    const a = r.root.items!.fields!.get('a')!;
    expect(a.count).toBe(1);
    expect(a.types.number).toBe(2);
    expect((schemaToJsonSchema(r) as any).items.required).toBeUndefined();
  });

  it('stays bounded on very deep nesting', () => {
    const deep = parseData('['.repeat(20000) + '{"a":1}' + ']'.repeat(20000), 'json');
    const r = inferSchema(deep);
    expect(r.depthLimited).toBe(true);
    expect(schemaToTypeScript(r)).toContain('unknown');
    expect(JSON.stringify(schemaToJsonSchema(r)).length).toBeGreaterThan(256 * 10);
    expect(schemaToText(r, { maxDepth: 100_000 })).toContain('not described');
  });

  it('samples very large arrays', () => {
    const big = parseData(JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ i }))), 'json');
    const r = inferSchema(big, big.root, { sampleArrayItems: 1000 });
    expect(r.sampled).toBe(true);
    expect(r.root.items!.count).toBeLessThanOrEqual(1001);
    expect(r.root.minItems).toBe(20000);
  });
});

describe('runQuery', () => {
  const q = (s: string, limit?: number) => runQuery(tree, s, limit).ids.map((id) => tree.toJS(id));
  it('supports names, indexes, slices, wildcards and unions', () => {
    expect(q('$.meta.version')).toEqual([3]);
    expect(q('meta.version')).toEqual([3]);
    expect(q("$['meta']['ok']")).toEqual([true]);
    expect(q('$.users[0].name')).toEqual(['User 0']);
    expect(q('$.users[-1].id')).toEqual([50]);
    expect(q('$.users[0:3].id')).toEqual([1, 2, 3]);
    expect(q('$.users[::20].id')).toEqual([1, 21, 41]);
    expect(q('$.users[0,2].id')).toEqual([1, 3]);
    expect(q('$.meta.*')).toEqual([3, true]);
    expect(runQuery(tree, '$..score').total).toBe(30);
  });
  it('supports filters', () => {
    expect(q('$.users[?(@.age > 55)].id')).toEqual([39, 40]);
    expect(q("$.users[?@.role == 'admin' && @.id > 40].id")).toEqual([43, 46, 49]);
    expect(q('$.users[?(@.nickname)].id')).toEqual([1, 6, 11, 16, 21, 26, 31, 36, 41, 46]);
    expect(q('$.users[?(@.email =~ /u4\\d@/)].id')).toEqual([42, 43, 44, 45, 46, 47, 48, 49, 50]);
    expect(q('$.users[?length(@.tags) > 0 && @.id < 5].id')).toEqual([2, 4]);
    // Bare paths use JavaScript truthiness (Goessner/Jayway semantics).
    expect(q('$.users[?(!@.email)].id')).toEqual([1, 11, 21, 31, 41]);
    expect(q('$.users[?@.email == null].id')).toEqual([1, 11, 21, 31, 41]);
    expect(runQuery(tree, '$.users[?!@.nickname]').total).toBe(40);
  });
  it('parses filter shapes with parentheses, negation, alternatives and literals', () => {
    const rows = parseData(
      JSON.stringify([
        { id: 1, a: 1, b: 2, s: 'x)y', t: 'a]b', ok: true, n: null, list: [1, 5] },
        { id: 2, a: 1, b: 3, s: "it's", t: '', ok: false, list: [] },
        { id: 3, a: 2, b: 2, s: 'x', t: 'q', ok: true, n: 0, list: [0] },
      ]),
      'json',
    );
    const f = (filter: string) => runQuery(rows, `$[?${filter}].id`).ids.map((id) => rows.value(id));
    expect(f('(@.a == 1) && (@.b == 2)')).toEqual([1]);
    expect(f('(@.a == 1 && @.b == 2)')).toEqual([1]);
    expect(f('(@.b == 2) || @.b == 3')).toEqual([1, 2, 3]);
    expect(f('((@.a == 1) && ((@.b == 3)))')).toEqual([2]);
    expect(f('(!(@.a == 1) || @.b == 3)')).toEqual([2, 3]);
    expect(f('!(@.a == 1)')).toEqual([3]);
    expect(f('(@.a == 1) && !(@.ok)')).toEqual([2]);
    expect(f("(@.s == 'x)y')")).toEqual([1]);
    expect(f("(@.t == 'a]b')")).toEqual([1]);
    expect(f(`(@.s == "it's")`)).toEqual([2]);
    expect(f("(@.s == 'it\\'s')")).toEqual([2]);
    expect(f("(@.t == '')")).toEqual([2]);
    // Numbers, strings, booleans and null.
    expect(f('(@.a >= 2)')).toEqual([3]);
    expect(f('(@.b < 3 && @.b > 1)')).toEqual([1, 3]);
    expect(f('(@.a == 1.0)')).toEqual([1, 2]);
    expect(f("(@.s == 'x')")).toEqual([3]);
    expect(f("(@.s < 'x')")).toEqual([2]);
    expect(f('(@.ok == true)')).toEqual([1, 3]);
    expect(f('(@.ok == false)')).toEqual([2]);
    expect(f('(@.n == null)')).toEqual([1]);
    expect(f('(@.n != null)')).toEqual([2, 3]);
    // Functions, regexes, root references and nested filters.
    expect(f('(length(@.s) > 3)')).toEqual([2]);
    expect(f("(match(@.s, 'x.*'))")).toEqual([1, 3]);
    expect(f("(search(@.s, 'y'))")).toEqual([1]);
    expect(f('(@.s =~ /^x/)')).toEqual([1, 3]);
    expect(f('(@.a == $[2].a)')).toEqual([3]);
    expect(f('(@.list[?(@ > 1)])')).toEqual([1]);
    expect(f('(count(@.list[*]) == 0)')).toEqual([2]);
  });

  it('decodes escapes in quoted names', () => {
    const t = parseData(JSON.stringify({ é: 1, 'a"b': 2, "a'b": 3, 'tab\there': 4, '\\': 5 }), 'json');
    const v = (q: string) => runQuery(t, q).ids.map((id) => t.value(id));
    expect(v("$['\\u00e9']")).toEqual([1]);
    expect(v('$["\\u00E9"]')).toEqual([1]);
    expect(v('$["a\\"b"]')).toEqual([2]);
    expect(v("$['a\\'b']")).toEqual([3]);
    expect(v("$['tab\\there']")).toEqual([4]);
    expect(v("$['\\\\']")).toEqual([5]);
    expect(() => runQuery(t, "$['\\u00g9']")).toThrow(QueryError);
    // Paths printed for these keys parse back to the same node.
    for (const k of runQuery(t, '$.*').ids) expect(runQuery(t, t.pathString(k)).ids).toEqual([k]);
  });

  it('fails cleanly on deeply nested queries and flags capped totals', () => {
    expect(() => runQuery(tree, '$[?(' + '('.repeat(5000) + '@.a' + ')'.repeat(5000) + ')]')).toThrow(QueryError);
    expect(() => runQuery(tree, '$[?(' + '!'.repeat(100_000) + '@.a)]')).toThrow(QueryError);
    expect(runQuery(tree, '$.users[?(' + Array(50_000).fill('@.id').join(' && ') + ')]').total).toBe(50);
    const big = parseData(JSON.stringify(Array.from({ length: 150_000 }, (_, i) => i)), 'json');
    const r = runQuery(big, '$..*', 10);
    expect(r.capped).toBe(true);
    expect(r.total).toBeGreaterThan(100_000);
    expect(runQuery(big, '$[0:5]', 10).capped).toBe(false);
  });

  it('reports totals and syntax errors', () => {
    const r = runQuery(tree, '$.users[*].id', 5);
    expect(r.ids.length).toBe(5);
    expect(r.total).toBe(50);
    expect(r.truncated).toBe(true);
    expect(() => runQuery(tree, '$.users[?(@.a ==)]')).toThrow(QueryError);
  });
  it('indexes same-named XML siblings', () => {
    const xml = parseData('<lib><book><t>A</t></book><book><t>B</t></book></lib>', 'xml');
    const r = runQuery(xml, '$.book[1].t');
    expect(r.ids.map((id) => xml.toJS(id))).toEqual([{ '#text': 'B' }]);
    expect(runQuery(xml, '$.book').total).toBe(2);
  });
});

describe('searchTree', () => {
  it('finds keys and values via the source text', () => {
    const r = searchTree(tree, { query: 'nick1' });
    expect(r.hits.map((h) => tree.pathString(h.id))).toEqual(['$.users[10].nickname', '$.users[15].nickname']);
    const keys = searchTree(tree, { query: 'nickname', values: false });
    expect(keys.hits.every((h) => h.in === 'key')).toBe(true);
    expect(keys.hits.length).toBe(10);
  });
  it('supports regex, case and limits', () => {
    expect(searchTree(tree, { query: 'USER 4\\d', regex: true }).hits.length).toBe(10);
    expect(searchTree(tree, { query: 'USER 4', caseSensitive: true }).hits.length).toBe(0);
    expect(searchTree(tree, { query: 'example', limit: 3 }).truncated).toBe(true);
    expect(searchTree(tree, { query: '(', regex: true }).error).toBeTruthy();
  });
  it('falls back to node scanning for positionless trees', () => {
    const toml = parseData('a = "needle"\n[b]\nc = "hay"\n', 'toml');
    expect(searchTree(toml, { query: 'needle' }).hits.length).toBe(1);
  });
});
