/** C and C++ (the tree-sitter `cpp` grammar parses both). */

import { genericSwitch, genericTry, type IRConverter, type Stmt } from '../ir';
import { CALLABLE_KINDS, type CodeSymbol, type ImportRef, type SymbolKind } from '../model';
import { baseNames, calleeName, paramNames, type LanguageSpec, type OutlineParts, type SymbolBuilder } from '../spec';
import { childOfType, clean, docComment, field, fields, hasToken, named, paramsText, rangeOf } from '../syntax';
import type { SyntaxNode } from '../treesitter';

const TYPE_KINDS: Record<string, SymbolKind> = {
  class_specifier: 'class',
  struct_specifier: 'struct',
  union_specifier: 'struct',
  enum_specifier: 'enum',
};

const PREPROC_BLOCKS = new Set(['preproc_if', 'preproc_ifdef', 'preproc_else', 'preproc_elif', 'preproc_elifdef']);
const PREPROC_IFS = new Set(['preproc_if', 'preproc_ifdef', 'preproc_elif', 'preproc_elifdef']);
const WRAPPERS = new Set(['pointer_declarator', 'reference_declarator', 'parenthesized_declarator', 'attributed_declarator']);
const NAMES = new Set(['identifier', 'field_identifier', 'type_identifier', 'qualified_identifier', 'destructor_name', 'operator_name']);
/** `type_qualifier` spellings that are really function/variable specifiers. */
const SPECIFIERS = new Set(['constexpr', 'consteval', 'constinit']);
const TEMPLATED = /^template_(function|type|method)$/;
const ANONYMOUS = '(anonymous)';

/** The declarator wrapped by a pointer/reference/parenthesized declarator. */
function inner(d: SyntaxNode): SyntaxNode | null {
  return field(d, 'declarator') ?? named(d).find((c) => /declarator|identifier|name/.test(c.type)) ?? null;
}

/** Function declarator (or conversion operator) of a declarator; null for variables and function pointers. */
function asFunction(d: SyntaxNode | null): SyntaxNode | null {
  while (d && WRAPPERS.has(d.type)) d = inner(d);
  if (d?.type === 'operator_cast') return d;
  if (d?.type !== 'function_declarator') return null;
  return field(d, 'declarator')?.type === 'parenthesized_declarator' ? null : d;
}

function parameterList(fd: SyntaxNode): SyntaxNode | null {
  return fd.type === 'operator_cast' ? field(field(fd, 'declarator'), 'parameters') : field(fd, 'parameters');
}

function paramsOf(fn: SyntaxNode): string[] {
  if (fn.type === 'lambda_expression') return paramNames(field(field(fn, 'declarator'), 'parameters'));
  const fd = asFunction(field(fn, 'declarator'));
  return fd ? paramNames(parameterList(fd)) : [];
}

/** Identifier node declared by a (possibly wrapped) declarator. */
function declaredName(d: SyntaxNode | null): SyntaxNode | null {
  while (d && !NAMES.has(d.type)) d = inner(d);
  return d;
}

function plainName(n: SyntaxNode): string {
  if (TEMPLATED.test(n.type)) return field(n, 'name')?.text ?? n.text;
  if (n.type === 'operator_cast') return `operator ${clean(field(n, 'type')?.text ?? '', 30)}`;
  return clean(n.text, 60);
}

interface QualifiedName {
  scope: string[];
  name: string;
  node: SyntaxNode;
}

/** `app::User::greet` -> scope [app, User], name greet. */
function qualifiedName(n: SyntaxNode): QualifiedName {
  const scope: string[] = [];
  let cur = n;
  while (cur.type === 'qualified_identifier') {
    const s = field(cur, 'scope');
    if (s) scope.push(plainName(s));
    const next = field(cur, 'name');
    if (!next) break;
    cur = next;
  }
  return { scope, name: plainName(cur), node: cur };
}

/** Members named like their class (`Box`, or `Inner` in `class Outer::Inner`) are constructors. */
function memberKind(name: string, cls: CodeSymbol): SymbolKind {
  return name === cls.name.split('::').pop() ? 'constructor' : 'method';
}

