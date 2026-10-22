import { describe, expect, it } from 'vitest';
import { parseData } from '../../src/core/data/formats';
import { cellKey, filterRows, sortRows, valueKey, type SortKey } from '../../src/webview/worker/table';

describe('table rows', () => {
  const t = parseData(
    JSON.stringify([
      { name: 'item10', n: 3, tag: 'b' },
      { name: 'Item2', n: -1, tag: null },
      { n: 10, name: 'item1', tag: 'B' },
      { name: 'zeta', n: 'n/a' },
      { name: 'alpha', n: 3, tag: 'a"b' },
    ]),
    'json',
  );
  const ids = t.children(t.root);
  const sorted = (column: string, desc = false) => {
    const hint = { index: 0 };
    return sortRows(ids, ids.map((r) => cellKey(t, r, column, hint)), desc).map((r) => ids.indexOf(r));
  };

  it('sorts numbers numerically, strings naturally and empty cells last', () => {
    expect(sorted('name')).toEqual([4, 2, 1, 0, 3]); // alpha, item1, Item2, item10, zeta
    expect(sorted('name', true)).toEqual([3, 0, 1, 2, 4]);
    // Numbers before strings; equal keys keep their order.
    expect(sorted('n')).toEqual([1, 0, 4, 2, 3]);
    expect(sorted('n', true)).toEqual([3, 2, 0, 4, 1]);
    // Missing and null cells stay last both ways.
    expect(sorted('tag')).toEqual([4, 0, 2, 1, 3]);
    expect(sorted('tag', true).slice(-2)).toEqual([1, 3]);
    expect(valueKey(t, t.root)).toBe(5);
  });

  it('filters on decoded cell text, case-insensitively', () => {
    const rows = (f: string) => filterRows(t, ids, f).map((r) => ids.indexOf(r));
    expect(rows('ITEM1')).toEqual([0, 2]);
    expect(rows('a"b')).toEqual([4]);
    expect(rows('n/a')).toEqual([3]);
    expect(rows('.*')).toEqual([]);
  });

  it('sorts a large string column quickly', () => {
    const n = 200_000;
    const keys: SortKey[] = Array.from({ length: n }, (_, i) => `user${(i * 7919) % n}`);
    const rowIds = Array.from({ length: n }, (_, i) => i);
    const started = performance.now();
    const order = sortRows(rowIds, keys, false);
    // About half a second; comparing with localeCompare(…, options) took over 12 s.
    expect(performance.now() - started).toBeLessThan(5000);
    expect(order.slice(0, 3).map((i) => keys[i])).toEqual(['user0', 'user1', 'user2']);
    expect(keys[order[n - 1]]).toBe(`user${n - 1}`);
  });
});
