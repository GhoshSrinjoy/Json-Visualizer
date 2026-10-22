/** PHP. */

import { genericSwitch, genericTry, type Stmt } from '../ir';
import type { CodeSymbol, ImportKind, ImportRef, SymbolKind } from '../model';
import { calleeName, paramNames, type LanguageSpec, type OutlineParts, type SymbolBuilder } from '../spec';
import { childOfType, clean, field, isComment, named, rangeOf, walk } from '../syntax';
import type { SyntaxNode } from '../treesitter';

const SELF = ['$this', 'self', 'static'];
/** Name of an unnamed `namespace { … }` block. */
const GLOBAL = '(global)';
const INCLUDES: Record<string, ImportKind> = {
  include_expression: 'include',
  include_once_expression: 'include',
  require_expression: 'require',
  require_once_expression: 'require',
};
const MODIFIERS = new Set(['visibility_modifier', 'static_modifier', 'abstract_modifier', 'final_modifier', 'readonly_modifier']);
const TYPES: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  trait_declaration: 'trait',
  enum_declaration: 'enum',
};

function modifiersOf(node: SyntaxNode): string[] {
  return named(node).filter((c) => MODIFIERS.has(c.type)).map((c) => c.text);
}

/** Contents of a string literal without interpolation. */
function stringValue(n: SyntaxNode | null | undefined): string | undefined {
  if (n?.type !== 'string' && n?.type !== 'encapsed_string') return undefined;
  const parts = named(n);
  return parts.every((p) => p.type === 'string_content' || p.type === 'escape_sequence') ? parts.map((p) => p.text).join('') : undefined;
}

/** Last segment of `App\Models\User`. */
function lastSegment(n: SyntaxNode): string {
  return n.text.split('\\').pop() ?? n.text;
}

/** `use A\B as C` clauses: the imported name and its binding. */
function useClauses(n: SyntaxNode, grouped: boolean): { target: SyntaxNode; binding: ImportRef['names'][number] }[] {
  return named(n)
    .filter((c) => c.type === 'namespace_use_clause')
    .flatMap((c) => {
      const alias = field(c, 'alias');
      const target = named(c).find((x) => x.id !== alias?.id);
      if (!target) return [];
      // Grouped names are relative to the group prefix: keep them whole.
      const name = grouped ? target.text : lastSegment(target);
      return [{ target, binding: alias ? { name, alias: alias.text } : { name } }];
    });
}

function useImports(node: SyntaxNode): ImportRef[] {
  const line = node.startPosition.row;
  const group = field(node, 'body');
  if (group) {
    // use App\Util\{Logger, Formatter as F};
    const prefix = named(node).find((c) => c.type === 'namespace_name');
    return prefix ? [{ source: prefix.text, names: useClauses(group, true).map((u) => u.binding), kind: 'use', line }] : [];
  }
  return useClauses(node, false).map((u) => ({ source: u.target.text, names: [u.binding], kind: 'use', line }));
}

function includeOf(n: SyntaxNode): ImportRef | undefined {
  const kind = INCLUDES[n.type];
  if (!kind) return undefined;
  let arg = named(n)[0];
  while (arg?.type === 'parenthesized_expression') arg = named(arg)[0];
  if (!arg) return undefined;
  // Literal paths lose their quotes; computed ones (`__DIR__ . '/x.php'`) stay as written.
  return { source: stringValue(arg) ?? clean(arg.text, 80), names: [{ name: '*' }], kind, line: n.startPosition.row };
}

