/**
 * JSONPath (RFC 9535 subset) over a DataTree.
 *
 *   $.store.book[0].title        users[*].email         $..price
 *   $.items[-1]  $.items[0:10:2]  $['odd key']           $.a[0,2]
 *   $.users[?(@.age >= 18 && @.active)]                  $..book[?@.price < 10]
 *   $.users[?(@.email =~ /@example\.com$/i)]             $.list[?length(@.tags) > 2]
 *
 * The leading `$` is optional. In XML trees `name[i]` indexes the i-th
 * sibling named `name`, matching how paths are displayed.
 */

import { DataTree, T_ARRAY, T_OBJECT, type Primitive } from './tree';

type Selector =
  | { kind: 'name'; name: string }
  | { kind: 'wildcard' }
  | { kind: 'index'; index: number }
  | { kind: 'slice'; start?: number; end?: number; step?: number }
  | { kind: 'filter'; expr: Expr }
  | { kind: 'union'; items: Selector[] }
  | { kind: 'nameIndex'; name: string; index: number };

interface Segment {
  descendant: boolean;
  selector: Selector;
}

type Expr =
  | { op: 'lit'; value: Primitive }
  | { op: 'path'; root: '@' | '$'; segments: Segment[] }
  | { op: 'regex'; re: RegExp }
  | { op: 'not'; a: Expr }
  | { op: 'and' | 'or'; items: Expr[] }
  | { op: 'cmp'; cmp: string; a: Expr; b: Expr }
  | { op: 'fn'; name: string; args: Expr[] };

export class QueryError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

export interface QueryResult {
  ids: number[];
  /** Matches found (may exceed ids.length when truncated). */
  total: number;
  truncated: boolean;
  /** Evaluation stopped at the internal cap on intermediate results, so `total` is a lower bound. */
  capped: boolean;
}

// ---------------------------------------------------------------- parsing

/** Nesting of brackets, parentheses, calls and `!` in a query (bounds the recursive descent). */
const MAX_NESTING = 256;

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

class Parser {
  i = 0;
  private depth = 0;
  constructor(readonly s: string) {}

  /** Runs a nested production, failing cleanly instead of overflowing the stack. */
  nested<T>(f: () => T): T {
    if (++this.depth > MAX_NESTING) this.fail('Query is nested too deeply');
    try {
      return f();
    } finally {
      this.depth--;
    }
  }

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  peek(k = 0) {
    return this.s[this.i + k];
  }
  eat(str: string) {
    this.ws();
    if (this.s.startsWith(str, this.i)) {
      this.i += str.length;
      return true;
    }
    return false;
  }
  expect(str: string) {
    if (!this.eat(str)) throw new QueryError(`Expected "${str}"`, this.i);
  }
  fail(msg: string): never {
    throw new QueryError(msg, this.i);
  }

  /** Path segments until a character that cannot continue a path. */
  segments(): Segment[] {
    const segs: Segment[] = [];
    for (;;) {
      const c = this.peek();
      if (c === '.' && this.peek(1) === '.') {
        this.i += 2;
        if (this.peek() === '[') segs.push({ descendant: true, selector: this.bracket() });
        else segs.push({ descendant: true, selector: this.dotName() });
      } else if (c === '.') {
        this.i++;
        segs.push({ descendant: false, selector: this.dotName() });
      } else if (c === '[') {
        segs.push({ descendant: false, selector: this.bracket() });
      } else return segs;
    }
  }

