/**
 * Structural diff of two DataTrees in any formats (JSON against YAML works).
 *
 * Each tree first gets a 64-bit content hash per node in one reverse pass:
 * objects hash independently of key order, numbers by value (1 = 1.0) and
 * strings by their decoded text. Identical subtrees are then skipped in O(1),
 * so two big documents with a few changes diff in about the time it takes to
 * hash them. Objects match by key; arrays by an id-like key (reporting
 * moves), by LCS on element hashes, by index or as multisets. Entries keep the
 * node ids of both trees, for side-by-side views and reveal-in-source.
 */

import { oneLine, pathSegment, withCommas } from '../util/strings';
import {
  DataTree,
  F_ATTR,
  F_COLUMN_KEY,
  F_ELEMENT,
  F_ESCAPED,
  F_KEY_SYNTH,
  F_TEXT,
  F_VAL_SYNTH,
  T_ARRAY,
  T_BOOLEAN,
  T_NUMBER,
  T_OBJECT,
  T_STRING,
} from './tree';

export type DiffKind = 'added' | 'removed' | 'changed' | 'type' | 'moved' | 'same';

export interface DiffEntry {
  /** 'type': the value's type changed; 'moved': an array element matched at a new index. */
  kind: DiffKind;
  /** JSONPath in the right document (in the left one for removed entries). */
  path: string;
  /** Node id in the left tree, or -1. */
  left: number;
  /** Node id in the right tree, or -1. */
  right: number;
  /** Property name or array index (left side for removed entries); null for the root. */
  key: string | number | null;
  /** Changes inside a container, in document order. */
  children?: DiffEntry[];
  /** Unchanged direct children left out of `children`. */
  unchanged?: number;
}

export interface DiffStats {
  added: number;
  removed: number;
  /** Changed values (containers that merely hold changes are not counted). */
  changed: number;
  moved: number;
  typeChanged: number;
}

export interface DiffResult {
  /** Entry for the two roots: kind 'same' when the documents are equal. */
  root: DiffEntry;
  stats: DiffStats;
  /** Output was cut at maxEntries (or at the nesting limit); stats cover what was reported. */
  truncated: boolean;
  ms: number;
}

export interface DiffOptions {
  /** Array matching: 'auto' (default) uses an id-like key when most elements have one, else LCS. */
  arrays?: 'auto' | 'index' | 'lcs';
  /** Keys tried as element identity by 'auto' (`@`-prefixed variants are added for XML). */
  idKeys?: string[];
  /** Compare arrays as multisets. */
  ignoreOrder?: boolean;
  /** Maximum number of entries reported (default 20,000). */
  maxEntries?: number;
  /** Numbers differing by at most this much are equal. */
  numericTolerance?: number;
}

const DEFAULT_ID_KEYS = ['id', '_id', 'uuid', 'key', 'name', 'slug', 'code'];
/** Exact LCS up to this many (left × right) cells; bigger ranges are split at unique elements first. */
const LCS_CELLS = 4_000_000;
/** Gaps up to this many (left × right) cells pair their elements by similarity. */
const PAIR_CELLS = 4096;
/** Similarity needed to pair two elements of an uneven gap. */
const PAIR_MIN = 0.3;
/** Unordered leftovers have no position to go by, so pairing needs about half the fields equal. */
const PAIR_UNORDERED = 2 / 3;
/** Share of elements that must carry the id key, on both sides. */
const ID_COVERAGE = 0.75;
/** Changes nested deeper are reported at their container (keeps consumers' recursion bounded). */
const MAX_DEPTH = 500;

// ---------------------------------------------------------------- hashing

/** Formats whose keys and strings keep their quotes in the source (DataTree's JSON family). */
const QUOTED = new Set<string>(['json', 'jsonc', 'json5', 'jsonl', 'xlsx']);

const TAG_KEY = 0x2d;
const TAG_STR = 0x1b;
const TAG_NUM = 0x3f;

interface Side {
  tree: DataTree;
  /** Two 32-bit hash lanes per node. */
  h1: Int32Array;
  h2: Int32Array;
  quoted: boolean;
  /** CSV header key hashes, two lanes per column. */
  cols: Int32Array | null;
}

// Hash results travel through module-level scratch values to keep the hot loops allocation-free.
let H1 = 0;
let H2 = 0;
let backslash = false;

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** Hashes s[start, end) into H1/H2 and notes whether it contains a backslash. */
function hashChars(s: string, start: number, end: number, tag: number): void {
  let a = 0x811c9dc5 ^ tag;
  let b = 0x050c5d1f ^ Math.imul(tag, 0x9e3779b1);
  let slash = false;
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) slash = true;
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  const n = end - start;
  H1 = fmix(a ^ Math.imul(n, 0x9e3779b1));
  H2 = fmix((b + Math.imul(n, 0x85ebca77)) | 0);
  backslash = slash;
}

function hashNumber(v: number): void {
  if (v !== v) {
    H1 = 0x7ff80001;
    H2 = 0x2b992ddf;
    return;
  }
  F64[0] = v === 0 ? 0 : v; // -0 equals 0
  const lo = U32[0] | 0;
  const hi = U32[1] | 0;
  H1 = fmix(lo ^ Math.imul(hi, 0x9e3779b1) ^ 0x3c6ef372);
  H2 = fmix(hi ^ Math.imul(lo, 0x85ebca77) ^ 0x1b873593);
}

const POW10 = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];

/**
 * Value of a number node: a number, canonical digits for integers beyond
 * double precision, or the literal itself when it is no number at all.
 * Plain decimals are read in place; other spellings (hex, `1_000`,
 * Infinity…) go through DataTree.value.
 */
