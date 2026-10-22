/** C#. */

import { genericTry, type SwitchShape } from '../ir';
import type { CodeSymbol, ImportRef, SymbolKind } from '../model';
import { calleeName, type LanguageSpec, type OutlineParts, type SymbolBuilder } from '../spec';
import { childOfType, clean, docComment, field, hasToken, headerText, isComment, kids, named, paramsText, rangeOf, walk } from '../syntax';
import type { SyntaxNode } from '../treesitter';

const TYPE_KINDS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  record_declaration: 'class',
  struct_declaration: 'struct',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  delegate_declaration: 'type',
};
const TYPE_DECLS = Object.keys(TYPE_KINDS);
/** Accessors with an implicit `value` parameter. */
const SETTERS = new Set(['set', 'init', 'add', 'remove']);

/** `<summary>` text of a `///` XML doc comment (or the first sentence of any comment above). */
function xmlDoc(node: SyntaxNode): string | undefined {
  const d = docComment(node);
  if (!d) return undefined;
  const summary = /<summary>([\s\S]*?)(?:<\/summary>|$)/.exec(d)?.[1] ?? d;
  // `<see cref="Foo"/>` / `<paramref name="x"/>` → `Foo` / `x`; other tags dropped.
  return clean(summary.replace(/<\w+\s+\w+="([^"]*)"\s*\/>/g, '$1').replace(/<[^>]*>/g, ' '), 140) || undefined;
}

/** `modifier` keywords plus attributes on the declaration itself (`[return: X]` targets something else). */
function modifiersOf(node: SyntaxNode): string[] {
  const out: string[] = [];
  for (const c of named(node)) {
    if (c.type === 'modifier') out.push(c.text);
    else if (c.type === 'attribute_list' && !childOfType(c, 'attribute_target_specifier')) {
      for (const a of named(c)) if (a.type === 'attribute') out.push(`[${clean(a.text, 40)}]`);
    }
  }
  return out;
}

function usingOf(node: SyntaxNode): ImportRef | undefined {
  const alias = field(node, 'name');
  const target = named(node).find((c) => c.id !== alias?.id && !isComment(c));
  if (!target) return undefined;
  return { source: clean(target.text, 200), names: [alias ? { name: '*', alias: alias.text } : { name: '*' }], kind: 'using', line: node.startPosition.row };
}