  dotName(): Selector {
    if (this.peek() === '*') {
      this.i++;
      return { kind: 'wildcard' };
    }
    const m = /^[@#]?[^\s.[\]()=!<>&|,'"]+/.exec(this.s.slice(this.i));
    if (!m) this.fail('Expected a property name');
    this.i += m[0].length;
    return { kind: 'name', name: m[0] };
  }

  bracket(): Selector {
    return this.nested(() => {
      this.expect('[');
      const items: Selector[] = [];
      do {
        items.push(this.bracketItem());
      } while (this.eat(','));
      this.expect(']');
      return items.length === 1 ? items[0] : { kind: 'union', items };
    });
  }

  bracketItem(): Selector {
    this.ws();
    const c = this.peek();
    if (c === '*') {
      this.i++;
      return { kind: 'wildcard' };
    }
    if (c === "'" || c === '"') return { kind: 'name', name: this.string() };
    if (c === '?') {
      // `?(…)` is just a parenthesised expression: `?(@.a) && (@.b)` continues after it.
      this.i++;
      return { kind: 'filter', expr: this.orExpr() };
    }
    // index or slice
    const nums: (number | undefined)[] = [];
    let colons = 0;
    for (;;) {
      this.ws();
      const m = /^-?\d+/.exec(this.s.slice(this.i));
      if (m) {
        this.i += m[0].length;
        nums[colons] = Number(m[0]);
      }
      this.ws();
      if (this.peek() === ':' && colons < 2) {
        this.i++;
        colons++;
        continue;
      }
      break;
    }
    if (colons === 0) {
      if (nums[0] === undefined) {
        // Bare name inside brackets: [name]
        const m = /^[A-Za-z_$@#][\w$:-]*/.exec(this.s.slice(this.i));
        if (m) {
          this.i += m[0].length;
          return { kind: 'name', name: m[0] };
        }
        this.fail('Expected index, slice, name or filter');
      }
      return { kind: 'index', index: nums[0]! };
    }
    return { kind: 'slice', start: nums[0], end: nums[1], step: nums[2] };
  }

  /** Quoted string with JSON-style escapes (`\n`, `\uXXXX`, `\'`, …). */
  string(): string {
    const q = this.s[this.i++];
    let out = '';
    while (this.i < this.s.length && this.s[this.i] !== q) {
      if (this.s[this.i] === '\\' && this.i + 1 < this.s.length) {
        const n = this.s[++this.i];
        if (n === 'u') {
          const hex = this.s.slice(this.i + 1, this.i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
        } else out += ESCAPES[n] ?? n;
      } else out += this.s[this.i];
      this.i++;
    }
    if (this.s[this.i] !== q) this.fail('Unterminated string');
    this.i++;
    return out;
  }

  orExpr(): Expr {
    const items = [this.andExpr()];
    while (this.eat('||')) items.push(this.andExpr());
    return items.length === 1 ? items[0] : { op: 'or', items };
  }
  andExpr(): Expr {
    const items = [this.unary()];
    while (this.eat('&&')) items.push(this.unary());
    return items.length === 1 ? items[0] : { op: 'and', items };
  }
  unary(): Expr {
    this.ws();
    if (this.peek() === '!' && this.peek(1) !== '=') {
      this.i++;
      return { op: 'not', a: this.nested(() => this.unary()) };
    }
    return this.comparison();
  }
  comparison(): Expr {
    const a = this.primary();
    this.ws();
    for (const cmp of ['==', '!=', '<=', '>=', '=~', '<', '>']) {
      if (this.s.startsWith(cmp, this.i)) {
        this.i += cmp.length;
        const b = this.primary();
        return { op: 'cmp', cmp, a, b };
      }
    }
    return a;
  }
  primary(): Expr {
    this.ws();
    const c = this.peek();
    if (c === '(') {
      this.i++;
      const e = this.nested(() => this.orExpr());
      this.expect(')');
      return e;
    }
    if (c === '@' || c === '$') {
      this.i++;
      return { op: 'path', root: c, segments: this.segments() };
    }
    if (c === "'" || c === '"') return { op: 'lit', value: this.string() };
    if (c === '/') {
      const end = findRegexEnd(this.s, this.i);
      if (end < 0) this.fail('Unterminated regex');
      const body = this.s.slice(this.i + 1, end);
      const flags = /^[gimsuy]*/.exec(this.s.slice(end + 1))![0];
      this.i = end + 1 + flags.length;
      try {
        return { op: 'regex', re: new RegExp(body, flags.replace('g', '')) };
      } catch (e) {
        this.fail(`Invalid regex: ${(e as Error).message}`);
      }
    }
    const num = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return { op: 'lit', value: Number(num[0]) };
    }
    const word = /^[A-Za-z_]\w*/.exec(this.s.slice(this.i));
    if (word) {
      this.i += word[0].length;
      const w = word[0];
      if (w === 'true' || w === 'false') return { op: 'lit', value: w === 'true' };
      if (w === 'null') return { op: 'lit', value: null };
      if (this.eat('(')) {
        const args: Expr[] = [];
        if (!this.eat(')')) {
          do args.push(this.nested(() => this.orExpr()));
          while (this.eat(','));
          this.expect(')');
        }
        return { op: 'fn', name: w, args };
      }
      this.fail(`Unknown identifier "${w}"`);
    }
    this.fail('Expected a value');
  }
}

function findRegexEnd(s: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i;
  }
  return -1;
}

export function parseQuery(query: string): Segment[] {
  const p = new Parser(query.trim());
  if (p.peek() === '$') p.i++;
  else if (p.peek() !== '.' && p.peek() !== '[' && p.s.length) {
    // `users[0].name` shorthand: treat the first name as `.users`.
    const sel = p.dotName();
    const rest = p.segments();
    if (p.i < p.s.length) p.fail(`Unexpected "${p.s[p.i]}"`);
    return [{ descendant: false, selector: sel }, ...rest];
  }
  const segs = p.segments();
  p.ws();
  if (p.i < p.s.length) p.fail(`Unexpected "${p.s[p.i]}"`);
  return segs;
}

// ---------------------------------------------------------------- evaluation

export function runQuery(tree: DataTree, query: string, limit = 1000, from = tree.root): QueryResult {
  let segs = parseQuery(query);
  if (tree.xmlLike) segs = groupXml(segs);
  // Intermediate node lists are capped so `$..*` on huge documents stays bounded.
  const hardCap = Math.max(limit * 100, 100_000);
  let nodes = [from];
  let capped = false;
  for (const seg of segs) {
    const next: number[] = [];
    const seen = seg.descendant ? new Set<number>() : undefined;
    for (const id of nodes) {
      if (seg.descendant) {
        const end = id + tree.size[id];
        for (let d = id; d < end; d++) {
          if (!tree.isContainer(d)) continue;
          select(tree, d, seg.selector, (c) => {
            if (!seen!.has(c)) {
              seen!.add(c);
              next.push(c);
            }
          });
          if (next.length > hardCap) break;
        }
      } else select(tree, id, seg.selector, (c) => next.push(c));
      if (next.length > hardCap) {
        capped = true;
        break;
      }
    }
    nodes = next;
    if (!nodes.length) break;
  }
  const total = nodes.length;
  return { ids: nodes.slice(0, limit), total, truncated: total > limit, capped };
}

/** In XML, `name` followed by `[i]` addresses the i-th same-named sibling. */
function groupXml(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    const n = segs[k + 1];
    if (s.selector.kind === 'name' && n && !n.descendant && n.selector.kind === 'index') {
      out.push({ descendant: s.descendant, selector: { kind: 'nameIndex', name: s.selector.name, index: n.selector.index } });
      k++;
    } else out.push(s);
  }
  return out;
}

