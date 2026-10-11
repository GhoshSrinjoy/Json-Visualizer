/**
 * Text search over keys and values. When the tree has source positions, the
 * raw text is scanned with one RegExp and hits are mapped back to nodes by
 * binary search — far faster than materialising every key and value.
 */

import { DataTree, F_COLUMN_KEY, F_NO_POS, F_SYNTHETIC, F_VAL_SYNTH, T_STRING } from './tree';

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

export function searchTree(tree: DataTree, opts: SearchOptions): SearchResult {
  const limit = opts.limit ?? 5000;
  const wantKeys = opts.keys ?? true;
  const wantValues = opts.values ?? true;
  if (!opts.query) return { hits: [], truncated: false };
  let re: RegExp;
  try {
    re = buildSearchRegExp(opts);
  } catch (e) {
    return { hits: [], truncated: false, error: (e as Error).message };
  }
  const positioned = hasMostlyPositions(tree);
  return positioned ? searchSource(tree, re, wantKeys, wantValues, limit) : searchNodes(tree, re, wantKeys, wantValues, limit);
}

function hasMostlyPositions(tree: DataTree): boolean {
  let synth = 0;
  const n = Math.min(tree.count, 2000);
  for (let i = 0; i < n; i++) if (tree.flags[i] & (F_NO_POS | F_VAL_SYNTH)) synth++;
  return synth * 10 < n;
}

function searchSource(tree: DataTree, re: RegExp, keys: boolean, values: boolean, limit: number): SearchResult {
  const hits: SearchHit[] = [];
  const text = tree.text;
  let lastId = -1;
  let lastIn: SearchHit['in'] | '' = '';
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (m[0].length === 0) re.lastIndex++;
    const off = m.index;
    const id = tree.nodeAtOffset(off);
    if (id < 0 || tree.flags[id] & F_SYNTHETIC) continue;
    let where: SearchHit['in'] | '' = '';
    const parent = tree.parent[id];
    const keyed = parent >= 0 && !tree.isArrayChild(id) && !(tree.flags[id] & F_COLUMN_KEY);
    if (keyed && off >= tree.keyPos[id] && off < tree.keyEnd[id]) where = 'key';
    else if (!tree.isContainer(id) && off >= tree.valPos[id] && off < tree.valEnd[id]) where = 'value';
    if (!where || (where === 'key' && !keys) || (where === 'value' && !values)) continue;
    if (id === lastId && where === lastIn) continue;
    lastId = id;
    lastIn = where;
    hits.push({ id, in: where });
    if (hits.length >= limit) return { hits, truncated: true };
  }
  return { hits, truncated: false };
}

function searchNodes(tree: DataTree, re: RegExp, keys: boolean, values: boolean, limit: number): SearchResult {
  const hits: SearchHit[] = [];
  const end = tree.root + tree.size[tree.root];
  for (let id = tree.root; id < end; id++) {
    if (tree.flags[id] & F_SYNTHETIC) continue;
    if (keys) {
      const k = tree.key(id);
      if (typeof k === 'string') {
        re.lastIndex = 0;
        if (re.test(k)) {
          hits.push({ id, in: 'key' });
          if (hits.length >= limit) return { hits, truncated: true };
          continue;
        }
      }
    }
    if (values && !tree.isContainer(id)) {
      const v = tree.type[id] === T_STRING ? tree.stringValue(id) : tree.rawValue(id);
      re.lastIndex = 0;
      if (re.test(v)) {
        hits.push({ id, in: 'value' });
        if (hits.length >= limit) return { hits, truncated: true };
      }
    }
  }
  return { hits, truncated: false };
}
