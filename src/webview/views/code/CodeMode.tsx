/** Code files: structure map, logic flow, data flow and call graph. */

import { Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CALLABLE_KINDS, type CallGraph, type CallGraphNode, type CodeOutline, type CodeSymbol, type DataNode, type FlowNode, type FunctionAnalysis } from '../../../core/code/model';
import { findAtLine, flattenSymbols, MODULE_SYMBOL } from '../../../core/code/symbols';
import { callGraphToMermaid, dataFlowToMermaid, flowToMermaid } from '../../../core/format/mermaid';
import type { CodeView, Target } from '../../../shared/protocol';
import { CanvasPane, LegendItems } from '../../components/CanvasPane';
import { Icon } from '../../components/icons';
import { CenterMessage, IconButton } from '../../components/ui';
import type { SceneNode } from '../../engine/scene';
import { buildCallScene, buildDataFlowScene, buildFlowScene, buildStructureScene, glyph, KIND_COLOR } from '../../scenes/code';
import { app, host, logError, setSearch, toast, updateSettings, useStore } from '../../store';
import { stem } from '../shared';

type Selection =
  | { kind: 'symbol'; id: string }
  | { kind: 'flow'; node: FlowNode }
  | { kind: 'data'; node: DataNode }
  | { kind: 'call'; node: CallGraphNode }
  | null;

const CX = (c?: number) => (!c || c < 6 ? '' : c < 11 ? 'mid' : 'high');

