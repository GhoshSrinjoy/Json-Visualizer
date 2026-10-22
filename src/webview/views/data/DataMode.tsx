/** Data documents (JSON, YAML, XML, TOML, CSV…): loads into the worker and hosts the panes. */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DiffKind } from '../../../core/data/diff';
import { CONVERT_TARGETS } from '../../../core/data/targets';
import { formatBytes } from '../../../core/util/strings';
import type { DataView, Target } from '../../../shared/protocol';
import { registerCommands } from '../../commands';
import { CenterMessage } from '../../components/ui';
import { app, host, logError, setSearch, toast, useStore } from '../../store';
import { DataClient } from '../../worker/client';
import type { Summary } from '../../worker/protocol';
import { DataContext, type DataCtx, type ValidationState } from './context';
import { ComparePane } from './ComparePane';
import { GraphPane } from './GraphPane';
import { DataInspector } from './Inspector';
import { SchemaPane } from './SchemaPane';
import { TablePane } from './TablePane';
import { TextPane } from './TextPane';
import { TreePane } from './TreePane';
import { stem } from '../shared';

let revealSeq = 0;
let editSeq = 0;

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
  const [editRequest, setEditRequest] = useState<DataCtx['editRequest']>(null);
  const [compare, setCompare] = useState<DataCtx['compare']>(null);
  const [diffMarks, setDiffMarks] = useState<ReadonlyMap<number, DiffKind> | null>(null);
  const [validation, setValidation] = useState<ValidationState | null>(null);
  /** The schema in use (kept across reloads), and whether automatic detection already ran. */
  const schema = useRef<{ ref: string; text: string; name: string; source: ValidationState['source'] } | null>(null);
  const schemaTried = useRef(false);
  const canEdit = useStore(app, (s) => !!s.init?.capabilities.edit);
  /** Path to select after the next reload (set by edits that move or create the node). */
  const nextSelect = useRef<string | null>(null);
  const view = useStore(app, (s) => s.view) as DataView;
  const search = useStore(app, (s) => s.search);
  const docVersion = useStore(app, (s) => s.docVersion);
  const inspectorOpen = useStore(app, (s) => s.inspectorOpen);
  const loading = useStore(app, (s) => s.loading);
  const error = useStore(app, (s) => s.error);
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected;
  const reloadHooks = useRef(new Set<() => Promise<void> | void>());
  const memo = useMemo(() => new Map<string, unknown>(), [client]);

  // Load (and reload on change, keeping the selection by path).
  useEffect(() => {
    let alive = true;
    (async () => {
      let keepPath: string | null = null;
      if (summary && selectedRef.current !== null) {
        keepPath = await client.call('detail', { id: selectedRef.current, maxChars: 0 }).then((d) => d.path).catch(() => null);
      }
      if (nextSelect.current) {
        keepPath = nextSelect.current;
        nextSelect.current = null;
      }
      if (summary) await Promise.all([...reloadHooks.current].map(async (fn) => fn())).catch(() => undefined);
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
      setSearch({ total: 0, truncated: false, index: -1, busy: false, error: undefined });
      return;
    }
    setSearch({ busy: true });
    const t = setTimeout(async () => {
      let ids: number[] = [];
      let total = 0;
      let truncated = false;
      let err: string | undefined;
      if (search.path || q.startsWith('$')) {
        const r = await client.call('query', { query: q, limit: 10000 });
        ids = r.ids;
        total = r.total;
        err = r.error;
      } else {
        const r = await client.call('search', {
          query: q,
          limit: 10000,
          caseSensitive: search.caseSensitive,
          wholeWord: search.wholeWord,
          regex: search.regex,
          keys: search.scope !== 'values',
          values: search.scope !== 'keys',
        });
        ids = r.hits.map((h) => h.id);
        total = ids.length;
        truncated = r.truncated;
        err = r.error;
      }
      setHits(ids);
      setHitIndex(ids.length ? 0 : -1);
      setHitVersion((v) => v + 1);
      setSearch({ total, truncated, index: ids.length ? 0 : -1, busy: false, error: err });
      if (ids.length) select(ids[0], { source: 'search' });
    }, 160);
    return () => clearTimeout(t);
  }, [search.query, search.path, search.caseSensitive, search.wholeWord, search.regex, search.scope, summary]);

  const step = (d: number) => {
    if (!hits.length) return;
    const i = (hitIndex + d + hits.length) % hits.length;
    setHitIndex(i);
    setHitVersion((v) => v + 1);
    setSearch({ index: i });
    select(hits[i], { source: 'search' });
  };

  /** Validates the current document against `schema.current`, fetching $ref'd documents in rounds. */
  const runValidation = async () => {
    const s = schema.current;
    if (!s) return;
    const base: ValidationState = { ref: s.ref, name: s.name, source: s.source, result: null, byId: new Map(), unresolved: [] };
    setValidation(base);
    try {
      const refs: Record<string, string> = {};
      const unresolved: string[] = [];
      let r = await client.call('validate', { schema: s.text, refs });
      for (let round = 0; r.missing.length && round < 4; round++) {
        for (const m of r.missing) {
          let abs = m;
          try {
            abs = new URL(m, s.ref).href;
          } catch {
            // not resolvable as a URL: let the host try it as a path
          }
          const loaded = await host().request('loadSchema', { uri: target.uri, ref: abs }).catch(() => null);
          if (!loaded) unresolved.push(m);
          refs[m] = loaded?.text ?? '{}';
        }
        r = await client.call('validate', { schema: s.text, refs });
      }
      const byId = new Map<number, string[]>();
      for (const e of r.errors) byId.set(e.id, [...(byId.get(e.id) ?? []), e.message]);
      setValidation({ ...base, result: r, byId, unresolved });
      app.set({ validationErrors: r.valid ? 0 : r.errors.length });
    } catch (e) {
      setValidation({ ...base, error: (e as Error).message });
      app.set({ validationErrors: null });
    }
  };

  const nameOf = (ref: string) => decodeURIComponent(ref.replace(/[?#].*$/, '').split(/[\\/]/).pop() || ref);

  /** Uses the schema at `ref` (relative to the file, or a URL), or one the user picks. */
  const validateWith = async (ref?: string) => {
    try {
      const loaded = ref ? await host().request('loadSchema', { uri: target.uri, ref }) : await host().request('pickSchema', { uri: target.uri });
      if (!loaded) return;
      schema.current = { ...loaded, name: nameOf(loaded.ref), source: ref ? 'document' : 'picked' };
      await runValidation();
    } catch (e) {
      toast(`Could not load the schema: ${(e as Error).message}`, 'error');
    }
  };

  // Validate on every (re)load: with the schema in use, or one found automatically the first time.
  useEffect(() => {
    if (!summary) return;
    if (schema.current) {
      void runValidation();
      return;
    }
    if (schemaTried.current || !app.get().settings.autoValidate) return;
    schemaTried.current = true;
    void (async () => {
      const ref = await client.call('schemaRef', undefined);
      // A meta-schema reference means this file IS a schema; checking it against the meta-schema is opt-in.
      if (ref && /json-schema\.org\//i.test(ref)) return;
      const loaded = await host()
        .request('loadSchema', { uri: target.uri, ref: ref ?? undefined })
        .catch((e: Error) => {
          if (ref) toast(`Could not load the schema ${ref}: ${e.message}`, 'error');
          return null;
        });
      if (!loaded || schema.current) return;
      schema.current = { ...loaded, name: nameOf(loaded.ref), source: ref ? 'document' : 'settings' };
      await runValidation();
    })();
  }, [summary]);

  /** Loads the file to compare with: `uri` (from a command or the init payload), or one the user picks. */
  const chooseCompare = async (uri?: string) => {
    try {
      const picked = uri
        ? await host().request('getData', { uri }).then((d) => ({ name: decodeURIComponent(uri.split(/[\\/]/).pop() ?? uri), bytes: d.bytes, format: d.format }))
        : await host().request('pickDataFile', { uri: target.uri });
      if (!picked) return;
      const own = picked.bytes.byteOffset === 0 && picked.bytes.byteLength === picked.bytes.buffer.byteLength;
      const buf = (own ? picked.bytes.buffer : picked.bytes.slice().buffer) as ArrayBuffer;
      const r = await client.call('loadOther', { bytes: buf, format: picked.format, name: picked.name }, [buf]);
      if (r.errors) toast(`${picked.name} has ${r.errors} syntax ${r.errors === 1 ? 'error' : 'errors'}; comparing what could be read.`);
      setCompare((c) => ({ name: picked.name, seq: (c?.seq ?? 0) + 1 }));
      app.set({ view: 'compare' });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // Compare requested when the view was opened (VS Code "Compare With…") or later by the host.
  useEffect(() => {
    if (!summary || compare) return;
    const uri = app.get().init?.compare;
    if (uri) void chooseCompare(uri);
  }, [summary !== null]);
  useEffect(() => {
    const on = (e: Event) => void chooseCompare((e as CustomEvent<string>).detail);
    window.addEventListener('structlens:compare', on);
    return () => window.removeEventListener('structlens:compare', on);
  }, [client]);

  /** Saves the selected container (or the document) as JSON or another format. Tables pick the main array of records. */
  const exportAs = async (to = 'json') => {
    if (!summary) return;
    const t = CONVERT_TARGETS.find((x) => x.id === to);
    let id = selectedRef.current ?? summary.root;
    try {
      const node = await client.call('node', { id });
      if (node.type !== 'object' && node.type !== 'array') id = summary.root;
      if ((to === 'csv' || to === 'tsv') && id === summary.root) id = (await client.call('tableInfo', { id, auto: true })).id;
      const data = t ? await client.call('convert', { id, to: t.id }) : await client.call('json', { id, indent: 2, maxChars: 1_000_000_000 });
      const r = await host().request('saveFile', { name: `${stem(target.name)}.${t?.ext ?? 'json'}`, data, mime: t?.mime ?? 'application/json' });
      if (r.path) toast(`Saved ${r.path}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  useEffect(
    () =>
      registerCommands({
        exportAs: (to) => exportAs(to),
        searchNext: () => step(1),
        searchPrev: () => step(-1),
        reveal: selected !== null && app.get().init?.capabilities.reveal ? () => revealInEditor(selected) : undefined,
      }),
    [hits, hitIndex, selected, summary],
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
        edit: canEdit
          ? async (op, selectAfter) => {
              try {
                const edits = await client.call('edits', { op });
                if (selectAfter) nextSelect.current = selectAfter;
                await host().request('applyEdit', { uri: target.uri, edits });
                return true;
              } catch (e) {
                nextSelect.current = null;
                toast((e as Error).message, 'error');
                return false;
              }
            }
          : undefined,
        requestEdit: (id, mode) => {
          select(id);
          app.set({ inspectorOpen: true });
          setEditRequest({ id, mode, seq: ++editSeq });
        },
        editRequest,
        compare,
        chooseCompare,
        clearCompare: () => {
          void client.call('clearOther', undefined);
          setCompare(null);
          setDiffMarks(null);
        },
        diffMarks,
        setDiffMarks,
        validation,
        validateWith,
        clearValidation: () => {
          schema.current = null;
          setValidation(null);
          app.set({ validationErrors: null });
        },
        beforeReload: (fn) => {
          reloadHooks.current.add(fn);
          return () => reloadHooks.current.delete(fn);
        },
        memo,
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
        {view === 'tree' ? <TreePane /> : view === 'table' ? <TablePane /> : view === 'schema' ? <SchemaPane /> : view === 'text' ? <TextPane /> : view === 'compare' ? <ComparePane /> : <GraphPane />}
      </main>
      <aside class={`inspector ${inspectorOpen ? '' : 'closed'}`}>
        <div class="panel-head">{selected === null ? 'Overview' : 'Inspector'}</div>
        <DataInspector />
      </aside>
    </DataContext.Provider>
  );
}
