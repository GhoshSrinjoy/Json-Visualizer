/** Ruby. */

import { alwaysTrue, IRConverter, type Stmt, type SwitchShape } from '../ir';
import type { CodeSymbol, ImportRef, SymbolKind } from '../model';
import { paramNames, type LanguageSpec, type OutlineParts, type SymbolBuilder } from '../spec';
import { clean, docComment, field, fields, firstLine, headerText, isComment, named, paramsText, statements, walk } from '../syntax';
import type { SyntaxNode } from '../treesitter';

const REQUIRES = new Set(['require', 'require_relative', 'load']);
const VISIBILITY = new Set(['private', 'protected', 'public']);
const MIXINS = new Set(['include', 'extend', 'prepend']);
const ATTRIBUTES = new Set(['attr_reader', 'attr_writer', 'attr_accessor']);
const RAISES = new Set(['raise', 'fail']);
const METHODS = new Set(['method', 'singleton_method']);
/** Iterators whose block reads as a loop body when the call is a statement. */
const ITERATORS = new Set([
  'each', 'each_with_index', 'each_with_object', 'each_pair', 'each_key', 'each_value', 'each_index', 'each_slice', 'each_cons',
  'each_char', 'each_line', 'each_byte', 'each_entry', 'reverse_each', 'find_each', 'times', 'upto', 'downto', 'step',
]);
/** Iterators that build a value: loops too, unless that value is the method's result. */
const MAPPERS = new Set(['map', 'map!', 'collect', 'flat_map', 'select', 'select!', 'filter', 'filter_map', 'reject', 'reject!']);
/** Calls kept as plain statements when they end a method (their value is not the point). */
const VOID_CALLS = new Set(['puts', 'print', 'p', 'pp', 'printf', 'warn', ...REQUIRES, ...RAISES, ...VISIBILITY, ...MIXINS, ...ATTRIBUTES]);
const VALUES = new Set([
  'identifier', 'constant', 'scope_resolution', 'instance_variable', 'class_variable', 'global_variable', 'self', 'nil', 'true',
  'false', 'integer', 'float', 'rational', 'complex', 'string', 'chained_string', 'simple_symbol', 'delimited_symbol', 'array',
  'string_array', 'symbol_array', 'hash', 'range', 'regex', 'binary', 'unary', 'conditional', 'element_reference',
  'parenthesized_statements', 'lambda', 'call', 'yield', 'super',
]);
/** Containers whose named children are statements. */
const BODIES = new Set(['program', 'body_statement', 'then', 'else', 'do', 'block_body', 'begin', 'ensure']);
const MODIFIERS = new Set(['if_modifier', 'unless_modifier', 'while_modifier', 'until_modifier', 'rescue_modifier']);

/** Contents of a plain (non-interpolated) string literal. */
function stringValue(n: SyntaxNode | null | undefined): string | undefined {
  if (n?.type !== 'string') return undefined;
  const parts = named(n);
  return parts.every((p) => p.type === 'string_content' || p.type === 'escape_sequence') ? parts.map((p) => p.text).join('') : undefined;
}

function symbolName(n: SyntaxNode): string | undefined {
  if (n.type === 'simple_symbol') return n.text.replace(/^:/, '');
  return stringValue(n);
}

function method(call: SyntaxNode): string {
  return field(call, 'method')?.text ?? '';
}

function args(call: SyntaxNode): SyntaxNode[] {
  const a = field(call, 'arguments');
  return a ? named(a) : [];
}

/** First / last statement of its body (comments aside). */
function isFirst(n: SyntaxNode): boolean {
  for (let s = n.previousNamedSibling; s; s = s.previousNamedSibling) if (!isComment(s)) return false;
  return true;
}

function isLast(n: SyntaxNode): boolean {
  for (let s = n.nextNamedSibling; s; s = s.nextNamedSibling) if (!isComment(s)) return false;
  return true;
}

/** A comment before the first statement of a body sits outside the `body_statement` node. */
function leadingDoc(n: SyntaxNode): string | undefined {
  return n.parent?.type === 'body_statement' && isFirst(n) ? docComment(n.parent) : undefined;
}

/** `require 'json'`, `require_relative 'x'`, `load 'tasks.rb'`. */
function requireOf(n: SyntaxNode): ImportRef | undefined {
  if (n.type !== 'call' || field(n, 'receiver') || !REQUIRES.has(method(n))) return undefined;
  const a = args(n);
  const source = a.length === 1 ? stringValue(a[0]) : undefined;
  return source === undefined ? undefined : { source, names: [{ name: '*' }], kind: 'require', line: n.startPosition.row };
}