function numberOf(tree: DataTree, id: number): number | string {
  const synth = tree.flags[id] & F_VAL_SYNTH;
  const s = synth ? tree.synthVals.get(id) ?? '' : tree.text;
  const a = synth ? 0 : tree.valPos[id];
  const b = synth ? s.length : tree.valEnd[id];
  let i = a;
  let c = s.charCodeAt(i);
  const neg = c === 45;
  if (neg || c === 43) c = s.charCodeAt(++i);
  const first = i;
  let m = 0;
  let frac = -1;
  for (; i < b; c = s.charCodeAt(++i)) {
    if (c >= 48 && c <= 57) {
      m = m * 10 + (c - 48);
      if (frac >= 0) frac++;
    } else if (c === 46 && frac < 0) frac = 0;
    else break;
  }
  const digits = i - first - (frac >= 0 ? 1 : 0);
  if (digits > 0 && i === b) {
    // Up to 15 digits m and 10^k are exact, so m / 10^k is the correctly rounded value.
    if (digits <= 15) return neg ? -(frac > 0 ? m / POW10[frac] : m) : frac > 0 ? m / POW10[frac] : m;
    const v = Number(s.slice(a, b));
    return frac < 0 && !Number.isSafeInteger(v) ? (neg ? '-' : '') + s.slice(first, b).replace(/^0+(?=\d)/, '') : v;
  }
  if (digits > 0 && (c === 101 || c === 69)) {
    c = s.charCodeAt(++i);
    if (c === 43 || c === 45) c = s.charCodeAt(++i);
    const e = i;
    while (i < b && c >= 48 && c <= 57) c = s.charCodeAt(++i);
    if (i === b && i > e) return Number(s.slice(a, b));
  }
  const v = tree.value(id);
  return typeof v === 'number' ? v : String(v);
}

/** Hash of a primitive's value into H1/H2. */
function hashValue(side: Side, id: number): void {
  const tree = side.tree;
  const f = tree.flags[id];
  switch (tree.type[id]) {
    case T_STRING: {
      if (f & (F_VAL_SYNTH | F_ESCAPED)) {
        const v = tree.stringValue(id);
        hashChars(v, 0, v.length, TAG_STR);
        return;
      }
      // The source text is the value, minus JSON quotes.
      const text = tree.text;
      let s = tree.valPos[id];
      let e = tree.valEnd[id];
      if (side.quoted) {
        const q = text.charCodeAt(s);
        if (q === 34 || q === 39) {
          s++;
          if (e > s && text.charCodeAt(e - 1) === q) e--;
        }
      }
      hashChars(text, s, e, TAG_STR);
      return;
    }
    case T_NUMBER: {
      const v = numberOf(tree, id);
      if (typeof v === 'string') hashChars(v, 0, v.length, TAG_NUM);
      else hashNumber(v);
      return;
    }
    case T_BOOLEAN: {
      const yes = side.quoted && !(f & F_VAL_SYNTH) ? tree.text.charCodeAt(tree.valPos[id]) === 116 : tree.value(id) === true;
      H1 = yes ? 0x2c1b3c6d : 0x7a3c2d1b;
      H2 = yes ? 0x297a2d39 : 0x6c8e9cf5;
      return;
    }
    default:
      H1 = 0x5f356495;
      H2 = 0x3a7c4ec1;
  }
}

/** Hash of a property name (decoded, as DataTree.key returns it) into H1/H2. */
function keyHash(side: Side, id: number): void {
  const tree = side.tree;
  const f = tree.flags[id];
  if (!(f & (F_KEY_SYNTH | F_COLUMN_KEY | F_TEXT | F_ATTR))) {
    const text = tree.text;
    let s = tree.keyPos[id];
    let e = tree.keyEnd[id];
    if (side.quoted) {
      const q = text.charCodeAt(s);
      if (q === 34 || q === 39) {
        s++;
        if (e > s && text.charCodeAt(e - 1) === q) e--;
      }
    }
    hashChars(text, s, e, TAG_KEY);
    if (!side.quoted || !backslash) return; // escaped JSON keys are decoded below
  } else if ((f & (F_KEY_SYNTH | F_COLUMN_KEY)) === F_COLUMN_KEY && side.cols) {
    const k = tree.keyPos[id] * 2;
    if (k + 1 < side.cols.length) {
      H1 = side.cols[k];
      H2 = side.cols[k + 1];
      return;
    }
  }
  const k = String(tree.key(id));
  hashChars(k, 0, k.length, TAG_KEY);
}

/**
 * Content hashes for every node, children before parents (pre-order ids in
 * reverse). Containers fold their children into their own slots as they are
 * visited: arrays in order (as multisets when `unordered`), objects as an
 * order-independent sum of key/value hashes. XML elements keep sibling
 * order, which is significant there.
 */
function hashTree(tree: DataTree, unordered: boolean): Side {
  const side: Side = { tree, h1: new Int32Array(Math.max(1, tree.count)), h2: new Int32Array(Math.max(1, tree.count)), quoted: QUOTED.has(tree.format), cols: null };
  if (tree.columns) {
    const cols = (side.cols = new Int32Array(tree.columns.length * 2));
    tree.columns.forEach((name, k) => {
      hashChars(name, 0, name.length, TAG_KEY);
      cols[2 * k] = H1;
      cols[2 * k + 1] = H2;
    });
  }
  if (!tree.count) return side;
  const { type, parent, childCount } = tree;
  const { h1, h2 } = side;
  const root = tree.root;
  const ordered = tree.xmlLike;
  for (let i = root + tree.size[root] - 1; i >= root; i--) {
    const t = type[i];
    let a: number;
    let b: number;
    if (t === T_OBJECT || t === T_ARRAY) {
      a = fmix(h1[i] ^ Math.imul(childCount[i], 0xcc9e2d51) ^ (t === T_OBJECT ? 0x6b43a9b5 : 0x2f8e1b37));
      b = fmix((h2[i] + Math.imul(childCount[i], 0x1b873593) + (t === T_OBJECT ? 0x3c6ef372 : 0x5851f42d)) | 0);
    } else {
      hashValue(side, i);
      a = H1;
      b = H2;
    }
    h1[i] = a;
    h2[i] = b;
    if (i === root) break;
    const p = parent[i];
    let sum = unordered;
    if (type[p] !== T_ARRAY) {
      keyHash(side, i);
      a = fmix((Math.imul(H1, 0xcc9e2d51) + a) | 0);
      b = fmix(Math.imul(H2, 0x1b873593) ^ b);
      sum = !ordered;
    }
    if (sum) {
      h1[p] = (h1[p] + a) | 0;
      h2[p] = (h2[p] + b) | 0;
    } else {
      h1[p] = Math.imul(((h1[p] << 5) | (h1[p] >>> 27)) ^ a, 0x9e3779b1);
      h2[p] = Math.imul(((h2[p] << 11) | (h2[p] >>> 21)) ^ b, 0x85ebca77);
    }
  }
  return side;
}

