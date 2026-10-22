/**
 * Single-pass, iterative JSON scanner that writes straight into a DataTree.
 *
 * - No recursion: arbitrarily deep documents cannot overflow the stack.
 * - Strings are skipped with native indexOf, which is what makes this fast on
 *   multi-hundred-megabyte inputs; values are never materialised.
 * - Tolerant by design: comments, trailing commas, single quotes, unquoted
 *   keys, NaN/Infinity/hex (JSONC/JSON5), several top-level values (JSON
 *   Lines) and malformed input all produce a usable tree plus error records.
 *   In strict 'json' the extensions are still read, but each kind is reported
 *   once as a warning; duplicate keys are warnings in every flavour.
 */

import {
  DataTree,
  F_ERROR,
  F_ESCAPED,
  F_SYNTHETIC,
  T_ARRAY,
  T_BOOLEAN,
  T_NULL,
  T_NUMBER,
  T_OBJECT,
  T_STRING,
  TreeBuilder,
  type DataFormat,
  type ParseIssue,
} from './tree';

export interface JsonParseOptions {
  format?: Extract<DataFormat, 'json' | 'jsonc' | 'json5' | 'jsonl' | 'xlsx'>;
  /** Stop after this many errors (the input is probably not JSON). */
  maxErrors?: number;
}

const S_TOP = 0; // between top-level values
const S_VALUE = 1; // after ':' or ',' in an array
const S_VALUE_OR_CLOSE = 2; // right after '['
const S_KEY_OR_CLOSE = 3; // right after '{' or ','
const S_COLON = 4; // after a key
const S_AFTER = 5; // after a value inside a container

const NUM_JSON = 0; // a valid JSON number
const NUM_JSON5 = 1; // JSON5 only: hex, Infinity, NaN, leading '+', leading or trailing '.'
const NUM_BAD = 2; // no JSON flavour's number: `1.2.3`, `2024-01-01`, `-`, `007`

const BACKSLASH = 92;
/** Issues kept per document (TreeBuilder.error stops recording at the same count). */
const MAX_ISSUES = 50;
/** Duplicate keys listed one by one; the rest are summarised. */
const MAX_DUPLICATE_WARNINGS = 20;

