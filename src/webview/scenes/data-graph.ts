/** Builds the card graph for data documents from worker card data. */

import { layoutTree } from '../../core/graph/tree-layout';
import { CARD_PAD_X, edgeLabelWidth, HEADER_H, ROW_H, type ColorName, type Row, type Scene, type SceneEdge, type SceneNode } from '../engine/scene';
import { colorOf } from '../values';
import type { CardData, NodeInfo } from '../worker/protocol';

export interface DataGraphState {
  root: number;
  cards: Map<number, CardData>;
  expanded: Set<number>;
  rowLimits: Map<number, number>;
}

export interface DataSceneOptions {
  direction: 'LR' | 'TB';
  charW: number;
  rootTitle: string;
  xml: boolean;
  pageSize: number;
  /** Label each edge with the key it leads to (`users`, `[0]`, `<item>`). */
  edgeLabels?: boolean;
  /** Nodes that failed schema validation: their rows are drawn in the danger color. */
  invalid?: ReadonlySet<number>;
  /** Changes from a comparison, by node id: rows get a +, ~, ≠ or ↕ marker. */
  marks?: ReadonlyMap<number, string>;
}

const MARKS: Record<string, [string, ColorName]> = { added: ['+', 'ok'], changed: ['~', 'warn'], type: ['≠', 'warn'], moved: ['↕', 'accent'] };

export const nodeKey = (id: number) => `n${id}`;
export const keyToId = (key: string) => Number(key.slice(1));

const TYPE_COLOR: Record<string, ColorName> = {
  object: 'object', array: 'array', string: 'string', number: 'number', boolean: 'boolean', null: 'null',
};

export function keyLabel(r: NodeInfo): string {
  if (r.key === null) return '';
  if (typeof r.key === 'number') return String(r.key);
  return r.key;
}

export function valueLabel(r: NodeInfo): string {
  if (r.inline !== undefined) return r.inline;
  switch (r.type) {
    case 'object':
      return r.count ? `{${r.count.toLocaleString()}}` : '{}';
    case 'array':
      return r.count ? `[${r.count.toLocaleString()}]` : '[]';
    case 'string':
      return r.preview === '' ? '""' : r.preview;
    default:
      return r.preview;
  }
}

function isContainer(r: NodeInfo): boolean {
  return (r.type === 'object' || r.type === 'array') && r.inline === undefined;
}

function titleOf(c: CardData, opts: DataSceneOptions, isRoot: boolean): string {
  if (isRoot) return opts.rootTitle;
  if (c.element) return `<${String(c.key)}>`;
  if (typeof c.key === 'number') return `[${c.key}]`;
  return c.key ?? '';
}

function rowFor(r: NodeInfo, expanded: boolean, xml: boolean, invalid?: ReadonlySet<number>, marks?: ReadonlyMap<number, string>): Row {
  const container = isContainer(r);
  const row: Row = {
    key: keyLabel(r),
    value: valueLabel(r),
    valueColor: r.error ? 'danger' : container ? TYPE_COLOR[r.type] : r.inline !== undefined ? 'string' : TYPE_COLOR[r.type],
    ref: r.id,
  };
  if (typeof r.key === 'number') row.keyColor = 'faint';
  if (r.attr) row.keyColor = 'interface';
  if (r.text) {
    row.keyColor = 'faint';
    row.key = r.key === '#cdata' ? 'cdata' : 'text';
  }
  if (xml && r.element && container) row.key = `<${keyLabel(r)}>`;
  if (r.type === 'string' && r.inline === undefined && !r.error) {
    const color = colorOf(r.preview, r.key);
    if (color) row.swatch = color;
  }
  if (invalid?.has(r.id)) row.keyColor = row.valueColor = 'danger';
  const mark = MARKS[marks?.get(r.id) ?? ''];
  if (mark) [row.icon, row.iconColor] = mark;
  if (container && r.count > 0) {
    row.expandable = true;
    row.expanded = expanded;
    if (expanded) row.child = nodeKey(r.id);
  }
  return row;
}