export function CodeMode({ target }: { target: Target }) {
  const init = useStore(app, (s) => s.init);
  const view = useStore(app, (s) => s.view) as CodeView;
  const docVersion = useStore(app, (s) => s.docVersion);
  const sidebarOpen = useStore(app, (s) => s.sidebarOpen);
  const inspectorOpen = useStore(app, (s) => s.inspectorOpen);
  const search = useStore(app, (s) => s.search.query);
  const [outline, setOutline] = useState<CodeOutline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [symbolId, setSymbolId] = useState<string | null>(init?.symbol ?? null);
  const [analysis, setAnalysis] = useState<FunctionAnalysis | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [cursorLine, setCursorLine] = useState<number | null>(init?.line ?? null);
  const [flowDir, setFlowDir] = useState<'TB' | 'LR'>('TB');
  const outlineRef = useRef<CodeOutline | null>(null);
  outlineRef.current = outline;

  // Outline.
  useEffect(() => {
    let alive = true;
    void host()
      .request('getOutline', { uri: target.uri })
      .then((o) => {
        if (!alive) return;
        if (!o) return setError('This language is not supported for code analysis.');
        setOutline(o);
        setError(null);
        app.set({ status: `${o.languageName} · ${flattenSymbols(o.symbols).length} symbols${o.approximate ? ' (approximate)' : ''}` });
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        logError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [target.uri, docVersion]);

  // Default function for flow views.
  const callables = useMemo(() => (outline ? flattenSymbols(outline.symbols).filter((s) => CALLABLE_KINDS.has(s.kind) && s.hasBody) : []), [outline]);
  useEffect(() => {
    if (!outline || symbolId) return;
    const atLine = cursorLine !== null ? findAtLine(outline.symbols, cursorLine) : undefined;
    const best = atLine ?? [...callables].sort((a, b) => (b.complexity ?? 0) - (a.complexity ?? 0))[0];
    setSymbolId(best?.id ?? MODULE_SYMBOL);
  }, [outline]);

  // Function analysis (flow + data flow).
  useEffect(() => {
    if (!symbolId || outline?.approximate) return;
    let alive = true;
    void host()
      .request('getFunction', { uri: target.uri, symbolId })
      .then((r) => alive && setAnalysis(r))
      .catch((e: Error) => alive && toast(e.message, 'error'));
    return () => {
      alive = false;
    };
  }, [symbolId, docVersion, outline?.approximate]);

  // Editor cursor → function / flow node.
  useEffect(
    () =>
      host().onEvent((e) => {
        if (e.type === 'cursor' && e.uri === target.uri && e.line !== undefined && app.get().settings.followCursor) {
          setCursorLine(e.line);
          const o = outlineRef.current;
          if (!o) return;
          const fn = findAtLine(o.symbols, e.line);
          if (fn && fn.id !== symbolId) setSymbolId(fn.id);
        }
      }),
    [symbolId],
  );
  useEffect(() => {
    const nav = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { symbol?: string; line?: number };
      if (d.symbol) setSymbolId(d.symbol);
      if (d.line !== undefined) setCursorLine(d.line);
    };
    window.addEventListener('structlens:navigate', nav);
    return () => window.removeEventListener('structlens:navigate', nav);
  }, []);

  const reveal = (line: number, col = 0, focus = true) => void host().request('reveal', { uri: target.uri, line, col, focus }).catch(() => undefined);
  const symbolById = (id: string) => (outline ? flattenSymbols(outline.symbols).find((s) => s.id === id) : undefined);
  const openFlow = (id: string, v: CodeView = 'flow') => {
    setSymbolId(id);
    app.set({ view: v });
  };

  if (error) {
    return (
      <main class="main">
        <CenterMessage>
          <b>Can't analyse {target.name}</b>
          <span>{error}</span>
        </CenterMessage>
      </main>
    );
  }
  if (!outline) {
    return (
      <main class="main">
        <CenterMessage spinner progress>
          Analysing {target.name}…
        </CenterMessage>
      </main>
    );
  }

  const fnName = symbolId === MODULE_SYMBOL ? 'top-level code' : (symbolById(symbolId ?? '')?.id ?? symbolId ?? '');
  let pane;
  if (view === 'flow' || view === 'dataflow') {
    if (outline.approximate) pane = <CenterMessage>Flow analysis needs a grammar-backed language; {outline.languageName} has an approximate outline only.</CenterMessage>;
    else if (!analysis || analysis.symbol.id !== symbolId) pane = <CenterMessage spinner>Building {view === 'flow' ? 'flowchart' : 'data flow'} for {fnName}…</CenterMessage>;
    else if (view === 'flow') pane = <FlowPane analysis={analysis} dir={flowDir} setDir={setFlowDir} cursorLine={cursorLine} selection={selection} setSelection={setSelection} reveal={reveal} name={stem(target.name)} />;
    else pane = <DataFlowPane analysis={analysis} selection={selection} setSelection={setSelection} reveal={reveal} name={stem(target.name)} />;
  } else if (view === 'calls') pane = <CallsPane target={target} symbolId={symbolId} selection={selection} setSelection={setSelection} reveal={reveal} openFlow={openFlow} />;
  else pane = <StructurePane outline={outline} selection={selection} setSelection={setSelection} reveal={reveal} openFlow={openFlow} search={search} name={stem(target.name)} />;

  return (
    <>
      <aside class={`sidebar ${sidebarOpen ? '' : 'closed'}`}>
        <SymbolList outline={outline} active={symbolId} onPick={(id) => {
          setSymbolId(id);
          setSelection(id === MODULE_SYMBOL ? null : { kind: 'symbol', id });
          if (view === 'structure' || view === 'calls') app.set({ view: 'flow' });
        }} />
      </aside>
      <main class="main">
        {(view === 'flow' || view === 'dataflow') && analysis && (
          <div class="floating tl" style={{ alignItems: 'center', padding: '4px 10px', gap: '8px', fontSize: '12px' }}>
            <span class="glyph" style={{ color: `var(--k-${KIND_COLOR[analysis.symbol.kind] ?? 'function'})` }}>{glyph(analysis.symbol.kind)}</span>
            <b style={{ fontFamily: 'var(--font-mono)' }}>{analysis.symbol.id === MODULE_SYMBOL ? 'top-level code' : analysis.symbol.id}</b>
            {analysis.flow.complexity > 1 && <span class={`cx ${CX(analysis.flow.complexity)}`} title="Cyclomatic complexity">cx {analysis.flow.complexity}</span>}
            <span style={{ color: 'var(--text-faint)' }}>
              {view === 'flow' ? `${analysis.flow.nodes.length} steps` : `${analysis.data.nodes.length} values · ${analysis.data.edges.length} flows`}
            </span>
          </div>
        )}
        {pane}
      </main>
      <aside class={`inspector ${inspectorOpen ? '' : 'closed'}`}>
        <div class="panel-head">Inspector</div>
        <CodeInspector outline={outline} selection={selection} analysis={analysis} reveal={reveal} openFlow={openFlow} select={setSelection} />
      </aside>
    </>
  );
}

// ---------------------------------------------------------------- sidebar

function SymbolList({ outline, active, onPick }: { outline: CodeOutline; active: string | null; onPick: (id: string) => void }) {
  const [filter, setFilter] = useState('');
  const items: { sym: CodeSymbol; depth: number }[] = [];
  const f = filter.toLowerCase();
  const visit = (s: CodeSymbol, depth: number) => {
    const match = !f || s.name.toLowerCase().includes(f);
    const kids = s.children ?? [];
    const childMatch = kids.some((c) => c.name.toLowerCase().includes(f));
    if (match || childMatch) items.push({ sym: s, depth });
    for (const c of kids) visit(c, depth + 1);
  };
  outline.symbols.forEach((s) => visit(s, 0));
  return (
    <>
      <div class="panel-head">
        Symbols <span class="spacer" />
        <span class="cx">{items.length}</span>
      </div>
      <input class="filter" placeholder="Filter symbols…" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
      <div class="panel-body">
        <ul class="list">
          <li class={`list-item ${active === MODULE_SYMBOL ? 'active' : ''}`} onClick={() => onPick(MODULE_SYMBOL)} title="Flow of the statements at the top level of the file">
            <span class="glyph" style={{ color: 'var(--k-module)' }}>◆</span>
            <span class="grow">top-level code</span>
          </li>
          {items.map(({ sym, depth }) => {
            const callable = CALLABLE_KINDS.has(sym.kind) && sym.hasBody;
            return (
              <li
                key={sym.id}
                class={`list-item depth-${Math.min(depth, 2)} ${active === sym.id ? 'active' : ''}`}
                style={callable ? undefined : { cursor: 'default', opacity: 0.85 }}
                title={`${sym.kind} ${sym.id}${sym.signature ?? ''}`}
                onClick={() => callable && onPick(sym.id)}
              >
                <span class="glyph" style={{ color: `var(--k-${KIND_COLOR[sym.kind] ?? 'variable'})` }}>{glyph(sym.kind)}</span>
                <span class="grow">{sym.name}</span>
                {sym.complexity && sym.complexity > 1 && <span class={`cx ${CX(sym.complexity)}`}>{sym.complexity}</span>}
                <span class="meta">{sym.range.start.line + 1}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- panes

interface PaneProps {
  selection: Selection;
  setSelection: (s: Selection) => void;
  reveal: (line: number, col?: number, focus?: boolean) => void;
}

function StructurePane({ outline, selection, setSelection, reveal, openFlow, search, name }: PaneProps & { outline: CodeOutline; openFlow: (id: string) => void; search: string; name: string }) {
  const settings = useStore(app, (s) => s.settings);
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    const keys = new Set<string>();
    for (const s of flattenSymbols(outline.symbols)) {
      if (!s.name.toLowerCase().includes(q)) continue;
      // Highlight the card listing the symbol (container card, or the file card).
      const parent = flattenSymbols(outline.symbols).find((p) => p.children?.some((c) => c.id === s.id));
      keys.add(parent ? `s:${parent.id}` : 'file');
      if (s.children?.length) keys.add(`s:${s.id}`);
    }
    return [...keys];
  }, [search, outline]);
  useEffect(() => {
    if (search.trim()) setSearch({ total: matches.length, index: matches.length ? 0 : -1, busy: false });
  }, [matches]);
  const symFromRow = (n: SceneNode, row: number): string | undefined => {
    const r = row >= 0 ? n.rows?.[row] : undefined;
    const ref = r?.ref ?? n.ref;
    return typeof ref === 'string' && ref !== 'file' && ref !== 'imports' && !ref.startsWith('import:') ? ref : undefined;
  };
  const sel = selection?.kind === 'symbol' ? selection.id : null;
  return (
    <CanvasPane
      build={(cw) => buildStructureScene(outline, cw, settings.direction)}
      sceneKey={`${outline.path}:${settings.direction}`}
      version={outline}
      selected={sel ? (outline.symbols.some((s) => s.id === sel) ? 'file' : `s:${flattenSymbols(outline.symbols).find((p) => p.children?.some((c) => c.id === sel))?.id ?? sel}`) : null}
      matches={matches}
      exportName={`${name}-structure`}
      onSelect={(n, row) => {
        if (!n) return setSelection(null);
        const id = symFromRow(n, row);
        if (id) setSelection({ kind: 'symbol', id });
        const r = row >= 0 ? n.rows?.[row] : undefined;
        if (typeof r?.ref === 'string' && r.ref.startsWith('import:')) reveal(Number(r.ref.slice(7)), 0, false);
      }}
      onOpen={(n, row) => {
        const id = symFromRow(n, row);
        if (!id) return;
        const s = flattenSymbols(outline.symbols).find((x) => x.id === id);
        if (s && CALLABLE_KINDS.has(s.kind) && s.hasBody) openFlow(id);
        else if (s) reveal(s.range.start.line, s.range.start.col);
      }}
      tooltip={(n, row) => {
        const id = symFromRow(n, row);
        const s = id ? flattenSymbols(outline.symbols).find((x) => x.id === id) : undefined;
        return s ? { head: `${s.kind} · line ${s.range.start.line + 1}`, body: `${s.name}${s.signature ?? ''}${s.doc ? `\n\n${s.doc}` : ''}` } : null;
      }}
      commands={{ toggleDirection: () => updateSettings({ direction: settings.direction === 'LR' ? 'TB' : 'LR' }) }}
      legend={<LegendItems items={[['class', 'var(--k-class)'], ['interface', 'var(--k-interface)'], ['function', 'var(--k-function)'], ['method', 'var(--k-method)'], ['field', 'var(--k-field)']]} />}
      startAt={{ key: 'file', align: settings.direction === 'LR' ? 'left' : 'top' }}
    />
  );
}

function FlowPane({ analysis, dir, setDir, cursorLine, selection, setSelection, reveal, name }: PaneProps & { analysis: FunctionAnalysis; dir: 'TB' | 'LR'; setDir: (d: 'TB' | 'LR') => void; cursorLine: number | null; name: string }) {
  const g = analysis.flow;
  const cursorKey = useMemo(() => {
    if (cursorLine === null) return null;
    let best: FlowNode | undefined;
    for (const n of g.nodes) {
      if (!n.range || n.kind === 'start') continue;
      if (n.range.start.line <= cursorLine && cursorLine <= n.range.end.line && (!best || n.range.start.line >= best.range!.start.line)) best = n;
    }
    return best ? `f${best.id}` : null;
  }, [cursorLine, g]);
  const selected = selection?.kind === 'flow' ? `f${selection.node.id}` : cursorKey;
  return (
    <CanvasPane
      build={(cw) => buildFlowScene(g, cw, dir)}
      sceneKey={`${analysis.symbol.id}:${dir}`}
      startAt={{ key: `f${(g.nodes.find((n) => n.kind === 'start') ?? g.nodes[0]).id}`, align: dir === 'TB' ? 'top' : 'left' }}
      version={g}
      selected={selected}
      focusKey={cursorKey}
      exportName={`${name}-${analysis.symbol.name}-flow`}
      mermaid={() => flowToMermaid(g, dir === 'TB' ? 'TD' : 'LR')}
      onSelect={(n) => {
        const fn = n?.ref as FlowNode | undefined;
        setSelection(fn ? { kind: 'flow', node: fn } : null);
        if (fn?.range && app.get().settings.followCursor) reveal(fn.range.start.line, fn.range.start.col, false);
      }}
      onOpen={(n) => {
        const fn = n.ref as FlowNode;
        if (fn.range) reveal(fn.range.start.line, fn.range.start.col, true);
      }}
      tooltip={(n) => {
        const fn = n.ref as FlowNode;
        const text = fn.lines?.length ? fn.lines.join('\n') : fn.label;
        return text.length > 40 || (fn.lines?.length ?? 0) > 1 ? { head: `${fn.kind}${fn.range ? ` · line ${fn.range.start.line + 1}` : ''}`, body: text } : null;
      }}
      commands={{ toggleDirection: () => setDir(dir === 'TB' ? 'LR' : 'TB') }}
      legend={<LegendItems items={[['decision', 'var(--f-decision)'], ['loop', 'var(--f-loop)'], ['statements', 'var(--f-block)'], ['return', 'var(--f-return)'], ['throw / catch', 'var(--f-throw)'], ['try', 'var(--f-try)']]} />}
    />
  );
}

/** Data flows are long chains: lay them out top-down in portrait panels (e.g. beside the editor). */
function portraitCanvas(): boolean {
  const { sidebarOpen, inspectorOpen } = app.get();
  return window.innerWidth - (sidebarOpen ? 270 : 0) - (inspectorOpen ? 340 : 0) < window.innerHeight - 80;
}

function DataFlowPane({ analysis, selection, setSelection, reveal, name }: PaneProps & { analysis: FunctionAnalysis; name: string }) {
  const g = analysis.data;
  const [dir, setDir] = useState<'LR' | 'TB'>(() => (portraitCanvas() ? 'TB' : 'LR'));
  if (!g.nodes.length) return <CenterMessage>No data flows found in this function.</CenterMessage>;
  return (
    <CanvasPane
      build={(cw) => buildDataFlowScene(g, cw, dir)}
      sceneKey={`${analysis.symbol.id}:${dir}`}
      version={g}
      selected={selection?.kind === 'data' ? `d:${selection.node.id}` : null}
      exportName={`${name}-${analysis.symbol.name}-dataflow`}
      mermaid={() => dataFlowToMermaid(g)}
      onSelect={(n) => setSelection(n ? { kind: 'data', node: n.ref as DataNode } : null)}
      startAt={{ key: `d:${(g.nodes.find((n) => n.kind === 'param') ?? g.nodes[0]).id}`, align: dir === 'TB' ? 'top' : 'left' }}
      commands={{ toggleDirection: () => setDir(dir === 'TB' ? 'LR' : 'TB') }}
      onOpen={(n) => {
        const d = n.ref as DataNode;
        const line = d.defs[0] ?? d.uses[0];
        if (line !== undefined) reveal(line);
      }}
      legend={<LegendItems items={[['input', 'var(--d-param)'], ['variable', 'var(--d-local)'], ['field', 'var(--k-interface)'], ['call', 'var(--d-call)'], ['external', 'var(--d-external)'], ['output', 'var(--f-return)']]} />}
    />
  );
}

function CallsPane({ target, symbolId, selection, setSelection, reveal, openFlow }: PaneProps & { target: Target; symbolId: string | null; openFlow: (id: string) => void }) {
  const caps = useStore(app, (s) => s.init?.capabilities);
  const [scope, setScope] = useState<'file' | 'workspace'>('file');
  const [externals, setExternals] = useState(false);
  const [graph, setGraph] = useState<CallGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focus = scope === 'workspace' && symbolId && symbolId !== MODULE_SYMBOL ? `${target.path}#${symbolId}` : undefined;
  useEffect(() => {
    let alive = true;
    setGraph(null);
    setError(null);
    void host()
      .request('getCallGraph', { uris: scope === 'file' ? [target.uri] : ['.'], focus, depth: 2, direction: 'both', externals })
      .then((g) => alive && setGraph(g))
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        logError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [target.uri, scope, externals, focus]);
  const bar = (
    <div class="floating tr" style={{ padding: '3px' }}>
      <div class="tabs" style={{ border: 0, background: 'transparent', padding: 0 }}>
        <button class={`tab ${scope === 'file' ? 'active' : ''}`} onClick={() => setScope('file')}>
          This file
        </button>
        <button class={`tab ${scope === 'workspace' ? 'active' : ''}`} disabled={!caps?.repo} title="Callers and callees of the selected function across the workspace" onClick={() => setScope('workspace')}>
          Workspace
        </button>
      </div>
      <IconButton icon="external" title={externals ? 'Hide library calls' : 'Show library calls'} active={externals} onClick={() => setExternals(!externals)} />
    </div>
  );
  if (error) return <CenterMessage>{error}</CenterMessage>;
  if (!graph) return <CenterMessage spinner>Resolving calls{scope === 'workspace' ? ' across the workspace' : ''}…</CenterMessage>;
  if (!graph.nodes.length) return (<>{bar}<CenterMessage>No calls found{focus ? ' for the selected function' : ''}.</CenterMessage></>);
  return (
    <CanvasPane
      build={(cw) => buildCallScene(graph, cw, focus)}
      sceneKey={`${scope}:${externals}:${focus ?? ''}`}
      startAt={focus ? { key: `c:${focus}`, align: 'center' } : null}
      version={graph}
      selected={selection?.kind === 'call' ? `c:${selection.node.id}` : focus ? `c:${focus}` : null}
      exportName={`${stem(target.name)}-calls`}
      mermaid={() => callGraphToMermaid(graph)}
      onSelect={(n) => setSelection(n ? { kind: 'call', node: n.ref as CallGraphNode } : null)}
      onOpen={(n) => {
        const c = n.ref as CallGraphNode;
        if (c.file === target.path) openFlow(c.id.slice(c.id.indexOf('#') + 1));
        else if (c.file) void host().request('open', { uri: c.file, visualize: true, view: 'flow', symbol: c.id.slice(c.id.indexOf('#') + 1) });
        else if (c.line !== undefined) reveal(c.line);
      }}
      legend={<LegendItems items={[['resolved call', 'var(--edge)'], ['likely (dashed)', 'var(--text-faint)'], ['external', 'var(--d-external)']]} />}
    >
      {bar}
    </CanvasPane>
  );
}

// ---------------------------------------------------------------- inspector

function CodeInspector({ outline, selection, analysis, reveal, openFlow, select }: { outline: CodeOutline; selection: Selection; analysis: FunctionAnalysis | null; reveal: (line: number, col?: number) => void; openFlow: (id: string, v?: CodeView) => void; select: (s: Selection) => void }) {
  const caps = useStore(app, (s) => s.init?.capabilities);
  const all = useMemo(() => flattenSymbols(outline.symbols), [outline]);
  if (!selection) return <FileOverview outline={outline} />;
  if (selection.kind === 'symbol') {
    const s = all.find((x) => x.id === selection.id);
    if (!s) return <FileOverview outline={outline} />;
    const callable = CALLABLE_KINDS.has(s.kind) && s.hasBody;
    const calls = [...new Set((s.calls ?? []).map((c) => (c.receiver ? `${c.receiver}.${c.name}` : c.name)))];
    return (
      <div class="panel-body">
        <div class="panel-section">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span class="glyph" style={{ color: `var(--k-${KIND_COLOR[s.kind] ?? 'variable'})` }}>{glyph(s.kind)}</span>
            <b style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{s.name}</b>
            <span class="spacer" />
            <span class="type-badge">{s.kind}</span>
          </div>
          {s.signature && <div class="path" style={{ marginTop: '10px' }}>{s.signature}</div>}
          {s.doc && <p style={{ color: 'var(--text-muted)', margin: '10px 0 0' }}>{s.doc}</p>}
        </div>
        <div class="panel-section actions">
          {caps?.reveal && (
            <button class="btn" onClick={() => reveal(s.range.start.line, s.range.start.col)}>
              <Icon name="external" /> Reveal
            </button>
          )}
          {callable && (
            <>
              <button class="btn" onClick={() => openFlow(s.id, 'flow')}>
                <Icon name="flow" /> Flow
              </button>
              <button class="btn" onClick={() => openFlow(s.id, 'dataflow')}>
                <Icon name="dataflow" /> Data flow
              </button>
              <button class="btn" onClick={() => openFlow(s.id, 'calls')}>
                <Icon name="calls" /> Calls
              </button>
            </>
          )}
        </div>
        <div class="panel-section">
          <dl class="kv">
            <dt>Lines</dt>
            <dd>
              {s.range.start.line + 1}–{s.range.end.line + 1}
            </dd>
            {s.modifiers?.length ? (
              <>
                <dt>Modifiers</dt>
                <dd>{s.modifiers.join(' ')}</dd>
              </>
            ) : null}
            {s.bases?.length ? (
              <>
                <dt>Extends</dt>
                <dd>{s.bases.join(', ')}</dd>
              </>
            ) : null}
            {s.params?.length ? (
              <>
                <dt>Params</dt>
                <dd>{s.params.join(', ')}</dd>
              </>
            ) : null}
            {s.complexity ? (
              <>
                <dt>Complexity</dt>
                <dd>
                  <span class={`cx ${CX(s.complexity)}`}>{s.complexity}</span>
                </dd>
              </>
            ) : null}
            {s.children?.length ? (
              <>
                <dt>Members</dt>
                <dd>{s.children.length}</dd>
              </>
            ) : null}
          </dl>
        </div>
        {calls.length > 0 && (
          <div class="panel-section">
            <p class="section-title">Calls ({calls.length})</p>
            <div class="file-list">
              {calls.map((c) => {
                const local = all.find((x) => x.name === c.split('.').pop() && CALLABLE_KINDS.has(x.kind));
                return (
                  <div key={c} onClick={() => local && select({ kind: 'symbol', id: local.id })} style={{ cursor: local ? 'pointer' : 'default' }}>
                    <span>{c}</span>
                    <span>{local ? `line ${local.range.start.line + 1}` : 'external'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }
  if (selection.kind === 'flow') {
    const n = selection.node;
    const outs = analysis?.flow.edges.filter((e) => e.from === n.id) ?? [];
    return (
      <div class="panel-body">
        <div class="panel-section">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <b>{n.kind}</b>
            {n.unreachable && <span class="pill warn">unreachable</span>}
            <span class="spacer" />
            {n.range && <span class="schema-note">line {n.range.start.line + 1}</span>}
          </div>
          <pre class="code-block">{n.lines?.length ? n.lines.join('\n') : n.label}</pre>
        </div>
        {outs.length > 0 && (
          <div class="panel-section">
            <p class="section-title">Next</p>
            <div class="file-list">
              {outs.map((e, i) => {
                const to = analysis!.flow.nodes[e.to];
                return (
                  <div key={i} onClick={() => select({ kind: 'flow', node: to })}>
                    <span>{e.label ? `${e.label} → ` : ''}{to.kind === 'end' ? 'end' : to.label}</span>
                    <span>{e.kind}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {caps?.reveal && n.range && (
          <div class="panel-section actions">
            <button class="btn" onClick={() => reveal(n.range!.start.line, n.range!.start.col)}>
              <Icon name="external" /> Reveal in editor
            </button>
          </div>
        )}
      </div>
    );
  }
  if (selection.kind === 'data') {
    const n = selection.node;
    const ins = analysis?.data.edges.filter((e) => e.to === n.id) ?? [];
    const outs = analysis?.data.edges.filter((e) => e.from === n.id) ?? [];
    const label = (id: string) => analysis?.data.nodes.find((x) => x.id === id)?.label ?? id;
    return (
      <div class="panel-body">
        <div class="panel-section">
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <b style={{ fontFamily: 'var(--font-mono)' }}>{n.label}</b>
            <span class="spacer" />
            <span class="type-badge">{n.kind}</span>
          </div>
        </div>
        <div class="panel-section">
          <dl class="kv">
            <dt>Assigned</dt>
            <dd>{n.defs.length ? n.defs.map((l) => l + 1).join(', ') : '—'}</dd>
            <dt>Read</dt>
            <dd>{n.uses.length ? n.uses.map((l) => l + 1).join(', ') : '—'}</dd>
          </dl>
        </div>
        {ins.length > 0 && (
          <div class="panel-section">
            <p class="section-title">Comes from</p>
            <div class="file-list">
              {ins.map((e, i) => (
                <div key={i} onClick={() => reveal(e.lines[0] ?? 0)}>
                  <span>{label(e.from)}</span>
                  <span>
                    {e.kind} · L{e.lines.map((l) => l + 1).join(',')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {outs.length > 0 && (
          <div class="panel-section">
            <p class="section-title">Flows into</p>
            <div class="file-list">
              {outs.map((e, i) => (
                <div key={i} onClick={() => reveal(e.lines[0] ?? 0)}>
                  <span>{label(e.to)}</span>
                  <span>
                    {e.kind} · L{e.lines.map((l) => l + 1).join(',')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
  const c = selection.node;
  return (
    <div class="panel-body">
      <div class="panel-section">
        <b style={{ fontFamily: 'var(--font-mono)' }}>{c.container ? `${c.container}.${c.name}` : c.name}</b>
        <dl class="kv" style={{ marginTop: '10px' }}>
          <dt>File</dt>
          <dd>{c.file ?? 'external'}</dd>
          {c.line !== undefined && (
            <>
              <dt>Line</dt>
              <dd>{c.line + 1}</dd>
            </>
          )}
          <dt>Callers</dt>
          <dd>{c.callers}</dd>
        </dl>
      </div>
    </div>
  );
}

function FileOverview({ outline }: { outline: CodeOutline }) {
  const all = flattenSymbols(outline.symbols);
  const counts = new Map<string, number>();
  for (const s of all) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const complex = all.filter((s) => (s.complexity ?? 0) > 1).sort((a, b) => (b.complexity ?? 0) - (a.complexity ?? 0)).slice(0, 8);
  return (
    <div class="panel-body">
      <div class="panel-section">
        <p class="section-title">File</p>
        <dl class="kv">
          <dt>Language</dt>
          <dd>{outline.languageName}{outline.approximate ? ' (approx.)' : ''}</dd>
          <dt>Lines</dt>
          <dd>
            {outline.lines.toLocaleString()} ({outline.loc.toLocaleString()} code)
          </dd>
          <dt>Imports</dt>
          <dd>{outline.imports.length}</dd>
          <dt>Exports</dt>
          <dd>{outline.exports.length}</dd>
          {outline.syntaxErrors > 0 && (
            <>
              <dt>Syntax errors</dt>
              <dd style={{ color: 'var(--danger)' }}>{outline.syntaxErrors}</dd>
            </>
          )}
        </dl>
      </div>
      <div class="panel-section">
        <p class="section-title">Symbols</p>
        <dl class="kv">
          {[...counts.entries()].map(([k, v]) => (
            <Fragment key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </Fragment>
          ))}
        </dl>
      </div>
      {complex.length > 0 && (
        <div class="panel-section">
          <p class="section-title">Most complex</p>
          <div class="file-list">
            {complex.map((s) => (
              <div
                key={s.id}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent('structlens:navigate', { detail: { symbol: s.id } }));
                  app.set({ view: 'flow' });
                }}
              >
                <span>{s.id}</span>
                <span class={`cx ${CX(s.complexity)}`}>{s.complexity}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