function functionName(fd: SyntaxNode): QualifiedName | null {
  if (fd.type === 'operator_cast') return { scope: [], name: plainName(fd), node: fd };
  const d = field(fd, 'declarator');
  return d ? qualifiedName(d) : null;
}

function returnType(node: SyntaxNode, fd: SyntaxNode): string | undefined {
  const trailing = childOfType(fd, 'trailing_return_type');
  if (trailing) return clean(trailing.text.replace(/^->\s*/, ''), 60);
  const type = field(node, 'type');
  if (!type) return undefined;
  const quals = named(node).filter((c) => c.type === 'type_qualifier' && c.startIndex < type.startIndex && !SPECIFIERS.has(c.text));
  let ptr = '';
  for (let d = field(node, 'declarator'); d && d.id !== fd.id && WRAPPERS.has(d.type); d = inner(d)) {
    if (d.type === 'pointer_declarator') ptr += '*';
    else if (d.type === 'reference_declarator') ptr += d.text.startsWith('&&') ? '&&' : '&';
  }
  return clean([...quals.map((q) => q.text), type.text].join(' ') + ptr, 60);
}

function signatureOf(node: SyntaxNode, fd: SyntaxNode, kind: SymbolKind): string {
  const params = paramsText(parameterList(fd));
  const ret = kind === 'constructor' ? undefined : returnType(node, fd);
  return ret ? `${params} -> ${ret}` : params;
}

function functionModifiers(node: SyntaxNode, fd: SyntaxNode, access?: string): string[] {
  const m = access ? [access] : [];
  for (const c of named(node)) {
    if (c.type === 'storage_class_specifier' || (c.type === 'type_qualifier' && SPECIFIERS.has(c.text))) m.push(c.text);
    else if (c.type === 'explicit_function_specifier') m.push('explicit');
  }
  if (hasToken(node, 'virtual')) m.push('virtual');
  for (const c of named(fd)) {
    // const / volatile, override / final, noexcept(…)
    if (c.type === 'type_qualifier' || c.type === 'virtual_specifier' || c.type === 'noexcept') m.push(c.text.split('(')[0]);
  }
  if (field(node, 'default_value')?.text === '0') m.push('abstract');
  if (childOfType(node, 'default_method_clause')) m.push('default');
  if (childOfType(node, 'delete_method_clause')) m.push('delete');
  return m;
}

/** Type text without an inline body: `struct Inner { … }` -> `struct Inner`. */
function typeText(type: SyntaxNode | null): string | undefined {
  return type ? clean(type.text.split('{')[0], 50) : undefined;
}

function variableModifiers(node: SyntaxNode, access?: string): string[] {
  const m = access ? [access] : [];
  for (const c of named(node)) if (c.type === 'storage_class_specifier' || c.type === 'type_qualifier') m.push(c.text);
  return m;
}

/** Named children, looking through `#if`/`#ifdef` blocks. */
function members(node: SyntaxNode): SyntaxNode[] {
  return named(node).flatMap((c) => (PREPROC_BLOCKS.has(c.type) ? members(c) : [c]));
}

function templateText(node: SyntaxNode): string {
  const p = field(node, 'parameters');
  return `template ${p ? clean(p.text, 60) : '<>'}`;
}

function importOf(node: SyntaxNode): ImportRef | undefined {
  const line = node.startPosition.row;
  if (node.type === 'preproc_include') {
    const p = field(node, 'path');
    // "local.h" loses its quotes; <system.h> stays as written.
    return p ? { source: p.type === 'string_literal' ? p.text.slice(1, -1) : p.text, names: [{ name: '*' }], kind: 'include', line } : undefined;
  }
  if (node.type === 'namespace_alias_definition') {
    // namespace fs = std::filesystem;
    const alias = field(node, 'name');
    const target = named(node).find((c) => c.id !== alias?.id);
    return target ? { source: target.text, names: [{ name: '*', alias: alias?.text }], kind: 'using', line } : undefined;
  }
  // using namespace std; / using std::string;
  const target = named(node)[0];
  if (!target) return undefined;
  const names = hasToken(node, 'namespace') ? [{ name: '*' }] : [{ name: qualifiedName(target).name }];
  return { source: target.text, names, kind: 'using', line };
}

