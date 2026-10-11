/** Inferred schema of the document (or the selected subtree), with JSON Schema / TypeScript export. */

import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../../components/icons';
import { CenterMessage } from '../../components/ui';
import { copy, host, toast } from '../../store';
import type { SchemaView } from '../../worker/protocol';
import { useData } from './context';
import { stem } from '../shared';

export function SchemaPane() {
  const { client, summary, selected, target } = useData();
  const [scope, setScope] = useState<number>(summary.root);
  const [schema, setSchema] = useState<SchemaView | null>(null);
  const [scopePath, setScopePath] = useState('$');

  // Follow the selection when it is a container.
  useEffect(() => {
    if (selected === null) return;
    void client.call('node', { id: selected }).then((n) => {
      if ((n.type === 'object' || n.type === 'array') && n.count > 0) setScope(selected);
    });
  }, [selected]);

  useEffect(() => {
    let alive = true;
    setSchema(null);
    void Promise.all([client.call('schema', { id: scope }), client.call('detail', { id: scope, maxChars: 0 })]).then(([s, d]) => {
      if (!alive) return;
      setSchema(s);
      setScopePath(d.path);
    });
    return () => {
      alive = false;
    };
  }, [client, scope]);

  const exportAs = async (kind: 'json-schema' | 'typescript' | 'text', save = false) => {
    const text = await client.call('exportSchema', { id: scope, kind });
    if (!save) return copy(text, kind === 'typescript' ? 'TypeScript types copied' : kind === 'json-schema' ? 'JSON Schema copied' : 'Schema copied');
    const ext = kind === 'typescript' ? 'd.ts' : kind === 'json-schema' ? 'schema.json' : 'schema.txt';
    const r = await host().request('saveFile', { name: `${stem(target.name)}.${ext}`, data: text, mime: kind === 'json-schema' ? 'application/schema+json' : 'text/plain' });
    if (r.path) toast(`Saved ${r.path}`);
  };

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
          <button class="btn outline" onClick={() => exportAs('json-schema')} title="Copy as JSON Schema (draft 2020-12)">
            <Icon name="braces" /> JSON Schema
          </button>
          <button class="btn outline" onClick={() => exportAs('typescript')} title="Copy as TypeScript interfaces">
            <Icon name="code" /> TypeScript
          </button>
          <button class="btn outline" onClick={() => exportAs('text')} title="Copy compact text (great for AI prompts)">
            <Icon name="sparkles" /> Text
          </button>
          <button class="btn" onClick={() => exportAs('json-schema', true)} title="Save JSON Schema file">
            <Icon name="download" />
          </button>
        </div>
        <SchemaRow name="$" s={schema} depth={0} />
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
