/**
 * Text search over keys and values. Each key and value is matched on its own
 * text, the same in every format: keys and strings decoded (`C:\Users` finds
 * "C:\\Users", `^…$` anchor to the value), numbers, booleans and null as
 * written.
 *
 * Plain-text queries on trees with source positions scan the raw text with
 * one RegExp and map hits back to nodes by binary search, which is far faster
 * than materialising every key and value; a match counts when it lies within
 * a single key or value whose source text is its text. The few keys and
 * values that need decoding (escapes, entities, doubled CSV quotes) or have no
 * source text are tested separately. Regular expressions test each key and
 * value on its own text.
 */

import {
  DataTree,
  F_ATTR,
  F_COLUMN_KEY,
  F_ESCAPED,
  F_KEY_SYNTH,
  F_NO_POS,
  F_SYNTHETIC,
  F_TEXT,
  F_VAL_SYNTH,
  T_ARRAY,
  T_OBJECT,
  T_STRING,
  type DataFormat,
} from './tree';

export interface SearchOptions {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  keys?: boolean;
  values?: boolean;
  limit?: number;
}

export interface SearchHit {
  id: number;
  /** Where the match is: in the key or in the value. */
  in: 'key' | 'value';
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
  error?: string;
}

export function buildSearchRegExp(opts: SearchOptions): RegExp {
  let src = opts.regex ? opts.query : opts.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) src = `\\b(?:${src})\\b`;
  return new RegExp(src, opts.caseSensitive ? 'g' : 'gi');
}

/**
 * Hits in document order, at most one per node (a key hit wins over a value
 * hit). `truncated` is true only when there are more hits than `limit`.
 */
export function searchTree(tree: DataTree, opts: SearchOptions): SearchResult {
  const limit = Math.max(0, opts.limit ?? 5000);
  if (!opts.query) return { hits: [], truncated: false };
  let re: RegExp;
  try {
    re = buildSearchRegExp(opts);
  } catch (e) {
    return { hits: [], truncated: false, error: (e as Error).message };
  }
  const s = new Searcher(tree, re, opts.keys ?? true, opts.values ?? true, !!opts.regex || opts.query.includes('@'));
  // One hit more than asked for tells whether the list was cut.
  const hits = !opts.regex && hasMostlyPositions(tree) ? s.scanSource(limit + 1) : s.scanNodes(limit + 1);
  const truncated = hits.length > limit;
  if (truncated) hits.length = limit;
  return { hits, truncated };
}

function hasMostlyPositions(tree: DataTree): boolean {
  let synth = 0;
  const n = Math.min(tree.count, 2000);
  for (let i = 0; i < n; i++) if (tree.flags[i] & (F_NO_POS | F_VAL_SYNTH)) synth++;
  return synth * 10 < n;
}

const JSON_FAMILY = new Set<DataFormat>(['json', 'jsonc', 'json5', 'jsonl', 'xlsx']);

class Searcher {
  private readonly text: string;
  /** Non-global copy of the query, for testing one key or value. */
  private readonly test: RegExp;
  private readonly jsonLike: boolean;
  private readonly csv: boolean;
  // Content range set by plainKey()/plainValue().
  private s = 0;
  private e = 0;
  // Next `\` / `""` at or after the last range checked (-1: none left; -2: not looked up yet).
  private backslash = -2;
  private doubledQuote = -2;

  constructor(
    private readonly tree: DataTree,
    /** Global RegExp for scanning the source. */
    private readonly re: RegExp,
    private readonly keys: boolean,
    private readonly values: boolean,
    /** XML attribute keys are matched as `@name`, which is not in the source: for regexes and queries with `@`. */
    private readonly attrKeysDecoded: boolean,
  ) {
    this.text = tree.text;
    this.test = new RegExp(re.source, re.flags.replace('g', ''));
    this.jsonLike = JSON_FAMILY.has(tree.format);
    this.csv = tree.format === 'csv' || tree.format === 'tsv';
  }

  /** Whether `id` has a key of its own: not the root, an array item, a CSV cell or XML text. */
  private keyed(id: number): boolean {
    const t = this.tree;
    const p = t.parent[id];
    return p >= 0 && id !== t.root && t.type[p] !== T_ARRAY && !(t.flags[id] & (F_COLUMN_KEY | F_TEXT));
  }

