import { describe, expect, it } from 'vitest';
import { parseData } from '../../src/core/data/formats';
import { buildSearchRegExp, searchTree, type SearchOptions } from '../../src/core/data/search';
import { DataTree, F_COLUMN_KEY, F_SYNTHETIC, F_TEXT, T_ARRAY, T_OBJECT, T_STRING, type DataFormat } from '../../src/core/data/tree';

/** What search should find: each key and value tested on its own (decoded) text. */
function reference(tree: DataTree, opts: SearchOptions): string[] {
  const re = buildSearchRegExp(opts);
  const test = new RegExp(re.source, re.flags.replace('g', ''));
  const out: string[] = [];
  for (let id = tree.root; id < tree.root + tree.size[tree.root]; id++) {
    if (tree.flags[id] & F_SYNTHETIC) continue;
    const p = tree.parent[id];
    const keyed = p >= 0 && id !== tree.root && tree.type[p] !== T_ARRAY && !(tree.flags[id] & (F_COLUMN_KEY | F_TEXT));
    if ((opts.keys ?? true) && keyed && test.test(String(tree.key(id)))) {
      out.push(`${id} key`);
      continue;
    }
    const t = tree.type[id];
    if ((opts.values ?? true) && t !== T_OBJECT && t !== T_ARRAY && test.test(t === T_STRING ? tree.stringValue(id) : tree.rawValue(id))) out.push(`${id} value`);
  }
  return out;
}

const found = (tree: DataTree, opts: SearchOptions) => searchTree(tree, { limit: 10_000, ...opts }).hits.map((h) => `${h.id} ${h.in}`);
const paths = (tree: DataTree, opts: SearchOptions) => searchTree(tree, { limit: 10_000, ...opts }).hits.map((h) => tree.pathString(h.id));

const doc = {
  path: 'C:\\Users\\ada',
  city: 'München',
  quote: 'He said "hi"',
  n: 123,
  s: '123',
  abc: 'abc',
  list: ['a', 'abc', 'xabcx', 'a"b', 'tab\there'],
  'k"ey': 'v',
  é: 'accent',
  nested: { abc: { abc: 'abc' } },
  t: true,
  z: null,
};
const json = JSON.stringify(doc);
// The same document with non-ASCII characters escaped, as Python's json.dumps writes it.
const escaped = json.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

