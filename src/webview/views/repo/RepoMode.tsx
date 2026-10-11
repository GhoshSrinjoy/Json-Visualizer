/** Folders / repositories: file tree, treemap, folder graph, dependency graph and stats. */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DepGraph, DepNode } from '../../../core/repo/deps';
import { K_DIR, repoChildren, repoPaths, type RepoModel } from '../../../core/repo/model';
import { depsToMermaid } from '../../../core/format/mermaid';
import { formatBytes, formatCount, withCommas } from '../../../core/util/strings';
import type { RepoView, Target } from '../../../shared/protocol';
import { registerCommands } from '../../commands';
import { CanvasPane, LegendItems } from '../../components/CanvasPane';
import { Icon } from '../../components/icons';
import { Treemap } from '../../components/Treemap';
import { CenterMessage, IconButton, VirtualList } from '../../components/ui';
import { buildDepsScene, buildRepoGraphScene, langColor, prepareDeps, type DepsSceneOptions, type RepoGraphState } from '../../scenes/repo';
import { app, copy, host, logError, setSearch, toast, updateSettings, useStore } from '../../store';
import { stem } from '../shared';

export function RepoMode({ target }: { target: Target }) {
  const view = useStore(app, (s) => s.view) as RepoView;
  const docVersion = useStore(app, (s) => s.docVersion);
  const sidebarOpen = useStore(app, (s) => s.sidebarOpen);
  const inspectorOpen = useStore(app, (s) => s.inspectorOpen);
  const query = useStore(app, (s) => s.search.query);
  const [repo, setRepo] = useState<RepoModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [deps, setDeps] = useState<DepGraph | null>(null);
  const [depsError, setDepsError] = useState<string | null>(null);
  const [force, setForce] = useState(0);

  useEffect(() => {
    let alive = true;
    app.set({ loading: 'Scanning…' });
    void host()
      .request('getRepo', { uri: target.uri, force: force > 0 })
      .then((r) => {
        if (!alive) return;
        setRepo(r);
        setError(null);
        app.set({ loading: null, status: `${withCommas(r.stats.files)} files · ${formatCount(r.stats.lines)} lines · scanned in ${r.stats.durationMs} ms${r.stats.truncated ? ' (truncated)' : ''}` });
      })
      .catch((e: Error) => {
        if (!alive) return;
        setError(e.message);
        app.set({ loading: null });
        logError(`Scan failed: ${e.message}`);
      });
    return () => {
      alive = false;
    };
  }, [target.uri, docVersion, force]);

  const needDeps = view === 'deps' || view === 'stats';
  useEffect(() => {
    if (!needDeps || !repo) return;
    let alive = true;
    void host()
      .request('getDeps', { uri: target.uri, force: force > 0 })
      .then((g) => alive && setDeps(g))
      .catch((e: Error) => {
        if (!alive) return;
        setDepsError(e.message);
        logError(`Dependency analysis failed: ${e.message}`);
      });
    return () => {
      alive = false;
    };
  }, [needDeps, repo, force]);

  useEffect(() => registerCommands({ refresh: () => setForce((f) => f + 1) }), []);

  const paths = useMemo(() => (repo ? repoPaths(repo) : []), [repo]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!repo || !q) return null;
    const out = new Set<number>();
    for (let i = 1; i < paths.length; i++) if (paths[i].toLowerCase().includes(q)) out.add(i);
    return out;
  }, [query, repo]);
  useEffect(() => {
    if (matches) setSearch({ total: matches.size, index: matches.size ? 0 : -1, busy: false });
  }, [matches]);

  const openEntry = (id: number) => {
    if (!repo) return;
    void host().request('open', { uri: relUri(target, paths[id]), visualize: true });
  };

  if (error)
    return (
      <main class="main">
        <CenterMessage>
          <b>Could not scan {target.name}</b>
          {error}
        </CenterMessage>
      </main>
    );
  if (!repo)
    return (
      <main class="main">
        <CenterMessage spinner progress>
          Scanning {target.name}…
        </CenterMessage>
      </main>
    );

  let pane;
  switch (view) {
    case 'treemap':
      pane = <TreemapPane repo={repo} selected={selected} setSelected={setSelected} matches={matches} openEntry={openEntry} />;
      break;
    case 'graph':
      pane = <RepoGraphPane repo={repo} selected={selected} setSelected={setSelected} matches={matches} openEntry={openEntry} name={stem(target.name)} />;
      break;
    case 'deps':
      pane = deps ? <DepsPane deps={deps} repo={repo} selected={selected} setSelected={setSelected} name={stem(target.name)} /> : depsError ? <CenterMessage>{depsError}</CenterMessage> : <CenterMessage spinner progress>Resolving imports…</CenterMessage>;
      break;
    case 'stats':
      pane = <StatsPane repo={repo} deps={deps} paths={paths} onPick={(id) => setSelected(id)} />;
      break;
    default:
      pane = <FilesPane repo={repo} selected={selected} setSelected={setSelected} matches={matches} openEntry={openEntry} />;
  }

  return (
    <>
      <aside class={`sidebar ${sidebarOpen ? '' : 'closed'}`}>
        <Languages repo={repo} />
      </aside>
      <main class="main">{pane}</main>
      <aside class={`inspector ${inspectorOpen ? '' : 'closed'}`}>
        <div class="panel-head">{selected === null ? 'Overview' : 'Inspector'}</div>
        <RepoInspector repo={repo} id={selected} paths={paths} target={target} deps={deps} openEntry={openEntry} />
      </aside>
    </>
  );
}

