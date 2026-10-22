/** Python. */

import { genericSwitch, genericTry } from '../ir';
import type { CodeSymbol, ImportRef, SymbolKind } from '../model';
import { baseNames, paramNames, type LanguageSpec, type OutlineParts, type SymbolBuilder } from '../spec';
import { childOfType, clean, field, fields, hasToken, named, rangeOf, summarizeComment } from '../syntax';
import type { SyntaxNode } from '../treesitter';

const SELF = ['self', 'cls'];

function docstring(body: SyntaxNode | null): string | undefined {
  const first = body ? named(body)[0] : null;
  if (first?.type !== 'expression_statement') return undefined;
  const s = named(first)[0];
  if (s?.type !== 'string') return undefined;
  return summarizeComment(s.text.replace(/^[rRbBuUfF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, ''));
}

function nameRangeOf(node: SyntaxNode) {
  const n = field(node, 'name');
  return n ? rangeOf(n) : undefined;
}

function dottedText(n: SyntaxNode | null): string {
  return n ? n.text.replace(/\s+/g, '') : '';
}

function importsOf(node: SyntaxNode): ImportRef[] {
  const line = node.startPosition.row;
  if (node.type === 'import_statement') {
    return fields(node, 'name').map((n) => {
      if (n.type === 'aliased_import') return { source: dottedText(field(n, 'name')), names: [{ name: '*', alias: field(n, 'alias')?.text }], kind: 'import' as const, line };
      return { source: dottedText(n), names: [{ name: '*' }], kind: 'import' as const, line };
    });
  }
  if (node.type === 'import_from_statement') {
    const mod = field(node, 'module_name');
    let source = '';
    let relative = 0;
    if (mod?.type === 'relative_import') {
      const prefix = childOfType(mod, 'import_prefix');
      relative = prefix ? prefix.text.length : 0;
      source = '.'.repeat(relative) + dottedText(childOfType(mod, 'dotted_name'));
    } else source = dottedText(mod);
    const names: ImportRef['names'] = childOfType(node, 'wildcard_import')
      ? [{ name: '*' }]
      : fields(node, 'name').map((n) =>
          n.type === 'aliased_import' ? { name: dottedText(field(n, 'name')), alias: field(n, 'alias')?.text } : { name: dottedText(n) },
        );
    return [{ source, names, kind: 'import', line, relative: relative || undefined }];
  }
  return [];
}

export function outlinePython(root: SyntaxNode, b: SymbolBuilder): OutlineParts {
  const symbols: CodeSymbol[] = [];
  const imports: ImportRef[] = [];
  let exports: string[] | undefined;

  const visit = (container: SyntaxNode, parent: CodeSymbol | null, decorators: string[] = []) => {
    for (const node of named(container)) {
      switch (node.type) {
        case 'import_statement':
        case 'import_from_statement':
          if (!parent) imports.push(...importsOf(node));
          break;
        case 'decorated_definition': {
          const decos = named(node)
            .filter((d) => d.type === 'decorator')
            .map((d) => clean(d.text.replace(/^@/, ''), 40));
          const def = field(node, 'definition');
          if (def) visitDef(def, parent, decos, node);
          break;
        }
        case 'function_definition':
        case 'class_definition':
          visitDef(node, parent, decorators, node);
          break;
        case 'expression_statement': {
          const a = named(node)[0];
          if (a?.type !== 'assignment') break;
          const left = field(a, 'left');
          if (left?.type !== 'identifier') break;
          const name = left.text;
          if (!parent && name === '__all__') {
            const right = field(a, 'right');
            exports = right ? named(right).filter((s) => s.type === 'string').map((s) => s.text.slice(1, -1)) : [];
          }
          const isClass = parent && parent.kind === 'class';
          if (!parent || isClass) {
            const kind: SymbolKind = isClass ? 'field' : /^[A-Z][A-Z0-9_]*$/.test(name) ? 'constant' : 'variable';
            const type = field(a, 'type');
            const right = field(a, 'right');
            const sym = b.make(a, kind, name, parent, { detail: type ? clean(type.text, 40) : right ? clean(right.text, 50) : undefined });
            if (!parent) symbols.push(sym);
          }
          break;
        }
        case 'if_statement':
          // Module-level `if TYPE_CHECKING:` / platform guards can define symbols.
          if (!parent) {
            const cons = field(node, 'consequence');
            if (cons && !/__name__/.test(field(node, 'condition')?.text ?? '')) visit(cons, parent);
          }
          break;
        case 'try_statement':
          if (!parent) {
            const body = field(node, 'body');
            if (body) visit(body, parent);
          }
          break;
      }
    }
  };

  const visitDef = (node: SyntaxNode, parent: CodeSymbol | null, decorators: string[], outer: SyntaxNode) => {
    const name = field(node, 'name')?.text;
    if (!name) return;
    const body = field(node, 'body');
    const mods = [...decorators];
    if (hasToken(node, 'async')) mods.unshift('async');
    if (name.startsWith('_') && !name.startsWith('__')) mods.push('private');
    if (node.type === 'class_definition') {
      const supers = field(node, 'superclasses');
      const bases = baseNames(supers).filter((x) => !x.includes('='));
      const sym = b.make(outer, 'class', name, parent, {
        nameRange: nameRangeOf(node),
        bases: bases.length ? bases : undefined,
        modifiers: mods.length ? mods : undefined,
        doc: docstring(body),
      });
      b.nodes.set(sym.id, node);
      if (!parent) symbols.push(sym);
      if (body) visit(body, sym);
      return;
    }
    const inClass = parent?.kind === 'class';
    let kind: SymbolKind = inClass ? 'method' : 'function';
    if (inClass && name === '__init__') kind = 'constructor';
    if (decorators.some((d) => d === 'property' || d.endsWith('.setter') || d.endsWith('.getter'))) kind = 'property';
    const sym = b.make(outer, kind, name, parent, {
      nameRange: nameRangeOf(node),
      signature: b.signature(field(node, 'parameters'), field(node, 'return_type'), ' -> '),
      modifiers: mods.length ? mods : undefined,
      doc: docstring(body),
    });
    b.nodes.set(sym.id, node);
    b.callable(sym, node);
    if (!parent) symbols.push(sym);
    // Nested functions/classes.
    if (body) {
      for (const c of named(body)) {
        if (c.type === 'function_definition' || c.type === 'class_definition') visitDef(c, sym, [], c);
        else if (c.type === 'decorated_definition') {
          const def = field(c, 'definition');
          if (def) visitDef(def, sym, [], c);
        }
      }
    }
  };

  visit(root, null);
  return { symbols, imports, exports: exports ?? symbols.filter((s) => !s.name.startsWith('_')).map((s) => s.name) };
}

export const python: LanguageSpec = {
  id: 'python',
  name: 'Python',
  grammar: 'python',
  extensions: ['py', 'pyw', 'pyi'],
  fileNames: ['SConstruct', 'SConscript'],
  lineComment: ['#'],
  outline: outlinePython,
  functionBody: (fn) => field(fn, 'body'),
  params: (fn) => paramNames(field(fn, 'parameters'), SELF),
  functionTypes: ['function_definition', 'class_definition', 'lambda'],
  decisionTypes: ['if_statement', 'elif_clause', 'except_clause', 'except_group_clause', 'conditional_expression', 'if_clause'],
  // `if_clause` is a comprehension filter, or the guard of a `case` (part of that case).
  decisionWeight: (n) => (n.type === 'if_clause' && n.parent?.type === 'case_clause' ? 0 : 1),
  calls: {
    call: { callee: (n) => field(n, 'function') },
  },
  flow: {
    blocks: ['block'],
    ifs: ['if_statement'],
    elifs: ['elif_clause'],
    elses: ['else_clause'],
    whiles: ['while_statement'],
    forEachs: ['for_statement'],
    fors: [],
    switches: ['match_statement'],
    tries: ['try_statement'],
    returns: ['return_statement'],
    throws: ['raise_statement'],
    breaks: ['break_statement'],
    continues: ['continue_statement'],
    withs: ['with_statement'],
    definitions: ['function_definition', 'class_definition', 'decorated_definition'],
    fallthrough: false,
    switchShape: (n) =>
      genericSwitch(n, { subjectFields: ['subject'], caseTypes: ['case_clause'], labelTypes: ['case_pattern'], labelFields: ['guard'] }),
    tryShape: (n) => genericTry(n, { catchTypes: ['except_clause', 'except_group_clause'], finallyTypes: ['finally_clause'], elseTypes: ['else_clause'] }),
  },
  data: {
    assigns: {
      assignment: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
      augmented_assignment: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
      named_expression: { target: (n) => field(n, 'name'), value: (n) => field(n, 'value') },
      // `with open(p) as fh`
      as_pattern: { target: (n) => field(n, 'alias'), value: (n) => named(n)[0] ?? null },
    },
    members: {
      attribute: { object: 'object', property: 'attribute' },
      subscript: { object: 'value', property: 'subscript' },
    },
    identifiers: ['identifier'],
    selfNames: SELF,
    skip: ['type', 'comment', 'decorator'],
    loopBindings: {
      for_statement: { target: (n) => field(n, 'left'), value: (n) => field(n, 'right') },
    },
    scopes: {
      lambda: (n) => paramNames(field(n, 'parameters'), SELF),
      list_comprehension: comprehensionNames,
      set_comprehension: comprehensionNames,
      dictionary_comprehension: comprehensionNames,
      generator_expression: comprehensionNames,
    },
  },
};

function comprehensionNames(n: SyntaxNode): string[] {
  const out: string[] = [];
  for (const c of named(n)) {
    if (c.type !== 'for_in_clause') continue;
    const left = field(c, 'left');
    if (!left) continue;
    if (left.type === 'identifier') out.push(left.text);
    else for (const id of named(left)) if (id.type === 'identifier') out.push(id.text);
  }
  return out;
}
