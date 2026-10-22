/**
 * Converts a document (or a subtree) to YAML, TOML, CSV/TSV, XML or JSON Lines.
 * Big integers survive as BigInt; deep documents are walked iteratively.
 */

import { stringify as tomlStringify } from 'smol-toml';
import { stringify as yamlStringify } from 'yaml';
import type { ConvertTarget } from './targets';
import { DataTree, F_ELEMENT, T_ARRAY, T_BOOLEAN, T_NULL, T_NUMBER, T_OBJECT } from './tree';

export { CONVERT_TARGETS, type ConvertTarget } from './targets';

export class ConvertError extends Error {}

type Plain = null | boolean | number | bigint | string | Plain[] | { [k: string]: Plain };

const isRecord = (v: Plain | undefined): v is { [k: string]: Plain } => !!v && typeof v === 'object' && !Array.isArray(v);

export function convertTree(tree: DataTree, id: number, to: ConvertTarget): string {
  const value = toPlain(tree, id);
  switch (to) {
    case 'yaml':
      return yamlStringify(value, { lineWidth: 0, aliasDuplicateObjects: false });
    case 'toml':
      return toToml(value);
    case 'csv':
    case 'tsv':
      return toDelimited(value, to === 'csv' ? ',' : '\t');
    case 'xml':
      return toXml(value, tree.xmlLike && tree.flags[id] & F_ELEMENT ? (id === tree.root ? tree.text.slice(tree.keyPos[id], tree.keyEnd[id]) : String(tree.key(id))) : undefined);
    case 'jsonl':
      return (Array.isArray(value) ? value : [value]).map((v) => compactJson(v)).join('\n') + '\n';
  }
}

/** Plain JS value of a subtree; integers beyond 2^53 become BigInt so no digits are lost. */
export function toPlain(t: DataTree, root = t.root): Plain {
  const out: { v: Plain } = { v: null };
  const stack: { id: number; set: (v: Plain) => void }[] = [{ id: root, set: (v) => (out.v = v) }];
  while (stack.length) {
    const { id, set } = stack.pop()!;
    const type = t.type[id];
    if (type === T_OBJECT || type === T_ARRAY) {
      const kids = t.children(id);
      if (type === T_ARRAY) {
        const a: Plain[] = new Array(kids.length).fill(null);
        set(a);
        for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i], set: (v) => (a[i] = v) });
      } else {
        const o: { [k: string]: Plain } = {};
        set(o);
        const keys = kids.map((c) => String(t.key(c)));
        // XML repeats a tag for each occurrence: those elements become one array, in order.
        const repeated = new Set<string>();
        if (t.xmlLike) {
          const seen = new Set<string>();
          for (const k of keys) seen.has(k) ? repeated.add(k) : seen.add(k);
        }
        const put = (k: string, v: Plain) => {
          // `__proto__` must stay an ordinary key.
          if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
          else o[k] = v;
        };
        // Reversed so that children are visited (and keys inserted) in document order.
        for (let i = kids.length - 1; i >= 0; i--) {
          const k = keys[i];
          stack.push({ id: kids[i], set: repeated.has(k) ? (v) => (Array.isArray(o[k]) ? (o[k] as Plain[]).push(v) : put(k, [v])) : (v) => put(k, v) });
        }
      }
    } else set(scalar(t, id));
  }
  return out.v;
}

function scalar(t: DataTree, id: number): Plain {
  switch (t.type[id]) {
    case T_NULL:
      return null;
    case T_BOOLEAN:
      return t.value(id) as boolean;
    case T_NUMBER: {
      const raw = t.rawValue(id).replace(/_/g, '');
      if (/^[-+]?\d{16,}$/.test(raw)) {
        const big = BigInt(raw);
        if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < -BigInt(Number.MAX_SAFE_INTEGER)) return big;
      }
      const v = t.value(id);
      return typeof v === 'number' ? v : String(v ?? raw);
    }
    default:
      return String(t.value(id) ?? '');
  }
}

/** JSON without losing BigInt digits. */
export function compactJson(v: Plain, indent?: number): string {
  const s = JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `\u0000${x}\u0000` : x), indent);
  return s.includes('\\u0000') ? s.replace(/"\\u0000(-?\d+)\\u0000"/g, '$1') : s;
}

