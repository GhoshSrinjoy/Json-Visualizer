/** Top bar: brand + target, view tabs, search, actions and settings. */

import { useEffect, useRef } from 'preact/hooks';
import { FORMAT_LABELS } from '../../core/data/formats';
import { formatBytes } from '../../core/util/strings';
import type { Mode, ViewId } from '../../shared/protocol';
import { runCommand, type CommandId } from '../commands';
import { BrowserHost } from '../host/browser';
import { app, host, setSearch, updateSettings, useStore } from '../store';
import { BrandMark, Icon, type IconName } from './icons';
import { IconButton, useMenu, type MenuItem } from './ui';

export const VIEWS: Record<Mode, { id: ViewId; label: string; icon: IconName }[]> = {
  data: [
    { id: 'graph', label: 'Graph', icon: 'graph' },
    { id: 'tree', label: 'Tree', icon: 'tree' },
    { id: 'table', label: 'Table', icon: 'table' },
    { id: 'schema', label: 'Schema', icon: 'braces' },
    { id: 'text', label: 'Text', icon: 'fileText' },
  ],
  code: [
    { id: 'structure', label: 'Structure', icon: 'structure' },
    { id: 'flow', label: 'Logic flow', icon: 'flow' },
    { id: 'dataflow', label: 'Data flow', icon: 'dataflow' },
    { id: 'calls', label: 'Calls', icon: 'calls' },
  ],
  repo: [
    { id: 'tree', label: 'Files', icon: 'tree' },
    { id: 'treemap', label: 'Treemap', icon: 'treemap' },
    { id: 'graph', label: 'Graph', icon: 'graph' },
    { id: 'deps', label: 'Dependencies', icon: 'deps' },
    { id: 'stats', label: 'Stats', icon: 'stats' },
  ],
  welcome: [],
};

export function Toolbar() {
  const init = useStore(app, (s) => s.init);
  const mode = useStore(app, (s) => s.mode);
  const view = useStore(app, (s) => s.view);
  const summary = useStore(app, (s) => s.summary);
  const commands = useStore(app, (s) => s.commands.join(','));
  const inspectorOpen = useStore(app, (s) => s.inspectorOpen);
  const sidebarOpen = useStore(app, (s) => s.sidebarOpen);
  const theme = useStore(app, (s) => s.theme);
  const settings = useStore(app, (s) => s.settings);
  const [menu, openMenu] = useMenu();
  const has = (c: CommandId) => commands.split(',').includes(c);

  const target = init?.target;
  const title = target?.name ?? 'StructLens';
  const subtitle =
    mode === 'data' && summary
      ? `${FORMAT_LABELS[summary.format]} · ${formatBytes(summary.bytes)} · ${summary.nodes.toLocaleString()} values`
      : mode === 'welcome'
        ? 'JSON · YAML · XML · TOML · CSV · code flow · repo maps'
        : (target?.path ?? '');

  const exportItems = (): MenuItem[] => {
    const items: MenuItem[] = [{ heading: 'Export' }];
    if (has('exportPng')) items.push({ label: 'PNG image', icon: 'image', onSelect: () => runCommand('exportPng') });
    if (has('exportSvg')) items.push({ label: 'SVG vector', icon: 'image', onSelect: () => runCommand('exportSvg') });
    if (has('exportMermaid')) items.push({ label: 'Mermaid diagram', icon: 'code', onSelect: () => runCommand('exportMermaid') });
    if (has('exportJson')) items.push({ label: mode === 'data' ? 'JSON (selection or document)' : 'JSON data', icon: 'braces', onSelect: () => runCommand('exportJson') });
    return items;
  };

  const settingsItems = (): MenuItem[] => {
    const depthItems: MenuItem[] = [1, 2, 3, 4, 6].map((d) => ({ label: `Open ${d} level${d > 1 ? 's' : ''} initially`, checked: settings.initialDepth === d, onSelect: () => updateSettings({ initialDepth: d }) }));
    return [
      { heading: 'Display' },
      { label: 'Animations', checked: settings.animations, onSelect: () => updateSettings({ animations: !settings.animations }) },
      { label: 'Minimap', checked: settings.minimap, onSelect: () => updateSettings({ minimap: !settings.minimap }) },
      { label: init?.host === 'vscode' ? 'Sync with editor cursor' : 'Follow selection', checked: settings.followCursor, onSelect: () => updateSettings({ followCursor: !settings.followCursor }) },
      { separator: true },
      { heading: 'Graph' },
      { label: 'Left to right', checked: settings.direction === 'LR', onSelect: () => updateSettings({ direction: 'LR' }) },
      { label: 'Top to bottom', checked: settings.direction === 'TB', onSelect: () => updateSettings({ direction: 'TB' }) },
      ...depthItems,
      { label: `Rows per card: ${settings.childPageSize}`, onSelect: () => updateSettings({ childPageSize: settings.childPageSize >= 200 ? 25 : settings.childPageSize * 2 }) },
      { separator: true },
      { heading: 'Theme' },
      { label: 'Match editor / system', checked: settings.theme === 'auto', onSelect: () => updateSettings({ theme: 'auto' }) },
      { label: 'Dark', checked: settings.theme === 'dark', onSelect: () => updateSettings({ theme: 'dark' }) },
      { label: 'Light', checked: settings.theme === 'light', onSelect: () => updateSettings({ theme: 'light' }) },
    ];
  };

  return (
    <header class="toolbar">
      <div class="brand">
        <BrandMark />
        <div class="brand-title">
          <span class="brand-name" title={target?.path}>
            {title}
          </span>
          <span class="brand-sub">{subtitle}</span>
        </div>
        {mode === 'data' && summary && summary.errors.length > 0 && (
          <span class="pill danger" title={summary.errors[0].message}>
            {summary.errors.length} {summary.errors.length === 1 ? 'error' : 'errors'}
          </span>
        )}
      </div>
      {VIEWS[mode].length > 0 && (
        <nav class="tabs" role="tablist">
          {VIEWS[mode].map((v, i) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} class={`tab ${view === v.id ? 'active' : ''}`} title={`${v.label} (${i + 1})`} onClick={() => app.set({ view: v.id })}>
              <Icon name={v.icon} />
              <span>{v.label}</span>
            </button>
          ))}
        </nav>
      )}
      <div class="spacer" />
      {mode !== 'welcome' && <SearchBox mode={mode} />}
      <div class="btn-group">
        {host() instanceof BrowserHost && <IconButton icon="upload" title="Open a file" onClick={() => openFilePicker()} />}
        {has('collapseAll') && <IconButton icon="collapse" title="Collapse all" kbd="C" onClick={() => runCommand('collapseAll')} />}
        {has('expandAll') && <IconButton icon="expand" title="Expand all" kbd="E" onClick={() => runCommand('expandAll')} />}
        {has('toggleDirection') && <IconButton icon="direction" title={`Layout: ${settings.direction === 'LR' ? 'left → right' : 'top → bottom'}`} kbd="D" onClick={() => runCommand('toggleDirection')} />}
        {has('refresh') && <IconButton icon="refresh" title="Refresh" kbd="R" onClick={() => runCommand('refresh')} />}
        {(has('exportPng') || has('exportJson')) && <IconButton icon="download" title="Export" onClick={(e) => openMenu(exportItems(), e.currentTarget as Element)} />}
      </div>
      <div class="divider" />
      <div class="btn-group">
        {mode !== 'data' && mode !== 'welcome' && <IconButton icon="panelLeft" title="Toggle sidebar" kbd="B" active={sidebarOpen} onClick={() => app.set({ sidebarOpen: !sidebarOpen })} />}
        {mode !== 'welcome' && <IconButton icon="panelRight" title="Toggle inspector" kbd="I" active={inspectorOpen} onClick={() => app.set({ inspectorOpen: !inspectorOpen })} />}
        {init?.host !== 'vscode' && <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} title="Toggle theme" onClick={() => updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' })} />}
        <IconButton icon="sliders" title="Settings" onClick={(e) => openMenu(settingsItems(), e.currentTarget as Element)} />
      </div>
      {menu}
    </header>
  );
}