function select(tree: DataTree, id: number, sel: Selector, emit: (c: number) => void): void {
  const t = tree.type[id];
  if (t !== T_OBJECT && t !== T_ARRAY) return;
  switch (sel.kind) {
    case 'wildcard':
      for (let c = tree.firstChild(id); c >= 0; c = tree.nextSibling(c)) emit(c);
      return;
    case 'name':
      if (t !== T_OBJECT) return;
      for (let c = tree.firstChild(id); c >= 0; c = tree.nextSibling(c)) if (tree.key(c) === sel.name) emit(c);
      return;
    case 'nameIndex': {
      if (t !== T_OBJECT) return;
      const matches: number[] = [];
      for (let c = tree.firstChild(id); c >= 0; c = tree.nextSibling(c)) if (tree.key(c) === sel.name) matches.push(c);
      const i = sel.index < 0 ? matches.length + sel.index : sel.index;
      if (i >= 0 && i < matches.length) emit(matches[i]);
      return;
    }
    case 'index': {
      if (t !== T_ARRAY) return;
      const n = tree.childCount[id];
      const i = sel.index < 0 ? n + sel.index : sel.index;
      const c = tree.childAt(id, i);
      if (c >= 0) emit(c);
      return;
    }
    case 'slice': {
      if (t !== T_ARRAY) return;
      const n = tree.childCount[id];
      const step = sel.step ?? 1;
      if (step === 0) return;
      const norm = (v: number) => (v < 0 ? Math.max(0, n + v) : Math.min(n, v));
      if (step > 0) {
        const start = sel.start === undefined ? 0 : norm(sel.start);
        const end = sel.end === undefined ? n : norm(sel.end);
        const kids = tree.children(id, start, Math.max(0, end - start));
        for (let k = 0; k < kids.length; k += step) emit(kids[k]);
      } else {
        const start = sel.start === undefined ? n - 1 : Math.min(n - 1, sel.start < 0 ? n + sel.start : sel.start);
        const end = sel.end === undefined ? -1 : sel.end < 0 ? n + sel.end : sel.end;
        const kids = tree.children(id);
        for (let k = start; k > end && k >= 0; k += step) emit(kids[k]);
      }
      return;
    }
    case 'filter':
      for (let c = tree.firstChild(id); c >= 0; c = tree.nextSibling(c)) if (truthy(evalExpr(tree, sel.expr, c), tree)) emit(c);
      return;
    case 'union':
      for (const s of sel.items) select(tree, id, s, emit);
      return;
  }
}

