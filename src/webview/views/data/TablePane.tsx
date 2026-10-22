/** Virtualized grid over an array of records (or any container), with sort, filter and drill-down. */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { PathSegment } from '../../../core/data/tree';
import { registerCommands } from '../../commands';
import { Icon } from '../../components/icons';
import { CenterMessage } from '../../components/ui';
import { host } from '../../store';
import type { TableInfo, TableRowData } from '../../worker/protocol';
import { useData } from './context';
import { stem } from '../shared';

const ROW = 26;
const HEAD = 32;
const PAGE = 100;

export function TablePane() {
  const ctx = useData();
  const { client, summary } = ctx;
  // Drill-down path; the last entry is the container being shown.
  const [trail, setTrail] = useState<{ id: number; label: string }[]>([{ id: ctx.tableTarget ?? summary.root, label: '$' }]);
  const target = trail[trail.length - 1].id;
  const [info, setInfo] = useState<TableInfo | null>(null);
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [filter, setFilter] = useState('');
  const [debounced, setDebounced] = useState('');
  const [total, setTotal] = useState(0);
  const pages = useRef(new Map<number, TableRowData[]>());
  const inflight = useRef(new Set<number>());
  const [, force] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [widths, setWidths] = useState<number[]>([]);
  const generation = useRef(0);
  const trailRef = useRef(trail);
  trailRef.current = trail;
  /** Trail by path, captured before a re-parse; the table waits until it is mapped to the new ids. */
  const restore = useRef<PathSegment[][] | null>(null);
  const pending = useRef(false);

  useEffect(
    () =>
      ctx.beforeReload(async () => {
        restore.current = await client.call('pathsOf', { ids: trailRef.current.map((t) => t.id) });
      }),
    [client],
  );

  // After a re-parse: the same containers again (as far as they still exist), with sort and filter kept.
  useEffect(() => {
    const paths = restore.current;
    restore.current = null;
    if (!paths) return;
    pending.current = true;
    void client.call('idsOf', { paths }).then((ids) => {
      pending.current = false;
      const end = ids.findIndex((id) => id < 0);
      const kept = (end < 0 ? ids : ids.slice(0, end)).map((id, i) => ({ id, label: trailRef.current[i]?.label ?? '$' }));
      setTrail(kept.length ? kept : [{ id: summary.root, label: '$' }]);
    });
  }, [summary]);

  // Follow external "open in table" requests.
  useEffect(() => {
    if (ctx.tableTarget !== null && ctx.tableTarget !== target) setTrail([{ id: ctx.tableTarget, label: '$' }]);
  }, [ctx.tableTarget]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(filter), 220);
    return () => clearTimeout(t);
  }, [filter]);

  useEffect(() => {
    if (pending.current) return;
    let alive = true;
    void client.call('tableInfo', { id: target, auto: trail.length === 1 && ctx.tableTarget === null }).then((i) => {
      if (!alive) return;
      if (i.id !== target) {
        // Jumped to the main array of records: show it as the first crumb.
        setTrail([{ id: i.id, label: i.path }]);
        return;
      }
      setInfo((prev) => {
        // A refresh of the same table keeps its sort and column widths.
        if (!prev || prev.path !== i.path || prev.columns.join('\u0000') !== i.columns.join('\u0000')) {
          setSort(null);
          setWidths([]);
        }
        return i;
      });
      setTotal(i.rows);
      pages.current.clear();
      inflight.current.clear();
      generation.current++;
      force((x) => x + 1);
    });
    return () => {
      alive = false;
    };
  }, [client, trail]);

  useEffect(() => {
    pages.current.clear();
    inflight.current.clear();
    generation.current++;
    force((x) => x + 1);
  }, [sort, debounced]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [info]);

  const columns = info?.columns ?? [];
  const loadPage = (p: number) => {
    if (!info || pages.current.has(p) || inflight.current.has(p)) return;
    inflight.current.add(p);
    const gen = generation.current;
    void client
      .call('tableRows', { id: target, start: p * PAGE, count: PAGE, columns, sort, filter: debounced || undefined })
      .then((r) => {
        if (gen !== generation.current) return;
        pages.current.set(p, r.rows);
        inflight.current.delete(p);
        setTotal(r.total);
        if (p === 0) setWidths((w) => (w.length ? w : computeWidths(columns, r.rows)));
        force((x) => x + 1);
      });
  };

  const first = Math.max(0, Math.floor((viewport.top - HEAD) / ROW) - 10);
  const last = Math.min(total, Math.ceil((viewport.top + viewport.height) / ROW) + 10);
  for (let p = Math.floor(first / PAGE); p <= Math.floor(Math.max(first, last - 1) / PAGE); p++) loadPage(p);

  const colWidths = useMemo(() => (widths.length === columns.length ? widths : columns.map((c) => Math.min(320, Math.max(90, c.length * 8 + 40)))), [widths, columns]);
  const totalWidth = 64 + colWidths.reduce((a, b) => a + b, 0);

  const drill = (id: number, label: string) => setTrail((t) => [...t, { id, label }]);

  useEffect(
    () =>
      registerCommands({
        exportJson: async () => {
          const text = await client.call('json', { id: target, indent: 2, maxChars: 200_000_000 });
          await host().request('saveFile', { name: `${stem(ctx.target.name)}.json`, data: text, mime: 'application/json' });
        },
      }),
    [target],
  );

  if (!info) return <CenterMessage spinner />;

  const header = (
    <div class="table-bar">
      <Icon name="table" />
      <span>
        {trail.length > 1 &&
          trail.slice(0, -1).map((t, i) => (
            <span key={i}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setTrail(trail.slice(0, i + 1));
                }}
              >
                {t.label}
              </a>
              {' › '}
            </span>
          ))}
        {trail.length > 1 && <b>{trail[trail.length - 1].label}</b>}
        {trail.length === 1 && info.path !== '$' && <span class="path" style={{ padding: '2px 7px', marginRight: '6px' }}>{info.path}</span>}
        {trail.length > 1 && ' — '}
        <b>{total.toLocaleString()}</b> {info.tabular ? 'rows' : 'entries'} × <b>{columns.length}</b> columns
        {!info.tabular && ' — select an array of objects for a record view'}
      </span>
      <span class="spacer" />
      <input placeholder="Filter rows…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
    </div>
  );

  const rows: JSX.Element[] = [];
  for (let i = first; i < last; i++) {
    const page = pages.current.get(Math.floor(i / PAGE));
    const row = page?.[i % PAGE];
    const top = HEAD + i * ROW;
    if (!row) {
      rows.push(<div key={`p${i}`} class="grow-row placeholder" style={{ top: `${top}px`, width: `${totalWidth}px` }} />);
      continue;
    }
    rows.push(
      <div
        key={row.id}
        class={`grow-row ${ctx.selected === row.id ? 'selected' : ''}`}
        style={{ top: `${top}px`, width: `${totalWidth}px` }}
        onClick={() => ctx.select(row.id, { source: 'table' })}
      >
        <div class="gcell idx" style={{ width: '64px' }}>
          {row.index}
        </div>
        {row.cells.map((c, k) => {
          if (!c) return <div key={k} class="gcell empty" style={{ width: `${colWidths[k]}px` }} />;
          const nested = c.type === 'object' || c.type === 'array';
          return (
            <div
              key={k}
              class={`gcell ${nested ? 'nested' : `v-${c.type}`}`}
              style={{ width: `${colWidths[k]}px` }}
              title={c.preview}
              onClick={(e) => {
                if (nested && c.count > 0) {
                  e.stopPropagation();
                  drill(c.id, `[${row.index}].${columns[k]}`);
                } else ctx.select(c.id, { source: 'table' });
              }}
            >
              {nested ? (c.type === 'array' ? `[${c.count}]` : `{${c.count}}`) : c.type === 'null' ? 'null' : c.preview}
            </div>
          );
        })}
      </div>,
    );
  }

  return (
    <div class="view-fill">
      {header}
      <div class="table-wrap" ref={scrollRef}>
        <div class="grid-inner" style={{ height: `${HEAD + total * ROW}px`, width: `${totalWidth}px` }}>
          <div class="grow-row ghead" style={{ width: `${totalWidth}px` }}>
            <div class="gcell idx" style={{ width: '64px' }}>
              #
            </div>
            {columns.map((c, k) => (
              <div
                key={c}
                class={`gcell ${sort?.column === c ? 'sorted' : ''}`}
                style={{ width: `${colWidths[k]}px` }}
                title={`Sort by ${c}`}
                onClick={() => setSort((s) => (s?.column !== c ? { column: c, desc: false } : !s.desc ? { column: c, desc: true } : null))}
              >
                {c}
                {sort?.column === c && <Icon name={sort.desc ? 'chevronDown' : 'chevronUp'} />}
              </div>
            ))}
          </div>
          {rows}
        </div>
      </div>
    </div>
  );
}

function computeWidths(columns: string[], rows: TableRowData[]): number[] {
  return columns.map((c, k) => {
    let max = c.length + 2;
    for (const r of rows.slice(0, 60)) {
      const cell = r.cells[k];
      if (cell) max = Math.max(max, Math.min(48, cell.preview.length));
    }
    return Math.round(Math.min(380, Math.max(80, max * 7.4 + 26)));
  });
}
