/** Scenes for repositories: directory cards and the dependency graph. */

import { layoutLayered } from '../../core/graph/layered';
import { layoutTree } from '../../core/graph/tree-layout';
import { aggregateByFolder, type DepGraph } from '../../core/repo/deps';
import { K_DIR, repoChildren, type RepoModel } from '../../core/repo/model';
import { formatBytes, formatCount } from '../../core/util/strings';
import { CARD_PAD_X, HEADER_H, ROW_H, type ColorName, type Row, type Scene, type SceneEdge, type SceneNode } from '../engine/scene';

export function langColor(repo: RepoModel, id: number): string {
  const l = repo.lang[id];
  return l >= 0 ? repo.languages[l].color : '#6e7681';
}

export interface RepoGraphState {
  expanded: Set<number>;
  rowLimits: Map<number, number>;
}

const ROWS = 40;

/** Directory cards: sub-folders (expandable) then files with line counts. */
export function buildRepoGraphScene(repo: RepoModel, state: RepoGraphState, charW: number, direction: 'LR' | 'TB'): Scene {
  const nodes: SceneNode[] = [];
  const children: number[][] = [];
  const index = new Map<number, number>();
  const queue = [0];
  while (queue.length) {
    const id = queue.shift()!;
    if (index.has(id)) continue;
    const kids = repoChildren(repo, id);
    const limit = state.rowLimits.get(id) ?? ROWS;
    const rows: Row[] = [];
    const childCards: number[] = [];
    for (const k of kids.slice(0, limit)) {
      if (repo.kind[k] === K_DIR) {
        const open = state.expanded.has(k);
        rows.push({
          icon: '▸',
          iconColor: 'dir',
          key: `${repo.names[k]}/`,
          keyColor: 'dir',
          value: `${repo.files[k].toLocaleString()} files`,
          valueColor: 'muted',
          aside: repo.lines[k] > 0 ? formatCount(repo.lines[k]) : undefined,
          expandable: repo.childCount[k] > 0,
          expanded: open,
          child: open ? `r${k}` : undefined,
          ref: k,
        });
        if (open) {
          childCards.push(k);
          queue.push(k);
        }
      } else {
        rows.push({
          icon: '●',
          iconColor: langColor(repo, k) as ColorName,
          key: repo.names[k],
          keyColor: 'text',
          aside: repo.lines[k] > 0 ? formatCount(repo.lines[k]) : formatBytes(repo.size[k]),
          ref: k,
        });
      }
    }
    if (kids.length > limit) rows.push({ action: 'more', value: `… ${(kids.length - limit).toLocaleString()} more`, ref: id });
    if (!kids.length) rows.push({ value: '(empty or ignored)', muted: true, ref: id });
    const title = id === 0 ? repo.name : `${repo.names[id]}/`;
    let chars = title.length + 10;
    for (const r of rows) chars = Math.max(chars, Math.min(48, (r.key?.length ?? 0) + (r.value ? r.value.length + 2 : 0) + (r.aside ? r.aside.length + 3 : 0) + 3));
    const w = Math.round(Math.min(420, Math.max(170, chars * charW + CARD_PAD_X * 2 + 14)));
    index.set(id, nodes.length);
    nodes.push({
      key: `r${id}`,
      shape: 'card',
      color: 'dir',
      title,
      icon: '▣',
      badge: `${repo.files[id].toLocaleString()} files`,
      rows,
      ref: id,
      x: 0,
      y: 0,
      w,
      h: HEADER_H + Math.max(1, rows.length) * ROW_H + 6,
    });
    children.push(childCards);
  }
  const edges: SceneEdge[] = [];
  nodes.forEach((n) =>
    n.rows?.forEach((r, i) => {
      if (r.child) edges.push({ from: n.key, to: r.child, fromRow: direction === 'LR' ? i : undefined, arrow: false });
    }),
  );
  const res = layoutTree(
    { width: nodes.map((n) => n.w), height: nodes.map((n) => n.h), children: children.map((c) => c.map((id) => index.get(id)!)), root: 0 },
    { direction, levelGap: 64, siblingGap: 18, layered: true },
  );
  nodes.forEach((n, i) => {
    n.x = res.x[i];
    n.y = res.y[i];
  });
  return { nodes, edges, direction, width: res.width, height: res.height, edgeMode: 'curve' };
}

export interface DepsSceneOptions {
  level: 'folder' | 'file';
  folderDepth: number;
  externals: boolean;
  /** Node path to centre on (neighbourhood view). */
  focus: string | null;
  maxNodes: number;
}