/** Expression values: primitives, node ids (for path results), or undefined (nothing). */
type Value = { kind: 'value'; v: Primitive | RegExp } | { kind: 'nodes'; ids: number[] } | { kind: 'none' };

function evalExpr(tree: DataTree, e: Expr, current: number): Value {
  switch (e.op) {
    case 'lit':
      return { kind: 'value', v: e.value };
    case 'regex':
      return { kind: 'value', v: e.re };
    case 'path': {
      let nodes = [e.root === '@' ? current : tree.root];
      for (const seg of e.segments) {
        const next: number[] = [];
        for (const id of nodes) {
          if (seg.descendant) {
            const end = id + tree.size[id];
            for (let d = id; d < end; d++) select(tree, d, seg.selector, (c) => next.push(c));
          } else select(tree, id, seg.selector, (c) => next.push(c));
        }
        nodes = next;
        if (!nodes.length) return { kind: 'none' };
      }
      return { kind: 'nodes', ids: nodes };
    }
    case 'not':
      return { kind: 'value', v: !truthy(evalExpr(tree, e.a, current), tree) };
    case 'and':
      return { kind: 'value', v: e.items.every((x) => truthy(evalExpr(tree, x, current), tree)) };
    case 'or':
      return { kind: 'value', v: e.items.some((x) => truthy(evalExpr(tree, x, current), tree)) };
    case 'cmp': {
      const a = scalar(tree, evalExpr(tree, e.a, current));
      const bv = evalExpr(tree, e.b, current);
      if (e.cmp === '=~') {
        const re = bv.kind === 'value' && bv.v instanceof RegExp ? bv.v : new RegExp(String(scalar(tree, bv) ?? ''));
        return { kind: 'value', v: a !== undefined && a !== null && re.test(String(a)) };
      }
      return { kind: 'value', v: compare(e.cmp, a, scalar(tree, bv)) };
    }
    case 'fn':
      return callFn(tree, e.name, e.args.map((a) => evalExpr(tree, a, current)));
  }
}

