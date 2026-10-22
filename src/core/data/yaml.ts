/**
 * YAML -> DataTree, keeping source ranges for every key and value.
 *
 * Aliases (`*name`) and `<<` merge keys are resolved: each becomes a copy of
 * the anchored node (flagged F_COPY) that keeps the anchor's source positions,
 * so revealing a copied value lands on its anchor. Expansion is capped so an
 * alias bomb cannot exhaust memory; aliases past the cap, circular aliases and
 * unknown anchors stay `*name` strings (F_ALIAS) with a parse issue.
 */

import { isAlias, isMap, isPair, isScalar, isSeq, parseAllDocuments, type Alias, type Node as YamlNode, type Pair, type YAMLMap } from 'yaml';
import { withCommas } from '../util/strings';
import {
  DataTree,
  F_ALIAS,
  F_COPY,
  F_ERROR,
  F_NO_POS,
  F_SYNTHETIC,
  T_ARRAY,
  T_BOOLEAN,
  T_NULL,
  T_NUMBER,
  T_OBJECT,
  T_STRING,
  TreeBuilder,
  isJsonNumber,
  type NodeType,
} from './tree';

const MAX_DEPTH = 2000;
/** Aliases may copy this many nodes in total, or ten times the parsed nodes when that is more. */
const MIN_COPY_BUDGET = 1_000_000;

/** A mapping entry after `<<` merges: `via` is the alias it was merged through, `from` the `<<` entry that brought it. */
interface Entry {
  key: string;
  pair: Pair;
  via?: Alias;
  from?: Pair;
}

interface Expansion {
  b: TreeBuilder;
  /** The anchored node each alias refers to (the closest anchor before it). */
  targets: Map<Alias, YamlNode>;
  /** Collections on the current path: an alias or merge of one of them is circular. */
  active: Set<YamlNode>;
  /** Mappings whose merged entries are being computed. */
  merging: Set<YAMLMap>;
  /** Merged entries per mapping. */
  entries: Map<YAMLMap, Entry[]>;
  copied: number;
  budget: number;
  capped: boolean;
}

export function parseYaml(text: string): DataTree {
  const started = now();
  const b = new TreeBuilder(text, 'yaml', (text.length >>> 4) + 16);
  b.open(T_ARRAY, F_SYNTHETIC, 0, 0, 0);
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(text, { uniqueKeys: false, prettyErrors: false, strict: false });
  } catch (e) {
    b.error(0, e instanceof Error ? e.message : String(e));
    return b.finish();
  }
  const list = Array.isArray(docs) ? docs : [docs];
  const targets = new Map<Alias, YamlNode>();
  let parsed = 0;
  for (const doc of list) parsed += resolveAliases(doc.contents as YamlNode | null, new Map(), targets, 0);
  const x: Expansion = { b, targets, active: new Set(), merging: new Set(), entries: new Map(), copied: 0, budget: Math.max(MIN_COPY_BUDGET, 10 * parsed), capped: false };
  for (const doc of list) {
    for (const err of doc.errors) b.error(err.pos?.[0] ?? 0, err.message.split('\n')[0]);
    const contents = doc.contents as YamlNode | null;
    // Skip empty documents (e.g. a trailing `---`) when there are others.
    if (contents === null && list.length > 1) continue;
    addNode(x, contents, 0, 0, 0);
  }
  const tree = b.finish();
  tree.parseMs = now() - started;
  return tree;
}

/**
 * Walks a document in source order, mapping each alias to the closest anchor
 * of its name before it (anchors may be redefined). Returns the nodes walked.
 */
function resolveAliases(node: YamlNode | null | undefined, anchors: Map<string, YamlNode>, targets: Map<Alias, YamlNode>, depth: number): number {
  if (!node || depth > MAX_DEPTH) return 0;
  if (isAlias(node)) {
    const target = anchors.get(node.source);
    if (target) targets.set(node, target);
    return 1;
  }
  const anchor = (node as { anchor?: string }).anchor;
  if (anchor) anchors.set(anchor, node);
  let n = 1;
  if (isMap(node)) {
    for (const item of node.items) {
      if (!isPair(item)) continue;
      n += resolveAliases(item.key as YamlNode | null, anchors, targets, depth + 1);
      n += resolveAliases(item.value as YamlNode | null, anchors, targets, depth + 1);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) n += resolveAliases(item as YamlNode, anchors, targets, depth + 1);
  }
  return n;
}