/** Namespace-scope names with external visibility (not `static`, not in an anonymous namespace). */
function exportsOf(symbols: CodeSymbol[], ns: string[] = [], out: string[] = []): string[] {
  for (const s of symbols) {
    if (s.kind === 'namespace') {
      if (s.name !== ANONYMOUS) exportsOf(s.children ?? [], [...ns, s.name], out);
    } else if (s.kind !== 'macro' && s.name !== ANONYMOUS && !s.modifiers?.includes('static')) {
      out.push([...ns, s.name].join('::'));
    }
  }
  return out;
}

export function outlineCpp(root: SyntaxNode, b: SymbolBuilder): OutlineParts {
  const symbols: CodeSymbol[] = [];
  const imports: ImportRef[] = [];
  /** Classes by simple and namespace-qualified name, for out-of-class member definitions. */
  const classes = new Map<string, CodeSymbol>();

  const add = (sym: CodeSymbol, parent: CodeSymbol | null): CodeSymbol => {
    if (!parent) symbols.push(sym);
    return sym;
  };

  const callable = (node: SyntaxNode, fd: SyntaxNode, kind: SymbolKind, q: QualifiedName, name: string, parent: CodeSymbol | null, mods: string[], template?: string) => {
    const sym = b.make(node, kind, name, parent, {
      signature: signatureOf(node, fd, kind),
      modifiers: mods.length ? mods : undefined,
      detail: template,
      nameRange: rangeOf(q.node),
    });
    b.callable(add(sym, parent), node);
  };

  const typeSymbol = (node: SyntaxNode, parent: CodeSymbol | null, ns: string[], template?: string, alias?: SyntaxNode, outer?: SyntaxNode): void => {
    const body = field(node, 'body');
    if (!body) return; // forward declaration or elaborated type
    const nameNode = field(node, 'name') ?? alias ?? null;
    const name = nameNode ? plainName(nameNode) : ANONYMOUS;
    const kind = TYPE_KINDS[node.type];
    const bases = baseNames(childOfType(node, 'base_class_clause') ?? field(node, 'base'));
    const mods = named(node).filter((c) => c.type === 'virtual_specifier').map((c) => c.text);
    const scoped = node.type === 'enum_specifier' && (hasToken(node, 'class') || hasToken(node, 'struct'));
    const sym = add(
      b.make(outer ?? node, kind, name, parent, {
        nameRange: nameNode ? rangeOf(nameNode) : undefined,
        bases: bases.length ? bases : undefined,
        modifiers: mods.length ? mods : undefined,
        detail: template ?? (node.type === 'union_specifier' ? 'union' : scoped ? 'enum class' : undefined),
      }),
      parent,
    );
    if (kind === 'enum') {
      for (const e of named(body)) {
        const en = e.type === 'enumerator' ? field(e, 'name') : null;
        const value = field(e, 'value');
        if (en) b.make(e, 'enumMember', en.text, sym, { detail: value ? clean(value.text, 40) : undefined });
      }
      return;
    }
    classes.set(name, sym);
    classes.set([...ns, name].join('::'), sym);
    // `class` members are private until an access specifier says otherwise.
    let access = node.type === 'class_specifier' ? 'private' : undefined;
    for (const m of members(body)) {
      if (m.type === 'access_specifier') access = m.text;
      else member(m, sym, access, [...ns, name]);
    }
  };

  const member = (m: SyntaxNode, cls: CodeSymbol, access: string | undefined, ns: string[], template?: string): void => {
    switch (m.type) {
      case 'function_definition': {
        const fd = asFunction(field(m, 'declarator'));
        const q = fd && functionName(fd);
        if (fd && q) callable(m, fd, memberKind(q.name, cls), q, q.name, cls, functionModifiers(m, fd, access), template);
        return;
      }
      case 'field_declaration':
      case 'declaration': {
        const type = field(m, 'type');
        if (type && TYPE_KINDS[type.type]) typeSymbol(type, cls, ns, template);
        for (const d of fields(m, 'declarator')) {
          const fd = asFunction(d);
          const q = fd && functionName(fd);
          if (fd && q) {
            // Declaration only (hasBody stays false until an out-of-class definition shows up).
            callable(m, fd, memberKind(q.name, cls), q, q.name, cls, functionModifiers(m, fd, access), template);
            continue;
          }
          const n = declaredName(d);
          const mods = variableModifiers(m, access);
          if (n) b.make(m, 'field', n.text, cls, { nameRange: rangeOf(n), modifiers: mods.length ? mods : undefined, detail: typeText(type) });
        }
        return;
      }
      case 'template_declaration':
        for (const c of named(m)) member(c, cls, access, ns, templateText(m));
        return;
      case 'alias_declaration':
      case 'type_definition':
        typeAlias(m, cls, ns);
        return;
      default:
        if (TYPE_KINDS[m.type]) typeSymbol(m, cls, ns, template);
    }
  };

  const typeAlias = (node: SyntaxNode, parent: CodeSymbol | null, ns: string[]): void => {
    const type = field(node, 'type');
    if (node.type === 'alias_declaration') {
      const name = field(node, 'name');
      if (name) add(b.make(node, 'type', name.text, parent, { detail: typeText(type) }), parent);
      return;
    }
    const names = fields(node, 'declarator').map(declaredName).filter((n): n is SyntaxNode => !!n);
    if (!names.length) return;
    if (type && TYPE_KINDS[type.type] && field(type, 'body')) {
      // typedef struct { … } Name;  /  typedef struct Node { … } Node;
      const tag = field(type, 'name');
      typeSymbol(type, parent, ns, undefined, names[0], tag ? undefined : node);
      if (!tag || tag.text === names[0].text) return;
    }
    for (const [i, n] of names.entries()) {
      // `typedef unsigned long ulong;` -> unsigned long; function pointers keep the whole declarator.
      const d = fields(node, 'declarator')[i];
      const detail = d?.type === 'type_identifier' ? typeText(type) : clean(node.text.replace(/^typedef\s+/, '').replace(/;\s*$/, ''), 60);
      add(b.make(node, 'type', n.text, parent, { detail, nameRange: rangeOf(n) }), parent);
    }
  };

  const declaration = (node: SyntaxNode, parent: CodeSymbol | null, ns: string[], template?: string): void => {
    const type = field(node, 'type');
    if (type && TYPE_KINDS[type.type]) typeSymbol(type, parent, ns, template);
    for (const d of fields(node, 'declarator')) {
      const fd = asFunction(d);
      const q = fd && functionName(fd);
      if (fd && q) {
        // Prototype (`int f(int);`); qualified ones redeclare members.
        if (!q.scope.length) callable(node, fd, 'function', q, q.name, parent, functionModifiers(node, fd), template);
        continue;
      }
      const n = declaredName(d);
      if (!n || n.type === 'qualified_identifier') continue; // `int Foo::count = 0;`
      const mods = variableModifiers(node);
      const kind: SymbolKind = mods.includes('const') || mods.includes('constexpr') ? 'constant' : 'variable';
      add(b.make(d, kind, n.text, parent, { nameRange: rangeOf(n), modifiers: mods.length ? mods : undefined, detail: typeText(type) }), parent);
    }
  };

  const functionDef = (node: SyntaxNode, parent: CodeSymbol | null, ns: string[], template?: string): void => {
    const fd = asFunction(field(node, 'declarator'));
    const q = fd && functionName(fd);
    if (!fd || !q) return;
    if (q.scope.length) {
      const scope = q.scope.join('::');
      const cls = classes.get([...ns, scope].join('::')) ?? classes.get(scope) ?? classes.get(q.scope[q.scope.length - 1]);
      if (cls) return defineMember(node, fd, q, cls, template);
    }
    callable(node, fd, 'function', q, [...q.scope, q.name].join('::'), parent, functionModifiers(node, fd), template);
  };

  /** `Type Class::member(…) { … }` completes the in-class declaration, or adds the member. */
  const defineMember = (node: SyntaxNode, fd: SyntaxNode, q: QualifiedName, cls: CodeSymbol, template?: string): void => {
    const decl = cls.children?.find((s) => s.name === q.name && CALLABLE_KINDS.has(s.kind) && !s.hasBody);
    if (!decl) {
      callable(node, fd, memberKind(q.name, cls), q, q.name, cls, functionModifiers(node, fd), template);
      return;
    }
    b.nodes.set(decl.id, node);
    decl.range = rangeOf(node);
    decl.nameRange = rangeOf(q.node);
    decl.signature = signatureOf(node, fd, decl.kind);
    decl.doc ??= docComment(node);
    b.callable(decl, node);
  };

  const macro = (node: SyntaxNode, parent: CodeSymbol | null): void => {
    const name = field(node, 'name');
    const value = field(node, 'value');
    if (!name) return;
    // Include guards (`#ifndef FOO_H` + `#define FOO_H`) are noise.
    if (!value && node.parent?.type === 'preproc_ifdef' && field(node.parent, 'name')?.text === name.text) return;
    const params = field(node, 'parameters');
    add(b.make(node, 'macro', name.text, parent, { signature: params ? clean(params.text, 60) : undefined, detail: value ? clean(value.text, 60) : undefined }), parent);
  };

  const top = (node: SyntaxNode, parent: CodeSymbol | null, ns: string[], template?: string): void => {
    switch (node.type) {
      case 'preproc_include':
      case 'using_declaration':
      case 'namespace_alias_definition': {
        const imp = importOf(node);
        if (imp) imports.push(imp);
        return;
      }
      case 'preproc_def':
      case 'preproc_function_def':
        macro(node, parent);
        return;
      case 'namespace_definition': {
        const nameNode = field(node, 'name');
        const sym = add(b.make(node, 'namespace', nameNode ? nameNode.text : ANONYMOUS, parent), parent);
        const body = field(node, 'body');
        if (body) for (const c of named(body)) top(c, sym, nameNode ? [...ns, nameNode.text] : ns);
        return;
      }
      case 'linkage_specification': {
        // extern "C" { … }  /  extern "C" int f();
        const body = field(node, 'body');
        if (body?.type === 'declaration_list') for (const c of named(body)) top(c, parent, ns);
        else if (body) top(body, parent, ns);
        return;
      }
      case 'template_declaration':
        for (const c of named(node)) top(c, parent, ns, templateText(node));
        return;
      case 'function_definition':
        functionDef(node, parent, ns, template);
        return;
      case 'declaration':
        declaration(node, parent, ns, template);
        return;
      case 'type_definition':
      case 'alias_declaration':
        typeAlias(node, parent, ns);
        return;
      default:
        if (PREPROC_BLOCKS.has(node.type)) for (const c of named(node)) top(c, parent, ns);
        else if (TYPE_KINDS[node.type]) typeSymbol(node, parent, ns, template);
    }
  };

  for (const c of named(root)) top(c, null, []);
  return { symbols, imports, exports: [...new Set(exportsOf(symbols))] };
}

