/** Rust. */

import { genericSwitch, type IRConverter, type LoopKind, type Stmt, type SwitchShape } from '../ir';
import type { CodeSymbol, ImportRef } from '../model';
import { calleeName, paramNames, type LanguageSpec, type OutlineParts, type SymbolBuilder } from '../spec';
import { childOfType, clean, field, firstLine, hasToken, isComment, kids, named, rangeOf, statements } from '../syntax';
import type { SyntaxNode } from '../treesitter';

type LoopStmt = Extract<Stmt, { k: 'loop' }>;

const PANICS = new Set(['panic', 'unreachable', 'todo', 'unimplemented']);
const LOOPS: Record<string, LoopKind> = { for_expression: 'forEach', while_expression: 'while', loop_expression: 'infinite' };

const compact = (n: SyntaxNode) => n.text.replace(/\s+/g, '');
const lastSegment = (path: string) => path.split('::').pop() ?? path;

/** `use a::{b, c as d, e::*}` flattened to one import per path. */
function useImports(node: SyntaxNode): ImportRef[] {
  const out: ImportRef[] = [];
  const line = node.startPosition.row;
  const add = (source: string, name: string, alias?: string) => out.push({ source, names: [alias ? { name, alias } : { name }], kind: 'use', line });
  const join = (prefix: string, path: string) => (prefix ? `${prefix}::${path}` : path);
  const visit = (n: SyntaxNode, prefix: string): void => {
    switch (n.type) {
      case 'scoped_use_list': {
        const path = field(n, 'path');
        const pre = path ? join(prefix, compact(path)) : prefix;
        for (const c of named(field(n, 'list') ?? n)) visit(c, pre);
        return;
      }
      case 'use_list':
        for (const c of named(n)) visit(c, prefix);
        return;
      case 'use_as_clause': {
        const src = join(prefix, compact(field(n, 'path') ?? n));
        add(src, lastSegment(src), field(n, 'alias')?.text);
        return;
      }
      case 'use_wildcard': {
        const path = named(n)[0];
        add(path ? join(prefix, compact(path)) : prefix, '*');
        return;
      }
      case 'self': // `use std::fs::{self}` imports the module itself
        add(prefix, lastSegment(prefix));
        return;
      default: {
        const src = join(prefix, compact(n));
        add(src, lastSegment(src));
      }
    }
  };
  const arg = field(node, 'argument');
  if (arg) visit(arg, '');
  return out;
}

/** `User` for `User`, `Counter<T>`, `fmt::Formatter`, `&mut Vec<T>`. */
function typeName(t: SyntaxNode): string {
  if (t.type === 'scoped_type_identifier') return field(t, 'name')?.text ?? clean(t.text, 40);
  const inner = /^(generic_type|reference_type|pointer_type)$/.test(t.type) ? field(t, 'type') : null;
  return inner ? typeName(inner) : clean(t.text, 40);
}

/** `async`, `unsafe`, `const`, `extern "C"`… */
function fnModifiers(node: SyntaxNode): string[] {
  const fm = childOfType(node, 'function_modifiers');
  return fm ? kids(fm).map((k) => (k.isNamed ? clean(k.text, 20) : k.type)) : [];
}

function isMacroExported(node: SyntaxNode): boolean {
  for (let p = node.previousNamedSibling; p?.type === 'attribute_item'; p = p.previousNamedSibling) {
    if (/\bmacro_export\b/.test(p.text)) return true;
  }
  return false;
}

