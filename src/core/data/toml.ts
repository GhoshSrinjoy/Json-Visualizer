/**
 * TOML -> DataTree. Values come from smol-toml; source positions come from a
 * light line scanner that maps every table header and `key = value` line to
 * its resolved path, so nodes can still be revealed in the editor.
 */

import { parse, TomlError } from 'smol-toml';
import { treeFromJS, type Located } from './fromjs';
import type { DataTree, PathSegment } from './tree';

export function parseToml(text: string): DataTree {
  let value: unknown;
  try {
    value = parse(text, { integersAsBigInt: 'asNeeded' });
  } catch (e) {
    const tree = treeFromJS({}, text, 'toml');
    const line = e instanceof TomlError ? e.line : 1;
    const col = e instanceof TomlError ? e.column : 1;
    const message = (e instanceof Error ? e.message : String(e)).split('\n')[0].replace(/^Invalid TOML document: /, '');
    tree.errors.push({ offset: tree.offsetOf(line - 1, col - 1), message, line, col });
    return tree;
  }
  const locs = locateToml(text);
  return treeFromJS(value, text, 'toml', (k) => locs.get(k));
}

/** Maps JSON-encoded resolved paths to source ranges. */
export function locateToml(text: string): Map<string, Located> {
  const map = new Map<string, Located>();
  const aot = new Map<string, number>(); // array-of-tables path -> element count
  let table: PathSegment[] = [];
  let pos = 0;
  const n = text.length;

  const resolve = (parts: string[]): PathSegment[] => {
    const out: PathSegment[] = [];
    for (const p of parts) {
      out.push(p);
      const count = aot.get(JSON.stringify(out));
      if (count !== undefined) out.push(count - 1);
    }
    return out;
  };

  while (pos < n) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = n;
    let i = pos;
    while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
    const c = text[i];

    if (c === '[') {
      const isArray = text[i + 1] === '[';
      const k = parseKey(text, i + (isArray ? 2 : 1));
      if (k) {
        let path: PathSegment[];
        if (isArray) {
          const parent = resolve(k.parts.slice(0, -1));
          const base = [...parent, k.parts[k.parts.length - 1]];
          const key = JSON.stringify(base);
          const count = (aot.get(key) ?? 0) + 1;
          aot.set(key, count);
          path = [...base, count - 1];
        } else {
          path = resolve(k.parts);
        }
        table = path;
        map.set(JSON.stringify(path), { keyPos: i, keyEnd: k.end, valPos: i, valEnd: end });
      }
      pos = end + 1;
      continue;
    }

    if (c && c !== '#' && c !== '\r' && i < end) {
      const k = parseKey(text, i);
      if (k) {
        let j = k.end;
        while (j < end && (text[j] === ' ' || text[j] === '\t')) j++;
        if (text[j] === '=') {
          j++;
          while (j < end && (text[j] === ' ' || text[j] === '\t')) j++;
          const valEnd = valueEnd(text, j);
          const path = [...table, ...k.parts];
          map.set(JSON.stringify(path), { keyPos: i, keyEnd: k.keyEnd, valPos: j, valEnd: trimEnd(text, valEnd) });
          if (valEnd > end) {
            // Multi-line value: resume on the line after it ends.
            const nl = text.indexOf('\n', valEnd - 1);
            pos = nl < 0 ? n : nl + 1;
            continue;
          }
        }
      }
    }
    pos = end + 1;
  }
  return map;
}

/** Parses a dotted TOML key starting at `i`. */
function parseKey(text: string, i: number): { parts: string[]; end: number; keyEnd: number } | null {
  const parts: string[] = [];
  let j = i;
  let keyEnd = i;
  for (;;) {
    while (text[j] === ' ' || text[j] === '\t') j++;
    const c = text[j];
    if (c === '"' || c === "'") {
      let e = j + 1;
      while (e < text.length && text[e] !== c && text[e] !== '\n') {
        if (c === '"' && text[e] === '\\') e++;
        e++;
      }
      const raw = text.slice(j + 1, e);
      parts.push(c === '"' ? unescapeBasic(raw) : raw);
      j = e + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(text.slice(j, j + 256));
      if (!m) return null;
      parts.push(m[0]);
      j += m[0].length;
    }
    keyEnd = j;
    while (text[j] === ' ' || text[j] === '\t') j++;
    if (text[j] === '.') {
      j++;
      continue;
    }
    if (text[j] === ']') {
      j++;
      if (text[j] === ']') j++;
    }
    return { parts, end: j, keyEnd };
  }
}

/** End offset of a value starting at `i`, following multi-line strings and brackets. */
function valueEnd(text: string, i: number): number {
  const n = text.length;
  if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
    const q = text.slice(i, i + 3);
    let e = text.indexOf(q, i + 3);
    while (e >= 0 && text[e + 3] === q[0]) e++; // up to two extra quotes are content
    return e < 0 ? n : e + 3;
  }
  let depth = 0;
  for (let j = i; j < n; j++) {
    const c = text[j];
    if (c === '"' || c === "'") {
      if (text.startsWith(c.repeat(3), j)) {
        const e = text.indexOf(c.repeat(3), j + 3);
        j = e < 0 ? n : e + 2;
        continue;
      }
      let e = j + 1;
      while (e < n && text[e] !== c && text[e] !== '\n') {
        if (c === '"' && text[e] === '\\') e++;
        e++;
      }
      j = e;
      continue;
    }
    if (c === '#') {
      if (depth <= 0) return j; // an inline comment ends the value
      const nl = text.indexOf('\n', j);
      j = nl < 0 ? n : nl;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === '\n' && depth <= 0) return j;
  }
  return n;
}

function trimEnd(text: string, end: number): number {
  let e = end;
  while (e > 0 && /\s/.test(text[e - 1])) e--;
  return e;
}

function unescapeBasic(s: string): string {
  if (s.indexOf('\\') < 0) return s;
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}