export function outlineRuby(root: SyntaxNode, b: SymbolBuilder): OutlineParts {
  const symbols: CodeSymbol[] = [];
  const imports: ImportRef[] = [];

  const add = (sym: CodeSymbol, parent: CodeSymbol | null): CodeSymbol => {
    if (!parent) symbols.push(sym);
    return sym;
  };

  const def = (node: SyntaxNode, parent: CodeSymbol | null, visibility: string | undefined, singleton: boolean): void => {
    const name = field(node, 'name')?.text;
    if (!name) return;
    const inType = parent?.kind === 'class' || parent?.kind === 'module';
    const kind: SymbolKind = !inType ? 'function' : name === 'initialize' ? 'constructor' : 'method';
    const mods = [visibility, singleton || node.type === 'singleton_method' ? 'static' : undefined].filter((m): m is string => !!m);
    const sym = b.make(node, kind, name, parent, {
      signature: paramsText(field(node, 'parameters')),
      modifiers: mods.length ? mods : undefined,
      doc: leadingDoc(node),
    });
    b.callable(add(sym, parent), node);
  };

  const container = (node: SyntaxNode, parent: CodeSymbol | null): void => {
    const name = field(node, 'name');
    if (!name) return;
    const sup = field(node, 'superclass');
    const base = sup ? named(sup)[0] : undefined;
    const kind = node.type === 'module' ? 'module' : 'class';
    const sym = add(b.make(node, kind, name.text, parent, { bases: base ? [clean(base.text, 50)] : undefined, doc: leadingDoc(node) }), parent);
    body(field(node, 'body'), sym, false);
  };

  /** Statements of a class/module body (or the program); tracks `private`/`protected` sections. */
  const body = (node: SyntaxNode | null, parent: CodeSymbol | null, singleton: boolean): void => {
    if (!node) return;
    let visibility: string | undefined;
    for (const c of named(node)) {
      switch (c.type) {
        case 'module':
        case 'class':
          container(c, parent);
          break;
        case 'singleton_class':
          // class << self: its methods are class methods.
          if (parent) body(field(c, 'body'), parent, true);
          break;
        case 'method':
        case 'singleton_method':
          def(c, parent, visibility, singleton);
          break;
        case 'identifier':
          if (parent && VISIBILITY.has(c.text)) visibility = c.text === 'public' ? undefined : c.text;
          break;
        case 'call':
          if (parent) visibility = classCall(c, parent, visibility, singleton);
          break;
        case 'assignment':
          assignment(c, parent);
          break;
      }
    }
  };

  /** Macros in class bodies: visibility, attributes, mixins. Returns the visibility for what follows. */
  const classCall = (c: SyntaxNode, cls: CodeSymbol, visibility: string | undefined, singleton: boolean): string | undefined => {
    const m = method(c);
    if (field(c, 'receiver')) return visibility;
    const a = args(c);
    if (VISIBILITY.has(m)) {
      const mod = m === 'public' ? undefined : m;
      if (!a.length) return mod;
      for (const arg of a) {
        if (METHODS.has(arg.type)) def(arg, cls, mod, singleton); // private def secret … end
        const target = symbolName(arg);
        const sym = target && cls.children?.find((s) => s.name === target && (s.kind === 'method' || s.kind === 'constructor'));
        if (sym) sym.modifiers = [...(sym.modifiers ?? []).filter((x) => !VISIBILITY.has(x)), ...(mod ? [mod] : [])];
      }
    } else if (ATTRIBUTES.has(m)) {
      for (const arg of a) {
        const name = symbolName(arg);
        // A single attribute takes the whole line (and its doc comment).
        const mods = visibility ? [visibility] : undefined;
        if (name) b.make(a.length === 1 ? c : arg, 'property', name, cls, { detail: m, modifiers: mods, doc: leadingDoc(c) });
      }
    } else if (MIXINS.has(m)) {
      const mixins = a.filter((x) => x.type === 'constant' || x.type === 'scope_resolution').map((x) => x.text);
      if (mixins.length) cls.bases = [...(cls.bases ?? []), ...mixins];
    }
    return visibility;
  };

  const assignment = (a: SyntaxNode, parent: CodeSymbol | null): void => {
    const left = field(a, 'left');
    const right = field(a, 'right');
    const extra = { detail: right ? clean(right.text, 50) : undefined, doc: leadingDoc(a) };
    if (left?.type === 'constant') add(b.make(a, 'constant', left.text, parent, extra), parent);
    else if (left?.type === 'class_variable' && parent) b.make(a, 'field', left.text, parent, { ...extra, modifiers: ['static'] });
    else if (left?.type === 'global_variable' && !parent) add(b.make(a, 'variable', left.text, parent, extra), parent);
  };

  body(root, null, false);
  walk(root, (n) => {
    const imp = requireOf(n);
    if (imp) imports.push(imp);
    return true;
  });
  return { symbols, imports, exports: symbols.map((s) => s.name) };
}

