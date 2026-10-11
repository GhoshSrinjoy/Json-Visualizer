/** Java. */

import { genericTry, type SwitchShape } from '../ir';
import type { CodeSymbol, ImportRef, SymbolKind } from '../model';
import { baseNames, type LanguageSpec, type OutlineParts, type SymbolBuilder } from '../spec';
import { childOfType, clean, docComment, field, fields, isComment, kids, named, paramsText, rangeOf, walk } from '../syntax';
import type { SyntaxNode } from '../treesitter';

const TYPE_KINDS: Record<string, SymbolKind> = {
  class_declaration: 'class',
  record_declaration: 'class',
  enum_declaration: 'enum',
  interface_declaration: 'interface',
  annotation_type_declaration: 'interface',
};
const TYPE_DECLS = Object.keys(TYPE_KINDS);

/** HTML tags common in Javadoc (generics such as `List<String>` must survive). */
const HTML_TAG = /<\/?(?:p|br|b|i|em|strong|code|pre|tt|ul|ol|li|a|h[1-6]|blockquote)\b[^>]*>/gi;

/** Javadoc summary without inline tags (`{@code x}` → `x`) or HTML. */
function javadoc(node: SyntaxNode): string | undefined {
  const d = docComment(node);
  return d ? clean(d.replace(HTML_TAG, '').replace(/\{@\w+\s*([^}]*)\}/g, '$1'), 140) || undefined : undefined;
}

/** Keywords (anonymous tokens) and annotations of a declaration's `modifiers` node. */
function modifiersOf(node: SyntaxNode): string[] {
  const mods = childOfType(node, 'modifiers');
  return mods ? kids(mods).filter((c) => !isComment(c)).map((c) => (c.isNamed ? clean(c.text, 40) : c.type)) : [];
}

function importOf(node: SyntaxNode): ImportRef | undefined {
  const name = named(node).find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
  if (!name) return undefined;
  const source = name.text.replace(/\s+/g, '');
  const wildcard = !!childOfType(node, 'asterisk');
  return { source, names: [{ name: wildcard ? '*' : source.slice(source.lastIndexOf('.') + 1) }], kind: 'import', line: node.startPosition.row };
}

export function outlineJava(root: SyntaxNode, b: SymbolBuilder): OutlineParts {
  const symbols: CodeSymbol[] = [];
  const imports: ImportRef[] = [];
  const exports: string[] = [];

  const callable = (node: SyntaxNode, kind: SymbolKind, name: string, parent: CodeSymbol, signature?: string) => {
    const mods = modifiersOf(node);
    const throws = childOfType(node, 'throws');
    const sym = b.make(node, kind, name, parent, {
      signature,
      modifiers: mods.length ? mods : undefined,
      detail: throws ? clean(throws.text, 60) : undefined,
      doc: javadoc(node),
    });
    b.callable(sym, node);
    // Local classes, records, enums and interfaces.
    const body = field(node, 'body');
    if (body) for (const c of named(body)) if (TYPE_KINDS[c.type]) typeDecl(c, sym);
  };

  const fieldsOf = (node: SyntaxNode, parent: CodeSymbol) => {
    const mods = modifiersOf(node);
    const kind: SymbolKind = node.type === 'constant_declaration' || (mods.includes('static') && mods.includes('final')) ? 'constant' : 'field';
    const type = field(node, 'type');
    const doc = javadoc(node);
    for (const d of fields(node, 'declarator')) {
      const name = field(d, 'name')?.text;
      if (name) b.make(d, kind, name, parent, { modifiers: mods.length ? mods : undefined, detail: type ? clean(type.text, 40) : undefined, doc });
    }
  };

  const member = (m: SyntaxNode, parent: CodeSymbol): void => {
    const name = field(m, 'name')?.text;
    switch (m.type) {
      case 'method_declaration':
      case 'annotation_type_element_declaration': {
        if (!name) return;
        const tp = field(m, 'type_parameters');
        callable(m, 'method', name, parent, `${tp ? clean(tp.text, 40) : ''}${b.signature(field(m, 'parameters'), field(m, 'type'))}`);
        return;
      }
      case 'constructor_declaration':
        callable(m, 'constructor', name ?? parent.name, parent, b.signature(field(m, 'parameters')));
        return;
      case 'compact_constructor_declaration':
        // `record P(int x) { P { … } }`: the parameters are the record components.
        callable(m, 'constructor', name ?? parent.name, parent, parent.signature);
        return;
      case 'field_declaration':
      case 'constant_declaration':
        fieldsOf(m, parent);
        return;
      case 'enum_body_declarations':
        for (const c of named(m)) member(c, parent);
        return;
      case 'enum_constant': {
        if (!name) return;
        const args = field(m, 'arguments');
        const sym = b.make(m, 'enumMember', name, parent, { detail: args ? clean(args.text, 40) : undefined, doc: javadoc(m) });
        const body = field(m, 'body');
        if (body) for (const c of named(body)) member(c, sym);
        return;
      }
      default:
        if (TYPE_KINDS[m.type]) typeDecl(m, parent);
    }
  };

  const typeDecl = (node: SyntaxNode, parent: CodeSymbol | null) => {
    const name = field(node, 'name')?.text;
    if (!name) return;
    const mods = modifiersOf(node);
    if (node.type === 'record_declaration') mods.push('record');
    else if (node.type === 'annotation_type_declaration') mods.push('@interface');
    const heritage = [field(node, 'superclass'), field(node, 'interfaces'), childOfType(node, 'extends_interfaces'), field(node, 'permits')].filter(
      (n): n is SyntaxNode => !!n,
    );
    const bases = heritage.filter((h) => h.type !== 'permits').flatMap((h) => baseNames(h));
    const components = node.type === 'record_declaration' ? field(node, 'parameters') : null;
    const sym = b.make(node, TYPE_KINDS[node.type], name, parent, {
      signature: components ? paramsText(components) : undefined,
      detail: heritage.length ? clean(heritage.map((h) => h.text).join(' '), 80) : undefined,
      modifiers: mods.length ? mods : undefined,
      bases: bases.length ? bases : undefined,
      doc: javadoc(node),
    });
    // Record components are the record's fields.
    for (const p of components ? named(components) : []) {
      const pn = p.type === 'formal_parameter' ? field(p, 'name') : null;
      if (pn) b.make(p, 'field', pn.text, sym, { detail: clean(field(p, 'type')?.text ?? '', 40) || undefined });
    }
    const body = field(node, 'body');
    if (body) for (const m of named(body)) member(m, sym);
    if (!parent) {
      symbols.push(sym);
      if (mods.includes('public')) exports.push(name);
    }
  };

  for (const node of named(root)) {
    if (node.type === 'package_declaration') {
      const pkg = named(node).find((c) => c.type === 'scoped_identifier' || c.type === 'identifier');
      if (!pkg) continue;
      const sym = b.make(node, 'namespace', pkg.text.replace(/\s+/g, ''), null, { nameRange: rangeOf(pkg) });
      // A license header above `package` is not documentation; a Javadoc (package-info.java) is.
      if (!node.previousNamedSibling?.text.startsWith('/**')) delete sym.doc;
      symbols.push(sym);
    } else if (node.type === 'import_declaration') {
      const imp = importOf(node);
      if (imp) imports.push(imp);
    } else if (TYPE_KINDS[node.type]) typeDecl(node, null);
  }
  return { symbols, imports, exports };
}

