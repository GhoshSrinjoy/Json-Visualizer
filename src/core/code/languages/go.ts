/** Go. */

import { genericSwitch, type IRConverter, type Stmt, type SwitchShape } from '../ir';
import type { CodeSymbol, ImportRef, SymbolKind } from '../model';
import { calleeName, paramNames, type LanguageSpec, type OutlineParts, type SymbolBuilder } from '../spec';
import { childOfType, clean, docComment, field, fields, firstLine, isComment, named, rangeOf, statements, walk } from '../syntax';
import type { SyntaxNode } from '../treesitter';

type LoopStmt = Extract<Stmt, { k: 'loop' }>;
type SwitchStmt = Extract<Stmt, { k: 'switch' }>;

const SWITCHES = new Set(['expression_switch_statement', 'type_switch_statement', 'select_statement']);

/** Exported identifiers start with an upper-case letter. */
const isExported = (name: string) => /^\p{Lu}/u.test(name);
const exportMods = (name: string) => (isExported(name) ? ['export'] : undefined);

/** Nodes of a multi-valued field: tree-sitter also lists the `,` separators of `A, B`. */
const namedFields = (node: SyntaxNode, name: string) => fields(node, name).filter((n) => n.isNamed);

/** Parameter names without the blank identifier. */
const names = (list: SyntaxNode | null) => paramNames(list).filter((n) => n !== '_');

function importsOf(decl: SyntaxNode): ImportRef[] {
  return named(childOfType(decl, 'import_spec_list') ?? decl)
    .filter((s) => s.type === 'import_spec')
    .map((s) => {
      const alias = field(s, 'name')?.text; // package name, `_` or `.`
      return {
        source: field(s, 'path')?.text.slice(1, -1) ?? '',
        names: [alias ? { name: '*', alias } : { name: '*' }],
        kind: 'import' as const,
        line: s.startPosition.row,
      };
    });
}

/** Base type of a method receiver: `User` for `(u *User)` and `(s *Stack[T])`. */
function receiverType(fn: SyntaxNode): string | undefined {
  let name: string | undefined;
  const recv = field(fn, 'receiver');
  if (recv) {
    walk(recv, (n) => {
      if (!name && n.type === 'type_identifier') name = n.text;
      return !name;
    });
  }
  return name;
}

/** Specs of a `type`/`const`/`var` declaration, grouped or not. */
function specsOf(decl: SyntaxNode): SyntaxNode[] {
  return named(childOfType(decl, 'var_spec_list') ?? decl).filter((s) => /^(type_spec|type_alias|const_spec|var_spec)$/.test(s.type));
}

