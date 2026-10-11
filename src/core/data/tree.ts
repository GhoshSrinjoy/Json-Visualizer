/**
 * Columnar, pre-order tree shared by every structured-data format.
 *
 * Node ids are assigned in document (pre-order) order, so the subtree of `id`
 * is exactly the id range [id, id + size[id]). That gives O(1) first-child and
 * next-sibling navigation without allocating an object per value, keeping
 * memory around 30 bytes per node even for files with tens of millions of
 * values. Keys and primitive values are not materialised: they are sliced from
 * the source text on demand (or read from a sparse side table when the source
 * text cannot represent them, e.g. resolved YAML scalars).
 */

import { decodeEntities, decodeQuoted, formatPath, oneLine } from '../util/strings';

export const T_OBJECT = 1;
export const T_ARRAY = 2;
export const T_STRING = 3;
export const T_NUMBER = 4;
export const T_BOOLEAN = 5;
export const T_NULL = 6;
export type NodeType = 1 | 2 | 3 | 4 | 5 | 6;

export const TYPE_NAMES = ['unknown', 'object', 'array', 'string', 'number', 'boolean', 'null'] as const;
export type TypeName = (typeof TYPE_NAMES)[number];

/** Key text lives in `synthKeys` (positions may still be valid). */
export const F_KEY_SYNTH = 1;
/** Value text lives in `synthVals` (positions may still be valid). */
export const F_VAL_SYNTH = 2;
/** Value needs decoding: JSON escapes, XML entities or doubled CSV quotes. */
export const F_ESCAPED = 4;
/** XML attribute. */
export const F_ATTR = 8;
/** XML text or CDATA content. */
export const F_TEXT = 16;
/** XML element. */
export const F_ELEMENT = 32;
/** Container with no source counterpart (JSON Lines root, multi-document YAML…). */
export const F_SYNTHETIC = 64;
/** Produced by error recovery. */
export const F_ERROR = 128;
/** YAML alias (`*anchor`). */
export const F_ALIAS = 256;
/** `keyPos` is an index into `tree.columns` (CSV header). */
export const F_COLUMN_KEY = 512;
/** No source positions are available for this node. */
export const F_NO_POS = 1024;
/** XML CDATA section. */
export const F_CDATA = 2048;

export type DataFormat =
  | 'json'
  | 'jsonc'
  | 'json5'
  | 'jsonl'
  | 'yaml'
  | 'xml'
  | 'html'
  | 'toml'
  | 'csv'
  | 'tsv'
  | 'ini'
  | 'env'
  | 'properties'
  /** Excel workbooks, converted to JSON (one record array per sheet). */
  | 'xlsx';

export interface ParseIssue {
  offset: number;
  message: string;
  line: number;
  col: number;
}

export type PathSegment = string | number;
export type Primitive = string | number | boolean | null;

/** Nesting beyond this is summarised by toJS (keeps recursion bounded). */
const MAX_JS_DEPTH = 1000;

/** Formats whose text is JSON-like (Excel workbooks are converted to JSON). */
const JSON_FAMILY = new Set<DataFormat>(['json', 'jsonc', 'json5', 'jsonl', 'xlsx']);
const XML_FAMILY = new Set<DataFormat>(['xml', 'html']);

export class DataTree {
  count = 0;
  /** Effective root (a synthetic wrapper is skipped when it has one child). */
  root = 0;
  capacity: number;
  type: Uint8Array;
  flags: Uint16Array;
  parent: Int32Array;
  size: Uint32Array;
  childCount: Uint32Array;
  keyPos: Uint32Array;
  keyEnd: Uint32Array;
  valPos: Uint32Array;
  valEnd: Uint32Array;
  synthKeys = new Map<number, string>();
  synthVals = new Map<number, string>();
  /** CSV header names, referenced by F_COLUMN_KEY nodes. */
  columns: string[] | undefined;
  errors: ParseIssue[] = [];
  maxDepth = 0;
  parseMs = 0;
  private lineStarts: Uint32Array | undefined;
  private readonly jsonLike: boolean;
  readonly xmlLike: boolean;