export function openFilePicker(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,.jsonc,.json5,.jsonl,.ndjson,.geojson,.yaml,.yml,.xml,.svg,.html,.htm,.toml,.csv,.tsv,.xlsx,.xlsm,.ini,.cfg,.env,.properties,.txt,application/json,text/*';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (f) (host() as BrowserHost).openDocument(f.name, new Uint8Array(await f.arrayBuffer()));
  };
  input.click();
}

function SearchBox({ mode }: { mode: Mode }) {
  const search = useStore(app, (s) => s.search);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focus = () => {
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener('structlens:focus-search', focus);
    return () => window.removeEventListener('structlens:focus-search', focus);
  }, []);
  const placeholder = search.path ? 'JSONPath, e.g. $.users[?(@.age > 30)].name' : mode === 'data' ? 'Search keys & values' : mode === 'code' ? 'Find symbols or nodes' : 'Find files';
  const count = search.busy ? '…' : search.error ? '!' : search.query ? (search.total ? `${search.index + 1}/${search.total.toLocaleString()}` : '0') : '';
  return (
    <div class="search" title={search.error}>
      <Icon name={search.path ? 'terminal' : 'search'} />
      <input
        ref={ref}
        value={search.query}
        placeholder={placeholder}
        spellcheck={false}
        onInput={(e) => setSearch({ query: (e.target as HTMLInputElement).value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            runCommand(e.shiftKey ? 'searchPrev' : 'searchNext');
          } else if (e.key === 'Escape') {
            setSearch({ query: '' });
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {count && <span class="count" style={search.error ? { color: 'var(--danger)' } : undefined}>{count}</span>}
      {search.query && (
        <>
          <button class="btn mini" title="Previous (Shift+Enter)" onClick={() => runCommand('searchPrev')}>
            <Icon name="chevronUp" />
          </button>
          <button class="btn mini" title="Next (Enter)" onClick={() => runCommand('searchNext')}>
            <Icon name="chevronDown" />
          </button>
        </>
      )}
      {!search.query && <kbd style={{ marginRight: '6px' }}>/</kbd>}
      {mode === 'data' && (
        <span class={`mode ${search.path ? 'on' : ''}`} title="Toggle JSONPath query mode" onClick={() => setSearch({ path: !search.path })}>
          $
        </span>
      )}
    </div>
  );
}
