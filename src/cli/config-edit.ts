/**
 * Minimal edits of AI client configuration files. Only the StructLens entry is
 * inserted or replaced; comments, formatting and every other setting stay byte
 * for byte. A file with syntax errors is never modified, and every edit is
 * checked by parsing the result before anyone writes it.
 */

import { parse as parseTomlText, TomlError } from 'smol-toml';
import { parseJson } from '../core/data/json';
import { locateToml } from '../core/data/toml';
import { F_SYNTHETIC, T_OBJECT, type DataTree } from '../core/data/tree';

export class ConfigError extends Error {}

export interface ConfigEdit {
  /** The new file content. */
  text: string;
  /** The entry existed before. */
  existed: boolean;
  /** `text` differs from the input. */
  changed: boolean;
}

const notChanged = 'Fix it and run setup again; the file was not changed.';

// ---------------------------------------------------------------- JSON

/** Sets `<section>.<name>` to `value` in a JSON (or JSON with comments) document. */
export function setJsonEntry(text: string, section: string, name: string, value: unknown, file: string): ConfigEdit {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const fresh = JSON.stringify({ [section]: { [name]: value } }, null, 2).split('\n').join(eol);
  if (!text.trim()) return { text: fresh + eol, existed: false, changed: true };
  // Nothing but comments so far: add the object after them.
  if (!text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) return { text: text + (text.endsWith('\n') ? '' : eol) + fresh + eol, existed: false, changed: true };

  const tree = parseJson(text, { format: 'jsonc' });
  const error = syntaxErrors(tree)[0];
  if (error) throw new ConfigError(`${file} has a syntax error at line ${error.line}, column ${error.col}: ${error.message}. ${notChanged}`);
  const top = topLevel(tree);
  if (top.length > 1) throw new ConfigError(`${file} contains more than one JSON value. ${notChanged}`);
  const root = top[0];
  if (root === undefined || tree.type[root] !== T_OBJECT) throw new ConfigError(`${file} does not contain a JSON object. ${notChanged}`);

  let next: string;
  let existed = false;
  const before = tree.toJS(root, Infinity) as Record<string, unknown>;
  const unit = indentUnit(text, tree, root);
  const sec = lastMember(tree, root, section);
  if (sec < 0) next = insertMember(text, tree, root, section, { [name]: value }, unit, eol);
  else if (tree.type[sec] !== T_OBJECT) throw new ConfigError(`"${section}" in ${file} is not an object. ${notChanged}`);
  else {
    const entry = lastMember(tree, sec, name);
    existed = entry >= 0;
    if (existed && sameValue(tree.toJS(entry, Infinity), value)) return { text, existed, changed: false };
    next = existed ? replaceValue(text, tree, sec, entry, value, unit, eol) : insertMember(text, tree, sec, name, value, unit, eol);
  }

  const check = parseJson(next, { format: 'jsonc' });
  const checkTop = topLevel(check);
  const actual = syntaxErrors(check).length || checkTop.length !== 1 ? undefined : check.toJS(checkTop[0], Infinity);
  if (!sameValue(actual, withPath(before, [section, name], value))) {
    throw new ConfigError(`Could not update ${file} safely, so it was not changed. Add this to it by hand:\n${fresh}`);
  }
  return { text: next, existed, changed: next !== text };
}

/** Parse errors; warnings (such as duplicate keys) don't stop an edit. */
function syntaxErrors(tree: DataTree) {
  return tree.errors.filter((e) => (e as { severity?: string }).severity !== 'warning');
}

/** Ids of the top-level values (the parser wraps them in a synthetic array unless there is exactly one). */
function topLevel(tree: DataTree): number[] {
  return tree.flags[tree.root] & F_SYNTHETIC ? tree.children(tree.root) : [tree.root];
}

function lastMember(tree: DataTree, obj: number, key: string): number {
  let found = -1;
  for (let c = tree.firstChild(obj); c >= 0; c = tree.nextSibling(c)) if (tree.key(c) === key) found = c;
  return found;
}

function lastChild(tree: DataTree, obj: number): number {
  let last = -1;
  for (let c = tree.firstChild(obj); c >= 0; c = tree.nextSibling(c)) last = c;
  return last;
}

/** Leading whitespace of the line containing `pos`. */
function lineIndent(text: string, pos: number): string {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(start, pos))![0];
}