// ---------------------------------------------------------------- flow

function isStatement(n: SyntaxNode): boolean {
  const p = n.parent;
  if (!p) return false;
  return BODIES.has(p.type) || (MODIFIERS.has(p.type) && field(p, 'body')?.id === n.id);
}

/** True for the expression whose value a method returns (its last statement, or `def x = expr`). */
function isMethodResult(n: SyntaxNode): boolean {
  const p = n.parent;
  if (!p) return false;
  if (METHODS.has(p.type)) return field(p, 'body')?.id === n.id;
  const fn = p.parent;
  if (p.type !== 'body_statement' || !fn || !METHODS.has(fn.type) || field(fn, 'name')?.text === 'initialize') return false;
  return isLast(n);
}

function returnsValue(n: SyntaxNode): boolean {
  if (!VALUES.has(n.type)) return false;
  if (n.type === 'call') return !!field(n, 'receiver') || !VOID_CALLS.has(method(n));
  return n.type !== 'identifier' || !VOID_CALLS.has(n.text);
}

/** Block of a statement-level iterator call (`items.each do |x| … end`), or of `loop do … end`. */
function iteratorBlock(call: SyntaxNode): SyntaxNode | null {
  const block = field(call, 'block');
  if (!block) return null;
  const m = method(call);
  if (!field(call, 'receiver')) return m === 'loop' ? block : null;
  return ITERATORS.has(m) || (MAPPERS.has(m) && !isMethodResult(call)) ? block : null;
}

function iteratorLoop(call: SyntaxNode, block: SyntaxNode, conv: IRConverter): Stmt {
  const params = field(block, 'parameters');
  const head = headerText(call, block);
  const p = params ? ` ${params.text}` : '';
  const forever = method(call) === 'loop';
  return {
    k: 'loop',
    node: call,
    loop: forever ? 'infinite' : 'forEach',
    header: forever ? 'loop' : block.type === 'do_block' ? `${head} do${p}` : `${head} {${p} … }`,
    headerNode: field(call, 'receiver'),
    body: conv.stmts(field(block, 'body')),
  };
}

/** rescue / else / ensure clauses always come last. */
function hasRescue(n: SyntaxNode): boolean {
  let c = n.lastNamedChild;
  while (c && isComment(c)) c = c.previousNamedSibling;
  return c?.type === 'rescue' || c?.type === 'else' || c?.type === 'ensure';
}

/** `begin … rescue … else … ensure … end` (also implicit in method and block bodies). */
function rescueBlock(node: SyntaxNode, conv: IRConverter): Stmt {
  const parts = statements(node);
  const els = parts.find((c) => c.type === 'else');
  const ensure = parts.find((c) => c.type === 'ensure');
  return {
    k: 'try',
    node,
    body: conv.list(parts.filter((c) => c.type !== 'rescue' && c.type !== 'else' && c.type !== 'ensure')),
    handlers: parts
      .filter((c) => c.type === 'rescue')
      .map((r) => ({ label: headerText(r, field(r, 'body'), 60) || 'rescue', body: conv.stmts(field(r, 'body')), node: r })),
    else: els ? conv.list(named(els)) : undefined,
    finally: ensure ? conv.list(named(ensure)) : undefined,
  };
}

/** `x while cond`, `x until cond`, and `begin … end while cond` (body runs first). */
function modifierLoop(node: SyntaxNode, conv: IRConverter): Stmt {
  const cond = field(node, 'condition');
  const body = field(node, 'body');
  const c = clean(cond?.text ?? '');
  // `x while true` only exits through break.
  const forever = node.type === 'while_modifier' && !!cond && alwaysTrue(cond);
  return {
    k: 'loop',
    node,
    loop: forever ? 'infinite' : body?.type === 'begin' ? 'doWhile' : 'while',
    header: `while ${node.type === 'until_modifier' ? `not (${c})` : c}`,
    headerNode: cond,
    body: conv.stmts(body),
  };
}

