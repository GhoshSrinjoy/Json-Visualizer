/** Card graph of a data document (JSON-Crack style, but paged, keyboard-driven and canvas-rendered). */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { EditCaps } from '../../../core/data/edit';
import type { PathSegment } from '../../../core/data/tree';
import { registerCommands } from '../../commands';
import { Icon } from '../../components/icons';
import { IconButton, Tooltip, useMenu, type MenuItem } from '../../components/ui';
import { GraphView, type Camera } from '../../engine/view';
import { buildDataScene, nodeKey, type DataGraphState } from '../../scenes/data-graph';
import { app, copy, host, setSearch, toast, updateSettings, useStore } from '../../store';
import { valueHints } from '../../values';
import type { CardData, NodeInfo, Summary } from '../../worker/protocol';
import { copyValue } from './actions';
import { useData } from './context';
import { similarPath } from './paths';
import { baseName, exportScene } from '../shared';

/** The subtree the graph is narrowed to ("Focus on this"). */
interface Focus {
  id: number;
  path: string;
  label: string;
}

/** View state kept across tab switches (node ids stay valid until the document is re-parsed). */
interface Saved {
  summary: Summary;
  state: DataGraphState;
  camera: Camera;
  focus: Focus | null;
}

/** Expanded cards by path, captured before a re-parse so that edits don't collapse the graph. */
interface Restore {
  expanded: PathSegment[][];
  limits: [PathSegment[], number][];
  focus: PathSegment[] | null;
  camera: Camera;
}

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Home']);

const isContainer = (n: NodeInfo | undefined): boolean => !!n && (n.type === 'object' || n.type === 'array') && n.inline === undefined && n.count > 0;
const keyText = (key: string | number | null) => (key === null ? '$' : typeof key === 'number' ? `[${key}]` : key);

