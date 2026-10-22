/** Renderable scene: positioned nodes (cards and shapes) and routed edges. */

export type Shape = 'card' | 'pill' | 'diamond' | 'hexagon' | 'stadium' | 'circle' | 'parallelogram' | 'note';

/** Semantic color names resolved through the theme. */
export type ColorName =
  | 'accent' | 'muted' | 'faint' | 'text' | 'key'
  | 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'
  | 'class' | 'function' | 'method' | 'interface' | 'variable' | 'module' | 'type' | 'enum' | 'field'
  | 'decision' | 'loop' | 'return' | 'throw' | 'start' | 'jump' | 'try' | 'block'
  | 'param' | 'local' | 'call' | 'external' | 'danger' | 'warn' | 'ok' | 'dir' | 'file';

export interface Row {
  key?: string;
  value?: string;
  keyColor?: ColorName;
  valueColor?: ColorName;
  /** Small leading glyph/marker text (e.g. a kind letter). */
  icon?: string;
  iconColor?: ColorName;
  /** Child node key this row links to (draws a port + edge when that node is shown). */
  child?: string;
  /** Row can expand to a child node that is currently hidden. */
  expandable?: boolean;
  expanded?: boolean;
  /** Row action (e.g. load more). */
  action?: string;
  muted?: boolean;
  /** Payload for event handlers. */
  ref?: unknown;
  /** Right-aligned extra text (line numbers, sizes). */
  aside?: string;
  /** CSS color drawn as a chip before the value (color values). */
  swatch?: string;
}

export interface SceneNode {
  key: string;
  shape: Shape;
  /** Accent color of the node (header strip / border). */
  color: ColorName | string;
  title?: string;
  /** Right side of the header, e.g. `{12}`. */
  badge?: string;
  /** Header glyph. */
  icon?: string;
  rows?: Row[];
  /** Body text lines for non-card shapes (or cards without rows). */
  lines?: string[];
  /** Muted / dimmed rendering (unreachable code, filtered out…). */
  faded?: boolean;
  dashed?: boolean;
  /** Filled background tint strength 0..1 (treemap-like nodes). */
  fill?: number;
  ref?: unknown;
  // Layout (world coordinates, top-left)
  x: number;
  y: number;
  w: number;
  h: number;
}

export type EdgeStyle = 'solid' | 'dashed' | 'dotted';

export interface SceneEdge {
  from: string;
  to: string;
  /** Row index of `from` that the edge starts at (cards). */
  fromRow?: number;
  label?: string;
  /** Where the label sits along the edge (0 = start, 1 = end); defaults to 0.35, next to the source. */
  labelAt?: number;
  color?: ColorName | string;
  style?: EdgeStyle;
  width?: number;
  /** Polyline from layout ([x0,y0,x1,y1,…]); when absent, a curve between ports. */
  points?: number[];
  arrow?: boolean;
  ref?: unknown;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  direction: 'LR' | 'TB';
  width: number;
  height: number;
  /** Default edge shape: `curve` (tree ports) or `route` (follow points). */
  edgeMode: 'curve' | 'route';
}

export const ROW_H = 20;
export const HEADER_H = 26;
export const CARD_PAD_X = 10;
export const CARD_PAD_Y = 6;

/** Edge labels longer than this are truncated. */
export const EDGE_LABEL_CHARS = 24;
export const EDGE_LABEL_H = 16;

/** World-space width of an edge label pill (layouts reserve room for it). */
export function edgeLabelWidth(label: string, charW: number): number {
  return Math.min(label.length, EDGE_LABEL_CHARS) * charW * 0.9 + 10;
}
