/** Mermaid renderers: flowcharts that agents can show users and editors can preview. */

import type { CallGraph, DataFlowGraph, FlowGraph } from '../code/model';
import type { DepGraph } from '../repo/deps';

/** Escapes text for a quoted Mermaid label. */
export function mermaidLabel(s: string, max = 70): string {
  let t = s.replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max - 1) + '…';
  return t.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/\|/g, '#124;').replace(/`/g, '#96;');
}

export function flowToMermaid(g: FlowGraph, direction: 'TD' | 'LR' = 'TD'): string {
  const out = [`flowchart ${direction}`];
  for (const n of g.nodes) {
    const text = mermaidLabel(n.lines && n.lines.length > 1 ? n.lines.join(' ⏎ ') : n.label, n.kind === 'block' ? 90 : 70);
    const id = `n${n.id}`;
    switch (n.kind) {
      case 'start':
      case 'end':
        out.push(`  ${id}(["${text}"])`);
        break;
      case 'decision':
      case 'switch':
        out.push(`  ${id}{"${text}"}`);
        break;
      case 'loop':
        out.push(`  ${id}[["${text}"]]`);
        break;
      case 'return':
      case 'throw':
        out.push(`  ${id}>"${text}"]`);
        break;
      case 'jump':
        out.push(`  ${id}(("${text}"))`);
        break;
      case 'try':
      case 'catch':
      case 'finally':
        out.push(`  ${id}[/"${text}"/]`);
        break;
      default:
        out.push(`  ${id}["${text}"]`);
    }
  }
  for (const e of g.edges) {
    const arrow = e.kind === 'back' || e.kind === 'continue' ? '-.->' : e.kind === 'exception' ? '-.->' : '-->';
    const label = e.label ? `|${mermaidLabel(e.label, 30)}|` : '';
    out.push(`  n${e.from} ${arrow}${label} n${e.to}`);
  }
  const unreachable = g.nodes.filter((n) => n.unreachable).map((n) => `n${n.id}`);
  out.push('  classDef term fill:#1f6feb22,stroke:#1f6feb');
  out.push('  classDef dead fill:#6e768133,stroke:#6e7681,stroke-dasharray:4 3,color:#8b949e');
  out.push(`  class n${g.nodes.find((n) => n.kind === 'start')?.id ?? 0},n${g.nodes.find((n) => n.kind === 'end')?.id ?? 1} term`);
  if (unreachable.length) out.push(`  class ${unreachable.join(',')} dead`);
  return out.join('\n');
}

export function dataFlowToMermaid(g: DataFlowGraph): string {
  const out = ['flowchart LR'];
  const ids = new Map<string, string>();
  g.nodes.forEach((n, i) => ids.set(n.id, `d${i}`));
  for (const n of g.nodes) {
    const id = ids.get(n.id)!;
    const text = mermaidLabel(n.label, 48);
    if (n.kind === 'param') out.push(`  ${id}[/"${text}"/]`);
    else if (n.kind === 'return') out.push(`  ${id}(["${text}"])`);
    else if (n.kind === 'call') out.push(`  ${id}("${text}")`);
    else if (n.kind === 'external') out.push(`  ${id}{{"${text}"}}`);
    else out.push(`  ${id}["${text}"]`);
  }
  for (const e of g.edges) {
    const a = ids.get(e.from);
    const b = ids.get(e.to);
    if (!a || !b) continue;
    const arrow = e.kind === 'mutate' ? '-.->' : e.kind === 'iterate' ? '==>' : '-->';
    const label = e.kind === 'assign' || e.kind === 'result' ? '' : `|${e.kind}|`;
    out.push(`  ${a} ${arrow}${label} ${b}`);
  }
  const byKind = (k: string) => g.nodes.filter((n) => n.kind === k).map((n) => ids.get(n.id)!);
  out.push('  classDef param fill:#2ea04326,stroke:#2ea043');
  out.push('  classDef ret fill:#a371f726,stroke:#a371f7');
  out.push('  classDef call fill:#d2992226,stroke:#d29922');
  for (const [k, cls] of [['param', 'param'], ['return', 'ret'], ['call', 'call']] as const) {
    const list = byKind(k);
    if (list.length) out.push(`  class ${list.join(',')} ${cls}`);
  }
  return out.join('\n');
}

export function callGraphToMermaid(g: CallGraph, maxEdges = 300): string {
  const out = ['flowchart LR'];
  const ids = new Map<string, string>();
  g.nodes.forEach((n, i) => ids.set(n.id, `c${i}`));
  const byFile = new Map<string, typeof g.nodes>();
  for (const n of g.nodes) {
    const key = n.file ?? '(external)';
    const list = byFile.get(key);
    if (list) list.push(n);
    else byFile.set(key, [n]);
  }
  let s = 0;
  for (const [file, nodes] of byFile) {
    out.push(`  subgraph s${s++}["${mermaidLabel(file, 60)}"]`);
    for (const n of nodes) {
      const label = mermaidLabel(n.container ? `${n.container}.${n.name}` : n.name, 50);
      out.push(n.kind === 'external' ? `    ${ids.get(n.id)}{{"${label}"}}` : `    ${ids.get(n.id)}("${label}")`);
    }
    out.push('  end');
  }
  for (const e of g.edges.slice(0, maxEdges)) {
    const arrow = e.confidence === 'exact' ? '-->' : '-.->';
    out.push(`  ${ids.get(e.from)} ${arrow}${e.count > 1 ? `|×${e.count}|` : ''} ${ids.get(e.to)}`);
  }
  if (g.edges.length > maxEdges) out.push(`  %% ${g.edges.length - maxEdges} more edges omitted`);
  return out.join('\n');
}

export function depsToMermaid(g: DepGraph, maxEdges = 300): string {
  const out = ['flowchart LR'];
  const used = new Set<number>();
  const edges = [...g.edges].sort((a, b) => b.count - a.count).slice(0, maxEdges);
  for (const e of edges) {
    used.add(e.from);
    used.add(e.to);
  }
  for (const id of used) {
    const n = g.nodes[id];
    const label = mermaidLabel(n.path, 60);
    out.push(n.kind === 'external' ? `  m${id}{{"${label}"}}` : n.kind === 'dir' ? `  m${id}[["${label}"]]` : `  m${id}["${label}"]`);
  }
  const inCycle = new Set(g.cycles.flat());
  for (const e of edges) out.push(`  m${e.from} ${inCycle.has(e.from) && inCycle.has(e.to) ? '==>' : '-->'} m${e.to}`);
  if (g.edges.length > maxEdges) out.push(`  %% ${g.edges.length - maxEdges} more edges omitted`);
  return out.join('\n');
}