/** Parameter names of methods, constructors and lambdas (`x ->`, `(a, b) ->`, `(int a) ->`). */
function javaParams(fn: SyntaxNode): string[] {
  const p = field(fn, 'parameters') ?? (fn.type === 'compact_constructor_declaration' ? field(fn.parent?.parent, 'parameters') : null);
  if (!p) return [];
  if (p.type === 'identifier') return [p.text];
  const out: string[] = [];
  for (const c of named(p)) {
    let name: SyntaxNode | null = null;
    if (c.type === 'identifier') name = c;
    else if (c.type === 'formal_parameter') name = field(c, 'name');
    else if (c.type === 'spread_parameter') name = field(childOfType(c, 'variable_declarator'), 'name');
    if (name) out.push(name.text);
  }
  return out;
}

const LOCAL_DECLS = new Set(['variable_declarator', 'enhanced_for_statement', 'catch_formal_parameter', 'resource']);

/** Names a lambda binds: its parameters plus the locals of a block body (data flow skips nested scopes when collecting locals). */
function lambdaNames(fn: SyntaxNode): string[] {
  const out = javaParams(fn);
  const body = field(fn, 'body');
  if (body?.type === 'block') {
    walk(body, (n) => {
      if (n.type === 'lambda_expression' || n.type === 'class_body') return false;
      const name = LOCAL_DECLS.has(n.type) ? field(n, 'name') : null;
      if (name) out.push(name.text);
      return true;
    });
  }
  return out;
}

/** `Foo`, `Foo<T>`, `pkg.Outer.Inner` → name + qualifier. */
function typeRef(t: SyntaxNode | null): { name: string; receiver?: string } | null {
  if (!t) return null;
  if (t.type === 'generic_type') return typeRef(named(t).find((c) => c.type !== 'type_arguments') ?? null);
  if (t.type === 'scoped_type_identifier') {
    const parts = named(t);
    const last = parts.pop();
    return last ? { name: last.text, receiver: parts.length ? clean(parts.map((p) => p.text).join('.'), 40) : undefined } : null;
  }
  return { name: clean(t.text, 40) };
}

