/** Host abstraction: the UI talks to VS Code, the CLI server or nothing (plain browser) the same way. */

import type { HostEvent, HostToUi, RequestMap, RequestName, UiToHost } from '../../shared/protocol';

export interface Host {
  kind: 'vscode' | 'server' | 'browser';
  request<K extends RequestName>(method: K, params: RequestMap[K]['params']): Promise<RequestMap[K]['result']>;
  onEvent(cb: (e: HostEvent) => void): () => void;
  /** Tells the host the UI is ready to receive `init`. */
  ready(): void;
  /** Editor-cursor sync back to the host (VS Code). */
  cursor?(uri: string, line: number, col?: number): void;
  saveState?(state: unknown): void;
  loadState?(): unknown;
  /** Diagnostics for the host's log (VS Code output channel). */
  log?(level: 'info' | 'warn' | 'error', message: string): void;
}

export abstract class BaseHost implements Host {
  abstract kind: Host['kind'];
  protected listeners = new Set<(e: HostEvent) => void>();

  abstract request<K extends RequestName>(method: K, params: RequestMap[K]['params']): Promise<RequestMap[K]['result']>;
  abstract ready(): void;

  onEvent(cb: (e: HostEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  protected emit(e: HostEvent): void {
    for (const l of this.listeners) l(e);
  }
}

export class VsCodeHost extends BaseHost {
  kind = 'vscode' as const;
  private readonly api = acquireVsCodeApi();
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    super();
    window.addEventListener('message', (ev: MessageEvent<HostToUi>) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.kind === 'response') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error !== undefined) p.reject(new Error(m.error));
        else p.resolve(m.result);
      } else if (m.kind === 'event') this.emit(m.event);
    });
    window.addEventListener('error', (e) => this.log('error', `${e.message}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''}`));
    window.addEventListener('unhandledrejection', (e) => this.log('error', `Unhandled rejection: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`));
  }

  private post(msg: UiToHost): void {
    this.api.postMessage(msg);
  }

  request<K extends RequestName>(method: K, params: RequestMap[K]['params']): Promise<RequestMap[K]['result']> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.post({ kind: 'request', id, method, params } as UiToHost);
    });
  }

  ready(): void {
    this.post({ kind: 'ready' });
  }

  cursor(uri: string, line: number, col?: number): void {
    this.post({ kind: 'cursorSync', uri, line, col });
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.post({ kind: 'log', level, message });
  }

  saveState(state: unknown): void {
    this.api.setState(state);
  }

  loadState(): unknown {
    return this.api.getState();
  }
}

/** Opens http(s)/mailto links in a new tab; other schemes are ignored. */
export function openWebLink(url: string): void {
  if (/^(?:https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener');
}

/** Lets the user pick a text file in the browser (null when cancelled). */
export function pickTextFile(accept: string): Promise<{ ref: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { ref: f.name, text: await f.text() } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Lets the user pick a data file in the browser (null when cancelled). */
export function pickDataFile(): Promise<{ name: string; bytes: Uint8Array } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Downloads a schema in the browser (only http(s); the server or editor handles local paths). */
export async function fetchSchema(ref: string): Promise<{ ref: string; text: string }> {
  const url = ref.replace(/#.*$/, '');
  const res = await fetch(url, { headers: { accept: 'application/schema+json, application/json, */*' } });
  if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}`);
  return { ref: url, text: await res.text() };
}