export function outlinePhp(root: SyntaxNode, b: SymbolBuilder): OutlineParts {
  const symbols: CodeSymbol[] = [];
  const imports: ImportRef[] = [];
  const exports: string[] = [];

  /** Registers a namespace-level declaration (exported under its qualified name). */
  const add = (sym: CodeSymbol, parent: CodeSymbol | null): CodeSymbol => {
    if (!parent) symbols.push(sym);
    exports.push(parent && parent.name !== GLOBAL ? `${parent.name}\\${sym.name}` : sym.name);
    return sym;
  };

  const callable = (node: SyntaxNode, kind: SymbolKind, name: string, parent: CodeSymbol | null): CodeSymbol => {
    const mods = modifiersOf(node);
    const sym = b.make(node, kind, name, parent, {
      signature: b.signature(field(node, 'parameters'), field(node, 'return_type')),
      modifiers: mods.length ? mods : undefined,
    });
    return b.callable(kind === 'function' ? add(sym, parent) : sym, node);
  };

  const typeSymbol = (node: SyntaxNode, parent: CodeSymbol | null): void => {
    const name = field(node, 'name')?.text;
    if (!name) return;
    const body = field(node, 'body');
    // extends / implements, then traits used in the body.
    const traits = body ? named(body).filter((c) => c.type === 'use_declaration') : [];
    const heritage = [childOfType(node, 'base_clause'), childOfType(node, 'class_interface_clause'), ...traits];
    const bases = heritage.flatMap((h) => (h ? named(h).filter((c) => /name/.test(c.type)).map((c) => c.text) : []));
    const mods = modifiersOf(node);
    const backing = node.type === 'enum_declaration' ? childOfType(node, 'primitive_type') : null;
    const sym = add(
      b.make(node, TYPES[node.type], name, parent, {
        bases: bases.length ? bases : undefined,
        modifiers: mods.length ? mods : undefined,
        detail: backing ? `: ${backing.text}` : undefined,
      }),
      parent,
    );
    for (const m of body ? named(body) : []) member(m, sym);
  };

  const member = (m: SyntaxNode, cls: CodeSymbol): void => {
    switch (m.type) {
      case 'method_declaration': {
        const name = field(m, 'name')?.text;
        if (!name) return;
        callable(m, name === '__construct' ? 'constructor' : 'method', name, cls);
        // Constructor promotion: `__construct(private string $root)` declares a property.
        for (const p of named(field(m, 'parameters') ?? m)) {
          const pn = p.type === 'property_promotion_parameter' ? field(p, 'name') : null;
          if (pn) property(p, pn, cls, field(p, 'type'));
        }
        return;
      }
      case 'property_declaration':
        for (const el of named(m)) {
          const pn = el.type === 'property_element' ? field(el, 'name') : null;
          if (pn) property(m, pn, cls, field(m, 'type'));
        }
        return;
      case 'const_declaration':
        constants(m, cls);
        return;
      case 'enum_case': {
        const name = field(m, 'name');
        const value = field(m, 'value');
        if (name) b.make(m, 'enumMember', name.text, cls, { detail: value ? clean(value.text, 40) : undefined });
        return;
      }
    }
  };

  const property = (node: SyntaxNode, name: SyntaxNode, cls: CodeSymbol, type: SyntaxNode | null): void => {
    const mods = modifiersOf(node);
    b.make(node, 'property', name.text.replace(/^\$/, ''), cls, { nameRange: rangeOf(name), modifiers: mods.length ? mods : undefined, detail: type?.text });
  };

  const constants = (node: SyntaxNode, parent: CodeSymbol | null): void => {
    const mods = modifiersOf(node);
    for (const el of named(node).filter((c) => c.type === 'const_element')) {
      const [name, value] = named(el);
      if (name?.type !== 'name') continue;
      const sym = b.make(el, 'constant', name.text, parent, {
        nameRange: rangeOf(name),
        modifiers: mods.length ? mods : undefined,
        detail: value ? clean(value.text, 50) : undefined,
      });
      if (!parent || parent.kind === 'namespace') add(sym, parent);
    }
  };

  /** Namespace-level statements. */
  const top = (node: SyntaxNode, parent: CodeSymbol | null): void => {
    switch (node.type) {
      case 'namespace_use_declaration':
        imports.push(...useImports(node));
        return;
      case 'function_definition': {
        const name = field(node, 'name')?.text;
        if (name) callable(node, 'function', name, parent);
        return;
      }
      case 'const_declaration':
        constants(node, parent);
        return;
      case 'if_statement': {
        // if (!function_exists('x')) { function x() {} }
        const body = field(node, 'body');
        if (body) for (const c of named(body)) top(c, parent);
        return;
      }
      default:
        if (TYPES[node.type]) typeSymbol(node, parent);
    }
  };

  let ns: CodeSymbol | null = null;
  for (const node of named(root)) {
    if (node.type !== 'namespace_definition') {
      top(node, ns);
      continue;
    }
    const sym = b.make(node, 'namespace', field(node, 'name')?.text ?? GLOBAL, null);
    symbols.push(sym);
    const body = field(node, 'body');
    if (body) {
      for (const c of named(body)) top(c, sym);
      ns = null;
    } else ns = sym; // `namespace App;` applies to the declarations that follow
  }
  // A `namespace X;` symbol spans the declarations it holds.
  for (const s of symbols) {
    const last = s.kind === 'namespace' ? s.children?.[s.children.length - 1] : undefined;
    if (last && last.range.end.line > s.range.end.line) s.range = { start: s.range.start, end: last.range.end };
  }

  walk(root, (n) => {
    const imp = includeOf(n);
    if (imp) imports.push(imp);
    return true;
  });
  imports.sort((x, y) => x.line - y.line);
  return { symbols, imports, exports };
}

// ---------------------------------------------------------------- calls

/** Callee of a function call: `strlen`, `\App\helper`, `$fn`. */
function functionCallee(n: SyntaxNode | null): { name: string; receiver?: string } | null {
  if (!n) return null;
  if (n.type === 'name' || n.type === 'variable_name') return { name: n.text };
  if (n.type === 'qualified_name') {
    const prefix = n.text.slice(0, n.text.lastIndexOf('\\')).replace(/^\\/, '');
    return { name: lastSegment(n), receiver: prefix || undefined };
  }
  return calleeName(n);
}

