import { describe, expect, it } from 'vitest';
import { stringify as toYaml } from 'yaml';
import { diffToText, diffTrees, flattenDiff, type DiffEntry, type DiffOptions, type DiffResult } from '../../src/core/data/diff';
import { parseData } from '../../src/core/data/formats';
import type { DataFormat, DataTree } from '../../src/core/data/tree';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const KEYS = ['id', 'name', 'k"q', 'a b', 'x\\y', 'é', 'v'];

function randomValue(r: () => number, depth: number): unknown {
  const k = r();
  if (depth > 4 || k < 0.4) {
    const p = r();
    if (p < 0.3) return Math.round((r() - 0.5) * 1000) / (r() < 0.5 ? 1 : 10);
    if (p < 0.6) return ['', 'a', 'b', 'hello world', 'quote " inside', 'tab\tnew\nline', 'ünï ✓'][Math.floor(r() * 7)];
    if (p < 0.8) return r() < 0.5;
    return null;
  }
  if (k < 0.7) return Array.from({ length: Math.floor(r() * 7) }, () => randomValue(r, depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = 0, n = Math.floor(r() * 6); i < n; i++) o[KEYS[Math.floor(r() * KEYS.length)] + (r() < 0.5 ? '' : i)] = randomValue(r, depth + 1);
  return o;
}

/** A copy with 1–3 random edits: inserts, deletes, moves, replacements, new and dropped keys. */
function mutate(r: () => number, value: unknown): unknown {
  const root: Record<string, unknown> = { v: structuredClone(value) };
  for (let e = 0, edits = 1 + Math.floor(r() * 3); e < edits; e++) {
    const containers: object[] = [];
    const stack: unknown[] = [root];
    while (stack.length) {
      const c = stack.pop();
      if (c && typeof c === 'object') {
        containers.push(c);
        stack.push(...Object.values(c));
      }
    }
    const c = containers[Math.floor(r() * containers.length)];
    const p = r();
    if (c === root) root.v = randomValue(r, 2);
    else if (Array.isArray(c)) {
      const i = Math.floor(r() * (c.length + 1));
      if (p < 0.25 || !c.length) c.splice(i, 0, randomValue(r, 3));
      else if (p < 0.45) c.splice(i % c.length, 1);
      else if (p < 0.65) c.splice(Math.floor(r() * c.length), 0, c.splice(i % c.length, 1)[0]);
      else c[i % c.length] = randomValue(r, 3);
    } else {
      const o = c as Record<string, unknown>;
      const keys = Object.keys(o);
      if (p < 0.3 || !keys.length) o[KEYS[Math.floor(r() * KEYS.length)] + 'm' + e] = randomValue(r, 3);
      else if (p < 0.5) delete o[keys[Math.floor(r() * keys.length)]];
      else o[keys[Math.floor(r() * keys.length)]] = randomValue(r, 3);
    }
  }
  return root.v;
}

/** JSON with object keys sorted (and array elements too, for unordered comparison). */
const canonical = (v: unknown, unordered = false): string =>
  JSON.stringify(v, (_, x: unknown) => {
    if (Array.isArray(x)) return unordered ? x.map((el) => canonical(el, true)).sort() : x;
    return x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x;
  });

/** Asserts that every entry's path, key and node ids point at the right nodes. */
function check(result: DiffResult, left: DataTree, right: DataTree): void {
  const walk = (e: DiffEntry) => {
    if (e.kind === 'removed') {
      expect(e.right).toBe(-1);
      expect(e.path).toBe(left.pathString(e.left));
      expect(e.key).toEqual(left.key(e.left));
    } else {
      expect(e.path).toBe(right.pathString(e.right));
      expect(e.key).toEqual(right.key(e.right));
      expect(e.left >= 0).toBe(e.kind !== 'added');
    }
    for (const c of e.children ?? []) walk(c);
  };
  walk(result.root);
}

/**
 * Every container entry accounts for all children on both sides (unchanged +
 * listed), and each entry's kind agrees with the values it points at.
 */
function verify(result: DiffResult, left: DataTree, right: DataTree, options: DiffOptions = {}): void {
  check(result, left, right);
  if (result.truncated) return;
  const unordered = options.ignoreOrder;
  const walk = (e: DiffEntry) => {
    const l = e.left >= 0 ? canonical(left.toJS(e.left), unordered) : '';
    const r = e.right >= 0 ? canonical(right.toJS(e.right), unordered) : '';
    if (e.children) {
      expect(left.type[e.left]).toBe(right.type[e.right]);
      expect((e.unchanged ?? 0) + e.children.filter((c) => c.kind !== 'removed').length).toBe(right.childCount[e.right]);
      expect((e.unchanged ?? 0) + e.children.filter((c) => c.kind !== 'added').length).toBe(left.childCount[e.left]);
      e.children.forEach(walk);
    } else if (e.kind === 'type') expect(left.type[e.left]).not.toBe(right.type[e.right]);
    // Raw text tells apart integers that toJS rounds to the same double.
    else if (e.kind === 'changed') expect(l !== r || left.rawValue(e.left) !== right.rawValue(e.right)).toBe(true);
    else if ((e.kind === 'moved' || e.kind === 'same') && !options.numericTolerance) expect(l).toBe(r);
  };
  walk(result.root);
}

function diffText(a: string, fa: DataFormat, b: string, fb: DataFormat, options?: DiffOptions) {
  const left = parseData(a, fa);
  const right = parseData(b, fb);
  const result = diffTrees(left, right, options);
  verify(result, left, right, options);
  const lines = flattenDiff(result).map((e) => `${e.kind} ${e.path}`);
  return { left, right, result, lines, text: diffToText(result, left, right) };
}

const diffJs = (a: unknown, b: unknown, options?: DiffOptions) => diffText(JSON.stringify(a), 'json', JSON.stringify(b), 'json', options);

const NONE = { added: 0, removed: 0, changed: 0, moved: 0, typeChanged: 0 };

describe('diffTrees: objects and values', () => {
  it('reports added, removed and changed keys', () => {
    const { result, lines } = diffJs({ a: 1, b: 2, c: 3 }, { a: 1, b: 5, d: 4 });
    expect(lines).toEqual(['changed $.b', 'added $.d', 'removed $.c']);
    expect(result.stats).toEqual({ ...NONE, added: 1, removed: 1, changed: 1 });
    expect(result.root.unchanged).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it('nests changes and collapses unchanged siblings into counts', () => {
    const a = { user: { name: 'Ada', address: { city: 'London', zip: 'N1' } }, tags: ['x'] };
    const b = { user: { name: 'Ada', address: { city: 'Paris', zip: 'N1' } }, tags: ['x'] };
    const { result } = diffJs(a, b);
    const root = result.root;
    expect(root).toMatchObject({ kind: 'changed', path: '$', unchanged: 1 });
    const user = root.children![0];
    expect(user).toMatchObject({ kind: 'changed', path: '$.user', key: 'user', unchanged: 1 });
    const address = user.children![0];
    expect(address).toMatchObject({ kind: 'changed', path: '$.user.address', unchanged: 1 });
    expect(address.children).toEqual([expect.objectContaining({ kind: 'changed', path: '$.user.address.city', key: 'city' })]);
    expect(result.stats).toEqual({ ...NONE, changed: 1 });
  });

  it('reports type changes', () => {
    const { lines, result } = diffJs({ a: { x: 1 }, b: [1], c: '1', d: null, e: 1 }, { a: [1], b: { 0: 1 }, c: 1, d: {}, e: 1 });
    expect(lines).toEqual(['type $.a', 'type $.b', 'type $.c', 'type $.d']);
    expect(result.stats).toEqual({ ...NONE, typeChanged: 4 });
    expect(diffJs(1, '1').result.root.kind).toBe('type');
    expect(diffJs(1, 2).result.root.kind).toBe('changed');
    expect(diffJs([], []).result.root.kind).toBe('same');
  });

  it('ignores key order', () => {
    const { result } = diffJs({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } }, { b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 });
    expect(result.root.kind).toBe('same');
    expect(result.stats).toEqual(NONE);
  });

  it('compares numbers by value and strings decoded', () => {
    const same = diffText(
      '{"a":1,"b":1e2,"c":-0,"d":0.10,"e":12345678901234567890,"f":"\\u00e9\\n","g":0.30000000000000004}',
      'json',
      '{"a":1.0,"b":100,"c":0,"d":0.1,"e":12345678901234567890,"f":"é\\n","g":0.30000000000000004}',
      'json',
    );
    expect(same.result.root.kind).toBe('same');
    // Integers beyond double precision still compare exactly.
    expect(diffText('{"e":12345678901234567890}', 'json', '{"e":12345678901234567891}', 'json').lines).toEqual(['changed $.e']);
    expect(diffText('{"g":0.3}', 'json', '{"g":0.30000000000000004}', 'json').lines).toEqual(['changed $.g']);
  });

  it('reads number spellings across formats by value', () => {
    const json5 = '{b: +1, c: .5, d: 5., e: 1e3, f: -0, g: 12345678901234567890, h: Infinity, i: NaN, j: 1.5E-3}';
    const json = '{"b": 1, "c": 0.5, "d": 5, "e": 1000, "f": 0, "g": 12345678901234567890, "h": 1e999, "i": null, "j": 0.0015}';
    expect(diffText(json5, 'json5', json, 'json5').lines).toEqual(['type $.i']);
    const yaml = 'b: +1\nc: .5\nd: 5.\ne: 1e3\nf: -0\nh: .inf\ni: .nan\nj: 1.5e-3\n';
    expect(diffText(json5.replace(' g: 12345678901234567890,', ''), 'json5', yaml, 'yaml').result.root.kind).toBe('same');
    const csv = diffText('n,s\n 42 ,x\n1e2,y\n', 'csv', '[{"n":42,"s":"x"},{"n":100,"s":"y"}]', 'json');
    expect(csv.result.root.kind).toBe('same');
  });

  it('applies a numeric tolerance', () => {
    const a = { x: 1.0, list: [1.0, 2.0, 3.0], y: 5 };
    const b = { x: 1.0004, list: [1.0001, 2.0, 3.0], y: 5.5 };
    expect(diffJs(a, b).lines).toEqual(['changed $.x', 'changed $.list[0]', 'changed $.y']);
    const { lines, result } = diffJs(a, b, { numericTolerance: 0.001 });
    expect(lines).toEqual(['changed $.y']);
    expect(result.root.unchanged).toBe(2);
    expect(diffJs({ x: 1 }, { x: 1.0004 }, { numericTolerance: 0.001 }).result.root.kind).toBe('same');
  });

  it('treats JSON and YAML with the same content as equal', () => {
    const json = '{"name":"demo","version":1,"enabled":true,"nothing":null,"tags":["a","b c"],"server":{"host":"localhost","ports":[80,443]},"note":"tab\\there"}';
    const yaml = 'name: demo\nversion: 1.0\nenabled: true\nnothing:\ntags: [a, "b c"]\nserver:\n  ports: [80, 443]\n  host: localhost\nnote: "tab\\there"\n';
    expect(diffText(json, 'json', yaml, 'yaml').result.root.kind).toBe('same');
    const changed = diffText(json, 'json', yaml.replace('443', '8443').replace('demo', 'demo2'), 'yaml');
    expect(changed.lines).toEqual(['changed $.name', 'changed $.server.ports[1]']);
    const port = flattenDiff(changed.result)[1];
    expect(changed.left.value(port.left)).toBe(443);
    expect(changed.right.value(port.right)).toBe(8443);
    expect(changed.right.lineCol(changed.right.start(port.right)).line).toBe(6);
  });

  it('treats CSV rows and JSON records with the same values as equal', () => {
    const csv = 'id,name,score,active\n1,Ada,9.5,true\n2,"Linus",7,false\n';
    const json = '[{"id":1,"name":"Ada","score":9.50,"active":true},{"id":2,"name":"Linus","score":7.0,"active":false}]';
    expect(diffText(csv, 'csv', json, 'json').result.root.kind).toBe('same');
    expect(diffText(csv, 'csv', json.replace('9.50', '9.6'), 'json').lines).toEqual(['changed $[0].score']);
  });
});

describe('diffTrees: arrays', () => {
  it('matches by index', () => {
    expect(diffJs([1, 2, 3], [1, 5, 3, 4], { arrays: 'index' }).lines).toEqual(['changed $[1]', 'added $[3]']);
    expect(diffJs([1, 2, 3], [0, 1, 2, 3], { arrays: 'index' }).lines).toEqual(['changed $[0]', 'changed $[1]', 'changed $[2]', 'added $[3]']);
    expect(diffJs([1, 2, 3], [1], { arrays: 'index' }).lines).toEqual(['removed $[1]', 'removed $[2]']);
  });

  it('matches records by id, reporting moves, inserts, deletes and edits', () => {
    const a = [{ id: 1, n: 'a' }, { id: 2, n: 'b' }, { id: 3, n: 'c' }, { id: 4, n: 'd' }];
    const b = [{ id: 4, n: 'd' }, { id: 1, n: 'a' }, { id: 3, n: 'C' }, { id: 5, n: 'e' }];
    const { lines, result, left, right, text } = diffJs(a, b);
    expect(lines).toEqual(['moved $[0]', 'changed $[2].n', 'added $[3]', 'removed $[1]']);
    expect(result.stats).toEqual({ added: 1, removed: 1, changed: 1, moved: 1, typeChanged: 0 });
    expect(result.root.unchanged).toBe(1);
    const moved = flattenDiff(result)[0];
    expect(left.pathString(moved.left)).toBe('$[3]');
    expect(right.pathString(moved.right)).toBe('$[0]');
    expect(text).toBe(['1 changed, 1 added, 1 removed, 1 moved', '↕ $[0]: moved from $[3]', '~ $[2].n: "c" → "C"', '+ $[3] {2}', '- $[1] {2}'].join('\n'));
  });

  it('reports a moved record that also changed, with left paths for removals inside it', () => {
    const a = [{ id: 'x', tags: ['a', 'b'] }, { id: 'y', tags: [] }, { id: 'z', tags: [] }];
    const b = [{ id: 'y', tags: [] }, { id: 'z', tags: [] }, { id: 'x', tags: ['a'] }];
    const { result, lines } = diffJs(a, b);
    expect(lines).toEqual(['moved $[2]', 'removed $[0].tags[1]']);
    expect(result.root.children![0]).toMatchObject({ kind: 'moved', path: '$[2]', unchanged: 1 });
  });

  it('uses other id-like keys and falls back when ids repeat', () => {
    const env = (vals: string[]) => vals.map((v) => ({ name: v.split('=')[0], value: v.split('=')[1] }));
    const { lines } = diffJs({ env: env(['A=1', 'B=2', 'C=3']) }, { env: env(['C=3', 'A=1', 'B=20']) });
    expect(lines).toEqual(['moved $.env[0]', 'changed $.env[2].value']);
    // Repeated "id" values are no identity: LCS pairs the edited elements in place.
    const dup = diffJs([{ id: 1, v: 1 }, { id: 1, v: 2 }], [{ id: 1, v: 3 }, { id: 1, v: 4 }]);
    expect(dup.lines).toEqual(['changed $[0].v', 'changed $[1].v']);
    expect(diffJs([{ id: 1, v: 1 }], [{ id: 2, v: 1 }], { idKeys: [] }).lines).toEqual(['changed $[0].id']);
  });

  it('aligns by LCS so an insertion does not shift everything after it', () => {
    const a = Array.from({ length: 10 }, (_, i) => i);
    const ins = diffJs(a, [...a.slice(0, 5), 99, ...a.slice(5)]);
    expect(ins.lines).toEqual(['added $[5]']);
    expect(ins.result.root.unchanged).toBe(10);
    const del = diffJs(a, [...a.slice(0, 3), ...a.slice(4)], { arrays: 'lcs' });
    expect(del.lines).toEqual(['removed $[3]']);

    const recs = Array.from({ length: 10 }, (_, i) => ({ label: `r${i}`, size: i, color: 'red' }));
    const edited = recs.map((r) => ({ ...r }));
    edited[7].size = 70;
    edited.splice(5, 0, { label: 'new', size: 0, color: 'blue' });
    expect(diffJs(recs, edited).lines).toEqual(['added $[5]', 'changed $[8].size']);
  });

  it('pairs the most similar elements of an uneven gap', () => {
    const p = { label: 'p', size: 1, color: 'red' };
    const q = { label: 'q', size: 2, color: 'red' };
    const r = { label: 'r', size: 3, color: 'red' };
    const { lines } = diffJs([p, q, r], [p, { label: 'x', size: 9, color: 'blue' }, { ...q, size: 20 }, r]);
    expect(lines).toEqual(['added $[1]', 'changed $[2].size']);
    const prims = diffJs([1, 2, 3, 4], [1, 9, 8, 4]);
    expect(prims.lines).toEqual(['changed $[1]', 'changed $[2]']);
    const uneven = diffJs(['a', 'b', 'c', 'z'], ['a', 'x', 'z']);
    expect(uneven.lines).toEqual(['changed $[1]', 'removed $[2]']);
  });

  it('reports moves found by LCS', () => {
    const { lines, text } = diffJs([1, 2, 3, 4], [4, 1, 2, 3]);
    expect(lines).toEqual(['moved $[0]']);
    expect(text).toBe('1 moved\n↕ $[0]: moved from $[3]');
  });

  it('compares arrays as multisets with ignoreOrder', () => {
    expect(diffJs([3, 1, 2], [1, 2, 3], { ignoreOrder: true }).result.root.kind).toBe('same');
    const recs = { l: [{ k: 'a', v: 1, w: 1 }, { k: 'b', v: 2, w: 2 }] };
    expect(diffJs(recs, { l: [{ k: 'b', v: 2, w: 2 }, { k: 'a', v: 3, w: 1 }] }, { ignoreOrder: true }).lines).toEqual(['changed $.l[1].v']);
    // Without a position to go by, only clearly similar leftovers pair up.
    expect(diffJs([{ a: 1 }, { b: 2 }], [{ b: 2 }, { a: 3 }], { ignoreOrder: true }).lines).toEqual(['added $[1]', 'removed $[0]']);
    expect(diffJs([1, 1, 2], [1, 2, 2], { ignoreOrder: true }).lines).toEqual(['added $[1]', 'removed $[1]']);
    expect(diffJs([{ id: 1, v: 1 }, { id: 2 }], [{ id: 2 }, { id: 1, v: 2 }], { ignoreOrder: true }).lines).toEqual(['changed $[1].v']);
    expect(diffJs([1, 2], [2, 1, 3], { ignoreOrder: true }).lines).toEqual(['added $[2]']);
    expect(diffJs([1, 2, 5], [2, 1], { ignoreOrder: true }).lines).toEqual(['removed $[2]']);
  });

  it('splits big arrays at unique elements when the LCS table would be too large', () => {
    const n = 20_000;
    const a = Array.from({ length: n }, (_, i) => ({ v: i, s: `item ${i}` }));
    const b = a.map((o) => ({ ...o }));
    b[15_000].s = 'edited';
    b.splice(12_000, 1);
    b.splice(9_000, 0, { v: -1, s: 'inserted' });
    b[3_000].s = 'edited too';
    b.splice(1_000, 0, { v: -2, s: 'inserted too' });
    const { result, lines } = diffJs(a, b);
    expect(lines).toEqual(['added $[1000]', 'changed $[3001].s', 'added $[9001]', 'removed $[12000]', 'changed $[15001].s']);
    expect(result.root.unchanged).toBe(n - 3);
  });
});

describe('diffTrees: XML, limits and rendering', () => {
  it('aligns repeated XML elements like an array and indexes their paths', () => {
    const a = '<list id="1"><item>a</item><item>b</item><item>c</item><name>x</name></list>';
    const b = '<list id="2"><item>a</item><item>new</item><item>b</item><item>c</item><name>y</name></list>';
    const { lines, result } = diffText(a, 'xml', b, 'xml');
    expect(lines).toEqual(["changed $['@id']", 'added $.item[1]', "changed $.name['#text']"]);
    expect(result.stats).toEqual({ ...NONE, changed: 2, added: 1 });
    const swap = diffText('<r><i>1</i><i>2</i></r>', 'xml', '<r><i>2</i><i>1</i></r>', 'xml');
    expect(swap.result.root.kind).not.toBe('same');
  });

  it('caps the output at maxEntries', () => {
    const a = Array.from({ length: 100 }, (_, i) => ({ v: i }));
    const b = a.map((o) => ({ v: o.v + 1000 }));
    const { result, text } = diffJs(a, b, { maxEntries: 10 });
    expect(result.truncated).toBe(true);
    let count = -1;
    const walk = (e: DiffEntry) => {
      count++;
      e.children?.forEach(walk);
    };
    walk(result.root);
    expect(count).toBeLessThanOrEqual(10);
    expect(count).toBeGreaterThan(0);
    expect(text.split('\n')[0]).toMatch(/\(truncated\)$/);
    expect(diffJs(a, b).result.stats.changed).toBe(100);
  });

  it('stays bounded on very deep nesting', () => {
    const depth = 5_000;
    const left = '['.repeat(depth) + '1' + ']'.repeat(depth);
    const { result, lines } = diffText(left, 'json', left.replace('1', '2'), 'json');
    expect(result.truncated).toBe(true);
    expect(lines.length).toBe(1);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(diffText(left, 'json', left, 'json').result.root.kind).toBe('same');
  });

  it('renders compact text', () => {
    const a = { users: [{ id: 1, email: 'a@x' }, { id: 2, email: 'c@x' }], settings: { beta: null, mode: 'dark', level: 1 } };
    const b = { users: [{ id: 1, email: 'b@x' }, { id: 2, email: 'c@x' }, { id: 3, email: 'd@x' }], settings: { mode: 'light', level: '1' } };
    const { text, left, right, result } = diffJs(a, b);
    expect(text).toBe(
      [
        '2 changed, 1 added, 1 removed, 1 type changed',
        '~ $.users[0].email: "a@x" → "b@x"',
        '+ $.users[2] {2}',
        '~ $.settings.mode: "dark" → "light"',
        '~ $.settings.level: 1 → "1" (number → string)',
        '- $.settings.beta: null',
      ].join('\n'),
    );
    expect(diffToText(result, left, right, { maxLines: 2 }).split('\n').slice(1)).toEqual(['~ $.users[0].email: "a@x" → "b@x"', '+ $.users[2] {2}', '… 3 more']);
    expect(diffJs({ a: 1 }, { a: 1 }).text).toBe('no differences');
  });
});

describe('diffTrees: random documents', () => {
  it('accounts for every difference, in every array mode', () => {
    const r = rng(7);
    const modes: DiffOptions[] = [{}, { arrays: 'lcs' }, { arrays: 'index' }, { ignoreOrder: true }];
    for (let n = 0; n < 400; n++) {
      const a = randomValue(r, 0);
      const b = r() < 0.15 ? structuredClone(a) : mutate(r, a);
      for (const options of modes) {
        const left = parseData(JSON.stringify(a), 'json');
        const right = parseData(JSON.stringify(b, null, r() < 0.5 ? 2 : undefined), 'json');
        const result = diffTrees(left, right, options);
        verify(result, left, right, options);
        expect(result.root.kind === 'same').toBe(canonical(a, options.ignoreOrder) === canonical(b, options.ignoreOrder));
      }
    }
  });

  it('accounts for every difference in XML, indexing same-named siblings', () => {
    const r = rng(3);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    type El = { tag: string; attrs: Record<string, string>; kids: (El | string)[] };
    const el = (depth: number): El => ({
      tag: pick(['a', 'b', 'item', 'item']),
      attrs: Object.fromEntries(Array.from({ length: Math.floor(r() * 3) }, () => [pick(['id', 'k']), pick(['1', '2', 'a&b'])])),
      kids: Array.from({ length: depth > 3 ? 0 : Math.floor(r() * 5) }, () => (r() < 0.3 ? pick(['t1', 'x < y']) : el(depth + 1))),
    });
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const xml = (e: El | string): string =>
      typeof e === 'string' ? esc(e) : `<${e.tag}${Object.entries(e.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${e.kids.map(xml).join('')}</${e.tag}>`;
    for (let n = 0; n < 300; n++) {
      const a: El = { tag: 'root', attrs: {}, kids: [el(1), el(1)] };
      const b = structuredClone(a);
      const all: El[] = [];
      const stack = [b];
      while (stack.length) {
        const e = stack.pop()!;
        all.push(e);
        for (const c of e.kids) if (typeof c !== 'string') stack.push(c);
      }
      for (let k = 0; k < 2; k++) {
        const e = pick(all);
        const i = Math.floor(r() * (e.kids.length + 1));
        if (r() < 0.4 || !e.kids.length) e.kids.splice(i, 0, el(3));
        else if (r() < 0.5) e.kids.splice(i % e.kids.length, 1);
        else e.kids.splice(Math.floor(r() * e.kids.length), 0, e.kids.splice(i % e.kids.length, 1)[0]);
      }
      const left = parseData(xml(a), 'xml');
      const right = parseData(xml(b), 'xml');
      const result = diffTrees(left, right);
      verify(result, left, right);
      expect(result.root.kind === 'same').toBe(canonical(left.toJS()) === canonical(right.toJS()));
    }
  });

  it('finds no differences between JSON and YAML renderings of the same data', () => {
    const r = rng(11);
    for (let n = 0; n < 200; n++) {
      const v = randomValue(r, 0);
      expect(diffTrees(parseData(JSON.stringify(v), 'json'), parseData(toYaml(v), 'yaml')).root.kind).toBe('same');
    }
  });
});

describe('diffTrees: performance', () => {
  const records = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: i,
      uuid: `${((i * 2654435761) >>> 0).toString(16)}-4f1a-9c2e-${i}`,
      name: `User number ${i}`,
      email: `user${i}@example.com`,
      active: i % 3 !== 0,
      score: Math.round(Math.sin(i) * 10000) / 100,
      tags: ['alpha', 'beta', 'gamma'].slice(0, i % 4),
      address: { street: `${i} Main St`, city: ['Berlin', 'Paris', 'Tokyo'][i % 3], zip: null },
    }));

  it('diffs large documents with a few changes in about the time it takes to hash them', () => {
    const a = records(40_000);
    const b = a.map((r) => ({ ...r, address: { ...r.address } }));
    b[100].email = 'changed@example.com';
    b[20_000].address.city = 'Lisbon';
    b.splice(30_000, 1);
    b.splice(5_000, 0, { ...a[0], id: -1, uuid: 'new', name: 'New user' });
    b.push(b.splice(7, 1)[0]);
    const left = parseData(JSON.stringify(a), 'json');
    const right = parseData(JSON.stringify(b), 'json');
    for (const arrays of ['auto', 'lcs'] as const) {
      const t = performance.now();
      const result = diffTrees(left, right, { arrays });
      const ms = performance.now() - t;
      expect(result.stats).toEqual({ added: 1, removed: 1, changed: 2, moved: 1, typeChanged: 0 });
      expect(ms).toBeLessThan(3000);
    }
    const t = performance.now();
    expect(diffTrees(left, parseData(JSON.stringify(a), 'json')).root.kind).toBe('same');
    expect(performance.now() - t).toBeLessThan(3000);
  });
});
