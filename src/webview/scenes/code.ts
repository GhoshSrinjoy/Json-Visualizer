/** Scenes for code: file structure map, control-flow chart, data-flow graph and call graph. */

import type { CallGraph, CodeOutline, CodeSymbol, DataFlowGraph, FlowGraph, FlowNode } from '../../core/code/model';
import { layoutLayered } from '../../core/graph/layered';
import { layoutTree } from '../../core/graph/tree-layout';
import { CARD_PAD_X, HEADER_H, ROW_H, type ColorName, type Row, type Scene, type SceneEdge, type SceneNode, type Shape } from '../engine/scene';

const KIND_GLYPH: Record<string, string> = {
  class: 'C', interface: 'I', struct: 'S', enum: 'E', trait: 'T', impl: 'Im', type: 'T', function: 'ƒ', method: 'm', constructor: 'c',
  property: 'p', field: 'f', variable: 'v', constant: 'K', enumMember: 'e', module: 'M', namespace: 'N', macro: '!',
};

export const KIND_COLOR: Record<string, ColorName> = {
  class: 'class', struct: 'class', impl: 'class', interface: 'interface', trait: 'interface', enum: 'enum', type: 'type',
  function: 'function', method: 'method', ['constructor']: 'method' as ColorName, property: 'field', field: 'field', variable: 'variable',
  constant: 'variable', enumMember: 'enum', module: 'module', namespace: 'module', macro: 'function',
};

export function glyph(kind: string): string {
  return KIND_GLYPH[kind] ?? '·';
}

function cardSize(rows: Row[], title: string, charW: number, min = 170, max = 520): { w: number; h: number } {
  let chars = title.length + 6;
  for (const r of rows) chars = Math.max(chars, Math.min(64, (r.icon ? r.icon.length + 1 : 0) + (r.key?.length ?? 0) + (r.value ? r.value.length + 1 : 0) + (r.aside ? r.aside.length + 2 : 0)));
  return { w: Math.round(Math.min(max, Math.max(min, chars * charW + CARD_PAD_X * 2 + 16))), h: HEADER_H + Math.max(1, rows.length) * ROW_H + 6 };
}

// ---------------------------------------------------------------- structure