export function outlineCsharp(root: SyntaxNode, b: SymbolBuilder): OutlineParts {
  const symbols: CodeSymbol[] = [];
  const imports: ImportRef[] = [];
  const exports: string[] = [];

  const make = (node: SyntaxNode, kind: SymbolKind, name: string, parent: CodeSymbol | null, extra: Partial<CodeSymbol> = {}) => {
    const mods = modifiersOf(node);
    const sym = b.make(node, kind, name, parent, { modifiers: mods.length ? mods : undefined, doc: xmlDoc(node), ...extra });
    if (!parent) symbols.push(sym);
    return sym;
  };

  /** `<T>(params): returns` for methods, local functions, operators and delegates. */
  const signature = (node: SyntaxNode) => {
    const tp = field(node, 'type_parameters');
    return `${tp ? clean(tp.text, 40) : ''}${b.signature(field(node, 'parameters'), field(node, 'returns') ?? field(node, 'type'))}`;
  };

  const callable = (node: SyntaxNode, kind: SymbolKind, name: string, parent: CodeSymbol | null) => {
    const sym = make(node, kind, name, parent, { signature: signature(node) });
    b.callable(sym, node);
    const body = field(node, 'body');
    if (body?.type === 'block') for (const c of named(body)) if (c.type === 'local_function_statement') localFunction(c, sym);
  };

  const localFunction = (node: SyntaxNode, parent: CodeSymbol | null) => {
    const name = field(node, 'name')?.text;
    if (name) callable(node, 'function', name, parent);
  };

  /** Properties, indexers and events; accessors with bodies become callable children. */
  const property = (node: SyntaxNode, name: string, parent: CodeSymbol, extra: Partial<CodeSymbol> = {}) => {
    const list = field(node, 'accessors');
    const accessors = list ? named(list).filter((a) => a.type === 'accessor_declaration') : [];
    const shape = accessors.map((a) => [...modifiersOf(a), field(a, 'name')?.text ?? ''].join(' ').trim());
    const type = field(node, 'type')?.text ?? '';
    const sym = make(node, 'property', name, parent, { detail: clean(`${type}${shape.length ? ` { ${shape.join('; ')}; }` : ''}`, 60) || undefined, ...extra });
    // Expression-bodied: `int Twice => x * 2;`
    if (csBody(node)) b.callable(sym, node);
    for (const a of accessors) if (field(a, 'body')) b.callable(make(a, 'method', field(a, 'name')?.text ?? 'get', sym), a);
  };

  const fieldsOf = (node: SyntaxNode, parent: CodeSymbol) => {
    const mods = modifiersOf(node);
    if (node.type === 'event_field_declaration') mods.push('event');
    const decl = childOfType(node, 'variable_declaration');
    const type = field(decl, 'type');
    const doc = xmlDoc(node);
    const kind: SymbolKind = mods.includes('const') ? 'constant' : 'field';
    for (const d of decl ? named(decl) : []) {
      const name = d.type === 'variable_declarator' ? field(d, 'name')?.text : undefined;
      if (name) b.make(d, kind, name, parent, { modifiers: mods.length ? mods : undefined, detail: type ? clean(type.text, 40) : undefined, doc });
    }
  };

  const member = (m: SyntaxNode, parent: CodeSymbol): void => {
    const name = field(m, 'name')?.text;
    switch (m.type) {
      case 'method_declaration':
        if (name) callable(m, 'method', name, parent);
        return;
      case 'constructor_declaration':
        callable(m, 'constructor', name ?? parent.name, parent);
        return;
      case 'destructor_declaration':
        callable(m, 'method', `~${name ?? parent.name}`, parent);
        return;
      case 'operator_declaration':
        callable(m, 'method', `operator ${field(m, 'operator')?.text ?? ''}`.trim(), parent);
        return;
      case 'conversion_operator_declaration':
        callable(m, 'method', `${hasToken(m, 'explicit') ? 'explicit' : 'implicit'} operator ${clean(field(m, 'type')?.text ?? '', 40)}`, parent);
        return;
      case 'property_declaration':
        if (name) property(m, name, parent);
        return;
      case 'indexer_declaration':
        property(m, 'this[]', parent, { signature: `${clean(field(m, 'parameters')?.text ?? '[]', 80)}: ${clean(field(m, 'type')?.text ?? '', 40)}` });
        return;
      case 'event_declaration':
        if (name) property(m, name, parent, { modifiers: [...modifiersOf(m), 'event'] });
        return;
      case 'field_declaration':
      case 'event_field_declaration':
        fieldsOf(m, parent);
        return;
      case 'enum_member_declaration': {
        const value = field(m, 'value');
        if (name) b.make(m, 'enumMember', name, parent, { detail: value ? clean(value.text, 40) : undefined, doc: xmlDoc(m) });
        return;
      }
      default:
        declaration(m, parent);
    }
  };

  const typeDecl = (node: SyntaxNode, parent: CodeSymbol | null) => {
    const name = field(node, 'name')?.text;
    if (!name) return;
    let kind = TYPE_KINDS[node.type];
    const mods = modifiersOf(node);
    if (node.type === 'record_declaration') {
      mods.push('record');
      if (hasToken(node, 'struct')) kind = 'struct';
    }
    const baseList = childOfType(node, 'base_list');
    // `record B(int X) : A(X)` lists a base with constructor arguments.
    const baseType = (c: SyntaxNode) => (c.type === 'primary_constructor_base_type' ? (field(c, 'type') ?? c) : c);
    const bases = baseList ? named(baseList).filter((c) => !isComment(c)).map((c) => clean(baseType(c).text, 50)) : [];
    const primary = childOfType(node, 'parameter_list');
    const sym = make(node, kind, name, parent, {
      modifiers: mods.length ? mods : undefined,
      bases: bases.length ? bases : undefined,
      signature: node.type === 'delegate_declaration' ? signature(node) : primary ? paramsText(primary) : undefined,
    });
    // Positional record parameters are its properties.
    if (primary && node.type === 'record_declaration') {
      for (const p of named(primary)) {
        const pn = p.type === 'parameter' ? field(p, 'name') : null;
        if (pn) b.make(p, 'property', pn.text, sym, { detail: clean(field(p, 'type')?.text ?? '', 40) || undefined });
      }
    }
    const body = field(node, 'body');
    if (body) for (const m of named(body)) member(m, sym);
    if ((!parent || parent.kind === 'namespace') && mods.includes('public')) exports.push(name);
  };

  const namespace = (node: SyntaxNode, parent: CodeSymbol | null) => make(node, 'namespace', clean(field(node, 'name')?.text ?? 'namespace', 60), parent);

  const declaration = (node: SyntaxNode, parent: CodeSymbol | null): void => {
    switch (node.type) {
      case 'using_directive': {
        const imp = usingOf(node);
        if (imp) imports.push(imp);
        return;
      }
      case 'namespace_declaration': {
        const ns = namespace(node, parent);
        const body = field(node, 'body');
        if (body) visit(body, ns);
        return;
      }
      case 'global_statement': {
        // Top-level programs: local functions are the file's functions.
        const fn = childOfType(node, 'local_function_statement');
        if (fn) localFunction(fn, parent);
        return;
      }
      default:
        if (TYPE_KINDS[node.type]) typeDecl(node, parent);
    }
  };

  const visit = (container: SyntaxNode, parent: CodeSymbol | null) => {
    let scope = parent;
    for (const node of named(container)) {
      if (node.type !== 'file_scoped_namespace_declaration') {
        declaration(node, scope);
        continue;
      }
      // `namespace X;` owns the rest of the file.
      scope = namespace(node, parent);
      const last = named(container).pop();
      if (last) scope.range = { start: scope.range.start, end: rangeOf(last).end };
    }
  };

  visit(root, null);
  return { symbols, imports, exports };
}

