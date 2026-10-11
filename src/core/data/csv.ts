/**
 * CSV/TSV -> DataTree: an array of row objects whose cells are keyed by the
 * header (F_COLUMN_KEY) and typed (number/boolean/null/string) on the fly.
 * Cells keep exact source ranges, so very large files stay cheap.
 */

import {
  DataTree,
  F_COLUMN_KEY,
  F_ESCAPED,
  T_ARRAY,
  T_BOOLEAN,
  T_NULL,
  T_NUMBER,
  T_OBJECT,
  T_STRING,
  TreeBuilder,
  type NodeType,
} from './tree';

export interface CsvOptions {
  format?: 'csv' | 'tsv';
  delimiter?: string;
  /** Whether the first row holds column names; 'auto' guesses. */
  header?: boolean | 'auto';
}

export function parseCsv(text: string, options: CsvOptions = {}): DataTree {
  const started = now();
  const format = options.format ?? 'csv';
  const delim = (options.delimiter ?? (format === 'tsv' ? '\t' : detectDelimiter(text))).charCodeAt(0);
  const n = text.length;
  const b = new TreeBuilder(text, format, (n >>> 3) + 16);
  const tree = b.tree;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  // Cell scratch space for the current row (start, end, quoted).
  let cs: Uint32Array = new Uint32Array(64);
  let ce: Uint32Array = new Uint32Array(64);
  let cq: Uint8Array = new Uint8Array(64);

  /** Scans one record starting at `i`; returns the cell count and advances `i`. */
  const scanRow = (): number => {
    let cells = 0;
    for (;;) {
      if (cells === cs.length) {
        const m = cs.length * 2;
        cs = grow32(cs, m);
        ce = grow32(ce, m);
        const q = new Uint8Array(m);
        q.set(cq);
        cq = q;
      }
      let c = text.charCodeAt(i);
      if (c === 34) {
        const start = i;
        let j = text.indexOf('"', i + 1);
        while (j >= 0 && text.charCodeAt(j + 1) === 34) j = text.indexOf('"', j + 2);
        if (j < 0) {
          b.error(start, 'Unterminated quoted field');
          j = n - 1;
        }
        i = j + 1;
        // Tolerate junk between the closing quote and the delimiter.
        while (i < n) {
          c = text.charCodeAt(i);
          if (c === delim || c === 10 || c === 13) break;
          i++;
        }
        cs[cells] = start;
        ce[cells] = j + 1;
        cq[cells] = 1;
      } else {
        const start = i;
        while (i < n) {
          c = text.charCodeAt(i);
          if (c === delim || c === 10 || c === 13) break;
          i++;
        }
        cs[cells] = start;
        ce[cells] = i;
        cq[cells] = 0;
      }
      cells++;
      if (i >= n) return cells;
      c = text.charCodeAt(i);
      if (c === delim) {
        i++; // a trailing delimiter at EOF yields a final empty cell on the next pass
        continue;
      }
      // End of record.
      if (c === 13 && text.charCodeAt(i + 1) === 10) i += 2;
      else i++;
      return cells;
    }
  };

  const skipBlankLines = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13) i++;
      else break;
    }
  };

  skipBlankLines();
  b.open(T_ARRAY, 0, 0, 0, i);

  const columns: string[] = [];
  let first = true;
  let useHeader = options.header ?? 'auto';
  while (i < n) {
    const rowStart = i;
    const cells = scanRow();
    let rowEnd = i;
    while (rowEnd > rowStart && (text.charCodeAt(rowEnd - 1) === 10 || text.charCodeAt(rowEnd - 1) === 13)) rowEnd--;
    if (cells === 1 && ce[0] === cs[0]) {
      skipBlankLines();
      continue; // empty line
    }
    if (first) {
      first = false;
      if (useHeader === 'auto') useHeader = !looksLikeData(text, cs, ce, cq, cells);
      if (useHeader) {
        const seen = new Map<string, number>();
        for (let k = 0; k < cells; k++) {
          let name = cellText(text, cs[k], ce[k], cq[k] === 1).trim() || `column${k + 1}`;
          const dup = seen.get(name);
          seen.set(name, (dup ?? 0) + 1);
          if (dup) name = `${name}_${dup + 1}`;
          columns.push(name);
        }
        skipBlankLines();
        continue;
      }
    }
    while (columns.length < cells) columns.push(`column${columns.length + 1}`);
    b.open(T_OBJECT, 0, 0, 0, rowStart);
    for (let k = 0; k < cells; k++) {
      const s = cs[k];
      const e = ce[k];
      const quoted = cq[k] === 1;
      const type = quoted ? T_STRING : cellType(text, s, e);
      b.leaf(type, F_COLUMN_KEY | (quoted ? F_ESCAPED : 0), k, k, s, e);
    }
    b.close(rowEnd);
    skipBlankLines();
  }
  tree.columns = columns;
  const result = b.finish();
  result.parseMs = now() - started;
  return result;
}