  /**
   * Whether a (keyed) node's key text differs from its source text: synthetic
   * or positionless keys, and quoted JSON keys with escapes. XML attribute
   * keys are left to the caller. Calls must follow document order.
   */
  private keyDecoded(id: number): boolean {
    const t = this.tree;
    if (t.flags[id] & (F_KEY_SYNTH | F_NO_POS)) return true;
    if (!this.jsonLike || !this.has('\\', t.keyPos[id], t.keyEnd[id])) return false;
    const q = this.text.charCodeAt(t.keyPos[id]);
    return q === 34 || q === 39; // bare JSON5 keys are read as written
  }

  /** Like keyDecoded() for the value of a primitive. */
  private valueDecoded(id: number): boolean {
    const t = this.tree;
    const f = t.flags[id];
    if (f & (F_VAL_SYNTH | F_NO_POS)) return true;
    if (t.type[id] !== T_STRING || !(f & F_ESCAPED)) return false;
    // A quoted CSV cell reads as its source unless it has doubled quotes.
    return !this.csv || this.has('""', t.valPos[id] + 1, t.valEnd[id] - 1);
  }

  /**
   * When the key's source text is its text, sets [s, e) to it (without the
   * quotes) and returns true; false when it must be decoded first.
   */
  private plainKey(id: number): boolean {
    const t = this.tree;
    if ((t.flags[id] & F_ATTR && this.attrKeysDecoded) || this.keyDecoded(id)) return false;
    let s = t.keyPos[id];
    let e = t.keyEnd[id];
    if (this.jsonLike) {
      const q = this.text.charCodeAt(s);
      if (q === 34 || q === 39) {
        s++;
        if (e > s && this.text.charCodeAt(e - 1) === q) e--;
      }
    }
    this.s = s;
    this.e = e;
    return true;
  }

  /** Like plainKey() for the value of a primitive. */
  private plainValue(id: number): boolean {
    if (this.valueDecoded(id)) return false;
    const t = this.tree;
    let s = t.valPos[id];
    let e = t.valEnd[id];
    if (t.type[id] === T_STRING) {
      // Quoted CSV cells and JSON strings without escapes are terminated, so the closing quote is there.
      const q = this.text.charCodeAt(s);
      if (t.flags[id] & F_ESCAPED || (this.jsonLike && (q === 34 || q === 39))) {
        s++;
        e--;
      }
    }
    this.s = s;
    this.e = e;
    return true;
  }

  /** Whether `needle` occurs in [s, e); ranges must not move backwards between calls (document order). */
  private has(needle: '\\' | '""', s: number, e: number): boolean {
    let at = needle === '\\' ? this.backslash : this.doubledQuote;
    if (at === -1) return false;
    if (at < s) {
      at = this.text.indexOf(needle, s);
      if (needle === '\\') this.backslash = at;
      else this.doubledQuote = at;
    }
    return at !== -1 && at < e;
  }

  private keyText(id: number): string {
    return String(this.tree.key(id));
  }

  private valueText(id: number): string {
    const t = this.tree;
    return t.type[id] === T_STRING ? t.stringValue(id) : t.rawValue(id);
  }

  /** Regular expressions (and trees without usable positions): every key and value on its own. */
  scanNodes(limit: number): SearchHit[] {
    const t = this.tree;
    const hits: SearchHit[] = [];
    const end = t.root + t.size[t.root];
    for (let id = t.root; id < end && hits.length < limit; id++) {
      if (t.flags[id] & F_SYNTHETIC) continue;
      if (this.keys && this.keyed(id)) {
        const k = this.plainKey(id) ? this.text.slice(this.s, this.e) : this.keyText(id);
        if (this.test.test(k)) {
          hits.push({ id, in: 'key' });
          continue;
        }
      }
      if (this.values && t.type[id] !== T_OBJECT && t.type[id] !== T_ARRAY) {
        const v = this.plainValue(id) ? this.text.slice(this.s, this.e) : this.valueText(id);
        if (this.test.test(v)) hits.push({ id, in: 'value' });
      }
    }
    return hits;
  }

  /** Plain text: one scan of the source for plain keys and values, plus the others one by one. */
  scanSource(limit: number): SearchHit[] {
    const fromSource = this.sourceHits(limit);
    // With the source hits complete, decoded ones past the last of them cannot make the cut.
    const stopAt = fromSource.length >= limit ? fromSource[fromSource.length - 1].id + 1 : Infinity;
    const decoded = this.decodedHits(limit, stopAt);
    if (!decoded.length) return fromSource;
    // Both lists are in document order; merge them, one hit per node.
    const hits: SearchHit[] = [];
    let a = 0;
    let b = 0;
    while (hits.length < limit && (a < fromSource.length || b < decoded.length)) {
      const x = fromSource[a];
      const y = decoded[b];
      const next = !y || (x && (x.id < y.id || (x.id === y.id && x.in === 'key'))) ? fromSource[a++] : decoded[b++];
      if (hits.length && hits[hits.length - 1].id === next.id) continue;
      hits.push(next);
    }
    return hits;
  }