export function outlineRust(root: SyntaxNode, b: SymbolBuilder): OutlineParts {
  const symbols: CodeSymbol[] = [];
  const imports: ImportRef[] = [];
  const exports: string[] = [];

  /** Items of a module, impl, trait or function body (`inModule`: imports count). */
  const items = (container: SyntaxNode | null, parent: CodeSymbol | null, inModule: boolean) => {
    if (container) for (const node of named(container)) item(node, parent, inModule);
  };

  const item = (node: SyntaxNode, parent: CodeSymbol | null, inModule: boolean): void => {
    const vis = childOfType(node, 'visibility_modifier');
    const isPub = !!vis && !/^pub\s*\(\s*self\s*\)$/.test(vis.text);
    const mods = vis ? [clean(vis.text, 30)] : [];
    const modifiers = (extra: string[] = []) => (mods.length + extra.length ? [...mods, ...extra] : undefined);
    const name = field(node, 'name')?.text;
    const typeText = clean(field(node, 'type')?.text ?? '', 60) || undefined;
    const add = (sym: CodeSymbol, exported = isPub) => {
      if (parent) return;
      symbols.push(sym);
      if (exported) exports.push(sym.name);
    };
    const inType = parent?.kind === 'impl' || parent?.kind === 'trait';

    switch (node.type) {
      case 'use_declaration':
        if (!inModule) return;
        for (const imp of useImports(node)) {
          imports.push(imp);
          // `pub use` re-exports what it binds.
          const n = imp.names[0];
          if (isPub && !parent && n.name !== '*') exports.push(n.alias ?? n.name);
        }
        return;
      case 'extern_crate_declaration': {
        const alias = field(node, 'alias')?.text;
        if (inModule && name) imports.push({ source: name, names: [alias ? { name, alias } : { name }], kind: 'use', line: node.startPosition.row });
        return;
      }
      case 'mod_item': {
        if (!name) return;
        const body = field(node, 'body');
        if (!body) {
          // `mod models;` pulls in models.rs / models/mod.rs.
          if (inModule) imports.push({ source: name, names: [{ name }], kind: 'mod', line: node.startPosition.row });
          return;
        }
        const sym = b.make(node, 'module', name, parent, { modifiers: modifiers() });
        items(body, sym, true);
        add(sym);
        return;
      }
      case 'function_item':
      case 'function_signature_item': {
        if (!name) return;
        const sym = b.make(node, inType ? 'method' : 'function', name, parent, {
          signature: b.signature(field(node, 'parameters'), field(node, 'return_type'), ' -> '),
          modifiers: modifiers(fnModifiers(node)),
        });
        b.callable(sym, node);
        items(field(node, 'body'), sym, false); // nested fns, structs…
        add(sym);
        return;
      }
      case 'struct_item': {
        if (!name) return;
        const body = field(node, 'body');
        const sym = b.make(node, 'struct', name, parent, {
          modifiers: modifiers(),
          detail: body?.type === 'ordered_field_declaration_list' ? clean(body.text, 50) : undefined,
        });
        if (body?.type === 'field_declaration_list') {
          for (const f of named(body)) {
            const fn = field(f, 'name')?.text;
            if (f.type !== 'field_declaration' || !fn) continue;
            const fv = childOfType(f, 'visibility_modifier');
            b.make(f, 'field', fn, sym, { detail: clean(field(f, 'type')?.text ?? '', 40) || undefined, modifiers: fv ? [clean(fv.text, 30)] : undefined });
          }
        }
        add(sym);
        return;
      }
      case 'enum_item': {
        if (!name) return;
        const sym = b.make(node, 'enum', name, parent, { modifiers: modifiers() });
        for (const v of named(field(node, 'body') ?? node)) {
          const vn = field(v, 'name')?.text;
          if (v.type !== 'enum_variant' || !vn) continue;
          const body = field(v, 'body');
          const value = field(v, 'value');
          b.make(v, 'enumMember', vn, sym, { detail: body ? clean(body.text, 40) : value ? `= ${clean(value.text, 30)}` : undefined });
        }
        add(sym);
        return;
      }
      case 'trait_item': {
        if (!name) return;
        const bounds = field(node, 'bounds');
        const supers = bounds ? named(bounds).filter((c) => c.type !== 'lifetime').map((c) => clean(c.text, 50)) : [];
        const sym = b.make(node, 'trait', name, parent, {
          modifiers: modifiers(hasToken(node, 'unsafe') ? ['unsafe'] : []),
          bases: supers.length ? supers : undefined,
        });
        items(field(node, 'body'), sym, false);
        add(sym);
        return;
      }
      case 'impl_item': {
        const type = field(node, 'type');
        if (!type) return;
        const trait = field(node, 'trait');
        const traitText = trait ? `${hasToken(node, '!') ? '!' : ''}${clean(trait.text, 50)}` : '';
        const sym = b.make(node, 'impl', typeName(type), parent, {
          nameRange: rangeOf(type),
          detail: trait ? `impl ${traitText} for ${clean(type.text, 50)}` : `impl ${clean(type.text, 50)}`,
          bases: trait ? [traitText] : undefined,
          modifiers: hasToken(node, 'unsafe') ? ['unsafe'] : undefined,
        });
        items(field(node, 'body'), sym, false);
        add(sym, false);
        return;
      }
      case 'const_item':
        if (name) add(b.make(node, 'constant', name, parent, { modifiers: modifiers(), detail: typeText }));
        return;
      case 'static_item':
        if (name) add(b.make(node, 'variable', name, parent, { modifiers: modifiers(childOfType(node, 'mutable_specifier') ? ['mut'] : []), detail: typeText }));
        return;
      case 'type_item':
      case 'associated_type':
        if (name) add(b.make(node, 'type', name, parent, { modifiers: modifiers(), detail: typeText }));
        return;
      case 'macro_definition':
        if (name) add(b.make(node, 'macro', name, parent), isMacroExported(node));
        return;
      case 'foreign_mod_item': // extern "C" { fn …; }
        items(field(node, 'body'), parent, inModule);
        return;
    }
  };

  items(root, null, true);
  return { symbols, imports, exports };
}