/** Statement body, or the expression of an expression-bodied member (`=> expr`, treated as an implicit return). */
function csBody(fn: SyntaxNode): SyntaxNode | null {
  const value = field(fn, 'value');
  const body = field(fn, 'body') ?? (value?.type === 'arrow_expression_clause' ? value : null);
  return body?.type === 'arrow_expression_clause' ? (named(body).find((c) => !isComment(c)) ?? null) : body;
}

function csParams(fn: SyntaxNode): string[] {
  if (fn.type === 'accessor_declaration') {
    // Indexer parameters plus the implicit `value` of setters.
    const owner = fn.parent?.parent;
    const out = owner?.type === 'indexer_declaration' ? csParams(owner) : [];
    if (SETTERS.has(field(fn, 'name')?.text ?? '')) out.push('value');
    return out;
  }
  const p = field(fn, 'parameters');
  if (!p) return [];
  if (p.type === 'implicit_parameter') return [p.text];
  const out: string[] = [];
  for (let i = 0; i < p.childCount; i++) {
    const c = p.child(i);
    // `params T[] rest` sits directly in the list as type/name fields.
    const name = c?.type === 'parameter' ? field(c, 'name') : p.fieldNameForChild(i) === 'name' ? c : null;
    if (name) out.push(name.text);
  }
  return out;
}

const LOCAL_DECLS = new Set(['variable_declarator', 'catch_declaration', 'declaration_expression', 'declaration_pattern']);

