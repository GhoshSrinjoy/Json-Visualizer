/**
 * Changes to a document made from the visualizer (set a value, rename a key,
 * delete an entry, add a property or item), as minimal text edits at the
 * parser's source positions: formatting and comments elsewhere stay as they are.
 * JSON, JSONC, JSON5, JSON Lines and YAML are supported.
 */

import { DataTree, F_ALIAS, F_COPY, F_KEY_SYNTH, F_NO_POS, F_SYNTHETIC, T_ARRAY, T_OBJECT } from './tree';

export interface TextEdit {
  offset: number;
  length: number;
  text: string;
}

export type ValueKind = 'string' | 'number' | 'boolean' | 'null' | 'json';

export type EditOp =
  | { kind: 'set'; id: number; type: ValueKind; value: string }
  | { kind: 'rename'; id: number; key: string }
  | { kind: 'delete'; id: number }
  /** Adds a property (objects: `key` required) or an item (arrays) at the end of container `id`. */
  | { kind: 'add'; id: number; key?: string; type: ValueKind; value: string };

export type EditMode = EditOp['kind'];

export class EditError extends Error {}

export interface EditCaps {
  set: boolean;
  rename: boolean;
  delete: boolean;
  add: boolean;
}

const JSON_FORMATS = new Set(['json', 'jsonc', 'json5', 'jsonl']);
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const YAML_PLAIN = /^[A-Za-z_][\w .\/@-]*$/;
const YAML_RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;

/** What can be changed about node `id`. */
export function editCaps(t: DataTree, id: number): EditCaps {
  const none = { set: false, rename: false, delete: false, add: false };
  const yaml = t.format === 'yaml';
  if (!JSON_FORMATS.has(t.format) && !yaml) return none;
  if (t.errors.some((e) => (e as { severity?: string }).severity !== 'warning')) return none;
  if (!positioned(t, id)) return none;
  const container = t.type[id] === T_OBJECT || t.type[id] === T_ARRAY;
  const parent = t.parent[id];
  const member = id !== t.root && parent >= 0 && positioned(t, parent);
  const blockContainer = yaml && container && !isFlow(t, id);
  return {
    set: !(yaml && container),
    rename: member && t.type[parent] === T_OBJECT && t.keyEnd[id] > t.keyPos[id],
    delete: member,
    add: container && (!yaml || (blockContainer && t.childCount[id] > 0) || isFlow(t, id)),
  };
}

export function editsFor(t: DataTree, op: EditOp): TextEdit[] {
  const caps = editCaps(t, op.id);
  const yaml = t.format === 'yaml';
  switch (op.kind) {
    case 'set': {
      if (!caps.set) throw new EditError('This value cannot be edited here.');
      const [from, to] = tokenRange(t, op.id);
      return [{ offset: from, length: to - from, text: literal(op.type, op.value, yaml) }];
    }
    case 'rename': {
      if (!caps.rename) throw new EditError('This key cannot be renamed here.');
      const parent = t.parent[op.id];
      for (let c = t.firstChild(parent); c >= 0; c = t.nextSibling(c)) if (c !== op.id && t.key(c) === op.key) throw new EditError(`There is already a key "${op.key}" here.`);
      return [{ offset: t.keyPos[op.id], length: t.keyEnd[op.id] - t.keyPos[op.id], text: keyLiteral(op.key, yaml) }];
    }
    case 'delete':
      if (!caps.delete) throw new EditError('This entry cannot be deleted here.');
      return yaml && !isFlow(t, t.parent[op.id]) ? deleteBlock(t, op.id) : deleteFlow(t, op.id);
    case 'add': {
      if (!caps.add) throw new EditError('Nothing can be added here.');
      const isObject = t.type[op.id] === T_OBJECT;
      if (isObject && op.key === undefined) throw new EditError('A new property needs a key.');
      if (isObject) for (let c = t.firstChild(op.id); c >= 0; c = t.nextSibling(c)) if (t.key(c) === op.key) throw new EditError(`There is already a key "${op.key}" here.`);
      const value = literal(op.type, op.value, yaml);
      return yaml && !isFlow(t, op.id) ? addBlock(t, op.id, isObject ? op.key! : undefined, value) : addFlow(t, op.id, isObject ? op.key! : undefined, value, yaml);
    }
  }
}

