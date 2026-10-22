/**
 * Schema inference over a DataTree: merges every value observed at the same
 * structural position into one SchemaNode (types, optionality, ranges,
 * examples, enums, string formats). Iterative and sampling-aware, so it is
 * usable on multi-million-node documents, and the result renders to compact
 * text (for LLMs/CLI), JSON Schema or TypeScript.
 */

import { oneLine, plural, withCommas } from '../util/strings';
import {
  DataTree,
  F_ATTR,
  F_TEXT,
  T_ARRAY,
  T_BOOLEAN,
  T_NULL,
  T_NUMBER,
  T_OBJECT,
  T_STRING,
  TYPE_NAMES,
  type TypeName,
} from './tree';

/**
 * Detected string formats. `date-time`, `date` and `time` are strict RFC 3339
 * (as JSON Schema defines them); `local-date-time` / `local-time` are the same
 * shapes without a UTC offset (Excel, TOML, CSV exports) and, like
 * `hex-color`, are descriptive only: they are never exported as a JSON Schema
 * `format`.
 */
export type StringFormat =
  | 'date-time'
  | 'date'
  | 'time'
  | 'local-date-time'
  | 'local-time'
  | 'email'
  | 'uri'
  | 'uuid'
  | 'ipv4'
  | 'hex-color';

/** Nesting below this many levels is not described, which keeps every consumer's recursion bounded. */
export const MAX_SCHEMA_DEPTH = 256;

export interface SchemaNode {
  /** Values observed at this position. */
  count: number;
  types: Partial<Record<TypeName, number>>;
  /** Object instances observed (fields with fewer occurrences are optional). */
  objects: number;
  fields?: Map<string, SchemaNode>;
  /** Set when an object has dynamic keys (ids, dates…): the merged value schema. */
  mapOf?: SchemaNode;
  mapKeys?: number;
  mapKeyExamples?: string[];
  items?: SchemaNode;
  minItems?: number;
  maxItems?: number;
  examples: string[];
  /** Distinct primitive values, or null once there are too many for an enum. */
  distinct: Map<string, number> | null;
  min?: number;
  max?: number;
  allIntegers: boolean;
  minLength?: number;
  maxLength?: number;
  /** Format every string seen so far satisfies: undefined before the first string, null once they share none. */
  format?: StringFormat | null;
  trueCount: number;
  /** XML: field is an attribute / text node. */
  attr?: boolean;
  text?: boolean;
  /** Object (node id) that last contributed this field, so a duplicated key counts once. */
  seenIn?: number;
}

export interface SchemaResult {
  root: SchemaNode;
  /** True when large arrays were sampled rather than fully scanned. */
  sampled: boolean;
  /** True when values nested deeper than MAX_SCHEMA_DEPTH were left undescribed. */
  depthLimited: boolean;
  nodesVisited: number;
  ms: number;
}

export interface InferOptions {
  /** Arrays longer than this are sampled evenly (default 5,000 items). */
  sampleArrayItems?: number;
  /** Objects with more distinct keys than this become maps (default 150). */
  maxFields?: number;
  /** Hard cap on visited nodes (default 5,000,000). */
  maxNodes?: number;
}

const MAX_DISTINCT = 12;
const MAX_EXAMPLES = 3;

export function newSchema(): SchemaNode {
  return { count: 0, types: {}, objects: 0, examples: [], distinct: new Map(), allIntegers: true, trueCount: 0 };
}