/** Picks the candidate delimiter with the most consistent per-line count. */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  const lines = sample.split(/\r?\n/).filter((l) => l.trim()).slice(0, 25);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', '\t', ';', '|']) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const nonZero = counts.filter((c) => c > 0);
    if (!nonZero.length) continue;
    const mode = modeOf(nonZero);
    const consistent = counts.filter((c) => c === mode).length;
    const score = consistent * 1000 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === d && !q) n++;
  }
  return n;
}

function modeOf(xs: number[]): number {
  const m = new Map<number, number>();
  let best = xs[0];
  let bestN = 0;
  for (const x of xs) {
    const k = (m.get(x) ?? 0) + 1;
    m.set(x, k);
    if (k > bestN) {
      bestN = k;
      best = x;
    }
  }
  return best;
}

function cellText(text: string, s: number, e: number, quoted: boolean): string {
  const raw = text.slice(s, e);
  return quoted ? raw.slice(1, -1).replace(/""/g, '"') : raw;
}

/** A first row with mostly numeric cells is data, not a header. */
function looksLikeData(text: string, cs: Uint32Array, ce: Uint32Array, cq: Uint8Array, cells: number): boolean {
  if (cells < 2) return false;
  let numeric = 0;
  for (let k = 0; k < cells; k++) if (!cq[k] && cellType(text, cs[k], ce[k]) === T_NUMBER) numeric++;
  return numeric * 2 >= cells;
}

/** Infers the type of an unquoted cell without allocating. */
export function cellType(text: string, s: number, e: number): NodeType {
  while (s < e && text.charCodeAt(s) === 32) s++;
  while (e > s && text.charCodeAt(e - 1) === 32) e--;
  const len = e - s;
  if (len === 0) return T_NULL;
  const c0 = text.charCodeAt(s) | 32;
  if (len === 4 && c0 === 116 && text.slice(s, e).toLowerCase() === 'true') return T_BOOLEAN;
  if (len === 5 && c0 === 102 && text.slice(s, e).toLowerCase() === 'false') return T_BOOLEAN;
  if (len === 4 && c0 === 110 && text.slice(s, e).toLowerCase() === 'null') return T_NULL;
  return isNumber(text, s, e) ? T_NUMBER : T_STRING;
}

function isNumber(text: string, s: number, e: number): boolean {
  let i = s;
  let c = text.charCodeAt(i);
  if (c === 45 || c === 43) c = text.charCodeAt(++i);
  const intStart = i;
  while (i < e && c >= 48 && c <= 57) c = text.charCodeAt(++i);
  const intLen = i - intStart;
  // Leading zeros (zip codes, ids) stay strings.
  if (intLen > 1 && text.charCodeAt(intStart) === 48) return false;
  let fracLen = 0;
  if (i < e && c === 46) {
    c = text.charCodeAt(++i);
    const fs = i;
    while (i < e && c >= 48 && c <= 57) c = text.charCodeAt(++i);
    fracLen = i - fs;
  }
  if (intLen === 0 && fracLen === 0) return false;
  if (i < e && (c | 32) === 101) {
    c = text.charCodeAt(++i);
    if (c === 45 || c === 43) c = text.charCodeAt(++i);
    const es = i;
    while (i < e && c >= 48 && c <= 57) c = text.charCodeAt(++i);
    if (i === es) return false;
  }
  return i === e;
}

function grow32(a: Uint32Array, n: number): Uint32Array {
  const b = new Uint32Array(n);
  b.set(a);
  return b;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