/** File → containers → members, as cards (tree layout). */
export function buildStructureScene(o: CodeOutline, charW: number, direction: 'LR' | 'TB'): Scene {
  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const children: number[][] = [];
  const isContainer = (s: CodeSymbol) => !!s.children?.length;

  const addCard = (key: string, title: string, color: ColorName, icon: string, rows: Row[], badge: string, ref: unknown): number => {
    const { w, h } = cardSize(rows, title, charW);
    nodes.push({ key, shape: 'card', color, title, icon, badge, rows, ref, x: 0, y: 0, w, h });
    children.push([]);
    return nodes.length - 1;
  };
  const symRow = (s: CodeSymbol): Row => ({
    icon: glyph(s.kind),
    iconColor: KIND_COLOR[s.kind] ?? 'muted',
    key: s.name,
    value: s.signature ? compactSig(s.signature) : s.detail ? s.detail : undefined,
    keyColor: KIND_COLOR[s.kind] === 'class' ? 'class' : s.kind === 'interface' ? 'interface' : 'text',
    valueColor: 'muted',
    aside: `${s.complexity && s.complexity > 4 ? `cx${s.complexity} ` : ''}${s.range.start.line + 1}`,
    expandable: isContainer(s),
    expanded: isContainer(s),
    child: isContainer(s) ? `s:${s.id}` : undefined,
    ref: s.id,
  });

  const fileRows: Row[] = [];
  if (o.imports.length) fileRows.push({ icon: '⇢', iconColor: 'muted', key: 'imports', value: `${o.imports.length}`, valueColor: 'muted', child: 'imports', expandable: true, expanded: true, ref: 'imports' });
  for (const s of o.symbols) fileRows.push(symRow(s));
  const root = addCard('file', o.path.split(/[\\/]/).pop() ?? o.path, 'module', '◆', fileRows, `${o.lines} lines`, 'file');
  if (o.imports.length) {
    const rows: Row[] = o.imports.slice(0, 80).map((i) => ({
      key: i.source,
      value: i.names.filter((n) => n.name !== '*').map((n) => n.alias ?? n.name).slice(0, 4).join(', ') || (i.names[0]?.alias ? `as ${i.names[0].alias}` : undefined),
      keyColor: i.source.startsWith('.') ? 'string' : 'key',
      valueColor: 'muted',
      aside: String(i.line + 1),
      ref: `import:${i.line}`,
    }));
    if (o.imports.length > 80) rows.push({ value: `… ${o.imports.length - 80} more`, muted: true });
    const idx = addCard('imports', 'imports', 'external', '⇢', rows, String(o.imports.length), 'imports');
    children[root].push(idx);
  }
  const visit = (s: CodeSymbol, parent: number) => {
    if (!isContainer(s)) return;
    const rows = s.children!.map(symRow);
    const title = s.bases?.length ? `${s.name} : ${s.bases.join(', ')}` : s.name;
    const idx = addCard(`s:${s.id}`, title, KIND_COLOR[s.kind] ?? 'class', glyph(s.kind), rows, s.kind, s.id);
    children[parent].push(idx);
    for (const c of s.children!) visit(c, idx);
  };
  for (const s of o.symbols) visit(s, root);
  nodes.forEach((n) =>
    n.rows?.forEach((r, i) => {
      if (r.child && nodes.some((m) => m.key === r.child)) edges.push({ from: n.key, to: r.child, fromRow: direction === 'LR' ? i : undefined, arrow: false });
    }),
  );
  const res = layoutTree({ width: nodes.map((n) => n.w), height: nodes.map((n) => n.h), children, root: 0 }, { direction, levelGap: 70, siblingGap: 20, layered: true });
  nodes.forEach((n, i) => {
    n.x = res.x[i];
    n.y = res.y[i];
  });
  return { nodes, edges, direction, width: res.width, height: res.height, edgeMode: 'curve' };
}

function compactSig(sig: string): string {
  return sig.length > 56 ? sig.slice(0, 55) + '…' : sig;
}

// ---------------------------------------------------------------- control flow

const FLOW_STYLE: Record<FlowNode['kind'], { shape: Shape; color: ColorName }> = {
  start: { shape: 'stadium', color: 'start' },
  end: { shape: 'stadium', color: 'muted' },
  block: { shape: 'note', color: 'block' },
  decision: { shape: 'diamond', color: 'decision' },
  switch: { shape: 'diamond', color: 'decision' },
  loop: { shape: 'hexagon', color: 'loop' },
  return: { shape: 'pill', color: 'return' },
  throw: { shape: 'pill', color: 'throw' },
  jump: { shape: 'pill', color: 'jump' },
  try: { shape: 'parallelogram', color: 'try' },
  catch: { shape: 'parallelogram', color: 'throw' },
  finally: { shape: 'parallelogram', color: 'try' },
  merge: { shape: 'circle', color: 'muted' },
};

/** Word-wraps `text` to at most `maxLines` lines of `width` chars (ellipsis when cut). */
function wrap(text: string, width: number, maxLines: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest && out.length < maxLines) {
    if (rest.length <= width) {
      out.push(rest);
      rest = '';
      break;
    }
    // Prefer breaking after a space, comma, paren or operator in the second half of the line.
    let cut = -1;
    for (let i = width; i > width / 2; i--) {
      if (/[\s,(&|]/.test(rest[i])) {
        cut = rest[i] === ' ' ? i : i + 1;
        break;
      }
    }
    if (cut < 0) cut = width;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest && out.length) out[out.length - 1] = out[out.length - 1].slice(0, Math.max(1, width - 1)) + '…';
  return out.length ? out : [''];
}

