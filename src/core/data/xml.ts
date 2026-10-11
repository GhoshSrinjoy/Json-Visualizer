/**
 * Tolerant XML (and loose HTML) scanner -> DataTree.
 *
 * Elements become objects keyed by tag name (F_ELEMENT), attributes become
 * `@name` string children (F_ATTR) and non-blank text becomes `#text`
 * children (F_TEXT). Mismatched or missing closing tags are repaired the way
 * browsers do rather than aborting, so partial documents still render.
 */

import {
  DataTree,
  F_ATTR,
  F_CDATA,
  F_ELEMENT,
  F_ESCAPED,
  F_SYNTHETIC,
  F_TEXT,
  T_OBJECT,
  T_STRING,
  TreeBuilder,
} from './tree';

export interface XmlParseOptions {
  /** HTML mode: void elements, raw-text <script>/<style>, case-insensitive closing tags. */
  html?: boolean;
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT = new Set(['script', 'style']);

export function parseXml(text: string, options: XmlParseOptions = {}): DataTree {
  const started = now();
  const html = !!options.html;
  const n = text.length;
  const b = new TreeBuilder(text, html ? 'html' : 'xml', (n >>> 5) + 16);
  const tree = b.tree;
  b.open(T_OBJECT, F_SYNTHETIC | F_ELEMENT, 0, 0, 0);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const isNameChar = (c: number) =>
    !(c === 32 || c === 9 || c === 10 || c === 13 || c === 47 || c === 62 || c === 61 || c === 60 || c !== c);

  const addText = (from: number, to: number) => {
    // Trim whitespace; skip blank runs.
    while (from < to && isSpace(text.charCodeAt(from))) from++;
    while (to > from && isSpace(text.charCodeAt(to - 1))) to--;
    if (from >= to) return;
    let flags = F_TEXT;
    const amp = text.indexOf('&', from);
    if (amp >= 0 && amp < to) flags |= F_ESCAPED;
    b.leaf(T_STRING, flags, 0, 0, from, to);
  };

  const tagName = (id: number) => {
    const s = text.slice(tree.keyPos[id], tree.keyEnd[id]);
    return html ? s.toLowerCase() : s;
  };

  /** Closes open elements up to and including the nearest one named `name`. */
  const closeTo = (name: string, at: number, end: number): void => {
    let depth = 0;
    let found = false;
    for (let id = b.top; id > 0 && !(tree.flags[id] & F_SYNTHETIC); id = tree.parent[id]) {
      depth++;
      if (tagName(id) === name) {
        found = true;
        break;
      }
    }
    if (!found) {
      b.error(at, `Unexpected closing tag </${name}>`);
      return;
    }
    for (let k = 1; k < depth; k++) {
      if (!html) b.error(at, `Missing closing tag </${tagName(b.top)}>`);
      b.close(at);
    }
    b.close(end);
  };

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(i, n);
      break;
    }
    if (lt > i) addText(i, lt);
    const c = text.charCodeAt(lt + 1);

    if (c === 33) {
      // <!-- comment -->, <![CDATA[ ... ]]>, <!DOCTYPE ...>
      if (text.startsWith('<!--', lt)) {
        const e = text.indexOf('-->', lt + 4);
        if (e < 0) b.error(lt, 'Unterminated comment');
        i = e < 0 ? n : e + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', lt)) {
        const e = text.indexOf(']]>', lt + 9);
        if (e < 0) b.error(lt, 'Unterminated CDATA section');
        const end = e < 0 ? n : e;
        if (end > lt + 9) b.leaf(T_STRING, F_TEXT | F_CDATA, 0, 0, lt + 9, end);
        i = e < 0 ? n : e + 3;
        continue;
      }
      i = skipDeclaration(text, lt);
      continue;
    }
    if (c === 63) {
      // <?xml ... ?> or other processing instruction
      const e = text.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === 47) {
      // </name>
      let j = lt + 2;
      while (j < n && isNameChar(text.charCodeAt(j))) j++;
      const name = html ? text.slice(lt + 2, j).toLowerCase() : text.slice(lt + 2, j);
      const gt = text.indexOf('>', j);
      const end = gt < 0 ? n : gt + 1;
      closeTo(name, lt, end);
      i = end;
      continue;
    }