/** Both lanes as one 53-bit number, usable as a Map key. */
function h53(side: Side, id: number): number {
  return (side.h1[id] >>> 0) * 2097152 + (side.h2[id] >>> 11);
}

function hashesOf(side: Side, ids: Int32Array): Float64Array {
  const out = new Float64Array(ids.length);
  for (let k = 0; k < ids.length; k++) out[k] = h53(side, ids[k]);
  return out;
}

function keyHashesOf(side: Side, ids: Int32Array): Float64Array {
  const out = new Float64Array(ids.length);
  for (let k = 0; k < ids.length; k++) {
    keyHash(side, ids[k]);
    out[k] = (H1 >>> 0) * 2097152 + (H2 >>> 11);
  }
  return out;
}

function childIds(tree: DataTree, id: number): Int32Array {
  const out = new Int32Array(tree.childCount[id]);
  for (let k = 0, c = id + 1; k < out.length; k++, c += tree.size[c]) out[k] = c;
  return out;
}

// ---------------------------------------------------------------- sequence matching

/** Marks the members of one longest strictly increasing subsequence. */
function lisMask(seq: ArrayLike<number>): Uint8Array {
  const n = seq.length;
  const tails = new Int32Array(n);
  const prev = new Int32Array(n);
  let len = 0;
  for (let i = 0; i < n; i++) {
    const v = seq[i];
    let lo = 0;
    let hi = len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (seq[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
    if (lo === len) len++;
  }
  const mask = new Uint8Array(n);
  for (let k = len > 0 ? tails[len - 1] : -1; k >= 0; k = prev[k]) mask[k] = 1;
  return mask;
}

/**
 * Matches equal values of A and B in order: an exact LCS for ranges up to
 * LCS_CELLS, otherwise split at values unique on both sides (patience diff),
 * falling back to position for ranges without such anchors. Returns the
 * matched index in B for every index in A, or -1.
 */
function lcsMatch(A: Float64Array, B: Float64Array): Int32Array {
  const match = new Int32Array(A.length).fill(-1);
  const work = [0, A.length, 0, B.length];
  while (work.length) {
    let b1 = work.pop()!;
    let b0 = work.pop()!;
    let a1 = work.pop()!;
    let a0 = work.pop()!;
    while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) match[a0++] = b0++;
    while (a0 < a1 && b0 < b1 && A[a1 - 1] === B[b1 - 1]) match[--a1] = --b1;
    if (a0 === a1 || b0 === b1) continue;
    if ((a1 - a0) * (b1 - b0) <= LCS_CELLS) {
      lcsTable(A, B, a0, a1, b0, b1, match);
      continue;
    }
    const anchors = uniqueAnchors(A, B, a0, a1, b0, b1);
    if (!anchors.length) {
      for (let k = 0; a0 + k < a1 && b0 + k < b1; k++) if (A[a0 + k] === B[b0 + k]) match[a0 + k] = b0 + k;
      continue;
    }
    for (let k = 0; k < anchors.length; k += 2) {
      const i = anchors[k];
      const j = anchors[k + 1];
      match[i] = j;
      if (i > a0 && j > b0) work.push(a0, i, b0, j);
      a0 = i + 1;
      b0 = j + 1;
    }
    if (a1 > a0 && b1 > b0) work.push(a0, a1, b0, b1);
  }
  return match;
}

function lcsTable(A: Float64Array, B: Float64Array, a0: number, a1: number, b0: number, b1: number, match: Int32Array): void {
  const n = a1 - a0;
  const m = b1 - b0;
  const w = m + 1;
  // Suffix LCS lengths; min(n, m) <= sqrt(LCS_CELLS) fits 16 bits.
  const T = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const v = A[a0 + i];
    const row = i * w;
    for (let j = m - 1; j >= 0; j--) {
      T[row + j] = v === B[b0 + j] ? T[row + w + j + 1] + 1 : Math.max(T[row + w + j], T[row + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (A[a0 + i] === B[b0 + j]) match[a0 + i++] = b0 + j++;
    else if (T[(i + 1) * w + j] >= T[i * w + j + 1]) i++;
    else j++;
  }
}

/** Pairs of values that occur exactly once in both ranges, reduced to an increasing chain. */
function uniqueAnchors(A: Float64Array, B: Float64Array, a0: number, a1: number, b0: number, b1: number): number[] {
  const inA = new Map<number, number>();
  for (let i = a0; i < a1; i++) inA.set(A[i], inA.has(A[i]) ? -1 : i);
  const inB = new Map<number, number>();
  for (let j = b0; j < b1; j++) if ((inA.get(B[j]) ?? -1) >= 0) inB.set(B[j], inB.has(B[j]) ? -1 : j);
  const ci: number[] = [];
  const cj: number[] = [];
  for (let i = a0; i < a1; i++) {
    const j = inA.get(A[i]) === i ? inB.get(A[i]) : undefined;
    if (j !== undefined && j >= 0) {
      ci.push(i);
      cj.push(j);
    }
  }
  const keep = lisMask(cj);
  const out: number[] = [];
  for (let k = 0; k < ci.length; k++) if (keep[k]) out.push(ci[k], cj[k]);
  return out;
}

function pick(h: Float64Array, idx: ArrayLike<number>): Float64Array {
  const out = new Float64Array(idx.length);
  for (let k = 0; k < idx.length; k++) out[k] = h[idx[k]];
  return out;
}

function range(from: number, to: number): Int32Array {
  const out = new Int32Array(Math.max(0, to - from));
  for (let k = 0; k < out.length; k++) out[k] = from + k;
  return out;
}

// ---------------------------------------------------------------- diff

const OP_PAIR = 0;
const OP_ADD = 1;
const OP_REMOVE = 2;
const OP_MOVE = 3;

/** One aligned element: indices into the compared sequences (-1 when absent). */
interface Step {
  k: number;
  i: number;
  j: number;
  /** Output order (right-side position). */
  pos: number;
}

interface Alignment {
  steps: Step[];
  same: number;
}

/** A child to report or descend into. */
interface Op {
  k: number;
  l: number;
  r: number;
  /** Keys on each side; for XML, the index among same-named siblings (or -1). */
  kl: string | number;
  kr: string | number;
  xl: number;
  xr: number;
  pos: number;
}

interface Frame {
  entry: DiffEntry;
  /** Path of the container in the left document. */
  lpath: string;
  ops: Op[];
  next: number;
  same: number;
  depth: number;
}

/** What gap pairing compares: key and key/value hashes of objects, element hashes of arrays. */
interface Sig {
  keys: Set<number> | null;
  items: Set<number>;
  n: number;
}

function op(k: number, l: number, r: number, kl: string | number, kr: string | number, pos: number): Op {
  return { k, l, r, kl, kr, xl: -1, xr: -1, pos };
}

function seg(key: string | number, index: number): string {
  return index >= 0 ? `${pathSegment(key)}[${index}]` : pathSegment(key);
}

const byPos = (a: { pos: number }, b: { pos: number }) => a.pos - b.pos;

class Differ {
  readonly stats: DiffStats = { added: 0, removed: 0, changed: 0, moved: 0, typeChanged: 0 };
  truncated = false;
  /** A change sat deeper than MAX_DEPTH. */
  deep = false;
  private count = 0;
  private readonly max: number;
  private readonly tol: number;
  private readonly mode: 'auto' | 'index' | 'lcs';
  private readonly unordered: boolean;
  /** Id key candidates, two hash lanes each. */
  private readonly cands: Int32Array;

  constructor(
    private readonly L: Side,
    private readonly R: Side,
    o: DiffOptions,
  ) {
    this.max = o.maxEntries ?? 20_000;
    this.tol = o.numericTolerance ?? 0;
    this.mode = o.arrays ?? 'auto';
    this.unordered = !!o.ignoreOrder;
    let keys = o.idKeys ?? DEFAULT_ID_KEYS;
    if (L.tree.xmlLike || R.tree.xmlLike) keys = [...keys, ...keys.map((k) => '@' + k)];
    this.cands = new Int32Array(keys.length * 2);
    keys.forEach((k, c) => {
      hashChars(k, 0, k.length, TAG_KEY);
      this.cands[2 * c] = H1;
      this.cands[2 * c + 1] = H2;
    });
  }

  run(): DiffEntry {
    const l = this.L.tree.root;
    const r = this.R.tree.root;
    const root: DiffEntry = { kind: 'same', path: '$', left: l, right: r, key: null };
    if (this.eq(l, r)) return root;
    const tl = this.L.tree.type[l];
    if (tl !== this.R.tree.type[r]) {
      root.kind = 'type';
      this.stats.typeChanged++;
      return root;
    }
    if (tl !== T_OBJECT && tl !== T_ARRAY) {
      if (!this.leafEqual(l, r)) {
        root.kind = 'changed';
        this.stats.changed++;
      }
      return root;
    }
    root.kind = 'changed';
    // Explicit stack: a frame resumes after each child frame closes, so entries stay in order.
    const stack: Frame[] = [this.frame(root, '$', 0)];
    while (stack.length) {
      const f = stack[stack.length - 1];
      const o = this.truncated ? undefined : f.ops[f.next++];
      if (o === undefined) {
        stack.pop();
        this.close(f, stack[stack.length - 1]);
        continue;
      }
      const child = this.apply(f, o);
      if (child) stack.push(child);
    }
    if (!root.children && !this.truncated) root.kind = 'same'; // differences were within tolerance
    return root;
  }

  private eq(l: number, r: number): boolean {
    return this.L.h1[l] === this.R.h1[r] && this.L.h2[l] === this.R.h2[r];
  }

  /** Primitives of the same type whose hashes differ: equal only within the numeric tolerance. */
  private leafEqual(l: number, r: number): boolean {
    if (!(this.tol > 0) || this.L.tree.type[l] !== T_NUMBER) return false;
    return Math.abs(Number(numberOf(this.L.tree, l)) - Number(numberOf(this.R.tree, r))) <= this.tol;
  }

  private reserve(): boolean {
    if (this.count >= this.max) {
      this.truncated = true;
      return false;
    }
    this.count++;
    return true;
  }

  private emit(f: Frame, e: DiffEntry): boolean {
    if (!this.reserve()) return false;
    (f.entry.children ??= []).push(e);
    return true;
  }

  private frame(entry: DiffEntry, lpath: string, depth: number): Frame {
    const f: Frame = { entry, lpath, ops: [], next: 0, same: 0, depth };
    if (this.L.tree.type[entry.left] === T_OBJECT) this.alignObject(f);
    else this.alignArray(f);
    return f;
  }

  private close(f: Frame, parent: Frame | undefined): void {
    const e = f.entry;
    if (e.children && f.same) e.unchanged = f.same;
    if (!parent) return;
    if (e.children || e.kind === 'moved') (parent.entry.children ??= []).push(e);
    else if (!this.truncated) {
      parent.same++;
      this.count--;
    }
  }

  /** Reports one op; returns a frame when it needs to descend. */
  private apply(f: Frame, o: Op): Frame | null {
    const stats = this.stats;
    if (o.k === OP_ADD) {
      if (this.emit(f, { kind: 'added', path: f.entry.path + seg(o.kr, o.xr), left: -1, right: o.r, key: o.kr })) stats.added++;
      return null;
    }
    if (o.k === OP_REMOVE) {
      if (this.emit(f, { kind: 'removed', path: f.lpath + seg(o.kl, o.xl), left: o.l, right: -1, key: o.kl })) stats.removed++;
      return null;
    }
    const { l, r } = o;
    const moved = o.k === OP_MOVE;
    const path = f.entry.path + seg(o.kr, o.xr);
    const tl = this.L.tree.type[l];
    const tr = this.R.tree.type[r];
    const container = tl === T_OBJECT || tl === T_ARRAY;
    if (this.eq(l, r) || (tl === tr && !container && this.leafEqual(l, r))) {
      if (!moved) f.same++;
      else if (this.emit(f, { kind: 'moved', path, left: l, right: r, key: o.kr })) stats.moved++;
      return null;
    }
    if (tl !== tr) {
      if (this.emit(f, { kind: 'type', path, left: l, right: r, key: o.kr })) stats.typeChanged++;
      return null;
    }
    const e: DiffEntry = { kind: moved && container ? 'moved' : 'changed', path, left: l, right: r, key: o.kr };
    if (!container || f.depth + 1 >= MAX_DEPTH) {
      if (container) this.deep = true; // too deep to detail: report the container itself
      if (this.emit(f, e)) stats[e.kind === 'moved' ? 'moved' : 'changed']++;
      return null;
    }
    if (!this.reserve()) return null;
    if (moved) stats.moved++;
    return this.frame(e, f.lpath + seg(o.kl, o.xl), f.depth + 1);
  }

  private alignArray(f: Frame): void {
    const A = childIds(this.L.tree, f.entry.left);
    const B = childIds(this.R.tree, f.entry.right);
    const { steps, same } = this.alignSeq(A, B);
    f.same = same;
    for (const s of steps) f.ops.push(op(s.k, s.i >= 0 ? A[s.i] : -1, s.j >= 0 ? B[s.j] : -1, s.i, s.j, s.pos));
    f.ops.sort(byPos);
  }

  /** Objects match by key; keys repeated among siblings (XML elements) align like arrays. */
  private alignObject(f: Frame): void {
    const lt = this.L.tree;
    const rt = this.R.tree;
    const A = childIds(lt, f.entry.left);
    const B = childIds(rt, f.entry.right);
    const n = A.length;
    const m = B.length;
    const ka = keyHashesOf(this.L, A);
    const kb = keyHashesOf(this.R, B);
    const ops = f.ops;
    let sameKeys = n === m && !lt.xmlLike && !rt.xmlLike;
    for (let k = 0; sameKeys && k < n; k++) sameKeys = ka[k] === kb[k];
    if (sameKeys) {
      for (let k = 0; k < n; k++) {
        if (this.eq(A[k], B[k])) f.same++;
        else {
          const key = String(rt.key(B[k]));
          ops.push(op(OP_PAIR, A[k], B[k], key, key, k));
        }
      }
      return;
    }
    const groups = new Map<number, number>();
    const ga: number[][] = [];
    const gb: number[][] = [];
    const group = (h: number) => {
      let g = groups.get(h);
      if (g === undefined) {
        groups.set(h, (g = ga.length));
        ga.push([]);
        gb.push([]);
      }
      return g;
    };
    for (let k = 0; k < n; k++) ga[group(ka[k])].push(k);
    for (let q = 0; q < m; q++) gb[group(kb[q])].push(q);
    for (let g = 0; g < ga.length; g++) {
      const la = ga[g];
      const lb = gb[g];
      if (la.length <= 1 && lb.length <= 1) {
        if (la.length && lb.length) {
          const l = A[la[0]];
          const r = B[lb[0]];
          if (this.eq(l, r)) f.same++;
          else {
            const key = String(rt.key(r));
            ops.push(op(OP_PAIR, l, r, key, key, lb[0]));
          }
        } else if (la.length) ops.push(op(OP_REMOVE, A[la[0]], -1, String(lt.key(A[la[0]])), '', m + la[0]));
        else ops.push(op(OP_ADD, -1, B[lb[0]], '', String(rt.key(B[lb[0]])), lb[0]));
        continue;
      }
      const sa = Int32Array.from(la, (k) => A[k]);
      const sb = Int32Array.from(lb, (q) => B[q]);
      const { steps, same } = this.alignSeq(sa, sb);
      f.same += same;
      const name = String(sa.length ? lt.key(sa[0]) : rt.key(sb[0]));
      for (const s of steps) {
        const o = op(s.k, s.i >= 0 ? sa[s.i] : -1, s.j >= 0 ? sb[s.j] : -1, name, name, s.j >= 0 ? lb[s.j] : m + la[s.i]);
        // XML paths index same-named elements (see DataTree.path).
        if (s.i >= 0 && lt.xmlLike && sa.length > 1 && lt.flags[o.l] & F_ELEMENT) o.xl = s.i;
        if (s.j >= 0 && rt.xmlLike && sb.length > 1 && rt.flags[o.r] & F_ELEMENT) o.xr = s.j;
        ops.push(o);
      }
    }
    ops.sort(byPos);
  }

  /** Aligns two element sequences (node ids) by the configured array mode. */
  private alignSeq(A: Int32Array, B: Int32Array): Alignment {
    const ha = hashesOf(this.L, A);
    const hb = hashesOf(this.R, B);
    const n = A.length;
    const m = B.length;
    const index = this.mode === 'index' && !this.unordered;
    // Equal leading (and, unless matching by index, trailing) elements are unchanged.
    let lo = 0;
    while (lo < n && lo < m && ha[lo] === hb[lo]) lo++;
    let an = n;
    let bn = m;
    while (!index && an > lo && bn > lo && ha[an - 1] === hb[bn - 1]) {
      an--;
      bn--;
    }
    const res: Alignment = { steps: [], same: lo + n - an };
    if (index) {
      for (let k = lo; k < Math.max(an, bn); k++) {
        if (k >= an) res.steps.push({ k: OP_ADD, i: -1, j: k, pos: k });
        else if (k >= bn) res.steps.push({ k: OP_REMOVE, i: k, j: -1, pos: k });
        else if (ha[k] === hb[k]) res.same++;
        else res.steps.push({ k: OP_PAIR, i: k, j: k, pos: k });
      }
      return res;
    }
    let IA = range(lo, an);
    let IB = range(lo, bn);
    if (this.mode === 'auto' && IA.length && IB.length) {
      const ids = this.ids(A, B, IA, IB);
      if (ids) [IA, IB] = this.matchIds(ids[0], ids[1], IA, IB, ha, hb, res, m);
    }
    if (this.unordered) this.matchUnordered(A, B, ha, hb, IA, IB, res);
    else this.matchLcs(A, B, ha, hb, IA, IB, res);
    return res;
  }

  /** Per-element id hashes (NaN when absent) for the first id key that most elements carry, unique on both sides. */
  private ids(A: Int32Array, B: Int32Array, IA: Int32Array, IB: Int32Array): [Float64Array, Float64Array] | null {
    const sa = this.sampleIds(this.L, A, IA);
    const sb = this.sampleIds(this.R, B, IB);
    for (let c = 0, tries = 0; c < sa.length && tries < 2; c++) {
      if (sa[c] < ID_COVERAGE || sb[c] < ID_COVERAGE) continue;
      tries++;
      const ia = this.idValues(this.L, A, IA, c);
      const ib = ia && this.idValues(this.R, B, IB, c);
      if (ia && ib) return [ia, ib];
    }
    return null;
  }

  /** Share of (about 32) sampled elements that carry each candidate key with a string or number value. */
  private sampleIds(side: Side, ids: Int32Array, I: Int32Array): Float64Array {
    const tree = side.tree;
    const nc = this.cands.length >> 1;
    const out = new Float64Array(nc);
    const step = Math.max(1, Math.floor(I.length / 32));
    let taken = 0;
    for (let k = 0; k < I.length; k += step, taken++) {
      const e = ids[I[k]];
      if (tree.type[e] !== T_OBJECT) continue;
      for (let c = e + 1, left = tree.childCount[e]; left > 0; left--, c += tree.size[c]) {
        if (tree.type[c] !== T_STRING && tree.type[c] !== T_NUMBER) continue;
        keyHash(side, c);
        for (let x = 0; x < nc; x++) {
          if (this.cands[2 * x] === H1 && this.cands[2 * x + 1] === H2) {
            out[x]++;
            break;
          }
        }
      }
    }
    for (let x = 0; x < nc; x++) out[x] /= Math.max(1, taken);
    return out;
  }

  private idValues(side: Side, ids: Int32Array, I: Int32Array, c: number): Float64Array | null {
    const tree = side.tree;
    const c1 = this.cands[2 * c];
    const c2 = this.cands[2 * c + 1];
    const out = new Float64Array(I.length).fill(NaN);
    const seen = new Set<number>();
    for (let k = 0; k < I.length; k++) {
      const e = ids[I[k]];
      if (tree.type[e] !== T_OBJECT) continue;
      for (let ch = e + 1, left = tree.childCount[e]; left > 0; left--, ch += tree.size[ch]) {
        if (tree.type[ch] !== T_STRING && tree.type[ch] !== T_NUMBER) continue;
        keyHash(side, ch);
        if (H1 !== c1 || H2 !== c2) continue;
        const v = h53(side, ch);
        if (seen.has(v)) return null;
        seen.add(v);
        out[k] = v;
        break;
      }
    }
    return seen.size >= I.length * ID_COVERAGE ? out : null;
  }

  /**
   * Matches elements by id. Matches out of relative order (outside the longest
   * increasing run) are moves. Returns the elements without an id.
   */
  private matchIds(ia: Float64Array, ib: Float64Array, IA: Int32Array, IB: Int32Array, ha: Float64Array, hb: Float64Array, res: Alignment, m: number): [Int32Array, Int32Array] {
    const at = new Map<number, number>();
    for (let k = 0; k < IA.length; k++) if (ia[k] === ia[k]) at.set(ia[k], k);
    const used = new Uint8Array(IA.length);
    const pk: number[] = [];
    const pq: number[] = [];
    const restA: number[] = [];
    const restB: number[] = [];
    for (let q = 0; q < IB.length; q++) {
      const k = ib[q] === ib[q] ? at.get(ib[q]) : -1;
      if (k === -1) restB.push(IB[q]);
      else if (k === undefined) res.steps.push({ k: OP_ADD, i: -1, j: IB[q], pos: IB[q] });
      else {
        used[k] = 1;
        pk.push(k);
        pq.push(q);
      }
    }
    for (let k = 0; k < IA.length; k++) {
      if (ia[k] !== ia[k]) restA.push(IA[k]);
      else if (!used[k]) res.steps.push({ k: OP_REMOVE, i: IA[k], j: -1, pos: m + IA[k] });
    }
    const inOrder = this.unordered ? null : lisMask(pk);
    for (let t = 0; t < pk.length; t++) {
      const i = IA[pk[t]];
      const j = IB[pq[t]];
      const moved = inOrder !== null && !inOrder[t];
      if (!moved && ha[i] === hb[j]) res.same++;
      else res.steps.push({ k: moved ? OP_MOVE : OP_PAIR, i, j, pos: j });
    }
    return [Int32Array.from(restA), Int32Array.from(restB)];
  }

  /** LCS on element hashes; leftovers equal to one on the other side are moves, the rest pair up per gap. */
  private matchLcs(A: Int32Array, B: Int32Array, ha: Float64Array, hb: Float64Array, IA: Int32Array, IB: Int32Array, res: Alignment): void {
    const n = IA.length;
    const m = IB.length;
    if (!n || !m) {
      this.pairGap(A, B, Array.from(IA), Array.from(IB), B.length, res);
      return;
    }
    const SA = pick(ha, IA);
    const SB = pick(hb, IB);
    const match = lcsMatch(SA, SB);
    const usedB = new Uint8Array(m);
    let matched = 0;
    for (let k = 0; k < n; k++) {
      if (match[k] >= 0) {
        usedB[match[k]] = 1;
        matched++;
      }
    }
    res.same += matched;
    const movedA = new Uint8Array(n);
    const movedB = new Uint8Array(m);
    if (matched < n && matched < m) {
      const pool = new Map<number, number[]>();
      for (let k = n - 1; k >= 0; k--) {
        if (match[k] >= 0) continue;
        const list = pool.get(SA[k]);
        if (list) list.push(k);
        else pool.set(SA[k], [k]);
      }
      for (let q = 0; q < m; q++) {
        const k = usedB[q] ? undefined : pool.get(SB[q])?.pop();
        if (k === undefined) continue;
        movedA[k] = movedB[q] = 1;
        res.steps.push({ k: OP_MOVE, i: IA[k], j: IB[q], pos: IB[q] });
      }
    }
    for (let k = 0, k0 = 0, q0 = 0; k <= n; k++) {
      const q = k < n ? match[k] : m;
      if (q < 0) continue;
      if (k > k0 || q > q0) {
        const gl: number[] = [];
        const gr: number[] = [];
        for (let t = k0; t < k; t++) if (!movedA[t]) gl.push(IA[t]);
        for (let u = q0; u < q; u++) if (!movedB[u]) gr.push(IB[u]);
        if (gl.length || gr.length) this.pairGap(A, B, gl, gr, q < m ? IB[q] : B.length, res);
      }
      k0 = k + 1;
      q0 = q + 1;
    }
  }

  /**
   * Pairs the unmatched elements of one gap (indices into A and B): by
   * position when both sides have as many, by best total similarity when the
   * gap is small; the rest are removed and added. `end` is the right-side
   * position after the gap.
   */
  private pairGap(A: Int32Array, B: Int32Array, gl: number[], gr: number[], end: number, res: Alignment): void {
    const a = gl.length;
    const b = gr.length;
    const steps = res.steps;
    const before = (u: number) => (u < b ? gr[u] : end) - 0.5;
    if (a === b) {
      for (let t = 0; t < a; t++) steps.push({ k: OP_PAIR, i: gl[t], j: gr[t], pos: gr[t] });
      return;
    }
    if (!a || !b || a * b > PAIR_CELLS) {
      for (const i of gl) steps.push({ k: OP_REMOVE, i, j: -1, pos: before(0) });
      for (const j of gr) steps.push({ k: OP_ADD, i: -1, j, pos: j });
      return;
    }
    const sim = this.similarities(A, B, gl, gr);
    const w = b + 1;
    const S = new Float64Array((a + 1) * w);
    for (let t = a - 1; t >= 0; t--) {
      for (let u = b - 1; u >= 0; u--) {
        const s = sim[t * b + u];
        const skip = Math.max(S[(t + 1) * w + u], S[t * w + u + 1]);
        S[t * w + u] = s >= PAIR_MIN ? Math.max(skip, S[(t + 1) * w + u + 1] + s) : skip;
      }
    }
    let t = 0;
    let u = 0;
    while (t < a && u < b) {
      const s = sim[t * b + u];
      if (s >= PAIR_MIN && S[t * w + u] === S[(t + 1) * w + u + 1] + s) {
        steps.push({ k: OP_PAIR, i: gl[t], j: gr[u], pos: gr[u] });
        t++;
        u++;
      } else if (S[t * w + u] === S[(t + 1) * w + u]) steps.push({ k: OP_REMOVE, i: gl[t++], j: -1, pos: before(u) });
      else steps.push({ k: OP_ADD, i: -1, j: gr[u], pos: gr[u++] });
    }
    for (; t < a; t++) steps.push({ k: OP_REMOVE, i: gl[t], j: -1, pos: before(b) });
    for (; u < b; u++) steps.push({ k: OP_ADD, i: -1, j: gr[u], pos: gr[u] });
  }

  /** Multiset matching by hash; leftovers pair greedily by similarity. */
  private matchUnordered(A: Int32Array, B: Int32Array, ha: Float64Array, hb: Float64Array, IA: Int32Array, IB: Int32Array, res: Alignment): void {
    const pool = new Map<number, number[]>();
    for (let k = IA.length - 1; k >= 0; k--) {
      const list = pool.get(ha[IA[k]]);
      if (list) list.push(IA[k]);
      else pool.set(ha[IA[k]], [IA[k]]);
    }
    const gr: number[] = [];
    for (const j of IB) {
      if (pool.get(hb[j])?.pop() !== undefined) res.same++;
      else gr.push(j);
    }
    const gl: number[] = [];
    for (const list of pool.values()) gl.push(...list);
    gl.sort((x, y) => x - y);
    const a = gl.length;
    const b = gr.length;
    const doneA = new Uint8Array(a);
    const doneB = new Uint8Array(b);
    if (a && b && a * b <= PAIR_CELLS) {
      const sim = this.similarities(A, B, gl, gr);
      const order: number[] = [];
      for (let c = 0; c < sim.length; c++) if (sim[c] >= PAIR_UNORDERED) order.push(c);
      order.sort((x, y) => sim[y] - sim[x] || x - y);
      for (const c of order) {
        const t = (c / b) | 0;
        const u = c % b;
        if (doneA[t] || doneB[u]) continue;
        doneA[t] = doneB[u] = 1;
        res.steps.push({ k: OP_PAIR, i: gl[t], j: gr[u], pos: gr[u] });
      }
    }
    for (let u = 0; u < b; u++) if (!doneB[u]) res.steps.push({ k: OP_ADD, i: -1, j: gr[u], pos: gr[u] });
    for (let t = 0; t < a; t++) if (!doneA[t]) res.steps.push({ k: OP_REMOVE, i: gl[t], j: -1, pos: B.length + gl[t] });
  }

  /** Similarity (0..1) of every gl × gr pair, row-major. */
  private similarities(A: Int32Array, B: Int32Array, gl: number[], gr: number[]): Float64Array {
    const sigsB = gr.map((j) => this.sig(this.R, B[j]));
    const out = new Float64Array(gl.length * gr.length);
    gl.forEach((i, t) => {
      const l = A[i];
      const sl = this.sig(this.L, l);
      gr.forEach((j, u) => {
        const r = B[j];
        const tl = this.L.tree.type[l];
        if (tl !== this.R.tree.type[r]) return;
        if (tl !== T_OBJECT && tl !== T_ARRAY) {
          out[t * gr.length + u] = this.eq(l, r) || this.leafEqual(l, r) ? 1 : 0.5;
          return;
        }
        const sr = sigsB[u];
        const n = Math.max(sl.n, sr.n);
        let items = 0;
        let keys = 0;
        for (const v of sr.items) if (sl.items.has(v)) items++;
        if (sl.keys && sr.keys) for (const k of sr.keys) if (sl.keys.has(k)) keys++;
        out[t * gr.length + u] = !n ? 1 : sl.keys ? (2 * items + keys) / (3 * n) : items / n;
      });
    });
    return out;
  }

  private sig(side: Side, id: number): Sig {
    const tree = side.tree;
    const items = new Set<number>();
    const isObject = tree.type[id] === T_OBJECT;
    const keys = isObject ? new Set<number>() : null;
    if (tree.isContainer(id)) {
      for (let c = id + 1, left = tree.childCount[id]; left > 0; left--, c += tree.size[c]) {
        if (!keys) {
          items.add(h53(side, c));
          continue;
        }
        keyHash(side, c);
        keys.add((H1 >>> 0) * 2097152 + (H2 >>> 11));
        items.add(((H1 ^ Math.imul(side.h1[c], 0x9e3779b1)) >>> 0) * 2097152 + (((H2 + side.h2[c]) | 0) >>> 11));
      }
    }
    return { keys, items, n: tree.childCount[id] };
  }
}

/**
 * Structural diff of two parsed documents. Unchanged subtrees are collapsed
 * into `unchanged` counts; entries reference node ids in both trees.
 */
export function diffTrees(left: DataTree, right: DataTree, options: DiffOptions = {}): DiffResult {
  const started = now();
  const unordered = !!options.ignoreOrder;
  const d = new Differ(hashTree(left, unordered), hashTree(right, unordered), options);
  const root = d.run();
  return { root, stats: d.stats, truncated: d.truncated || d.deep, ms: now() - started };
}

// ---------------------------------------------------------------- rendering

/** Entries that are changes themselves (not containers that only hold changes), in document order. */
export function flattenDiff(result: DiffResult): DiffEntry[] {
  const out: DiffEntry[] = [];
  const stack = [result.root];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.kind !== 'same' && (e.kind !== 'changed' || !e.children)) out.push(e);
    if (e.children) for (let k = e.children.length - 1; k >= 0; k--) stack.push(e.children[k]);
  }
  return out;
}

export interface DiffTextOptions {
  /** Change lines before the rest is summarised (default 400). */
  maxLines?: number;
  /** Characters per value preview (default 60). */
  maxValue?: number;
}

/**
 * Compact text for the CLI and agents: a summary line, then one line per
 * change, e.g. `~ $.users[3].email: "a@x" → "b@x"`, `+ $.users[60] {7}`,
 * `- $.settings.beta: null`, `↕ $.items[0]: moved from $.items[4]`.
 */
export function diffToText(result: DiffResult, left: DataTree, right: DataTree, options: DiffTextOptions = {}): string {
  const maxLines = options.maxLines ?? 400;
  const maxValue = options.maxValue ?? 60;
  const s = result.stats;
  const parts: string[] = [];
  if (s.changed) parts.push(`${withCommas(s.changed)} changed`);
  if (s.added) parts.push(`${withCommas(s.added)} added`);
  if (s.removed) parts.push(`${withCommas(s.removed)} removed`);
  if (s.typeChanged) parts.push(`${withCommas(s.typeChanged)} type changed`);
  if (s.moved) parts.push(`${withCommas(s.moved)} moved`);
  const head = parts.length ? parts.join(', ') : result.root.kind === 'same' ? 'no differences' : 'differences';
  const out = [`${head}${result.truncated ? ' (truncated)' : ''}`];
  const show = (tree: DataTree, id: number): string => {
    const t = tree.type[id];
    if (t === T_OBJECT) return `{${withCommas(tree.childCount[id])}}`;
    if (t === T_ARRAY) return `[${withCommas(tree.childCount[id])}]`;
    if (t === T_STRING) return JSON.stringify(oneLine(tree.stringValue(id), maxValue));
    return tree.preview(id, maxValue);
  };
  const value = (tree: DataTree, id: number) => (tree.isContainer(id) ? ` ${show(tree, id)}` : `: ${show(tree, id)}`);
  const lines = flattenDiff(result);
  for (const e of lines.slice(0, maxLines)) {
    switch (e.kind) {
      case 'added':
        out.push(`+ ${e.path}${value(right, e.right)}`);
        break;
      case 'removed':
        out.push(`- ${e.path}${value(left, e.left)}`);
        break;
      case 'moved':
        out.push(`↕ ${e.path}: moved from ${left.pathString(e.left)}`);
        break;
      case 'type':
        out.push(`~ ${e.path}: ${show(left, e.left)} → ${show(right, e.right)} (${left.typeName(e.left)} → ${right.typeName(e.right)})`);
        break;
      default:
        out.push(`~ ${e.path}: ${show(left, e.left)} → ${show(right, e.right)}`);
    }
  }
  if (lines.length > maxLines) out.push(`… ${withCommas(lines.length - maxLines)} more`);
  return out.join('\n');
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
