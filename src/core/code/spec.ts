/** The contract every language adapter implements, plus shared helpers. */

import type { FlowRules } from './ir';
import type { CallRef, CodeSymbol, ImportRef, SymbolKind } from './model';
import { NAME_TYPES, clean, docComment, field, named, paramsText, rangeOf, walk } from './syntax';
import type { SyntaxNode } from './treesitter';

export interface CallShape {
  callee: (node: SyntaxNode) => SyntaxNode | null;
  args?: (node: SyntaxNode) => SyntaxNode | null;
  kind?: 'new' | 'macro';
  /** Fixed name/receiver extraction for grammars where callee fields differ (Java/Ruby/PHP). */
  name?: (node: SyntaxNode) => { name: string; receiver?: string } | null;
}

export interface AssignShape {
  target: (node: SyntaxNode) => SyntaxNode | null;
  value: (node: SyntaxNode) => SyntaxNode | null;
}

export interface DataRules {
  /** Assignment and declarator nodes. */
  assigns: Record<string, AssignShape>;
  /** Member access nodes: object part and property part. */
  members: Record<string, { object: string; property: string }>;
  /** Identifier node types that can name a variable. */
  identifiers: string[];
  /** `this` / `self` / `$this` spellings. */
  selfNames: string[];
  /** Subtrees that never contain variable reads (types, keys, attribute names…). */
  skip: string[];
  /** Loop binding: `for target in source`. */
  loopBindings?: Record<string, AssignShape>;
  /** Fields of compound statements that hold nested statements (not header expressions). */
  bodyFields?: string[];
  /**
   * Expression scopes (lambdas, comprehensions): names they bind are hidden
   * while their body is analysed, so only free variables produce flows.
   */
  scopes?: Record<string, (node: SyntaxNode) => string[]>;
}

export interface OutlineParts {
  symbols: CodeSymbol[];
  imports: ImportRef[];
  exports: string[];
}

export interface LanguageSpec {
  id: string;
  name: string;
  grammar: string;
  extensions: string[];
  fileNames?: string[];
  lineComment: string[];
  blockComment?: [string, string];
  outline(root: SyntaxNode, b: SymbolBuilder): OutlineParts;
  /** Function body node for flow analysis. */
  functionBody(fn: SyntaxNode): SyntaxNode | null;
  /** Parameter names of a function node. */
  params(fn: SyntaxNode): string[];
  flow: FlowRules;
  data: DataRules;
  calls: Record<string, CallShape>;
  /** Node types that start a new function scope (calls/identifiers inside are not attributed to the parent). */
  functionTypes: string[];
  /** Node types that add a decision point for complexity. */
  decisionTypes: string[];
}

/**
 * Builds CodeSymbol objects and remembers their syntax nodes (needed later to
 * compute flow graphs for a selected function).
 */
export class SymbolBuilder {
  readonly nodes = new Map<string, SyntaxNode>();
  private readonly usedIds = new Set<string>();
  private readonly fnTypes: Set<string>;
  private readonly decisionTypes: Set<string>;

  constructor(readonly spec: LanguageSpec) {
    this.fnTypes = new Set(spec.functionTypes);
    this.decisionTypes = new Set(spec.decisionTypes);
  }

  make(
    node: SyntaxNode,
    kind: SymbolKind,
    name: string,
    parent: CodeSymbol | null,
    extra: Partial<CodeSymbol> = {},
  ): CodeSymbol {
    const base = parent ? `${parent.id}.${name}` : name;
    let id = base;
    if (this.usedIds.has(id)) id = `${base}@${node.startPosition.row + 1}`;
    for (let k = 2; this.usedIds.has(id); k++) id = `${base}@${node.startPosition.row + 1}#${k}`;
    this.usedIds.add(id);
    const nameNode = field(node, 'name');
    const sym: CodeSymbol = {
      id,
      name,
      kind,
      range: rangeOf(node),
      nameRange: nameNode ? rangeOf(nameNode) : undefined,
      ...extra,
    };
    if (sym.doc === undefined) {
      const d = docComment(node);
      if (d) sym.doc = d;
    }
    this.nodes.set(id, node);
    if (parent) (parent.children ??= []).push(sym);
    return sym;
  }

  /** Fills calls, complexity and params for a callable symbol. */
  callable(sym: CodeSymbol, node: SyntaxNode): CodeSymbol {
    const body = this.spec.functionBody(node);
    sym.hasBody = !!body;
    sym.params = this.spec.params(node);
    if (body) {
      sym.calls = collectCalls(body, this.spec, this.fnTypes);
      sym.complexity = complexity(body, this.decisionTypes, this.fnTypes);
    }
    return sym;
  }

  signature(params: SyntaxNode | null, returns?: SyntaxNode | null, sep = ': '): string {
    const p = paramsText(params);
    if (!returns) return p;
    const r = clean(returns.text.replace(/^(->|:)\s*/, ''), 60);
    return `${p}${sep}${r}`;
  }
}

// ---------------------------------------------------------------- calls