function range(node: unknown): [number, number] | undefined {
  const r = (node as { range?: [number, number, number] } | null)?.range;
  return r ? [r[0], r[1]] : undefined;
}

/**
 * `fallbackPos` (>= 0) positions value-less entries such as `key:` at their
 * key; `copy` is F_COPY inside the expansion of an alias.
 */
function addNode(x: Expansion, node: YamlNode | null | undefined, keyPos: number, keyEnd: number, depth: number, fallbackPos = -1, copy = 0): void {
  const b = x.b;
  const r = range(node);
  const pos = r ? r[0] : Math.max(0, fallbackPos);
  const end = r ? r[1] : Math.max(0, fallbackPos);
  const posFlag = (r || fallbackPos >= 0 ? 0 : F_NO_POS) | copy;

  if (isAlias(node) && depth <= MAX_DEPTH) {
    const target = x.targets.get(node);
    let problem: string | undefined;
    if (!target) problem = `Unknown alias *${node.source}`;
    else if (x.active.has(target)) problem = `Circular alias *${node.source} is left unexpanded`;
    else if (x.copied >= x.budget) {
      // Report the cap once; every later alias stays text as well.
      problem = x.capped ? '' : `Aliases expand to more than ${withCommas(x.budget)} values; *${node.source} and later aliases are left unexpanded`;
      x.capped = true;
    }
    if (problem === undefined) {
      addNode(x, target, keyPos, keyEnd, depth, fallbackPos, F_COPY);
      return;
    }
    if (problem) b.error(pos, problem);
    const id = b.leaf(T_STRING, F_ALIAS | posFlag, keyPos, keyEnd, pos, end);
    b.setValue(id, `*${node.source}`);
    if (copy) x.copied++;
    return;
  }
  if (copy) x.copied++;
  if (node === null || node === undefined) {
    b.leaf(T_NULL, posFlag, keyPos, keyEnd, pos, end);
    return;
  }
  if (depth > MAX_DEPTH) {
    const id = b.leaf(T_STRING, F_ERROR | posFlag, keyPos, keyEnd, pos, end);
    b.setValue(id, '… (nesting too deep)');
    return;
  }
  if (isMap(node)) {
    x.active.add(node);
    b.open(T_OBJECT, posFlag, keyPos, keyEnd, pos);
    if (node.items.some((p) => isPair(p) && isMergeKey(p.key))) addMerged(x, node, depth, copy, pos);
    else for (const item of node.items) if (isPair(item)) addPair(x, item, depth, copy, pos);
    b.close(end);
    x.active.delete(node);
    return;
  }
  if (isSeq(node)) {
    x.active.add(node);
    b.open(T_ARRAY, posFlag, keyPos, keyEnd, pos);
    for (const item of node.items) addNode(x, item as YamlNode, 0, 0, depth + 1, end, copy);
    b.close(end);
    x.active.delete(node);
    return;
  }
  if (isScalar(node)) {
    const v = node.value;
    let type: NodeType;
    let text: string;
    if (v === null || v === undefined) {
      type = T_NULL;
      text = 'null';
    } else if (typeof v === 'boolean') {
      type = T_BOOLEAN;
      text = String(v);
    } else if (typeof v === 'number' || typeof v === 'bigint') {
      type = T_NUMBER;
      const src = (node as { source?: string }).source;
      // Keep the literal when JSON can carry it as written, and for integers
      // beyond double precision, so no digit is lost.
      if (src && (isJsonNumber(src) || (typeof v === 'number' && !Number.isSafeInteger(v) && /^[+-]?\d+$/.test(src)))) text = src;
      else if (typeof v === 'number' && !Number.isFinite(v)) text = Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
      else text = String(v);
    } else if (v instanceof Date) {
      type = T_STRING;
      text = v.toISOString();
    } else if (v instanceof Uint8Array) {
      type = T_STRING;
      text = `<binary ${v.length} bytes>`;
    } else {
      type = T_STRING;
      text = String(v);
    }
    const id = b.leaf(type, posFlag, keyPos, keyEnd, pos, end);
    b.setValue(id, text);
    return;
  }
  // Unknown node kinds: render via toString.
  const id = b.leaf(T_STRING, posFlag, keyPos, keyEnd, pos, end);
  b.setValue(id, String(node));
}