  constructor(
    readonly text: string,
    readonly format: DataFormat,
    capacity = 64,
  ) {
    this.capacity = Math.max(16, capacity | 0);
    const c = this.capacity;
    this.type = new Uint8Array(c);
    this.flags = new Uint16Array(c);
    this.parent = new Int32Array(c);
    this.size = new Uint32Array(c);
    this.childCount = new Uint32Array(c);
    this.keyPos = new Uint32Array(c);
    this.keyEnd = new Uint32Array(c);
    this.valPos = new Uint32Array(c);
    this.valEnd = new Uint32Array(c);
    this.jsonLike = JSON_FAMILY.has(format);
    this.xmlLike = XML_FAMILY.has(format);
  }

  grow(min = this.capacity * 2): void {
    const c = Math.max(min, Math.ceil(this.capacity * 1.6));
    this.type = growU8(this.type, c);
    this.flags = growU16(this.flags, c);
    this.parent = growI32(this.parent, c);
    this.size = growU32(this.size, c);
    this.childCount = growU32(this.childCount, c);
    this.keyPos = growU32(this.keyPos, c);
    this.keyEnd = growU32(this.keyEnd, c);
    this.valPos = growU32(this.valPos, c);
    this.valEnd = growU32(this.valEnd, c);
    this.capacity = c;
  }

  // ---------------------------------------------------------------- navigation

  isContainer(id: number): boolean {
    const t = this.type[id];
    return t === T_OBJECT || t === T_ARRAY;
  }

  firstChild(id: number): number {
    return this.childCount[id] > 0 ? id + 1 : -1;
  }

  nextSibling(id: number): number {
    const p = this.parent[id];
    if (p < 0) return -1;
    const next = id + this.size[id];
    return next < p + this.size[p] ? next : -1;
  }

  /** Child ids in order, skipping `offset` and returning at most `limit`. */
  children(id: number, offset = 0, limit = Infinity): number[] {
    const out: number[] = [];
    const n = this.childCount[id];
    if (n === 0 || offset >= n) return out;
    const size = this.size;
    let c = id + 1;
    for (let i = 0; i < offset; i++) c += size[c];
    const end = Math.min(n, offset + limit);
    for (let i = offset; i < end; i++) {
      out.push(c);
      c += size[c];
    }
    return out;
  }

  childAt(id: number, index: number): number {
    if (index < 0 || index >= this.childCount[id]) return -1;
    const size = this.size;
    let c = id + 1;
    for (let i = 0; i < index; i++) c += size[c];
    return c;
  }

  /** Index of `id` among its parent's children (O(index)). */
  indexInParent(id: number): number {
    const p = this.parent[id];
    if (p < 0) return 0;
    if (this.type[p] === T_ARRAY) return this.keyPos[id];
    let i = 0;
    for (let c = p + 1; c !== id; c += this.size[c]) i++;
    return i;
  }

  depth(id: number): number {
    let d = 0;
    for (let p = this.parent[id]; p >= 0 && p >= this.root; p = this.parent[p]) d++;
    return d;
  }

  // ---------------------------------------------------------------- keys & values

  isArrayChild(id: number): boolean {
    const p = this.parent[id];
    return p >= 0 && this.type[p] === T_ARRAY;
  }

  /** Key of `id`: a property name, an array index, or null for the root. */
  key(id: number): string | number | null {
    if (id === this.root || this.parent[id] < 0) return null;
    if (this.isArrayChild(id)) return this.keyPos[id];
    const f = this.flags[id];
    if (f & F_KEY_SYNTH) return this.synthKeys.get(id) ?? '';
    if (f & F_COLUMN_KEY) return this.columns?.[this.keyPos[id]] ?? `column${this.keyPos[id] + 1}`;
    if (f & F_TEXT) return f & F_CDATA ? '#cdata' : '#text';
    const raw = this.text.slice(this.keyPos[id], this.keyEnd[id]);
    if (f & F_ATTR) return '@' + raw;
    if (this.jsonLike) return decodeQuoted(raw);
    return raw;
  }

  /** Raw source text of a primitive (or the synthetic value). */
  rawValue(id: number): string {
    if (this.flags[id] & F_VAL_SYNTH) return this.synthVals.get(id) ?? '';
    return this.text.slice(this.valPos[id], this.valEnd[id]);
  }

