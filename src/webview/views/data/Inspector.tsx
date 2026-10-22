/** Right-hand panel: node details when something is selected, document overview otherwise. */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { EditCaps, EditMode } from '../../../core/data/edit';
import { FORMAT_LABELS } from '../../../core/data/formats';
import { formatBytes, withCommas } from '../../../core/util/strings';
import { Icon } from '../../components/icons';
import { app, copy, host, toast, useStore } from '../../store';
import type { NodeDetail } from '../../worker/protocol';
import { useData } from './context';
import { copyValue } from './actions';
import { EditActions, EditForm } from './EditPanel';
import { NodeValidation, ValidationSection } from './Validation';
import { ValuePreview } from './ValuePreview';

const TYPE_VARS: Record<string, string> = {
  object: 'var(--t-object)', array: 'var(--t-array)', string: 'var(--t-string)', number: 'var(--t-number)', boolean: 'var(--t-boolean)', null: 'var(--t-null)',
};

export function DataInspector() {
  const ctx = useData();
  const { client, selected } = ctx;
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const caps = useStore(app, (s) => s.init?.capabilities);
  const [editCaps, setEditCaps] = useState<EditCaps | null>(null);
  const [mode, setMode] = useState<EditMode | null>(null);
  const handled = useRef(0);

  useEffect(() => {
    if (selected === null) return setDetail(null);
    let alive = true;
    void client.call('detail', { id: selected, maxChars: 20000 }).then(async (d) => {
      // Embedded images can be long: fetch them whole so the preview works.
      if (d.valueTruncated && d.type === 'string' && d.value.startsWith('data:image/')) d = await client.call('detail', { id: d.id, maxChars: 16_000_000 });
      if (!alive) return;
      setDetail(d);
      setMode(null);
      setEditCaps(ctx.edit ? await client.call('editCaps', { id: d.id }) : null);
    });
    return () => {
      alive = false;
    };
  }, [client, selected, ctx.summary]);

  // Menus and shortcuts elsewhere ask for the editor of a node.
  useEffect(() => {
    const r = ctx.editRequest;
    if (r && r.seq !== handled.current && detail?.id === r.id && editCaps) {
      handled.current = r.seq;
      setMode(r.mode);
    }
  }, [ctx.editRequest?.seq, detail, editCaps]);

  // F2 edits (or renames a container), Delete asks to delete — unless the user is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!detail || !editCaps || mode || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const container = detail.type === 'object' || detail.type === 'array';
      if (e.key === 'F2' && (editCaps.set || editCaps.rename)) setMode(editCaps.set && !container ? 'set' : editCaps.rename ? 'rename' : 'set');
      else if (e.key === 'Delete' && editCaps.delete) setMode('delete');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail, editCaps, mode]);

  if (!detail) return <Overview />;
  const d = detail;
  const container = d.type === 'object' || d.type === 'array';
  const keyText = d.key === null ? '$' : typeof d.key === 'number' ? `[${d.key}]` : d.key;
  return (
    <div class="panel-body">
      <div class="panel-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <span class="glyph" style={{ color: TYPE_VARS[d.type] }}>
            {d.type === 'object' ? '{}' : d.type === 'array' ? '[]' : d.type[0].toUpperCase()}
          </span>
          <b style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', wordBreak: 'break-all' }}>{keyText}</b>
          <span class="spacer" />
          <span class="type-badge" style={{ color: TYPE_VARS[d.type] }}>
            {d.element ? 'element' : d.attr ? 'attribute' : d.type}
          </span>
        </div>
        <div class="path" title="JSONPath">
          {d.path}
        </div>
      </div>
      <div class="panel-section">
        <div class="actions">
          <button class="btn" onClick={() => copy(d.path, `Copied ${d.path}`)}>
            <Icon name="link" /> Path
          </button>
          <button class="btn" onClick={() => void copyValue(client, d.id)}>
            <Icon name="copy" /> Value
          </button>
          {container && (
            <button class="btn" onClick={() => client.call('json', { id: d.id, indent: 2, maxChars: 50_000_000 }).then((t) => copy(t, 'JSON copied'), (e: Error) => toast(e.message, 'error'))}>
              <Icon name="braces" /> JSON
            </button>
          )}
          {caps?.reveal && d.start && (
            <button class="btn" onClick={() => ctx.revealInEditor(d.id)}>
              <Icon name="external" /> Reveal
            </button>
          )}
          {container && (
            <button class="btn" onClick={() => ctx.openTable(d.id)}>
              <Icon name="table" /> Table
            </button>
          )}
          {editCaps && <EditActions caps={editCaps} d={d} onEdit={setMode} />}
          {d.parent >= 0 && d.parent >= ctx.summary.root && (
            <button class="btn" onClick={() => ctx.select(d.parent, { focus: true })} title="Select parent">
              <Icon name="chevronUp" /> Parent
            </button>
          )}
        </div>
      </div>
      {mode && <EditForm key={`${d.id}:${mode}`} d={d} mode={mode} onDone={() => setMode(null)} />}
      <NodeValidation id={d.id} />
      {!container && !d.valueTruncated && <ValuePreview type={d.type} value={d.value} valueKey={d.key} />}
      <div class="panel-section">
        <p class="section-title">{container ? 'Content' : 'Value'}</p>
        <pre class="code-block">
          {d.value}
          {d.valueTruncated && '\n…'}
        </pre>
      </div>
      <div class="panel-section">
        <dl class="kv">
          {container && (
            <>
              <dt>Children</dt>
              <dd>{withCommas(d.count)}</dd>
              <dt>Descendants</dt>
              <dd>{withCommas(d.descendants)}</dd>
            </>
          )}
          {!container && d.type === 'string' && (
            <>
              <dt>Length</dt>
              <dd>{withCommas(d.value.length)}{d.valueTruncated ? '+' : ''}</dd>
            </>
          )}
          <dt>Depth</dt>
          <dd>{d.depth}</dd>
          {d.start && (
            <>
              <dt>Location</dt>
              <dd>
                Ln {d.start.line + 1}, Col {d.start.col + 1}
                {d.end && d.end.line !== d.start.line ? ` → Ln ${d.end.line + 1}` : ''}
              </dd>
            </>
          )}
        </dl>
      </div>
    </div>
  );
}

