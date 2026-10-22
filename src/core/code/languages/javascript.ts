/** JavaScript, TypeScript and TSX. */

import { genericSwitch, genericTry } from '../ir';
import type { CodeSymbol, ImportRef, SymbolKind } from '../model';
import { baseNames, paramNames, type LanguageSpec, type OutlineParts, type SymbolBuilder } from '../spec';
import { childOfType, clean, field, hasToken, named, walk } from '../syntax';
import type { SyntaxNode } from '../treesitter';

const FUNCTION_TYPES = [
  'function_declaration', 'generator_function_declaration', 'function_expression', 'function', 'arrow_function',
  'generator_function', 'method_definition', 'class_declaration', 'abstract_class_declaration', 'class',
];

function stringValue(n: SyntaxNode | null): string | undefined {
  if (!n) return undefined;
  if (n.type === 'string') return n.text.slice(1, -1);
  if (n.type === 'template_string' && !n.text.includes('${')) return n.text.slice(1, -1);
  return undefined;
}

/** Identifiers bound by an object/array destructuring pattern. */
function patternBindings(pattern: SyntaxNode): string[] {
  const out: string[] = [];
  walk(pattern, (n) => {
    if (n.type === 'pair_pattern') {
      const v = field(n, 'value');
      if (v) out.push(...patternBindings(v));
      return false;
    }
    if (n.type === 'object_assignment_pattern' || n.type === 'assignment_pattern') {
      // `{ a = fallback }`: only the left side is bound.
      const left = field(n, 'left');
      if (left) out.push(...patternBindings(left));
      return false;
    }
    if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') out.push(n.text);
    return true;
  });
  return out;
}

function importOf(node: SyntaxNode): ImportRef | undefined {
  const source = stringValue(field(node, 'source'));
  if (source === undefined) return undefined;
  const names: ImportRef['names'] = [];
  const clause = childOfType(node, 'import_clause');
  if (clause) {
    for (const c of named(clause)) {
      if (c.type === 'identifier') names.push({ name: 'default', alias: c.text });
      else if (c.type === 'namespace_import') names.push({ name: '*', alias: named(c)[0]?.text });
      else if (c.type === 'named_imports') {
        for (const s of named(c)) {
          if (s.type !== 'import_specifier') continue;
          const n = field(s, 'name')?.text ?? s.text;
          const a = field(s, 'alias')?.text;
          names.push(a ? { name: n, alias: a } : { name: n });
        }
      }
    }
  }
  if (node.type === 'export_statement') {
    const clauseE = childOfType(node, 'export_clause');
    if (clauseE) for (const s of named(clauseE)) names.push({ name: field(s, 'name')?.text ?? s.text });
    else names.push({ name: '*' });
  }
  return { source, names, kind: node.type === 'export_statement' ? 'export-from' : 'import', line: node.startPosition.row };
}