  /** Decoded string content for T_STRING nodes (raw text for other primitives). */
  stringValue(id: number): string {
    const f = this.flags[id];
    if (f & F_VAL_SYNTH) return this.synthVals.get(id) ?? '';
    const raw = this.text.slice(this.valPos[id], this.valEnd[id]);
    if (this.type[id] !== T_STRING) return raw;
    if (this.jsonLike) return decodeQuoted(raw);
    if (!(f & F_ESCAPED)) return raw;
    if (this.xmlLike) return decodeEntities(raw);
    if (this.format === 'csv' || this.format === 'tsv') return raw.slice(1, -1).replace(/""/g, '"');
    return decodeQuoted(raw);
  }

  /** JS value of a primitive node; undefined for containers. */
  value(id: number): Primitive | undefined {
    switch (this.type[id]) {
      case T_STRING:
        return this.stringValue(id);
      case T_NUMBER: {
        const raw = this.rawValue(id);
        const n = Number(raw.replace(/_/g, ''));
        return Number.isNaN(n) && !/nan/i.test(raw) ? raw : n;
      }
      case T_BOOLEAN:
        return /^(true|yes|on)$/i.test(this.rawValue(id));
      case T_NULL:
        return null;
      default:
        return undefined;
    }
  }

  /** Short single-line preview used by tree rows and graph cards. */
  preview(id: number, max = 80): string {
    switch (this.type[id]) {
      case T_OBJECT:
        return `{${this.childCount[id]}}`;
      case T_ARRAY:
        return `[${this.childCount[id]}]`;
      case T_STRING:
        return oneLine(this.stringValue(id), max);
      case T_NULL:
        return this.flags[id] & F_ALIAS ? this.rawValue(id) : 'null';
      default:
        return oneLine(this.rawValue(id), max);
    }
  }

  typeName(id: number): TypeName {
    return TYPE_NAMES[this.type[id]] ?? 'unknown';
  }

  // ---------------------------------------------------------------- paths

  /**
   * Path segments from the effective root to `id`. XML siblings that share a
   * tag name are addressed as `name[index]`, matching XML-to-JSON conventions.
   */
  path(id: number): PathSegment[] {
    const segs: PathSegment[] = [];
    for (let c = id; c !== this.root && c >= 0; c = this.parent[c]) {
      const p = this.parent[c];
      if (p < 0) break;
      const k = this.key(c);
      if (k === null) break;
      if (this.xmlLike && typeof k === 'string' && (this.flags[c] & F_ELEMENT)) {
        const { index, total } = this.sameKeyIndex(c, k);
        if (total > 1) segs.push(index);
      }
      segs.push(k);
    }
    return segs.reverse();
  }

  pathString(id: number): string {
    return formatPath(this.path(id));
  }

  private sameKeyIndex(id: number, key: string): { index: number; total: number } {
    const p = this.parent[id];
    let index = 0;
    let total = 0;
    for (let c = p + 1, n = this.childCount[p]; n > 0; n--, c += this.size[c]) {
      if (!(this.flags[c] & F_ELEMENT)) continue;
      if (this.key(c) !== key) continue;
      if (c < id) index++;
      total++;
    }
    return { index, total };
  }

  // ---------------------------------------------------------------- positions

  hasPosition(id: number): boolean {
    return !(this.flags[id] & (F_NO_POS | F_SYNTHETIC));
  }

  /** Source offset where the node (including its key) starts. */
  start(id: number): number {
    const v = this.valPos[id];
    const f = this.flags[id];
    if (this.parent[id] < 0 || this.isArrayChild(id) || f & (F_COLUMN_KEY | F_NO_POS | F_TEXT)) return v;
    const k = this.keyPos[id];
    return k < v ? k : v;
  }

  end(id: number): number {
    return this.valEnd[id];
  }

