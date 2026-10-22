/** Messages between the UI thread and the data worker. */

import type { DiffKind, DiffStats } from '../../core/data/diff';
import type { EditCaps, EditOp } from '../../core/data/edit';
import type { ConvertTarget, TypeTarget } from '../../core/data/targets';
import type { SourceEdit } from '../../shared/protocol';
import type { DataFormat, PathSegment, TypeName } from '../../core/data/tree';

export interface Summary {
  name: string;
  format: DataFormat;
  bytes: number;
  nodes: number;
  root: number;
  rootType: TypeName;
  maxDepth: number;
  lines: number;
  parseMs: number;
  /** Parse issues; `severity` is absent for errors. */
  errors: { line: number; col: number; message: string; offset: number; severity?: 'error' | 'warning' }[];
  typeCounts: Record<string, number>;
  /** XML/HTML trees use element semantics. */
  xml: boolean;
}

export interface NodeInfo {
  id: number;
  key: string | number | null;
  type: TypeName;
  preview: string;
  count: number;
  /** XML attribute / text / element markers. */
  attr?: boolean;
  text?: boolean;
  element?: boolean;
  error?: boolean;
  /** XML element with only text: shown inline as `tag: text`. */
  inline?: string;
}

export interface CardData extends NodeInfo {
  rows: NodeInfo[];
  /** Children beyond `rows`. */
  more: number;
}

export interface NodeDetail extends NodeInfo {
  path: string;
  segments: (string | number)[];
  depth: number;
  /** Full (but capped) value / JSON text. */
  value: string;
  valueTruncated: boolean;
  start?: { line: number; col: number; offset: number };
  end?: { line: number; col: number; offset: number };
  descendants: number;
  parent: number;
}

export interface TableInfo {
  id: number;
  /** JSONPath of the container shown. */
  path: string;
  rows: number;
  columns: string[];
  /** True when the container is an array of objects (or CSV rows). */
  tabular: boolean;
}

export interface TableCell {
  id: number;
  type: TypeName;
  preview: string;
  count: number;
}

export interface TableRowData {
  index: number;
  id: number;
  cells: (TableCell | null)[];
}

/** Schema with Maps converted to arrays for structured cloning. */
export interface SchemaView {
  count: number;
  objects: number;
  types: Partial<Record<TypeName, number>>;
  typeText: string;
  fields?: { key: string; schema: SchemaView; optional: boolean; presence: number }[];
  mapOf?: SchemaView;
  mapKeys?: number;
  items?: SchemaView;
  minItems?: number;
  maxItems?: number;
  examples: string[];
  enumValues?: string[];
  format?: string;
  min?: number;
  max?: number;
  attr?: boolean;
  text?: boolean;
}

/** One line of a diff, in document order (`span` rows below it belong to it). */
export interface DiffRow {
  kind: DiffKind;
  depth: number;
  key: string | number | null;
  path: string;
  /** Node ids in the compared document (left) and this document (right), or -1. */
  left: number;
  right: number;
  before?: string;
  beforeType?: TypeName;
  after?: string;
  afterType?: TypeName;
  span: number;
  /** Unchanged children not listed. */
  unchanged?: number;
  /** Moved array elements: the index in the compared document. */
  fromKey?: string | number | null;
}

export interface DiffView {
  rows: DiffRow[];
  stats: DiffStats;
  truncated: boolean;
  ms: number;
  /** The documents are equal. */
  same: boolean;
}

export interface ValidationView {
  valid: boolean;
  errors: { id: number; path: string; keyword: string; message: string }[];
  /** Stopped at the error limit. */
  truncated: boolean;
  /** Schema keywords that are not checked. */
  unsupported: string[];
  /** `$ref`'d documents that were not supplied (fetch them and validate again). */
  missing: string[];
}

export interface DiffArgs {
  arrays?: 'auto' | 'index' | 'lcs';
  ignoreOrder?: boolean;
}

export interface WorkerApi {
  load(args: { bytes?: ArrayBuffer; text?: string; format?: DataFormat; name: string }): Summary | Promise<Summary>;
  summary(): Summary;
  node(args: { id: number }): NodeInfo;
  children(args: { id: number; offset: number; limit: number }): NodeInfo[];
  cards(args: { ids: number[]; rowLimit: number; rowLimits?: Record<number, number> }): CardData[];
  /** Breadth-first expansion from the root within a card budget. */
  initial(args: { depth: number; budget: number; rowLimit: number }): { expanded: number[]; cards: CardData[] };
  /** All container descendants of `id` up to depth/budget (for "expand all"). */
  expandAll(args: { id: number; depth: number; budget: number; rowLimit: number }): { expanded: number[]; cards: CardData[] };
  detail(args: { id: number; maxChars: number }): NodeDetail;
  ancestors(args: { id: number }): number[];
  search(args: { query: string; regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; keys?: boolean; values?: boolean; limit?: number }): { hits: { id: number; in: 'key' | 'value' }[]; truncated: boolean; error?: string };
  query(args: { query: string; limit: number }): { ids: number[]; total: number; error?: string };
  schema(args: { id: number }): SchemaView;
  exportSchema(args: { id: number; kind: 'json-schema' | 'typescript' | 'text' }): string;
  tableInfo(args: { id: number; auto?: boolean }): TableInfo;
  tableRows(args: { id: number; start: number; count: number; columns: string[]; sort?: { column: string; desc: boolean } | null; filter?: string }): { rows: TableRowData[]; total: number };
  /** Path segments of nodes, to find them again after the document is re-parsed. */
  pathsOf(args: { ids: number[] }): PathSegment[][];
  /** Node ids for path segments (-1 where the path no longer exists). */
  idsOf(args: { paths: PathSegment[][] }): number[];
  nodeAtOffset(args: { offset: number }): number;
  nodeAtLine(args: { line: number; col: number }): number;
  json(args: { id: number; indent?: number; maxChars: number }): string;
  /** Type declarations for a subtree, from its inferred schema. */
  types(args: { id: number; target: TypeTarget; rootName?: string }): string;
  /** The document's own schema reference (`$schema`, or a YAML modeline). */
  schemaRef(): string | null;
  /** Validates the document against a schema (JSON or YAML text); `refs` holds fetched `$ref` documents by URI. */
  validate(args: { schema: string; refs: Record<string, string> }): ValidationView;
  /** Loads the document to compare with (the left side; the main document is the right side). */
  loadOther(args: { bytes?: ArrayBuffer; text?: string; format?: DataFormat; name: string }): Promise<{ name: string; format: DataFormat; nodes: number; errors: number }>;
  clearOther(): void;
  diff(args: DiffArgs): DiffView;
  /** The diff as compact text (for copying, or for AI agents). */
  diffText(args: DiffArgs): string;
  /** What can be changed about a node from the visualizer. */
  editCaps(args: { id: number }): EditCaps;
  /** Source edits for a change (throws EditError with a readable message). */
  edits(args: { op: EditOp }): SourceEdit[];
  /** The subtree in another format (YAML, TOML, CSV, TSV, XML, JSON Lines). */
  convert(args: { id: number; to: ConvertTarget }): string;
  text(args: { maxChars: number }): { text: string; truncated: boolean };
}

export type WorkerMethod = keyof WorkerApi;

export interface WorkerRequest {
  id: number;
  method: WorkerMethod;
  args: unknown;
}

export interface WorkerResponse {
  id: number;
  result?: unknown;
  error?: string;
}