export function parseJson(text: string, options: JsonParseOptions = {}): DataTree {
  const started = now();
  const format = options.format ?? 'json';
  const strict = format === 'json';
  const maxErrors = options.maxErrors ?? 200;
  const n = text.length;
  const b = new TreeBuilder(text, format, (n >>> 4) + 16);
  const tree = b.tree;
  b.open(T_ARRAY, F_SYNTHETIC, 0, 0, 0);

  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let state = S_TOP;
  let keyPos = 0;
  let keyEnd = 0;
  let errorCount = 0;
  /** Offset of the comma just consumed (-1 when the previous token was something else). */
  let comma = -1;
  // Members whose key is not a quoted literal without escapes, for the
  // duplicate-key check (which otherwise compares the text between the quotes).
  const escapedKeys = new Set<number>();
  const unquotedKeys = new Set<number>();
  // Lazily maintained positions of the next '\\' and '\n' at/after the scan
  // position; -1 means "none left". Keeps escape/newline detection O(n).
  let nextBackslash = -2;
  let nextNewline = -2;

  const error = (at: number, message: string) => {
    errorCount++;
    b.error(at, message);
  };

  /** Strict JSON: the first occurrence of each kind of extension, and how often it occurs. */
  const extensions = new Map<string, { issue: ParseIssue; count: number }>();
  const warn = (kind: string, at: number, message: string) => {
    const seen = extensions.get(kind);
    if (seen) seen.count++;
    else extensions.set(kind, { issue: { offset: at, message, line: 0, col: 0, severity: 'warning' }, count: 1 });
  };

  const afterValue = () => (b.depth <= 1 ? S_TOP : S_AFTER);
  const topIsObject = () => tree.type[b.top] === T_OBJECT;

  /**
   * Returns the index just past the closing quote of the literal starting at
   * `start`; sets `escaped` when the literal contains a backslash.
   */
  let escaped = false;
  const scanQuoted = (start: number, quote: string): number => {
    let q = text.indexOf(quote, start + 1);
    while (q > 0 && text.charCodeAt(q - 1) === BACKSLASH) {
      let k = q - 1;
      while (text.charCodeAt(k) === BACKSLASH) k--;
      if ((q - 1 - k) % 2 === 0) break; // even run of backslashes: quote is real
      q = text.indexOf(quote, q + 1);
    }
    if (nextNewline !== -1 && nextNewline <= start) nextNewline = text.indexOf('\n', start + 1);
    // A raw newline before the closing quote means the literal is unterminated
    // (unless it is a JSON5 line continuation).
    while (nextNewline !== -1 && (q < 0 || nextNewline < q)) {
      const prev = text.charCodeAt(nextNewline - 1);
      const cont = prev === BACKSLASH || (prev === 13 && text.charCodeAt(nextNewline - 2) === BACKSLASH);
      if (!cont) {
        error(start, 'Unterminated string');
        let e = nextNewline;
        if (text.charCodeAt(e - 1) === 13) e--;
        escaped = true;
        return e;
      }
      nextNewline = text.indexOf('\n', nextNewline + 1);
    }
    if (q < 0) {
      error(start, 'Unterminated string');
      escaped = true;
      return n;
    }
    if (nextBackslash !== -1 && nextBackslash <= start) nextBackslash = text.indexOf('\\', start + 1);
    escaped = nextBackslash !== -1 && nextBackslash < q;
    return q + 1;
  };

  const isDelimiter = (c: number) =>
    c !== c /* NaN: end of input */ ||
    c === 44 || c === 125 || c === 93 || c === 58 || c === 32 || c === 10 || c === 13 || c === 9 || c === 47;

  /** Skips an invalid token and records it as an error leaf. */
  const garbage = (start: number): number => {
    let j = start;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 44 || c === 125 || c === 93 || c === 10 || c === 13) break;
      j++;
    }
    if (j === start) j++;
    error(start, `Unexpected ${describe(text, start)}`);
    b.leaf(T_STRING, F_ERROR, keyPos, keyEnd, start, j);
    return j;
  };

  /**
   * Number or JSON5 numeric literal (hex, Infinity, NaN, leading +/.). Returns
   * the token end and classifies it in `numKind`; number-like characters
   * that follow a complete literal (`1.2.3`, `2024-01-01`) make it NUM_BAD.
   */
  let numKind = NUM_JSON;
  const scanNumber = (start: number): number => {
    let j = start;
    let c = text.charCodeAt(j);
    let kind = c === 43 ? NUM_JSON5 : NUM_JSON;
    if (c === 45 || c === 43) c = text.charCodeAt(++j);
    if (c === 48 && (text.charCodeAt(j + 1) | 32) === 120) {
      j += 2;
      const digits = j;
      while (j < n && isHexDigit(text.charCodeAt(j))) j++;
      kind = j > digits ? NUM_JSON5 : NUM_BAD;
    } else if (c === 73 && text.startsWith('Infinity', j)) {
      j += 8;
      kind = NUM_JSON5;
    } else if (c === 78 && text.startsWith('NaN', j)) {
      j += 3;
      kind = NUM_JSON5;
    } else {
      const int = j;
      while (c >= 48 && c <= 57) c = text.charCodeAt(++j);
      const intLen = j - int;
      let fracLen = -1;
      if (c === 46) {
        c = text.charCodeAt(++j);
        const frac = j;
        while (c >= 48 && c <= 57) c = text.charCodeAt(++j);
        fracLen = j - frac;
      }
      if (intLen === 0 && fracLen <= 0) kind = NUM_BAD;
      else if (intLen > 1 && text.charCodeAt(int) === 48) kind = NUM_BAD; // leading zero
      else if (intLen === 0 || fracLen === 0) kind = NUM_JSON5; // `.5`, `5.`
      if (c === 101 || c === 69) {
        c = text.charCodeAt(++j);
        if (c === 43 || c === 45) c = text.charCodeAt(++j);
        const exp = j;
        while (c >= 48 && c <= 57) c = text.charCodeAt(++j);
        if (j === exp) kind = NUM_BAD;
      }
    }
    while (j < n) {
      c = text.charCodeAt(j);
      if ((c >= 48 && c <= 57) || c === 46 || c === 101 || c === 69 || c === 43 || c === 45 || c === 95) {
        kind = NUM_BAD;
        j++;
      } else break;
    }
    numKind = kind;
    return j;
  };

  const isIdentChar = (c: number) =>
    (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || c === 36 || c > 127;

  outer: while (errorCount < maxErrors) {
    // Whitespace and comments.
    let c = 0;
    while (i < n) {
      c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) {
        i++;
        continue;
      }
      if (c === 47) {
        const d = text.charCodeAt(i + 1);
        if (d === 47 || d === 42) {
          if (strict) warn('comment', i, 'Comments are not allowed in JSON');
          if (d === 47) {
            const e = text.indexOf('\n', i + 2);
            i = e < 0 ? n : e + 1;
            continue;
          }
          const e = text.indexOf('*/', i + 2);
          if (e < 0) error(i, 'Unterminated comment');
          i = e < 0 ? n : e + 2;
          continue;
        }
      }
      if (c === 0xfeff || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 11 || c === 12) {
        i++;
        continue;
      }
      break;
    }
    if (i >= n) break;
    const afterComma = comma;
    comma = -1;

    switch (state) {
      case S_TOP:
      case S_VALUE:
      case S_VALUE_OR_CLOSE: {
        if (c === 93 && state !== S_VALUE && b.depth > 1) {
          if (strict && afterComma >= 0) warn('trailing-comma', afterComma, 'Trailing commas are not allowed in JSON');
          b.close(i + 1);
          i++;
          state = afterValue();
          continue outer;
        }
        if (c === 44 && state === S_TOP) {
          i++; // commas between top-level values: `{...},{...}`
          continue outer;
        }
        if (strict && state === S_TOP && tree.childCount[0] > 0 && c !== 93 && c !== 125) {
          warn('top-level', i, 'JSON allows only one top-level value');
        }
        if (c === 93 || c === 125) {
          // Closing bracket where a value is required (`[1,]` handled above).
          if (state === S_TOP) {
            error(i, `Unexpected ${describe(text, i)}`);
            i++;
            continue outer;
          }
          // `{"a": }` — record a missing value and let S_AFTER close.
          error(i, 'Missing value');
          b.leaf(T_NULL, F_ERROR, keyPos, keyEnd, i, i);
          state = S_AFTER;
          continue outer;
        }
        switch (c) {
          case 123:
            b.open(T_OBJECT, 0, keyPos, keyEnd, i);
            i++;
            state = S_KEY_OR_CLOSE;
            continue outer;
          case 91:
            b.open(T_ARRAY, 0, keyPos, keyEnd, i);
            i++;
            state = S_VALUE_OR_CLOSE;
            continue outer;
          case 34: {
            const end = scanQuoted(i, '"');
            b.leaf(T_STRING, escaped ? F_ESCAPED : 0, keyPos, keyEnd, i, end);
            i = end;
            state = afterValue();
            continue outer;
          }
          case 39: {
            if (strict) warn('single-quote', i, 'Single-quoted strings are not allowed in JSON');
            const end = scanQuoted(i, "'");
            b.leaf(T_STRING, F_ESCAPED, keyPos, keyEnd, i, end);
            i = end;
            state = afterValue();
            continue outer;
          }
          case 116:
            if (text.startsWith('true', i) && isDelimiter(text.charCodeAt(i + 4))) {
              b.leaf(T_BOOLEAN, 0, keyPos, keyEnd, i, i + 4);
              i += 4;
              state = afterValue();
              continue outer;
            }
            break;
          case 102:
            if (text.startsWith('false', i) && isDelimiter(text.charCodeAt(i + 5))) {
              b.leaf(T_BOOLEAN, 0, keyPos, keyEnd, i, i + 5);
              i += 5;
              state = afterValue();
              continue outer;
            }
            break;
          case 110:
            if (text.startsWith('null', i) && isDelimiter(text.charCodeAt(i + 4))) {
              b.leaf(T_NULL, 0, keyPos, keyEnd, i, i + 4);
              i += 4;
              state = afterValue();
              continue outer;
            }
            break;
          default:
            if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46 || c === 73 || c === 78) {
              let end = jsonNumberEnd(text, i);
              let kind = NUM_JSON;
              if (end < 0) {
                end = scanNumber(i);
                kind = numKind;
              }
              if (end > i && isDelimiter(text.charCodeAt(end))) {
                if (kind === NUM_BAD) {
                  // Kept as text (like other invalid tokens) rather than as a number it is not.
                  error(i, `Invalid number "${text.slice(i, Math.min(end, i + 40))}"`);
                  b.leaf(T_STRING, F_ERROR, keyPos, keyEnd, i, end);
                } else {
                  if (strict && kind === NUM_JSON5) warn('json5-number', i, `JSON5 number syntax (${text.slice(i, Math.min(end, i + 40))}) is not allowed in JSON`);
                  b.leaf(T_NUMBER, 0, keyPos, keyEnd, i, end);
                }
                i = end;
                state = afterValue();
                continue outer;
              }
            }
        }
        i = garbage(i);
        state = afterValue();
        continue outer;
      }

      case S_KEY_OR_CLOSE: {
        if (c === 125) {
          if (strict && afterComma >= 0) warn('trailing-comma', afterComma, 'Trailing commas are not allowed in JSON');
          b.close(i + 1);
          i++;
          state = afterValue();
          continue outer;
        }
        if (c === 34 || c === 39) {
          if (strict && c === 39) warn('single-quote', i, 'Single-quoted strings are not allowed in JSON');
          keyPos = i;
          keyEnd = scanQuoted(i, c === 34 ? '"' : "'");
          // The member's id is the next one (nothing is added between a key and its value).
          if (escaped) escapedKeys.add(tree.count);
          i = keyEnd;
          state = S_COLON;
          continue outer;
        }
        if (isIdentChar(c)) {
          if (strict) warn('unquoted-key', i, 'Property names must be double-quoted in JSON');
          let j = i + 1;
          while (j < n && isIdentChar(text.charCodeAt(j))) j++;
          keyPos = i;
          keyEnd = j;
          unquotedKeys.add(tree.count);
          i = j;
          state = S_COLON;
          continue outer;
        }
        if (c === 44) {
          error(i, 'Unexpected ","');
          i++;
          continue outer;
        }
        if (c === 93) {
          error(i, 'Mismatched "]"');
          b.close(i + 1);
          i++;
          state = afterValue();
          continue outer;
        }
        // Something like `{ : 1 }` or `{ - }`: treat the token as an unquoted key.
        error(i, `Unexpected ${describe(text, i)} in object`);
        keyPos = i;
        let j = i + 1;
        while (j < n && !isDelimiter(text.charCodeAt(j))) j++;
        keyEnd = j;
        unquotedKeys.add(tree.count);
        i = j;
        state = S_COLON;
        continue outer;
      }

      case S_COLON:
        if (c === 58) {
          i++;
          state = S_VALUE;
          continue outer;
        }
        if (c === 61) {
          error(i, 'Expected ":" but found "="');
          i++;
          state = S_VALUE;
          continue outer;
        }
        error(i, 'Expected ":"');
        if (c === 44 || c === 125) {
          // `{"a", ...}` / `{"a"}`: a key without a value.
          b.leaf(T_NULL, F_ERROR, keyPos, keyEnd, i, i);
          state = S_AFTER;
        } else {
          state = S_VALUE; // `{"a" 1}`: assume the colon and parse the value
        }
        continue outer;

      case S_AFTER: {
        if (c === 44) {
          comma = i;
          i++;
          state = topIsObject() ? S_KEY_OR_CLOSE : S_VALUE_OR_CLOSE;
          continue outer;
        }
        if (c === 125 || c === 93) {
          if ((c === 125) !== topIsObject()) error(i, `Mismatched "${text[i]}"`);
          b.close(i + 1);
          i++;
          state = afterValue();
          continue outer;
        }
        error(i, 'Expected "," or closing bracket');
        state = topIsObject() ? S_KEY_OR_CLOSE : S_VALUE;
        continue outer;
      }
    }
  }

  if (errorCount >= maxErrors) {
    // Always visible, even when the issue list is full.
    if (tree.errors.length >= MAX_ISSUES) tree.errors.length = MAX_ISSUES - 1;
    tree.errors.push({ offset: i, message: 'Too many errors; stopped parsing', line: 0, col: 0 });
  } else if (b.depth > 1) error(n, 'Unexpected end of input (unclosed bracket)');
  b.closeAll(n);
  if (tree.childCount[0] === 0 && errorCount === 0) {
    // Nothing but whitespace (or comments). An empty JSON Lines file is valid, just empty.
    tree.errors.push({ offset: 0, message: 'Empty document', line: 0, col: 0, ...(format === 'jsonl' ? { severity: 'warning' as const } : {}) });
  }
  const warnings: ParseIssue[] = [];
  for (const { issue, count } of extensions.values()) {
    if (count > 1) issue.message += ` (${count} occurrences)`;
    warnings.push(issue);
  }
  // Workbooks are converted from JS objects, so their keys are unique.
  if (format !== 'xlsx') warnings.push(...duplicateKeys(tree, escapedKeys, unquotedKeys, MAX_DUPLICATE_WARNINGS));
  if (warnings.length && tree.errors.length < MAX_ISSUES) {
    // Errors keep priority; the list is then in document order.
    for (const w of warnings.slice(0, MAX_ISSUES - tree.errors.length)) tree.errors.push(w);
    tree.errors.sort((a, c) => a.offset - c.offset);
  }
  const result = b.finish();
  result.parseMs = now() - started;
  return result;
}