function addPair(x: Expansion, pair: Pair, depth: number, copy: number, pos: number): void {
  const k = pair.key as YamlNode | null;
  const kr = range(k);
  const kPos = kr ? kr[0] : pos;
  const kEnd = kr ? kr[1] : pos;
  const before = x.b.tree.count;
  addNode(x, pair.value as YamlNode | null, kPos, kEnd, depth + 1, kEnd, copy);
  x.b.setKey(before, keyText(k));
}

/** Adds the entries of a mapping that uses `<<` merge keys. */
function addMerged(x: Expansion, map: YAMLMap, depth: number, copy: number, pos: number): void {
  const kept = new Set<Pair>();
  for (const e of mergedEntries(x, map)) {
    if (e.via) {
      const target = x.targets.get(e.via);
      if ((target && x.active.has(target)) || x.copied >= x.budget) {
        // Keep the `<<` entry itself instead: addNode turns its alias into `*name` text with an issue.
        if (e.from && !kept.has(e.from)) {
          kept.add(e.from);
          addPair(x, e.from, depth, copy, pos);
        }
        continue;
      }
    }
    addPair(x, e.pair, depth, e.via ? F_COPY : copy, pos);
  }
}

/**
 * Entries of a mapping with YAML 1.1 merge keys applied: keys written in the
 * mapping win, then earlier merge sources over later ones; merged keys take
 * the place of the `<<` entry.
 */
function mergedEntries(x: Expansion, map: YAMLMap): Entry[] {
  const cached = x.entries.get(map);
  if (cached) return cached;
  const pairs = map.items.filter((p): p is Pair => isPair(p));
  const out: Entry[] = [];
  if (!pairs.some((p) => isMergeKey(p.key))) {
    for (const p of pairs) out.push({ key: keyText(p.key as YamlNode | null), pair: p });
  } else {
    x.merging.add(map);
    const own = new Set(pairs.filter((p) => !isMergeKey(p.key)).map((p) => keyText(p.key as YamlNode | null)));
    const merged = new Set<string>();
    for (const p of pairs) {
      if (!isMergeKey(p.key)) {
        out.push({ key: keyText(p.key as YamlNode | null), pair: p });
        continue;
      }
      const sources = mergeSources(x, p.value);
      if (!sources) {
        out.push({ key: '<<', pair: p }); // not mergeable: an ordinary key
        continue;
      }
      for (const s of sources) {
        if (x.merging.has(s.map)) {
          x.b.error(range(s.alias ?? s.map)?.[0] ?? 0, `Circular merge${s.alias ? ` of *${s.alias.source}` : ''} is skipped`);
          continue;
        }
        for (const e of mergedEntries(x, s.map)) {
          if (own.has(e.key) || merged.has(e.key)) continue;
          merged.add(e.key);
          out.push({ key: e.key, pair: e.pair, via: s.alias ?? e.via, from: p });
        }
      }
    }
    x.merging.delete(map);
  }
  x.entries.set(map, out);
  return out;
}

/** Mappings a `<<` value merges: a mapping, an alias of one, or a sequence of those; undefined when it is none of these. */
function mergeSources(x: Expansion, value: unknown): { map: YAMLMap; alias?: Alias }[] | undefined {
  const one = (v: unknown): { map: YAMLMap; alias?: Alias } | undefined => {
    if (isMap(v)) return { map: v };
    if (isAlias(v)) {
      const target = x.targets.get(v);
      if (isMap(target)) return { map: target, alias: v };
    }
    return undefined;
  };
  if (!isSeq(value)) {
    const s = one(value);
    return s && [s];
  }
  const out: { map: YAMLMap; alias?: Alias }[] = [];
  for (const item of value.items) {
    const s = one(item);
    if (!s) return undefined;
    out.push(s);
  }
  return out;
}

/** A plain `<<` key; a quoted "<<" is an ordinary key. */
function isMergeKey(k: unknown): boolean {
  if (!isScalar(k) || (k.type && k.type !== 'PLAIN')) return false;
  const v = k.value;
  return v === '<<' || (typeof v === 'symbol' && v.description === '<<');
}

function keyText(k: YamlNode | null): string {
  if (k === null || k === undefined) return '';
  if (isScalar(k)) return k.value === null ? 'null' : typeof k.value === 'symbol' ? (k.value.description ?? '') : String(k.value);
  if (isAlias(k)) return `*${k.source}`;
  return String(k);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
