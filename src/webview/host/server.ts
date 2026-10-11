/** Host backed by the CLI's local web server (`structlens open`). */

import type { HostEvent, InitPayload, RequestMap, RequestName } from '../../shared/protocol';
import { BaseHost } from './host';

export class ServerHost extends BaseHost {
  kind = 'server' as const;
  private readonly token: string;
  private events: EventSource | null = null;

  constructor() {
    super();
    const q = new URLSearchParams(location.search);
    this.token = window.__STRUCTLENS__?.token ?? q.get('token') ?? '';
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const u = new URL(path, location.origin);
    u.searchParams.set('token', this.token);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  async request<K extends RequestName>(method: K, params: RequestMap[K]['params']): Promise<RequestMap[K]['result']> {
    if (method === 'getData') {
      const { uri } = params as RequestMap['getData']['params'];
      const res = await fetch(this.url('/api/file', { uri }));
      if (!res.ok) throw new Error(await res.text());
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { bytes, version: Number(res.headers.get('x-version') ?? 0) } as RequestMap[K]['result'];
    }
    if (method === 'saveFile') {
      const { name, data, mime } = params as RequestMap['saveFile']['params'];
      download(name, data, mime);
      return { saved: true } as RequestMap[K]['result'];
    }
    if (method === 'copyText') {
      await navigator.clipboard.writeText((params as RequestMap['copyText']['params']).text);
      return undefined as RequestMap[K]['result'];
    }
    if (method === 'open') {
      const p = params as RequestMap['open']['params'];
      if (p.visualize) {
        const u = new URL(location.href);
        u.searchParams.set('path', p.uri);
        if (p.view) u.searchParams.set('view', p.view);
        else u.searchParams.delete('view');
        if (p.symbol) u.searchParams.set('symbol', p.symbol);
        else u.searchParams.delete('symbol');
        history.pushState(null, '', u);
        await this.init();
        return undefined as RequestMap[K]['result'];
      }
    }
    const res = await fetch(this.url('/api/rpc'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error ?? res.statusText);
    return body.result;
  }

  private async init(): Promise<void> {
    const q = new URLSearchParams(location.search);
    const params: Record<string, string> = {};
    for (const k of ['path', 'view', 'symbol', 'line']) {
      const v = q.get(k);
      if (v) params[k] = v;
    }
    const res = await fetch(this.url('/api/init', params));
    const payload = (await res.json()) as InitPayload & { error?: string };
    this.emit({ type: 'init', payload });
    this.watch(payload.target?.uri);
  }

  private watch(uri?: string): void {
    this.events?.close();
    this.events = null;
    if (!uri) return;
    this.events = new EventSource(this.url('/api/events', { uri }));
    this.events.onmessage = (ev) => {
      try {
        this.emit(JSON.parse(ev.data) as HostEvent);
      } catch {
        // ignore malformed events
      }
    };
  }

  ready(): void {
    window.addEventListener('popstate', () => void this.init());
    void this.init();
  }
}

export function download(name: string, data: string | Uint8Array, mime: string): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
