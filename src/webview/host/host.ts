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
