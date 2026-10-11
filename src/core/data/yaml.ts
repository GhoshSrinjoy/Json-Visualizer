/** YAML -> DataTree, keeping source ranges for every key and value. */

import { isAlias, isMap, isPair, isScalar, isSeq, parseAllDocuments, type Node as YamlNode } from 'yaml';
import {
  DataTree,
  F_ALIAS,
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
  type NodeType,
} from './tree';

const MAX_DEPTH = 2000;

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
  for (const doc of list) {
    for (const err of doc.errors) b.error(err.pos?.[0] ?? 0, err.message.split('\n')[0]);
    const contents = doc.contents as YamlNode | null;
    // Skip empty documents (e.g. a trailing `---`) when there are others.
    if (contents === null && list.length > 1) continue;
    addNode(b, contents, 0, 0, 0);
  }
  const tree = b.finish();
  tree.parseMs = now() - started;
  return tree;
}

function range(node: unknown): [number, number] | undefined {
  const r = (node as { range?: [number, number, number] } | null)?.range;
  return r ? [r[0], r[1]] : undefined;
}

/** `fallbackPos` (>= 0) positions value-less entries such as `key:` at their key. */
function addNode(b: TreeBuilder, node: YamlNode | null | undefined, keyPos: number, keyEnd: number, depth: number, fallbackPos = -1): void {
  const r = range(node);
  const pos = r ? r[0] : Math.max(0, fallbackPos);
  const end = r ? r[1] : Math.max(0, fallbackPos);
  const posFlag = r || fallbackPos >= 0 ? 0 : F_NO_POS;

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
    b.open(T_OBJECT, posFlag, keyPos, keyEnd, pos);
    for (const item of node.items) {
      if (!isPair(item)) continue;
      const k = item.key as YamlNode | null;
      const kr = range(k);
      const kPos = kr ? kr[0] : pos;
      const kEnd = kr ? kr[1] : pos;
      const before = b.tree.count;
      addNode(b, item.value as YamlNode | null, kPos, kEnd, depth + 1, kEnd);
      b.setKey(before, keyText(k));
    }
    b.close(end);
    return;
  }
  if (isSeq(node)) {
    b.open(T_ARRAY, posFlag, keyPos, keyEnd, pos);
    for (const item of node.items) addNode(b, item as YamlNode, 0, 0, depth + 1, end);
    b.close(end);
    return;
  }
  if (isAlias(node)) {
    const id = b.leaf(T_NULL, F_ALIAS | posFlag, keyPos, keyEnd, pos, end);
    b.setValue(id, `*${node.source}`);
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
      // Keep the literal for integers beyond double precision.
      text = typeof v === 'number' && !Number.isSafeInteger(v) && src && /^[+-]?\d+$/.test(src) ? src : String(v);
      if (typeof v === 'number' && !Number.isFinite(v)) text = Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
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

function keyText(k: YamlNode | null): string {
  if (k === null || k === undefined) return '';
  if (isScalar(k)) return k.value === null ? 'null' : String(k.value);
  if (isAlias(k)) return `*${k.source}`;
  return String(k);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