function caseShape(node: SyntaxNode): SwitchShape {
  const cases: SwitchShape['cases'] = [];
  for (const c of named(node)) {
    const body = field(c, 'body');
    if (c.type === 'when' || c.type === 'in_clause') {
      // `when 1, 2` lists patterns; `in [a, *] if a > 0` has one pattern and an optional guard.
      const label = [...fields(c, 'pattern'), ...fields(c, 'guard')].map((p) => clean(p.text, 40)).join(c.type === 'when' ? ', ' : ' ');
      cases.push({ label, body: body ? [body] : [], isDefault: false, node: c });
    } else if (c.type === 'else') {
      cases.push({ label: 'else', body: named(c), isDefault: true, node: c });
    }
  }
  // A subject-less `case` is labelled by its keyword.
  return { subject: field(node, 'value') ?? node.child(0), cases };
}

function special(node: SyntaxNode, conv: IRConverter, expanded?: number): Stmt[] | undefined {
  const parent = node.parent;
  if (parent?.type === 'body_statement' && parent.id !== expanded && hasRescue(parent)) {
    // A body with rescue/ensure clauses is an implicit begin … end, emitted at its first statement.
    if (!isFirst(node)) return [];
    return [rescueBlock(parent, new IRConverter({ ...conv.rules, special: (n, c) => special(n, c, parent.id) }))];
  }
  switch (node.type) {
    case 'begin':
      return hasRescue(node) ? [rescueBlock(node, conv)] : conv.list(named(node));
    case 'until': {
      const cond = field(node, 'condition');
      const header = `while not (${clean(cond?.text ?? '')})`;
      return [{ k: 'loop', node, loop: 'while', header, headerNode: cond, body: conv.stmts(field(node, 'body')) }];
    }
    case 'while_modifier':
    case 'until_modifier':
      return [modifierLoop(node, conv)];
    case 'rescue_modifier': {
      const handler = { label: 'rescue', body: conv.stmts(field(node, 'handler')), node };
      return [{ k: 'try', node, body: conv.stmts(field(node, 'body')), handlers: [handler] }];
    }
    case 'identifier':
      // Bare `raise` re-raises.
      if (RAISES.has(node.text)) return [{ k: 'jump', node, jump: 'throw', text: node.text }];
      break;
    case 'call': {
      if (!field(node, 'receiver') && RAISES.has(method(node))) {
        return [{ k: 'jump', node, jump: 'throw', text: firstLine(node, 80), valueNode: field(node, 'arguments') }];
      }
      const block = iteratorBlock(node);
      if (block) return [iteratorLoop(node, block, conv)];
      break;
    }
    case 'binary': {
      // `items << x`: the statement is the `<<` call on `items` (see calls['<<']).
      const op = field(node, 'operator');
      if (op?.type === '<<') return [{ k: 'simple', node: op, text: firstLine(node) }];
      break;
    }
  }
  // The last expression is the method's value. Done here rather than through FlowRules.implicitReturn,
  // which IRConverter.body() checks by node identity (tree-sitter returns fresh node objects).
  if (isMethodResult(node) && returnsValue(node)) {
    return [{ k: 'jump', node, jump: 'return', text: `return ${firstLine(node, 70)}`, valueNode: node }];
  }
  return undefined;
}

/** Name of the class whose `new` a call invokes: `User.new`, `App::User.new`, or bare `new` inside the class. */
function constructed(n: SyntaxNode, recv: SyntaxNode | null): string | undefined {
  if (recv?.type === 'constant') return recv.text;
  if (recv?.type === 'scope_resolution') return field(recv, 'name')?.text;
  if (recv && recv.type !== 'self') return undefined;
  for (let p = n.parent; p; p = p.parent) if (p.type === 'class') return field(p, 'name')?.text.split('::').pop();
  return undefined;
}

function callName(n: SyntaxNode): { name: string; receiver?: string } {
  const recv = field(n, 'receiver');
  // `User.new(…)` is named like the class (as Python's `User(…)`), so it resolves to `initialize`.
  const cls = method(n) === 'new' ? constructed(n, recv) : undefined;
  if (cls) return { name: cls };
  const p = n.parent;
  // `obj.attr = x` / `self.count += 1` call the writer `attr=`.
  const writer = (p?.type === 'assignment' || p?.type === 'operator_assignment') && field(p, 'left')?.id === n.id;
  return { name: writer ? `${method(n)}=` : method(n), receiver: recv ? clean(recv.text, 40) : undefined };
}

