import { describe, expect, it } from 'vitest';
import { editCaps } from '../../src/core/data/edit';
import { detectFormat, parseData, sniffFormat } from '../../src/core/data/formats';
import { runQuery } from '../../src/core/data/query';
import { F_ALIAS, F_ATTR, F_COPY, F_ELEMENT, F_TEXT, T_BOOLEAN, T_NULL, T_NUMBER, T_OBJECT, T_STRING } from '../../src/core/data/tree';

describe('YAML', () => {
  const text = `name: demo
version: 1.2
enabled: true
nothing:
tags:
  - a
  - "b c"
server:
  host: localhost
  ports: [80, 443]
big: 12345678901234567890
anchor: &A {k: v}
ref: *A
`;
  it('converts mappings, sequences and scalars', () => {
    const tree = parseData(text, 'yaml');
    expect(tree.errors).toEqual([]);
    const js = tree.toJS() as Record<string, unknown>;
    expect(js.name).toBe('demo');
    expect(js.version).toBe(1.2);
    expect(js.enabled).toBe(true);
    expect(js.nothing).toBe(null);
    expect(js.tags).toEqual(['a', 'b c']);
    expect(js.server).toEqual({ host: 'localhost', ports: [80, 443] });
    const big = tree.children(tree.root).find((c) => tree.key(c) === 'big')!;
    expect(tree.rawValue(big)).toBe('12345678901234567890');
  });
  it('keeps positions for reveal', () => {
    const tree = parseData(text, 'yaml');
    const at = tree.nodeAtOffset(text.indexOf('localhost'));
    expect(tree.pathString(at)).toBe('$.server.host');
    const nothing = tree.children(tree.root).find((c) => tree.key(c) === 'nothing')!;
    expect(tree.type[nothing]).toBe(T_NULL);
    expect(tree.lineCol(tree.start(nothing)).line).toBe(3);
  });
  it('wraps multiple documents and reports errors', () => {
    const multi = parseData('a: 1\n---\nb: 2\n', 'yaml');
    expect(multi.toJS()).toEqual([{ a: 1 }, { b: 2 }]);
    const bad = parseData('a: [1, 2\nb: : c', 'yaml');
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.errors[0].line).toBeGreaterThan(0);
  });
});