/** URI of an entry below the repo target: encoded segments for VS Code URIs, plain paths for the CLI. */
function relUri(target: Target, rel: string): string {
  if (!rel) return target.uri;
  if (target.uri.includes('://')) return `${target.uri.replace(/\/$/, '')}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  if (target.uri === '.' || target.uri === '') return rel;
  return `${target.uri.replace(/\/$/, '')}/${rel}`;
}

// ---------------------------------------------------------------- sidebar

function Languages({ repo }: { repo: RepoModel }) {
  const langs = repo.languages.filter((l) => l.files > 0).sort((a, b) => b.lines - a.lines || b.bytes - a.bytes);
  const total = Math.max(1, langs.reduce((s, l) => s + l.lines, 0));
  return (
    <>
      <div class="panel-head">Languages</div>
      <div class="panel-body">
        <div class="panel-section">
          <div class="lang-bar">
            {langs.filter((l) => l.lines > 0).map((l) => (
              <i key={l.id} title={`${l.name} ${Math.round((l.lines / total) * 100)}%`} style={{ width: `${(l.lines / total) * 100}%`, background: l.color }} />
            ))}
          </div>
          {langs.slice(0, 30).map((l) => (
            <div class="bar-row" key={l.id} style={{ gridTemplateColumns: '1fr 54px 44px' }}>
              <span class="label">
                <i class="dot" style={{ background: l.color }} />
                {l.name}
              </span>
              <span class="num">{l.lines ? formatCount(l.lines) : formatBytes(l.bytes)}</span>
              <span class="num">{l.files}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- files

interface PaneProps {
  repo: RepoModel;
  selected: number | null;
  setSelected: (id: number | null) => void;
  matches?: Set<number> | null;
  openEntry: (id: number) => void;
}

function FilesPane({ repo, selected, setSelected, matches, openEntry }: PaneProps) {
  const [expanded, setExpanded] = useState(() => new Set<number>([0, ...repoChildren(repo, 0).filter((c) => repo.kind[c] === K_DIR && repo.childCount[c] < 40)]));
  const rows = useMemo(() => {
    const out: { id: number; depth: number }[] = [];
    const visible = matches ? new Set<number>() : null;
    if (matches && visible) for (const m of matches) for (let p = m; p >= 0; p = repo.parent[p]) visible.add(p);
    const walk = (id: number, depth: number) => {
      for (const c of repoChildren(repo, id)) {
        if (visible && !visible.has(c)) continue;
        out.push({ id: c, depth });
        if (repo.kind[c] === K_DIR && (expanded.has(c) || visible)) walk(c, depth + 1);
      }
    };
    walk(0, 0);
    return out;
  }, [repo, expanded, matches]);
  const index = selected === null ? -1 : rows.findIndex((r) => r.id === selected);
  const toggle = (id: number) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };
  useEffect(
    () =>
      registerCommands({
        expandAll: () => {
          const all = new Set<number>([0]);
          for (let i = 0; i < repo.names.length && all.size < 5000; i++) if (repo.kind[i] === K_DIR) all.add(i);
          setExpanded(all);
        },
        collapseAll: () => setExpanded(new Set([0])),
      }),
    [repo],
  );
  const maxLines = Math.max(1, repo.lines[0]);
  return (
    <div class="view-fill">
      <VirtualList
        count={rows.length}
        rowHeight={26}
        scrollTo={index}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const j = Math.max(0, Math.min(rows.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
            setSelected(rows[j].id);
          } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && selected !== null && repo.kind[selected] === K_DIR) {
            e.preventDefault();
            if ((e.key === 'ArrowRight') !== expanded.has(selected)) toggle(selected);
          } else if (e.key === 'Enter' && selected !== null) openEntry(selected);
        }}
        render={(i) => {
          const { id, depth } = rows[i];
          const dir = repo.kind[id] === K_DIR;
          const open = expanded.has(id) || !!matches;
          const share = Math.max(0, repo.lines[id]) / maxLines;
          return (
            <div
              key={id}
              class={`trow ${selected === id ? 'selected' : ''} ${matches?.has(id) ? 'match' : ''}`}
              style={{ top: `${i * 26}px`, height: '26px', paddingLeft: `${8 + depth * 16}px`, fontFamily: 'var(--font-ui)', fontSize: '12.5px' }}
              onClick={() => {
                setSelected(id);
                if (dir) toggle(id);
              }}
              onDblClick={() => !dir && openEntry(id)}
            >
              <span class={`twisty ${open ? 'open' : ''}`} style={{ visibility: dir ? 'visible' : 'hidden' }}>
                <Icon name="chevronRight" />
              </span>
              {dir ? <Icon name="folder" style={{ color: 'var(--r-dir)', width: '15px', height: '15px', marginRight: '7px' }} /> : <i class="dot" style={{ background: langColor(repo, id), margin: '0 10px 0 4px' }} />}
              <span class="tkey" style={{ color: 'var(--text)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {repo.names[id]}
                {dir && <span style={{ color: 'var(--text-faint)' }}> · {withCommas(repo.files[id])}</span>}
              </span>
              <span style={{ width: '90px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span class="track" style={{ flex: 1, height: '4px', background: 'var(--surface-3)', borderRadius: '2px', overflow: 'hidden' }}>
                  <i style={{ display: 'block', height: '100%', width: `${Math.max(2, share * 100)}%`, background: dir ? 'var(--accent)' : langColor(repo, id) }} />
                </span>
              </span>
              <span class="tcount" style={{ width: '70px', textAlign: 'right' }}>
                {repo.lines[id] > 0 ? withCommas(repo.lines[id]) : ''}
              </span>
              <span class="tcount" style={{ width: '70px', textAlign: 'right' }}>
                {formatBytes(repo.size[id])}
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- treemap

function TreemapPane({ repo, selected, setSelected, matches, openEntry }: PaneProps) {
  const [root, setRoot] = useState(0);
  const [metric, setMetric] = useState<'lines' | 'bytes'>(repo.lines[0] > 0 ? 'lines' : 'bytes');
  const crumbs: number[] = [];
  for (let p = root; p >= 0; p = repo.parent[p]) crumbs.unshift(p);
  return (
    <div class="view-fill">
      <div class="table-bar">
        <Icon name="treemap" />
        {crumbs.map((c, i) => (
          <span key={c}>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setRoot(c);
              }}
            >
              {c === 0 ? repo.name : repo.names[c]}
            </a>
            {i < crumbs.length - 1 ? ' / ' : ''}
          </span>
        ))}
        <span class="spacer" />
        <span>Size by</span>
        <div class="tabs" style={{ padding: '2px' }}>
          <button class={`tab ${metric === 'lines' ? 'active' : ''}`} style={{ height: '24px' }} onClick={() => setMetric('lines')}>
            lines
          </button>
          <button class={`tab ${metric === 'bytes' ? 'active' : ''}`} style={{ height: '24px' }} onClick={() => setMetric('bytes')}>
            bytes
          </button>
        </div>
      </div>
      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <Treemap repo={repo} metric={metric} root={root} selected={selected} highlight={matches ?? undefined} onZoom={setRoot} onSelect={setSelected} onOpen={openEntry} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- folder graph

function RepoGraphPane({ repo, selected, setSelected, matches, openEntry, name }: PaneProps & { name: string }) {
  const settings = useStore(app, (s) => s.settings);
  // Start with the root plus its first few non-empty folders (decided before the first build so the camera fits it).
  const initialExpanded = () => {
    const ex = new Set([0]);
    for (const c of repoChildren(repo, 0)) if (repo.kind[c] === K_DIR && repo.files[c] > 0 && ex.size < 5) ex.add(c);
    return ex;
  };
  const state = useRef<RepoGraphState>({ expanded: initialExpanded(), rowLimits: new Map() });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    state.current = { expanded: initialExpanded(), rowLimits: new Map() };
    setVersion((v) => v + 1);
  }, [repo]);
  const toggle = (id: number) => {
    const ex = state.current.expanded;
    if (ex.has(id)) {
      const stack = [id];
      while (stack.length) {
        const x = stack.pop()!;
        ex.delete(x);
        for (const c of repoChildren(repo, x)) if (ex.has(c)) stack.push(c);
      }
    } else ex.add(id);
    setVersion((v) => v + 1);
  };
  const matchKeys = useMemo(() => {
    if (!matches) return [];
    const keys = new Set<string>();
    for (const m of matches) if (state.current.expanded.has(repo.parent[m])) keys.add(`r${repo.parent[m]}`);
    return [...keys];
  }, [matches, version]);
  return (
    <CanvasPane
      build={(cw) => buildRepoGraphScene(repo, state.current, cw, settings.direction)}
      sceneKey={`${repo.root}:${settings.direction}`}
      version={version}
      selected={selected !== null ? (repo.kind[selected] === K_DIR && state.current.expanded.has(selected) ? `r${selected}` : `r${repo.parent[selected]}`) : null}
      matches={matchKeys}
      exportName={`${name}-folders`}
      startAt={{ key: 'r0', align: settings.direction === 'LR' ? 'left' : 'top' }}
      onSelect={(n, row) => {
        if (!n) return setSelected(null);
        const r = row >= 0 ? n.rows?.[row] : undefined;
        const id = (r?.ref ?? n.ref) as number;
        if (r?.action) {
          state.current.rowLimits.set(id, (state.current.rowLimits.get(id) ?? 40) + 200);
          setVersion((v) => v + 1);
          return;
        }
        setSelected(id);
        if (r?.expandable) toggle(id);
      }}
      onToggle={(n, row) => {
        const r = n.rows?.[row];
        if (r?.ref !== undefined) toggle(r.ref as number);
      }}
      onOpen={(n, row) => {
        const r = row >= 0 ? n.rows?.[row] : undefined;
        if (r?.ref !== undefined && repo.kind[r.ref as number] !== K_DIR) openEntry(r.ref as number);
      }}
      commands={{
        expandAll: () => {
          for (let i = 0; i < repo.names.length && state.current.expanded.size < 300; i++) if (repo.kind[i] === K_DIR) state.current.expanded.add(i);
          setVersion((v) => v + 1);
        },
        collapseAll: () => {
          state.current.expanded = new Set([0]);
          setVersion((v) => v + 1);
        },
        toggleDirection: () => updateSettings({ direction: settings.direction === 'LR' ? 'TB' : 'LR' }),
      }}
    />
  );
}

// ---------------------------------------------------------------- dependencies

function DepsPane({ deps, repo, selected, setSelected, name }: { deps: DepGraph; repo: RepoModel; selected: number | null; setSelected: (id: number | null) => void; name: string }) {
  const [opts, setOpts] = useState<DepsSceneOptions>(() => ({
    level: deps.nodes.length > 60 ? 'folder' : 'file',
    folderDepth: autoFolderDepth(deps),
    externals: false,
    focus: null,
    maxNodes: 350,
  }));
  const prepared = useMemo(() => prepareDeps(deps, opts), [deps, opts]);
  const paths = useMemo(() => repoPaths(repo), [repo]);
  const entryOf = (n: DepNode) => (n.entry !== undefined ? n.entry : paths.indexOf(n.path));
  useEffect(() => {
    if (prepared.truncated) toast(`Showing the ${opts.maxNodes} most connected nodes (${prepared.truncated} hidden). Focus a node or use folder level.`);
  }, [prepared.truncated]);
  const bar = (
    <div class="floating tr" style={{ padding: '3px', alignItems: 'center', gap: '4px' }}>
      <div class="tabs" style={{ border: 0, background: 'transparent', padding: 0 }}>
        <button class={`tab ${opts.level === 'folder' ? 'active' : ''}`} onClick={() => setOpts({ ...opts, level: 'folder', focus: null })}>
          Folders
        </button>
        <button class={`tab ${opts.level === 'file' ? 'active' : ''}`} onClick={() => setOpts({ ...opts, level: 'file', focus: null })}>
          Files
        </button>
      </div>
      {opts.level === 'folder' && (
        <>
          <IconButton icon="minus" title="Shallower folders" disabled={opts.folderDepth <= 1} onClick={() => setOpts({ ...opts, folderDepth: opts.folderDepth - 1, focus: null })} />
          <span class="zoom-label" style={{ minWidth: '54px' }}>depth {opts.folderDepth}</span>
          <IconButton icon="plus" title="Deeper folders" disabled={opts.folderDepth >= 6} onClick={() => setOpts({ ...opts, folderDepth: opts.folderDepth + 1, focus: null })} />
        </>
      )}
      <IconButton icon="external" title={opts.externals ? 'Hide external packages' : 'Show external packages'} active={opts.externals} onClick={() => setOpts({ ...opts, externals: !opts.externals })} />
      {opts.focus && <IconButton icon="x" title="Clear focus" onClick={() => setOpts({ ...opts, focus: null })} />}
    </div>
  );
  if (!prepared.graph.nodes.length) return (<div class="view-fill">{bar}<CenterMessage>No imports between files were found{opts.externals ? '' : ' (try showing external packages)'}.</CenterMessage></div>);
  const selKey = (() => {
    if (selected === null) return null;
    const p = paths[selected];
    const n = prepared.graph.nodes.find((x) => x.path === p);
    return n ? `p${n.id}` : null;
  })();
  return (
    <CanvasPane
      build={(cw) => buildDepsScene(prepared.graph, cw, opts.focus)}
      sceneKey={`${opts.level}:${opts.folderDepth}:${opts.externals}:${opts.focus ?? ''}`}
      version={prepared}
      selected={selKey}
      exportName={`${name}-dependencies`}
      mermaid={() => depsToMermaid(prepared.graph)}
      onSelect={(n) => {
        if (!n) return setSelected(null);
        const d = n.ref as DepNode;
        const id = entryOf(d);
        if (id >= 0) setSelected(id);
      }}
      onOpen={(n) => {
        const d = n.ref as DepNode;
        if (d.kind === 'external') return;
        if (opts.level === 'folder' && d.kind === 'dir') setOpts({ ...opts, folderDepth: Math.min(6, d.path.split('/').length + 1), focus: null });
        else setOpts({ ...opts, focus: d.path });
      }}
      legend={<LegendItems items={[['import', 'var(--edge)'], ['cycle', 'var(--danger)'], ['external', 'var(--d-external)']]} />}
    >
      {bar}
      {deps.cycles.length > 0 && (
        <div class="floating tl" style={{ padding: '6px 10px', fontSize: '12px', color: 'var(--danger)', gap: '6px', alignItems: 'center' }}>
          <Icon name="alert" />
          {deps.cycles.length} import {deps.cycles.length === 1 ? 'cycle' : 'cycles'} · double-click a node to focus it
        </div>
      )}
    </CanvasPane>
  );
}

/** Shallowest folder depth that shows a meaningful number of folders (≥ 8, up to depth 4). */
function autoFolderDepth(deps: DepGraph): number {
  for (let d = 1; d <= 4; d++) {
    const folders = new Set(deps.nodes.filter((n) => n.kind === 'file').map((n) => n.path.split('/').slice(0, -1).slice(0, d).join('/')));
    if (folders.size >= 8) return d;
  }
  return 4;
}

// ---------------------------------------------------------------- stats

function StatsPane({ repo, deps, paths, onPick }: { repo: RepoModel; deps: DepGraph | null; paths: string[]; onPick: (id: number) => void }) {
  const files: number[] = [];
  for (let i = 1; i < repo.names.length; i++) if (repo.kind[i] !== K_DIR) files.push(i);
  const largest = [...files].sort((a, b) => repo.lines[b] - repo.lines[a]).slice(0, 12);
  const biggest = [...files].sort((a, b) => repo.size[b] - repo.size[a]).slice(0, 8);
  const folders = repoChildren(repo, 0).filter((c) => repo.kind[c] === K_DIR).sort((a, b) => repo.lines[b] - repo.lines[a]).slice(0, 10);
  const maxFolder = Math.max(1, ...folders.map((f) => repo.lines[f]));
  const langs = repo.languages.filter((l) => l.lines > 0).sort((a, b) => b.lines - a.lines).slice(0, 10);
  const maxLang = Math.max(1, ...langs.map((l) => l.lines));
  const s = repo.stats;
  const hubs = deps ? [...deps.nodes].filter((n) => n.kind === 'file').sort((a, b) => b.fanIn - a.fanIn).slice(0, 10) : [];
  return (
    <div class="stats">
      <div class="stat-card">
        <h3>Repository</h3>
        <div class="big-numbers">
          <div class="big-number">
            <b>{withCommas(s.files)}</b>
            <span>files</span>
          </div>
          <div class="big-number">
            <b>{withCommas(s.dirs)}</b>
            <span>folders</span>
          </div>
          <div class="big-number">
            <b>{formatCount(s.lines)}</b>
            <span>lines</span>
          </div>
          <div class="big-number">
            <b>{formatBytes(s.bytes)}</b>
            <span>on disk ({withCommas(s.ignored)} ignored)</span>
          </div>
        </div>
      </div>
      <div class="stat-card">
        <h3>Languages by lines</h3>
        {langs.map((l) => (
          <div class="bar-row" key={l.id}>
            <span class="label">
              <i class="dot" style={{ background: l.color }} />
              {l.name}
            </span>
            <span class="track">
              <i style={{ width: `${(l.lines / maxLang) * 100}%`, background: l.color }} />
            </span>
            <span class="num">{formatCount(l.lines)}</span>
          </div>
        ))}
      </div>
      <div class="stat-card">
        <h3>Top-level folders</h3>
        {folders.map((f) => (
          <div class="bar-row" key={f} onClick={() => onPick(f)} style={{ cursor: 'pointer' }}>
            <span class="label">{repo.names[f]}/</span>
            <span class="track">
              <i style={{ width: `${(repo.lines[f] / maxFolder) * 100}%`, background: 'var(--accent)' }} />
            </span>
            <span class="num">{formatCount(repo.lines[f])}</span>
          </div>
        ))}
      </div>
      <div class="stat-card">
        <h3>Largest files (lines)</h3>
        <div class="file-list">
          {largest.filter((f) => repo.lines[f] > 0).map((f) => (
            <div key={f} onClick={() => onPick(f)}>
              <span>{paths[f]}</span>
              <span>{withCommas(repo.lines[f])}</span>
            </div>
          ))}
        </div>
      </div>
      <div class="stat-card">
        <h3>Heaviest files (bytes)</h3>
        <div class="file-list">
          {biggest.map((f) => (
            <div key={f} onClick={() => onPick(f)}>
              <span>{paths[f]}</span>
              <span>{formatBytes(repo.size[f])}</span>
            </div>
          ))}
        </div>
      </div>
      <div class="stat-card">
        <h3>Most imported files</h3>
        {deps ? (
          <div class="file-list">
            {hubs.filter((h) => h.fanIn > 0).map((h) => (
              <div key={h.id} onClick={() => h.entry !== undefined && onPick(h.entry)}>
                <span>{h.path}</span>
                <span>{h.fanIn} importers</span>
              </div>
            ))}
            {deps.cycles.length > 0 && <p style={{ color: 'var(--danger)', fontSize: '12px' }}>{deps.cycles.length} import cycles detected — see the Dependencies view.</p>}
          </div>
        ) : (
          <CenterMessage spinner />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- inspector

function RepoInspector({ repo, id, paths, target, deps, openEntry }: { repo: RepoModel; id: number | null; paths: string[]; target: Target; deps: DepGraph | null; openEntry: (id: number) => void }) {
  if (id === null) {
    const s = repo.stats;
    return (
      <div class="panel-body">
        <div class="panel-section">
          <dl class="kv">
            <dt>Folder</dt>
            <dd>{target.path}</dd>
            <dt>Files</dt>
            <dd>{withCommas(s.files)}</dd>
            <dt>Folders</dt>
            <dd>{withCommas(s.dirs)}</dd>
            <dt>Lines</dt>
            <dd>{withCommas(s.lines)}</dd>
            <dt>Size</dt>
            <dd>{formatBytes(s.bytes)}</dd>
            <dt>Ignored</dt>
            <dd>{withCommas(s.ignored)} entries</dd>
            <dt>Scan</dt>
            <dd>{s.durationMs} ms{s.truncated ? ' (truncated)' : ''}</dd>
          </dl>
        </div>
        <div class="panel-section" style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
          Select a file or folder. Double-click a file to open its structure, flow or data view.
        </div>
      </div>
    );
  }
  const dir = repo.kind[id] === K_DIR;
  const path = paths[id];
  const lang = repo.lang[id] >= 0 ? repo.languages[repo.lang[id]] : null;
  const node = deps?.nodes.find((n) => n.path === path);
  const imports = node && deps ? deps.edges.filter((e) => e.from === node.id).map((e) => deps.nodes[e.to].path) : [];
  const importers = node && deps ? deps.edges.filter((e) => e.to === node.id).map((e) => deps.nodes[e.from].path) : [];
  return (
    <div class="panel-body">
      <div class="panel-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          {dir ? <Icon name="folder" style={{ color: 'var(--r-dir)' }} /> : <i class="dot" style={{ background: langColor(repo, id) }} />}
          <b style={{ wordBreak: 'break-all' }}>{repo.names[id]}</b>
        </div>
        <div class="path">{path}</div>
      </div>
      <div class="panel-section actions">
        <button class="btn" onClick={() => openEntry(id)}>
          <Icon name="eye" /> Visualize
        </button>
        {!dir && (
          <button class="btn" onClick={() => void host().request('reveal', { uri: relUri(target, path), line: 0 })}>
            <Icon name="external" /> Open
          </button>
        )}
        <button class="btn" onClick={() => copy(path, `Copied ${path}`)}>
          <Icon name="copy" /> Path
        </button>
      </div>
      <div class="panel-section">
        <dl class="kv">
          {dir && (
            <>
              <dt>Files</dt>
              <dd>{withCommas(repo.files[id])}</dd>
            </>
          )}
          {lang && (
            <>
              <dt>Language</dt>
              <dd>{lang.name}</dd>
            </>
          )}
          <dt>Lines</dt>
          <dd>{repo.lines[id] >= 0 ? withCommas(repo.lines[id]) : '—'}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(repo.size[id])}</dd>
          {repo.mtime[id] > 0 && (
            <>
              <dt>Modified</dt>
              <dd>{new Date(repo.mtime[id]).toLocaleString()}</dd>
            </>
          )}
        </dl>
      </div>
      {node && (
        <div class="panel-section">
          <p class="section-title">Imports ({imports.length})</p>
          <div class="file-list">
            {imports.slice(0, 40).map((p) => (
              <div key={p}>
                <span>{p}</span>
              </div>
            ))}
          </div>
          <p class="section-title" style={{ marginTop: '12px' }}>
            Imported by ({importers.length})
          </p>
          <div class="file-list">
            {importers.slice(0, 40).map((p) => (
              <div key={p}>
                <span>{p}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