export function inferSchema(tree: DataTree, rootId = tree.root, options: InferOptions = {}): SchemaResult {
  const started = now();
  const sampleItems = options.sampleArrayItems ?? 5000;
  const maxFields = options.maxFields ?? 150;
  const maxNodes = options.maxNodes ?? 5_000_000;
  const root = newSchema();
  let visited = 0;
  let sampled = false;
  let depthLimited = false;

  interface Frame {
    id: number;
    schema: SchemaNode;
    child: number;
    index: number;
    stride: number;
    isArray: boolean;
    /** XML: names of the children (small elements only), and those that repeat (negated once counted as an array), as toJS() groups them. */
    keys: string[] | null;
    repeats: Map<string, number> | null;
  }

  const stack: Frame[] = [];
  const push = (id: number, schema: SchemaNode) => {
    const isArray = tree.type[id] === T_ARRAY;
    const n = tree.childCount[id];
    let stride = 1;
    if (isArray && n > sampleItems) {
      stride = Math.ceil(n / sampleItems);
      sampled = true;
    }
    let keys: string[] | null = null;
    let repeats: Map<string, number> | null = null;
    if (!isArray && tree.xmlLike && n > 1) {
      if (n <= 64) {
        keys = new Array<string>(n);
        for (let c = tree.firstChild(id), i = 0; c >= 0; c = tree.nextSibling(c), i++) keys[i] = String(tree.key(c));
        repeats = repeatedIn(keys);
      } else repeats = repeatedKeys(tree, id, maxNodes - visited + 1); // later children are never visited
    }
    stack.push({ id, schema, child: tree.firstChild(id), index: 0, stride, isArray, keys, repeats });
  };

  observe(tree, root, rootId);
  visited++;
  if (tree.isContainer(rootId)) push(rootId, root);

  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.child < 0 || visited >= maxNodes) {
      if (visited >= maxNodes) sampled = true;
      stack.pop();
      continue;
    }
    const c = f.child;
    // Advance (skipping items for sampled arrays).
    let next = tree.nextSibling(c);
    for (let s = 1; s < f.stride && next >= 0; s++) next = tree.nextSibling(next);
    f.child = next;
    const index = f.index;
    f.index += f.stride;

    let target: SchemaNode;
    let duplicate = false;
    if (f.isArray) {
      target = f.schema.items ??= newSchema();
    } else {
      const parent = f.schema;
      const key = f.keys ? f.keys[index] : String(tree.key(c));
      const repeats = f.repeats?.get(key);
      if (repeats !== undefined && repeats < 0) {
        // A later XML sibling with a repeated name: one more item of the array noted at the first.
        target = (parent.mapOf ?? parent.fields!.get(key)!).items!;
      } else {
        if (parent.mapOf) {
          target = parent.mapOf;
          noteMapKey(parent, key);
        } else {
          const fields = (parent.fields ??= new Map());
          let s = fields.get(key);
          if (!s) {
            s = newSchema();
            if (tree.flags[c] & F_ATTR) s.attr = true;
            if (tree.flags[c] & F_TEXT) s.text = true;
            fields.set(key, s);
            if (fields.size > maxFields || (fields.size >= 20 && looksDynamic(fields))) {
              toMap(parent);
              target = parent.mapOf!;
              noteMapKey(parent, key);
            } else target = s;
          } else target = s;
        }
        if (repeats !== undefined) {
          // XML siblings sharing a name are one array value, as toJS() builds it.
          f.repeats!.set(key, -repeats);
          noteArray(target, repeats);
          target = target.items!;
        } else if (target !== parent.mapOf) {
          duplicate = target.seenIn === f.id;
          target.seenIn = f.id;
        }
      }
    }
    observe(tree, target, c);
    // A key repeated within one object (last one wins in toJS()) counts once towards presence.
    if (duplicate) target.count--;
    visited++;
    if (tree.isContainer(c)) {
      if (stack.length < MAX_SCHEMA_DEPTH) push(c, target);
      else depthLimited = true;
    }
  }

  return { root, sampled, depthLimited, nodesVisited: visited, ms: now() - started };
}

/** Like repeatedKeys() for a few names, without a Map unless one repeats. */
function repeatedIn(keys: string[]): Map<string, number> | null {
  let out: Map<string, number> | null = null;
  for (let j = 1; j < keys.length; j++) {
    for (let i = 0; i < j; i++) {
      if (keys[i] !== keys[j]) continue;
      out ??= new Map();
      out.set(keys[j], (out.get(keys[j]) ?? 1) + 1);
      break;
    }
  }
  return out;
}