function memberCallee(n: SyntaxNode, objectField: string): { name: string; receiver?: string } | null {
  const name = field(n, 'name');
  const obj = field(n, objectField);
  return name ? { name: name.text, receiver: obj ? clean(obj.text, 40) : undefined } : null;
}

/** `new User(…)`, `new \Foo\Bar`, `new static`; anonymous classes have no callee. */
function createdClass(n: SyntaxNode): { name: string; receiver?: string } | null {
  const cls = named(n).find((c) => c.type !== 'arguments' && !isComment(c));
  return cls && cls.type !== 'anonymous_class' ? functionCallee(cls) : null;
}

// ---------------------------------------------------------------- flow

/** `foreach ($items as $k => $v)`: the iterated expression and the binding (no field names). */
function foreachParts(n: SyntaxNode): SyntaxNode[] {
  const body = field(n, 'body');
  return named(n).filter((c) => c.id !== body?.id && !isComment(c));
}

function special(node: SyntaxNode): Stmt[] | undefined {
  if (node.type === 'php_tag') return [];
  // `end:` marks the statement after it as a `goto` target.
  if (node.type === 'named_label_statement') return [{ k: 'labeled', node, label: named(node)[0]?.text ?? '', body: [] }];
  return undefined;
}

const fnParams = (fn: SyntaxNode) => paramNames(field(fn, 'parameters'), SELF);

export const php: LanguageSpec = {
  id: 'php',
  name: 'PHP',
  grammar: 'php',
  extensions: ['php', 'phtml'],
  lineComment: ['//', '#'],
  blockComment: ['/*', '*/'],
  outline: outlinePhp,
  functionBody: (fn) => field(fn, 'body'),
  params: fnParams,
  functionTypes: [
    'function_definition', 'method_declaration', 'arrow_function', 'anonymous_function', 'class_declaration', 'anonymous_class',
    'interface_declaration', 'trait_declaration', 'enum_declaration',
  ],
  decisionTypes: ['if_statement', 'else_if_clause', 'catch_clause', 'conditional_expression', 'match_conditional_expression'],
  calls: {
    function_call_expression: { callee: (n) => field(n, 'function'), name: (n) => functionCallee(field(n, 'function')) },
    member_call_expression: { callee: (n) => field(n, 'name'), name: (n) => memberCallee(n, 'object') },
    nullsafe_member_call_expression: { callee: (n) => field(n, 'name'), name: (n) => memberCallee(n, 'object') },
    scoped_call_expression: { callee: (n) => field(n, 'name'), name: (n) => memberCallee(n, 'scope') },
    // `new X(…)` has no field names: the class is the first child, the arguments follow.
    object_creation_expression: { callee: (n) => named(n)[0] ?? null, name: createdClass, args: (n) => childOfType(n, 'arguments'), kind: 'new' },
  },
  flow: {
    blocks: ['compound_statement', 'colon_block'],
    ifs: ['if_statement'],
    elifs: ['else_if_clause'],
    elses: ['else_clause'],
    whiles: ['while_statement'],
    doWhiles: ['do_statement'],
    fors: ['for_statement'],
    forEachs: ['foreach_statement'],
    switches: ['switch_statement'],
    tries: ['try_statement'],
    // exit()/die() end the script like a return ends the function.
    returns: ['return_statement', 'exit_statement'],
    throws: ['throw_expression'],
    breaks: ['break_statement'],
    continues: ['continue_statement'],
    gotos: ['goto_statement'],
    exprStatements: ['expression_statement'],
    definitions: ['function_definition', 'class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration'],
    fallthrough: true,
    switchShape: (n) =>
      genericSwitch(n, { subjectFields: ['condition'], caseTypes: ['case_statement'], defaultTypes: ['default_statement'], labelFields: ['value'] }),
    tryShape: (n) => genericTry(n, { catchTypes: ['catch_clause'], finallyTypes: ['finally_clause'] }),
    special,
  },
  data: {
    assigns: {
      assignment_expression: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
      augmented_assignment_expression: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
      reference_assignment_expression: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
      static_variable_declaration: { target: (n) => field(n, 'name'), value: (n) => field(n, 'value') },
    },
    members: {
      member_access_expression: { object: 'object', property: 'name' },
      nullsafe_member_access_expression: { object: 'object', property: 'name' },
      scoped_property_access_expression: { object: 'scope', property: 'name' },
    },
    identifiers: ['variable_name'],
    selfNames: SELF,
    skip: [
      'comment', 'name', 'qualified_name', 'relative_scope', 'named_type', 'primitive_type', 'optional_type', 'union_type',
      'intersection_type', 'type_list', 'attribute_list', 'string', 'integer', 'float', 'boolean', 'null',
    ],
    loopBindings: {
      foreach_statement: { target: (n) => foreachParts(n)[1] ?? null, value: (n) => foreachParts(n)[0] ?? null },
    },
    scopes: {
      arrow_function: fnParams,
      anonymous_function: fnParams,
    },
  },
};