export function outlineGo(root: SyntaxNode, b: SymbolBuilder): OutlineParts {
  const symbols: CodeSymbol[] = [];
  const imports: ImportRef[] = [];
  const types = new Map<string, CodeSymbol>();
  const methods: SyntaxNode[] = [];

  /** A single-spec declaration is documented above its keyword. */
  const docOf = (spec: SyntaxNode, decl: SyntaxNode) => docComment(spec) ?? (specsOf(decl).length === 1 ? docComment(decl) : undefined);
  const signature = (n: SyntaxNode) => b.signature(field(n, 'parameters'), field(n, 'result'), ' ');

  const fnSymbol = (node: SyntaxNode, parent: CodeSymbol | null): CodeSymbol | undefined => {
    const name = field(node, 'name')?.text;
    if (!name) return undefined;
    const recv = field(node, 'receiver');
    const sym = b.make(node, recv ? 'method' : 'function', name, parent, {
      signature: signature(node),
      detail: recv ? clean(recv.text, 50) : undefined,
      modifiers: exportMods(name),
    });
    b.callable(sym, node);
    // The receiver is an input of the body (data flow) but not a call argument.
    if (recv) sym.params = names(field(node, 'parameters'));
    return sym;
  };

  const typeSymbol = (spec: SyntaxNode, decl: SyntaxNode): CodeSymbol | undefined => {
    const name = field(spec, 'name')?.text;
    const type = field(spec, 'type');
    if (!name || !type) return undefined;
    const kind: SymbolKind = type.type === 'struct_type' ? 'struct' : type.type === 'interface_type' ? 'interface' : 'type';
    const tparams = field(spec, 'type_parameters');
    const sym = b.make(spec, kind, name, null, {
      detail: kind === 'type' ? `${spec.type === 'type_alias' ? '= ' : ''}${clean(type.text, 60)}` : tparams ? clean(tparams.text, 40) : undefined,
      modifiers: exportMods(name),
      doc: docOf(spec, decl),
    });
    const bases: string[] = [];
    if (kind === 'struct') {
      for (const f of named(childOfType(type, 'field_declaration_list') ?? type)) {
        if (f.type !== 'field_declaration') continue;
        const ft = field(f, 'type');
        const fieldNames = namedFields(f, 'name');
        // Embedded fields promote their methods, much like a base type.
        if (!fieldNames.length && ft) bases.push(clean(ft.text, 50));
        for (const n of fieldNames) {
          b.make(f, 'field', n.text, sym, { nameRange: rangeOf(n), detail: ft ? clean(ft.text, 40) : undefined, modifiers: exportMods(n.text) });
        }
      }
    } else if (kind === 'interface') {
      for (const m of named(type)) {
        const mn = field(m, 'name')?.text;
        if (m.type === 'method_elem' && mn) {
          b.callable(b.make(m, 'method', mn, sym, { signature: signature(m), modifiers: exportMods(mn) }), m);
        } else if (m.type === 'type_elem') {
          // Embedded interfaces; unions and `~T` constraints are not bases.
          const t = statements(m);
          if (t.length === 1 && /^(type_identifier|qualified_type|generic_type)$/.test(t[0].type)) bases.push(clean(t[0].text, 50));
        }
      }
    }
    if (bases.length) sym.bases = bases;
    return sym;
  };

  const valueSymbols = (decl: SyntaxNode) => {
    const kind: SymbolKind = decl.type === 'const_declaration' ? 'constant' : 'variable';
    for (const spec of specsOf(decl)) {
      const type = field(spec, 'type');
      const value = field(spec, 'value');
      const values = value ? named(value) : [];
      namedFields(spec, 'name').forEach((n, i) => {
        if (n.text === '_') return; // `var _ Iface = (*T)(nil)` compile-time checks
        const v = values[i];
        symbols.push(
          b.make(spec, kind, n.text, null, {
            nameRange: rangeOf(n),
            detail: type ? clean(type.text, 50) : v ? clean(v.text, 50) : undefined,
            modifiers: exportMods(n.text),
            doc: docOf(spec, decl),
          }),
        );
      });
    }
  };

  for (const node of named(root)) {
    switch (node.type) {
      case 'import_declaration':
        imports.push(...importsOf(node));
        break;
      case 'function_declaration': {
        const sym = fnSymbol(node, null);
        if (sym) symbols.push(sym);
        break;
      }
      case 'method_declaration':
        methods.push(node);
        break;
      case 'type_declaration':
        for (const spec of specsOf(node)) {
          const sym = typeSymbol(spec, node);
          if (!sym) continue;
          symbols.push(sym);
          if (!types.has(sym.name)) types.set(sym.name, sym);
        }
        break;
      case 'const_declaration':
      case 'var_declaration':
        valueSymbols(node);
        break;
    }
  }
  // Methods go under their receiver type when it is declared in this file
  // (possibly after the method), else they stay top-level.
  for (const m of methods) {
    const owner = types.get(receiverType(m) ?? '');
    const sym = fnSymbol(m, owner ?? null);
    if (sym && !owner) symbols.push(sym);
  }
  symbols.sort((x, y) => x.range.start.line - y.range.start.line);
  return { symbols, imports, exports: symbols.filter((s) => s.kind !== 'method' && isExported(s.name)).map((s) => s.name) };
}

function goCallee(fn: SyntaxNode | null): { name: string; receiver?: string } | null {
  switch (fn?.type) {
    case 'identifier':
    case 'selector_expression':
      return calleeName(fn);
    case 'parenthesized_expression':
      return goCallee(named(fn)[0] ?? null);
    case 'index_expression': // generic instantiation `Sum[int](a, b)`
      return goCallee(field(fn, 'operand'));
    default:
      return null; // closures and call results have no name
  }
}

/** `User{…}` -> User, `pkg.T{…}` -> pkg.T, `[]string{…}` -> []string. */
function literalType(t: SyntaxNode | null): { name: string; receiver?: string } | null {
  if (!t) return null;
  if (t.type === 'generic_type') return literalType(field(t, 'type'));
  if (t.type === 'qualified_type') return { name: field(t, 'name')?.text ?? t.text, receiver: field(t, 'package')?.text };
  return { name: clean(t.text, 30) };
}

function switchShape(node: SyntaxNode): SwitchShape {
  const shape = genericSwitch(node, {
    subjectFields: ['value'],
    caseTypes: ['expression_case', 'type_case', 'communication_case'],
    defaultTypes: ['default_case'],
    labelFields: ['value', 'type', 'communication'],
  });
  for (const c of shape.cases) {
    // genericSwitch also turns the separators of `case int, string:` into labels.
    if (c.node?.type === 'type_case') c.label = namedFields(c.node, 'type').map((t) => clean(t.text, 40)).join(', ');
  }
  // `select` waits until some case is ready: there is no "nothing matched" path.
  const last = shape.cases[shape.cases.length - 1];
  if (node.type === 'select_statement' && last && !shape.cases.some((c) => c.isDefault)) last.isDefault = true;
  return shape;
}

