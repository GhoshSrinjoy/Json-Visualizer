/** Inferred schema of the document (or the selected subtree), plus generated types in ten languages and JSON Schema. */

import { useEffect, useRef, useState } from 'preact/hooks';
import { TYPE_TARGETS, type TypeTarget } from '../../../core/data/targets';
import type { PathSegment } from '../../../core/data/tree';
import { Icon } from '../../components/icons';
import { CenterMessage } from '../../components/ui';
import { copy, host, toast } from '../../store';
import type { SchemaView } from '../../worker/protocol';
import { useData } from './context';
import { stem } from '../shared';

/** What the code view can show: types per language, the JSON Schema, or compact text for prompts. */
const OUTPUTS: { id: TypeTarget | 'json-schema' | 'text'; label: string; ext: string; mime: string }[] = [
  ...TYPE_TARGETS.map((t) => ({ ...t, mime: 'text/plain' })),
  { id: 'json-schema', label: 'JSON Schema', ext: 'schema.json', mime: 'application/schema+json' },
  { id: 'text', label: 'Compact text (for AI prompts)', ext: 'schema.txt', mime: 'text/plain' },
];
let lastOutput: (typeof OUTPUTS)[number]['id'] = 'typescript';

/** `users`, `[3]`, `my-file.json` → `Users`, `Item`, `MyFile` (the generated root type's name). */
function typeName(source: string): string {
  const words = source.replace(/\.[^.]+$/, '').match(/[A-Za-z0-9]+/g) ?? [];
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(name) ? name : 'Root';
}