/** `case 1:` groups and `case X ->` rules of a switch block. */
function switchShape(node: SyntaxNode): SwitchShape {
  const cases: SwitchShape['cases'] = [];
  const body = field(node, 'body');
  for (const c of body ? named(body) : []) {
    if (c.type !== 'switch_block_statement_group' && c.type !== 'switch_rule') continue;
    const labels = named(c).filter((k) => k.type === 'switch_label');
    // `default` is a bare label, or a value in `case null, default`.
    const isDefault = labels.some((l) => !named(l).length || named(l).some((v) => v.text === 'default'));
    cases.push({
      label: labels.map((l) => clean(l.text.replace(/^case\b\s*/, ''), 40)).join(', '),
      body: named(c).filter((k) => k.type !== 'switch_label' && !isComment(k)),
      isDefault,
      node: c,
    });
  }
  return { subject: field(node, 'condition'), cases };
}

const binding = (target: string, value?: string) => ({
  target: (n: SyntaxNode) => field(n, target),
  value: (n: SyntaxNode) => (value ? field(n, value) : null),
});

export const java: LanguageSpec = {
  id: 'java',
  name: 'Java',
  grammar: 'java',
  extensions: ['java'],
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
  outline: outlineJava,
  functionBody: (fn) => field(fn, 'body'),
  params: javaParams,
  // `class_body` covers anonymous classes (`new Runnable() { … }`).
  functionTypes: ['method_declaration', 'constructor_declaration', 'compact_constructor_declaration', 'lambda_expression', 'class_body', ...TYPE_DECLS],
  decisionTypes: [
    'if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'catch_clause', 'ternary_expression',
    'switch_label',
  ],
  calls: {
    method_invocation: {
      callee: (n) => field(n, 'name'),
      name: (n) => {
        const name = field(n, 'name');
        const obj = field(n, 'object');
        return name ? { name: name.text, receiver: obj ? clean(obj.text, 40) : undefined } : null;
      },
    },
    object_creation_expression: { callee: (n) => field(n, 'type'), kind: 'new', name: (n) => typeRef(field(n, 'type')) },
    // `this(…)` / `super(…)` in constructors.
    explicit_constructor_invocation: { callee: (n) => field(n, 'constructor') },
  },
  flow: {
    blocks: ['block', 'constructor_body'],
    ifs: ['if_statement'],
    elses: [],
    whiles: ['while_statement'],
    doWhiles: ['do_statement'],
    fors: ['for_statement'],
    forEachs: ['enhanced_for_statement'],
    switches: ['switch_expression'],
    tries: ['try_statement', 'try_with_resources_statement'],
    returns: ['return_statement'],
    throws: ['throw_statement'],
    breaks: ['break_statement'],
    continues: ['continue_statement'],
    withs: ['synchronized_statement'],
    labeled: ['labeled_statement'],
    definitions: TYPE_DECLS,
    fallthrough: true,
    switchShape,
    tryShape: (n) => genericTry(n, { catchTypes: ['catch_clause'], finallyTypes: ['finally_clause'] }),
    special: (node, conv) => {
      if (node.type === 'switch_expression') {
        const s = conv.switchStmt(node);
        // `case X:` groups fall through; `case X ->` rules never do.
        if (s.k === 'switch') s.fallthrough = !named(field(node, 'body') ?? node).some((c) => c.type === 'switch_rule');
        return [s];
      }
      if (node.type === 'try_with_resources_statement') {
        const s = conv.tryStmt(node);
        // Resources are acquired inside the try: their exceptions reach the catch clauses.
        const res = field(node, 'resources');
        if (s.k === 'try' && res) s.body.unshift(...named(res).filter((r) => !isComment(r)).map((r) => conv.simple(r)));
        return [s];
      }
      return undefined;
    },
  },
  data: {
    assigns: {
      variable_declarator: binding('name', 'value'),
      assignment_expression: binding('left', 'right'),
      resource: binding('name', 'value'),
      // `o instanceof String s` binds s to o.
      instanceof_expression: binding('name', 'left'),
      catch_formal_parameter: binding('name'),
      // Pattern variables (`case String s ->`, `Point(int x, int y)`) have no name field.
      type_pattern: { target: (n) => childOfType(n, 'identifier'), value: () => null },
      record_pattern_component: { target: (n) => childOfType(n, 'identifier'), value: () => null },
    },
    members: {
      field_access: { object: 'object', property: 'field' },
      array_access: { object: 'array', property: 'index' },
    },
    identifiers: ['identifier'],
    selfNames: ['this'],
    skip: [
      'type_identifier', 'scoped_type_identifier', 'generic_type', 'array_type', 'integral_type', 'floating_point_type', 'boolean_type',
      'void_type', 'type_arguments', 'dimensions', 'string_literal', 'character_literal', 'decimal_integer_literal', 'hex_integer_literal',
      'octal_integer_literal', 'binary_integer_literal', 'decimal_floating_point_literal', 'hex_floating_point_literal', 'true', 'false',
      'null_literal', 'class_literal', 'line_comment', 'block_comment', 'marker_annotation', 'annotation', 'modifiers',
    ],
    loopBindings: {
      enhanced_for_statement: binding('name', 'value'),
    },
    scopes: {
      lambda_expression: lambdaNames,
    },
  },
};