export function calleeName(node: SyntaxNode | null): { name: string; receiver?: string } | null {
  if (!node) return null;
  if (NAME_TYPES.has(node.type) || node.type === 'super') return { name: node.text };
  const prop =
    field(node, 'property') ?? field(node, 'field') ?? field(node, 'attribute') ?? field(node, 'name') ?? field(node, 'method');
  const obj =
    field(node, 'object') ?? field(node, 'operand') ?? field(node, 'value') ?? field(node, 'argument') ??
    field(node, 'expression') ?? field(node, 'scope') ?? field(node, 'path') ?? field(node, 'receiver');
  if (prop && NAME_TYPES.has(prop.type)) return { name: prop.text, receiver: obj ? clean(obj.text, 40) : undefined };
  if (node.type === 'generic_name' || node.type === 'generic_function' || node.type === 'template_function') {
    const inner = field(node, 'function') ?? field(node, 'name') ?? named(node)[0];
    if (inner && inner.id !== node.id) return calleeName(inner);
  }
  // Fallback: last identifier-like descendant.
  let last: SyntaxNode | null = null;
  walk(node, (n) => {
    if (NAME_TYPES.has(n.type)) last = n;
  });
  if (!last) return null;
  const l = last as SyntaxNode;
  const recv = node.text.slice(0, l.startIndex - node.startIndex).replace(/(\?\.|\.|::|->)$/, '');
  return { name: l.text, receiver: recv ? clean(recv, 40) : undefined };
}

export function callInfo(node: SyntaxNode, spec: LanguageSpec): (CallRef & { argsNode: SyntaxNode | null }) | null {
  const shape = spec.calls[node.type];
  if (!shape) return null;
  const info = shape.name ? shape.name(node) : calleeName(shape.callee(node));
  if (!info || !info.name) return null;
  return {
    name: info.name,
    receiver: info.receiver,
    line: node.startPosition.row,
    kind: shape.kind,
    argsNode: shape.args ? shape.args(node) : field(node, 'arguments'),
  };
}

/** Calls inside `body`, not descending into nested functions. */
export function collectCalls(body: SyntaxNode, spec: LanguageSpec, fnTypes: Set<string>): CallRef[] {
  const out: CallRef[] = [];
  walk(body, (n) => {
    if (n.id !== body.id && fnTypes.has(n.type)) return false;
    if (spec.calls[n.type]) {
      const c = callInfo(n, spec);
      if (c) out.push({ name: c.name, receiver: c.receiver, line: c.line, kind: c.kind });
    }
    return true;
  });
  return out;
}

const BOOL_TOKENS = new Set(['&&', '||', 'and', 'or', '??']);

export function complexity(body: SyntaxNode, decisionTypes: Set<string>, fnTypes: Set<string>): number {
  let c = 1;
  walk(body, (n) => {
    if (n.id !== body.id && fnTypes.has(n.type)) return false;
    if (n.isNamed) {
      if (decisionTypes.has(n.type)) c++;
    } else if (BOOL_TOKENS.has(n.type)) c++;
    return true;
  });
  return c;
}

// ---------------------------------------------------------------- params

const TYPE_FIELDS = new Set(['type', 'value', 'default_value', 'default', 'return_type', 'annotation']);

/**
 * Generic parameter-name extraction: identifier leaves of the parameter list
 * that are not inside type annotations or default values.
 */
export function paramNames(paramsNode: SyntaxNode | null, selfNames: string[] = []): string[] {
  if (!paramsNode) return [];
  const out: string[] = [];
  const visit = (n: SyntaxNode) => {
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (!c || !c.isNamed) continue;
      const f = n.fieldNameForChild(i);
      if (f && TYPE_FIELDS.has(f)) continue;
      if (/type|annotation|decorator|attribute|modifier/.test(c.type) && c.type !== 'typed_parameter' && c.type !== 'typed_default_parameter') continue;
      if (c.type === 'identifier' || c.type === 'variable_name' || c.type === 'simple_identifier') {
        const name = c.text.replace(/^\$/, '');
        if (!selfNames.includes(c.text) && !selfNames.includes(name)) out.push(name);
        continue;
      }
      if (c.type === 'self_parameter' || c.type === 'self') continue;
      visit(c);
    }
  };
  visit(paramsNode);
  return [...new Set(out)];
}

/** Text of base types listed in a heritage/superclass node. */
export function baseNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  const out: string[] = [];
  const visit = (n: SyntaxNode) => {
    for (const c of named(n)) {
      if (/^(identifier|type_identifier|constant|scoped_identifier|qualified_name|qualified_identifier|scope_resolution|name|generic_type|generic_name|member_expression|attribute|dotted_name|scoped_type_identifier|nested_identifier|simple_identifier|template_type)$/.test(c.type)) {
        out.push(clean(c.text, 50));
      } else if (!/arguments|keyword_argument|access_specifier|modifier/.test(c.type)) visit(c);
    }
  };
  visit(node);
  return [...new Set(out)];
}