    // <name attr="v" ...> or <name/>
    const nameStart = lt + 1;
    let j = nameStart;
    while (j < n && isNameChar(text.charCodeAt(j))) j++;
    if (j === nameStart || !isNameStart(c)) {
      // A bare '<' in text.
      if (!html) b.error(lt, 'Unescaped "<" in text');
      addText(lt, lt + 1);
      i = lt + 1;
      continue;
    }
    const nameEnd = j;
    const name = html ? text.slice(nameStart, nameEnd).toLowerCase() : '';
    if (html && name === 'p') {
      // An open <p> is implicitly closed by another <p>.
      const top = b.top;
      if (top > 0 && tagName(top) === 'p') b.close(lt);
    }
    b.open(T_OBJECT, F_ELEMENT, nameStart, nameEnd, lt);

    let selfClosing = false;
    for (;;) {
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (j >= n) {
        b.error(lt, 'Unterminated start tag');
        break;
      }
      const d = text.charCodeAt(j);
      if (d === 62) {
        j++;
        break;
      }
      if (d === 47 && text.charCodeAt(j + 1) === 62) {
        selfClosing = true;
        j += 2;
        break;
      }
      if (d === 60) {
        b.error(j, 'Unterminated start tag');
        break;
      }
      // Attribute
      const aStart = j;
      while (j < n && isNameChar(text.charCodeAt(j))) j++;
      if (j === aStart) {
        j++; // stray character such as a lone '/'
        continue;
      }
      const aEnd = j;
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (text.charCodeAt(j) !== 61) {
        b.leaf(T_STRING, F_ATTR, aStart, aEnd, aEnd, aEnd); // boolean attribute
        continue;
      }
      j++;
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      const q = text.charCodeAt(j);
      let vStart: number;
      let vEnd: number;
      if (q === 34 || q === 39) {
        vStart = j + 1;
        vEnd = text.indexOf(q === 34 ? '"' : "'", vStart);
        if (vEnd < 0) {
          b.error(j, 'Unterminated attribute value');
          vEnd = n;
        }
        j = vEnd + 1;
      } else {
        vStart = j;
        while (j < n && !isSpace(text.charCodeAt(j)) && text.charCodeAt(j) !== 62) j++;
        vEnd = j;
      }
      const amp = text.indexOf('&', vStart);
      b.leaf(T_STRING, F_ATTR | (amp >= 0 && amp < vEnd ? F_ESCAPED : 0), aStart, aEnd, vStart, vEnd);
    }

    if (selfClosing || (html && VOID_ELEMENTS.has(name))) {
      b.close(j);
    } else if (html && RAW_TEXT.has(name)) {
      const close = indexOfCaseInsensitive(text, `</${name}`, j);
      const end = close < 0 ? n : close;
      if (end > j) b.leaf(T_STRING, F_TEXT | F_CDATA, 0, 0, j, end);
      const gt = close < 0 ? n : text.indexOf('>', close);
      b.close(gt < 0 ? n : gt + 1);
      j = gt < 0 ? n : gt + 1;
    }
    i = j;
  }

  if (b.depth > 1) {
    if (!html) b.error(n, `Missing closing tag </${tagName(b.top)}>`);
  }
  const result = b.finish();
  result.parseMs = now() - started;
  return result;
}

function isNameStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c > 127;
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** Skips `<!DOCTYPE ...>` including an internal subset in brackets. */
function skipDeclaration(text: string, lt: number): number {
  let depth = 0;
  for (let j = lt + 2; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === 91) depth++;
    else if (c === 93) depth--;
    else if (c === 62 && depth <= 0) return j + 1;
    else if (c === 34 || c === 39) {
      const e = text.indexOf(c === 34 ? '"' : "'", j + 1);
      if (e < 0) return text.length;
      j = e;
    }
  }
  return text.length;
}

function indexOfCaseInsensitive(text: string, needle: string, from: number): number {
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'gi');
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? m.index : -1;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
