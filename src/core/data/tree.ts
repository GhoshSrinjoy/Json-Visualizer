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
/** YAML alias left unexpanded (circular, unknown anchor or expansion cap): a `*anchor` string. */
export const F_ALIAS = 256;
/** `keyPos` is an index into `tree.columns` (CSV header). */
export const F_COLUMN_KEY = 512;
/** No source positions are available for this node. */
export const F_NO_POS = 1024;
/** XML CDATA section. */
export const F_CDATA = 2048;
/** Copied from a YAML anchor by an alias or merge key; positions point at the anchor. */
export const F_COPY = 4096;

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
  /** Absent means 'error'; warnings flag input that was read fine but is not valid in the format. */
  severity?: 'error' | 'warning';
}

export type PathSegment = string | number;
export type Primitive = string | number | boolean | null;

/** Nesting beyond this is summarised by toJS (keeps recursion bounded). */
const MAX_JS_DEPTH = 1000;
/** V8's string length limit: no JSON text can be longer. */
const MAX_STRING = 2 ** 29 - 24;

/** Formats whose text is JSON-like (Excel workbooks are converted to JSON). */
const JSON_FAMILY = new Set<DataFormat>(['json', 'jsonc', 'json5', 'jsonl', 'xlsx']);
const XML_FAMILY = new Set<DataFormat>(['xml', 'html']);
/** Formats whose parsers assign ids in source order (TOML and YAML aliases do not). */
const SOURCE_ORDERED = new Set<DataFormat>(['json', 'jsonc', 'json5', 'jsonl', 'xlsx', 'xml', 'html', 'csv', 'tsv', 'ini', 'env', 'properties']);

