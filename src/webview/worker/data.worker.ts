/// <reference lib="webworker" />
/**
 * Data worker: parses documents off the UI thread and answers paged queries
 * against the columnar DataTree, so even multi-hundred-megabyte files keep the
 * UI responsive. Only small, display-ready slices cross the thread boundary.
 */

import { decodeText, detectFormat, parseData } from '../../core/data/formats';
import { xlsxToJson, type InflateRaw } from '../../core/data/xlsx';
import { runQuery } from '../../core/data/query';
import { inferSchema, schemaEnum, schemaFormat, schemaToJsonSchema, schemaToText, schemaToTypeScript, typeExpr, type SchemaNode } from '../../core/data/schema';
import { searchTree } from '../../core/data/search';
import { DataTree, F_ATTR, F_ELEMENT, F_ERROR, F_TEXT, T_ARRAY, T_OBJECT, T_STRING, TYPE_NAMES } from '../../core/data/tree';
import type { CardData, NodeDetail, NodeInfo, SchemaView, Summary, TableCell, TableInfo, WorkerApi, WorkerRequest, WorkerResponse } from './protocol';

let tree: DataTree | null = null;
let name = '';
/** Size of the loaded file (text length is not the file size for decoded or converted documents). */
let sourceBytes = 0;
let tableOrder: { id: number; key: string; order: Uint32Array } | null = null;

function need(): DataTree {
  if (!tree) throw new Error('No document loaded');
  return tree;
}

function info(t: DataTree, id: number): NodeInfo {
  const f = t.flags[id];
  const n: NodeInfo = {
    id,
    key: t.key(id),
    type: TYPE_NAMES[t.type[id]],
    preview: t.preview(id, 160),
    count: t.childCount[id],
  };
  if (f & F_ATTR) n.attr = true;
  if (f & F_TEXT) n.text = true;
  if (f & F_ERROR) n.error = true;
  if (f & F_ELEMENT) {
    n.element = true;
    // `<name>Ada</name>` reads best inline.
    if (t.childCount[id] === 1) {
      const c = id + 1;
      if (t.flags[c] & F_TEXT) n.inline = t.preview(c, 160);
    } else if (t.childCount[id] === 0) n.inline = '';
  }
  return n;
}

/** Rows shown by default for arrays of records: each row is only a port, so keep it short. */
const RECORD_ARRAY_ROWS = 12;

function card(t: DataTree, id: number, rowLimit: number, explicit = false): CardData {
  const base = info(t, id);
  let limit = rowLimit;
  if (!explicit && t.type[id] === T_ARRAY && t.childCount[id] > RECORD_ARRAY_ROWS && t.isContainer(id + 1)) limit = Math.min(limit, RECORD_ARRAY_ROWS);
  const rows = t.children(id, 0, limit).map((c) => info(t, c));
  return { ...base, rows, more: Math.max(0, t.childCount[id] - rows.length) };
}

/** Largest array of records within a few levels (the natural "table" of a document). */
function bestTable(t: DataTree, from: number): number | null {
  let best: number | null = null;
  let bestRows = 0;
  let frontier = [from];
  for (let depth = 0; depth < 4 && frontier.length; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      if (t.type[id] === T_ARRAY && t.childCount[id] > bestRows && t.type[id + 1] === T_OBJECT) {
        best = id;
        bestRows = t.childCount[id];
      }
      for (let c = t.firstChild(id), k = 0; c >= 0 && k < 200; c = t.nextSibling(c), k++) if (t.isContainer(c)) next.push(c);
    }
    frontier = next.slice(0, 2000);
  }
  return best;
}

function summary(): Summary {
  const t = need();
  const counts = t.typeCounts();
  return {
    name,
    format: t.format,
    bytes: sourceBytes || t.text.length,
    nodes: t.nodeCount(),
    root: t.root,
    rootType: TYPE_NAMES[t.type[t.root]],
    maxDepth: t.maxDepth,
    lines: t.lineCount(),
    parseMs: t.parseMs,
    errors: t.errors.slice(0, 50).map((e) => ({ line: e.line, col: e.col, message: e.message, offset: e.offset })),
    typeCounts: counts,
    xml: t.xmlLike,
  };
}

function schemaView(s: SchemaNode): SchemaView {
  const v: SchemaView = {
    count: s.count,
    objects: s.objects,
    types: s.types,
    typeText: typeExpr(s),
    examples: s.examples,
    minItems: s.minItems,
    maxItems: s.maxItems,
    min: s.min,
    max: s.max,
    attr: s.attr,
    text: s.text,
  };
  const en = schemaEnum(s);
  if (en) v.enumValues = en;
  const fmt = schemaFormat(s);
  if (fmt) v.format = fmt;
  if (s.fields) {
    v.fields = [...s.fields.entries()].map(([key, f]) => ({
      key,
      schema: schemaView(f),
      optional: f.count < s.objects,
      presence: s.objects ? f.count / s.objects : 1,
    }));
  }
  if (s.mapOf) {
    v.mapOf = schemaView(s.mapOf);
    v.mapKeys = s.mapKeys;
  }
  if (s.items && s.items.count) v.items = schemaView(s.items);
  return v;
}

