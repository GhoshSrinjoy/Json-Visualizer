/** Virtualized, keyboard-navigable tree of a data document (handles millions of children via paging). */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { registerCommands } from '../../commands';
import { Icon } from '../../components/icons';
import { useMenu, VirtualList, type MenuItem } from '../../components/ui';
import { keyLabel, valueLabel } from '../../scenes/data-graph';
import { app, copy, useStore } from '../../store';
import type { NodeInfo } from '../../worker/protocol';
import { useData } from './context';

const ROW = 24;
const PAGE = 500;

interface FlatRow {
  id: number;
  depth: number;
  info: NodeInfo | null;
  /** "Load more" row for a parent with unloaded children. */
  more?: { parent: number; loaded: number; total: number };
}

export function TreePane() {
  const ctx = useData();
  const { client, summary } = ctx;
  const page = useStore(app, (s) => Math.max(PAGE, s.settings.childPageSize));
  const [version, setVersion] = useState(0);
  const expanded = useRef(new Set<number>());
  const kids = useRef(new Map<number, NodeInfo[]>());
  const rootInfo = useRef<NodeInfo | null>(null);
  const [menu, openMenu] = useMenu();
  const bump = () => setVersion((v) => v + 1);

  const isContainer = (n: NodeInfo) => (n.type === 'object' || n.type === 'array') && n.count > 0;

  const load = async (id: number, offset = 0) => {
    const list = await client.call('children', { id, offset, limit: page });
    const cur = kids.current.get(id) ?? [];
    kids.current.set(id, offset === 0 ? list : [...cur, ...list]);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await client.call('node', { id: summary.root });
      rootInfo.current = r;
      expanded.current = new Set([summary.root]);
      kids.current = new Map();
      if (isContainer(r)) await load(summary.root);
      // Open the first level of small documents.
      const first = kids.current.get(summary.root) ?? [];
      if (summary.nodes < 2000) for (const c of first.slice(0, 20)) if (isContainer(c)) {
        expanded.current.add(c.id);
        await load(c.id);
      }
      if (alive) bump();
    })();
    return () => {
      alive = false;
    };
  }, [client, summary]);

  const rows = useMemo(() => {
    const out: FlatRow[] = [];
    const root = rootInfo.current;
    if (!root) return out;
    type Item = { node: NodeInfo; depth: number } | { moreOf: NodeInfo; depth: number };
    const stack: Item[] = [{ node: root, depth: 0 }];
    while (stack.length) {
      const it = stack.pop()!;
      if ('moreOf' in it) {
        const loaded = (kids.current.get(it.moreOf.id) ?? []).length;
        out.push({ id: -1 - it.moreOf.id, depth: it.depth, info: null, more: { parent: it.moreOf.id, loaded, total: it.moreOf.count } });
        continue;
      }
      out.push({ id: it.node.id, depth: it.depth, info: it.node });
      if (!expanded.current.has(it.node.id)) continue;
      const list = kids.current.get(it.node.id) ?? [];
      // Pushed in reverse so children pop in order, followed by a "more" row.
      if (list.length < it.node.count) stack.push({ moreOf: it.node, depth: it.depth + 1 });
      for (let i = list.length - 1; i >= 0; i--) stack.push({ node: list[i], depth: it.depth + 1 });
    }
    return out;
  }, [version]);

  const indexOf = (id: number | null) => (id === null ? -1 : rows.findIndex((r) => r.id === id));
  const selectedIndex = indexOf(ctx.selected);

  const toggle = async (id: number) => {
    if (expanded.current.has(id)) expanded.current.delete(id);
    else {
      expanded.current.add(id);
      if (!kids.current.has(id)) await load(id);
    }
    bump();
  };

  /** Expands ancestors (and loads pages) until `id` is in the flat list. */
  const reveal = async (id: number) => {
    const chain = await client.call('ancestors', { id });
    for (const a of chain) {
      if (a < summary.root) continue;
      expanded.current.add(a);
      if (!kids.current.has(a)) await load(a);
    }
    // Load further pages of the direct parent if needed.
    const parent = chain[chain.length - 1];
    if (parent !== undefined) {
      let guard = 0;
      while (!(kids.current.get(parent) ?? []).some((c) => c.id === id) && guard++ < 40) {
        const loaded = (kids.current.get(parent) ?? []).length;
        const before = loaded;
        await load(parent, loaded);
        if ((kids.current.get(parent) ?? []).length === before) break;
      }
    }
    bump();
  };

  useEffect(() => {
    if (ctx.hitIndex >= 0 && ctx.hits[ctx.hitIndex] !== undefined) void reveal(ctx.hits[ctx.hitIndex]);
  }, [ctx.hitVersion]);
  useEffect(() => {
    if (ctx.reveal) void reveal(ctx.reveal.id);
  }, [ctx.reveal?.seq]);

  const hitSet = useMemo(() => new Set(ctx.hits), [ctx.hits]);

  useEffect(
    () =>
      registerCommands({
        expandAll: async () => {
          // Expand the visible containers one level deeper (bounded).
          let added = 0;
          for (const r of rows) {
            if (r.info && isContainer(r.info) && !expanded.current.has(r.id) && added < 200) {
              expanded.current.add(r.id);
              if (!kids.current.has(r.id)) await load(r.id);
              added++;
            }
          }
          bump();
        },
        collapseAll: () => {
          expanded.current = new Set([summary.root]);
          bump();
        },
      }),
    [rows],
  );

  const onKey = (e: KeyboardEvent) => {
    const i = selectedIndex;
    const row = rows[i];
    const select = (j: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (r?.info) ctx.select(r.id, { source: 'tree' });
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        select(i + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        select(i - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (row?.info && isContainer(row.info)) {
          if (!expanded.current.has(row.id)) void toggle(row.id);
          else select(i + 1);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (row?.info && expanded.current.has(row.id) && row.id !== summary.root) void toggle(row.id);
        else if (row) {
          for (let j = i - 1; j >= 0; j--) if (rows[j].depth < row.depth) return select(j);
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (row?.info && isContainer(row.info)) void toggle(row.id);
        break;
      case 'PageDown':
        e.preventDefault();
        select(i + 20);
        break;
      case 'PageUp':
        e.preventDefault();
        select(i - 20);
        break;
      case 'Home':
        e.preventDefault();
        select(0);
        break;
      case 'End':
        e.preventDefault();
        select(rows.length - 1);
        break;
    }
  };

  const menuFor = (id: number): MenuItem[] => [
    { label: 'Copy path', icon: 'link', onSelect: () => client.call('detail', { id, maxChars: 0 }).then((d) => copy(d.path, `Copied ${d.path}`)) },
    { label: 'Copy value', icon: 'copy', onSelect: () => client.call('detail', { id, maxChars: 5_000_000 }).then((d) => copy(d.value, 'Value copied')) },
    { label: 'Copy as JSON', icon: 'braces', onSelect: () => client.call('json', { id, indent: 2, maxChars: 20_000_000 }).then((t) => copy(t, 'JSON copied')) },
  ];

  const render = (i: number) => {
    const r = rows[i];
    const pad = 8 + r.depth * 16;
    if (r.more) {
      const m = r.more;
      return (
        <div key={`m${m.parent}`} class="trow" style={{ top: `${i * ROW}px`, paddingLeft: `${pad + 20}px` }}>
          <span
            class="tmore"
            onClick={async () => {
              await load(m.parent, m.loaded);
              bump();
            }}
          >
            Show {Math.min(page, m.total - m.loaded).toLocaleString()} more ({(m.total - m.loaded).toLocaleString()} remaining)
          </span>
        </div>
      );
    }
    const n = r.info!;
    const open = expanded.current.has(n.id);
    const container = isContainer(n);
    const key = r.depth === 0 ? '$' : keyLabel(n);
    return (
      <div
        key={n.id}
        class={`trow ${ctx.selected === n.id ? 'selected' : ''} ${hitSet.has(n.id) ? 'match' : ''}`}
        style={{ top: `${i * ROW}px`, paddingLeft: `${pad}px` }}
        onClick={() => ctx.select(n.id, { source: 'tree' })}
        onDblClick={() => container && void toggle(n.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          ctx.select(n.id);
          openMenu(menuFor(n.id), { x: e.clientX, y: e.clientY });
        }}
      >
        {Array.from({ length: r.depth }, (_, d) => (
          <span key={d} class="indent-guide" style={{ left: `${16 + d * 16}px` }} />
        ))}
        <span
          class={`twisty ${open ? 'open' : ''}`}
          style={{ visibility: container ? 'visible' : 'hidden' }}
          onClick={(e) => {
            e.stopPropagation();
            void toggle(n.id);
          }}
        >
          <Icon name="chevronRight" />
        </span>
        <span class="tkey" style={typeof n.key === 'number' ? { color: 'var(--text-faint)' } : n.attr ? { color: 'var(--k-interface)' } : undefined}>
          {key}
        </span>
        <span class="tsep">:</span>
        {container ? (
          <span class={`tcount v-${n.type}`}>{valueLabel(n)}</span>
        ) : (
          <span class={`tval ${n.error ? 'v-error' : n.inline !== undefined ? 'v-string' : `v-${n.type}`}`}>{n.type === 'string' && n.inline === undefined ? JSON.stringify(n.preview).slice(1, -1) || '""' : valueLabel(n)}</span>
        )}
      </div>
    );
  };

  return (
    <div class="view-fill">
      <VirtualList count={rows.length} rowHeight={ROW} render={render} scrollTo={selectedIndex} onKeyDown={onKey} />
      {menu}
    </div>
  );
}