export function buildFlowScene(g: FlowGraph, charW: number, direction: 'LR' | 'TB'): Scene {
  const nodes: SceneNode[] = g.nodes.map((n) => {
    const st = FLOW_STYLE[n.kind] ?? FLOW_STYLE.block;
    let lines: string[];
    let w: number;
    let h: number;
    if (n.kind === 'block') {
      lines = (n.lines?.length ? n.lines : [n.label]).map((l) => (l.length > 64 ? l.slice(0, 63) + '…' : l));
      w = Math.min(520, Math.max(150, Math.max(...lines.map((l) => l.length)) * charW + CARD_PAD_X * 2 + 4));
      h = lines.length * ROW_H + 10;
    } else if (n.kind === 'decision' || n.kind === 'switch') {
      lines = wrap(n.label, 30, 3);
      const tw = Math.max(...lines.map((l) => l.length)) * charW;
      w = Math.max(120, tw * 1.7 + 30);
      h = Math.max(64, lines.length * 18 + 40);
    } else if (n.kind === 'loop') {
      lines = wrap(n.label, 40, 2);
      w = Math.max(130, Math.max(...lines.map((l) => l.length)) * charW + 44);
      h = lines.length * 18 + 22;
    } else if (n.kind === 'start' || n.kind === 'end') {
      lines = wrap(n.kind === 'end' ? 'end' : n.label, 48, 2);
      w = Math.max(90, Math.max(...lines.map((l) => l.length)) * charW + 40);
      h = lines.length * 18 + 18;
    } else {
      lines = wrap(n.label, 48, 2);
      w = Math.max(n.kind === 'jump' ? 80 : 110, Math.max(...lines.map((l) => l.length)) * charW + 36);
      h = lines.length * 18 + 16;
    }
    return {
      key: `f${n.id}`,
      shape: st.shape,
      color: st.color,
      lines,
      faded: n.unreachable,
      dashed: n.unreachable,
      ref: n,
      x: 0,
      y: 0,
      w: Math.round(w),
      h: Math.round(h),
    };
  });
  const startIdx = g.nodes.findIndex((n) => n.kind === 'start');
  const res = layoutLayered(
    nodes.map((n) => ({ w: n.w, h: n.h })),
    g.edges.map((e) => ({ from: e.from, to: e.to, weight: e.kind === 'back' || e.kind === 'continue' ? 0.3 : e.kind === 'normal' ? 2 : 1 })),
    { direction, root: startIdx >= 0 ? startIdx : undefined, rankSep: 46, nodeSep: 34 },
  );
  nodes.forEach((n, i) => {
    n.x = res.x[i];
    n.y = res.y[i];
  });
  const edges: SceneEdge[] = g.edges.map((e, i) => {
    const back = e.kind === 'back' || e.kind === 'continue';
    const exc = e.kind === 'exception';
    return {
      from: `f${e.from}`,
      to: `f${e.to}`,
      label: e.label && e.label !== 'break' ? e.label : undefined,
      color: exc ? 'throw' : back ? 'loop' : e.kind === 'true' ? 'ok' : e.kind === 'false' ? 'danger' : e.kind === 'return' ? 'return' : undefined,
      style: exc ? 'dotted' : back ? 'dashed' : 'solid',
      points: res.routes[i],
    };
  });
  return { nodes, edges, direction, width: res.width, height: res.height, edgeMode: 'route' };
}

// ---------------------------------------------------------------- data flow

const DATA_STYLE: Record<string, { shape: Shape; color: ColorName }> = {
  param: { shape: 'pill', color: 'param' },
  local: { shape: 'note', color: 'local' },
  field: { shape: 'note', color: 'interface' },
  call: { shape: 'stadium', color: 'call' },
  return: { shape: 'pill', color: 'return' },
  external: { shape: 'hexagon', color: 'external' },
};

