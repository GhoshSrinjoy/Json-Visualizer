/**
 * Sorting and filtering of table rows for the data worker (a module of its
 * own so it can be tested without a worker).
 *
 * Sorting compares with one shared Intl.Collator: `localeCompare(…, options)`
 * resolves the locale again on every call, which made a 200k-row string
 * column take over 12 s. Distinct strings are collated once, and rows are
 * then ordered by plain numbers.
 */

import { DataTree, T_ARRAY, T_OBJECT, T_STRING } from '../../core/data/tree';

const collator = new Intl.Collator(undefined, { numeric: true });

/** A cell's sort key: numbers numerically, strings by the collator, null (missing or null) last. */
export type SortKey = number | string | null;

/** Sort key of the value at `id` (containers sort by their size). */
export function valueKey(t: DataTree, id: number): SortKey {
  const type = t.type[id];
  if (type === T_OBJECT || type === T_ARRAY) return t.childCount[id];
  const v = t.value(id);
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : v;
  return String(v);
}

/** Sort key of `column` in the record `row`; `hint` is where the column was in the previous row. */
export function cellKey(t: DataTree, row: number, column: string, hint = { index: 0 }): SortKey {
  if (t.type[row] !== T_OBJECT) return null;
  // Records usually repeat their keys in the same order: try the last position first.
  const guess = t.childAt(row, hint.index);
  if (guess >= 0 && t.key(guess) === column) return valueKey(t, guess);
  let i = 0;
  for (let c = t.firstChild(row); c >= 0; c = t.nextSibling(c), i++) {
    if (String(t.key(c)) === column) {
      hint.index = i;
      return valueKey(t, c);
    }
  }
  return null;
}

/**
 * Row ids ordered by their keys (`keys[i]` belongs to `ids[i]`). Numbers come
 * before strings, as in spreadsheets; descending reverses that but keeps
 * empty cells last. Equal keys keep their order.
 */
export function sortRows(ids: number[], keys: SortKey[], desc: boolean): number[] {
  const n = ids.length;
  const strings = new Set<string>();
  for (const k of keys) if (typeof k === 'string') strings.add(k);
  const sorted = [...strings].sort(collator.compare);
  const rank = new Map<string, number>();
  sorted.forEach((s, i) => rank.set(s, i));
  // Class (numbers, strings, empty) and a number within it.
  const cls = new Uint8Array(n);
  const val = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    if (k === null) cls[i] = 2;
    else if (typeof k === 'number') {
      cls[i] = desc ? 1 : 0;
      val[i] = desc ? -k : k;
    } else {
      cls[i] = desc ? 0 : 1;
      const r = rank.get(k)!;
      val[i] = desc ? -r : r;
    }
  }
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => cls[a] - cls[b] || val[a] - val[b]);
  return order.map((i) => ids[i]);
}

/**
 * Rows containing `filter` (case-insensitive) in a cell's text, or for rows
 * that are not records, in their own value or key.
 */
export function filterRows(t: DataTree, ids: number[], filter: string): number[] {
  const re = new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const text = (id: number) => {
    const type = t.type[id];
    if (type === T_OBJECT || type === T_ARRAY) return t.preview(id);
    return type === T_STRING ? t.stringValue(id) : t.rawValue(id);
  };
  return ids.filter((r) => {
    if (!t.isContainer(r)) return re.test(text(r)) || re.test(String(t.key(r)));
    for (let c = t.firstChild(r); c >= 0; c = t.nextSibling(c)) if (re.test(text(c))) return true;
    return false;
  });
}
