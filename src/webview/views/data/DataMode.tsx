/** Data documents (JSON, YAML, XML, TOML, CSV…): loads into the worker and hosts the panes. */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatBytes } from '../../../core/util/strings';
import type { DataView, Target } from '../../../shared/protocol';
import { registerCommands } from '../../commands';
import { CenterMessage } from '../../components/ui';
import { app, host, logError, setSearch, useStore } from '../../store';
import { DataClient } from '../../worker/client';
import type { Summary } from '../../worker/protocol';
import { DataContext, type DataCtx } from './context';
import { GraphPane } from './GraphPane';
import { DataInspector } from './Inspector';
import { SchemaPane } from './SchemaPane';
import { TablePane } from './TablePane';
import { TextPane } from './TextPane';
import { TreePane } from './TreePane';

let revealSeq = 0;

export function DataMode({ target }: { target: Target }) {
  const client = useMemo(() => new DataClient(), [target.uri]);
  useEffect(() => () => client.terminate(), [client]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [hits, setHits] = useState<number[]>([]);
  const [hitIndex, setHitIndex] = useState(-1);
  const [hitVersion, setHitVersion] = useState(0);
  const [reveal, setReveal] = useState<{ id: number; seq: number } | null>(null);
  const [tableTarget, setTableTarget] = useState<number | null>(null);
  const view = useStore(app, (s) => s.view) as DataView;
  const search = useStore(app, (s) => s.search);
  const docVersion = useStore(app, (s) => s.docVersion);
  const inspectorOpen = useStore(app, (s) => s.inspectorOpen);
  const loading = useStore(app, (s) => s.loading);
  const error = useStore(app, (s) => s.error);
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected;

  // Load (and reload on change, keeping the selection by path).
  useEffect(() => {
    let alive = true;
    (async () => {
      let keepPath: string | null = null;
      if (summary && selectedRef.current !== null) {
        keepPath = await client.call('detail', { id: selectedRef.current, maxChars: 0 }).then((d) => d.path).catch(() => null);
      }
      try {
        app.set({ loading: summary ? null : `Loading ${target.name}…`, error: null });
        const { bytes, format } = await host().request('getData', { uri: target.uri });
        if (!summary) app.set({ loading: `Parsing ${formatBytes(bytes.byteLength)}…` });
        const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
        const buf = (own ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
        const s = await client.call('load', { bytes: buf, format: format ?? target.format, name: target.name }, [buf]);
        if (!alive) return;
        let sel: number | null = null;
        if (keepPath) {
          const r = await client.call('query', { query: keepPath, limit: 1 });
          sel = r.ids[0] ?? null;
        }
        setSummary(s);
        setSelected(sel);
        app.set({ summary: s, loading: null, error: null });
      } catch (e) {
        if (!alive) return;
        app.set({ loading: null, error: (e as Error).message });
        logError(`${target.name}: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, docVersion]);

  const select: DataCtx['select'] = (id, opts) => {
    setSelected(id);
    if (id === null) {
      app.set({ crumb: '' });
      return;
    }
    if (opts?.focus) setReveal({ id, seq: ++revealSeq });
    void client.call('detail', { id, maxChars: 0 }).then((d) => {
      app.set({ crumb: d.path });
      // Two-way sync: highlight the node in the editor without stealing focus.
      const s = app.get();
      if (opts?.source !== 'cursor' && s.settings.followCursor && s.init?.capabilities.reveal && host().kind === 'vscode' && d.start) {
        void host().request('reveal', { uri: target.uri, line: d.start.line, col: d.start.col, endLine: d.end?.line, endCol: d.end?.col, focus: false });
      }
    });
  };

  const revealInEditor = (id: number) => {
    void client.call('detail', { id, maxChars: 0 }).then((d) => {
      if (d.start) void host().request('reveal', { uri: target.uri, line: d.start.line, col: d.start.col, endLine: d.end?.line, endCol: d.end?.col, focus: true });
    });
  };

  // Search: plain text or JSONPath.
  useEffect(() => {
    if (!summary) return;
    const q = search.query.trim();
    if (!q) {
      setHits([]);
      setHitIndex(-1);
      setSearch({ total: 0, index: -1, busy: false, error: undefined });
      return;
    }
    setSearch({ busy: true });
    const t = setTimeout(async () => {
      let ids: number[] = [];
      let total = 0;
      let err: string | undefined;
      if (search.path || q.startsWith('$')) {
        const r = await client.call('query', { query: q, limit: 10000 });
        ids = r.ids;
        total = r.total;
        err = r.error;
      } else {
        const r = await client.call('search', { query: q, limit: 10000 });
        ids = r.hits.map((h) => h.id);
        total = ids.length;
        err = r.error;
      }
      setHits(ids);
      setHitIndex(ids.length ? 0 : -1);
      setHitVersion((v) => v + 1);
      setSearch({ total, index: ids.length ? 0 : -1, busy: false, error: err });
      if (ids.length) select(ids[0], { source: 'search' });
    }, 160);
    return () => clearTimeout(t);
  }, [search.query, search.path, summary]);

  const step = (d: number) => {
    if (!hits.length) return;
    const i = (hitIndex + d + hits.length) % hits.length;
    setHitIndex(i);
    setHitVersion((v) => v + 1);
    setSearch({ index: i });
    select(hits[i], { source: 'search' });
  };

  useEffect(
    () =>
      registerCommands({
        searchNext: () => step(1),
        searchPrev: () => step(-1),
        reveal: selected !== null && app.get().init?.capabilities.reveal ? () => revealInEditor(selected) : undefined,
      }),
    [hits, hitIndex, selected],
  );

  // Editor cursor → node.
  useEffect(
    () =>
      host().onEvent(async (e) => {
        if (e.type !== 'cursor' || e.uri !== target.uri || !app.get().settings.followCursor || !summary) return;
        const id = e.offset !== undefined ? await client.call('nodeAtOffset', { offset: e.offset }) : await client.call('nodeAtLine', { line: e.line ?? 0, col: 0 });
        if (id < 0 || id === selectedRef.current) return;
        select(id, { source: 'cursor' });
        setReveal({ id, seq: ++revealSeq });
      }),
    [client, summary],
  );

  const ctx: DataCtx | null = summary
    ? {
        client,
        summary,
        target,
        selected,
        select: (id, opts) => {
          select(id, opts);
          if (id !== null && opts?.focus) setReveal({ id, seq: ++revealSeq });
        },
        hits,
        hitIndex,
        hitVersion,
        reveal,
        revealInEditor,
        tableTarget,
        openTable: (id) => {
          setTableTarget(id);
          app.set({ view: 'table' });
        },
      }
    : null;

  if (!ctx) {
    return (
      <main class="main">
        {error ? (
          <CenterMessage>
            <b style={{ color: 'var(--danger)' }}>Could not open {target.name}</b>
            <span>{error}</span>
          </CenterMessage>
        ) : (
          <CenterMessage spinner progress>
            {loading ?? 'Loading…'}
          </CenterMessage>
        )}
      </main>
    );
  }

  return (
    <DataContext.Provider value={ctx}>
      <main class="main" key={`${view}`}>
        {view === 'tree' ? <TreePane /> : view === 'table' ? <TablePane /> : view === 'schema' ? <SchemaPane /> : view === 'text' ? <TextPane /> : <GraphPane />}
      </main>
      <aside class={`inspector ${inspectorOpen ? '' : 'closed'}`}>
        <div class="panel-head">{selected === null ? 'Overview' : 'Inspector'}</div>
        <DataInspector />
      </aside>
    </DataContext.Provider>
  );
}
