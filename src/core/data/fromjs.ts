/** Builds a DataTree from an already-parsed JS value (TOML, INI, …). */

import {
  DataTree,
  F_NO_POS,
  T_ARRAY,
  T_BOOLEAN,
  T_NULL,
  T_NUMBER,
  T_OBJECT,
  T_STRING,
  TreeBuilder,
  type DataFormat,
  type PathSegment,
} from './tree';

export interface Located {
  keyPos: number;
  keyEnd: number;
  valPos: number;
  valEnd: number;
}

/** Looks up source positions for a path (JSON-encoded segments). */
export type Locator = (pathKey: string) => Located | undefined;

const MAX_DEPTH = 2000;

export function treeFromJS(value: unknown, text: string, format: DataFormat, locate?: Locator): DataTree {
  const b = new TreeBuilder(text, format, 256);
  const path: PathSegment[] = [];

  const add = (v: unknown, key: string | null, depth: number) => {
    const loc = locate?.(JSON.stringify(path));
    const flags = loc ? 0 : F_NO_POS;
    const kp = loc?.keyPos ?? 0;
    const ke = loc?.keyEnd ?? 0;
    const vp = loc?.valPos ?? 0;
    const ve = loc?.valEnd ?? 0;
    let id: number;
    if (Array.isArray(v) && depth < MAX_DEPTH) {
      id = b.open(T_ARRAY, flags, kp, ke, vp);
      v.forEach((item, i) => {
        path.push(i);
        add(item, null, depth + 1);
        path.pop();
      });
      b.close(ve);
    } else if (isPlainObject(v) && depth < MAX_DEPTH) {
      id = b.open(T_OBJECT, flags, kp, ke, vp);
      for (const [k, item] of Object.entries(v)) {
        path.push(k);
        add(item, k, depth + 1);
        path.pop();
      }
      b.close(ve);
    } else {
      const [type, str] = primitive(v);
      id = b.leaf(type, flags, kp, ke, vp, ve);
      b.setValue(id, str);
    }
    if (key !== null) b.setKey(id, key);
  };

  add(value, null, 0);
  const tree = b.finish();
  if (locate) inheritPositions(tree);
  return tree;
}

/** Containers without a position take the span of their positioned children. */
function inheritPositions(tree: DataTree): void {
  for (let id = tree.count - 1; id >= 0; id--) {
    if (!(tree.flags[id] & F_NO_POS) || tree.childCount[id] === 0) continue;
    let lo = Infinity;
    let hi = -1;
    for (let c = tree.firstChild(id); c >= 0; c = tree.nextSibling(c)) {
      if (tree.flags[c] & F_NO_POS) continue;
      lo = Math.min(lo, tree.start(c));
      hi = Math.max(hi, tree.end(c));
    }
    if (hi < 0) continue;
    tree.flags[id] &= ~F_NO_POS;
    tree.keyPos[id] = lo;
    tree.keyEnd[id] = lo;
    tree.valPos[id] = lo;
    tree.valEnd[id] = hi;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  if (v instanceof Date) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function primitive(v: unknown): [1 | 2 | 3 | 4 | 5 | 6, string] {
  if (v === null || v === undefined) return [T_NULL, 'null'];
  switch (typeof v) {
    case 'string':
      return [T_STRING, v];
    case 'number':
      return [T_NUMBER, Number.isFinite(v) ? String(v) : Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity'];
    case 'bigint':
      return [T_NUMBER, v.toString()];
    case 'boolean':
      return [T_BOOLEAN, String(v)];
    default:
      // TomlDate overrides toISOString() to keep local dates/times as written.
      if (v instanceof Date) return [T_STRING, isNaN(v.getTime()) ? String(v) : v.toISOString()];
      return [T_STRING, String(v)];
  }
}