/** Names occurring more than once among the first `limit` children of `id`, with their counts (null when none do). */
function repeatedKeys(tree: DataTree, id: number, limit: number): Map<string, number> | null {
  let out: Map<string, number> | null = null;
  const seen = new Map<string, number>();
  for (let c = tree.firstChild(id), i = 0; c >= 0 && i < limit; c = tree.nextSibling(c), i++) {
    const k = String(tree.key(c));
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > 1) (out ??= new Map()).set(k, n);
  }
  return out;
}

function noteArray(s: SchemaNode, n: number): void {
  s.count++;
  s.types.array = (s.types.array ?? 0) + 1;
  s.minItems = s.minItems === undefined ? n : Math.min(s.minItems, n);
  s.maxItems = s.maxItems === undefined ? n : Math.max(s.maxItems, n);
  s.items ??= newSchema();
}

function observe(tree: DataTree, s: SchemaNode, id: number): void {
  const t = tree.type[id];
  if (t === T_ARRAY) {
    noteArray(s, tree.childCount[id]);
    return;
  }
  s.count++;
  const name = TYPE_NAMES[t];
  s.types[name] = (s.types[name] ?? 0) + 1;
  switch (t) {
    case T_OBJECT:
      s.objects++;
      return;
    case T_STRING: {
      const v = tree.stringValue(id);
      s.minLength = s.minLength === undefined ? v.length : Math.min(s.minLength, v.length);
      s.maxLength = s.maxLength === undefined ? v.length : Math.max(s.maxLength, v.length);
      noteDistinct(s, v.length <= 60 ? JSON.stringify(v) : null);
      if (s.examples.length < MAX_EXAMPLES && v.length > 0) {
        const ex = JSON.stringify(oneLine(v, 40));
        if (!s.examples.includes(ex)) s.examples.push(ex);
      }
      // Every string is checked: a format is only reported when all of them satisfy it.
      if (s.format === undefined) s.format = detectStringFormat(v) ?? null;
      else if (s.format !== null && !FORMAT_TESTS[s.format](v)) s.format = null;
      return;
    }
    case T_NUMBER: {
      const raw = tree.rawValue(id);
      const v = numberValue(raw);
      if (Number.isFinite(v)) {
        s.min = s.min === undefined ? v : Math.min(s.min, v);
        s.max = s.max === undefined ? v : Math.max(s.max, v);
      }
      if (!/^[+-]?(0x[0-9a-f_]+|\d[\d_]*)$/i.test(raw)) s.allIntegers = false;
      noteDistinct(s, raw);
      if (s.examples.length < MAX_EXAMPLES && !s.examples.includes(raw)) s.examples.push(oneLine(raw, 30));
      return;
    }
    case T_BOOLEAN:
      if (tree.value(id) === true) s.trueCount++;
      return;
    case T_NULL:
      return;
  }
}

function noteDistinct(s: SchemaNode, v: string | null): void {
  if (!s.distinct) return;
  if (v === null) {
    s.distinct = null;
    return;
  }
  s.distinct.set(v, (s.distinct.get(v) ?? 0) + 1);
  if (s.distinct.size > MAX_DISTINCT) s.distinct = null;
}

function noteMapKey(s: SchemaNode, key: string): void {
  s.mapKeys = (s.mapKeys ?? 0) + 1;
  const ex = (s.mapKeyExamples ??= []);
  if (ex.length < MAX_EXAMPLES && !ex.includes(key)) ex.push(key);
}

const DYNAMIC_KEY = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{4}-\d{2}-\d{2}.*|[A-Z]{2,3}|v?\d+(\.\d+)+)$/i;