const CONTROL_CHAR = /[\u0000-\u001f]/;
const NEEDS_ESCAPE = /[\\\u0000-\u001f]/;

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
  /** Positioned node ids sorted by start, when ids are not in source order (null when they are). */
  private byStart: Uint32Array | null | undefined;
  /** JSON string literals of `columns`, built on first use. */
  private columnsJSON: string[] | undefined;
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
        const n = parseNumber(raw);
        return Number.isNaN(n) && !NAN_LITERAL.test(raw.trim()) ? raw : n;
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
        return 'null';
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

  /** Deepest node whose source range contains `offset` (the root when none does). */
  nodeAtOffset(offset: number): number {
    const byStart = this.positionIndex();
    const best = byStart ? this.lastStartingIn(byStart, offset) : this.lastStarting(offset);
    for (let id = best; id >= 0; id = this.parent[id]) {
      if (this.flags[id] & (F_SYNTHETIC | F_NO_POS)) continue;
      if (this.start(id) <= offset && offset < Math.max(this.end(id), this.start(id) + 1)) return id;
    }
    return this.root;
  }

  /** The last node, by id, that starts at or before `offset`; ids must be in source order. */
  private lastStarting(offset: number): number {
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
    return best;
  }

  /**
   * Ids are in source order for most formats, so nodeAtOffset can binary-search
   * them directly. TOML (tables can be reopened after other tables) and YAML
   * aliases (copies point back at their anchor) break that order; for those an
   * index of positioned, non-copied nodes sorted by start is built once.
   */
  private positionIndex(): Uint32Array | null {
    if (this.byStart !== undefined) return this.byStart;
    let ordered = true;
    if (!SOURCE_ORDERED.has(this.format)) {
      for (let id = 0, prev = 0; id < this.count; id++) {
        const f = this.flags[id];
        if (f & (F_NO_POS | F_SYNTHETIC)) continue;
        const s = this.start(id);
        if (f & F_COPY || s < prev) {
          ordered = false;
          break;
        }
        prev = s;
      }
    }
    if (ordered) return (this.byStart = null);
    const ids: number[] = [];
    const starts = new Uint32Array(this.count);
    for (let id = 0; id < this.count; id++) {
      if (this.flags[id] & (F_NO_POS | F_SYNTHETIC | F_COPY)) continue;
      ids.push(id);
      starts[id] = this.start(id);
    }
    // Ties keep id order, so the deepest of several nodes starting together wins.
    ids.sort((a, b) => starts[a] - starts[b] || a - b);
    return (this.byStart = Uint32Array.from(ids));
  }

  /** The last node of `byStart` that starts at or before `offset` (-1 when none does). */
  private lastStartingIn(byStart: Uint32Array, offset: number): number {
    let best = -1;
    for (let lo = 0, hi = byStart.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >>> 1;
      if (this.start(byStart[mid]) <= offset) {
        best = byStart[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
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
   * Materialises a subtree as plain JS for display. `budget` caps the number of
   * nodes visited; containers past the budget are replaced by a summary string,
   * so exports and copies must use toJSON / jsonText instead.
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
      } else if (k === '__proto__') {
        // Assignment would set the prototype instead of adding the key.
        Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
      } else obj[k] = v;
    }
    return obj;
  }

  /**
   * Complete JSON text of a subtree (see jsonText). Throws when it would be
   * longer than `maxChars`, so a copy or export is never silently cut short.
   */
  toJSON(id = this.root, indent: number | undefined = 2, maxChars = Infinity): string {
    const { text, truncated } = this.jsonText(id, indent, maxChars);
    if (truncated) {
      const what = id === this.root ? 'The document' : this.pathString(id);
      throw new Error(`${what} is larger than ${charsLabel(Math.min(maxChars, MAX_STRING))} as JSON; select a smaller part to copy or export.`);
    }
    return text;
  }

  /**
   * JSON text of a subtree, written straight from the columns: no intermediate
   * JS values and no recursion, so documents of any size and depth convert
   * completely. Number literals that are valid JSON are copied verbatim (big
   * integers keep every digit); other spellings become what JSON.stringify
   * writes for their value (`0x1F` → 31, `.5` → 0.5, NaN and Infinity → null).
   * XML siblings that share a name are grouped into arrays, as in toJS;
   * duplicate keys elsewhere are kept as written. `indent` works as in
   * JSON.stringify. Writing stops once the text would exceed `maxChars`: `text`
   * is then its first `maxChars` characters and `truncated` is true.
   */
  jsonText(id = this.root, indent?: number, maxChars = Infinity): { text: string; truncated: boolean } {
    const out = new JsonWriter(Math.max(0, Math.min(maxChars, MAX_STRING)));
    const step = indent !== undefined && indent >= 1 ? Math.min(10, Math.floor(indent)) : 0;
    const pads: string[] = [];
    const seps: string[] = [];
    const indentOf = (depth: number) => (step ? '\n' + ' '.repeat(depth * step) : '');
    const pad = (depth: number): string => (depth < 256 ? (pads[depth] ??= indentOf(depth)) : indentOf(depth));
    const sep = (depth: number): string => (depth < 256 ? (seps[depth] ??= ',' + indentOf(depth)) : ',' + indentOf(depth));
    const colon = step ? ': ' : ':';
    const { type, size, childCount } = this;
    // Open containers, innermost last. A frame walks its children by subtree
    // size, or an explicit item list: an XML object whose children repeat a
    // name lists name groups, and each group is written as an array of ids.
    const ids: number[] = [];
    const nexts: number[] = []; // next child id, or next list index
    const ends: number[] = []; // end of the subtree, or list length
    const lists: (number[][] | number[] | undefined)[] = [];
    const objects: boolean[] = [];
    let sp = 0;
    const push = (container: number, object: boolean, list: number[][] | number[] | undefined) => {
      ids[sp] = container;
      nexts[sp] = list ? 0 : container + 1;
      ends[sp] = list ? list.length : container + size[container];
      lists[sp] = list;
      objects[sp] = object;
      sp++;
    };
    const value = (node: number) => {
      const t = type[node];
      if (t !== T_OBJECT && t !== T_ARRAY) out.write(this.scalarJSON(node));
      else if (childCount[node] === 0) out.write(t === T_OBJECT ? '{}' : '[]');
      else {
        out.write(t === T_OBJECT ? '{' : '[');
        push(node, t === T_OBJECT, t === T_OBJECT && this.xmlLike ? this.nameGroups(node) : undefined);
      }
    };

    value(id);
    while (sp > 0 && !out.full) {
      const d = sp - 1;
      const next = nexts[d];
      if (next >= ends[d]) {
        sp = d;
        out.write(pad(d));
        out.write(objects[d] ? '}' : ']');
        continue;
      }
      const list = lists[d];
      let child: number;
      let group: number[] | undefined;
      if (list === undefined) {
        child = next;
        nexts[d] = next + size[next];
        out.write(next === ids[d] + 1 ? pad(sp) : sep(sp));
      } else {
        const item = list[next];
        nexts[d] = next + 1;
        out.write(next === 0 ? pad(sp) : sep(sp));
        if (typeof item === 'number') child = item;
        else if (item.length === 1) child = item[0];
        else {
          child = item[0];
          group = item;
        }
      }
      if (objects[d]) {
        out.write(this.keyJSON(child));
        out.write(colon);
      }
      if (group) {
        out.write('[');
        push(-1, false, group);
      } else value(child);
    }
    return out.result();
  }

  /** JSON text of a primitive node. */
  private scalarJSON(id: number): string {
    switch (this.type[id]) {
      case T_STRING:
        return this.stringJSON(id);
      case T_NUMBER: {
        const raw = this.rawValue(id);
        return jsonNumber(raw) ?? JSON.stringify(raw);
      }
      case T_BOOLEAN:
        return this.value(id) ? 'true' : 'false';
      default:
        return 'null';
    }
  }

  /** JSON string literal of a T_STRING node; JSON sources reuse their own literal when it is valid. */
  private stringJSON(id: number): string {
    const f = this.flags[id];
    if (this.jsonLike && !(f & (F_VAL_SYNTH | F_ERROR))) {
      const raw = this.text.slice(this.valPos[id], this.valEnd[id]);
      if (raw.length >= 2 && raw.charCodeAt(0) === 34 && raw.charCodeAt(raw.length - 1) === 34) {
        if (!(f & F_ESCAPED)) {
          if (!CONTROL_CHAR.test(raw)) return raw;
        } else {
          try {
            JSON.parse(raw);
            return raw;
          } catch {
            // not strict JSON (raw control characters, `\x41`…): re-encode below
          }
        }
      }
    }
    return JSON.stringify(this.stringValue(id));
  }

  /** JSON string literal of an object member's key. */
  private keyJSON(id: number): string {
    const f = this.flags[id];
    if (this.jsonLike && !(f & F_KEY_SYNTH)) {
      const raw = this.text.slice(this.keyPos[id], this.keyEnd[id]);
      if (raw.length >= 2 && raw.charCodeAt(0) === 34 && raw.charCodeAt(raw.length - 1) === 34 && !NEEDS_ESCAPE.test(raw)) return raw;
    } else if (f & F_COLUMN_KEY && !(f & F_KEY_SYNTH) && this.columns) {
      const cached = (this.columnsJSON ??= this.columns.map((c) => JSON.stringify(c)))[this.keyPos[id]];
      if (cached !== undefined) return cached;
    }
    return JSON.stringify(String(this.key(id)));
  }

  /** Children of an XML element grouped by name in first-seen order, when a name repeats (as toJS groups them). */
  private nameGroups(id: number): number[][] | undefined {
    const n = this.childCount[id];
    if (n < 2) return undefined;
    const groups = new Map<string, number[]>();
    let repeated = false;
    for (let c = id + 1, k = 0; k < n; k++, c += this.size[c]) {
      const name = String(this.key(c));
      const g = groups.get(name);
      if (g) {
        g.push(c);
        repeated = true;
      } else groups.set(name, [c]);
    }
    return repeated ? [...groups.values()] : undefined;
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

/**
 * Collects output in joined chunks (never one deep string rope) and stops
 * accepting text once `max` characters have been written.
 */
class JsonWriter {
  full = false;
  private length = 0;
  private parts: string[] = [];
  private readonly chunks: string[] = [];

  constructor(private readonly max: number) {}

  write(s: string): void {
    if (this.full) return;
    if (this.length + s.length > this.max) {
      this.parts.push(s.slice(0, this.max - this.length));
      this.length = this.max;
      this.full = true;
      return;
    }
    this.length += s.length;
    this.parts.push(s);
    if (this.parts.length === 4096) {
      this.chunks.push(this.parts.join(''));
      this.parts = [];
    }
  }

  result(): { text: string; truncated: boolean } {
    this.chunks.push(this.parts.join(''));
    this.parts = [];
    return { text: this.chunks.length === 1 ? this.chunks[0] : this.chunks.join(''), truncated: this.full };
  }
}

/** "20 MB"-style label for a character limit (one character is about one byte). */
function charsLabel(n: number): string {
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e2) / 10} KB`;
  return `${n} characters`;
}

const NAN_LITERAL = /^[+-]?\.?nan$/i;
const INF_LITERAL = /^\.?inf(inity)?$/i;
/** Decimal literals JSON does not accept as written: `+1`, `.5`, `5.`, `007`, `1_000`. */
const LOOSE_DECIMAL = /^([+-]?)(\d[\d_]*)?(?:\.(\d[\d_]*)?)?(?:[eE]([+-]?\d+))?$/;

/** True when `s` is exactly one JSON number token. */
export function isJsonNumber(s: string): boolean {
  let i = 0;
  let c = s.charCodeAt(0);
  if (c === 45) c = s.charCodeAt(++i);
  if (c === 48) c = s.charCodeAt(++i);
  else if (c >= 49 && c <= 57) {
    do c = s.charCodeAt(++i);
    while (c >= 48 && c <= 57);
  } else return false;
  if (c === 46) {
    const from = ++i;
    c = s.charCodeAt(i);
    while (c >= 48 && c <= 57) c = s.charCodeAt(++i);
    if (i === from) return false;
  }
  if (c === 101 || c === 69) {
    c = s.charCodeAt(++i);
    if (c === 43 || c === 45) c = s.charCodeAt(++i);
    const from = i;
    while (c >= 48 && c <= 57) c = s.charCodeAt(++i);
    if (i === from) return false;
  }
  return i === s.length;
}

/**
 * Numeric value of a number literal in any spelling the parsers accept: JSON,
 * JSON5 (`0x1F`, `.5`, `+1`, `Infinity`), YAML (`0o17`, `.inf`, `.nan`), TOML
 * (`1_000`, `0b11`, `inf`, `nan`) and CSV cells with surrounding spaces. NaN
 * when the text is not a number.
 */
export function parseNumber(raw: string): number {
  let s = raw.trim();
  if (s.includes('_')) s = s.replace(/_/g, '');
  const c = s.charCodeAt(0);
  if (c === 43 || c === 45) s = s.slice(1);
  if (!s) return NaN;
  const sign = c === 45 ? -1 : 1;
  const n = Number(s); // decimal, 0x/0o/0b and Infinity
  if (!Number.isNaN(n)) return sign * n;
  return INF_LITERAL.test(s) ? sign * Infinity : NaN;
}

/**
 * JSON text for a number literal: the literal itself when it is a valid JSON
 * number (so no digit is lost), otherwise what JSON.stringify writes for its
 * value, except that long decimal literals keep every digit
 * (`+12345678901234567890` → `12345678901234567890`). Undefined when the text
 * is not a number at all.
 */
export function jsonNumber(raw: string): string | undefined {
  if (isJsonNumber(raw)) return raw;
  const s = raw.trim();
  if (s !== raw && isJsonNumber(s)) return s;
  const m = LOOSE_DECIMAL.exec(s);
  if (m && (m[2] || m[3])) {
    const int = (m[2] ?? '').replace(/_/g, '').replace(/^0+(?=\d)/, '') || '0';
    const frac = (m[3] ?? '').replace(/_/g, '');
    const text = `${m[1] === '-' ? '-' : ''}${int}${frac ? '.' + frac : ''}${m[4] !== undefined ? 'e' + m[4] : ''}`;
    if (significantDigits(int + frac) > 15) return text;
    const n = Number(text);
    return Number.isFinite(n) ? String(n) : text;
  }
  const n = parseNumber(s);
  if (Number.isNaN(n)) return NAN_LITERAL.test(s) ? 'null' : undefined;
  if (!Number.isFinite(n)) return 'null';
  if (!Number.isSafeInteger(n) && /^[+-]?0[box][\da-f_]+$/i.test(s)) {
    return (s[0] === '-' ? '-' : '') + BigInt(s.replace(/^[+-]/, '').replace(/_/g, '')).toString();
  }
  return String(n);
}

/** Significant digits in a run of decimal digits (leading and trailing zeros do not count). */
function significantDigits(digits: string): number {
  let a = 0;
  let b = digits.length;
  while (a < b && digits.charCodeAt(a) === 48) a++;
  while (b > a && digits.charCodeAt(b - 1) === 48) b--;
  return b - a;
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