export function outlineJs(root: SyntaxNode, b: SymbolBuilder): OutlineParts {
  const symbols: CodeSymbol[] = [];
  const imports: ImportRef[] = [];
  const exports = new Set<string>();

  const add = (sym: CodeSymbol | null, parent: CodeSymbol | null) => {
    if (sym && !parent) symbols.push(sym);
  };

  const fnSymbol = (node: SyntaxNode, name: string, kind: SymbolKind, parent: CodeSymbol | null, mods: string[]): CodeSymbol => {
    const params = field(node, 'parameters') ?? field(node, 'parameter');
    const sym = b.make(node, kind, name, parent, {
      signature: b.signature(params, field(node, 'return_type')),
      modifiers: mods.length ? mods : undefined,
    });
    b.callable(sym, node);
    const body = field(node, 'body');
    if (body) visitBody(body, sym);
    return sym;
  };

  const modifiersOf = (node: SyntaxNode, exported: boolean): string[] => {
    const m: string[] = [];
    if (exported) m.push('export');
    for (const t of ['async', 'static', 'abstract', 'readonly', 'declare', 'get', 'set', '*', 'override']) {
      if (hasToken(node, t)) m.push(t === '*' ? 'generator' : t);
    }
    const acc = childOfType(node, 'accessibility_modifier');
    if (acc) m.push(acc.text);
    return m;
  };

  /** Nested functions/classes inside a function body. */
  const visitBody = (body: SyntaxNode, parent: CodeSymbol) => {
    for (const c of named(body)) {
      if (c.type === 'function_declaration' || c.type === 'generator_function_declaration' || c.type === 'class_declaration') {
        decl(c, parent, false);
      } else if (c.type === 'lexical_declaration' || c.type === 'variable_declaration') {
        for (const d of named(c)) {
          const v = field(d, 'value');
          if (d.type === 'variable_declarator' && v && /function|arrow_function|class/.test(v.type)) declarator(d, c, parent, false);
        }
      }
    }
  };

  const classSymbol = (node: SyntaxNode, name: string, parent: CodeSymbol | null, mods: string[]) => {
    const heritage = childOfType(node, 'class_heritage');
    const bases = heritage ? baseNames(heritage) : [];
    const sym = b.make(node, 'class', name, parent, {
      bases: bases.length ? bases : undefined,
      detail: heritage ? clean(heritage.text, 80) : undefined,
      modifiers: mods.length ? mods : undefined,
    });
    const body = field(node, 'body');
    if (body) {
      for (const m of named(body)) {
        if (m.type === 'method_definition' || m.type === 'abstract_method_signature' || m.type === 'method_signature') {
          const nm = field(m, 'name')?.text ?? 'method';
          const mm = modifiersOf(m, false);
          const kind: SymbolKind = nm === 'constructor' ? 'constructor' : mm.includes('get') || mm.includes('set') ? 'property' : 'method';
          fnSymbol(m, nm, kind, sym, mm);
        } else if (m.type === 'public_field_definition' || m.type === 'field_definition' || m.type === 'property_signature') {
          const nm = field(m, 'name')?.text ?? field(m, 'property')?.text ?? 'field';
          const v = field(m, 'value');
          if (v && /arrow_function|function/.test(v.type)) fnSymbol(v, nm, 'method', sym, modifiersOf(m, false));
          else b.make(m, 'property', nm, sym, { modifiers: modifiersOf(m, false), detail: clean(field(m, 'type')?.text?.replace(/^:\s*/, '') ?? '', 40) || undefined });
        }
      }
    }
    return sym;
  };

  const declarator = (d: SyntaxNode, declNode: SyntaxNode, parent: CodeSymbol | null, exported: boolean) => {
    const nameNode = field(d, 'name');
    if (!nameNode) return;
    // Destructuring (`const { a, b: c } = …`) is named after its bindings.
    const name = nameNode.type === 'identifier' ? nameNode.text : patternBindings(nameNode).join(', ') || clean(nameNode.text, 40);
    const value = field(d, 'value');
    const isConst = declNode.text.startsWith('const') || /^export\s+const/.test(declNode.text);
    if (exported) exports.add(name);
    if (value && (value.type === 'arrow_function' || value.type === 'function_expression' || value.type === 'function' || value.type === 'generator_function')) {
      const sym = fnSymbol(value, name, 'function', parent, modifiersOf(value, exported));
      sym.range = { start: { line: declNode.startPosition.row, col: declNode.startPosition.column }, end: sym.range.end };
      add(sym, parent);
    } else if (value && (value.type === 'class' || value.type === 'class_expression')) {
      add(classSymbol(value, name, parent, exported ? ['export'] : []), parent);
    } else if (!parent) {
      const typeNode = field(d, 'type');
      add(
        b.make(d, isConst ? 'constant' : 'variable', name, parent, {
          modifiers: exported ? ['export'] : undefined,
          detail: typeNode ? clean(typeNode.text.replace(/^:\s*/, ''), 50) : value ? clean(value.text, 50) : undefined,
        }),
        parent,
      );
    }
  };

  const decl = (node: SyntaxNode, parent: CodeSymbol | null, exported: boolean): void => {
    const name = field(node, 'name')?.text;
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'function_signature':
        if (name) {
          if (exported) exports.add(name);
          add(fnSymbol(node, name, 'function', parent, modifiersOf(node, exported)), parent);
        }
        return;
      case 'class_declaration':
      case 'abstract_class_declaration':
        if (name) {
          if (exported) exports.add(name);
          add(classSymbol(node, name, parent, modifiersOf(node, exported)), parent);
        }
        return;
      case 'lexical_declaration':
      case 'variable_declaration':
        for (const d of named(node)) if (d.type === 'variable_declarator') declarator(d, node, parent, exported);
        return;
      case 'interface_declaration': {
        if (!name) return;
        if (exported) exports.add(name);
        const ext = childOfType(node, 'extends_type_clause');
        const sym = b.make(node, 'interface', name, parent, { modifiers: exported ? ['export'] : undefined, bases: ext ? baseNames(ext) : undefined });
        const body = field(node, 'body');
        if (body) {
          for (const m of named(body)) {
            const mn = field(m, 'name')?.text;
            if (!mn) continue;
            if (m.type === 'method_signature') b.make(m, 'method', mn, sym, { signature: b.signature(field(m, 'parameters'), field(m, 'return_type')) });
            else if (m.type === 'property_signature') b.make(m, 'property', mn, sym, { detail: clean(field(m, 'type')?.text?.replace(/^:\s*/, '') ?? '', 50) || undefined });
          }
        }
        add(sym, parent);
        return;
      }
      case 'type_alias_declaration':
        if (name) {
          if (exported) exports.add(name);
          add(b.make(node, 'type', name, parent, { modifiers: exported ? ['export'] : undefined, detail: clean(field(node, 'value')?.text ?? '', 60) }), parent);
        }
        return;
      case 'enum_declaration': {
        if (!name) return;
        if (exported) exports.add(name);
        const sym = b.make(node, 'enum', name, parent, { modifiers: exported ? ['export'] : undefined });
        const body = field(node, 'body');
        if (body) for (const m of named(body)) {
          const mn = m.type === 'enum_assignment' ? field(m, 'name')?.text : m.type === 'property_identifier' ? m.text : undefined;
          if (mn) b.make(m, 'enumMember', mn, sym);
        }
        add(sym, parent);
        return;
      }
      case 'internal_module':
      case 'module': {
        const nm = name ?? 'namespace';
        const sym = b.make(node, 'namespace', clean(nm, 40), parent);
        const body = field(node, 'body');
        if (body) for (const c of named(body)) top(c, sym);
        add(sym, parent);
        return;
      }
      case 'ambient_declaration':
        for (const c of named(node)) decl(c, parent, exported);
        return;
    }
  };

  const top = (node: SyntaxNode, parent: CodeSymbol | null) => {
    switch (node.type) {
      case 'import_statement': {
        const imp = importOf(node);
        if (imp) imports.push(imp);
        return;
      }
      case 'export_statement': {
        const d = field(node, 'declaration');
        if (d) {
          if (hasToken(node, 'default')) exports.add('default');
          decl(d, parent, true);
          return;
        }
        if (field(node, 'source')) {
          const imp = importOf(node);
          if (imp) imports.push(imp);
        }
        const clause = childOfType(node, 'export_clause');
        if (clause) for (const s of named(clause)) exports.add(field(s, 'alias')?.text ?? field(s, 'name')?.text ?? s.text);
        if (hasToken(node, 'default')) {
          exports.add('default');
          const v = field(node, 'value');
          if (v && /class|function|arrow_function/.test(v.type)) {
            const nm = field(v, 'name')?.text ?? 'default';
            if (/class/.test(v.type)) add(classSymbol(v, nm, parent, ['export', 'default']), parent);
            else add(fnSymbol(v, nm, 'function', parent, ['export', 'default']), parent);
          }
        }
        return;
      }
      case 'expression_statement': {
        // module.exports = …, exports.x = …
        const e = named(node)[0];
        if (e?.type === 'assignment_expression') {
          const left = field(e, 'left')?.text ?? '';
          const m = /^(module\.)?exports(\.(\w+))?$/.exec(left);
          if (m) {
            if (m[3]) exports.add(m[3]);
            const right = field(e, 'right');
            if (right?.type === 'object') for (const p of named(right)) exports.add(field(p, 'key')?.text ?? p.text);
            else if (!m[3]) exports.add('default');
          }
        }
        return;
      }
      default:
        decl(node, parent, false);
    }
  };

  for (const c of named(root)) top(c, null);

  // require('x') and import('x') anywhere in the file.
  walk(root, (n) => {
    if (n.type !== 'call_expression') return true;
    const fn = field(n, 'function');
    const args = field(n, 'arguments');
    const first = args ? named(args)[0] : null;
    const src = stringValue(first);
    if (src !== undefined && fn) {
      if (fn.type === 'identifier' && fn.text === 'require') {
        const parent = n.parent;
        let names: ImportRef['names'] = [{ name: '*' }];
        if (parent?.type === 'variable_declarator') {
          const nm = field(parent, 'name');
          if (nm?.type === 'identifier') names = [{ name: 'default', alias: nm.text }];
          else if (nm?.type === 'object_pattern') names = named(nm).map((p) => ({ name: p.text.split(':')[0].trim() }));
        }
        imports.push({ source: src, names, kind: 'require', line: n.startPosition.row });
      } else if (fn.type === 'import') {
        imports.push({ source: src, names: [{ name: '*' }], kind: 'dynamic', line: n.startPosition.row });
      }
    }
    return true;
  });

  imports.sort((a, b2) => a.line - b2.line);
  return { symbols, imports, exports: [...exports] };
}