export function GraphPane() {
  const ctx = useData();
  const { client, summary } = ctx;
  const settings = useStore(app, (s) => s.settings);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<GraphView | null>(null);
  const state = useRef<DataGraphState>({ root: summary.root, cards: new Map(), expanded: new Set(), rowLimits: new Map() });
  const [focus, setFocusState] = useState<Focus | null>(null);
  const focusRef = useRef<Focus | null>(null);
  const restore = useRef<Restore | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tip, setTip] = useState<{ x: number; y: number; head: string; body: string; image?: string; color?: string } | null>(null);
  const hoverId = useRef(-1);
  const [menu, openMenu] = useMenu();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const mouse = useRef({ x: 0, y: 0 });
  // Functions below run from view callbacks created once per document: they read
  // everything that changes (summary, selection, settings) through refs.

  const setFocus = (f: Focus | null) => {
    focusRef.current = f;
    setFocusState(f);
  };

  const rebuild = (opts: { animate?: boolean; fit?: boolean; anchor?: string } = {}) => {
    const view = viewRef.current;
    if (!view) return;
    const s = app.get().settings;
    const scene = buildDataScene(state.current, {
      direction: s.direction,
      charW: view.charWidth,
      rootTitle: focusRef.current?.label ?? baseName(ctxRef.current.target.name),
      xml: ctxRef.current.summary.xml,
      pageSize: s.childPageSize,
      edgeLabels: s.edgeLabels,
      marks: ctxRef.current.diffMarks ?? undefined,
      invalid: ctxRef.current.validation?.byId.size ? new Set(ctxRef.current.validation.byId.keys()) : undefined,
    });
    view.setScene(scene, opts);
    app.set({ status: `${scene.nodes.length.toLocaleString()} cards` });
    // Outline the cards that show invalid values.
    const bad = new Set<string>();
    for (const id of ctxRef.current.validation?.byId.keys() ?? []) {
      if (state.current.expanded.has(id)) bad.add(nodeKey(id));
      const p = parentCardOf(id);
      if (p !== null) bad.add(nodeKey(p));
    }
    view.setErrors(bad);
    syncSelection();
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

  /** Card and row that show a node: its row in the parent card, or its own card (root). */
  const locate = (id: number): { key: string; row: number } | null => {
    const parent = parentCardOf(id);
    if (parent === null) return state.current.expanded.has(id) ? { key: nodeKey(id), row: -1 } : null;
    const row = viewRef.current?.node(nodeKey(parent))?.rows?.findIndex((r) => r.ref === id && !r.action) ?? -1;
    return { key: nodeKey(parent), row };
  };

  const syncSelection = () => {
    const v = viewRef.current;
    if (!v) return;
    const sel = ctxRef.current.selected;
    const at = sel === null ? null : locate(sel);
    if (sel === null) v.setSelection(null);
    else v.setSelection(state.current.expanded.has(sel) && v.node(nodeKey(sel)) ? nodeKey(sel) : (at?.key ?? nodeKey(sel)));
    v.setSelectedRow(at && at.row >= 0 ? at.key : null, at?.row ?? -1);
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
    // A node outside the focused subtree ends the focus.
    if (focusRef.current && id !== state.current.root && !ancestors.includes(state.current.root)) {
      state.current.root = ctxRef.current.summary.root;
      state.current.expanded.add(state.current.root);
      setFocus(null);
    }
    const chain = [...ancestors, id].filter((a) => a >= state.current.root);
    if (!chain.length) return null;
    let changed = false;
    for (let i = 0; i < chain.length; i++) {
      const a = chain[i];
      const info = await client.call('node', { id: a });
      const container = (info.type === 'object' || info.type === 'array') && info.inline === undefined;
      if (!container) break;
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

  const frameRoot = () => viewRef.current?.frameStart(nodeKey(state.current.root), app.get().settings.direction === 'LR' ? 'left' : 'top');

  const focusOn = async (id: number) => {
    const d = await client.call('detail', { id, maxChars: 0 });
    await fetchCards([id]);
    state.current.root = id;
    state.current.expanded.add(id);
    setFocus({ id, path: d.path, label: keyText(d.key) });
    rebuild({ fit: true });
    frameRoot();
  };

  const unfocus = async () => {
    const was = state.current.root;
    state.current.root = ctxRef.current.summary.root;
    state.current.expanded.add(state.current.root);
    setFocus(null);
    const key = await ensureVisible(was);
    rebuild({ fit: true });
    if (key) viewRef.current?.focus(nodeKey(was), { zoom: Math.max(viewRef.current.zoom, 0.8) });
  };

  /** Selects a node from the keyboard and pans just enough to show it. */
  const go = (id: number) => {
    ctxRef.current.select(id, { source: 'graph' });
    const at = locate(id);
    if (at) viewRef.current?.reveal(at.key, at.row);
  };

  /** Tree-style keys: ↑/↓ siblings, → expand / first child, ← collapse / parent, Enter toggles, Home goes to the root. */
  const navigate = async (key: string) => {
    const s = state.current;
    const cur = ctxRef.current.selected ?? s.root;
    const parent = cur === s.root ? null : parentCardOf(cur);
    if (key === 'Home' || (parent === null && cur !== s.root && !s.expanded.has(cur))) return go(s.root);
    const rows = parent !== null ? s.cards.get(parent)!.rows : [];
    const i = rows.findIndex((r) => r.id === cur);
    const container = isContainer(i >= 0 ? rows[i] : s.cards.get(cur));
    const open = s.expanded.has(cur);
    switch (key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const step = key === 'ArrowDown' ? 1 : -1;
        if (parent === null) {
          const first = s.cards.get(cur)?.rows[0];
          if (step > 0 && open && first) go(first.id);
          return;
        }
        if (rows[i + step]) return go(rows[i + step].id);
        if (step > 0 && (s.cards.get(parent)?.more ?? 0) > 0) {
          await showMore(parent);
          const next = s.cards.get(parent)?.rows[i + 1];
          if (next) go(next.id);
        } else if (step < 0) go(parent);
        return;
      }
      case 'ArrowRight': {
        if (!container) return;
        if (!open) {
          await toggle(cur);
          return go(cur);
        }
        const first = s.cards.get(cur)?.rows[0];
        if (first) go(first.id);
        return;
      }
      case 'ArrowLeft':
        if (container && open && cur !== s.root) {
          await toggle(cur);
          return go(cur);
        }
        if (parent !== null) go(parent);
        return;
      default:
        if (container && cur !== s.root) {
          await toggle(cur);
          go(cur);
        }
    }
  };

  // Create the view once per document.
  useEffect(() => {
    const view = new GraphView(hostRef.current!, {
      onNodeClick(node, row) {
        const r = row >= 0 ? node.rows?.[row] : undefined;
        if (r?.expandable && r.ref !== undefined && !r.expanded) void toggle(r.ref as number);
        const id = r?.ref !== undefined ? (r.ref as number) : (node.ref as number);
        ctxRef.current.select(id, { source: 'graph' });
        view.canvas.focus({ preventScroll: true });
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
        const r = node && row >= 0 ? node.rows?.[row] : undefined;
        const id = r && !r.action && typeof r.ref === 'number' ? r.ref : -1;
        if (id === hoverId.current) return;
        hoverId.current = id;
        if (!r || id < 0) return setTip(null);
        const at = { x: mouse.current.x, y: mouse.current.y, head: r.key ?? '' };
        const problems = ctxRef.current.validation?.byId.get(id);
        if (problems) return setTip({ ...at, head: `${r.key ?? ''}: not valid`, body: problems.join('\n') });
        if (r.swatch) return setTip({ ...at, body: r.value ?? '', color: r.swatch });
        // Image links get a thumbnail; previews are truncated, so read the whole value first.
        if (r.valueColor === 'string' && /^(?:https?:\/\/|data:image\/)/i.test(r.value ?? '')) {
          void client.call('detail', { id, maxChars: 4_000_000 }).then((d) => {
            const img = valueHints(d.type, d.value, d.key).find((h) => h.kind === 'image');
            if (img && hoverId.current === id) setTip({ ...at, x: mouse.current.x, y: mouse.current.y, body: '', image: img.url });
          });
        }
        const full = `${r.key ?? ''}${r.key !== undefined && r.value !== undefined ? ': ' : ''}${r.value ?? ''}`;
        if (full.length * view.charWidth < node!.w - 30) return setTip(null);
        setTip({ ...at, body: r.value ?? '' });
      },
      onContextMenu(node, row, ev) {
        if (!node) return;
        const r = row >= 0 ? node.rows?.[row] : undefined;
        const id = r?.ref !== undefined && !r.action ? (r.ref as number) : (node.ref as number);
        ctxRef.current.select(id);
        const container = r?.expandable ? (r.ref as number) : r ? null : (node.ref as number);
        const at = { x: ev.clientX, y: ev.clientY };
        if (!ctxRef.current.edit) return openMenu(nodeMenu(id, container), at);
        void Promise.all([client.call('editCaps', { id }), client.call('node', { id })]).then(
          ([caps, info]) => openMenu(nodeMenu(id, container, caps, info.type === 'object'), at),
          () => openMenu(nodeMenu(id, container), at),
        );
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
    const onKey = (e: KeyboardEvent) => {
      if (!NAV_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
      // Only when the graph (or nothing in particular) has focus: never steal keys from buttons, inputs or menus.
      const t = e.target;
      if (t instanceof Node && t !== document.body && t !== document.documentElement && !hostRef.current?.contains(t)) return;
      e.preventDefault();
      void navigate(e.key);
    };
    window.addEventListener('keydown', onKey);
    const unhook = ctxRef.current.beforeReload(async () => {
      const s = state.current;
      const limits = [...s.rowLimits.entries()];
      const ids = [...s.expanded, ...limits.map(([id]) => id), s.root];
      const paths = await client.call('pathsOf', { ids });
      restore.current = {
        expanded: paths.slice(0, s.expanded.size),
        limits: limits.map(([, n], i) => [paths[s.expanded.size + i], n]),
        focus: focusRef.current ? paths[paths.length - 1] : null,
        camera: view.camera,
      };
    });
    return () => {
      unhook();
      ctxRef.current.memo.set('graph', { summary: ctxRef.current.summary, state: state.current, camera: view.camera, focus: focusRef.current } satisfies Saved);
      window.removeEventListener('keydown', onKey);
      view.canvas.removeEventListener('mousemove', move);
      view.destroy();
      viewRef.current = null;
    };
  }, [client]);

  // Cards for the document: restored after a tab switch or an edit, or the initial expansion.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    (async () => {
      const s = app.get().settings;
      const saved = ctxRef.current.memo.get('graph') as Saved | undefined;
      const r = restore.current;
      restore.current = null;
      if (saved?.summary === summary) {
        state.current = saved.state;
        setFocus(saved.focus);
        rebuild();
        view.camera = saved.camera;
      } else if (r) {
        const ids = await client.call('idsOf', { paths: [...r.expanded, ...r.limits.map(([p]) => p), ...(r.focus ? [r.focus] : [])] });
        if (cancelled) return;
        const root = r.focus ? ids[ids.length - 1] : -1;
        const rowLimits = new Map<number, number>();
        r.limits.forEach(([, n], i) => ids[r.expanded.length + i] >= 0 && rowLimits.set(ids[r.expanded.length + i], n));
        state.current = { root: root >= 0 ? root : summary.root, cards: new Map(), expanded: new Set([summary.root, ...ids.slice(0, r.expanded.length).filter((id) => id >= 0)]), rowLimits };
        if (root < 0) setFocus(null);
        else if (focusRef.current) setFocus({ ...focusRef.current, id: root });
        await fetchCards([...state.current.expanded]);
        if (cancelled) return;
        rebuild();
        view.camera = r.camera;
      } else {
        const init = await client.call('initial', { depth: s.initialDepth, budget: Math.min(400, s.maxVisibleNodes), rowLimit: s.childPageSize });
        if (cancelled) return;
        state.current = { root: summary.root, cards: new Map(init.cards.map((c) => [c.id, c])), expanded: new Set(init.expanded), rowLimits: new Map() };
        setFocus(null);
        rebuild({ fit: true });
        // Legible start: rather than shrinking a big graph to fit, start at the
        // root (left edge, or top for top-down layouts) at a readable zoom.
        frameRoot();
      }
      setZoom(view.zoom);
    })();
    return () => {
      cancelled = true;
    };
  }, [summary]);

  // Settings that affect rendering (only on change: the mount is handled above).
  const shown = useRef(settings);
  useEffect(() => {
    const v = viewRef.current;
    const prev = shown.current;
    shown.current = settings;
    if (!v) return;
    v.animations = settings.animations;
    v.showMinimap = settings.minimap;
    if (!state.current.cards.size) return;
    if (prev.direction !== settings.direction) rebuild({ animate: true, fit: true });
    // Labels only widen the gaps: keep the root card still instead of re-fitting.
    else if (prev.edgeLabels !== settings.edgeLabels) rebuild({ animate: true, anchor: nodeKey(state.current.root) });
    else if (prev.minimap !== settings.minimap) v.invalidate();
  }, [settings.direction, settings.minimap, settings.animations, settings.edgeLabels]);

  // Comparison markers and schema errors.
  useEffect(() => {
    if (state.current.cards.size) rebuild();
  }, [ctx.diffMarks, ctx.validation]);

  // Selection highlight (card and row).
  useEffect(syncSelection, [ctx.selected]);

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

  const nodeMenu = (id: number, container: number | null, edit?: EditCaps, isObject = false): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Copy path', icon: 'link', onSelect: () => client.call('detail', { id, maxChars: 0 }).then((d) => copy(d.path, `Copied ${d.path}`)) },
      { label: 'Copy value', icon: 'copy', onSelect: () => void copyValue(client, id) },
      { label: 'Copy as JSON', icon: 'braces', onSelect: () => client.call('json', { id, indent: 2, maxChars: 20_000_000 }).then((t) => copy(t, 'JSON copied'), (e: Error) => toast(e.message, 'error')) },
      { label: 'Copy as YAML', icon: 'fileText', onSelect: () => client.call('convert', { id, to: 'yaml' }).then((t) => copy(t, 'YAML copied'), (e: Error) => toast(e.message, 'error')) },
      { label: 'Find all like this', icon: 'search', onSelect: () => void findSimilar(id) },
    ];
    if (edit && (edit.set || edit.rename || edit.add || edit.delete)) {
      const ask = (mode: 'set' | 'rename' | 'add' | 'delete') => () => ctxRef.current.requestEdit(id, mode);
      items.push({ separator: true });
      if (edit.set) items.push({ label: 'Edit value…', icon: 'code', kbd: 'F2', onSelect: ask('set') });
      if (edit.rename) items.push({ label: 'Rename key…', icon: 'fileText', onSelect: ask('rename') });
      if (edit.add) items.push({ label: isObject ? 'Add property…' : 'Add item…', icon: 'plus', onSelect: ask('add') });
      if (edit.delete) items.push({ label: 'Delete…', icon: 'x', kbd: 'Del', onSelect: ask('delete') });
    }
    if (host().kind === 'vscode') items.push({ label: 'Reveal in editor', icon: 'external', onSelect: () => ctxRef.current.revealInEditor(id) });
    if (container !== null) {
      items.push({ separator: true });
      items.push({ label: 'Expand 1 level', icon: 'expand', onSelect: () => void expandAll(container, 1) });
      items.push({ label: 'Expand 2 levels', icon: 'expand', onSelect: () => void expandAll(container, 2) });
      items.push({ label: 'Expand all below', icon: 'expand', kbd: container === state.current.root ? 'E' : undefined, onSelect: () => void expandAll(container) });
      if (state.current.expanded.has(container) && container !== state.current.root) items.push({ label: 'Collapse', icon: 'collapse', onSelect: () => void toggle(container) });
      if (container !== state.current.root) items.push({ label: 'Focus on this', icon: 'target', onSelect: () => void focusOn(container) });
      items.push({ label: 'Open in table', icon: 'table', onSelect: () => ctxRef.current.openTable(container) });
    }
    return items;
  };

  /** Every value at the same place in the enclosing arrays, as a JSONPath search. */
  const findSimilar = async (id: number) => {
    const d = await client.call('detail', { id, maxChars: 0 });
    const query = similarPath(d.segments);
    if (query) setSearch({ path: true, query });
    else toast('This value is not inside an array, so there is nothing like it to find.');
  };

  const expandAll = async (from = state.current.root, depth = 64) => {
    const s = app.get().settings;
    const r = await client.call('expandAll', { id: from, depth, budget: s.maxVisibleNodes, rowLimit: s.childPageSize });
    for (const c of r.cards) state.current.cards.set(c.id, c);
    for (const id of r.expanded) state.current.expanded.add(id);
    const anchor = parentCardOf(from) ?? from;
    rebuild({ animate: true, fit: from === state.current.root && depth > 2, anchor: nodeKey(anchor) });
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
        toggleEdgeLabels: () => updateSettings({ edgeLabels: !app.get().settings.edgeLabels }),
        exportPng: () => exportScene(viewRef.current!, 'png', baseName(ctx.target.name)),
        exportSvg: () => exportScene(viewRef.current!, 'svg', baseName(ctx.target.name)),
        exportJson: async () => {
          const id = ctxRef.current.selected ?? state.current.root;
          try {
            const text = await client.call('json', { id, indent: 2, maxChars: 1_000_000_000 });
            await host().request('saveFile', { name: `${baseName(ctx.target.name).replace(/\.[^.]+$/, '')}.json`, data: text, mime: 'application/json' });
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        },
      }),
    [client],
  );

  return (
    <div class="graph-host" ref={hostRef}>
      {focus && (
        <div class="floating tl focus-bar">
          <button class="btn" onClick={() => void unfocus()} title="Show the whole document again">
            <Icon name="x" /> Whole document
          </button>
          <span class="focus-path" title={focus.path}>
            {focus.path}
          </span>
        </div>
      )}
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
          {tip.color && <i class="tt-swatch" style={{ background: tip.color }} />}
          {tip.image && <img class="tt-image" src={tip.image} alt="" referrerpolicy="no-referrer" onError={() => setTip(null)} />}
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
      <span title="Click a ● port or double-click a row to expand · arrow keys move (→ expand, ← collapse, Enter toggles) · right-click a card to focus on it · drag to pan, scroll to zoom">
        <Icon name="info" class="" style={{ width: '12px', height: '12px' }} />
      </span>
    </>
  );
}
