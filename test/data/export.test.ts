import { describe, expect, it } from 'vitest';
import { parseData } from '../../src/core/data/formats';
import { parseJson } from '../../src/core/data/json';
import { runQuery } from '../../src/core/data/query';
import { jsonNumber, parseNumber, type DataFormat } from '../../src/core/data/tree';
import { dataMatchesText } from '../../src/core/format/text';

describe('JSON export (toJSON / jsonText)', () => {
  it('exports every row of documents past the old 200k-node display budget', () => {
    const rows = ['a,b,c,d,e,f,g,h'];
    for (let i = 0; i < 30_000; i++) rows.push(`${i},x${i},${i * 2},y,z,1,2,3`);
    const tree = parseData(rows.join('\n'), 'csv');
    expect(tree.nodeCount()).toBeGreaterThan(200_000);
    const text = tree.toJSON(tree.root, 2);
    expect(text).not.toContain('more');
    const arr = JSON.parse(text) as Record<string, unknown>[];
    expect(arr).toHaveLength(30_000);
    expect(arr[29_999]).toEqual({ a: 29999, b: 'x29999', c: 59998, d: 'y', e: 'z', f: 1, g: 2, h: 3 });
  });

  it('writes the same text as JSON.stringify for every format', () => {
    const samples: [string, DataFormat][] = [
      ['{"a":1,"b":[1,2,{"c":null,"d":true,"e":false}],"f":"x\\ny","g":{},"h":[]}', 'json'],
      ['[1,[2,[3,[]]],{}]', 'json'],
      ['"just a string"', 'json'],
      ['{"a":1}\n{"b":[2]}\n', 'jsonl'],
      ["{a: 'x', // comment\n b: [1, 2,], c: 'it\\'s'}", 'json5'],
      ['a: 1\nb: [x, "y z", {c: 2.5}]\nd:\ne: true\n---\nsecond: doc\n', 'yaml'],
      ['<r a="1"><b>x</b><b>y</b><c/>text<b><d>1</d></b></r>', 'xml'],
      ['id,name,score\n1,"A, ""q""",9.5\n2,B,\n', 'csv'],
      ['x = 1\n[t]\ny = "z"\n[[arr]]\nk = 1\n[[arr]]\nk = 2\n', 'toml'],
      ['[s]\nk = v\nn = 5\n', 'ini'],
      ['A=1\nB="two"\n', 'env'],
    ];
    for (const [src, format] of samples) {
      const tree = parseData(src, format);
      for (const indent of [undefined, 0, 2, 4]) {
        expect(tree.jsonText(tree.root, indent).text, `${format}, indent ${indent}`).toBe(JSON.stringify(tree.toJS(), null, indent));
      }
    }
  });

  it('keeps the digits of big integers in every format', () => {
    const big = '12345678901234567890';
    const cases: [string, DataFormat][] = [
      [`{"id": ${big}, "n": 9007199254740993}`, 'json'],
      [`id: ${big}\nn: 9007199254740993\n`, 'yaml'],
      [`id = ${big}\nn = 9007199254740993\n`, 'toml'],
      [`id,n\n${big},9007199254740993\n`, 'csv'],
    ];
    for (const [src, format] of cases) {
      const tree = parseData(src, format);
      const text = tree.toJSON(tree.root, 0);
      expect(text, format).toContain(`"id":${big}`);
      expect(text, format).toContain('"n":9007199254740993');
    }
  });

  it('turns number spellings JSON lacks into what JSON.stringify writes', () => {
    const json5 = parseJson('[Infinity, NaN, -Infinity, +1, .5, 5., -.5e1]', { format: 'json5' });
    expect(json5.toJSON(json5.root, 0)).toBe('[null,null,null,1,0.5,5,-5]');
    expect(json5.toJS()).toEqual([Infinity, NaN, -Infinity, 1, 0.5, 5, -5]);
    const yaml = parseData('h: 0x1F\no: 0o17\np: +5\ni: .inf\nm: -.inf\nn: .nan\nf: 1.50\n', 'yaml');
    expect(yaml.toJSON(yaml.root, 0)).toBe('{"h":31,"o":15,"p":5,"i":null,"m":null,"n":null,"f":1.50}');
    const toml = parseData('a = 1_000\nb = 0x1F\nc = inf\nd = nan\ne = -inf\nf = 0b11\n', 'toml');
    expect(toml.toJSON(toml.root, 0)).toBe('{"a":1000,"b":31,"c":null,"d":null,"e":null,"f":3}');
    const csv = parseData('a,b,c,d\n 5 ,+1,.5,007\n', 'csv');
    expect(csv.toJSON(csv.root, 0)).toBe('[{"a":5,"b":1,"c":0.5,"d":"007"}]');
  });

  it('normalises number literals without losing digits', () => {
    const cases: Record<string, string | undefined> = {
      '12345678901234567890': '12345678901234567890',
      '-0': '-0',
      '1E400': '1E400',
      '+1': '1',
      '.5': '0.5',
      '5.': '5',
      '007': '7',
      '1_000.50': '1000.5',
      '+.5e3': '500',
      '+12345678901234567890': '12345678901234567890',
      '0012345678901234567890': '12345678901234567890',
      '0xFFFFFFFFFFFFFFFFFF': '4722366482869645213695',
      '-0x1F': '-31',
      '0o17': '15',
      Infinity: 'null',
      '.NaN': 'null',
      '1.2.3': undefined,
      '-': undefined,
    };
    for (const [raw, json] of Object.entries(cases)) expect(jsonNumber(raw), raw).toBe(json);
    expect(parseNumber('-0x1F')).toBe(-31);
    expect(parseNumber('+.inf')).toBe(Infinity);
    expect(parseNumber('1_000')).toBe(1000);
    expect(parseNumber('abc')).toBeNaN();
  });

  it('writes valid JSON for non-JSON strings and keys and keeps keys as written', () => {
    const tree = parseJson("{'k\\'1': 'sq \"x\"', bare: \"tab\there\", \"e\": \"\\x41\\u00e9\", \"2\": 1, \"1\": 2, \"__proto__\": {\"p\": 1}}", { format: 'json5' });
    const text = tree.toJSON(tree.root, 0);
    expect(text).toBe('{"k\'1":"sq \\"x\\"","bare":"tab\\there","e":"Aé","2":1,"1":2,"__proto__":{"p":1}}');
    expect(Object.keys(JSON.parse(text))).toContain('__proto__');
    const js = tree.toJS() as Record<string, unknown>;
    expect(Object.getPrototypeOf(js)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(js, '__proto__')).toBe(true);
  });

  it('exports arbitrarily deep documents without recursion', () => {
    const depth = 20_000;
    const src = '['.repeat(depth) + '1' + ']'.repeat(depth);
    const tree = parseJson(src);
    expect(tree.toJSON(tree.root, 0)).toBe(src);
  });

  it('stops at maxChars with an exact prefix, and toJSON refuses instead of cutting', () => {
    const tree = parseJson('{"a": [1, 2, 3], "b": "' + 'x'.repeat(100) + '"}');
    const full = tree.jsonText(tree.root, 2).text;
    for (const max of [0, 1, 7, 40, full.length - 1, full.length]) {
      const r = tree.jsonText(tree.root, 2, max);
      expect(r.text).toBe(full.slice(0, max));
      expect(r.truncated).toBe(full.length > max);
    }
    expect(tree.toJSON(tree.root, 2, full.length)).toBe(full);
    expect(() => tree.toJSON(tree.root, 2, full.length - 1)).toThrow(`The document is larger than ${full.length - 1} characters as JSON`);
    const a = tree.firstChild(tree.root);
    expect(() => tree.toJSON(a, 2, 5)).toThrow('$.a is larger than 5 characters as JSON; select a smaller part to copy or export.');
    const big = parseJson(`["${'x'.repeat(1_100_000)}"]`);
    expect(() => big.toJSON(big.root, 2, 1_000_000)).toThrow('The document is larger than 1 MB as JSON');
  });

  it('gives MCP query results as compact JSON with exact numbers', () => {
    const tree = parseJson('{\n  "id": 12345678901234567890,\n  "user": {\n    "name": "Ada",\n    "tags": [1, 2]\n  }\n}');
    const r = runQuery(tree, '$..*');
    const text = dataMatchesText(tree, r.ids, r.total);
    expect(text).toContain('$.id (L2): 12345678901234567890');
    expect(text).toContain('$.user (L3): {"name":"Ada","tags":[1,2]}');
    expect(dataMatchesText(tree, [tree.root], 1, 10)).toContain(': {"id":1234…');
  });
});