describe('YAML aliases and merge keys', () => {
  const text = 'base: &b\n  host: db\n  port: 5432\ndev:\n  <<: *b\n  name: dev\nref: *b\nnum: &n 42\nalso: *n\n';

  it('resolves aliases to copies of the anchored node', () => {
    const tree = parseData(text, 'yaml');
    expect(tree.errors).toEqual([]);
    const value = { base: { host: 'db', port: 5432 }, dev: { host: 'db', port: 5432, name: 'dev' }, ref: { host: 'db', port: 5432 }, num: 42, also: 42 };
    expect(tree.toJS()).toEqual(value);
    expect(JSON.parse(tree.toJSON())).toEqual(value);
    expect(runQuery(tree, '$.dev.host').ids.map((id) => tree.value(id))).toEqual(['db']);
    expect(tree.typeName(runQuery(tree, '$.ref').ids[0])).toBe('object');
  });

  it('points copies at the anchor, while the cursor finds the original', () => {
    const tree = parseData(text, 'yaml');
    const anchorHost = runQuery(tree, '$.base.host').ids[0];
    for (const path of ['$.ref.host', '$.dev.host']) {
      const copy = runQuery(tree, path).ids[0];
      expect(tree.flags[copy] & F_COPY).toBeTruthy();
      expect([tree.start(copy), tree.end(copy)]).toEqual([tree.start(anchorHost), tree.end(anchorHost)]);
    }
    const ref = runQuery(tree, '$.ref').ids[0];
    expect(tree.start(ref)).toBe(text.indexOf('host'));
    expect(tree.pathString(tree.nodeAtOffset(text.indexOf('db')))).toBe('$.base.host');
    expect(tree.pathString(tree.nodeAtOffset(text.indexOf('name: dev')))).toBe('$.dev.name');
    expect(tree.pathString(tree.nodeAtOffset(text.indexOf('42')))).toBe('$.num');
  });

  it('keeps copies read-only for in-place edits (their positions are the anchor)', () => {
    const tree = parseData(text, 'yaml');
    const none = { set: false, rename: false, delete: false, add: false };
    for (const path of ['$.ref', '$.ref.host', '$.dev.host', '$.also']) expect(editCaps(tree, runQuery(tree, path).ids[0]), path).toEqual(none);
    expect(editCaps(tree, runQuery(tree, '$.dev.name').ids[0]).set).toBe(true);
  });

  it('merges with YAML 1.1 precedence: own keys, then earlier sources', () => {
    const tree = parseData('a: &a {x: 1, y: 1, z: 1}\nb: &b {x: 2, w: 2}\nc:\n  y: own\n  <<: [*a, *b]\n  z: own\nd: {<<: {i: 1}, j: 2}\ne: &e {<<: *a, v: 3}\nf: {<<: *e}\n"<<": plain\n', 'yaml');
    const js = tree.toJS() as Record<string, unknown>;
    expect(js.c).toEqual({ y: 'own', x: 1, w: 2, z: 'own' });
    expect(Object.keys(js.c as object)).toEqual(['y', 'x', 'w', 'z']);
    expect(js.d).toEqual({ i: 1, j: 2 });
    expect(js.f).toEqual({ x: 1, y: 1, z: 1, v: 3 });
    expect(js['<<']).toBe('plain');
  });

  it('leaves circular and unknown aliases as text with an issue', () => {
    const tree = parseData('a: &a [1, *a]\nm: &m\n  k: 1\n  <<: *m\nx: *nope\n', 'yaml');
    expect(tree.toJS()).toEqual({ a: [1, '*a'], m: { k: 1 }, x: '*nope' });
    expect(tree.errors.map((e) => e.message)).toEqual(['Circular alias *a is left unexpanded', 'Circular merge of *m is skipped', 'Unknown alias *nope']);
    const alias = runQuery(tree, '$.x').ids[0];
    expect(tree.flags[alias] & F_ALIAS).toBeTruthy();
  });

  it('caps alias bombs', () => {
    const lines = ['a: &a [lol, lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
    for (let i = 1; i < 9; i++) lines.push(`${'abcdefghi'[i]}: &${'abcdefghi'[i]} [${Array(10).fill(`*${'abcdefghi'[i - 1]}`).join(', ')}]`);
    const tree = parseData(lines.join('\n'), 'yaml');
    expect(tree.count).toBeGreaterThan(1_000_000);
    expect(tree.count).toBeLessThan(1_100_000);
    expect(tree.errors).toHaveLength(1);
    expect(tree.errors[0].message).toMatch(/^Aliases expand to more than 1,000,000 values; \*\w and later aliases are left unexpanded$/);
    expect(tree.toJSON(tree.root, 0)).toContain('"*');
  });
});

describe('XML', () => {
  const text = `<?xml version="1.0"?>
<!DOCTYPE catalog [<!ENTITY x "y">]>
<catalog xmlns:h="urn:x">
  <!-- comment -->
  <book id="b1" available="yes">
    <title>XML &amp; You</title>
    <price>29.99</price>
  </book>
  <book id="b2"><title><![CDATA[<raw>]]></title></book>
  <h:empty/>
</catalog>`;
  it('maps elements, attributes, text and CDATA', () => {
    const tree = parseData(text, 'xml');
    expect(tree.errors).toEqual([]);
    expect(tree.key(tree.root)).toBe(null);
    expect(tree.flags[tree.root] & F_ELEMENT).toBeTruthy();
    const kids = tree.children(tree.root);
    expect(kids.map((c) => tree.key(c))).toEqual(['@xmlns:h', 'book', 'book', 'h:empty']);
    const book1 = kids[1];
    const b1 = tree.children(book1);
    expect(b1.map((c) => tree.key(c))).toEqual(['@id', '@available', 'title', 'price']);
    expect(tree.flags[b1[0]] & F_ATTR).toBeTruthy();
    const titleText = tree.firstChild(b1[2]);
    expect(tree.flags[titleText] & F_TEXT).toBeTruthy();
    expect(tree.stringValue(titleText)).toBe('XML & You');
    const cdata = tree.firstChild(tree.children(kids[2])[1]);
    expect(tree.key(cdata)).toBe('#cdata');
    expect(tree.stringValue(cdata)).toBe('<raw>');
  });
  it('builds grouped sibling paths', () => {
    const tree = parseData(text, 'xml');
    const at = tree.nodeAtOffset(text.indexOf('b2'));
    expect(tree.pathString(at)).toBe("$.book[1]['@id']");
  });
  it('repairs mismatched tags', () => {
    const tree = parseData('<a><b><c>text</b><d/></a>', 'xml');
    expect(tree.errors.map((e) => e.message)).toContain('Missing closing tag </c>');
    const js = tree.toJS() as Record<string, unknown>;
    expect(Object.keys(js)).toEqual(['b', 'd']);
  });
  it('parses loose HTML', () => {
    const tree = parseData('<!doctype html><html><head><meta charset=utf-8><script>if (a < b) {}</script></head><body><p>One<p>Two<br>three</body></html>', 'html');
    expect(tree.errors).toEqual([]);
    const body = tree.children(tree.root).find((c) => tree.key(c) === 'body')!;
    expect(tree.children(body).map((c) => tree.key(c))).toEqual(['p', 'p']);
    const script = tree.children(tree.children(tree.root)[0]).find((c) => tree.key(c) === 'script')!;
    expect(tree.stringValue(tree.firstChild(script))).toBe('if (a < b) {}');
  });
});

describe('TOML', () => {
  const text = `title = "TOML" # comment
[owner]
name = "Tom"
dob = 1979-05-27T07:32:00-08:00

[database]
ports = [ 8000,
  8001 ]
enabled = true

[[products]]
name = "Hammer"
[[products]]
name = "Nail"
`;
  it('converts values and locates keys', () => {
    const tree = parseData(text, 'toml');
    expect(tree.errors).toEqual([]);
    const js = tree.toJS() as Record<string, any>;
    expect(js.title).toBe('TOML');
    expect(js.database.ports).toEqual([8000, 8001]);
    expect(js.products.map((p: { name: string }) => p.name)).toEqual(['Hammer', 'Nail']);
    const nail = tree.nodeAtOffset(text.indexOf('"Nail"'));
    expect(tree.pathString(nail)).toBe('$.products[1].name');
    const enabled = tree.nodeAtOffset(text.indexOf('enabled'));
    expect(tree.type[enabled]).toBe(T_BOOLEAN);
  });
  it('reports parse errors with positions', () => {
    const tree = parseData('a = 1\nb = = 2\n', 'toml');
    expect(tree.errors[0].line).toBe(2);
  });

  it('finds the node at the cursor when tables interleave', () => {
    const src = '[tool.poetry]\nname = "x"\n\n[build-system]\nrequires = ["a"]\n# build backend\nbackend = "b"\n\n[tool.black]\nline-length = 88\n';
    const tree = parseData(src, 'toml');
    const at = (s: string) => tree.pathString(tree.nodeAtOffset(src.indexOf(s)));
    expect(at('backend =')).toBe("$['build-system'].backend");
    expect(at('requires')).toBe("$['build-system'].requires");
    expect(at('"a"')).toBe("$['build-system'].requires");
    expect(at('# build')).toBe("$['build-system']");
    expect(at('line-length')).toBe("$.tool.black['line-length']");
    expect(at('[tool.black]')).toBe('$.tool.black');
    expect(at('name')).toBe('$.tool.poetry.name');
  });

  it('keeps what it can read around syntax errors', () => {
    const cut = parseData('[package]\nname = "x"\n[dependencies]\nserde = { version = "1"\n', 'toml');
    expect(cut.toJS()).toEqual({ package: { name: 'x' }, dependencies: {} });
    expect(cut.errors).toHaveLength(1);
    expect(cut.errors[0]).toMatchObject({ line: 5, col: 1 });
    expect(cut.errors[0].message).toContain('(line 4 skipped)');

    const middle = parseData('a = 1\nb = = 2\nc = 3\n[t]\nx = { y = 1\nz = 2\n[u]\nv = 4\n', 'toml');
    expect(middle.toJS()).toEqual({ a: 1, c: 3, t: {}, u: { v: 4 } });
    expect(middle.errors.map((e) => e.line)).toEqual([2, 6]);
    expect(middle.pathString(middle.nodeAtOffset(middle.text.indexOf('v = 4')))).toBe('$.u.v');

    // A broken header drops its table rather than moving its keys to the previous one.
    const header = parseData('[a]\nx = 1\n[b\ny = 2\n[c]\nz = 3\n', 'toml');
    expect(header.toJS()).toEqual({ a: { x: 1 }, c: { z: 3 } });
    expect(header.errors[0]).toMatchObject({ line: 3, col: 3 });
  });
});

describe('CSV', () => {
  it('detects header, delimiter and cell types', () => {
    const tree = parseData('id;name;score;active;zip\n1;"Smith, ""J"" ";9.5;true;01234\n2;Lee;;false;99999\n', 'csv');
    expect(tree.columns).toEqual(['id', 'name', 'score', 'active', 'zip']);
    expect(tree.childCount[tree.root]).toBe(2);
    const row = tree.firstChild(tree.root);
    expect(tree.type[row]).toBe(T_OBJECT);
    const cells = tree.children(row);
    expect(cells.map((c) => tree.type[c])).toEqual([T_NUMBER, T_STRING, T_NUMBER, T_BOOLEAN, T_STRING]);
    expect(tree.stringValue(cells[1])).toBe('Smith, "J" ');
    expect(tree.toJS()).toEqual([
      { id: 1, name: 'Smith, "J" ', score: 9.5, active: true, zip: '01234' },
      { id: 2, name: 'Lee', score: null, active: false, zip: 99999 },
    ]);
  });
  it('handles headerless numeric data, CRLF and multi-line quoted fields', () => {
    const tree = parseData('1,2,3\r\n4,"multi\r\nline",6\r\n', 'csv');
    expect(tree.columns).toEqual(['column1', 'column2', 'column3']);
    expect(tree.toJS()).toEqual([
      { column1: 1, column2: 2, column3: 3 },
      { column1: 4, column2: 'multi\r\nline', column3: 6 },
    ]);
  });
  it('parses TSV', () => {
    const tree = parseData('a\tb\nx\ty\n', 'tsv');
    expect(tree.toJS()).toEqual([{ a: 'x', b: 'y' }]);
  });
});

describe('key/value formats', () => {
  it('parses INI sections', () => {
    const tree = parseData('; c\nroot = 1\n[core]\neditor = vim ; inline\n[remote "origin"]\nurl = https://x\n', 'ini');
    expect(tree.toJS()).toEqual({ root: 1, core: { editor: 'vim' }, 'remote "origin"': { url: 'https://x' } });
  });
  it('parses .env files', () => {
    const tree = parseData('# c\nexport API_KEY=abc123\nPORT=8080\nMSG="hello\\nworld"\nEMPTY=\nNOTE=value # comment\n', 'env');
    expect(tree.toJS()).toEqual({ API_KEY: 'abc123', PORT: 8080, MSG: 'hello\nworld', EMPTY: null, NOTE: 'value' });
  });
  it('parses .properties files', () => {
    const tree = parseData('# c\na=1\nb : two\nc three\nlong = first \\\n   second\nu=\\u00e9\n', 'properties');
    expect(tree.toJS()).toEqual({ a: '1', b: 'two', c: 'three', long: 'first second', u: 'é' });
  });
});

describe('detectFormat', () => {
  it('uses names, extensions, language ids and content', () => {
    expect(detectFormat('/x/tsconfig.json')).toBe('jsonc');
    expect(detectFormat('C:\\a\\data.ndjson')).toBe('jsonl');
    expect(detectFormat('compose.yml')).toBe('yaml');
    expect(detectFormat('Cargo.lock')).toBe('toml');
    expect(detectFormat('.env.production')).toBe('env');
    expect(detectFormat('icon.svg')).toBe('xml');
    expect(detectFormat('page.html')).toBe('html');
    expect(detectFormat('main.ts')).toBe(undefined);
    expect(detectFormat('untitled', 'yaml')).toBe('yaml');
    expect(detectFormat('data.json', undefined, '{"a":1}\n{"a":2}\n')).toBe('jsonl');
    expect(sniffFormat('  {"a": 1}')).toBe('json');
    expect(sniffFormat('<root/>')).toBe('xml');
    expect(sniffFormat('key: value\nother: 2')).toBe('yaml');
  });
});
