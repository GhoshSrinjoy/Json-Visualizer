/** Minimal observable store + Preact hook (no external state library). */

import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS, type InitPayload, type Mode, type UiSettings, type ViewId } from '../shared/protocol';
import type { Host } from './host/host';
import type { Summary } from './worker/protocol';

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      let changed = false;
      for (const k of Object.keys(p) as (keyof T)[]) if (state[k] !== p[k]) changed = true;
      if (!changed) return;
      state = { ...state, ...p };
      for (const fn of [...subs]) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Re-renders when the selected slice changes (shallow compare for arrays/objects of primitives). */
export function useStore<T extends object, S>(store: Store<T>, select: (s: T) => S): S {
  const [, force] = useState(0);
  const selRef = useRef(select);
  selRef.current = select;
  const valueRef = useRef<S>(select(store.get()));
  valueRef.current = select(store.get());
  useEffect(
    () =>
      store.subscribe(() => {
        const next = selRef.current(store.get());
        if (!shallowEqual(next, valueRef.current)) {
          valueRef.current = next;
          force((x) => x + 1);
        }
      }),
    [store],
  );
  return valueRef.current;
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}

// ---------------------------------------------------------------- app state

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

export interface AppState {
  init: InitPayload | null;
  mode: Mode;
  view: ViewId;
  settings: UiSettings;
  theme: 'dark' | 'light';
  loading: string | null;
  error: string | null;
  summary: Summary | null;
  /** Bumped whenever the document is reloaded (views re-fetch). */
  docVersion: number;
  inspectorOpen: boolean;
  sidebarOpen: boolean;
  toast: Toast | null;
  /** Status bar breadcrumb (e.g. selected JSON path). */
  crumb: string;
  /** View-specific status text. */
  status: string;
  /** Commands the active view supports (see commands.ts). */
  commands: string[];
  search: SearchState;
}

export interface SearchState {
  query: string;
  /** JSONPath mode for data documents. */
  path: boolean;
  total: number;
  index: number;
  busy: boolean;
  error?: string;
}

export const app = createStore<AppState>({
  init: null,
  mode: 'welcome',
  view: 'graph',
  settings: DEFAULT_SETTINGS,
  theme: 'dark',
  loading: null,
  error: null,
  summary: null,
  docVersion: 0,
  inspectorOpen: true,
  sidebarOpen: true,
  toast: null,
  crumb: '',
  status: '',
  commands: [],
  search: { query: '', path: false, total: 0, index: -1, busy: false },
});

export function setSearch(patch: Partial<SearchState>): void {
  app.set((s) => ({ search: { ...s.search, ...patch } }));
}

let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, kind: Toast['kind'] = 'info'): void {
  if (kind === 'error') logError(message);
  app.set({ toast: { id: ++toastSeq, message, kind } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => app.set({ toast: null }), kind === 'error' ? 6000 : 2600);
}

/** The active host (set once at startup). */
export const runtime: { host: Host | null } = { host: null };

export function host(): Host {
  if (!runtime.host) throw new Error('host not initialised');
  return runtime.host;
}

/** Reports a failure to the host's log (no-op outside VS Code). */
export function logError(message: string): void {
  runtime.host?.log?.('error', message);
}

export async function copy(text: string, what = 'Copied to clipboard'): Promise<void> {
  try {
    await host().request('copyText', { text });
    toast(what);
  } catch (e) {
    toast(`Copy failed: ${(e as Error).message}`, 'error');
  }
}

export function updateSettings(patch: Partial<UiSettings>): void {
  app.set((s) => ({ settings: { ...s.settings, ...patch } }));
  void host().request('setSettings', patch).catch(() => undefined);
}