  private sourceHits(limit: number): SearchHit[] {
    const { tree: t, re, text } = this;
    const hits: SearchHit[] = [];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while (hits.length < limit && (m = re.exec(text))) {
      const off = m.index;
      const end = off + m[0].length;
      const id = t.nodeAtOffset(off);
      let next = off + 1;
      if (id >= 0 && !(t.flags[id] & (F_SYNTHETIC | F_NO_POS))) {
        let where: SearchHit['in'] | '' = '';
        let regionEnd = 0;
        if (this.keyed(id) && off >= t.keyPos[id] && off < t.keyEnd[id]) {
          regionEnd = t.keyEnd[id];
          if (this.keys && this.plainKey(id)) where = 'key';
        } else if (t.type[id] !== T_OBJECT && t.type[id] !== T_ARRAY && off >= t.valPos[id] && off < t.valEnd[id]) {
          regionEnd = t.valEnd[id];
          if (this.values && this.plainValue(id)) where = 'value';
        }
        if (where && off >= this.s && end <= this.e) {
          // One hit per node; a key hit still lets the scan continue into the value's children.
          if (!hits.length || hits[hits.length - 1].id !== id) hits.push({ id, in: where });
          next = Math.max(end, regionEnd);
        } else if (regionEnd && !where) next = regionEnd; // decoded separately, or not searched
      }
      re.lastIndex = next;
    }
    return hits;
  }

  /** Hits among keys and values whose text differs from their source (or that have none), before `stopAt`. */
  private decodedHits(limit: number, stopAt: number): SearchHit[] {
    const ix = this.decodedIndex();
    const keyIds = !this.keys ? NONE : this.attrKeysDecoded && ix.attrs.length ? mergeSorted(ix.keys, ix.attrs) : ix.keys;
    const valueIds = this.values ? ix.values : NONE;
    const hits: SearchHit[] = [];
    let i = 0;
    let j = 0;
    while (hits.length < limit) {
      const k = i < keyIds.length ? keyIds[i] : Infinity;
      const v = j < valueIds.length ? valueIds[j] : Infinity;
      const id = Math.min(k, v);
      if (id >= stopAt) break;
      if (k === id) {
        i++;
        if (this.test.test(this.keyText(id))) {
          hits.push({ id, in: 'key' });
          if (v === id) j++;
          continue;
        }
      }
      if (v === id) {
        j++;
        if (this.test.test(this.valueText(id))) hits.push({ id, in: 'value' });
      }
    }
    return hits;
  }

  private decodedIndex(): DecodedIndex {
    let ix = decodedIndexes.get(this.tree);
    if (!ix) {
      const t = this.tree;
      const keys: number[] = [];
      const values: number[] = [];
      const attrs: number[] = [];
      this.backslash = this.doubledQuote = -2;
      const end = t.root + t.size[t.root];
      for (let id = t.root; id < end; id++) {
        if (t.flags[id] & F_SYNTHETIC) continue;
        if (this.keyed(id)) {
          if (t.flags[id] & F_ATTR) attrs.push(id);
          else if (this.keyDecoded(id)) keys.push(id);
        }
        if (t.type[id] !== T_OBJECT && t.type[id] !== T_ARRAY && this.valueDecoded(id)) values.push(id);
      }
      ix = { keys: Int32Array.from(keys), values: Int32Array.from(values), attrs: Int32Array.from(attrs) };
      decodedIndexes.set(t, ix);
    }
    return ix;
  }
}

/** Ids of the keys and values whose text is not their source text, per tree (trees do not change once parsed). */
interface DecodedIndex {
  keys: Int32Array;
  values: Int32Array;
  /** XML attribute keys: decoded (`@name`) only for queries that mention `@`. */
  attrs: Int32Array;
}

const decodedIndexes = new WeakMap<DataTree, DecodedIndex>();
const NONE = new Int32Array(0);

function mergeSorted(a: Int32Array, b: Int32Array): Int32Array {
  const out = new Int32Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length || j < b.length) out[k++] = j >= b.length || (i < a.length && a[i] < b[j]) ? a[i++] : b[j++];
  return out;
}