/** The whitespace before `pos` when nothing else precedes it on its line. */
function indentBefore(text: string, pos: number): string | undefined {
  const before = text.slice(text.lastIndexOf('\n', pos - 1) + 1, pos);
  return /^[ \t]*$/.test(before) ? before : undefined;
}

/** The file's indentation step, from the first member of the root object (default two spaces). */
function indentUnit(text: string, tree: DataTree, root: number): string {
  const first = tree.firstChild(root);
  const base = lineIndent(text, tree.valPos[root]);
  const own = first >= 0 ? indentBefore(text, tree.start(first)) : undefined;
  return own !== undefined && own.length > base.length && own.startsWith(base) ? own.slice(base.length) : '  ';
}

function formatJson(value: unknown, indent: string, unit: string, eol: string): string {
  return JSON.stringify(value, null, unit).split('\n').join(eol + indent);
}

/** Inserts `"key": value` as the last member of the object `obj`. */
function insertMember(text: string, tree: DataTree, obj: number, key: string, value: unknown, unit: string, eol: string): string {
  const open = tree.valPos[obj];
  const close = tree.valEnd[obj] - 1;
  const objIndent = lineIndent(text, open);
  const last = lastChild(tree, obj);
  if (last < 0) {
    const indent = objIndent + unit;
    const member = `${JSON.stringify(key)}: ${formatJson(value, indent, unit, eol)}`;
    if (!text.slice(open + 1, close).trim()) return text.slice(0, open + 1) + eol + indent + member + eol + objIndent + text.slice(close);
    // Only comments inside: add the member after them.
    let at = close;
    while (at > open + 1 && /\s/.test(text[at - 1])) at--;
    const lineBreak = /[\r\n]/.test(text.slice(at, close));
    return text.slice(0, at) + eol + indent + member + (lineBreak ? '' : eol + objIndent) + text.slice(at);
  }
  const after = tree.valEnd[last];
  let j = after;
  const skipBlanks = () => {
    while (text[j] === ' ' || text[j] === '\t') j++;
  };
  skipBlanks();
  const comma = text[j] === ',';
  if (comma) {
    j++;
    skipBlanks();
  }
  // A comment that ends the last member's line stays with that member.
  for (;;) {
    if (text.startsWith('//', j)) {
      const nl = text.indexOf('\n', j);
      j = nl < 0 ? text.length : text[nl - 1] === '\r' ? nl - 1 : nl;
      break;
    }
    if (text.startsWith('/*', j)) {
      const e = text.indexOf('*/', j + 2);
      if (e < 0 || /[\r\n]/.test(text.slice(j, e))) break;
      j = e + 2;
      skipBlanks();
      continue;
    }
    break;
  }
  if (j < text.length && text[j] !== '\n' && text[j] !== '\r') {
    // The object goes on after the last member on the same line (`{ "a": 1 }`): stay on one line.
    return text.slice(0, after) + `, ${JSON.stringify(key)}: ${JSON.stringify(value)}` + text.slice(after);
  }
  const indent = indentBefore(text, tree.start(last)) ?? objIndent + unit;
  const member = `${JSON.stringify(key)}: ${formatJson(value, indent, unit, eol)}`;
  return text.slice(0, after) + (comma ? '' : ',') + text.slice(after, j) + eol + indent + member + text.slice(j);
}

/** Replaces the value of the member `id` of the object `obj`. */
function replaceValue(text: string, tree: DataTree, obj: number, id: number, value: unknown, unit: string, eol: string): string {
  const oneLine = !/[\r\n]/.test(text.slice(tree.valPos[obj], tree.valEnd[obj]));
  const formatted = oneLine ? JSON.stringify(value) : formatJson(value, lineIndent(text, tree.start(id)), unit, eol);
  return text.slice(0, tree.valPos[id]) + formatted + text.slice(tree.valEnd[id]);
}

// ---------------------------------------------------------------- TOML

/** Sets the table `[a.b]` (`path` = ['a', 'b']) to `body` in a TOML document, e.g. `[mcp_servers.structlens]` in Codex's config. */
export function setTomlTable(original: string, path: string[], body: Record<string, unknown>, file: string): ConfigEdit {
  const bom = original.startsWith('﻿') ? '﻿' : '';
  const edit = setTomlTableText(original.slice(bom.length), path, body, file);
  return { ...edit, text: bom + edit.text };
}

