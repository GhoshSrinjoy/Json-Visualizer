/**
 * TOML -> DataTree. Values come from smol-toml; source positions come from a
 * light line scanner that maps every table header and `key = value` line to
 * its resolved path, so nodes can still be revealed in the editor.
 */

import { parse, TomlError } from 'smol-toml';
import { treeFromJS, type Located } from './fromjs';
import type { DataTree, PathSegment } from './tree';

/** Statements skipped to read past syntax errors, at most. */
const MAX_REPAIRS = 50;

/**
 * Parses TOML, reading past syntax errors: the statement that fails (or, for
 * a bad table header, its whole table) is blanked out and the rest parsed
 * again, so one typo does not hide the document. Blanking keeps offsets, so
 * positions and the reported line/column still match the original text.
 */
export function parseToml(text: string): DataTree {
  const started = now();
  const issues: { line: number; col: number; message: string }[] = [];
  let src = text;
  let value: unknown = {};
  for (let attempt = 0; ; attempt++) {
    try {
      value = parse(src, { integersAsBigInt: 'asNeeded' });
      break;
    } catch (e) {
      const line = e instanceof TomlError ? e.line : 1;
      const col = e instanceof TomlError ? e.column : 1;
      const message = (e instanceof Error ? e.message : String(e)).split('\n')[0].replace(/^Invalid TOML document: /, '');
      const skip = e instanceof TomlError && attempt < MAX_REPAIRS ? skippable(src, line) : undefined;
      if (!skip) {
        // Out of repairs: keep what parses before the failing line.
        issues.push({ line, col, message: `${message} (not read past this line)` });
        value = parsePrefix(src, line);
        break;
      }
      const from = lineOf(src, skip.from);
      const to = lineOf(src, skip.to - 1);
      issues.push({ line, col, message: `${message} (${from === to ? `line ${from}` : `lines ${from}-${to}`} skipped)` });
      src = src.slice(0, skip.from) + src.slice(skip.from, skip.to).replace(/[^\r\n]/g, ' ') + src.slice(skip.to);
    }
  }
  const locs = locateToml(src);
  const tree = treeFromJS(value, text, 'toml', (k) => locs.get(k));
  for (const i of issues) tree.errors.push({ ...i, offset: tree.offsetOf(i.line - 1, i.col - 1) });
  tree.parseMs = now() - started;
  return tree;
}

/**
 * The text to blank so parsing can continue after an error on `line`
 * (1-based): the statement there (with every line of a multi-line value), or
 * a bad table header together with its keys, so they are not attributed to
 * the previous table. Undefined when nothing is left to skip.
 */
function skippable(text: string, line: number): { from: number; to: number } | undefined {
  const n = text.length;
  let at = 0;
  for (let l = 1; l < line && at < n; l++) {
    const nl = text.indexOf('\n', at);
    at = nl < 0 ? n : nl + 1;
  }
  // The last statement starting at or before the error line.
  let stmt: { from: number; to: number; header: boolean; open: boolean } | undefined;
  for (let pos = 0; pos < n && pos <= at; ) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = n;
    const i = skipBlank(text, pos, end);
    const c = text[i];
    if (i < end && c !== '#' && c !== '\r') {
      let to = end;
      let open = false;
      if (c !== '[') {
        const k = parseKey(text, i);
        const eq = k ? skipBlank(text, k.end, end) : end;
        if (text[eq] === '=') {
          const v = scanValue(text, skipBlank(text, eq + 1, end));
          open = !v.closed;
          if (v.end > end) {
            const nl = text.indexOf('\n', v.end - 1);
            to = nl < 0 ? n : nl;
          }
        }
      }
      stmt = { from: pos, to, header: c === '[', open };
      pos = to + 1;
    } else pos = end + 1;
  }
  if (!stmt) return undefined;
  // A bad header takes its table along; an unterminated value runs up to the next header.
  let to = stmt.to;
  if (stmt.header || stmt.open) to = nextHeader(text, stmt.header ? stmt.to : Math.max(stmt.from, at));
  return /\S/.test(text.slice(stmt.from, to)) ? { from: stmt.from, to } : undefined;
}

/** Start of the first line after `from` that looks like a table header (or the end of the text). */
function nextHeader(text: string, from: number): number {
  const re = /^[ \t]*\[/gm;
  re.lastIndex = text.indexOf('\n', from) + 1 || text.length;
  const m = re.lastIndex < text.length ? re.exec(text) : null;
  return m ? m.index : text.length;
}

function parsePrefix(text: string, line: number): unknown {
  let cut = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', cut);
    if (nl < 0) break;
    cut = nl + 1;
  }
  try {
    return parse(text.slice(0, cut), { integersAsBigInt: 'asNeeded' });
  } catch {
    return {};
  }
}

/** 1-based line number of an offset. */
function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

function skipBlank(text: string, i: number, end: number): number {
  while (i < end && (text[i] === ' ' || text[i] === '\t')) i++;
  return i;
}

/**
 * Maps JSON-encoded resolved paths to source ranges. A table header's range
 * runs to the end of the table's last key/value; only headers have
 * `keyPos === valPos`.
 */
export function locateToml(text: string): Map<string, Located> {
  const map = new Map<string, Located>();
  const aot = new Map<string, number>(); // array-of-tables path -> element count
  let table: PathSegment[] = [];
  let section: Located | undefined;
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
        section = { keyPos: i, keyEnd: k.end, valPos: i, valEnd: end };
        map.set(JSON.stringify(path), section);
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
          const valEnd = scanValue(text, j).end;
          const path = [...table, ...k.parts];
          const loc = { keyPos: i, keyEnd: k.keyEnd, valPos: j, valEnd: trimEnd(text, valEnd) };
          map.set(JSON.stringify(path), loc);
          // The table's range covers its keys, so the cursor anywhere in it finds the table.
          if (section && loc.valEnd > section.valEnd) section.valEnd = loc.valEnd;
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

/**
 * End offset of a value starting at `i`, following multi-line strings and
 * brackets. `closed` is false when an unterminated multi-line string or
 * bracket leaves the end unknown.
 */
function scanValue(text: string, i: number): { end: number; closed: boolean } {
  const n = text.length;
  if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
    const q = text.slice(i, i + 3);
    let e = text.indexOf(q, i + 3);
    while (e >= 0 && text[e + 3] === q[0]) e++; // up to two extra quotes are content
    return e < 0 ? { end: n, closed: false } : { end: e + 3, closed: true };
  }
  let depth = 0;
  for (let j = i; j < n; j++) {
    const c = text[j];
    if (c === '"' || c === "'") {
      if (text.startsWith(c.repeat(3), j)) {
        const e = text.indexOf(c.repeat(3), j + 3);
        if (e < 0) return { end: n, closed: false };
        j = e + 2;
        continue;
      }
      let e = j + 1;
      while (e < n && text[e] !== c && text[e] !== '\n') {
        if (c === '"' && text[e] === '\\') e++;
        e++;
      }
      // An unterminated one-line string ends at the line break; only an open bracket carries on.
      if (e >= n || text[e] === '\n') return { end: e, closed: depth <= 0 };
      j = e;
      continue;
    }
    if (c === '#') {
      if (depth <= 0) return { end: j, closed: true }; // an inline comment ends the value
      const nl = text.indexOf('\n', j);
      j = nl < 0 ? n : nl;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === '\n' && depth <= 0) return { end: j, closed: true };
  }
  return { end: n, closed: depth <= 0 };
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

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