function scalar(tree: DataTree, v: Value): Primitive | undefined {
  if (v.kind === 'none') return undefined;
  if (v.kind === 'value') return v.v instanceof RegExp ? v.v.source : v.v;
  if (v.ids.length !== 1) return undefined;
  const id = v.ids[0];
  return tree.isContainer(id) ? undefined : tree.value(id);
}

/**
 * Filter truthiness follows Goessner/Jayway JSONPath (what users expect from
 * `[?(@.active)]`): a single primitive is tested by value, containers and
 * multi-node results by existence.
 */
function truthy(v: Value, tree?: DataTree): boolean {
  if (v.kind === 'none') return false;
  if (v.kind === 'nodes') {
    if (v.ids.length !== 1 || !tree || tree.isContainer(v.ids[0])) return v.ids.length > 0;
    const p = tree.value(v.ids[0]);
    return p !== false && p !== null && p !== 0 && p !== '';
  }
  return v.v !== false && v.v !== null && v.v !== undefined && v.v !== 0 && v.v !== '';
}

function compare(op: string, a: Primitive | undefined, b: Primitive | undefined): boolean {
  if (a === undefined || b === undefined) return op === '!=' ? a !== b : false;
  // Allow numeric comparison of numeric strings (common in XML/CSV).
  if (typeof a !== typeof b) {
    if (typeof a === 'string' && typeof b === 'number' && a.trim() !== '' && !isNaN(Number(a))) a = Number(a);
    else if (typeof b === 'string' && typeof a === 'number' && b.trim() !== '' && !isNaN(Number(b))) b = Number(b);
  }
  switch (op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
  }
  if (a === null || b === null || typeof a !== typeof b) return false;
  switch (op) {
    case '<':
      return (a as number) < (b as number);
    case '<=':
      return (a as number) <= (b as number);
    case '>':
      return (a as number) > (b as number);
    case '>=':
      return (a as number) >= (b as number);
  }
  return false;
}

function callFn(tree: DataTree, name: string, args: Value[]): Value {
  const a = args[0];
  switch (name) {
    case 'length': {
      if (!a || a.kind === 'none') return { kind: 'none' };
      if (a.kind === 'nodes') {
        if (a.ids.length !== 1) return { kind: 'none' };
        const id = a.ids[0];
        if (tree.isContainer(id)) return { kind: 'value', v: tree.childCount[id] };
        const v = tree.value(id);
        return typeof v === 'string' ? { kind: 'value', v: v.length } : { kind: 'none' };
      }
      return typeof a.v === 'string' ? { kind: 'value', v: a.v.length } : { kind: 'none' };
    }
    case 'count':
      return { kind: 'value', v: a?.kind === 'nodes' ? a.ids.length : 0 };
    case 'match':
    case 'search': {
      const s = a ? scalar(tree, a) : undefined;
      const p = args[1] ? scalar(tree, args[1]) : undefined;
      if (typeof s !== 'string' || typeof p !== 'string') return { kind: 'value', v: false };
      try {
        const re = new RegExp(name === 'match' ? `^(?:${p})$` : p);
        return { kind: 'value', v: re.test(s) };
      } catch {
        return { kind: 'value', v: false };
      }
    }
    case 'value':
      return a ? { kind: 'value', v: scalar(tree, a) ?? null } : { kind: 'none' };
    case 'type': {
      if (!a || a.kind !== 'nodes' || a.ids.length !== 1) return { kind: 'none' };
      return { kind: 'value', v: tree.typeName(a.ids[0]) };
    }
  }
  throw new QueryError(`Unknown function "${name}"`, 0);
}