/** Objects keyed by ids/dates/versions are maps, not records. */
function looksDynamic(fields: Map<string, SchemaNode>): boolean {
  let dyn = 0;
  for (const k of fields.keys()) if (DYNAMIC_KEY.test(k)) dyn++;
  return dyn / fields.size >= 0.8;
}

/** Collapses an object's fields into a single map value schema. */
function toMap(s: SchemaNode): void {
  const merged = newSchema();
  let keys = 0;
  const examples: string[] = [];
  for (const [k, f] of s.fields ?? []) {
    mergeInto(merged, f);
    keys += f.count;
    if (examples.length < MAX_EXAMPLES) examples.push(k);
  }
  s.mapOf = merged;
  s.mapKeys = keys;
  s.mapKeyExamples = examples;
  s.fields = undefined;
}

export function mergeInto(a: SchemaNode, b: SchemaNode): void {
  a.count += b.count;
  a.objects += b.objects;
  for (const [t, n] of Object.entries(b.types)) a.types[t as TypeName] = (a.types[t as TypeName] ?? 0) + (n ?? 0);
  if (b.fields) {
    a.fields ??= new Map();
    for (const [k, f] of b.fields) {
      const ex = a.fields.get(k);
      if (ex) mergeInto(ex, f);
      else a.fields.set(k, cloneSchema(f));
    }
  }
  if (b.mapOf) {
    a.mapOf ??= newSchema();
    mergeInto(a.mapOf, b.mapOf);
    a.mapKeys = (a.mapKeys ?? 0) + (b.mapKeys ?? 0);
  }
  if (b.items) {
    a.items ??= newSchema();
    mergeInto(a.items, b.items);
  }
  if (b.minItems !== undefined) a.minItems = a.minItems === undefined ? b.minItems : Math.min(a.minItems, b.minItems);
  if (b.maxItems !== undefined) a.maxItems = a.maxItems === undefined ? b.maxItems : Math.max(a.maxItems, b.maxItems);
  if (b.min !== undefined) a.min = a.min === undefined ? b.min : Math.min(a.min, b.min);
  if (b.max !== undefined) a.max = a.max === undefined ? b.max : Math.max(a.max, b.max);
  if (b.minLength !== undefined) a.minLength = a.minLength === undefined ? b.minLength : Math.min(a.minLength, b.minLength);
  if (b.maxLength !== undefined) a.maxLength = a.maxLength === undefined ? b.maxLength : Math.max(a.maxLength, b.maxLength);
  a.allIntegers &&= b.allIntegers;
  a.trueCount += b.trueCount;
  for (const ex of b.examples) if (a.examples.length < MAX_EXAMPLES && !a.examples.includes(ex)) a.examples.push(ex);
  if (!a.distinct || !b.distinct) a.distinct = null;
  else {
    for (const [v, n] of b.distinct) a.distinct.set(v, (a.distinct.get(v) ?? 0) + n);
    if (a.distinct.size > MAX_DISTINCT) a.distinct = null;
  }
  if (b.format !== undefined) a.format = a.format === undefined || a.format === b.format ? b.format : null;
}

function cloneSchema(s: SchemaNode): SchemaNode {
  const c = newSchema();
  mergeInto(c, s);
  c.attr = s.attr;
  c.text = s.text;
  return c;
}

/** Value of a number literal, including JSON5 signed hex and `_` separators. */
function numberValue(raw: string): number {
  const s = raw.indexOf('_') >= 0 ? raw.replace(/_/g, '') : raw;
  const n = Number(s);
  if (n === n || !/^[+-]0x/i.test(s)) return n;
  const hex = Number(s.slice(1));
  return s[0] === '-' ? -hex : hex;
}