/** Applies edits (any order) to `text`. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.offset - a.offset)) out = out.slice(0, e.offset) + e.text + out.slice(e.offset + e.length);
  return out;
}

/** Source text for a value of the given kind; throws when the text isn't one. */
export function literal(type: ValueKind, value: string, yaml = false): string {
  const v = value.trim();
  switch (type) {
    case 'string':
      return yaml && YAML_PLAIN.test(value) && !YAML_RESERVED.test(value) && !/[:#]\s|\s$/.test(value) ? value : JSON.stringify(value);
    case 'number':
      if (!NUMBER.test(v)) throw new EditError(`"${value}" is not a number.`);
      return v;
    case 'boolean':
      if (v !== 'true' && v !== 'false') throw new EditError('A boolean is true or false.');
      return v;
    case 'null':
      return 'null';
    case 'json':
      try {
        const parsed: unknown = JSON.parse(v);
        // YAML block context: keep it on one line (JSON is valid YAML flow style).
        return yaml ? JSON.stringify(parsed) : v;
      } catch (e) {
        throw new EditError(`Not valid JSON: ${(e as Error).message}`);
      }
  }
}

function keyLiteral(key: string, yaml: boolean): string {
  return yaml && YAML_PLAIN.test(key) && !YAML_RESERVED.test(key) ? key : JSON.stringify(key);
}

function positioned(t: DataTree, id: number): boolean {
  return !(t.flags[id] & (F_NO_POS | F_SYNTHETIC | F_ALIAS | F_COPY)) && t.valEnd[id] >= t.valPos[id];
}

/** Flow collection (`{…}` / `[…]`): always for JSON, by syntax for YAML. */
function isFlow(t: DataTree, id: number): boolean {
  if (t.format !== 'yaml') return true;
  const c = t.text[t.valPos[id]];
  return c === '{' || c === '[';
}

/** The whole value token, including quotes YAML positions may leave out. */
function tokenRange(t: DataTree, id: number): [number, number] {
  let from = t.valPos[id];
  let to = t.valEnd[id];
  const q = t.text[from - 1];
  if ((q === '"' || q === "'") && t.text[to] === q && t.text[from] !== q) {
    from--;
    to++;
  }
  return [from, to];
}

/** Start of the member: its key when it has one. */
function memberStart(t: DataTree, id: number): number {
  const p = t.parent[id];
  return t.type[p] === T_OBJECT && !(t.flags[id] & F_KEY_SYNTH && t.keyEnd[id] <= t.keyPos[id]) ? Math.min(t.keyPos[id], t.valPos[id]) : tokenRange(t, id)[0];
}

function memberEnd(t: DataTree, id: number): number {
  return Math.max(tokenRange(t, id)[1], t.valEnd[id]);
}

function siblings(t: DataTree, id: number): { prev: number; next: number } {
  const p = t.parent[id];
  let prev = -1;
  for (let c = t.firstChild(p); c >= 0 && c !== id; c = t.nextSibling(c)) prev = c;
  return { prev: neighbour(t, prev), next: neighbour(t, t.nextSibling(id)) };
}

/** Edit ranges also come from neighbouring entries, which must sit where they appear (not alias copies). */
function neighbour(t: DataTree, id: number): number {
  if (id >= 0 && !positioned(t, id)) throw new EditError('An entry next to this one is a YAML alias or has no position; make this change in the editor.');
  return id;
}

/** Removes a member of a `{…}`/`[…]` container together with one separating comma. */
function deleteFlow(t: DataTree, id: number): TextEdit[] {
  const { prev, next } = siblings(t, id);
  const start = memberStart(t, id);
  if (next >= 0) {
    const to = memberStart(t, next);
    return [{ offset: start, length: to - start, text: '' }];
  }
  if (prev >= 0) {
    const from = memberEnd(t, prev);
    const end = memberEnd(t, id);
    return [{ offset: from, length: end - from, text: '' }];
  }
  // Only member: leave an empty container.
  const p = t.parent[id];
  const open = t.valPos[p] + 1;
  const close = t.text.lastIndexOf(t.type[p] === T_OBJECT ? '}' : ']', t.valEnd[p] - 1);
  return [{ offset: open, length: Math.max(0, close - open), text: '' }];
}

const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
const lineEnd = (text: string, at: number) => {
  const n = text.indexOf('\n', at);
  return n < 0 ? text.length : n + 1;
};

/** YAML block collections: removes the member's whole lines (or empties the parent). */
function deleteBlock(t: DataTree, id: number): TextEdit[] {
  const p = t.parent[id];
  if (t.childCount[p] === 1) {
    const [from, to] = [t.valPos[p], t.valEnd[p]];
    return [{ offset: from, length: to - from, text: t.type[p] === T_OBJECT ? '{}' : '[]' }];
  }
  const text = t.text;
  // Sequence items start at their dash.
  let start = memberStart(t, id);
  if (t.type[p] === T_ARRAY) start = text.lastIndexOf('-', start);
  const from = lineStart(text, start);
  // Only whitespace may precede the member on its line (it starts the line).
  if (text.slice(from, start).trim() !== '') throw new EditError('This entry shares a line with another; edit it in the editor.');
  const to = lineEnd(text, Math.max(start, memberEnd(t, id) - 1));
  return [{ offset: from, length: to - from, text: '' }];
}

function addFlow(t: DataTree, id: number, key: string | undefined, value: string, yaml: boolean): TextEdit[] {
  const text = t.text;
  const kids = t.children(id, 0, Infinity).map((c) => neighbour(t, c));
  const member = (sep: string) => (key === undefined ? value : `${keyLiteral(key, yaml)}${sep}${value}`);
  if (!kids.length) {
    const close = text.lastIndexOf(t.type[id] === T_OBJECT ? '}' : ']', t.valEnd[id] - 1);
    const open = t.valPos[id] + 1;
    return [{ offset: open, length: Math.max(0, close - open), text: member(': ') }];
  }
  const first = kids[0];
  const last = kids[kids.length - 1];
  // Reuse the document's own layout: the gap between members (indentation after the last line break) and the key/value separator.
  const gap = kids.length > 1 ? text.slice(memberEnd(t, kids[kids.length - 2]), memberStart(t, last)).replace(/^\s*,/, '') : text.slice(t.valPos[id] + 1, memberStart(t, first));
  const nl = gap.lastIndexOf('\n');
  const tail = gap.slice(nl + 1);
  const indent = nl >= 0 && /^[ \t]*$/.test(tail) ? (gap.includes('\r\n') ? '\r\n' : '\n') + tail : /^\s*$/.test(gap) ? gap : ' ';
  const sep = t.type[id] === T_OBJECT ? text.slice(t.keyEnd[first], tokenRange(t, first)[0]) : ': ';
  return [{ offset: memberEnd(t, last), length: 0, text: `,${indent}${member(/^\s*:\s*$/.test(sep) ? sep : ': ')}` }];
}

function addBlock(t: DataTree, id: number, key: string | undefined, value: string): TextEdit[] {
  const text = t.text;
  const kids = t.children(id, 0, Infinity);
  neighbour(t, kids[0]);
  neighbour(t, kids[kids.length - 1]);
  const first = kids[0];
  const last = kids[kids.length - 1];
  let start = memberStart(t, first);
  if (t.type[id] === T_ARRAY) start = text.lastIndexOf('-', start);
  const indent = text.slice(lineStart(text, start), start);
  if (indent.trim() !== '') throw new EditError('Add entries to this collection in the editor.');
  const at = lineEnd(text, Math.max(memberStart(t, last), memberEnd(t, last) - 1));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `${indent}${key === undefined ? `- ${value}` : `${keyLiteral(key, true)}: ${value}`}${eol}`;
  // The last line may not end with a newline.
  return [{ offset: at, length: 0, text: at === text.length && !text.endsWith('\n') ? eol + line.slice(0, -eol.length) : line }];
}
