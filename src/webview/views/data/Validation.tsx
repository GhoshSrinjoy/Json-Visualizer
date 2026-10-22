/** Inspector sections for JSON Schema validation: the document's status, and a selected node's errors. */

import { Icon } from '../../components/icons';
import { useData } from './context';

const SOURCE: Record<string, string> = {
  document: 'From the document’s $schema.',
  settings: 'From your editor’s schema settings (json.schemas / yaml.schemas).',
  picked: 'Chosen by you.',
};

export function ValidationSection() {
  const ctx = useData();
  const v = ctx.validation;
  if (!v) {
    return (
      <div class="panel-section">
        <p class="section-title">Schema</p>
        <p class="pv-note val-blurb">Check this document against a JSON Schema: every error is pinned to its node in the graph, tree and editor.</p>
        <button class="btn outline" onClick={() => void ctx.validateWith()}>
          <Icon name="check" /> Validate against a schema…
        </button>
      </div>
    );
  }
  const r = v.result;
  return (
    <div class="panel-section">
      <p class="section-title">Schema</p>
      <div class="val-head">
        <span class="val-name" title={v.ref}>
          {v.name}
        </span>
        <span class="spacer" />
        <button class="btn mini" title="Check again" onClick={() => void ctx.validateWith(v.source === 'picked' ? undefined : v.ref)}>
          <Icon name="refresh" />
        </button>
        <button class="btn mini" title="Use another schema" onClick={() => void ctx.validateWith()}>
          <Icon name="folder" />
        </button>
        <button class="btn mini" title="Stop validating" onClick={() => ctx.clearValidation()}>
          <Icon name="x" />
        </button>
      </div>
      {v.error ? (
        <div class="error-item">
          <span>{v.error}</span>
        </div>
      ) : !r ? (
        <p class="pv-note">Checking…</p>
      ) : r.valid ? (
        <p class="val-ok">
          <Icon name="check" /> Valid
        </p>
      ) : (
        <>
          <p class="val-bad">
            {r.errors.length.toLocaleString()}
            {r.truncated ? '+' : ''} {r.errors.length === 1 ? 'error' : 'errors'}
          </p>
          {r.errors.slice(0, 200).map((e, i) => (
            <div key={i} class="error-item" onClick={() => ctx.select(e.id, { focus: true })} title="Show this node">
              <b>{e.path}</b>
              <span>{e.message}</span>
            </div>
          ))}
          {r.errors.length > 200 && <p class="pv-note">…and {(r.errors.length - 200).toLocaleString()} more.</p>}
        </>
      )}
      {v.unresolved.length > 0 && <p class="pv-note">Could not load {v.unresolved.join(', ')}; those parts were not checked.</p>}
      {!!r?.unsupported.length && <p class="pv-note">Not checked: {r.unsupported.join(', ')}.</p>}
      <p class="pv-note">{SOURCE[v.source]}</p>
    </div>
  );
}

/** A selected node's schema errors (when there are any). */
export function NodeValidation({ id }: { id: number }) {
  const messages = useData().validation?.byId.get(id);
  if (!messages?.length) return null;
  return (
    <div class="panel-section">
      <p class="section-title" style={{ color: 'var(--danger)' }}>
        Schema {messages.length === 1 ? 'error' : 'errors'}
      </p>
      {messages.map((m, i) => (
        <div key={i} class="error-item">
          <span>{m}</span>
        </div>
      ))}
    </div>
  );
}