export function buildDataFlowScene(g: DataFlowGraph, charW: number, direction: 'LR' | 'TB' = 'LR'): Scene {
  const order = ['param', 'external', 'field', 'local', 'call', 'return'];
  const sorted = [...g.nodes].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const index = new Map(sorted.map((n, i) => [n.id, i]));
  const nodes: SceneNode[] = sorted.map((n) => {
    const st = DATA_STYLE[n.kind] ?? DATA_STYLE.local;
    const label = n.kind === 'return' ? (n.label === 'throw' ? '⚠ throw' : '↩ return') : n.label;
    const lines = [label.length > 44 ? label.slice(0, 43) + '…' : label];
    const w = Math.max(n.kind === 'param' ? 70 : 80, lines[0].length * charW + (st.shape === 'hexagon' ? 40 : 30));
    return { key: `d:${n.id}`, shape: st.shape, color: st.color, lines, ref: n, x: 0, y: 0, w: Math.round(w), h: 34 };
  });
  const res = layoutLayered(
    nodes.map((n) => ({ w: n.w, h: n.h })),
    g.edges.map((e) => ({ from: index.get(e.from)!, to: index.get(e.to)! })),
    direction === 'LR' ? { direction, rankSep: 70, nodeSep: 18 } : { direction, rankSep: 46, nodeSep: 22 },
  );
  nodes.forEach((n, i) => {
    n.x = res.x[i];
    n.y = res.y[i];
  });
  const edges: SceneEdge[] = g.edges.map((e, i) => ({
    from: `d:${e.from}`,
    to: `d:${e.to}`,
    label: e.kind === 'mutate' || e.kind === 'iterate' ? e.kind : undefined,
    color: e.kind === 'return' ? 'return' : e.kind === 'mutate' ? 'warn' : e.kind === 'iterate' ? 'loop' : e.kind === 'arg' ? 'call' : undefined,
    style: e.kind === 'mutate' ? 'dashed' : 'solid',
    width: e.kind === 'iterate' ? 2 : 1.3,
    points: res.routes[i],
    ref: e,
  }));
  return { nodes, edges, direction, width: res.width, height: res.height, edgeMode: 'route' };
}

// ---------------------------------------------------------------- call graph

const FILE_COLORS: ColorName[] = ['function', 'class', 'interface', 'module', 'enum', 'call', 'param', 'method'];

export function buildCallScene(g: CallGraph, charW: number, focus?: string): Scene {
  const files = [...new Set(g.nodes.map((n) => n.file ?? ''))];
  const color = (file?: string) => (file ? FILE_COLORS[files.indexOf(file) % FILE_COLORS.length] : 'external');
  const index = new Map(g.nodes.map((n, i) => [n.id, i]));
  const nodes: SceneNode[] = g.nodes.map((n) => {
    const name = n.container ? `${n.container}.${n.name}` : n.name;
    const sub = n.file ? n.file.split(/[\\/]/).pop()! : 'external';
    const lines = [name.length > 40 ? name.slice(0, 39) + '…' : name, `${sub}${n.line !== undefined ? `:${n.line + 1}` : ''}`];
    const w = Math.max(...lines.map((l) => l.length)) * charW + 34;
    return {
      key: `c:${n.id}`,
      shape: n.kind === 'external' ? 'hexagon' : 'stadium',
      color: color(n.file),
      lines,
      faded: n.kind === 'external',
      ref: n,
      x: 0,
      y: 0,
      w: Math.round(Math.max(110, w)),
      h: 46,
    };
  });
  const res = layoutLayered(
    nodes.map((n) => ({ w: n.w, h: n.h })),
    g.edges.map((e) => ({ from: index.get(e.from)!, to: index.get(e.to)!, weight: e.count })),
    { direction: 'LR', rankSep: 80, nodeSep: 16, root: focus ? index.get(focus) : undefined },
  );
  nodes.forEach((n, i) => {
    n.x = res.x[i];
    n.y = res.y[i];
  });
  const edges: SceneEdge[] = g.edges.map((e, i) => ({
    from: `c:${e.from}`,
    to: `c:${e.to}`,
    label: e.count > 1 ? `×${e.count}` : undefined,
    style: e.confidence === 'exact' ? 'solid' : 'dashed',
    points: res.routes[i],
    ref: e,
  }));
  return { nodes, edges, direction: 'LR', width: res.width, height: res.height, edgeMode: 'route' };
}