/** Column names for a table over `id`'s children (union of keys of the first rows). */
function columnsOf(t: DataTree, id: number): { columns: string[]; tabular: boolean } {
  if (t.columns && id === t.root) return { columns: t.columns, tabular: true };
  const seen = new Map<string, number>();
  let objects = 0;
  let scanned = 0;
  for (let c = t.firstChild(id); c >= 0 && scanned < 500; c = t.nextSibling(c), scanned++) {
    if (t.type[c] !== T_OBJECT) continue;
    objects++;
    let k = 0;
    for (let g = t.firstChild(c); g >= 0 && k < 200; g = t.nextSibling(g), k++) {
      const key = String(t.key(g));
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const tabular = objects > 0 && objects >= scanned * 0.6;
  if (!tabular) return { columns: t.type[id] === T_OBJECT ? ['key', 'value'] : ['value'], tabular: false };
  return { columns: [...seen.entries()].sort((a, b) => b[1] - a[1] || 0).map(([k]) => k).slice(0, 200), tabular: true };
}

function cellFor(t: DataTree, row: number, column: string, tabular: boolean): TableCell | null {
  if (!tabular) {
    if (column === 'key') return { id: row, type: 'string', preview: String(t.key(row)), count: 0 };
    return { id: row, type: TYPE_NAMES[t.type[row]], preview: t.preview(row, 200), count: t.childCount[row] };
  }
  if (t.type[row] !== T_OBJECT) return null;
  for (let c = t.firstChild(row); c >= 0; c = t.nextSibling(c)) {
    if (String(t.key(c)) === column) return { id: c, type: TYPE_NAMES[t.type[c]], preview: t.preview(c, 200), count: t.childCount[c] };
  }
  return null;
}

function sortKey(t: DataTree, row: number, column: string): string | number {
  for (let c = t.firstChild(row); c >= 0; c = t.nextSibling(c)) {
    if (String(t.key(c)) === column) {
      const v = t.value(c);
      if (typeof v === 'number') return v;
      if (v === undefined) return t.childCount[c];
      return v === null ? '' : String(v).toLowerCase();
    }
  }
  return '';
}

const inflateRaw: InflateRaw = async (data) => {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const api: WorkerApi = {
  async load({ bytes, text, format, name: n }) {
    const excel = (format ?? detectFormat(n)) === 'xlsx' && bytes;
    const src = excel ? await xlsxToJson(new Uint8Array(bytes), inflateRaw) : (text ?? (bytes ? decodeText(new Uint8Array(bytes)) : ''));
    const fmt = excel ? 'xlsx' : (format ?? detectFormat(n, undefined, src.slice(0, 64 * 1024)) ?? 'json');
    tree = parseData(src, fmt);
    sourceBytes = bytes?.byteLength ?? 0;
    name = n;
    tableOrder = null;
    return summary();
  },
  summary,
  node: ({ id }) => info(need(), id),
  children({ id, offset, limit }) {
    const t = need();
    return t.children(id, offset, limit).map((c) => info(t, c));
  },
  cards({ ids, rowLimit, rowLimits }) {
    const t = need();
    return ids.filter((id) => id >= 0 && id < t.count).map((id) => card(t, id, rowLimits?.[id] ?? rowLimit, rowLimits?.[id] !== undefined));
  },
  initial({ depth, budget, rowLimit }) {
    const t = need();
    const expanded: number[] = [];
    const cards: CardData[] = [];
    if (!t.isContainer(t.root)) return { expanded, cards: [card(t, t.root, rowLimit)] };
    // Breadth-first, but only a few items of each array: an overview of the
    // shape rather than a wall of identical records.
    const ARRAY_SAMPLE = 4;
    let frontier = [t.root];
    for (let d = 0; d < depth && frontier.length && cards.length < budget; d++) {
      const next: number[] = [];
      for (const id of frontier) {
        if (cards.length >= budget) break;
        const c = card(t, id, rowLimit);
        cards.push(c);
        expanded.push(id);
        let taken = 0;
        for (const r of c.rows) {
          if ((r.type !== 'object' && r.type !== 'array') || r.count === 0 || r.inline !== undefined) continue;
          if (c.type === 'array' && taken++ >= ARRAY_SAMPLE) break;
          next.push(r.id);
        }
      }
      frontier = next;
    }
    return { expanded, cards };
  },
  expandAll({ id, depth, budget, rowLimit }) {
    const t = need();
    const expanded: number[] = [];
    const cards: CardData[] = [];
    let frontier = [id];
    for (let d = 0; d <= depth && frontier.length && cards.length < budget; d++) {
      const next: number[] = [];
      for (const x of frontier) {
        if (cards.length >= budget) break;
        const c = card(t, x, rowLimit);
        cards.push(c);
        expanded.push(x);
        for (const r of c.rows) if ((r.type === 'object' || r.type === 'array') && r.count > 0 && r.inline === undefined) next.push(r.id);
      }
      frontier = next;
    }
    return { expanded, cards };
  },
  detail({ id, maxChars }) {
    const t = need();
    const base = info(t, id);
    let value: string;
    if (t.isContainer(id)) value = t.toJSON(id, 2, maxChars + 1);
    else value = t.type[id] === T_STRING ? t.stringValue(id) : t.rawValue(id);
    const truncated = value.length > maxChars;
    const d: NodeDetail = {
      ...base,
      path: t.pathString(id),
      segments: t.path(id),
      depth: t.depth(id),
      value: truncated ? value.slice(0, maxChars) : value,
      valueTruncated: truncated,
      descendants: t.size[id] - 1,
      parent: t.parent[id],
    };
    if (t.hasPosition(id)) {
      const s = t.start(id);
      const e = t.end(id);
      d.start = { ...t.lineCol(s), offset: s };
      d.end = { ...t.lineCol(e), offset: e };
    }
    return d;
  },
  ancestors({ id }) {
    const t = need();
    const out: number[] = [];
    for (let p = t.parent[id]; p >= 0 && p >= t.root; p = t.parent[p]) out.push(p);
    return out.reverse();
  },
  search: (args) => searchTree(need(), args),
  query({ query, limit }) {
    try {
      const r = runQuery(need(), query, limit);
      return { ids: r.ids, total: r.total };
    } catch (e) {
      return { ids: [], total: 0, error: (e as Error).message };
    }
  },
  schema: ({ id }) => schemaView(inferSchema(need(), id).root),
  exportSchema({ id, kind }) {
    const s = inferSchema(need(), id);
    if (kind === 'json-schema') return JSON.stringify(schemaToJsonSchema(s, name), null, 2);
    if (kind === 'typescript') return schemaToTypeScript(s);
    return schemaToText(s);
  },
  tableInfo({ id, auto }): TableInfo {
    const t = need();
    // Opening the table on a non-tabular root jumps to the main array of records.
    if (auto) {
      const { tabular } = columnsOf(t, id);
      const best = tabular ? null : bestTable(t, id);
      if (best !== null) id = best;
    }
    const { columns, tabular } = columnsOf(t, id);
    return { id, rows: t.childCount[id], columns, tabular, path: t.pathString(id) };
  },
  tableRows({ id, start, count, columns, sort, filter }) {
    const t = need();
    const { tabular } = columnsOf(t, id);
    const total = t.childCount[id];
    let order: Uint32Array | null = null;
    const key = `${sort?.column ?? ''}:${sort?.desc ?? ''}:${filter ?? ''}`;
    if (sort || filter) {
      if (tableOrder && tableOrder.id === id && tableOrder.key === key) order = tableOrder.order;
      else {
        let ids = t.children(id);
        if (filter) {
          const f = filter.toLowerCase();
          ids = ids.filter((r) => {
            if (!t.isContainer(r)) return t.preview(r, 400).toLowerCase().includes(f) || String(t.key(r)).toLowerCase().includes(f);
            for (let c = t.firstChild(r); c >= 0; c = t.nextSibling(c)) if (t.preview(c, 400).toLowerCase().includes(f)) return true;
            return false;
          });
        }
        if (sort) {
          const keys = new Map(ids.map((r) => [r, tabular ? sortKey(t, r, sort.column) : sort.column === 'key' ? String(t.key(r)) : (t.value(r) as string | number) ?? '']));
          ids.sort((a, b) => {
            const ka = keys.get(a)!;
            const kb = keys.get(b)!;
            const c = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), undefined, { numeric: true });
            return sort.desc ? -c : c;
          });
        }
        order = Uint32Array.from(ids);
        tableOrder = { id, key, order };
      }
    }
    const rowsTotal = order ? order.length : total;
    const ids = order ? Array.from(order.subarray(start, start + count)) : t.children(id, start, count);
    return {
      total: rowsTotal,
      rows: ids.map((rid, i) => ({ index: start + i, id: rid, cells: columns.map((col) => cellFor(t, rid, col, tabular)) })),
    };
  },
  nodeAtOffset: ({ offset }) => need().nodeAtOffset(offset),
  nodeAtLine({ line, col }) {
    const t = need();
    return t.nodeAtOffset(t.offsetOf(line, col));
  },
  json: ({ id, indent, maxChars }) => need().toJSON(id, indent ?? 2, maxChars),
  text({ maxChars }) {
    const t = need();
    return { text: t.text.length > maxChars ? t.text.slice(0, maxChars) : t.text, truncated: t.text.length > maxChars };
  },
};

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, method, args } = e.data;
  let res: WorkerResponse;
  try {
    const fn = api[method] as (a: unknown) => unknown;
    res = { id, result: await fn(args) };
  } catch (err) {
    res = { id, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(res);
};