// ---------------------------------------------------------------- calls

function callee(n: SyntaxNode | null): { name: string; receiver?: string } | null {
  if (!n) return null;
  switch (n.type) {
    case 'identifier':
    case 'type_identifier':
    case 'field_identifier':
      return { name: n.text };
    case 'field_expression': {
      const f = field(n, 'field');
      const obj = field(n, 'argument');
      return f ? { name: plainName(f), receiver: obj ? clean(obj.text, 40) : undefined } : null;
    }
    case 'qualified_identifier': {
      const q = qualifiedName(n);
      return { name: q.name, receiver: q.scope.length ? q.scope.join('::') : undefined };
    }
    case 'template_function':
    case 'template_type':
      return callee(field(n, 'name'));
    case 'primitive_type':
    case 'placeholder_type_specifier':
      return null;
    default:
      return calleeName(n);
  }
}

/** `User u("x", 1);` and `Point p{1, 2};` construct objects without a call expression. */
function directInit(n: SyntaxNode): { name: string; receiver?: string } | null {
  const v = field(n, 'value');
  if (!v || !(v.type === 'argument_list' || (v.type === 'initializer_list' && !hasToken(n, '=')))) return null;
  return n.parent?.type === 'declaration' ? callee(field(n.parent, 'type')) : null;
}