const GROUP_COLORS: ColorName[] = ['function', 'class', 'interface', 'module', 'enum', 'call', 'param', 'method', 'string', 'number'];

export function prepareDeps(graph: DepGraph, opts: DepsSceneOptions): { graph: DepGraph; truncated: number } {
  let g = opts.level === 'folder' ? aggregateByFolder(graph, opts.folderDepth) : graph;
  let keep = g.nodes.map((n) => n.kind !== 'external' || opts.externals);
  if (opts.focus) {
    const f = g.nodes.find((n) => n.path === opts.focus);
    if (f) {
      const near = new Set([f.id]);
      for (const e of g.edges) {
        if (e.from === f.id) near.add(e.to);
        if (e.to === f.id) near.add(e.from);
      }
      keep = keep.map((k, i) => k && near.has(i));
    }
  }
  let ids = g.nodes.filter((n, i) => keep[i] && (n.fanIn + n.fanOut > 0 || opts.focus === n.path)).map((n) => n.id);
  let truncated = 0;
  if (ids.length > opts.maxNodes) {
    truncated = ids.length - opts.maxNodes;
    ids = ids.sort((a, b) => g.nodes[b].fanIn + g.nodes[b].fanOut - (g.nodes[a].fanIn + g.nodes[a].fanOut)).slice(0, opts.maxNodes);
  }
  const set = new Set(ids);
  const remap = new Map(ids.map((id, i) => [id, i]));
  g = {
    ...g,
    nodes: ids.map((id, i) => ({ ...g.nodes[id], id: i })),
    edges: g.edges.filter((e) => set.has(e.from) && set.has(e.to)).map((e) => ({ ...e, from: remap.get(e.from)!, to: remap.get(e.to)! })),
    cycles: g.cycles.map((c) => c.filter((id) => set.has(id)).map((id) => remap.get(id)!)).filter((c) => c.length > 1),
  };
  return { graph: g, truncated };
}

export function buildDepsScene(g: DepGraph, charW: number, focus: string | null): Scene {
  const groups = [...new Set(g.nodes.filter((n) => n.kind !== 'external').map((n) => n.group))];
  const inCycle = new Set(g.cycles.flat());
  const nodes: SceneNode[] = g.nodes.map((n) => {
    const label = n.kind === 'dir' ? `${n.path}/` : n.path;
    const short = label.length > 46 ? '…' + label.slice(-45) : label;
    const sub = n.kind === 'external' ? n.group : `in ${n.fanIn} · out ${n.fanOut}`;
    const lines = [short, sub];
    const w = Math.max(...lines.map((l) => l.length)) * charW + 36;
    return {
      key: `p${n.id}`,
      shape: n.kind === 'external' ? 'hexagon' : n.kind === 'dir' ? 'note' : 'stadium',
      color: n.kind === 'external' ? 'external' : GROUP_COLORS[groups.indexOf(n.group) % GROUP_COLORS.length],
      lines,
      faded: n.kind === 'external',
      dashed: inCycle.has(n.id),
      ref: n,
      x: 0,
      y: 0,
      w: Math.round(Math.max(120, w)),
      h: 46,
    };
  });
  const focusIdx = focus ? g.nodes.findIndex((n) => n.path === focus) : -1;
  const res = layoutLayered(
    nodes.map((n) => ({ w: n.w, h: n.h })),
    g.edges.map((e) => ({ from: e.from, to: e.to, weight: Math.min(4, e.count) })),
    { direction: 'LR', rankSep: 90, nodeSep: 16, root: focusIdx >= 0 ? focusIdx : undefined },
  );
  nodes.forEach((n, i) => {
    n.x = res.x[i];
    n.y = res.y[i];
  });
  const edges: SceneEdge[] = g.edges.map((e, i) => {
    const cyc = inCycle.has(e.from) && inCycle.has(e.to);
    return {
      from: `p${e.from}`,
      to: `p${e.to}`,
      label: e.count > 1 ? `×${e.count}` : undefined,
      color: cyc ? 'danger' : undefined,
      width: cyc ? 1.8 : Math.min(3, 1 + Math.log2(e.count) * 0.4),
      style: g.nodes[e.to].kind === 'external' ? 'dashed' : 'solid',
      points: res.routes[i],
      ref: e,
    };
  });
  return { nodes, edges, direction: 'LR', width: res.width, height: res.height, edgeMode: 'route' };
}