function Overview() {
  const { summary, target } = useData();
  const counts = Object.entries(summary.typeCounts).filter(([k, v]) => v > 0 && k !== 'unknown');
  const max = Math.max(1, ...counts.map(([, v]) => v));
  return (
    <div class="panel-body">
      <div class="panel-section">
        <p class="section-title">Document</p>
        <dl class="kv">
          <dt>File</dt>
          <dd>{target.path}</dd>
          <dt>Format</dt>
          <dd>{FORMAT_LABELS[summary.format]}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(summary.bytes)}</dd>
          <dt>Lines</dt>
          <dd>{withCommas(summary.lines)}</dd>
          <dt>Values</dt>
          <dd>{withCommas(summary.nodes)}</dd>
          <dt>Max depth</dt>
          <dd>{summary.maxDepth}</dd>
          <dt>Parsed in</dt>
          <dd>{summary.parseMs < 1 ? '<1' : Math.round(summary.parseMs)} ms</dd>
        </dl>
      </div>
      <div class="panel-section">
        <p class="section-title">Value types</p>
        {counts.map(([k, v]) => (
          <div class="bar-row" key={k}>
            <span class="label">
              <i class="dot" style={{ background: TYPE_VARS[k] }} />
              {k}
            </span>
            <span class="track">
              <i style={{ width: `${(v / max) * 100}%`, background: TYPE_VARS[k] }} />
            </span>
            <span class="num">{withCommas(v)}</span>
          </div>
        ))}
      </div>
      <ValidationSection />
      {summary.errors.length > 0 && <ErrorList />}
      <div class="panel-section" style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
        <Icon name="info" style={{ display: 'inline', verticalAlign: '-3px', marginRight: '6px' }} />
        Select a node to see its path and value. Search with text, or switch to <b>$</b> for JSONPath queries.
      </div>
    </div>
  );
}

function ErrorList() {
  const { summary, target } = useData();
  const caps = useStore(app, (s) => s.init?.capabilities);
  return (
    <div class="panel-section">
      <p class="section-title" style={{ color: 'var(--danger)' }}>
        {summary.errors.length} parse {summary.errors.length === 1 ? 'issue' : 'issues'}
      </p>
      {summary.errors.slice(0, 50).map((e, i) => (
        <div
          key={i}
          class="error-item"
          onClick={() => caps?.reveal && host().request('reveal', { uri: target.uri, line: e.line - 1, col: e.col - 1 })}
          title={caps?.reveal ? 'Reveal in editor' : undefined}
        >
          <b>
            {e.line}:{e.col}
          </b>
          <span>{e.message}</span>
        </div>
      ))}
    </div>
  );
}
