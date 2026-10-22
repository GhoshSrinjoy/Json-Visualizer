/**
 * Stand-alone browser host (no backend): data files come from drag & drop,
 * the file picker, paste or a `?url=` parameter. Code/repo analysis needs the
 * VS Code extension or the CLI.
 */

import { decodeText, detectFormat } from '../../core/data/formats';
import { DEFAULT_SETTINGS, type InitPayload, type RequestMap, type RequestName, type UiSettings } from '../../shared/protocol';
import { VERSION } from '../../shared/version';
import { BaseHost, fetchSchema, openWebLink, pickDataFile, pickTextFile } from './host';
import { download } from './server';

const SETTINGS_KEY = 'structlens.settings';

export class BrowserHost extends BaseHost {
  kind = 'browser' as const;
  private docs = new Map<string, { bytes: Uint8Array; version: number }>();
  private seq = 0;

  private settings(): UiSettings {
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<UiSettings>) };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  async request<K extends RequestName>(method: K, params: RequestMap[K]['params']): Promise<RequestMap[K]['result']> {
    switch (method) {
      case 'getData': {
        const d = this.docs.get((params as RequestMap['getData']['params']).uri);
        if (!d) throw new Error('Document not found');
        return { bytes: d.bytes, version: d.version } as RequestMap[K]['result'];
      }
      case 'saveFile': {
        const { name, data, mime } = params as RequestMap['saveFile']['params'];
        download(name, data, mime);
        return { saved: true } as RequestMap[K]['result'];
      }
      case 'copyText':
        await navigator.clipboard.writeText((params as RequestMap['copyText']['params']).text);
        return undefined as RequestMap[K]['result'];
      case 'setSettings':
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...this.settings(), ...(params as Partial<UiSettings>) }));
        } catch {
          // storage unavailable (private mode); settings stay in memory
        }
        return undefined as RequestMap[K]['result'];
      case 'applyEdit': {
        const p = params as RequestMap['applyEdit']['params'];
        const d = this.docs.get(p.uri);
        if (!d) throw new Error('Document not found');
        let text = decodeText(d.bytes);
        for (const e of p.edits) if (text.slice(e.check.from, e.offset + e.length) !== e.check.text) throw new Error('The document changed since the view loaded it.');
        for (const e of [...p.edits].sort((a, b) => b.offset - a.offset)) text = text.slice(0, e.offset) + e.text + text.slice(e.offset + e.length);
        this.updateDocument(p.uri, text);
        return undefined as RequestMap[K]['result'];
      }
      case 'loadSchema': {
        const { ref } = params as RequestMap['loadSchema']['params'];
        return (ref && /^https?:/i.test(ref) ? await fetchSchema(ref) : null) as RequestMap[K]['result'];
      }
      case 'pickDataFile':
        return (await pickDataFile()) as RequestMap[K]['result'];
      case 'pickSchema':
        return (await pickTextFile('.json,.yaml,.yml,application/json')) as RequestMap[K]['result'];
      case 'openExternal':
        openWebLink((params as RequestMap['openExternal']['params']).url);
        return undefined as RequestMap[K]['result'];
      case 'reveal':
      case 'notify':
        return undefined as RequestMap[K]['result'];
      default:
        throw new Error('This needs the StructLens VS Code extension or CLI.');
    }
  }

  /** Loads bytes as a new document and re-initializes the UI. */
  openDocument(name: string, bytes: Uint8Array): void {
    const uri = `mem://${++this.seq}/${name}`;
    const prev = this.docs.get(uri);
    this.docs.set(uri, { bytes, version: (prev?.version ?? 0) + 1 });
    const head = new TextDecoder().decode(bytes.subarray(0, 64 * 1024));
    const format = detectFormat(name, undefined, head) ?? 'json';
    this.emit({ type: 'init', payload: this.payload({ mode: 'data', target: { uri, path: name, name, format } }) });
  }

  /** Replaces the text of the current in-memory document (editor tab). */
  updateDocument(uri: string, text: string): void {
    const d = this.docs.get(uri);
    const bytes = new TextEncoder().encode(text);
    const version = (d?.version ?? 0) + 1;
    this.docs.set(uri, { bytes, version });
    this.emit({ type: 'changed', uri, version });
  }

  private payload(p: Pick<InitPayload, 'mode' | 'target'>): InitPayload {
    return {
      ...p,
      settings: this.settings(),
      host: 'browser',
      capabilities: { reveal: false, code: false, repo: false, settings: true, edit: true },
      version: VERSION,
    };
  }

  ready(): void {
    const q = new URLSearchParams(location.search);
    const url = q.get('url');
    if (url) {
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          return r.arrayBuffer();
        })
        .then((buf) => this.openDocument(url.split('/').pop()?.split('?')[0] || 'document.json', new Uint8Array(buf)))
        .catch((e: Error) => this.emit({ type: 'init', payload: { ...this.payload({ mode: 'welcome' }), notice: `Could not load ${url}: ${e.message}` } }));
      return;
    }
    this.emit({ type: 'init', payload: this.payload({ mode: 'welcome' }) });
  }
}
