/** Language-neutral models produced by code analysis (all positions 0-based, UTF-16). */

export interface Pos {
  line: number;
  col: number;
}

export interface Range {
  start: Pos;
  end: Pos;
}

export type SymbolKind =
  | 'module'
  | 'namespace'
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'impl'
  | 'type'
  | 'function'
  | 'method'
  | 'constructor'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'enumMember'
  | 'macro';

export const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set(['function', 'method', 'constructor']);
export const CONTAINER_KINDS: ReadonlySet<SymbolKind> = new Set([
  'module', 'namespace', 'class', 'interface', 'struct', 'enum', 'trait', 'impl',
]);

export interface CallRef {
  /** Callee name (last segment), e.g. `push` for `result.push(x)`. */
  name: string;
  /** Receiver text, e.g. `result`, `this`, `fmt`. */
  receiver?: string;
  line: number;
  /** Constructor call (`new X()`, `X{}` composite) or macro. */
  kind?: 'new' | 'macro';
}

export interface CodeSymbol {
  /** Stable id within the file, e.g. `User.describe` (suffixed `@line` on collisions). */
  id: string;
  name: string;
  kind: SymbolKind;
  range: Range;
  nameRange?: Range;
  /** Parameters and return type, e.g. `(file: string, limit = 10): Promise<User[]>`. */
  signature?: string;
  /** Short extra description, e.g. `impl Greeter for User`. */
  detail?: string;
  modifiers?: string[];
  /** Base classes / implemented interfaces / traits. */
  bases?: string[];
  /** First line of the doc comment or docstring. */
  doc?: string;
  children?: CodeSymbol[];
  params?: string[];
  /** Callables: approximate cyclomatic complexity. */
  complexity?: number;
  /** Callables: outgoing calls. */
  calls?: CallRef[];
  /** Callables with a body can be shown as a flow graph. */
  hasBody?: boolean;
}

export type ImportKind = 'import' | 'require' | 'include' | 'use' | 'using' | 'dynamic' | 'export-from' | 'mod';

export interface ImportRef {
  /** Module specifier / path / namespace as written. */
  source: string;
  /** Imported bindings (`*` for namespace/wildcard imports, `default` for default imports). */
  names: { name: string; alias?: string }[];
  kind: ImportKind;
  line: number;
  /** Python-style relative depth (number of leading dots) when relevant. */
  relative?: number;
}

export interface CodeOutline {
  path: string;
  /** Language id, e.g. `typescript`. */
  language: string;
  languageName: string;
  lines: number;
  /** Non-blank, non-comment-only lines (approximate). */
  loc: number;
  imports: ImportRef[];
  exports: string[];
  symbols: CodeSymbol[];
  /** Syntax error nodes found by the parser. */
  syntaxErrors: number;
  parseMs: number;
  /** True when produced by the regex fallback (no grammar available). */
  approximate?: boolean;
}

// ---------------------------------------------------------------- control flow

export type FlowNodeKind =
  | 'start'
  | 'end'
  | 'block'
  | 'decision'
  | 'loop'
  | 'switch'
  | 'return'
  | 'throw'
  | 'jump'
  | 'try'
  | 'catch'
  | 'finally'
  | 'merge';

export type FlowEdgeKind = 'normal' | 'true' | 'false' | 'back' | 'exception' | 'break' | 'continue' | 'case' | 'return';

export interface FlowNode {
  id: number;
  kind: FlowNodeKind;
  /** Main label (condition, statement text…). */
  label: string;
  /** Statements in a block node. */
  lines?: string[];
  range?: Range;
  /** Not reachable from the start node. */
  unreachable?: boolean;
  /** Notable effects inside the node: calls made, awaits, yields. */
  tags?: string[];
}

export interface FlowEdge {
  from: number;
  to: number;
  label?: string;
  kind: FlowEdgeKind;
}

export interface FlowGraph {
  /** Function display name. */
  name: string;
  symbolId: string;
  signature?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Cyclomatic complexity (decisions + 1). */
  complexity: number;
  range: Range;
}

// ---------------------------------------------------------------- data flow

export type DataNodeKind = 'param' | 'local' | 'return' | 'call' | 'external' | 'field';

export interface DataNode {
  id: string;
  kind: DataNodeKind;
  label: string;
  /** Lines (0-based) where the value is assigned. */
  defs: number[];
  /** Lines (0-based) where the value is read. */
  uses: number[];
}

export type DataEdgeKind = 'assign' | 'arg' | 'return' | 'condition' | 'iterate' | 'mutate' | 'result';

export interface DataEdge {
  from: string;
  to: string;
  kind: DataEdgeKind;
  lines: number[];
}

export interface DataFlowGraph {
  name: string;
  symbolId: string;
  nodes: DataNode[];
  edges: DataEdge[];
  range: Range;
}

// ---------------------------------------------------------------- call graph

export interface CallGraphNode {
  id: string;
  name: string;
  kind: SymbolKind | 'external';
  /** File path (absent for external callees). */
  file?: string;
  /** Enclosing class/module name. */
  container?: string;
  line?: number;
  /** Number of incoming edges. */
  callers: number;
}

export interface CallGraphEdge {
  from: string;
  to: string;
  count: number;
  /** exact: same scope or explicit import; likely: unique name match; guess: ambiguous. */
  confidence: 'exact' | 'likely' | 'guess';
}

export interface CallGraph {
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
  /** Files that were analysed. */
  files: string[];
}

/** Flow and data flow of one function (or of a file's top-level code). */
export interface FunctionAnalysis {
  symbol: CodeSymbol;
  flow: FlowGraph;
  data: DataFlowGraph;
}