/** Objects up to this size keep a key template (see duplicateKeys). */
const MAX_TEMPLATE_KEYS = 64;
/** Larger objects are checked through a hash table rather than pairwise. */
const MAX_PAIRWISE_KEYS = 16;

/**
 * Keys repeated within one object (when the document is read, the last one
 * wins): up to `limit` warnings, then one that counts the rest. Keys without
 * escapes are compared as source text (between the quotes unless listed in
 * `unquotedKeys`), escaped ones decoded.
 *
 * Arrays of records repeat their keys, so an object that turns out to have
 * distinct, unescaped keys becomes the template for objects of its size, and
 * later objects matching it are settled by their key lengths and a few
 * characters. Other objects compare keys pairwise when small (only pairs of
 * equal length) or through a hash table.
 */
function duplicateKeys(tree: DataTree, escapedKeys: Set<number>, unquotedKeys: Set<number>, limit: number): ParseIssue[] {
  const { text, type, childCount, size, keyPos, keyEnd } = tree;
  const special = escapedKeys.size > 0 || unquotedKeys.size > 0;
  const out: ParseIssue[] = [];
  let more = 0;
  let moreAt = 0;
  const report = (c: number) => {
    if (out.length < limit) out.push({ offset: keyPos[c], message: `Duplicate key ${JSON.stringify(tree.key(c))}`, line: 0, col: 0, severity: 'warning' });
    else if (more++ === 0) moreAt = keyPos[c];
  };
  let kids = new Int32Array(64);
  let starts = new Int32Array(64);
  /** Content length of each key; -1 for an escaped key (compared decoded). */
  let lens = new Int32Array(64);
  let hashes = new Int32Array(64);
  let stamps = new Int32Array(128);
  let slots = new Int32Array(128);
  let gen = 0;
  const same = (i: number, j: number) =>
    lens[i] >= 0 && lens[j] >= 0 ? lens[i] === lens[j] && sameText(text, starts[i], starts[j], lens[i]) : tree.key(kids[i]) === tree.key(kids[j]);
  const templates: (KeyTemplate | undefined)[] = [];

  for (let id = 0; id < tree.count; id++) {
    if (type[id] !== T_OBJECT) continue;
    const k = childCount[id];
    if (k < 2) continue;
    if (k > kids.length) {
      const m = Math.max(k, kids.length * 2);
      kids = new Int32Array(m);
      starts = new Int32Array(m);
      lens = new Int32Array(m);
      hashes = new Int32Array(m);
    }
    const t = k <= MAX_TEMPLATE_KEYS ? templates[k] : undefined;
    if (t && !special) {
      // The common case, records repeating the template: lengths, then a few characters.
      const tl = t.lens;
      let c = id + 1;
      let i = 0;
      for (; i < k; i++, c += size[c]) {
        const s = keyPos[c] + 1;
        if (keyEnd[c] - 1 - s !== tl[i]) break;
        starts[i] = s;
      }
      if (i === k && witnessesMatch(t, text, starts)) {
        t.hits++;
        continue;
      }
    }
    let escapes = false;
    for (let c = id + 1, i = 0; i < k; i++, c += size[c]) {
      kids[i] = c;
      let s = keyPos[c] + 1;
      let e = keyEnd[c] - 1;
      if (special) {
        if (unquotedKeys.has(c)) {
          s--;
          e++;
        } else if (escapedKeys.has(c)) {
          e = s - 1; // length -1: compared decoded
          escapes = true;
        }
      }
      starts[i] = s;
      lens[i] = e - s;
    }
    if (t && special && !escapes && matchesTemplate(t, text, starts, lens, k)) {
      t.hits++;
      continue;
    }
    if (t) t.misses++;

    let distinct = true;
    if (k <= MAX_PAIRWISE_KEYS) {
      for (let j = 1; j < k; j++) {
        for (let i = 0; i < j; i++) {
          if (!same(i, j)) continue;
          distinct = false;
          report(kids[j]);
          break;
        }
      }
    } else {
      if (k * 2 > stamps.length) {
        let cap = stamps.length;
        while (k * 2 > cap) cap *= 2;
        stamps = new Int32Array(cap);
        slots = new Int32Array(cap);
        gen = 0;
      }
      gen++;
      const mask = stamps.length - 1;
      for (let j = 0; j < k; j++) {
        let h: number;
        if (lens[j] >= 0) h = hashRange(text, starts[j], starts[j] + lens[j]);
        else {
          const key = String(tree.key(kids[j]));
          h = hashRange(key, 0, key.length);
        }
        hashes[j] = h;
        for (let slot = (h ^ (h >>> 16)) & mask; ; slot = (slot + 1) & mask) {
          if (stamps[slot] !== gen) {
            stamps[slot] = gen;
            slots[slot] = j;
            break;
          }
          const i = slots[slot];
          if (hashes[i] !== h || !same(i, j)) continue;
          distinct = false;
          report(kids[j]);
          break;
        }
      }
    }
    // A shape that keeps failing its template is replaced, but not on every miss.
    if (distinct && !escapes && k <= MAX_TEMPLATE_KEYS && (!t || t.misses > 2 * t.hits + 16)) {
      templates[k] = buildTemplate(text, starts, lens, k);
    }
  }
  if (more) out.push({ offset: moreAt, message: `${more} more duplicate keys`, line: 0, col: 0, severity: 'warning' });
  return out;
}