// String formats. The exported ones accept a subset of what ajv-formats'
// full mode (and the RFCs behind it) accepts, so an exported schema always
// validates the values it was inferred from.
const DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
/** scheme://authority/path?query#fragment using only RFC 3986 characters (IPv6 hosts are not recognised). */
const URI =
  /^[a-z][a-z0-9+.-]*:\/\/(?:(?:[\w\-.~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:[\w\-.~!$&'()*+,;=]|%[0-9a-f]{2})*(?::\d*)?(?:\/(?:[\w\-.~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*(?:\?(?:[\w\-.~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[\w\-.~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// Dates and times are parsed by hand: every string of a field is checked, so this stays allocation-free.

/** The `n`-digit number at `i`, or -1. */
function digitsAt(v: string, i: number, n: number): number {
  let x = 0;
  for (let k = i; k < i + n; k++) {
    const c = v.charCodeAt(k) - 48;
    if (!(c >= 0 && c <= 9)) return -1;
    x = x * 10 + c;
  }
  return x;
}

/** A valid `YYYY-MM-DD` at `i`. */
function isDateAt(v: string, i: number): boolean {
  if (v.charCodeAt(i + 4) !== 45 || v.charCodeAt(i + 7) !== 45) return false;
  const year = digitsAt(v, i, 4);
  const month = digitsAt(v, i + 5, 2);
  const day = digitsAt(v, i + 8, 2);
  if (year < 0 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= (month === 2 && !leap ? 28 : DAYS[month]);
}

function isDate(v: string): boolean {
  return v.length === 10 && isDateAt(v, 0);
}

/**
 * The time from `i` to the end: `time` for an RFC 3339 full-time (seconds
 * and offset), `local-time` for hh:mm[:ss[.f]] without an offset.
 */
function timeKindAt(v: string, i: number): 'time' | 'local-time' | undefined {
  const n = v.length;
  if (v.charCodeAt(i + 2) !== 58) return undefined;
  const h = digitsAt(v, i, 2);
  const m = digitsAt(v, i + 3, 2);
  if (h < 0 || h > 23 || m < 0 || m > 59) return undefined;
  let j = i + 5;
  let seconds = false;
  if (v.charCodeAt(j) === 58) {
    const s = digitsAt(v, j + 1, 2);
    if (s < 0 || s > 59) return undefined;
    seconds = true;
    j += 3;
    if (v.charCodeAt(j) === 46) {
      const f = ++j;
      while (j < n && v.charCodeAt(j) >= 48 && v.charCodeAt(j) <= 57) j++;
      if (j === f) return undefined;
    }
  }
  if (j === n) return 'local-time';
  const c = v.charCodeAt(j);
  if ((c === 90 || c === 122) && j + 1 === n) return seconds ? 'time' : undefined; // Z
  if ((c !== 43 && c !== 45) || j + 6 !== n || v.charCodeAt(j + 3) !== 58) return undefined;
  const oh = digitsAt(v, j + 1, 2);
  const om = digitsAt(v, j + 4, 2);
  return seconds && oh >= 0 && oh <= 23 && om >= 0 && om <= 59 ? 'time' : undefined;
}

function timeKind(v: string): 'time' | 'local-time' | undefined {
  return v.length >= 5 ? timeKindAt(v, 0) : undefined;
}

/** `date-time` (RFC 3339: `T`, seconds, offset) or `local-date-time` (no offset; `T` or space). */
function dateTimeKind(v: string): 'date-time' | 'local-date-time' | undefined {
  const sep = v.charCodeAt(10);
  if (v.length < 16 || !(sep === 84 || sep === 116 || sep === 32) || !isDateAt(v, 0)) return undefined;
  const t = timeKindAt(v, 11);
  if (t === 'local-time') return 'local-date-time';
  return t === 'time' && sep !== 32 ? 'date-time' : undefined;
}

const FORMAT_TESTS: Record<StringFormat, (v: string) => boolean> = {
  'date-time': (v) => dateTimeKind(v) === 'date-time',
  'local-date-time': (v) => dateTimeKind(v) === 'local-date-time',
  date: isDate,
  time: (v) => timeKind(v) === 'time',
  'local-time': (v) => timeKind(v) === 'local-time',
  uuid: (v) => UUID.test(v),
  email: (v) => v.length <= 2048 && EMAIL.test(v),
  uri: (v) => v.length <= 2048 && URI.test(v),
  ipv4: (v) => IPV4.test(v),
  'hex-color': (v) => HEX_COLOR.test(v),
};

/** Formats exported as JSON Schema `format`. */
const JSON_SCHEMA_FORMATS = new Set<StringFormat>(['date-time', 'date', 'time', 'email', 'uri', 'uuid', 'ipv4']);

export function detectStringFormat(v: string): StringFormat | undefined {
  if (v.length < 3 || v.length > 2048) return undefined;
  for (const name of Object.keys(FORMAT_TESTS) as StringFormat[]) if (FORMAT_TESTS[name](v)) return name;
  return undefined;
}

// ---------------------------------------------------------------- summaries

/** String format shared by every observed string, if any. */
export function schemaFormat(s: SchemaNode): StringFormat | undefined {
  return s.format ?? undefined;
}

/** Enum values when there are few distinct values seen many times. */
export function schemaEnum(s: SchemaNode): string[] | undefined {
  if (!s.distinct || s.distinct.size < 2) return undefined;
  const prims = (s.types.string ?? 0) + (s.types.number ?? 0);
  if (prims < s.distinct.size * 3 || prims < 6) return undefined;
  return [...s.distinct.keys()];
}

/** Short type expression: `string | null`, `array<object>`, `map<string, number>`. */
export function typeExpr(s: SchemaNode, depth = 0): string {
  const parts: string[] = [];
  const order: TypeName[] = ['object', 'array', 'string', 'number', 'boolean', 'null'];
  for (const t of order) {
    if (!s.types[t]) continue;
    if (t === 'number') parts.push(s.allIntegers ? 'integer' : 'number');
    else if (t === 'array') {
      const inner = s.items && s.items.count > 0 && depth < 3 ? typeExpr(s.items, depth + 1) : 'unknown';
      parts.push(`array<${inner}>`);
    } else if (t === 'object' && s.mapOf) {
      parts.push(`map<string, ${depth < 3 ? typeExpr(s.mapOf, depth + 1) : '…'}>`);
    } else parts.push(t);
  }
  return parts.join(' | ') || 'unknown';
}

export interface SchemaTextOptions {
  maxDepth?: number;
  maxFields?: number;
  showExamples?: boolean;
}

/** Compact, indented text rendering for LLMs, the CLI and tooltips. */
export function schemaToText(result: SchemaResult | SchemaNode, options: SchemaTextOptions = {}): string {
  const root = 'root' in result ? result.root : result;
  const maxDepth = options.maxDepth ?? 12;
  const maxFields = options.maxFields ?? 60;
  const showExamples = options.showExamples ?? true;
  const out: string[] = [];
  out.push(`$: ${describe(root, showExamples)}`);
  const walk = (s: SchemaNode, indent: string, depth: number) => {
    if (depth >= maxDepth) return;
    if (s.fields && !s.mapOf) {
      const entries = [...s.fields.entries()];
      const shown = entries.slice(0, maxFields);
      shown.forEach(([k, f], i) => {
        const last = i === shown.length - 1 && entries.length <= maxFields;
        const optional = f.count < s.objects;
        const pct = optional && s.objects ? ` (${Math.round((f.count / s.objects) * 100)}%)` : '';
        out.push(`${indent}${last ? '└─' : '├─'} ${fieldName(k)}${optional ? '?' : ''}: ${describe(f, showExamples)}${pct}`);
        walk(f, indent + (last ? '   ' : '│  '), depth + 1);
      });
      if (entries.length > maxFields) out.push(`${indent}└─ … ${entries.length - maxFields} more fields`);
    } else if (s.mapOf) {
      const keys = s.mapKeyExamples?.length ? ` keys e.g. ${s.mapKeyExamples.map((k) => JSON.stringify(k)).join(', ')}` : '';
      out.push(`${indent}└─ [key]: ${describe(s.mapOf, showExamples)}${keys}`);
      walk(s.mapOf, indent + '   ', depth + 1);
    }
    if (s.items && s.items.count > 0 && (s.items.fields || s.items.mapOf || s.items.items)) {
      out.push(`${indent}└─ []: ${describe(s.items, showExamples)}`);
      walk(s.items, indent + '   ', depth + 1);
    }
  };
  walk(root, '', 0);
  if ('root' in result && result.sampled) out.push('(large arrays were sampled)');
  if ('root' in result && result.depthLimited) out.push(`(values nested deeper than ${MAX_SCHEMA_DEPTH} levels are not described)`);
  return out.join('\n');
}

function fieldName(k: string): string {
  return /^[@#]?[A-Za-z_$][\w$.:-]*$/.test(k) ? k : JSON.stringify(k);
}

function describe(s: SchemaNode, showExamples: boolean): string {
  let d = typeExpr(s);
  const notes: string[] = [];
  if (s.types.array) {
    if (s.minItems !== undefined) notes.push(s.minItems === s.maxItems ? plural(s.minItems, 'item') : `${withCommas(s.minItems)}–${withCommas(s.maxItems!)} items`);
  }
  if (s.types.object && s.mapOf) notes.push(plural(s.mapKeys ?? 0, 'key'));
  else if (s.types.object && s.fields) notes.push(plural(s.fields.size, 'field'));
  const fmt = schemaFormat(s);
  if (fmt) notes.push(`format ${fmt}`);
  const en = schemaEnum(s);
  if (en) notes.push(`enum ${en.slice(0, 8).join(' | ')}${en.length > 8 ? ' | …' : ''}`);
  else if (s.types.number && s.min !== undefined) notes.push(s.min === s.max ? `= ${s.min}` : `${fmtNum(s.min)}…${fmtNum(s.max!)}`);
  else if (showExamples && s.examples.length && (s.types.string || s.types.number)) notes.push(`e.g. ${s.examples.join(', ')}`);
  if (s.types.boolean && s.types.boolean > 1) notes.push(`${Math.round((s.trueCount / s.types.boolean) * 100)}% true`);
  if (notes.length) d += `  ${notes.join(', ')}`;
  return d;
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

// ---------------------------------------------------------------- exports

/** A distinct-value key (JSON text of a string, or a number literal) as a JSON value; undefined when JSON cannot hold it. */
function jsonValue(key: string): string | number | undefined {
  if (key.charCodeAt(0) === 34) return JSON.parse(key) as string;
  const n = numberValue(key);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * `enum` for JSON Schema: every observed value must be listed, so nulls and
 * booleans are added and nothing is emitted when a value cannot be (objects,
 * arrays, NaN/Infinity).
 */
function jsonEnum(s: SchemaNode): unknown[] | undefined {
  const en = schemaEnum(s);
  if (!en || s.types.object || s.types.array) return undefined;
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const key of en) {
    const v = jsonValue(key);
    if (v === undefined) return undefined;
    const id = typeof v === 'number' ? `n${v}` : `s${v}`; // 1 and 1.0 are one value
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(v);
  }
  if (s.types.boolean) {
    if (s.trueCount > 0) out.push(true);
    if (s.trueCount < s.types.boolean) out.push(false);
  }
  if (s.types.null) out.push(null);
  return out;
}

export function schemaToJsonSchema(result: SchemaResult | SchemaNode, title?: string): Record<string, unknown> {
  const root = 'root' in result ? result.root : result;
  const conv = (s: SchemaNode, depth: number): Record<string, unknown> => {
    const types: string[] = [];
    const out: Record<string, unknown> = {};
    for (const t of Object.keys(s.types) as TypeName[]) {
      if (t === 'number') types.push(s.allIntegers ? 'integer' : 'number');
      else if (t !== 'unknown') types.push(t);
    }
    if (types.length === 1) out.type = types[0];
    else if (types.length > 1) out.type = types;
    if (depth >= MAX_SCHEMA_DEPTH) return out;
    if (s.types.object) {
      if (s.mapOf) out.additionalProperties = conv(s.mapOf, depth + 1);
      else if (s.fields) {
        const props: Record<string, unknown> = {};
        const required: string[] = [];
        for (const [k, f] of s.fields) {
          props[k] = conv(f, depth + 1);
          if (f.count >= s.objects) required.push(k);
        }
        out.properties = props;
        if (required.length) out.required = required;
      }
    }
    if (s.types.array && s.items && s.items.count > 0) out.items = conv(s.items, depth + 1);
    const fmt = schemaFormat(s);
    if (fmt && JSON_SCHEMA_FORMATS.has(fmt)) out.format = fmt;
    const en = jsonEnum(s);
    if (en) out.enum = en;
    else if (s.examples.length && (s.types.string || s.types.number)) {
      const examples = s.examples.map(jsonValue).filter((v) => v !== undefined);
      if (examples.length) out.examples = examples;
    }
    return out;
  };
  const sampled = 'root' in result && result.sampled ? { $comment: 'Inferred from a sample of the large arrays.' } : {};
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', ...(title ? { title } : {}), ...sampled, ...conv(root, 0) };
}

/** TypeScript declarations with one named interface per object shape. */
export function schemaToTypeScript(result: SchemaResult | SchemaNode, rootName = 'Root'): string {
  const root = 'root' in result ? result.root : result;
  const decls: string[] = [];
  const used = new Set<string>();
  const nameFor = (hint: string) => {
    let base = hint.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^\d+/, '');
    base = base ? base[0].toUpperCase() + base.slice(1) : 'Item';
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}${i}`;
    used.add(name);
    return name;
  };
  const tsType = (s: SchemaNode, hint: string, depth: number): string => {
    if (depth >= MAX_SCHEMA_DEPTH) return 'unknown';
    const parts: string[] = [];
    if (s.types.object) {
      if (s.mapOf) parts.push(`Record<string, ${tsType(s.mapOf, singular(hint), depth + 1)}>`);
      else if (s.fields && s.fields.size) parts.push(declare(s, hint, depth));
      else parts.push('Record<string, unknown>');
    }
    if (s.types.array) {
      const inner = s.items && s.items.count ? tsType(s.items, singular(hint), depth + 1) : 'unknown';
      parts.push(/[|&]/.test(inner) ? `Array<${inner}>` : `${inner}[]`);
    }
    if (s.types.string) {
      const en = schemaEnum(s);
      parts.push(en && !s.types.number ? en.join(' | ') : 'string');
    }
    if (s.types.number) parts.push('number');
    if (s.types.boolean) parts.push('boolean');
    if (s.types.null) parts.push('null');
    return parts.join(' | ') || 'unknown';
  };
  const declare = (s: SchemaNode, hint: string, depth: number): string => {
    const name = nameFor(hint);
    const lines: string[] = [];
    for (const [k, f] of s.fields!) {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
      lines.push(`  ${key}${f.count < s.objects ? '?' : ''}: ${tsType(f, k, depth + 1)};`);
    }
    decls.push(`export interface ${name} {\n${lines.join('\n')}\n}`);
    return name;
  };
  const top = tsType(root, rootName, 0);
  if (!used.has(top)) decls.push(`export type ${nameFor(rootName)} = ${top};`);
  return decls.reverse().join('\n\n') + '\n';
}

function singular(s: string): string {
  if (/ies$/i.test(s)) return s.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/i.test(s)) return s.slice(0, -2);
  if (/s$/i.test(s) && !/ss$/i.test(s)) return s.slice(0, -1);
  return `${s}Item`;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

