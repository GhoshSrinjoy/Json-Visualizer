/** Landing screen for the stand-alone browser build: drop, open, paste or try a sample. */

import { useState } from 'preact/hooks';
import { openFilePicker } from '../components/Toolbar';
import { BrandMark, Icon, type IconName } from '../components/icons';
import { BrowserHost } from '../host/browser';
import { app, host, useStore } from '../store';

const enc = (s: string) => new TextEncoder().encode(s);

const SAMPLES: { name: string; label: string; make: () => string }[] = [
  {
    name: 'api-response.json',
    label: 'API response',
    make: () =>
      JSON.stringify(
        {
          status: 'ok',
          page: { number: 1, size: 3, total: 1284 },
          data: [
            { id: 'u_01', name: 'Ada Lovelace', email: 'ada@example.com', roles: ['admin', 'author'], active: true, profile: { city: 'London', joined: '2021-03-04T10:00:00Z', score: 98.5 } },
            { id: 'u_02', name: 'Alan Turing', email: 'alan@example.com', roles: ['author'], active: false, profile: { city: 'Manchester', joined: '2022-07-21T09:30:00Z', score: 91.2 } },
            { id: 'u_03', name: 'Grace Hopper', email: null, roles: [], active: true, profile: { city: 'New York', joined: '2020-11-11T15:45:00Z', score: 99.9 } },
          ],
          links: { self: '/users?page=1', next: '/users?page=2' },
        },
        null,
        2,
      ),
  },
  {
    name: 'deployment.yaml',
    label: 'Kubernetes YAML',
    make: () => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels: { app: web, tier: frontend }
spec:
  replicas: 3
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: nginx:1.27
          ports: [{ containerPort: 80 }]
          resources:
            limits: { cpu: 500m, memory: 256Mi }
          env:
            - { name: MODE, value: production }
            - { name: CACHE_TTL, value: "300" }
`,
  },
  {
    name: 'catalog.xml',
    label: 'XML catalog',
    make: () => `<?xml version="1.0"?>
<catalog updated="2026-10-01">
  <book id="bk101" lang="en"><author>Gambardella, Matthew</author><title>XML Developer's Guide</title><price currency="USD">44.95</price></book>
  <book id="bk102" lang="en"><author>Ralls, Kim</author><title>Midnight Rain</title><price currency="USD">5.95</price></book>
  <magazine id="mg01"><title>Data Monthly</title><issue>42</issue></magazine>
</catalog>`,
  },
  {
    name: 'large-dataset.json',
    label: 'Large: 200k records',
    make: () => {
      const parts: string[] = [];
      for (let i = 0; i < 200_000; i++) parts.push(`{"id":${i},"name":"User ${i}","tags":["t${i % 7}","t${i % 13}"],"active":${i % 3 !== 0},"score":${(i * 37) % 1000 / 10},"geo":{"lat":${((i * 7) % 180) - 90},"lng":${((i * 13) % 360) - 180}}}`);
      return `[${parts.join(',')}]`;
    },
  },
];

const FEATURES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'graph', title: 'Graph, tree & table', text: 'Interactive views for JSON, YAML, XML, TOML, CSV and more — handles files with millions of values.' },
  { icon: 'braces', title: 'Schema & queries', text: 'Inferred schemas, JSON Schema / TypeScript export and JSONPath filters.' },
  { icon: 'flow', title: 'Code logic & data flow', text: 'Flowcharts, data flow and call graphs for 14+ languages (VS Code extension or CLI).' },
  { icon: 'bot', title: 'For AI agents too', text: 'An MCP server lets Claude Code, Codex, Copilot & Cursor read the same structures.' },
];

export function Welcome() {
  const [over, setOver] = useState(false);
  const [text, setText] = useState('');
  const notice = useStore(app, (s) => s.init?.notice);
  const browser = host() as BrowserHost;

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) browser.openDocument(f.name, new Uint8Array(await f.arrayBuffer()));
    else {
      const t = e.dataTransfer?.getData('text/plain');
      if (t) browser.openDocument(guessName(t), enc(t));
    }
  };

  return (
    <div class="welcome" onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div class="welcome-inner">
        <div class="hero">
          <BrandMark size={52} />
          <div>
            <h1>StructLens</h1>
            <p>See the structure of any data file, codebase or repository — fast, even for huge files.</p>
          </div>
        </div>
        {notice && <div class="notice">{notice}</div>}
        <div class={`dropzone ${over ? 'over' : ''}`}>
          <Icon name="upload" />
          <div>
            <b>Drop a file here</b> or{' '}
            <button class="btn primary" onClick={() => openFilePicker()}>
              Open file…
            </button>
          </div>
          <small>JSON · JSONC · JSON Lines · YAML · XML · HTML · TOML · CSV · TSV · Excel · INI · .env · .properties — parsed locally, nothing is uploaded.</small>
        </div>
        <div class="paste">
          <textarea placeholder="…or paste JSON, YAML, XML, CSV here" value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} spellcheck={false} />
          <div class="row" style={{ marginTop: '8px' }}>
            <button class="btn primary" disabled={!text.trim()} onClick={() => browser.openDocument(guessName(text), enc(text))}>
              Visualize
            </button>
            <span style={{ color: 'var(--text-faint)', fontSize: '12px' }}>Try a sample:</span>
            {SAMPLES.map((s) => (
              <button key={s.name} class="btn outline" onClick={() => browser.openDocument(s.name, enc(s.make()))}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div class="features">
          {FEATURES.map((f) => (
            <div class="feature" key={f.title}>
              <b>
                <Icon name={f.icon} />
                {f.title}
              </b>
              {f.text}
            </div>
          ))}
        </div>
        <div class="feature" style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
          <b>
            <Icon name="terminal" /> Code &amp; repositories from your terminal
          </b>
          npx structlens . &nbsp;·&nbsp; npx structlens mcp &nbsp;·&nbsp; or install the VS Code extension
        </div>
      </div>
    </div>
  );
}

function guessName(text: string): string {
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return /\n\s*[{[]/.test(t) && /}\s*\n\s*{/.test(t) ? 'pasted.jsonl' : 'pasted.json';
  if (t.startsWith('<')) return /^<!doctype html|^<html/i.test(t) ? 'pasted.html' : 'pasted.xml';
  if (/^[^\n,]+(,[^\n,]+)+\n/.test(t)) return 'pasted.csv';
  if (/^\[[^\]]+\]\s*$/m.test(t) && /=/.test(t)) return 'pasted.toml';
  return 'pasted.yaml';
}
