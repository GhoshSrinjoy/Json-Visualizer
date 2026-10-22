import { describe, expect, it } from 'vitest';
import { parseJson, looksLikeJsonLines } from '../../src/core/data/json';
import { F_ERROR, F_SYNTHETIC, T_ARRAY, T_NUMBER, T_OBJECT, T_STRING } from '../../src/core/data/tree';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomValue(r: () => number, depth: number): unknown {
  const k = r();
  if (depth > 5 || k < 0.35) {
    const p = r();
    if (p < 0.3) return Math.round((r() - 0.5) * 1e6) / (r() < 0.5 ? 1 : 100);
    if (p < 0.6) return ['', 'a', 'hello world', 'quote " inside', 'back\\slash', 'tab\tnew\nline', 'ünïcödé ✓', '\u0000x'][Math.floor(r() * 8)];
    if (p < 0.75) return r() < 0.5;
    return null;
  }
  if (k < 0.7) {
    const n = Math.floor(r() * 6);
    return Array.from({ length: n }, () => randomValue(r, depth + 1));
  }
  const n = Math.floor(r() * 6);
  const o: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) o[['id', 'name', 'k"q', 'a b', 'x\\y', 'nested', `k${i}`][Math.floor(r() * 7)] + i] = randomValue(r, depth + 1);
  return o;
}

describe('parseJson', () => {
  it('round-trips random documents (compact and pretty)', () => {
    const r = rng(42);
    for (let i = 0; i < 300; i++) {
      const v = randomValue(r, 0);
      for (const text of [JSON.stringify(v), JSON.stringify(v, null, 2)]) {
        const tree = parseJson(text);
        expect(tree.errors).toEqual([]);
        expect(tree.toJS()).toEqual(v);
      }
    }
  });

  it('exposes keys, types, counts and previews', () => {
    const tree = parseJson('{"name":"Ada","age":36,"tags":["x","y"],"addr":{"city":"London"},"ok":true,"none":null}');
    const root = tree.root;
    expect(tree.type[root]).toBe(T_OBJECT);
    expect(tree.childCount[root]).toBe(6);
    const kids = tree.children(root);
    expect(kids.map((c) => tree.key(c))).toEqual(['name', 'age', 'tags', 'addr', 'ok', 'none']);
    expect(kids.map((c) => tree.typeName(c))).toEqual(['string', 'number', 'array', 'object', 'boolean', 'null']);
    expect(tree.preview(kids[2])).toBe('[2]');
    expect(tree.preview(kids[3])).toBe('{1}');
    expect(tree.value(kids[1])).toBe(36);
    const tags = tree.children(kids[2]);
    expect(tags.map((c) => tree.key(c))).toEqual([0, 1]);
    expect(tree.pathString(tags[1])).toBe('$.tags[1]');
    expect(tree.nextSibling(kids[5])).toBe(-1);
  });

  it('keeps big numbers exact in rawValue', () => {
    const tree = parseJson('{"id": 12345678901234567890123}');
    const id = tree.firstChild(tree.root);
    expect(tree.type[id]).toBe(T_NUMBER);
    expect(tree.rawValue(id)).toBe('12345678901234567890123');
  });

  it('decodes escaped keys and strings and builds bracket paths', () => {
    const tree = parseJson('{"a \\"b\\"": {"\\u00e9": "line\\nbreak"}}');
    const k1 = tree.firstChild(tree.root);
    expect(tree.key(k1)).toBe('a "b"');
    const k2 = tree.firstChild(k1);
    expect(tree.key(k2)).toBe('é');
    expect(tree.stringValue(k2)).toBe('line\nbreak');
    expect(tree.pathString(k2)).toBe(`$['a "b"']['é']`);
  });

  it('maps offsets to the deepest node and back to lines', () => {
    const text = '{\n  "users": [\n    {"name": "Ada"},\n    {"name": "Linus"}\n  ]\n}';
    const tree = parseJson(text);
    const at = tree.nodeAtOffset(text.indexOf('Linus'));
    expect(tree.stringValue(at)).toBe('Linus');
    expect(tree.pathString(at)).toBe('$.users[1].name');
    expect(tree.lineCol(tree.start(at))).toEqual({ line: 3, col: 5 });
    const users = tree.nodeAtOffset(text.indexOf('"users"') + 2);
    expect(tree.key(users)).toBe('users');
  });

  it('accepts JSONC comments and trailing commas', () => {
    const tree = parseJson('// header\n{\n  /* block */ "a": 1, // one\n  "b": [1, 2, ],\n}\n', { format: 'jsonc' });
    expect(tree.errors).toEqual([]);
    expect(tree.toJS()).toEqual({ a: 1, b: [1, 2] });
  });

  it('accepts JSON5 extensions', () => {
    const tree = parseJson("{unquoted: 'single', hex: 0x1F, inf: -Infinity, nan: NaN, lead: .5, plus: +1,}", { format: 'json5' });
    expect(tree.errors).toEqual([]);
    const js = tree.toJS() as Record<string, unknown>;
    expect(js.unquoted).toBe('single');
    expect(js.hex).toBe(31);
    expect(js.inf).toBe(-Infinity);
    expect(Number.isNaN(js.nan)).toBe(true);
    expect(js.lead).toBe(0.5);
    expect(js.plus).toBe(1);
  });

  it('wraps JSON Lines in a synthetic array root', () => {
    const text = '{"a":1}\n{"a":2}\n{"a":3}\n';
    expect(looksLikeJsonLines(text)).toBe(true);
    const tree = parseJson(text, { format: 'jsonl' });
    expect(tree.flags[tree.root] & F_SYNTHETIC).toBeTruthy();
    expect(tree.type[tree.root]).toBe(T_ARRAY);
    expect(tree.toJS()).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(tree.nodeCount()).toBe(6);
  });

  it('recovers from errors and reports line/column', () => {
    const tree = parseJson('{\n  "a": 1\n  "b": [1, 2\n  "c": "unterminated\n}');
    expect(tree.errors.length).toBeGreaterThan(0);
    expect(tree.errors[0]).toMatchObject({ line: 3, message: 'Expected "," or closing bracket' });
    const js = tree.toJS() as Record<string, unknown>;
    expect(js.a).toBe(1);
    expect(Array.isArray(js.b)).toBe(true);
  });

  it('handles unclosed input', () => {
    const tree = parseJson('[1, [2, [3');
    expect(tree.errors.at(-1)?.message).toMatch(/Unexpected end/);
    expect(tree.toJS()).toEqual([1, [2, [3]]]);
  });

  it('does not overflow on very deep nesting', () => {
    const depth = 200_000;
    const text = '['.repeat(depth) + ']'.repeat(depth);
    const tree = parseJson(text);
    expect(tree.errors).toEqual([]);
    expect(tree.maxDepth).toBe(depth + 1);
    expect(tree.nodeCount()).toBe(depth);
  });

  it('parses scalars at the top level', () => {
    expect(parseJson('"just a string"').toJS()).toBe('just a string');
    expect(parseJson('  42 ').toJS()).toBe(42);
    const empty = parseJson('   ');
    expect(empty.nodeCount()).toBe(0);
  });

  it('paginates children', () => {
    const tree = parseJson(JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ i }))));
    const page = tree.children(tree.root, 500, 3);
    expect(page.map((c) => tree.key(c))).toEqual([500, 501, 502]);
    expect(tree.childAt(tree.root, 999)).toBe(page[0] + 499 * 2);
    expect(tree.type[page[0]]).toBe(T_OBJECT);
    expect(tree.type[page[0] + 1]).toBe(T_NUMBER);
    expect(tree.indexInParent(page[2])).toBe(502);
  });

  it('marks garbage tokens as errors without losing siblings', () => {
    const tree = parseJson('{"a": undefined, "b": 2}');
    expect(tree.errors[0].message).toMatch(/Unexpected token "undefined"/);
    const kids = tree.children(tree.root);
    expect(kids.map((k) => tree.key(k))).toEqual(['a', 'b']);
    expect(tree.type[kids[0]]).toBe(T_STRING);
    expect(tree.value(kids[1])).toBe(2);
  });
});