/** Names a lambda binds: its parameters plus the locals of a block body (data flow skips nested scopes when collecting locals). */
function lambdaNames(fn: SyntaxNode): string[] {
  const out = csParams(fn);
  const body = field(fn, 'body') ?? childOfType(fn, 'block');
  if (body?.type === 'block') {
    walk(body, (n) => {
      if (n.type === 'lambda_expression' || n.type === 'anonymous_method_expression' || n.type === 'local_function_statement') return false;
      const name = n.type === 'foreach_statement' ? field(n, 'left') : LOCAL_DECLS.has(n.type) ? field(n, 'name') : null;
      if (name?.type === 'identifier') out.push(name.text);
      return true;
    });
  }
  return out;
}

/** Range variables of a LINQ query (`from c in …`, `join d in …`, `let n = …`). */
function queryNames(q: SyntaxNode): string[] {
  const out: string[] = [];
  for (const c of named(q)) {
    // `from` has a name field; `join d in …` and `let n = …` start with the bound identifier.
    const id = c.type === 'from_clause' ? field(c, 'name') : /^(join|let)_clause$/.test(c.type) ? childOfType(c, 'identifier') : null;
    if (id) out.push(id.text);
  }
  return out;
}

/** Callee of `F()`, `F<T>()`, `a.F()`, `a?.F()`, `a.F<T>()`. */
function invoked(fn: SyntaxNode | null): { name: string; receiver?: string } | null {
  if (!fn) return null;
  if (fn.type === 'generic_name') return { name: named(fn)[0]?.text ?? fn.text };
  if (fn.type === 'member_access_expression' || fn.type === 'conditional_access_expression') {
    const conditional = fn.type === 'conditional_access_expression';
    const target = invoked(conditional ? field(named(fn).pop() ?? null, 'name') : field(fn, 'name'));
    const obj = field(fn, conditional ? 'condition' : 'expression');
    if (target) return { name: target.name, receiver: obj ? clean(obj.text, 40) : undefined };
  }
  return calleeName(fn);
}

/** `Foo`, `Foo<T>`, `Ns.Foo` → name + qualifier. */
function typeName(t: SyntaxNode | null): { name: string; receiver?: string } | null {
  if (!t) return null;
  if (t.type === 'generic_name') return { name: named(t)[0]?.text ?? t.text };
  if (t.type === 'qualified_name' || t.type === 'alias_qualified_name') {
    const inner = typeName(field(t, 'name'));
    const q = field(t, 'qualifier') ?? field(t, 'alias');
    return inner && { name: inner.name, receiver: q ? clean(q.text, 40) : undefined };
  }
  return { name: clean(t.text, 40) };
}

const RETURNING = new Set(['method_declaration', 'local_function_statement', 'property_declaration', 'lambda_expression', 'anonymous_method_expression']);

/** Target-typed `new()`: the type of the declaration it initialises, or of the enclosing member's return. */
function targetType(n: SyntaxNode): { name: string } | null {
  const p = n.parent;
  let type: SyntaxNode | null = null;
  if (p?.type === 'variable_declarator') type = field(p.parent, 'type');
  else if (p?.type === 'property_declaration') type = field(p, 'type');
  else if (p?.type === 'return_statement' || p?.type === 'arrow_expression_clause') {
    // Lambdas have no declared return type to look at.
    let fn: SyntaxNode | null = p;
    while (fn && !RETURNING.has(fn.type)) fn = fn.parent;
    if (fn && !fn.type.endsWith('_expression')) type = field(fn, 'returns') ?? field(fn, 'type');
  }
  const t = type && type.type !== 'implicit_type' ? typeName(type) : null;
  return t && { name: t.name };
}