  /** Deepest node whose source range contains `offset` (or -1). */
  nodeAtOffset(offset: number): number {
    let lo = 0;
    let hi = this.count - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.flags[mid] & F_NO_POS) {
        // Positionless runs are rare; scan linearly for the nearest positioned node.
        let m = mid;
        while (m > lo && this.flags[m] & F_NO_POS) m--;
        if (this.flags[m] & F_NO_POS) {
          lo = mid + 1;
          continue;
        }
        if (this.start(m) <= offset) {
          best = m;
          lo = mid + 1;
        } else hi = m - 1;
        continue;
      }
      if (this.start(mid) <= offset) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (let id = best; id >= 0; id = this.parent[id]) {
      if (this.flags[id] & (F_SYNTHETIC | F_NO_POS)) continue;
      if (this.start(id) <= offset && offset < Math.max(this.end(id), this.start(id) + 1)) return id;
    }
    return this.root;
  }

  /** Zero-based line/column of a source offset. */
  lineCol(offset: number): { line: number; col: number } {
    const ls = this.lines();
    let lo = 0;
    let hi = ls.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (ls[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, col: offset - ls[lo] };
  }

  offsetOf(line: number, col: number): number {
    const ls = this.lines();
    const l = Math.max(0, Math.min(line, ls.length - 1));
    return Math.min(this.text.length, ls[l] + Math.max(0, col));
  }

  lineCount(): number {
    return this.lines().length;
  }

  private lines(): Uint32Array {
    if (this.lineStarts) return this.lineStarts;
    const t = this.text;
    let n = 1;
    for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) n++;
    const ls = new Uint32Array(n);
    let j = 1;
    for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) ls[j++] = i + 1;
    this.lineStarts = ls;
    return ls;
  }

  // ---------------------------------------------------------------- materialisation

  /**
   * Materialises a subtree as plain JS. `budget` caps the number of nodes
   * visited; containers past the budget are replaced by a summary string.
   */
  toJS(id = this.root, budget = 200_000): unknown {
    const state = { left: budget, depth: 0 };
    return this.toJSInner(id, state);
  }

  private toJSInner(id: number, state: { left: number; depth: number }): unknown {
    state.left--;
    const t = this.type[id];
    if (t !== T_OBJECT && t !== T_ARRAY) return this.value(id);
    if (state.left <= 0 || state.depth >= MAX_JS_DEPTH) {
      return t === T_ARRAY ? `[… ${this.childCount[id]} items]` : `{… ${this.childCount[id]} keys}`;
    }
    state.depth++;
    try {
      return t === T_ARRAY ? this.arrayToJS(id, state) : this.objectToJS(id, state);
    } finally {
      state.depth--;
    }
  }

  private arrayToJS(id: number, state: { left: number; depth: number }): unknown[] {
    const arr: unknown[] = [];
    for (let c = this.firstChild(id); c >= 0; c = this.nextSibling(c)) {
      if (state.left <= 0) {
        arr.push(`… ${this.childCount[id] - arr.length} more`);
        break;
      }
      arr.push(this.toJSInner(c, state));
    }
    return arr;
  }

  private objectToJS(id: number, state: { left: number; depth: number }): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    for (let c = this.firstChild(id); c >= 0; c = this.nextSibling(c)) {
      if (state.left <= 0) {
        obj['…'] = `${this.childCount[id] - Object.keys(obj).length} more keys`;
        break;
      }
      const k = String(this.key(c));
      const v = this.toJSInner(c, state);
      if (this.xmlLike && Object.prototype.hasOwnProperty.call(obj, k)) {
        const prev = obj[k];
        obj[k] = Array.isArray(prev) && (prev as { __multi?: boolean }).__multi ? (prev.push(v), prev) : markMulti([prev, v]);
      } else obj[k] = v;
    }
    return obj;
  }

  /**
   * JSON text for a subtree. For strict JSON sources the original text is
   * reused verbatim (so big numbers keep their precision).
   */
  toJSON(id = this.root, indent: number | undefined = 2, maxChars = Infinity): string {
    let s: string;
    if (this.format === 'json' && !this.errors.length && !(this.flags[id] & F_SYNTHETIC) && indent === undefined) {
      s = this.text.slice(this.valPos[id], this.valEnd[id]);
    } else {
      s = JSON.stringify(this.toJS(id), null, indent) ?? 'null';
    }
    return s.length > maxChars ? s.slice(0, maxChars) + '\n…(truncated)' : s;
  }

  /** Counts per node type in the subtree of `id`. */
  typeCounts(id = this.root): Record<TypeName, number> {
    const counts = { unknown: 0, object: 0, array: 0, string: 0, number: 0, boolean: 0, null: 0 };
    const end = id + this.size[id];
    const type = this.type;
    const tally = new Uint32Array(8);
    for (let i = id; i < end; i++) tally[type[i]]++;
    for (let t = 1; t <= 6; t++) counts[TYPE_NAMES[t]] = tally[t];
    if (this.flags[id] & F_SYNTHETIC) counts[TYPE_NAMES[this.type[id]]]--;
    return counts;
  }

  /** Number of real (non-synthetic) nodes. */
  nodeCount(): number {
    let n = this.size[this.root];
    if (this.flags[this.root] & F_SYNTHETIC) n--;
    return n;
  }
}