// ---------------------------------------------------------------- flow

function isLastStatement(node: SyntaxNode): boolean {
  for (let s = node.nextNamedSibling; s; s = s.nextNamedSibling) if (!isComment(s)) return false;
  return true;
}

/**
 * True when the value of `node` is the function result: the final
 * expression of the body (no `;`), through `if`/`match` arms and blocks.
 */
function isTail(node: SyntaxNode): boolean {
  const p = node.parent;
  if (!p) return false;
  switch (p.type) {
    case 'block':
      return isLastStatement(node) && !hasToken(node, ';') && isTail(p);
    case 'function_item':
      return field(p, 'body')?.id === node.id && field(p, 'return_type') !== null;
    case 'expression_statement':
      return !hasToken(p, ';') && isTail(p);
    case 'if_expression':
      return field(p, 'condition')?.id !== node.id && isTail(p);
    case 'match_expression':
      return field(p, 'value')?.id !== node.id && isTail(p);
    case 'match_arm':
      return field(p, 'value')?.id === node.id && isTail(p);
    case 'else_clause':
    case 'match_block':
    case 'unsafe_block':
      return isTail(p);
    default:
      return false;
  }
}

function isPanic(n: SyntaxNode): boolean {
  return n.type === 'macro_invocation' && PANICS.has(lastSegment(field(n, 'macro')?.text ?? ''));
}

const panicOf = (node: SyntaxNode, mac: SyntaxNode): Stmt => ({ k: 'jump', node, jump: 'throw', text: firstLine(node, 80), valueNode: childOfType(mac, 'token_tree') });