/** `case` labels (patterns and `when` guards) and statements of a switch section. */
function sectionParts(sec: SyntaxNode): { labels: string[]; isDefault: boolean; body: SyntaxNode[] } {
  const labels: string[] = [];
  const body: SyntaxNode[] = [];
  let isDefault = false;
  let label: string[] | null = null;
  for (const k of kids(sec)) {
    if (isComment(k)) continue;
    if (k.isNamed) {
      if (label) label.push(k.text);
      else body.push(k);
    } else if (k.type === 'case' || k.type === 'default') {
      label = k.type === 'default' ? ['default'] : [];
      isDefault ||= k.type === 'default';
    } else if (k.type === ':' && label) {
      labels.push(clean(label.join(' '), 40));
      label = null;
    }
  }
  return { labels, isDefault, body };
}

/** C# forbids falling out of a non-empty section, so only empty sections merge into the next one. */
function switchShape(node: SyntaxNode): SwitchShape {
  const cases: SwitchShape['cases'] = [];
  let carry: string[] = [];
  let carryDefault = false;
  const body = field(node, 'body');
  for (const sec of body ? named(body) : []) {
    if (sec.type !== 'switch_section') continue;
    const s = sectionParts(sec);
    carry.push(...s.labels);
    carryDefault ||= s.isDefault;
    if (!s.body.length) continue;
    cases.push({ label: carry.join(', '), body: s.body, isDefault: carryDefault, node: sec });
    carry = [];
    carryDefault = false;
  }
  if (carry.length) cases.push({ label: carry.join(', '), body: [], isDefault: carryDefault });
  return { subject: field(node, 'value'), cases };
}

/** The value part of a node whose other named child is a name (`x = 1` declarators, `name: v` arguments). */
function valueOf(n: SyntaxNode, name: SyntaxNode | null): SyntaxNode | null {
  return named(n).filter((c) => c.id !== name?.id && !isComment(c) && c.type !== 'bracketed_argument_list').pop() ?? null;
}

/**
 * The grammar reads the argument in `Foo(a * b)` as a declaration of `b` with pointer type `a*`.
 * Outside `out`/`ref`/`in` arguments such a declaration is really a product of two values.
 */
function isProduct(n: SyntaxNode): boolean {
  const arg = n.parent;
  return field(n, 'type')?.type === 'pointer_type' && !(arg && ['out', 'ref', 'in'].some((t) => hasToken(arg, t)));
}

function identifiersIn(n: SyntaxNode): string[] {
  const out: string[] = [];
  walk(n, (c) => {
    if (c.type === 'identifier') out.push(c.text);
  });
  return out;
}

const declTarget = (n: SyntaxNode) => field(n, 'name') ?? childOfType(n, 'tuple_pattern');
const nameOnly = { target: (n: SyntaxNode) => field(n, 'name'), value: () => null };