export function SchemaPane() {
  const ctx = useData();
  const { client, summary, selected, target } = ctx;
  const [scope, setScope] = useState<number>(summary.root);
  const [schema, setSchema] = useState<SchemaView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scopePath, setScopePath] = useState('$');
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const restore = useRef<PathSegment[] | null>(null);
  const [mode, setMode] = useState<'tree' | 'code'>('tree');
  const [output, setOutput] = useState(lastOutput);
  const [code, setCode] = useState<string | null>(null);

  useEffect(
    () =>
      ctx.beforeReload(async () => {
        [restore.current] = await client.call('pathsOf', { ids: [scopeRef.current] });
      }),
    [client],
  );

  // Follow the selection when it is a container.
  useEffect(() => {
    if (selected === null) return;
    void client.call('node', { id: selected }).then((n) => {
      if ((n.type === 'object' || n.type === 'array') && n.count > 0) setScope(selected);
    });
  }, [selected]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // After a re-parse, find the scope again by path (ids change).
      const path = restore.current;
      restore.current = null;
      let id = scope;
      if (path) {
        id = (await client.call('idsOf', { paths: [path] }))[0];
        if (id < 0) id = summary.root;
        if (id !== scope) return alive && setScope(id);
      }
      const [s, d] = await Promise.all([client.call('schema', { id }), client.call('detail', { id, maxChars: 0 })]);
      if (!alive) return;
      setSchema(s);
      setScopePath(d.path);
      setError(null);
    })().catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [client, scope, summary]);

  const rootName = typeName(scope === summary.root ? target.name : scopePath.split(/[.[\]'"]+/).filter(Boolean).pop() ?? 'Root');
  const generate = (id: (typeof OUTPUTS)[number]['id']) =>
    id === 'json-schema' || id === 'text' ? client.call('exportSchema', { id: scope, kind: id }) : client.call('types', { id: scope, target: id, rootName });

  useEffect(() => {
    if (mode !== 'code') return;
    let alive = true;
    setCode(null);
    generate(output).then(
      (t) => alive && setCode(t),
      (e: Error) => alive && setCode(`// ${e.message}`),
    );
    return () => {
      alive = false;
    };
  }, [mode, output, scope, summary]);

  const pickOutput = (id: (typeof OUTPUTS)[number]['id']) => {
    lastOutput = id;
    setOutput(id);
  };

  const save = async () => {
    const o = OUTPUTS.find((x) => x.id === output)!;
    const text = code ?? (await generate(output));
    const r = await host().request('saveFile', { name: `${o.id === 'json-schema' || o.id === 'text' ? stem(target.name) : rootName}.${o.ext}`, data: text, mime: o.mime });
    if (r.path) toast(`Saved ${r.path}`);
  };

  if (error) return <CenterMessage>{`Could not infer the schema: ${error}`}</CenterMessage>;
  if (!schema) return <CenterMessage spinner>Inferring schema…</CenterMessage>;
  return (
    <div class="view-fill">
      <div class="schema">
        <div class="schema-toolbar">
          <span class="path">{scopePath}</span>
          {scope !== summary.root && (
            <button class="btn outline" onClick={() => setScope(summary.root)}>
              Whole document
            </button>
          )}
          <span class="spacer" />
          <div class="segmented" role="tablist">
            <button class={`btn ${mode === 'tree' ? 'active' : ''}`} role="tab" aria-selected={mode === 'tree'} onClick={() => setMode('tree')}>
              <Icon name="tree" /> Structure
            </button>
            <button class={`btn ${mode === 'code' ? 'active' : ''}`} role="tab" aria-selected={mode === 'code'} onClick={() => setMode('code')} title="Types for TypeScript, Zod, Python, Go, Rust, C#, Kotlin, Swift, Java; JSON Schema">
              <Icon name="code" /> Types &amp; schema
            </button>
          </div>
          {mode === 'code' && (
            <>
              <select class="lang-select" value={output} onChange={(e) => pickOutput((e.target as HTMLSelectElement).value as typeof output)}>
                {OUTPUTS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button class="btn outline" disabled={code === null} onClick={() => code !== null && copy(code, `${OUTPUTS.find((o) => o.id === output)!.label} copied`)}>
                <Icon name="copy" /> Copy
              </button>
              <button class="btn" onClick={() => void save()} title="Save to a file">
                <Icon name="download" />
              </button>
            </>
          )}
        </div>
        {mode === 'tree' ? <SchemaRow name="$" s={schema} depth={0} /> : code === null ? <CenterMessage spinner>Generating…</CenterMessage> : <pre class="code-view">{code}</pre>}
      </div>
    </div>
  );
}

function TypeBadges({ s }: { s: SchemaView }) {
  return (
    <>
      {s.typeText.split(' | ').map((t) => {
        const base = t.replace(/<.*$/, '').replace(/^map$/, 'object');
        return (
          <span key={t} class={`type-badge ${base}`}>
            {t}
          </span>
        );
      })}
    </>
  );
}

function notes(s: SchemaView): string[] {
  const n: string[] = [];
  if (s.minItems !== undefined) n.push(s.minItems === s.maxItems ? `${s.minItems} items` : `${s.minItems.toLocaleString()}–${s.maxItems!.toLocaleString()} items`);
  if (s.mapKeys !== undefined) n.push(`${s.mapKeys.toLocaleString()} dynamic keys`);
  if (s.format) n.push(s.format);
  if (s.enumValues) n.push(`enum ${s.enumValues.slice(0, 8).join(' | ')}${s.enumValues.length > 8 ? ' …' : ''}`);
  else if (s.min !== undefined && s.types.number) n.push(s.min === s.max ? `= ${s.min}` : `${round(s.min)} … ${round(s.max!)}`);
  else if (s.examples.length && (s.types.string || s.types.number)) n.push(`e.g. ${s.examples.join(', ')}`);
  return n;
}

function round(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : (Math.round(n * 1000) / 1000).toString();
}

function SchemaRow({ name, s, depth, optional, presence }: { name: string; s: SchemaView; depth: number; optional?: boolean; presence?: number }) {
  const [open, setOpen] = useState(depth < 3);
  const hasKids = !!(s.fields?.length || s.mapOf || s.items?.fields || s.items?.mapOf || s.items?.items);
  return (
    <div>
      <div class="schema-row">
        <span class={`twisty ${open ? 'open' : ''}`} style={{ visibility: hasKids ? 'visible' : 'hidden' }} onClick={() => setOpen(!open)}>
          <Icon name="chevronRight" />
        </span>
        <span class={`schema-key ${optional ? 'optional' : ''}`} style={s.attr ? { color: 'var(--k-interface)' } : undefined}>
          {name}
        </span>
        <TypeBadges s={s} />
        {optional && presence !== undefined && (
          <span title={`present in ${Math.round(presence * 100)}% of objects`}>
            <span class="presence">
              <i style={{ width: `${Math.round(presence * 100)}%` }} />
            </span>{' '}
            <span class="schema-note">{Math.round(presence * 100)}%</span>
          </span>
        )}
        {notes(s).map((x) => (
          <span key={x} class="schema-note">
            {x}
          </span>
        ))}
      </div>
      {open && hasKids && (
        <div class="schema-node">
          {s.fields?.map((f) => <SchemaRow key={f.key} name={f.key} s={f.schema} depth={depth + 1} optional={f.optional} presence={f.presence} />)}
          {s.mapOf && <SchemaRow name="[key]" s={s.mapOf} depth={depth + 1} />}
          {s.items && (s.items.fields || s.items.mapOf || s.items.items) && <SchemaRow name="[ ]" s={s.items} depth={depth + 1} />}
        </div>
      )}
    </div>
  );
}
