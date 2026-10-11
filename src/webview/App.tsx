/** Application shell: host events, theme, keyboard shortcuts and mode routing. */

import { useEffect } from 'preact/hooks';
import type { InitPayload, ViewId } from '../shared/protocol';
import { runCommand } from './commands';
import { Icon } from './components/icons';
import { StatusBar } from './components/StatusBar';
import { Toolbar, VIEWS } from './components/Toolbar';
import { app, host, setSearch, useStore } from './store';
import { CodeMode } from './views/code/CodeMode';
import { DataMode } from './views/data/DataMode';
import { RepoMode } from './views/repo/RepoMode';
import { Welcome } from './views/Welcome';

const DEFAULT_VIEW: Record<string, ViewId> = { data: 'graph', code: 'structure', repo: 'tree', welcome: 'graph' };

/**
 * Side panels that leave the canvas enough room: a visualizer beside the
 * editor is often only 600–900px wide.
 */
function fittingPanels(mode: string, width: number): { sidebarOpen: boolean; inspectorOpen: boolean } {
  const sidebar = mode !== 'data' && width >= 760;
  return { sidebarOpen: sidebar, inspectorOpen: width >= (sidebar ? 1400 : 1100) };
}

const widthClass = (w: number) => (w < 760 ? 0 : w < 1100 ? 1 : w < 1400 ? 2 : 3);

function applyInit(p: InitPayload): void {
  const views = VIEWS[p.mode].map((v) => v.id);
  const view = p.view && views.includes(p.view) ? p.view : DEFAULT_VIEW[p.mode];
  app.set({
    init: p,
    mode: p.mode,
    view,
    settings: p.settings,
    summary: null,
    error: null,
    loading: null,
    crumb: '',
    status: '',
    search: { query: '', path: false, total: 0, index: -1, busy: false },
    ...fittingPanels(p.mode, window.innerWidth),
  });
  document.title = p.target ? `${p.target.name} — StructLens` : 'StructLens';
  if (p.target) host().saveState?.({ mode: p.mode, target: p.target, view });
}

export function App() {
  const init = useStore(app, (s) => s.init);
  const mode = useStore(app, (s) => s.mode);
  const toast = useStore(app, (s) => s.toast);
  const themeSetting = useStore(app, (s) => s.settings.theme);

  // Host events.
  useEffect(() => {
    const off = host().onEvent((e) => {
      switch (e.type) {
        case 'init':
          applyInit(e.payload);
          break;
        case 'changed':
          if (e.uri === app.get().init?.target?.uri) app.set((s) => ({ docVersion: s.docVersion + 1 }));
          break;
        case 'settings':
          app.set({ settings: e.settings });
          break;
        case 'navigate': {
          const s = app.get();
          if (e.view && VIEWS[s.mode].some((v) => v.id === e.view)) app.set({ view: e.view });
          if (e.query !== undefined) setSearch({ query: e.query });
          if (e.symbol !== undefined || e.line !== undefined) window.dispatchEvent(new CustomEvent('structlens:navigate', { detail: e }));
          break;
        }
      }
    });
    host().ready();
    return off;
  }, []);

  // Re-fit the side panels when the window crosses a width threshold (manual toggles stick in between).
  useEffect(() => {
    let last = widthClass(window.innerWidth);
    const onResize = () => {
      const now = widthClass(window.innerWidth);
      if (now === last) return;
      last = now;
      app.set(fittingPanels(app.get().mode, window.innerWidth));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Theme: explicit, or follow VS Code / the OS.
  useEffect(() => {
    const resolve = () => {
      let dark: boolean;
      if (themeSetting !== 'auto') dark = themeSetting === 'dark';
      else if (document.body.classList.contains('vscode-host')) dark = !document.body.classList.contains('vscode-light') && !document.body.classList.contains('vscode-high-contrast-light');
      else dark = !window.matchMedia('(prefers-color-scheme: light)').matches;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      app.set({ theme: dark ? 'dark' : 'light' });
    };
    resolve();
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', resolve);
    const mo = new MutationObserver(resolve);
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => {
      mq.removeEventListener('change', resolve);
      mo.disconnect();
    };
  }, [themeSetting]);

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      if ((e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        window.dispatchEvent(new Event('structlens:focus-search'));
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      const s = app.get();
      const views = VIEWS[s.mode];
      switch (e.key) {
        case '/':
          e.preventDefault();
          window.dispatchEvent(new Event('structlens:focus-search'));
          break;
        case 'f':
        case 'F':
          runCommand('fit');
          break;
        case '+':
        case '=':
          runCommand('zoomIn');
          break;
        case '-':
        case '_':
          runCommand('zoomOut');
          break;
        case '0':
          runCommand('resetZoom');
          break;
        case 'e':
        case 'E':
          runCommand('expandAll');
          break;
        case 'c':
        case 'C':
          runCommand('collapseAll');
          break;
        case 'd':
        case 'D':
          runCommand('toggleDirection');
          break;
        case 'r':
        case 'R':
          runCommand('refresh');
          break;
        case 'i':
        case 'I':
          app.set({ inspectorOpen: !s.inspectorOpen });
          break;
        case 'b':
        case 'B':
          app.set({ sidebarOpen: !s.sidebarOpen });
          break;
        case 'n':
          runCommand('searchNext');
          break;
        case 'N':
          runCommand('searchPrev');
          break;
        case 'Escape':
          setSearch({ query: '' });
          break;
        default:
          if (/^[1-9]$/.test(e.key) && views[Number(e.key) - 1]) app.set({ view: views[Number(e.key) - 1].id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const target = init?.target;
  return (
    <div class="app">
      <Toolbar />
      {!init ? (
        <main class="main" />
      ) : mode === 'data' && target ? (
        <DataMode key={`${target.uri}`} target={target} />
      ) : mode === 'code' && target ? (
        <CodeMode key={`${target.uri}`} target={target} />
      ) : mode === 'repo' && target ? (
        <RepoMode key={`${target.uri}`} target={target} />
      ) : (
        <main class="main">
          <Welcome />
        </main>
      )}
      <StatusBar />
      {toast && (
        <div class={`toast ${toast.kind}`} key={toast.id} role="status">
          <Icon name={toast.kind === 'error' ? 'alert' : 'check'} />
          {toast.message}
        </div>
      )}
    </div>
  );
}