/**
 * Keys of an earlier object with distinct, unescaped keys. An object of the
 * same size whose keys have these lengths and these characters at the
 * positions that tell equal-length template keys apart has distinct keys too.
 */
interface KeyTemplate {
  lens: Int32Array;
  /** (key index, offset, character) triples. */
  checks: Int32Array;
  hits: number;
  misses: number;
}

function buildTemplate(text: string, starts: Int32Array, lens: Int32Array, k: number): KeyTemplate {
  const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => lens[a] - lens[b]);
  const checks: number[] = [];
  for (let g = 0; g < k; ) {
    let end = g + 1;
    while (end < k && lens[order[end]] === lens[order[g]]) end++;
    if (end - g > 1) {
      // One position where these (distinct) keys all differ, else where each pair first differs.
      const positions = new Set<number>();
      for (let p = 0; p < lens[order[g]] && !positions.size; p++) {
        const seen = new Set<number>();
        for (let x = g; x < end; x++) seen.add(text.charCodeAt(starts[order[x]] + p));
        if (seen.size === end - g) positions.add(p);
      }
      if (!positions.size) {
        for (let x = g; x < end; x++) {
          for (let y = x + 1; y < end; y++) {
            let p = 0;
            while (text.charCodeAt(starts[order[x]] + p) === text.charCodeAt(starts[order[y]] + p)) p++;
            positions.add(p);
          }
        }
      }
      for (let x = g; x < end; x++) for (const p of positions) checks.push(order[x], p, text.charCodeAt(starts[order[x]] + p));
    }
    g = end;
  }
  return { lens: lens.slice(0, k), checks: Int32Array.from(checks), hits: 0, misses: 0 };
}

