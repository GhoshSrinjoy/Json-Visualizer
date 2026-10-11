/** Helpers over tree-sitter nodes shared by every language adapter. */

import type { Range } from './model';
import type { SyntaxNode } from './treesitter';

export function rangeOf(node: SyntaxNode): Range {
  return {
    start: { line: node.startPosition.row, col: node.startPosition.column },
    end: { line: node.endPosition.row, col: node.endPosition.column },
  };
}

export function field(node: SyntaxNode | null | undefined, name: string): SyntaxNode | null {
  return node ? node.childForFieldName(name) : null;
}

export function fields(node: SyntaxNode, name: string): SyntaxNode[] {
  return node.childrenForFieldName(name).filter((n): n is SyntaxNode => !!n && n.isNamed);
}

export function named(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c) out.push(c);
  }
  return out;
}

/** All children (named and anonymous). */
export function kids(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) out.push(c);
  }
  return out;
}

export function isComment(node: SyntaxNode): boolean {
  return node.type.includes('comment');
}

/** Named, non-comment children. */
export function statements(node: SyntaxNode): SyntaxNode[] {
  return named(node).filter((c) => !isComment(c));
}

export function firstOfType(node: SyntaxNode, types: ReadonlySet<string> | string[]): SyntaxNode | null {
  const set = Array.isArray(types) ? new Set(types) : types;
  for (const c of named(node)) if (set.has(c.type)) return c;
  return null;
}

export function childOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const c of named(node)) if (c.type === type) return c;
  return null;
}

export function childrenOfType(node: SyntaxNode, type: string | ReadonlySet<string>): SyntaxNode[] {
  return named(node).filter((c) => (typeof type === 'string' ? c.type === type : type.has(c.type)));
}

/** True if an anonymous child token with this text exists (e.g. `async`, `static`). */
export function hasToken(node: SyntaxNode, token: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.type === token) return true;
  }
  return false;
}

/** Collapses whitespace and trims; keeps the first `max` chars. */
export function clean(text: string, max = 90): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** First line of a node's text, with a marker when there is more. */
export function firstLine(node: SyntaxNode, max = 90): string {
  const t = node.text;
  const nl = t.indexOf('\n');
  if (nl < 0) return clean(t, max);
  const head = clean(t.slice(0, nl), max);
  return head.endsWith('…') ? head : `${head} …`;
}

/** Strips one level of surrounding parentheses. */
export function unparen(text: string): string {
  const t = text.trim();
  if (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') depth--;
      if (depth === 0 && i < t.length - 1) return t; // `(a) && (b)`
    }
    return t.slice(1, -1).trim();
  }
  return t;
}

/** Source text from the start of `node` up to the start of `until` (e.g. a loop header). */
export function headerText(node: SyntaxNode, until: SyntaxNode | null, max = 90): string {
  const text = node.text;
  const cut = until ? until.startIndex - node.startIndex : text.length;
  let h = text.slice(0, Math.max(0, cut));
  h = h.replace(/\s+/g, ' ').trim().replace(/(\{|:|\bdo|\bthen)$/, '').trim();
  return clean(h, max);
}

/** Identifier-like leaf node types across grammars. */
export const NAME_TYPES = new Set([
  'identifier', 'property_identifier', 'field_identifier', 'type_identifier', 'shorthand_property_identifier',
  'name', 'constant', 'simple_identifier', 'namespace_identifier', 'package_identifier', 'variable_name',
  'private_property_identifier', 'statement_identifier', 'scope_resolution', 'self', 'this',
]);

/** Text of a declaration's name: the `name` field, or the first identifier-like child. */
export function nameText(node: SyntaxNode, fieldName = 'name'): string | undefined {
  const n = node.childForFieldName(fieldName);
  if (n) return n.text;
  for (const c of named(node)) if (NAME_TYPES.has(c.type)) return c.text;
  return undefined;
}

/**
 * Doc comment directly above a declaration (JSDoc, ///, #, --) — first
 * sentence/line only. Skips decorators/attributes in between.
 */
export function docComment(node: SyntaxNode): string | undefined {
  // The comment usually precedes the outermost wrapper (`export function …`,
  // `const f = () => …`, decorated definitions), so try those too.
  for (let target: SyntaxNode | null = node; target; target = target.parent) {
    const doc = commentBefore(target);
    if (doc !== undefined) return doc;
    if (!target.parent || !DOC_WRAPPERS.has(target.parent.type)) return undefined;
  }
  return undefined;
}

const DOC_WRAPPERS = new Set([
  'export_statement', 'decorated_definition', 'ambient_declaration', 'lexical_declaration', 'variable_declaration',
  'variable_declarator', 'public_field_definition', 'field_definition', 'pair', 'assignment_expression',
  'expression_statement', 'attribute_item', 'declaration', 'template_declaration', 'field_declaration',
]);

function commentBefore(node: SyntaxNode): string | undefined {
  let prev = node.previousNamedSibling;
  while (prev && /decorator|attribute_item|attribute_list|annotation|marker_annotation/.test(prev.type)) prev = prev.previousNamedSibling;
  if (!prev || !isComment(prev)) return undefined;
  if (node.startPosition.row - prev.endPosition.row > 1) return undefined;
  // Gather a contiguous run of line comments ending at `prev`.
  const parts = [prev.text];
  let p = prev.previousNamedSibling;
  while (p && isComment(p) && prev.startPosition.row - p.endPosition.row <= 1 && parts.length < 30) {
    parts.unshift(p.text);
    prev = p;
    p = p.previousNamedSibling;
  }
  return summarizeComment(parts.join('\n'));
}

export function summarizeComment(raw: string): string | undefined {
  const lines = raw
    .split('\n')
    .map((l) =>
      l
        .replace(/^\s*(\/\*\*?|\*\/|\*|\/\/\/?|#+|--|""")/, '')
        .replace(/\*\/\s*$/, '')
        .trim(),
    )
    .filter((l) => l && !l.startsWith('@') && !/^-+$/.test(l));
  if (!lines.length) return undefined;
  const first = lines.join(' ').split(/(?<=[.!?])\s/)[0];
  return clean(first, 140);
}

/** Collapsed text of a parameter list, e.g. `(a: string, b = 1)`. */
export function paramsText(node: SyntaxNode | null, max = 120): string {
  if (!node) return '()';
  const t = clean(node.text, max);
  return t.startsWith('(') ? t : `(${t})`;
}

/** Visits descendants depth-first; return false from `visit` to skip a subtree. */
export function walk(node: SyntaxNode, visit: (n: SyntaxNode) => boolean | void): void {
  const cursor = node.walk();
  let depth = 0;
  for (;;) {
    const descend = visit(cursor.currentNode) !== false;
    if (descend && cursor.gotoFirstChild()) {
      depth++;
      continue;
    }
    // Climb until a next sibling exists, never leaving the starting node.
    for (;;) {
      if (depth === 0) {
        cursor.delete();
        return;
      }
      if (cursor.gotoNextSibling()) break;
      cursor.gotoParent();
      depth--;
    }
  }
}

/** Counts syntax errors (ERROR and MISSING nodes). */
export function countErrors(root: SyntaxNode, limit = 1000): number {
  if (!root.hasError) return 0;
  let n = 0;
  walk(root, (c) => {
    if (n >= limit) return false;
    if (c.isError || c.isMissing) n++;
    return c.hasError;
  });
  return n;
}