function setTomlTableText(text: string, path: string[], body: Record<string, unknown>, file: string): ConfigEdit {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = tomlTable(path, body).join(eol);
  let before: Record<string, unknown> = {};
  try {
    before = parseTomlText(text) as Record<string, unknown>;
  } catch (e) {
    const where = e instanceof TomlError ? ` at line ${e.line}, column ${e.column}` : '';
    const message = (e instanceof Error ? e.message : String(e)).split('\n')[0].replace(/^Invalid TOML document: /, '');
    throw new ConfigError(`${file} has a syntax error${where}: ${message}. ${notChanged}`);
  }
  const existing = getPath(before, path);
  if (existing !== undefined && sameValue(existing, body)) return { text, existed: true, changed: false };

  let next: string;
  if (existing === undefined) {
    next = text + (text && !text.endsWith('\n') ? eol : '') + (text.trim() ? eol : '') + block + eol;
  } else {
    const regions = tableRegions(text, path);
    if (!regions.length) {
      throw new ConfigError(`${path.join('.')} in ${file} is written as dotted keys or an inline table, which setup can't replace safely; the file was not changed. Replace it with:\n${block}`);
    }
    // The first table becomes the new block; sub-tables of the old definition go away.
    next = text;
    for (let k = regions.length - 1; k >= 0; k--) {
      const [start, end] = regions[k];
      next = k === 0 ? next.slice(0, start) + block + next.slice(end) : next.slice(0, start) + next.slice(skipLineBreak(next, end));
    }
  }

  let after: unknown;
  try {
    after = parseTomlText(next);
  } catch {
    after = undefined;
  }
  if (!sameValue(after, withPath(before, path, body))) {
    throw new ConfigError(`Could not update ${file} safely, so it was not changed. Add this to it by hand:\n${block}`);
  }
  return { text: next, existed: existing !== undefined, changed: next !== text };
}

/** The TOML lines of `[path]` with `body` (strings, numbers, booleans, arrays and flat objects). */
export function tomlTable(path: string[], body: Record<string, unknown>): string[] {
  return [`[${path.map(tomlKey).join('.')}]`, ...Object.entries(body).filter(([, v]) => v !== undefined).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)];
}

const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function tomlValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (isRecord(v)) return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(', ')} }`;
  throw new Error(`Unsupported TOML value: ${String(v)}`);
}

/**
 * Source ranges of the tables at or under `path` that are written with headers: from the start of
 * the header line to the end of the table's last key/value line. Comments and blank lines after
 * that belong to whatever follows and are kept.
 */
function tableRegions(text: string, path: string[]): [number, number][] {
  const headers: { path: (string | number)[]; pos: number }[] = [];
  const entries: { pos: number; end: number }[] = [];
  for (const [key, loc] of locateToml(text)) {
    if (loc.keyPos === loc.valPos) headers.push({ path: JSON.parse(key) as (string | number)[], pos: loc.keyPos });
    else entries.push({ pos: loc.keyPos, end: loc.valEnd });
  }
  headers.sort((a, b) => a.pos - b.pos);
  const out: [number, number][] = [];
  headers.forEach((h, i) => {
    if (h.path.length < path.length || path.some((p, k) => h.path[k] !== p)) return;
    const next = headers[i + 1]?.pos ?? Infinity;
    let end = lineEnd(text, h.pos);
    for (const e of entries) if (e.pos > h.pos && e.pos < next) end = Math.max(end, lineEnd(text, e.end));
    out.push([text.lastIndexOf('\n', h.pos - 1) + 1, end]);
  });
  return out;
}

/** Where the line containing `pos` ends (before its line break). */
function lineEnd(text: string, pos: number): number {
  const nl = text.indexOf('\n', pos);
  if (nl < 0) return text.length;
  return text[nl - 1] === '\r' ? nl - 1 : nl;
}

function skipLineBreak(text: string, pos: number): number {
  if (text.startsWith('\r\n', pos)) return pos + 2;
  return text[pos] === '\n' ? pos + 1 : pos;
}

// ---------------------------------------------------------------- values

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const p of path) {
    if (!isRecord(cur) || !Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** A copy of `obj` with `path` set to `value` (only the objects along the path are copied). */
function withPath(obj: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = path;
  const child = obj[head];
  return { ...obj, [head]: rest.length ? withPath(isRecord(child) ? child : {}, rest, value) : value };
}

const dateKey = (d: Date) => {
  try {
    return d.toISOString();
  } catch {
    return String(d);
  }
};

/** Deep equality of parsed config values (key order does not matter). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && dateKey(a) === dateKey(b);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
}