function matchesTemplate(t: KeyTemplate, text: string, starts: Int32Array, lens: Int32Array, k: number): boolean {
  for (let i = 0; i < k; i++) if (lens[i] !== t.lens[i]) return false;
  return witnessesMatch(t, text, starts);
}

/** Whether keys already known to have the template's lengths also have its distinguishing characters. */
function witnessesMatch(t: KeyTemplate, text: string, starts: Int32Array): boolean {
  const ch = t.checks;
  for (let j = 0; j < ch.length; j += 3) if (text.charCodeAt(starts[ch[j]] + ch[j + 1]) !== ch[j + 2]) return false;
  return true;
}

function sameText(text: string, a: number, b: number, len: number): boolean {
  for (let p = 0; p < len; p++) if (text.charCodeAt(a + p) !== text.charCodeAt(b + p)) return false;
  return true;
}

/** FNV-1a over the UTF-16 code units of `s[from, to)`. */
function hashRange(s: string, from: number, to: number): number {
  let h = 0x811c9dc5 | 0;
  for (let p = from; p < to; p++) h = Math.imul(h ^ s.charCodeAt(p), 0x01000193);
  return h;
}

/**
 * End of the token at `start` when it is exactly one RFC 8259 number followed
 * by a delimiter (the common case, kept small so it inlines), otherwise -1.
 */
