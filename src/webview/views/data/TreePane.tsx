/** Virtualized, keyboard-navigable tree of a data document (handles millions of children via paging). */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { EditCaps } from '../../../core/data/edit';
import type { PathSegment } from '../../../core/data/tree';
import { registerCommands } from '../../commands';
import { Icon } from '../../components/icons';
import { useMenu, VirtualList, type MenuItem } from '../../components/ui';
import { keyLabel, valueLabel } from '../../scenes/data-graph';
import { app, copy, setSearch, toast, useStore } from '../../store';
import { colorOf } from '../../values';
import type { NodeInfo, Summary } from '../../worker/protocol';
import { copyValue } from './actions';
import { useData } from './context';
import { similarPath } from './paths';

const ROW = 24;
const DIFF_GLYPH: Record<string, string> = { added: '+', changed: '~', type: '≠', moved: '↕' };
const PAGE = 500;

interface FlatRow {
  id: number;
  depth: number;
  info: NodeInfo | null;
  /** "Load more" row for a parent with unloaded children. */
  more?: { parent: number; loaded: number; total: number };
}

/** Tree state kept across tab switches (ids stay valid until the document is re-parsed). */
interface Saved {
  summary: Summary;
  root: NodeInfo | null;
  expanded: Set<number>;
  kids: Map<number, NodeInfo[]>;
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
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  /** Expanded nodes by path, captured before a re-parse so that edits keep the tree open. */
  const restore = useRef<PathSegment[][] | null>(null);

  const isContainer = (n: NodeInfo) => (n.type === 'object' || n.type === 'array') && n.count > 0;

  const load = async (id: number, offset = 0) => {
    const list = await client.call('children', { id, offset, limit: page });
    const cur = kids.current.get(id) ?? [];
    kids.current.set(id, offset === 0 ? list : [...cur, ...list]);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = ctx.memo.get('tree') as Saved | undefined;
      const paths = restore.current;
      restore.current = null;
      if (saved?.summary === summary) {
        rootInfo.current = saved.root;
        expanded.current = saved.expanded;
        kids.current = saved.kids;
        return bump();
      }
      const r = await client.call('node', { id: summary.root });
      rootInfo.current = r;
      expanded.current = new Set([summary.root]);
      kids.current = new Map();
      if (isContainer(r)) await load(summary.root);
      if (paths) {
        // Ids are pre-order, so ascending order loads parents before their children.
        const ids = (await client.call('idsOf', { paths })).filter((id) => id >= 0).sort((a, b) => a - b);
        for (const id of ids) {
          expanded.current.add(id);
          if (!kids.current.has(id)) await load(id);
        }
      } else if (summary.nodes < 2000) {
        // Open the first level of small documents.
        for (const c of (kids.current.get(summary.root) ?? []).slice(0, 20)) if (isContainer(c)) {
          expanded.current.add(c.id);
          await load(c.id);
        }
      }
      if (alive) bump();
    })();
    return () => {
      alive = false;
    };
  }, [client, summary]);

  useEffect(() => {
    const unhook = ctx.beforeReload(async () => {
      restore.current = await client.call('pathsOf', { ids: [...expanded.current] });
    });
    return () => {
      unhook();
      ctxRef.current.memo.set('tree', { summary: ctxRef.current.summary, root: rootInfo.current, expanded: expanded.current, kids: kids.current } satisfies Saved);
    };
  }, [client]);

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

  const menuFor = (id: number, edit?: EditCaps, isObject = false): MenuItem[] => [
    { label: 'Copy path', icon: 'link', onSelect: () => client.call('detail', { id, maxChars: 0 }).then((d) => copy(d.path, `Copied ${d.path}`)) },
    { label: 'Copy value', icon: 'copy', onSelect: () => void copyValue(client, id) },
    { label: 'Copy as JSON', icon: 'braces', onSelect: () => client.call('json', { id, indent: 2, maxChars: 20_000_000 }).then((t) => copy(t, 'JSON copied'), (e: Error) => toast(e.message, 'error')) },
    { label: 'Copy as YAML', icon: 'fileText', onSelect: () => client.call('convert', { id, to: 'yaml' }).then((t) => copy(t, 'YAML copied'), (e: Error) => toast(e.message, 'error')) },
    {
      label: 'Find all like this',
      icon: 'search',
      onSelect: () =>
        client.call('detail', { id, maxChars: 0 }).then((d) => {
          const query = similarPath(d.segments);
          if (query) setSearch({ path: true, query });
          else toast('This value is not inside an array, so there is nothing like it to find.');
        }),
    },
    ...editItems(id, edit, isObject),
  ];

  const editItems = (id: number, edit: EditCaps | undefined, isObject: boolean): MenuItem[] => {
    if (!edit || !(edit.set || edit.rename || edit.add || edit.delete)) return [];
    const ask = (mode: 'set' | 'rename' | 'add' | 'delete') => () => ctx.requestEdit(id, mode);
    return [
      { separator: true },
      ...(edit.set ? [{ label: 'Edit value…', icon: 'code' as const, kbd: 'F2', onSelect: ask('set') }] : []),
      ...(edit.rename ? [{ label: 'Rename key…', icon: 'fileText' as const, onSelect: ask('rename') }] : []),
      ...(edit.add ? [{ label: isObject ? 'Add property…' : 'Add item…', icon: 'plus' as const, onSelect: ask('add') }] : []),
      ...(edit.delete ? [{ label: 'Delete…', icon: 'x' as const, kbd: 'Del', onSelect: ask('delete') }] : []),
    ];
  };

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
    const swatch = n.type === 'string' && n.inline === undefined ? colorOf(n.preview, n.key) : null;
    return (
      <div
        key={n.id}
        class={`trow ${ctx.selected === n.id ? 'selected' : ''} ${hitSet.has(n.id) ? 'match' : ''} ${ctx.validation?.byId.has(n.id) ? 'invalid' : ''}`}
        title={ctx.validation?.byId.get(n.id)?.join('\n')}
        style={{ top: `${i * ROW}px`, paddingLeft: `${pad}px` }}
        onClick={() => ctx.select(n.id, { source: 'tree' })}
        onDblClick={() => container && void toggle(n.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          ctx.select(n.id);
          const at = { x: e.clientX, y: e.clientY };
          if (!ctx.edit) return openMenu(menuFor(n.id), at);
          void client.call('editCaps', { id: n.id }).then(
            (caps) => openMenu(menuFor(n.id, caps, n.type === 'object'), at),
            () => openMenu(menuFor(n.id), at),
          );
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
        {ctx.diffMarks?.has(n.id) && <span class={`dmark k-${ctx.diffMarks.get(n.id)}`}>{DIFF_GLYPH[ctx.diffMarks.get(n.id)!]}</span>}
        <span class="tkey" style={typeof n.key === 'number' ? { color: 'var(--text-faint)' } : n.attr ? { color: 'var(--k-interface)' } : undefined}>
          {key}
        </span>
        <span class="tsep">:</span>
        {container ? (
          <span class={`tcount v-${n.type}`}>{valueLabel(n)}</span>
        ) : (
          <>
            {swatch && <i class="swatch" style={{ background: swatch }} />}
            <span class={`tval ${n.error ? 'v-error' : n.inline !== undefined ? 'v-string' : `v-${n.type}`}`}>{n.type === 'string' && n.inline === undefined ? JSON.stringify(n.preview).slice(1, -1) || '""' : valueLabel(n)}</span>
          </>
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
