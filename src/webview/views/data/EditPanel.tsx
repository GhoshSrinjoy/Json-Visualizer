/** Inspector editor: change a value, rename a key, delete an entry or add one; written back to the file. */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { EditCaps, EditMode, ValueKind } from '../../../core/data/edit';
import { formatPath } from '../../../core/util/strings';
import { Icon } from '../../components/icons';
import type { NodeDetail } from '../../worker/protocol';
import { useData } from './context';

const KINDS: ValueKind[] = ['string', 'number', 'boolean', 'null', 'json'];
export function EditActions({ caps, d, onEdit }: { caps: EditCaps; d: NodeDetail; onEdit: (mode: EditMode) => void }) {
  const container = d.type === 'object' || d.type === 'array';
  return (
    <>
      {caps.set && (
        <button class="btn" onClick={() => onEdit('set')} title="Change this value (F2)">
          <Icon name="code" /> Edit
        </button>
      )}
      {caps.rename && (
        <button class="btn" onClick={() => onEdit('rename')} title="Rename this key">
          <Icon name="fileText" /> Rename
        </button>
      )}
      {caps.add && container && (
        <button class="btn" onClick={() => onEdit('add')} title={d.type === 'object' ? 'Add a property' : 'Add an item'}>
          <Icon name="plus" /> {d.type === 'object' ? 'Property' : 'Item'}
        </button>
      )}
      {caps.delete && (
        <button class="btn danger" onClick={() => onEdit('delete')} title="Delete this entry">
          <Icon name="x" /> Delete
        </button>
      )}
    </>
  );
}

export function EditForm({ d, mode, onDone }: { d: NodeDetail; mode: EditMode; onDone: () => void }) {
  const { edit } = useData();
  const container = d.type === 'object' || d.type === 'array';
  const keyText = typeof d.key === 'string' ? d.key : '';
  const initialKind: ValueKind = mode === 'add' ? 'string' : container ? 'json' : (d.type as ValueKind);
  const [kind, setKind] = useState<ValueKind>(initialKind);
  const [value, setValue] = useState(mode === 'set' ? (d.type === 'null' ? '' : d.value) : '');
  const [key, setKey] = useState(mode === 'rename' ? keyText : '');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus(), [mode, d.id]);

  const save = async () => {
    if (!edit || busy) return;
    setBusy(true);
    // Each change says where the selection should land once the file is re-read.
    const parent = d.segments.slice(0, -1);
    const ok =
      mode === 'set'
        ? await edit({ kind: 'set', id: d.id, type: kind, value }, d.path)
        : mode === 'rename'
          ? await edit({ kind: 'rename', id: d.id, key }, formatPath([...parent, key]))
          : mode === 'delete'
            ? await edit({ kind: 'delete', id: d.id }, formatPath(parent))
            : await edit({ kind: 'add', id: d.id, key: d.type === 'object' ? key : undefined, type: kind, value }, formatPath([...d.segments, d.type === 'object' ? key : d.count]));
    setBusy(false);
    if (ok) onDone();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onDone();
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !(e.target instanceof HTMLTextAreaElement))) {
      e.preventDefault();
      void save();
    }
  };

  if (mode === 'delete') {
    return (
      <div class="panel-section edit-form" onKeyDown={onKey}>
        <p class="section-title">Delete</p>
        <p class="edit-note">
          Delete <b>{d.key === null ? '$' : typeof d.key === 'number' ? `item ${d.key}` : `"${d.key}"`}</b>
          {container && d.count ? ` and its ${d.count.toLocaleString()} ${d.count === 1 ? 'child' : 'children'}` : ''} from the file?
        </p>
        <div class="edit-buttons">
          <button class="btn danger solid" disabled={busy} onClick={() => void save()} ref={first as never}>
            Delete
          </button>
          <button class="btn" onClick={onDone}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  const showValue = mode !== 'rename';
  const showKey = mode === 'rename' || (mode === 'add' && d.type === 'object');
  return (
    <div class="panel-section edit-form" onKeyDown={onKey}>
      <p class="section-title">{mode === 'set' ? 'Edit value' : mode === 'rename' ? 'Rename key' : d.type === 'object' ? 'Add property' : 'Add item'}</p>
      {showKey && <input ref={showKey ? first : undefined} class="edit-input" value={key} placeholder="key" spellcheck={false} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />}
      {showValue && (
        <>
          <div class="edit-kinds" role="radiogroup">
            {KINDS.map((k) => (
              <button key={k} class={`btn mini ${kind === k ? 'active' : ''}`} role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>
                {k}
              </button>
            ))}
          </div>
          {kind === 'boolean' ? (
            <div class="edit-kinds">
              {['true', 'false'].map((b) => (
                <button key={b} class={`btn mini ${value.trim() === b ? 'active' : ''}`} onClick={() => setValue(b)}>
                  {b}
                </button>
              ))}
            </div>
          ) : kind !== 'null' ? (
            <textarea
              ref={showKey ? undefined : first}
              class="edit-input"
              rows={kind === 'json' ? 8 : kind === 'string' && value.length > 60 ? 4 : 1}
              value={value}
              spellcheck={false}
              placeholder={kind === 'json' ? '{"any": ["JSON"]}' : kind}
              onInput={(e) => setValue((e.target as HTMLTextAreaElement).value)}
            />
          ) : null}
        </>
      )}
      <div class="edit-buttons">
        <button class="btn primary" disabled={busy || (showKey && !key)} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button class="btn" onClick={onDone}>
          Cancel
        </button>
        <span class="edit-hint">{kind === 'string' || kind === 'json' ? 'Ctrl+Enter to save' : 'Enter to save'} · Esc to cancel</span>
      </div>
    </div>
  );
}