describe('searchTree', () => {
  it('matches keys and string values on their decoded text', () => {
    const t = parseData(escaped, 'json');
    expect(paths(t, { query: 'C:\\Users' })).toEqual(['$.path']);
    expect(paths(t, { query: 'München' })).toEqual(['$.city']);
    expect(paths(t, { query: 'said "hi' })).toEqual(['$.quote']);
    expect(paths(t, { query: 'k"ey' })).toEqual([`$['k"ey']`]);
    expect(paths(t, { query: 'é', values: false })).toEqual(["$['é']"]);
    expect(paths(t, { query: '\t' })).toEqual(['$.list[4]']);
    // Escape sequences themselves are not text.
    expect(paths(t, { query: 'u00fc' })).toEqual([]);
    expect(paths(t, { query: '\\\\' })).toEqual([]);
  });

  it('anchors regular expressions to each key or value, in every format', () => {
    const j = parseData('{"a": "abc", "b": "123", "c": 123}', 'json');
    const y = parseData('a: abc\nb: "123"\nc: 123\n', 'yaml');
    for (const t of [j, y]) {
      expect(paths(t, { query: '^\\d+$', regex: true })).toEqual(['$.b', '$.c']);
      expect(paths(t, { query: '^abc$', regex: true })).toEqual(['$.a']);
      expect(paths(t, { query: '^[a-c]$', regex: true, values: false })).toEqual(['$.a', '$.b', '$.c']);
    }
  });

  it('agrees with testing every key and value on its own', () => {
    const sources: [string, DataFormat][] = [
      [json, 'json'],
      [escaped, 'json'],
      [JSON.stringify(doc, null, 2), 'json'],
      ["{path: 'C:\\\\Users', 'quote': 'said \"hi\"', abc: [1e3, .5, 'abc'], 'k\\u0065y': 1}", 'json5'],
      ['path: "C:\\\\Users\\\\ada"\ncity: München\nquote: He said "hi"\nn: 123\ns: "123"\nabc: abc\nlist: [a, abc, xabcx]\n', 'yaml'],
      ['<r a="abc" b="x &amp; y"><abc>abc</abc><p>a &lt; b</p><q>said "hi</q><n>123</n><abc/></r>', 'xml'],
      ['name,city,n\n"abc","München",1\nabc,"said ""hi""",123\n"x,y",abc,5\n', 'csv'],
      ['a = "abc"\n[t]\nabc = 123\n', 'toml'],
    ];
    const queries: SearchOptions[] = [
      { query: 'abc' },
      { query: 'abc', wholeWord: true },
      { query: 'ABC', caseSensitive: true },
      { query: 'Abc' },
      { query: 'abc', keys: false },
      { query: 'abc', values: false },
      { query: 'C:\\Users' },
      { query: 'said "hi' },
      { query: 'München' },
      { query: '"' },
      { query: ',' },
      { query: '123' },
      { query: '1e3' },
      { query: '&' },
      { query: '^a', regex: true },
      { query: 'b$', regex: true },
      { query: 'a.*c', regex: true },
    ];
    for (const [text, format] of sources) {
      const t = parseData(text, format);
      for (const q of queries) expect(found(t, q), `${format} ${JSON.stringify(q)} in ${text.slice(0, 30)}`).toEqual(reference(t, q));
    }
  });

  it('finds decoded CSV cells, XML entities and attribute keys', () => {
    const csv = parseData('a,b\n"say ""hi""",x\n"plain",y\n', 'csv');
    expect(paths(csv, { query: 'say "hi"' })).toEqual(['$[0].a']);
    expect(paths(csv, { query: '^plain$', regex: true })).toEqual(['$[1].a']);
    const xml = parseData('<r id="1"><x id="2">a &amp; b</x></r>', 'xml');
    expect(paths(xml, { query: 'a & b' })).toEqual(['$.x[\'#text\']']);
    expect(paths(xml, { query: '@id' })).toEqual(["$['@id']", "$.x['@id']"]);
    expect(paths(xml, { query: '^@id$', regex: true })).toEqual(["$['@id']", "$.x['@id']"]);
  });

  it('does not let one greedy match hide the next values', () => {
    const t = parseData(JSON.stringify({ a: 'user1', b: 'user2', c: 'user3' }), 'json');
    expect(paths(t, { query: 'user.*', regex: true })).toEqual(['$.a', '$.b', '$.c']);
    expect(paths(t, { query: 'user1", "b' })).toEqual([]);
  });

  it('reports one hit per node and an exact truncated flag', () => {
    const t = parseData(JSON.stringify({ name: 'name', list: ['x', 'x', 'x'] }), 'json');
    expect(searchTree(t, { query: 'name' }).hits).toEqual([{ id: t.firstChild(t.root), in: 'key' }]);
    expect(searchTree(t, { query: 'x', limit: 3 })).toMatchObject({ truncated: false });
    expect(searchTree(t, { query: 'x', limit: 2 })).toMatchObject({ truncated: true });
    expect(searchTree(t, { query: 'x', limit: 2 }).hits.length).toBe(2);
  });

  it('keeps the source scan fast on big documents', () => {
    const items = Array.from({ length: 100_000 }, (_, i) => ({ id: i, name: `user${i}`, note: i % 100 ? 'plain' : 'line\nbreak "quoted"' }));
    const t = parseData(JSON.stringify({ items }), 'json');
    searchTree(t, { query: 'warm-up' });
    const started = performance.now();
    for (let i = 0; i < 10; i++) searchTree(t, { query: `zz-${i}` });
    // A few milliseconds per scan here; a per-node fallback would take far longer.
    expect((performance.now() - started) / 10).toBeLessThan(200);
    expect(searchTree(t, { query: 'break "quoted' }).hits.length).toBe(1000);
  });
});