// ---------------------------------------------------------------- flow

/** `#if` / `#ifdef` inside a function body: a compile-time branch. */
function preprocIf(node: SyntaxNode, conv: IRConverter): Stmt {
  const cond = field(node, 'condition') ?? field(node, 'name');
  const alt = field(node, 'alternative');
  const body = named(node).filter((c) => c.id !== cond?.id && c.id !== alt?.id);
  let otherwise: Stmt[] | undefined;
  if (alt) otherwise = PREPROC_IFS.has(alt.type) ? [preprocIf(alt, conv)] : conv.list(named(alt));
  return { k: 'if', node, cond: clean(node.text.split('\n')[0], 80), condNode: cond, then: conv.list(body), else: otherwise };
}

function special(node: SyntaxNode, conv: IRConverter): Stmt[] | undefined {
  if (PREPROC_IFS.has(node.type)) return [preprocIf(node, conv)];
  return undefined;
}

function makeSpec(id: string, name: string, extensions: string[]): LanguageSpec {
  return {
    id,
    name,
    grammar: 'cpp',
    extensions,
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    outline: outlineCpp,
    functionBody: (fn) => field(fn, 'body'),
    params: paramsOf,
    functionTypes: ['function_definition', 'lambda_expression', 'class_specifier', 'struct_specifier', 'union_specifier'],
    decisionTypes: ['if_statement', 'catch_clause', 'conditional_expression', ...PREPROC_IFS],
    calls: {
      call_expression: { callee: (n) => field(n, 'function'), name: (n) => callee(field(n, 'function')) },
      new_expression: { callee: (n) => field(n, 'type'), name: (n) => callee(field(n, 'type')), kind: 'new' },
      init_declarator: { callee: () => null, name: directInit, args: (n) => field(n, 'value'), kind: 'new' },
    },
    flow: {
      blocks: ['compound_statement'],
      ifs: ['if_statement'],
      elses: ['else_clause'],
      whiles: ['while_statement'],
      doWhiles: ['do_statement'],
      fors: ['for_statement'],
      forEachs: ['for_range_loop'],
      switches: ['switch_statement'],
      tries: ['try_statement'],
      returns: ['return_statement', 'co_return_statement'],
      throws: ['throw_statement'],
      breaks: ['break_statement'],
      continues: ['continue_statement'],
      gotos: ['goto_statement'],
      labeled: ['labeled_statement'],
      definitions: ['function_definition', 'class_specifier', 'struct_specifier', 'union_specifier', 'enum_specifier'],
      fallthrough: true,
      switchShape: (n) => genericSwitch(n, { subjectFields: ['condition'], caseTypes: ['case_statement'], labelFields: ['value'] }),
      tryShape: (n) => genericTry(n, { catchTypes: ['catch_clause'], finallyTypes: [] }),
      // `for (;;)` only exits through break/return.
      loopKind: (n, base) => (n.type === 'for_statement' && !field(n, 'condition') ? 'infinite' : base),
      special,
    },
    data: {
      assigns: {
        init_declarator: { target: (n) => field(n, 'declarator'), value: (n) => field(n, 'value') },
        assignment_expression: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
      },
      members: {
        field_expression: { object: 'argument', property: 'field' },
        subscript_expression: { object: 'argument', property: 'indices' },
      },
      identifiers: ['identifier'],
      selfNames: ['this'],
      skip: [
        'type_identifier', 'primitive_type', 'qualified_identifier', 'template_argument_list', 'type_descriptor', 'field_identifier',
        'statement_identifier', 'string_literal', 'raw_string_literal', 'char_literal', 'number_literal', 'comment',
      ],
      loopBindings: {
        for_range_loop: { target: (n) => field(n, 'declarator'), value: (n) => field(n, 'right') },
        // Declarations without an initializer (`std::vector<User> result;`) still define locals.
        // Declarations are never loop nodes, so only the local-variable pass reads this entry.
        declaration: { target: (n) => fields(n, 'declarator').find((d) => d.type !== 'init_declarator') ?? null, value: () => null },
      },
      scopes: {
        lambda_expression: paramsOf,
      },
    },
  };
}

export const cpp = makeSpec('cpp', 'C++', ['cpp', 'cc', 'cxx', 'c++', 'hpp', 'hh', 'hxx', 'ipp', 'tpp', 'ino']);
export const c = makeSpec('c', 'C', ['c']);