function jsonNumberEnd(text: string, start: number): number {
  let j = start;
  let c = text.charCodeAt(j);
  if (c === 45) c = text.charCodeAt(++j);
  if (c === 48) {
    c = text.charCodeAt(++j);
  } else if (c >= 49 && c <= 57) {
    do c = text.charCodeAt(++j);
    while (c >= 48 && c <= 57);
  } else return -1;
  if (c === 46) {
    c = text.charCodeAt(++j);
    if (!(c >= 48 && c <= 57)) return -1;
    do c = text.charCodeAt(++j); while (c >= 48 && c <= 57);
  }
  if (c === 101 || c === 69) {
    c = text.charCodeAt(++j);
    if (c === 43 || c === 45) c = text.charCodeAt(++j);
    if (!(c >= 48 && c <= 57)) return -1;
    do c = text.charCodeAt(++j); while (c >= 48 && c <= 57);
  }
  // Same delimiters as parseJson's isDelimiter (NaN: end of input).
  return c !== c || c === 44 || c === 125 || c === 93 || c === 58 || c === 32 || c === 10 || c === 13 || c === 9 || c === 47 ? j : -1;
}

function isHexDigit(c: number): boolean {
  return (c >= 48 && c <= 57) || ((c | 32) >= 97 && (c | 32) <= 102);
}

/** True when the text holds several newline-separated top-level JSON values. */
export function looksLikeJsonLines(text: string): boolean {
  let lines = 0;
  let start = 0;
  for (let k = 0; k < 5 && start < text.length; k++) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    const f = line[0];
    const l = line[line.length - 1];
    if (!((f === '{' && l === '}') || (f === '[' && l === ']'))) return false;
    lines++;
  }
  return lines >= 2;
}

function describe(text: string, i: number): string {
  if (i >= text.length) return 'end of input';
  const ch = text[i];
  if (/[A-Za-z0-9_]/.test(ch)) {
    const m = /^[A-Za-z0-9_$.+-]{1,20}/.exec(text.slice(i, i + 20));
    return `token "${m ? m[0] : ch}"`;
  }
  return `character ${JSON.stringify(ch)}`;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
