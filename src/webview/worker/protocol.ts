/** Messages between the UI thread and the data worker. */

import type { DataFormat, TypeName } from '../../core/data/tree';

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
  errors: { line: number; col: number; message: string; offset: number }[];
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
  search(args: { query: string; regex?: boolean; caseSensitive?: boolean; keys?: boolean; values?: boolean; limit?: number }): { hits: { id: number; in: 'key' | 'value' }[]; truncated: boolean; error?: string };
  query(args: { query: string; limit: number }): { ids: number[]; total: number; error?: string };
  schema(args: { id: number }): SchemaView;
  exportSchema(args: { id: number; kind: 'json-schema' | 'typescript' | 'text' }): string;
  tableInfo(args: { id: number; auto?: boolean }): TableInfo;
  tableRows(args: { id: number; start: number; count: number; columns: string[]; sort?: { column: string; desc: boolean } | null; filter?: string }): { rows: TableRowData[]; total: number };
  nodeAtOffset(args: { offset: number }): number;
  nodeAtLine(args: { line: number; col: number }): number;
  json(args: { id: number; indent?: number; maxChars: number }): string;
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