function markMulti(a: unknown[]): unknown[] {
  Object.defineProperty(a, '__multi', { value: true, enumerable: false });
  return a;
}

function growU8(a: Uint8Array, n: number): Uint8Array {
  const b = new Uint8Array(n);
  b.set(a);
  return b;
}
function growU16(a: Uint16Array, n: number): Uint16Array {
  const b = new Uint16Array(n);
  b.set(a);
  return b;
}
function growU32(a: Uint32Array, n: number): Uint32Array {
  const b = new Uint32Array(n);
  b.set(a);
  return b;
}
function growI32(a: Int32Array, n: number): Int32Array {
  const b = new Int32Array(n);
  b.set(a);
  return b;
}

/**
 * Appends nodes in pre-order. Parsers call `open`/`close` for containers and
 * `leaf` for primitives; parent links, child counts and subtree sizes are
 * maintained automatically.
 */
export class TreeBuilder {
  readonly tree: DataTree;
  private stack = new Int32Array(64);
  private sp = 0;

  constructor(text: string, format: DataFormat, estimatedNodes = 64) {
    this.tree = new DataTree(text, format, estimatedNodes);
  }

  get depth(): number {
    return this.sp;
  }

  get top(): number {
    return this.sp > 0 ? this.stack[this.sp - 1] : -1;
  }

  /** Adds a node under the open container. Array children get their index as key. */
  leaf(type: NodeType, flags: number, keyPos: number, keyEnd: number, valPos: number, valEnd: number): number {
    const t = this.tree;
    const id = t.count;
    if (id >= t.capacity) t.grow();
    const p = this.sp > 0 ? this.stack[this.sp - 1] : -1;
    t.type[id] = type;
    t.flags[id] = flags;
    t.parent[id] = p;
    if (p >= 0) {
      if (t.type[p] === T_ARRAY) {
        keyPos = t.childCount[p];
        keyEnd = keyPos;
      }
      t.childCount[p]++;
    }
    t.keyPos[id] = keyPos;
    t.keyEnd[id] = keyEnd;
    t.valPos[id] = valPos;
    t.valEnd[id] = valEnd;
    t.size[id] = 1;
    t.childCount[id] = 0;
    t.count = id + 1;
    return id;
  }

  open(type: NodeType, flags: number, keyPos: number, keyEnd: number, valPos: number): number {
    const id = this.leaf(type, flags, keyPos, keyEnd, valPos, valPos);
    if (this.sp === this.stack.length) {
      const s = new Int32Array(this.stack.length * 2);
      s.set(this.stack);
      this.stack = s;
    }
    this.stack[this.sp++] = id;
    if (this.sp > this.tree.maxDepth) this.tree.maxDepth = this.sp;
    return id;
  }

  close(valEnd: number): number {
    if (this.sp === 0) return -1;
    const t = this.tree;
    const id = this.stack[--this.sp];
    t.size[id] = t.count - id;
    t.valEnd[id] = valEnd;
    return id;
  }

  closeAll(valEnd: number): void {
    while (this.sp > 0) this.close(valEnd);
  }

  setKey(id: number, key: string): void {
    this.tree.flags[id] |= F_KEY_SYNTH;
    this.tree.synthKeys.set(id, key);
  }

  setValue(id: number, value: string): void {
    this.tree.flags[id] |= F_VAL_SYNTH;
    this.tree.synthVals.set(id, value);
  }

  error(offset: number, message: string): void {
    const t = this.tree;
    if (t.errors.length >= 50) return;
    t.errors.push({ offset, message, line: 0, col: 0 });
  }

  /**
   * Finalises the tree: skips a synthetic wrapper with a single child and
   * resolves line/column numbers for recorded errors.
   */
  finish(): DataTree {
    const t = this.tree;
    this.closeAll(t.text.length);
    t.root = 0;
    if (t.count > 1 && t.flags[0] & F_SYNTHETIC && t.childCount[0] === 1) {
      t.root = 1;
      t.parent[1] = -1;
    }
    for (const e of t.errors) {
      const lc = t.lineCol(e.offset);
      e.line = lc.line + 1;
      e.col = lc.col + 1;
    }
    return t;
  }
}