export function buildDataScene(state: DataGraphState, opts: DataSceneOptions): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const index = new Map<number, number>();
  const children: number[][] = [];
  const depth: number[] = [];
  const lr = opts.direction === 'LR';

  // Breadth-first over expanded cards reachable from the root.
  const queue: [number, number][] = [[state.root, 0]];
  while (queue.length) {
    const [id, d] = queue.shift()!;
    if (index.has(id)) continue;
    const c = state.cards.get(id);
    if (!c) continue;
    const isRoot = id === state.root;
    const rows: Row[] = [];
    const kids: number[] = [];
    if (!isContainer(c) && isRoot) {
      rows.push({ value: valueLabel(c), valueColor: TYPE_COLOR[c.type], ref: c.id });
    }
    c.rows.forEach((r) => {
      const expanded = isContainer(r) && state.expanded.has(r.id) && state.cards.has(r.id);
      rows.push(rowFor(r, expanded, opts.xml, opts.invalid, opts.marks));
      if (expanded) {
        kids.push(r.id);
        queue.push([r.id, d + 1]);
      }
    });
    if (c.more > 0) {
      const next = Math.min(c.more, opts.pageSize);
      rows.push({ action: 'more', value: `… ${c.more.toLocaleString()} more · show ${next.toLocaleString()}`, ref: c.id });
    }
    const title = titleOf(c, opts, isRoot);
    const badge = c.element ? (c.count ? `${c.count}` : '') : c.type === 'array' ? `[${c.count.toLocaleString()}]` : c.type === 'object' ? `{${c.count.toLocaleString()}}` : c.type;
    let chars = title.length + badge.length + 4;
    for (const r of rows) {
      const k = Math.min(r.key?.length ?? 0, 28);
      const v = Math.min(r.value?.length ?? 0, 46);
      chars = Math.max(chars, k + (r.key !== undefined && r.value !== undefined ? 2 : 0) + v + (r.expandable ? 2 : 0) + (r.swatch ? 2 : 0) + (r.icon ? r.icon.length + 1 : 0));
    }
    const w = Math.round(Math.min(460, Math.max(150, chars * opts.charW + CARD_PAD_X * 2 + 10)));
    const h = HEADER_H + Math.max(1, rows.length) * ROW_H + 6;
    index.set(id, nodes.length);
    nodes.push({
      key: nodeKey(id),
      shape: 'card',
      color: c.element ? 'object' : (TYPE_COLOR[c.type] ?? 'object'),
      title,
      badge,
      icon: c.element ? '<>' : c.type === 'array' ? '[ ]' : c.type === 'object' ? '{ }' : undefined,
      rows,
      ref: id,
      x: 0,
      y: 0,
      w,
      h,
    });
    children.push(kids);
    depth.push(d);
  }

  // Edges from row ports to child cards, labelled with the child's key (its card title).
  const labelW: number[] = [];
  nodes.forEach((n, ni) => {
    n.rows?.forEach((r, i) => {
      const ci = r.child ? index.get(keyToId(r.child)) : undefined;
      if (ci === undefined) return;
      const edge: SceneEdge = { from: n.key, to: r.child!, fromRow: lr ? i : undefined, color: r.valueColor, arrow: false };
      if (opts.edgeLabels) {
        // LR: centred in the gap between columns. TB: edges fan out from one point, so sit near the child.
        edge.label = nodes[ci].title || '""';
        edge.labelAt = lr ? 0.5 : 0.72;
        labelW[depth[ni]] = Math.max(labelW[depth[ni]] ?? 0, edgeLabelWidth(edge.label, opts.charW));
      }
      edges.push(edge);
    });
  });

  if (!nodes.length) return { nodes, edges, direction: opts.direction, width: 0, height: 0, edgeMode: 'curve' };
  const childIdx = children.map((ks) => ks.map((id) => index.get(id)!));
  // Widen the gap after each level that has labels: LR needs the widest label, TB a little more height.
  const levelGap = lr ? 70 : 56;
  const levelGaps = labelW.map((w) => Math.max(levelGap, lr ? Math.ceil(w) + 36 : 72));
  const res = layoutTree(
    { width: nodes.map((n) => n.w), height: nodes.map((n) => n.h), children: childIdx, root: 0 },
    { direction: opts.direction, levelGap, levelGaps, siblingGap: lr ? 18 : 28, layered: true },
  );
  nodes.forEach((n, i) => {
    n.x = res.x[i];
    n.y = res.y[i];
  });
  return { nodes, edges, direction: opts.direction, width: res.width, height: res.height, edgeMode: 'curve' };
}