export const csharp: LanguageSpec = {
  id: 'csharp',
  name: 'C#',
  grammar: 'c-sharp',
  extensions: ['cs', 'csx'],
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
  outline: outlineCsharp,
  functionBody: csBody,
  params: csParams,
  functionTypes: [
    'method_declaration', 'constructor_declaration', 'destructor_declaration', 'operator_declaration', 'conversion_operator_declaration',
    'local_function_statement', 'accessor_declaration', 'lambda_expression', 'anonymous_method_expression', ...TYPE_DECLS,
  ],
  decisionTypes: ['if_statement', 'catch_clause', 'conditional_expression', 'switch_expression_arm'],
  // The `_ =>` arm of a switch expression is its default.
  decisionWeight: (n) => (n.type === 'switch_expression_arm' && named(n)[0]?.type === 'discard' ? 0 : 1),
  calls: {
    invocation_expression: { callee: (n) => field(n, 'function'), name: (n) => invoked(field(n, 'function')) },
    object_creation_expression: { callee: (n) => field(n, 'type'), kind: 'new', name: (n) => typeName(field(n, 'type')) },
    implicit_object_creation_expression: { callee: () => null, kind: 'new', name: targetType, args: (n) => childOfType(n, 'argument_list') },
  },
  flow: {
    blocks: ['block', 'global_statement'],
    ifs: ['if_statement'],
    elses: [],
    whiles: ['while_statement'],
    doWhiles: ['do_statement'],
    fors: ['for_statement'],
    forEachs: ['foreach_statement'],
    switches: ['switch_statement'],
    tries: ['try_statement'],
    returns: ['return_statement'],
    throws: ['throw_statement', 'throw_expression'],
    breaks: ['break_statement'],
    continues: ['continue_statement'],
    withs: ['using_statement', 'lock_statement', 'checked_statement', 'unsafe_statement', 'fixed_statement'],
    labeled: ['labeled_statement'],
    definitions: ['local_function_statement', 'namespace_declaration', 'file_scoped_namespace_declaration', ...TYPE_DECLS],
    fallthrough: false,
    switchShape,
    tryShape: (n) => genericTry(n, { catchTypes: ['catch_clause'], finallyTypes: ['finally_clause'] }),
    special: (node, conv) => {
      switch (node.type) {
        case 'empty_statement':
          return [];
        case 'yield_statement':
          // `yield break` ends the iterator; `yield return x` produces a value and continues.
          return hasToken(node, 'break') ? [conv.jump(node, 'return')] : undefined;
        case 'lock_statement':
        case 'checked_statement':
        case 'unsafe_statement':
        case 'fixed_statement': {
          // No body field, and the body may be a bare statement (`lock (x) Foo();`).
          const body = named(node).filter((c) => !isComment(c)).pop() ?? null;
          return [{ k: 'block', node, header: headerText(node, body), body: conv.stmts(body) }];
        }
      }
      return undefined;
    },
  },
  data: {
    assigns: {
      variable_declarator: { target: declTarget, value: (n) => valueOf(n, declTarget(n)) },
      assignment_expression: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
      // Bindings without a source value: `out var x`, `catch (E e)`, `case T x`.
      declaration_expression: { target: (n) => (isProduct(n) ? null : field(n, 'name')), value: () => null },
      catch_declaration: nameOnly,
      declaration_pattern: nameOnly,
      // `o is string s` binds s to o.
      is_pattern_expression: {
        target: (n) => {
          const p = field(n, 'pattern');
          return p?.type === 'declaration_pattern' ? field(p, 'name') : null;
        },
        value: (n) => field(n, 'expression'),
      },
      // Pass-throughs whose other part is a name or a type, not a read: `f(count: n)`, `o as T`.
      argument: { target: () => null, value: (n) => valueOf(n, field(n, 'name')) },
      as_expression: { target: () => null, value: (n) => field(n, 'left') },
    },
    members: {
      member_access_expression: { object: 'expression', property: 'name' },
      element_access_expression: { object: 'expression', property: 'subscript' },
      // `p.X` as the left operand of a misread product (see isProduct).
      qualified_name: { object: 'qualifier', property: 'name' },
    },
    identifiers: ['identifier'],
    selfNames: ['this'],
    skip: [
      'predefined_type', 'implicit_type', 'nullable_type', 'array_type', 'generic_name', 'type_argument_list',
      'type_parameter_list', 'array_rank_specifier', 'attribute_list', 'string_literal', 'verbatim_string_literal', 'raw_string_literal',
      'character_literal', 'integer_literal', 'real_literal', 'boolean_literal', 'null_literal', 'comment', 'typeof_expression',
      'sizeof_expression', 'default_expression', 'member_binding_expression', 'discard',
    ],
    loopBindings: {
      foreach_statement: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
    },
    scopes: {
      lambda_expression: lambdaNames,
      anonymous_method_expression: lambdaNames,
      query_expression: queryNames,
      // Scopes visit every child: a misread product reads both operands, a real `out T x` reads nothing.
      declaration_expression: (n) => (isProduct(n) ? [] : identifiersIn(n)),
      pointer_type: () => [],
    },
  },
};