function special(node: SyntaxNode, conv: IRConverter): Stmt[] | undefined {
  switch (node.type) {
    case 'empty_statement':
    case 'attribute_item':
      return [];
    case 'expression_statement': {
      const inner = statements(node);
      if (inner.length !== 1 || conv.isControl(inner[0].type)) return undefined;
      if (inner[0].type === 'block') return conv.stmts(inner[0]); // nested `{ … }` scope
      if (isPanic(inner[0])) return [panicOf(node, inner[0])];
      break;
    }
    case 'macro_invocation':
      if (isPanic(node)) return [panicOf(node, node)];
      break;
    case 'let_declaration': {
      const alt = field(node, 'alternative');
      if (!alt) break;
      // `let P = v else { … }` decides: the else block runs when P does not match.
      const cond = clean(node.text.slice(0, alt.startIndex - node.startIndex)).replace(/\s*else$/, '');
      return [{ k: 'if', node, cond, condNode: node, then: [], else: conv.stmts(alt) }];
    }
    case 'for_expression':
    case 'while_expression':
    case 'loop_expression': {
      const label = childOfType(node, 'label');
      if (!label) return undefined;
      const loop = conv.loop(node, LOOPS[node.type]) as LoopStmt;
      return [{ ...loop, label: label.text.slice(1), header: loop.header.replace(/^'\w+:\s*/, '') }];
    }
    case 'break_expression':
    case 'continue_expression':
      // Only a `'label` names the target: `break value` carries a value.
      return [{ k: 'jump', node, jump: node.type === 'break_expression' ? 'break' : 'continue', text: firstLine(node, 80), label: childOfType(node, 'label')?.text.slice(1) }];
  }
  // Tail expressions, including the arms of a tail `if`/`match`, are the result.
  // `implicitReturn` alone misses the body's own final expression: it compares
  // node objects, which web-tree-sitter recreates on every access.
  if (!conv.isControl(node.type) && isTail(node)) {
    return [{ k: 'jump', node, jump: 'return', text: `return ${firstLine(node, 70)}`, valueNode: node }];
  }
  return undefined;
}

/** Every value matches some arm, so the last arm is the catch-all (no "otherwise" path). */
function exhaustive(shape: SwitchShape): SwitchShape {
  const last = shape.cases[shape.cases.length - 1];
  if (last && !shape.cases.some((c) => c.isDefault)) last.isDefault = true;
  return shape;
}

// ---------------------------------------------------------------- data

function rustCallee(fn: SyntaxNode | null): { name: string; receiver?: string } | null {
  if (!fn || fn.type === 'closure_expression' || fn.type === 'call_expression') return null;
  if (fn.type === 'parenthesized_expression') return rustCallee(named(fn)[0] ?? null);
  return calleeName(fn);
}

/**
 * Macro arguments are raw tokens: identifiers that only appear after `.` or
 * `::` are field/path names, so they are hidden instead of read as variables.
 */
function tokenMembers(tt: SyntaxNode): string[] {
  const after = new Set<string>();
  const bare = new Set<string>();
  const visit = (n: SyntaxNode) => {
    let prev = '';
    for (const k of kids(n)) {
      if (k.type === 'token_tree') visit(k);
      else if (k.type === 'identifier') (prev === '.' || prev === '::' ? after : bare).add(k.text);
      prev = k.type;
    }
  };
  visit(tt);
  return [...after].filter((n) => !bare.has(n));
}

/** `v[i] = x` writes into `v`. */
const assignTarget = (n: SyntaxNode) => {
  const left = field(n, 'left');
  return left?.type === 'index_expression' ? (named(left)[0] ?? left) : left;
};

export const rust: LanguageSpec = {
  id: 'rust',
  name: 'Rust',
  grammar: 'rust',
  extensions: ['rs'],
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
  outline: outlineRust,
  functionBody: (fn) => field(fn, 'body'),
  params: (fn) => paramNames(field(fn, 'parameters'), ['self']),
  functionTypes: ['function_item', 'closure_expression'],
  decisionTypes: ['if_expression', 'while_expression', 'for_expression', 'match_arm', 'try_expression'],
  calls: {
    call_expression: { callee: (n) => field(n, 'function'), name: (n) => rustCallee(field(n, 'function')) },
    macro_invocation: { callee: (n) => field(n, 'macro'), args: (n) => childOfType(n, 'token_tree'), kind: 'macro' },
    struct_expression: { callee: (n) => field(n, 'name'), args: (n) => field(n, 'body'), kind: 'new' },
  },
  flow: {
    blocks: ['block'],
    ifs: ['if_expression'],
    elses: ['else_clause'],
    whiles: ['while_expression'],
    fors: [],
    forEachs: ['for_expression'],
    infinites: ['loop_expression'],
    switches: ['match_expression'],
    tries: [],
    returns: ['return_expression'],
    throws: [],
    breaks: ['break_expression'],
    continues: ['continue_expression'],
    withs: ['unsafe_block'],
    exprStatements: ['expression_statement'],
    definitions: ['function_item', 'struct_item', 'enum_item', 'union_item', 'trait_item', 'impl_item', 'mod_item', 'macro_definition', 'type_item'],
    fallthrough: false,
    switchShape: (n) => exhaustive(genericSwitch(n, { subjectFields: ['value'], bodyField: 'body', caseTypes: ['match_arm'], labelFields: ['pattern'] })),
    tryShape: () => ({ body: null, handlers: [] }),
    implicitReturn: isTail,
    special,
  },
  data: {
    assigns: {
      let_declaration: { target: (n) => field(n, 'pattern'), value: (n) => field(n, 'value') },
      let_condition: { target: (n) => field(n, 'pattern'), value: (n) => field(n, 'value') },
      assignment_expression: { target: assignTarget, value: (n) => field(n, 'right') },
      compound_assignment_expr: { target: assignTarget, value: (n) => field(n, 'right') },
    },
    members: {
      field_expression: { object: 'value', property: 'field' },
    },
    identifiers: ['identifier', 'shorthand_field_identifier'],
    selfNames: ['self'],
    skip: [
      'type_identifier', 'primitive_type', 'generic_type', 'scoped_type_identifier', 'reference_type', 'pointer_type', 'array_type',
      'tuple_type', 'function_type', 'abstract_type', 'dynamic_type', 'type_arguments', 'lifetime', 'label', 'string_literal',
      'raw_string_literal', 'char_literal', 'integer_literal', 'float_literal', 'boolean_literal', 'field_identifier',
      'scoped_identifier', 'match_pattern', 'closure_parameters', 'attribute_item', 'line_comment', 'block_comment',
    ],
    loopBindings: {
      for_expression: { target: (n) => field(n, 'pattern'), value: (n) => field(n, 'value') },
    },
    scopes: {
      closure_expression: (n) => paramNames(field(n, 'parameters')),
      token_tree: tokenMembers,
    },
  },
};
