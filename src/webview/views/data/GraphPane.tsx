/** Card graph of a data document (JSON-Crack style, but paged and canvas-rendered). */

import { useEffect, useRef, useState } from 'preact/hooks';
import { registerCommands } from '../../commands';
import { Icon } from '../../components/icons';
import { IconButton, Tooltip, useMenu, type MenuItem } from '../../components/ui';
import { GraphView } from '../../engine/view';
import { buildDataScene, nodeKey, type DataGraphState } from '../../scenes/data-graph';
import { app, copy, host, toast, updateSettings, useStore } from '../../store';
import type { CardData } from '../../worker/protocol';
import { useData } from './context';
import { baseName, exportScene } from '../shared';

export function GraphPane() {
  const ctx = useData();
  const { client, summary } = ctx;
  const settings = useStore(app, (s) => s.settings);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<GraphView | null>(null);
  const state = useRef<DataGraphState>({ root: summary.root, cards: new Map(), expanded: new Set(), rowLimits: new Map() });
  const [zoom, setZoom] = useState(1);
  const [tip, setTip] = useState<{ x: number; y: number; head: string; body: string } | null>(null);
  const [menu, openMenu] = useMenu();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const mouse = useRef({ x: 0, y: 0 });

  const rebuild = (opts: { animate?: boolean; fit?: boolean; anchor?: string } = {}) => {
    const view = viewRef.current;
    if (!view) return;
    const scene = buildDataScene(state.current, {
      direction: app.get().settings.direction,
      charW: view.charWidth,
      rootTitle: baseName(ctxRef.current.target.name),
      xml: summary.xml,
      pageSize: app.get().settings.childPageSize,
    });
    view.setScene(scene, opts);
    app.set({ status: `${scene.nodes.length.toLocaleString()} cards` });
  };

  const fetchCards = async (ids: number[]) => {
    const missing = ids.filter((id) => !state.current.cards.has(id));
    if (!missing.length) return;
    const rowLimits = Object.fromEntries([...state.current.rowLimits.entries()]);
    const cards: CardData[] = await client.call('cards', { ids: missing, rowLimit: app.get().settings.childPageSize, rowLimits });
    for (const c of cards) state.current.cards.set(c.id, c);
  };

  const parentCardOf = (id: number): number | null => {
    for (const [cid, c] of state.current.cards) if (state.current.expanded.has(cid) && c.rows.some((r) => r.id === id)) return cid;
    return null;
  };

  const collapse = (id: number) => {
    // Remove the card and every expanded descendant card.
    const stack = [id];
    while (stack.length) {
      const x = stack.pop()!;
      state.current.expanded.delete(x);
      const c = state.current.cards.get(x);
      if (c) for (const r of c.rows) if (state.current.expanded.has(r.id)) stack.push(r.id);
    }
  };

  const toggle = async (id: number) => {
    const anchor = parentCardOf(id);
    if (state.current.expanded.has(id)) collapse(id);
    else {
      await fetchCards([id]);
      state.current.expanded.add(id);
    }
    rebuild({ animate: true, anchor: anchor !== null ? nodeKey(anchor) : undefined });
  };

  const showMore = async (cardId: number) => {
    const page = app.get().settings.childPageSize;
    const cur = state.current.rowLimits.get(cardId) ?? page;
    const next = cur + Math.max(page, Math.min(cur, 1000));
    state.current.rowLimits.set(cardId, next);
    const [c] = await client.call('cards', { ids: [cardId], rowLimit: next, rowLimits: { [cardId]: next } });
    if (c) state.current.cards.set(cardId, c);
    rebuild({ animate: true, anchor: nodeKey(cardId) });
  };

  /** Expands ancestors (and pages) so `id` is visible; returns the card key to focus. */
  const ensureVisible = async (id: number): Promise<string | null> => {
    const ancestors = await client.call('ancestors', { id });
    const chain = [...ancestors, id].filter((a) => a >= state.current.root);
    if (!chain.length) return null;
    let changed = false;
    for (let i = 0; i < chain.length; i++) {
      const a = chain[i];
      const info = await client.call('node', { id: a });
      const isContainer = (info.type === 'object' || info.type === 'array') && info.inline === undefined;
      if (!isContainer) break;
      if (i < chain.length - 1 || state.current.cards.has(a) || a === state.current.root) {
        if (!state.current.expanded.has(a)) {
          await fetchCards([a]);
          state.current.expanded.add(a);
          changed = true;
        }
      }
      // Make sure the next link in the chain is within the visible page.
      const next = chain[i + 1];
      if (next !== undefined) {
        const card = state.current.cards.get(a);
        if (card && !card.rows.some((r) => r.id === next)) {
          const limit = Math.min(5000, (state.current.rowLimits.get(a) ?? app.get().settings.childPageSize) * 4);
          let grown = card;
          let lim = limit;
          while (!grown.rows.some((r) => r.id === next) && grown.more > 0 && lim <= 20000) {
            state.current.rowLimits.set(a, lim);
            [grown] = await client.call('cards', { ids: [a], rowLimit: lim, rowLimits: { [a]: lim } });
            lim *= 2;
          }
          state.current.cards.set(a, grown);
          changed = true;
        }
      }
    }
    if (changed) rebuild({ animate: false });
    const target = state.current.expanded.has(id) ? id : (parentCardOf(id) ?? id);
    return nodeKey(target);
  };

  // Create the view once.
  useEffect(() => {
    const view = new GraphView(hostRef.current!, {
      onNodeClick(node, row) {
        const r = row >= 0 ? node.rows?.[row] : undefined;
        if (r?.expandable && r.ref !== undefined && !r.expanded) void toggle(r.ref as number);
        const id = r?.ref !== undefined ? (r.ref as number) : (node.ref as number);
        ctxRef.current.select(id, { source: 'graph' });
      },
      onToggle(node, row) {
        const r = node.rows?.[row];
        if (r?.ref !== undefined) void toggle(r.ref as number);
      },
      onNodeDoubleClick(node, row) {
        const r = row >= 0 ? node.rows?.[row] : undefined;
        if (r?.expandable && r.ref !== undefined) void toggle(r.ref as number);
        else view.focus(node.key, { zoom: Math.max(view.zoom, 1) });
      },
      onAction(node) {
        void showMore(node.ref as number);
      },
      onHover(node, row) {
        if (!node || row < 0) return setTip(null);
        const r = node.rows?.[row];
        if (!r || r.action) return setTip(null);
        const full = `${r.key ?? ''}${r.key !== undefined && r.value !== undefined ? ': ' : ''}${r.value ?? ''}`;
        if (full.length * view.charWidth < node.w - 30) return setTip(null);
        setTip({ x: mouse.current.x, y: mouse.current.y, head: r.key ?? '', body: r.value ?? '' });
      },
      onContextMenu(node, row, ev) {
        if (!node) return;
        const r = row >= 0 ? node.rows?.[row] : undefined;
        const id = r?.ref !== undefined && !r.action ? (r.ref as number) : (node.ref as number);
        ctxRef.current.select(id);
        openMenu(nodeMenu(id, r?.expandable ? (r.ref as number) : node.ref === state.current.root ? null : (node.ref as number)), { x: ev.clientX, y: ev.clientY });
      },
      onBackgroundClick() {
        ctxRef.current.select(null);
      },
      onViewport(k) {
        setZoom(k);
      },
    });
    view.animations = app.get().settings.animations;
    view.showMinimap = app.get().settings.minimap;
    viewRef.current = view;
    const move = (e: MouseEvent) => {
      mouse.current = { x: e.clientX, y: e.clientY };
    };
    view.canvas.addEventListener('mousemove', move);
    let cancelled = false;
    (async () => {
      const s = app.get().settings;
      const init = await client.call('initial', { depth: s.initialDepth, budget: Math.min(400, s.maxVisibleNodes), rowLimit: s.childPageSize });
      if (cancelled) return;
      state.current = { root: summary.root, cards: new Map(init.cards.map((c) => [c.id, c])), expanded: new Set(init.expanded), rowLimits: new Map() };
      rebuild({ fit: true });
      // Legible start: rather than shrinking a big graph to fit, start at the
      // root (left edge, or top for top-down layouts) at a readable zoom.
      view.frameStart(nodeKey(summary.root), s.direction === 'LR' ? 'left' : 'top');
      setZoom(view.zoom);
    })();
    return () => {
      cancelled = true;
      view.canvas.removeEventListener('mousemove', move);
      view.destroy();
      viewRef.current = null;
    };
  }, [client, summary]);

  // Settings that affect rendering.
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.animations = settings.animations;
    v.showMinimap = settings.minimap;
    if (state.current.cards.size) rebuild({ animate: true, fit: true });
  }, [settings.direction, settings.minimap, settings.animations]);

  // Selection highlight.
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    if (ctx.selected === null) return v.setSelection(null);
    const key = state.current.expanded.has(ctx.selected) ? nodeKey(ctx.selected) : (() => {
      const p = parentCardOf(ctx.selected!);
      return p !== null ? nodeKey(p) : nodeKey(ctx.selected!);
    })();
    v.setSelection(key);
  }, [ctx.selected]);

  // Search hits: highlight cards that contain hits.
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const keys = new Set<string>();
    for (const id of ctx.hits.slice(0, 5000)) {
      if (state.current.expanded.has(id)) keys.add(nodeKey(id));
      const p = parentCardOf(id);
      if (p !== null) keys.add(nodeKey(p));
    }
    v.setMatches(keys);
  }, [ctx.hits, ctx.hitVersion]);

  // Navigate to the active hit / external reveal requests.
  const goTo = async (id: number, zoom?: number) => {
    const key = await ensureVisible(id);
    const v = viewRef.current;
    if (!key || !v) return;
    v.focus(key, { zoom: zoom ?? Math.max(v.zoom, 0.9) });
  };
  useEffect(() => {
    if (ctx.hitIndex >= 0 && ctx.hits[ctx.hitIndex] !== undefined) void goTo(ctx.hits[ctx.hitIndex]);
  }, [ctx.hitVersion]);
  useEffect(() => {
    if (ctx.reveal) void goTo(ctx.reveal.id);
  }, [ctx.reveal?.seq]);

  const nodeMenu = (id: number, container: number | null): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Copy path', icon: 'link', onSelect: () => client.call('detail', { id, maxChars: 0 }).then((d) => copy(d.path, `Copied ${d.path}`)) },
      { label: 'Copy value', icon: 'copy', onSelect: () => client.call('detail', { id, maxChars: 5_000_000 }).then((d) => copy(d.value, 'Value copied')) },
      { label: 'Copy as JSON', icon: 'braces', onSelect: () => client.call('json', { id, indent: 2, maxChars: 20_000_000 }).then((t) => copy(t, 'JSON copied')) },
    ];
    if (ctx.summary && host().kind === 'vscode') items.push({ label: 'Reveal in editor', icon: 'external', onSelect: () => ctxRef.current.revealInEditor(id) });
    if (container !== null) {
      items.push({ separator: true });
      items.push({ label: 'Expand all below', icon: 'expand', onSelect: () => void expandAll(container) });
      if (state.current.expanded.has(container)) items.push({ label: 'Collapse', icon: 'collapse', onSelect: () => void toggle(container) });
      items.push({ label: 'Open in table', icon: 'table', onSelect: () => ctxRef.current.openTable(container) });
    }
    return items;
  };

  const expandAll = async (from = state.current.root) => {
    const s = app.get().settings;
    const r = await client.call('expandAll', { id: from, depth: 64, budget: s.maxVisibleNodes, rowLimit: s.childPageSize });
    for (const c of r.cards) state.current.cards.set(c.id, c);
    for (const id of r.expanded) state.current.expanded.add(id);
    rebuild({ animate: true, fit: from === state.current.root });
    if (r.cards.length >= s.maxVisibleNodes) toast(`Showing the first ${s.maxVisibleNodes.toLocaleString()} cards — raise “max visible nodes” in settings to see more.`);
  };

  useEffect(
    () =>
      registerCommands({
        fit: () => viewRef.current?.fit(),
        zoomIn: () => viewRef.current?.zoomBy(1.25),
        zoomOut: () => viewRef.current?.zoomBy(0.8),
        resetZoom: () => viewRef.current?.resetZoom(),
        center: () => {
          const sel = ctxRef.current.selected;
          if (sel !== null) void goTo(sel);
        },
        expandAll: () => expandAll(),
        collapseAll: () => {
          state.current.expanded = new Set([state.current.root]);
          rebuild({ animate: true, fit: true });
        },
        toggleDirection: () => updateSettings({ direction: app.get().settings.direction === 'LR' ? 'TB' : 'LR' }),
        exportPng: () => exportScene(viewRef.current!, 'png', baseName(ctx.target.name)),
        exportSvg: () => exportScene(viewRef.current!, 'svg', baseName(ctx.target.name)),
        exportJson: async () => {
          const id = ctxRef.current.selected ?? state.current.root;
          const text = await client.call('json', { id, indent: 2, maxChars: 200_000_000 });
          await host().request('saveFile', { name: `${baseName(ctx.target.name).replace(/\.[^.]+$/, '')}.json`, data: text, mime: 'application/json' });
        },
      }),
    [client],
  );

  return (
    <div class="graph-host" ref={hostRef}>
      <div class="floating br">
        <IconButton icon="minus" title="Zoom out" kbd="-" onClick={() => viewRef.current?.zoomBy(0.8)} />
        <span class="zoom-label">{Math.round(zoom * 100)}%</span>
        <IconButton icon="plus" title="Zoom in" kbd="+" onClick={() => viewRef.current?.zoomBy(1.25)} />
        <IconButton icon="fit" title="Fit to view" kbd="F" onClick={() => viewRef.current?.fit()} />
      </div>
      <div class="floating bl legend">
        <Legend xml={summary.xml} />
      </div>
      {tip && (
        <Tooltip x={tip.x} y={tip.y}>
          {tip.head && <div class="tt-head">{tip.head}</div>}
          {tip.body}
        </Tooltip>
      )}
      {menu}
    </div>
  );
}

function Legend({ xml }: { xml: boolean }) {
  const items: [string, string][] = xml
    ? [['element', 'var(--t-object)'], ['attribute', 'var(--k-interface)'], ['text', 'var(--t-string)']]
    : [['object', 'var(--t-object)'], ['array', 'var(--t-array)'], ['string', 'var(--t-string)'], ['number', 'var(--t-number)'], ['boolean', 'var(--t-boolean)'], ['null', 'var(--t-null)']];
  return (
    <>
      {items.map(([label, color]) => (
        <span key={label}>
          <i style={{ background: color }} />
          {label}
        </span>
      ))}
      <span title="Click a ● port or double-click a row to expand; drag to pan; scroll to zoom">
        <Icon name="info" class="" style={{ width: '12px', height: '12px' }} />
      </span>
    </>
  );
}