function lambdaParams(fn: SyntaxNode): string[] {
  const p = field(fn, 'parameters');
  if (p) return paramNames(p, ['this']);
  const single = field(fn, 'parameter');
  return single ? [single.text] : [];
}

function makeSpec(id: string, name: string, grammar: string, extensions: string[]): LanguageSpec {
  return {
    id,
    name,
    grammar,
    extensions,
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    outline: outlineJs,
    functionBody: (fn) => field(fn, 'body'),
    params: (fn) => {
      const p = field(fn, 'parameters');
      if (p) return paramNames(p, ['this']);
      const single = field(fn, 'parameter');
      return single ? [single.text] : [];
    },
    functionTypes: FUNCTION_TYPES,
    decisionTypes: ['if_statement', 'catch_clause', 'ternary_expression'],
    calls: {
      call_expression: { callee: (n) => field(n, 'function') },
      new_expression: { callee: (n) => field(n, 'constructor'), kind: 'new' },
    },
    flow: {
      blocks: ['statement_block'],
      ifs: ['if_statement'],
      elses: ['else_clause'],
      whiles: ['while_statement'],
      doWhiles: ['do_statement'],
      fors: ['for_statement'],
      forEachs: ['for_in_statement'],
      switches: ['switch_statement'],
      tries: ['try_statement'],
      returns: ['return_statement'],
      throws: ['throw_statement'],
      breaks: ['break_statement'],
      continues: ['continue_statement'],
      labeled: ['labeled_statement'],
      definitions: ['function_declaration', 'generator_function_declaration', 'class_declaration'],
      fallthrough: true,
      switchShape: (n) =>
        genericSwitch(n, { subjectFields: ['value'], caseTypes: ['switch_case'], defaultTypes: ['switch_default'], labelFields: ['value'] }),
      tryShape: (n) => genericTry(n, { catchTypes: ['catch_clause'], finallyTypes: ['finally_clause'] }),
    },
    data: {
      assigns: {
        variable_declarator: { target: (n) => field(n, 'name'), value: (n) => field(n, 'value') },
        assignment_expression: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
        augmented_assignment_expression: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
      },
      members: {
        member_expression: { object: 'object', property: 'property' },
        subscript_expression: { object: 'object', property: 'index' },
      },
      identifiers: ['identifier', 'shorthand_property_identifier', 'shorthand_property_identifier_pattern'],
      selfNames: ['this'],
      skip: ['type_annotation', 'type_arguments', 'type_parameters', 'predefined_type', 'string', 'number', 'regex', 'comment', 'property_identifier', 'statement_identifier', 'jsx_closing_element'],
      loopBindings: {
        for_in_statement: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
      },
      scopes: {
        arrow_function: lambdaParams,
        function_expression: lambdaParams,
        function: lambdaParams,
      },
    },
  };
}

export const javascript = makeSpec('javascript', 'JavaScript', 'javascript', ['js', 'jsx', 'mjs', 'cjs']);
export const typescript = makeSpec('typescript', 'TypeScript', 'typescript', ['ts', 'mts', 'cts']);
export const tsx = makeSpec('typescriptreact', 'TypeScript React', 'tsx', ['tsx']);