function toToml(value: Plain): string {
  if (!isRecord(value)) throw new ConvertError('TOML needs an object at the top level. Select an object, or pick another format.');
  // TOML has no null: count what gets left out, and say so.
  let nulls = 0;
  const stack: Plain[] = [value];
  while (stack.length) {
    const v = stack.pop()!;
    if (Array.isArray(v)) {
      for (const x of v) if (x === null) nulls++;
      stack.push(...v.filter((x) => x !== null && typeof x === 'object'));
    } else if (isRecord(v)) for (const x of Object.values(v)) x === null ? nulls++ : typeof x === 'object' && stack.push(x);
  }
  if (nulls) {
    const strip = (v: Plain): Plain => (Array.isArray(v) ? v.filter((x) => x !== null).map(strip) : isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, strip(x)])) : v);
    value = strip(value);
  }
  const text = tomlStringify(value);
  return nulls ? `# ${nulls} null ${nulls === 1 ? 'value was' : 'values were'} left out: TOML has no null.\n${text}` : text;
}

// ---------------------------------------------------------------- CSV / TSV

/** Rows for a table: an array of records, a map of records, or anything else as one value column. */
export function toRows(value: Plain): { columns: string[]; rows: Map<string, Plain>[] } {
  const rows: Map<string, Plain>[] = [];
  const flatten = (v: Plain, prefix: string, into: Map<string, Plain>, depth: number) => {
    if (isRecord(v) && depth < 8) for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, into, depth + 1);
    else into.set(prefix || 'value', v);
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      const row = new Map<string, Plain>();
      flatten(item, '', row, 0);
      rows.push(row);
    }
  } else if (isRecord(value) && isMapOfRecords(value)) {
    for (const [k, v] of Object.entries(value)) {
      const row = new Map<string, Plain>([['key', k]]);
      flatten(v, isRecord(v) ? '' : 'value', row, 0);
      rows.push(row);
    }
  } else {
    const row = new Map<string, Plain>();
    flatten(value, '', row, 0);
    rows.push(row);
  }
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of r.keys()) if (!seen.has(k)) seen.add(k), columns.push(k);
  return { columns, rows };
}

/** An object whose values are mostly records (ids → records): one row per key. */
function isMapOfRecords(value: { [k: string]: Plain }): boolean {
  const vals = Object.values(value);
  return vals.length > 0 && vals.filter(isRecord).length * 2 >= vals.length;
}

function toDelimited(value: Plain, sep: ',' | '\t'): string {
  const { columns, rows } = toRows(value);
  const cell = (v: Plain | undefined): string => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? compactJson(v) : String(v);
    return /[",\t\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c)).join(sep)];
  for (const r of rows) lines.push(columns.map((c) => cell(r.get(c))).join(sep));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- XML

const XML_NAME = /^[\p{L}_][\p{L}\p{N}._-]*$/u;
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');
const text = (v: Plain) => (v === null ? '' : typeof v === 'object' ? compactJson(v) : String(v));

/** XML in the shape StructLens reads XML (`@attr` keys are attributes, `#text` is element text). */
function toXml(value: Plain, rootTag?: string): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  // The element a subtree of an XML document came from keeps its tag; otherwise a
  // single top-level key becomes the root, or everything goes into <root>.
  const entries = isRecord(value) ? Object.entries(value) : [];
  if (rootTag && XML_NAME.test(rootTag)) element(rootTag, value, 0, out);
  else if (entries.length === 1 && XML_NAME.test(entries[0][0]) && !Array.isArray(entries[0][1])) element(entries[0][0], entries[0][1], 0, out);
  else element('root', value, 0, out);
  return out.join('\n') + '\n';
}

function element(name: string, value: Plain, depth: number, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) element(name, item, depth, out);
    return;
  }
  const pad = '  '.repeat(depth);
  const tag = XML_NAME.test(name) ? name : 'item';
  let attrs = tag === name ? '' : ` key="${escAttr(name)}"`;
  if (!isRecord(value)) {
    out.push(value === null ? `${pad}<${tag}${attrs}/>` : `${pad}<${tag}${attrs}>${escText(text(value))}</${tag}>`);
    return;
  }
  const children: [string, Plain][] = [];
  let body = '';
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('@') && XML_NAME.test(k.slice(1)) && (v === null || typeof v !== 'object')) attrs += ` ${k.slice(1)}="${escAttr(text(v))}"`;
    else if (k === '#text' || k === '#cdata') body += text(v);
    else children.push([k, v]);
  }
  if (!children.length) {
    out.push(body ? `${pad}<${tag}${attrs}>${escText(body)}</${tag}>` : `${pad}<${tag}${attrs}/>`);
    return;
  }
  out.push(`${pad}<${tag}${attrs}>`);
  if (body) out.push(`${pad}  ${escText(body)}`);
  if (depth > 200) out.push(`${pad}  ${escText(compactJson(Object.fromEntries(children)))}`);
  else for (const [k, v] of children) element(k, v, depth + 1, out);
  out.push(`${pad}</${tag}>`);
}