/** `x << y` as a statement appends to `x`. */
function appendCall(op: SyntaxNode): { name: string; receiver?: string } | null {
  const bin = op.parent;
  const left = bin?.type === 'binary' && isStatement(bin) ? field(bin, 'left') : null;
  return left ? { name: '<<', receiver: clean(left.text, 40) } : null;
}

function iteratorBinding(n: SyntaxNode, part: 'target' | 'value'): SyntaxNode | null {
  const block = n.type === 'call' ? iteratorBlock(n) : null;
  if (!block) return null;
  return part === 'target' ? field(block, 'parameters') : field(n, 'receiver');
}

/** `for x in items`: the iterable inside the `in` clause. */
function forIterable(n: SyntaxNode): SyntaxNode | null {
  const clause = field(n, 'value');
  return clause ? (named(clause)[0] ?? null) : null;
}

const blockParams = (n: SyntaxNode) => paramNames(field(n, 'parameters'));

export const ruby: LanguageSpec = {
  id: 'ruby',
  name: 'Ruby',
  grammar: 'ruby',
  extensions: ['rb', 'rake', 'gemspec'],
  fileNames: ['Rakefile', 'Gemfile'],
  lineComment: ['#'],
  blockComment: ['=begin', '=end'],
  outline: outlineRuby,
  functionBody: (fn) => field(fn, 'body'),
  params: (fn) => paramNames(field(fn, 'parameters')),
  functionTypes: ['method', 'singleton_method', 'class', 'module', 'singleton_class', 'lambda'],
  // `while`, `for` and `case` arms are counted from the flow rules.
  decisionTypes: ['if', 'elsif', 'unless', 'until', 'rescue', 'conditional', ...MODIFIERS, 'call'],
  decisionWeight: (n) => {
    // Iterator blocks drawn as loops (`items.each do`); `loop do` only exits through break.
    if (n.type === 'call') return isStatement(n) && method(n) !== 'loop' && iteratorBlock(n) ? 1 : 0;
    const cond = n.type === 'while_modifier' ? field(n, 'condition') : null;
    return cond && alwaysTrue(cond) ? 0 : 1;
  },
  calls: {
    call: {
      callee: (n) => field(n, 'method'),
      name: callName,
      // A block's free variables feed the call like arguments do.
      args: (n) => field(n, 'arguments') ?? field(n, 'block'),
    },
    '<<': { callee: () => null, name: appendCall, args: (op) => (op.parent ? field(op.parent, 'right') : null) },
  },
  flow: {
    blocks: ['body_statement', 'then', 'do', 'block_body'],
    ifs: ['if', 'if_modifier'],
    unless: ['unless', 'unless_modifier'],
    elifs: ['elsif'],
    elses: ['else'],
    whiles: ['while'],
    fors: [],
    forEachs: ['for'],
    switches: ['case', 'case_match'],
    // begin/rescue (explicit or implicit) is converted in `special`.
    tries: [],
    returns: ['return'],
    throws: [],
    breaks: ['break'],
    continues: ['next'],
    definitions: ['method', 'singleton_method', 'class', 'module', 'singleton_class'],
    fallthrough: false,
    switchShape: caseShape,
    tryShape: () => ({ body: null, handlers: [] }),
    special,
  },
  data: {
    assigns: {
      assignment: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
      operator_assignment: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
    },
    members: {
      // Attribute writes: `self.name = x`, `obj.attr = 1` (reads are calls).
      call: { object: 'receiver', property: 'method' },
      element_reference: { object: 'object', property: 'index' },
    },
    identifiers: ['identifier', 'instance_variable', 'class_variable', 'global_variable'],
    selfNames: ['self'],
    skip: ['comment', 'simple_symbol', 'hash_key_symbol', 'regex'],
    loopBindings: {
      for: { target: (n) => field(n, 'pattern'), value: forIterable },
      call: { target: (n) => iteratorBinding(n, 'target'), value: (n) => iteratorBinding(n, 'value') },
    },
    scopes: {
      block: blockParams,
      do_block: blockParams,
      lambda: blockParams,
    },
  },
};
