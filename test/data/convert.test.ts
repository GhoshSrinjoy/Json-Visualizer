import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { compactJson, ConvertError, convertTree, toPlain } from '../../src/core/data/convert';
import { parseData } from '../../src/core/data/formats';

const doc = {
  service: 'directory',
  version: 2.5,
  big: '__BIG__',
  tags: ['a', 'b'],
  owner: { name: 'Ada', 'e-mail': 'ada@example.com', address: { city: 'London', zip: null } },
  users: [
    { id: 1, name: 'Ada, Countess', active: true, roles: ['admin'] },
    { id: 2, name: 'Alan "Turing"', active: false, note: 'multi\nline' },
  ],
};
const text = JSON.stringify(doc, null, 2).replace('"__BIG__"', '12345678901234567890');
const tree = parseData(text, 'json');
const big = 12345678901234567890n;

describe('convertTree', () => {
  it('keeps big integers exact', () => {
    const plain = toPlain(tree) as Record<string, unknown>;
    expect(plain.big).toBe(big);
    expect(compactJson({ n: big, s: 'x' })).toBe('{"n":12345678901234567890,"s":"x"}');
  });

  it('round-trips through YAML', () => {
    const y = convertTree(tree, tree.root, 'yaml');
    const back = parseYaml(y, { intAsBigInt: true }) as Record<string, unknown>;
    expect(back.big).toBe(big);
    expect((back.users as { name: string }[])[1].name).toBe('Alan "Turing"');
    expect((back.owner as { address: { zip: null } }).address.zip).toBeNull();
  });

  it('writes TOML, leaving out nulls with a note', () => {
    const t = convertTree(tree, tree.root, 'toml');
    expect(t.startsWith('# 1 null value was left out')).toBe(true);
    const back = parseToml(t, { integersAsBigInt: 'asNeeded' }) as Record<string, unknown>;
    expect((back.owner as { address: Record<string, unknown> }).address).toEqual({ city: 'London' });
    expect((back.users as unknown[]).length).toBe(2);
    expect(() => convertTree(tree, tree.children(tree.root)[3], 'toml')).toThrow(ConvertError);
  });

  it('writes CSV with flattened records and proper quoting', () => {
    const users = tree.children(tree.root)[5];
    const csv = convertTree(tree, users, 'csv');
    expect(csv.split('\n')[0]).toBe('id,name,active,roles,note');
    expect(csv).toContain('1,"Ada, Countess",true,"[""admin""]",');
    expect(csv).toContain('2,"Alan ""Turing""",false,,"multi\nline"');
    const tsv = convertTree(tree, tree.children(tree.root)[4], 'tsv');
    // A plain record is one row; a map of records (below) is one row per key.
    expect(tsv.split('\n')[0]).toBe('name\te-mail\taddress.city\taddress.zip');
    // A map of records becomes one row per key.
    const map = parseData('{"a":{"x":1},"b":{"x":2,"y":3}}', 'json');
    expect(convertTree(map, map.root, 'csv')).toBe('key,x,y\na,1,\nb,2,3\n');
  });

  it('writes XML that reads back the same way', () => {
    const xml = convertTree(tree, tree.root, 'xml');
    expect(xml).toContain('<root>');
    expect(xml).toContain('<e-mail>ada@example.com</e-mail>');
    const odd = parseData('{"first name": "Ada", "2nd": 2}', 'json');
    expect(convertTree(odd, odd.root, 'xml')).toContain('<item key="first name">Ada</item>');
    expect(xml).toContain('<name>Alan &quot;Turing&quot;</name>'.replace(/&quot;/g, '"'));
    const src = parseData('<catalog id="7"><book lang="en"><title>A &amp; B</title></book><book><title>C</title></book></catalog>', 'xml');
    const out = convertTree(src, src.root, 'xml');
    expect(out).toContain('<catalog id="7">');
    expect(out).toContain('<book lang="en">');
    expect(out).toContain('<title>A &amp; B</title>');
    const again = parseData(out, 'xml');
    expect(toPlain(again)).toEqual(toPlain(src));
  });

  it('writes JSON Lines', () => {
    const users = tree.children(tree.root)[5];
    const lines = convertTree(tree, users, 'jsonl').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(doc.users[0]);
  });

  it('handles very deep documents without overflowing', () => {
    const deep = '['.repeat(20000) + ']'.repeat(20000);
    const t = parseData(deep, 'json');
    expect(() => toPlain(t)).not.toThrow();
  });
});
