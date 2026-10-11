import { describe, expect, it } from 'vitest';
import { parseData } from '../../src/core/data/formats';
import { inferSchema, schemaToJsonSchema, schemaToText, schemaToTypeScript } from '../../src/core/data/schema';
import { QueryError, runQuery } from '../../src/core/data/query';
import { searchTree } from '../../src/core/data/search';

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