const issues = (tree: ReturnType<typeof parseJson>) => tree.errors.map((e) => `${e.severity ?? 'error'}: ${e.message}`);

describe('parseJson strictness', () => {
  it('reports malformed numbers and keeps their text', () => {
    const tree = parseJson('{"d": 2024-01-01, "e": -, "f": 1.2.3, "g": 007, "h": 1e, "i": 1_000, "ok": [0, -0, 1.5e3, -12.5E-2]}');
    expect(issues(tree)).toEqual(['2024-01-01', '-', '1.2.3', '007', '1e', '1_000'].map((n) => `error: Invalid number "${n}"`));
    const js = tree.toJS() as Record<string, unknown>;
    expect(js).toMatchObject({ d: '2024-01-01', e: '-', f: '1.2.3', g: '007', h: '1e', i: '1_000', ok: [0, -0, 1500, -0.125] });
    for (const id of tree.children(tree.root).slice(0, 6)) expect(tree.flags[id] & F_ERROR).toBeTruthy();
  });

  it('warns about JSON5 and JSONC syntax in strict JSON but still reads it', () => {
    const text = "// c\n{a: 'x', \"b\": [1, 2,], 'k': 0x1F, n: NaN, p: +1, q: .5, /* c */ r: 5.,}";
    const strict = parseJson(text);
    expect(issues(strict)).toEqual([
      'warning: Comments are not allowed in JSON (2 occurrences)',
      'warning: Property names must be double-quoted in JSON (5 occurrences)',
      'warning: Single-quoted strings are not allowed in JSON (2 occurrences)',
      'warning: Trailing commas are not allowed in JSON (2 occurrences)',
      'warning: JSON5 number syntax (0x1F) is not allowed in JSON (5 occurrences)',
    ]);
    expect(strict.errors.map((e) => e.line)).toEqual([1, 2, 2, 2, 2]);
    expect(strict.toJS()).toMatchObject({ a: 'x', b: [1, 2], k: 31, p: 1, q: 0.5, r: 5 });
    // The extensions are fine where the format allows them.
    expect(issues(parseJson(text, { format: 'json5' }))).toEqual([]);
    expect(issues(parseJson('// c\n{"a": [1, 2,], /* c */ "b": 1,}', { format: 'jsonc' }))).toEqual([]);
    // Several top-level values.
    expect(issues(parseJson('{"a":1}{"b":2}'))).toEqual(['warning: JSON allows only one top-level value']);
    expect(issues(parseJson('{"a":1},{"b":2}'))).toEqual(['warning: JSON allows only one top-level value']);
    expect(issues(parseJson('{"a":1}\n{"b":2}\n', { format: 'jsonl' }))).toEqual([]);
    // Warnings never stop parsing early, and errors keep priority in the issue list.
    const many = parseJson(`[${Array.from({ length: 300 }, () => '/* c */ 1').join(',')}]`);
    expect(many.nodeCount()).toBe(301);
    expect(issues(many)).toEqual(['warning: Comments are not allowed in JSON (300 occurrences)']);
  });

  it('warns about duplicate keys in every JSON flavor', () => {
    for (const format of ['json', 'jsonc', 'json5', 'jsonl'] as const) {
      const tree = parseJson('{"a":1,"b":{"x":1,"x":2},"\\u0061":3}', { format });
      expect(issues(tree), format).toEqual(['warning: Duplicate key "x"', 'warning: Duplicate key "a"']);
      expect(tree.toJS()).toEqual({ a: 3, b: { x: 2 } });
    }
    expect(issues(parseJson("{a: 1, 'a': 2, \"a\": 3}", { format: 'json5' }))).toEqual(['warning: Duplicate key "a"', 'warning: Duplicate key "a"']);
    const lots = parseJson(`{${Array.from({ length: 30 }, (_, i) => `"k":${i}`).join(',')}}`);
    expect(lots.errors.length).toBe(21);
    expect(lots.errors.at(-1)?.message).toBe('9 more duplicate keys');
  });

  it('finds duplicate keys exactly, in records that repeat a shape and in ones that do not', () => {
    // Reference: decode every key of every object.
    const expected = (tree: ReturnType<typeof parseJson>) => {
      const out: string[] = [];
      for (let id = 0; id < tree.count; id++) {
        if (tree.type[id] !== T_OBJECT) continue;
        const seen = new Set<string>();
        for (let c = tree.firstChild(id); c >= 0; c = tree.nextSibling(c)) {
          const k = String(tree.key(c));
          if (seen.has(k)) out.push(`${tree.keyPos[c]} ${k}`);
          seen.add(k);
        }
      }
      return out.slice(0, 20);
    };
    const r = rng(7);
    const keys = ['id', 'name', 'nome', 'note', 'ab1', 'ab2', 'xy1', 'field_10_name', 'field_11_name', '\\u0061b1', 'a'];
    for (let round = 0; round < 200; round++) {
      const shape = Array.from({ length: 1 + Math.floor(r() * 20) }, () => keys[Math.floor(r() * keys.length)]);
      const objects = Array.from({ length: 1 + Math.floor(r() * 30) }, () => {
        // Mostly the same shape (the template path), sometimes with one key changed.
        const own = r() < 0.8 ? shape : shape.map((k) => (r() < 0.2 ? keys[Math.floor(r() * keys.length)] : k));
        return `{${own.map((k, i) => `"${k}":${i}`).join(',')}}`;
      });
      const tree = parseJson(`[${objects.join(',')}]`);
      const got = tree.errors.filter((e) => e.message.startsWith('Duplicate key')).map((e) => `${e.offset} ${JSON.parse(e.message.slice(14))}`);
      expect(got, `round ${round}`).toEqual(expected(tree));
    }
  });

  it('reports an empty document', () => {
    for (const text of ['', '   \n\t ', '﻿']) {
      const tree = parseJson(text);
      expect(issues(tree)).toEqual(['error: Empty document']);
      expect(tree.nodeCount()).toBe(0);
    }
    expect(issues(parseJson('// nothing\n', { format: 'jsonc' }))).toEqual(['error: Empty document']);
    expect(issues(parseJson('', { format: 'jsonl' }))).toEqual(['warning: Empty document']);
  });

  it('keeps the "stopped parsing" notice when the issue list is full', () => {
    const tree = parseJson(`[${'?,'.repeat(500)}1]`);
    expect(tree.errors.length).toBe(50);
    expect(tree.errors.at(-1)?.message).toBe('Too many errors; stopped parsing');
  });
});