function special(node: SyntaxNode, conv: IRConverter): Stmt[] | undefined {
  // `if v, ok := m[k]; ok` and `switch x := f(); x`: the initializer runs first.
  const init = node.type === 'if_statement' || SWITCHES.has(node.type) ? field(node, 'initializer') : null;
  const pre = init ? [conv.simple(init)] : [];
  switch (node.type) {
    case 'if_statement':
      return init ? [...pre, conv.ifStmt(node)] : undefined;
    case 'for_statement': {
      // The header clause carries the data flow: range bindings or init/update statements.
      const loop = conv.loop(node, 'for') as LoopStmt;
      const clause = childOfType(node, 'range_clause') ?? childOfType(node, 'for_clause');
      return [clause ? { ...loop, node: clause } : loop];
    }
    case 'expression_switch_statement':
    case 'type_switch_statement':
    case 'select_statement': {
      const sw = conv.switchStmt(node) as SwitchStmt;
      if (node.type === 'select_statement') return [{ ...sw, subject: 'select' }];
      if (node.type === 'type_switch_statement') {
        const alias = field(node, 'alias');
        const subject = `${alias ? `${alias.text} := ` : ''}${field(node, 'value')?.text ?? ''}.(type)`;
        // The statement is the subject node so data flow binds the alias (see `data.assigns`).
        return [...pre, { ...sw, subject, subjectNode: node }];
      }
      return [...pre, field(node, 'value') ? sw : { ...sw, subject: 'switch' }];
    }
    case 'expression_statement': {
      const call = named(node)[0];
      if (call?.type === 'call_expression' && field(call, 'function')?.text === 'panic') {
        return [{ k: 'jump', node, jump: 'throw', text: firstLine(node, 80), valueNode: field(call, 'arguments') }];
      }
      return undefined;
    }
  }
  return undefined;
}

/** `var x = v` binds x; without a value every name is declared. Several names with values bind the first only. */
const specAssign = {
  target: (n: SyntaxNode) => (field(n, 'value') ? field(n, 'name') : n),
  value: (n: SyntaxNode) => field(n, 'value'),
};

const leftRight = { target: (n: SyntaxNode) => field(n, 'left'), value: (n: SyntaxNode) => field(n, 'right') };

export const go: LanguageSpec = {
  id: 'go',
  name: 'Go',
  grammar: 'go',
  extensions: ['go'],
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
  outline: outlineGo,
  functionBody: (fn) => field(fn, 'body'),
  params: (fn) => [...names(field(fn, 'receiver')), ...names(field(fn, 'parameters'))],
  functionTypes: ['function_declaration', 'method_declaration', 'func_literal'],
  decisionTypes: ['if_statement', 'for_statement', 'expression_case', 'type_case', 'communication_case'],
  calls: {
    call_expression: { callee: (n) => field(n, 'function'), name: (n) => goCallee(field(n, 'function')) },
    composite_literal: { callee: (n) => field(n, 'type'), name: (n) => literalType(field(n, 'type')), args: (n) => field(n, 'body'), kind: 'new' },
  },
  flow: {
    blocks: ['block', 'statement_list'],
    ifs: ['if_statement'],
    elses: [],
    whiles: [],
    fors: ['for_statement'],
    switches: [...SWITCHES],
    tries: [],
    returns: ['return_statement'],
    throws: [],
    breaks: ['break_statement'],
    continues: ['continue_statement'],
    fallthroughs: ['fallthrough_statement'],
    labeled: ['labeled_statement'],
    definitions: ['function_declaration', 'method_declaration', 'type_declaration'],
    fallthrough: false,
    switchShape,
    tryShape: () => ({ body: null, handlers: [] }),
    loopKind: (n) => {
      if (childOfType(n, 'range_clause')) return 'forEach';
      const clause = childOfType(n, 'for_clause');
      if (clause) return field(clause, 'condition') ? 'for' : 'infinite';
      const body = field(n, 'body');
      return named(n).some((c) => c.id !== body?.id && !isComment(c)) ? 'while' : 'infinite';
    },
    special,
  },
  data: {
    assigns: {
      short_var_declaration: leftRight,
      assignment_statement: leftRight,
      receive_statement: leftRight,
      var_spec: specAssign,
      const_spec: specAssign,
      type_switch_statement: { target: (n) => field(n, 'alias'), value: (n) => field(n, 'value') },
    },
    members: {
      selector_expression: { object: 'operand', property: 'field' },
      index_expression: { object: 'operand', property: 'index' },
    },
    identifiers: ['identifier'],
    // Go has no `self`; listing the blank identifier keeps `_` out of the graph.
    selfNames: ['_'],
    skip: [
      'interpreted_string_literal', 'raw_string_literal', 'rune_literal', 'int_literal', 'float_literal', 'imaginary_literal',
      'nil', 'true', 'false', 'iota', 'comment', 'field_identifier', 'package_identifier', 'label_name', 'type_identifier',
      'qualified_type', 'generic_type', 'pointer_type', 'slice_type', 'array_type', 'map_type', 'channel_type', 'function_type',
      'interface_type', 'struct_type', 'type_arguments', 'parameter_list',
    ],
    loopBindings: {
      range_clause: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
    },
    scopes: {
      func_literal: (n) => names(field(n, 'parameters')),
    },
  },
};
