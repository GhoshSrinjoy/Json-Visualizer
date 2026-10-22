/** Compare view: this document against another file, as a structural diff with values side by side. */

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { DiffKind } from '../../../core/data/diff';
import { Icon } from '../../components/icons';
import { CenterMessage, VirtualList } from '../../components/ui';
import { app, copy, toast } from '../../store';
import type { DiffArgs, DiffRow, DiffView } from '../../worker/protocol';
import { useData } from './context';

const ROW = 26;
const GLYPH: Record<DiffKind, string> = { added: '+', removed: '−', changed: '~', type: '≠', moved: '↕', same: '' };
const keyText = (k: string | number | null) => (k === null ? '$' : typeof k === 'number' ? `[${k}]` : k);

/** A change the user would step to: a value, or a container added or removed as a whole. */
const isChange = (r: DiffRow) => r.kind !== 'same' && (r.span === 0 || r.kind === 'added' || r.kind === 'removed' || r.kind === 'type');

export function ComparePane() {
  const ctx = useData();
  const { client, compare, summary, target } = ctx;
  const [args, setArgs] = useState<DiffArgs>({ arrays: 'auto', ignoreOrder: false });
  const [view, setView] = useState<DiffView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (!compare) {
      setView(null);
      return;
    }
    let alive = true;
    setError(null);
    client.call('diff', args).then(
      (v) => {
        if (!alive) return;
        setView(v);
        setCollapsed(new Set());
        setActive(-1);
        const marks = new Map<number, DiffKind>();
        for (const r of v.rows) if (r.right >= 0 && isChange(r)) marks.set(r.right, r.kind);
        ctx.setDiffMarks(marks);
      },
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [compare?.seq, summary, args.arrays, args.ignoreOrder]);

  const visible = useMemo(() => {
    const out: number[] = [];
    if (!view) return out;
    for (let i = 0; i < view.rows.length; i++) {
      out.push(i);
      if (collapsed.has(i)) i += view.rows[i].span;
    }
    return out;
  }, [view, collapsed]);
  const changes = useMemo(() => (view ? view.rows.flatMap((r, i) => (isChange(r) ? [i] : [])) : []), [view]);

  /** The node to select in this document: the row's own, or (for removals) its closest kept ancestor. */
  const nodeFor = (i: number): number => {
    const rows = view!.rows;
    for (let j = i; j >= 0; j--) if (rows[j].right >= 0 && rows[j].depth <= rows[i].depth && j + rows[j].span >= i) return rows[j].right;
    return summary.root;
  };

  const pick = (i: number, focus = false) => {
    setActive(i);
    ctx.select(nodeFor(i), { source: 'compare', focus });
  };

  const step = (dir: 1 | -1) => {
    if (!changes.length) return;
    const pos = dir > 0 ? changes.findIndex((c) => c > active) : changes.length - 1 - [...changes].reverse().findIndex((c) => c < active);
    const i = changes[pos >= 0 && pos < changes.length ? pos : dir > 0 ? 0 : changes.length - 1];
    // Open any collapsed ancestor so the change is on screen.
    setCollapsed((c) => new Set([...c].filter((j) => !(j < i && j + view!.rows[j].span >= i))));
    pick(i);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F7') return;
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!compare) {
    return (
      <CenterMessage>
        <b>Compare {target.name} with another file</b>
        <span class="compare-blurb">See what was added, removed, changed or moved, by structure rather than by line. Key order and formatting don't matter, arrays of records are matched by their ids, and the formats can differ (JSON against YAML works).</span>
        <button class="btn primary" onClick={() => void ctx.chooseCompare()}>
          <Icon name="layers" /> Choose a file…
        </button>
      </CenterMessage>
    );
  }
  if (error) return <CenterMessage>{error}</CenterMessage>;
  if (!view) return <CenterMessage spinner>Comparing…</CenterMessage>;

  const s = view.stats;
  const render = (n: number) => {
    const i = visible[n];
    const r = view.rows[i];
    const open = !collapsed.has(i);
    return (
      <div
        key={i}
        class={`trow drow k-${r.kind} ${active === i ? 'selected' : ''}`}
        style={{ top: `${n * ROW}px`, paddingLeft: `${8 + r.depth * 16}px` }}
        onClick={() => pick(i)}
        onDblClick={() => {
          pick(i, true);
          app.set({ view: 'graph' });
        }}
        title={r.path}
      >
        <span
          class={`twisty ${open ? 'open' : ''}`}
          style={{ visibility: r.span > 0 ? 'visible' : 'hidden' }}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((c) => {
              const next = new Set(c);
              if (next.has(i)) next.delete(i);
              else next.add(i);
              return next;
            });
          }}
        >
          <Icon name="chevronRight" />
        </span>
        <span class="dmark">{GLYPH[r.kind]}</span>
        <span class="tkey">{keyText(r.key)}</span>
        <span class="tsep">:</span>
        {r.kind === 'added' ? (
          <span class="dval add">{r.after}</span>
        ) : r.kind === 'removed' ? (
          <span class="dval del">{r.before}</span>
        ) : r.kind === 'moved' ? (
          <span class="dnote">moved from {keyText(r.fromKey ?? null)}</span>
        ) : r.span === 0 && r.kind !== 'same' ? (
          <>
            <span class="dval del">{r.before}</span>
            <span class="darrow">→</span>
            <span class="dval add">{r.after}</span>
            {r.kind === 'type' && <span class="dnote">{`${r.beforeType} → ${r.afterType}`}</span>}
          </>
        ) : (
          <span class="dval">{r.after ?? r.before}</span>
        )}
        {!!r.unchanged && <span class="dnote">{r.unchanged.toLocaleString()} unchanged</span>}
      </div>
    );
  };

  return (
    <div class="view-fill">
      <div class="table-bar compare-bar">
        <span class="cmp-files" title={`Changes from ${compare.name} to ${target.name}`}>
          <b>{compare.name}</b> → <b>{target.name}</b>
        </span>
        {view.same ? (
          <span class="chip ok">identical</span>
        ) : (
          <>
            {s.added > 0 && <span class="chip ok">+{s.added.toLocaleString()}</span>}
            {s.removed > 0 && <span class="chip danger">−{s.removed.toLocaleString()}</span>}
            {s.changed + s.typeChanged > 0 && <span class="chip warn">~{(s.changed + s.typeChanged).toLocaleString()}</span>}
            {s.moved > 0 && <span class="chip">↕{s.moved.toLocaleString()}</span>}
            {view.truncated && <span class="chip warn">first {view.rows.length.toLocaleString()} shown</span>}
          </>
        )}
        <span class="spacer" />
        <select value={args.arrays} onChange={(e) => setArgs({ ...args, arrays: (e.target as HTMLSelectElement).value as DiffArgs['arrays'] })} title="How array elements are matched">
          <option value="auto">Arrays: by id, else by content</option>
          <option value="lcs">Arrays: by content</option>
          <option value="index">Arrays: by position</option>
        </select>
        <label class="check" title="Treat arrays as sets: element order doesn't count">
          <input type="checkbox" checked={args.ignoreOrder} onChange={(e) => setArgs({ ...args, ignoreOrder: (e.target as HTMLInputElement).checked })} /> Ignore order
        </label>
        <button class="btn" disabled={!changes.length} onClick={() => step(-1)} title="Previous change (Shift+F7)">
          <Icon name="chevronUp" />
        </button>
        <button class="btn" disabled={!changes.length} onClick={() => step(1)} title="Next change (F7)">
          <Icon name="chevronDown" />
        </button>
        <button class="btn" onClick={() => client.call('diffText', args).then((t) => copy(t, 'Diff copied'), (e: Error) => toast(e.message, 'error'))} title="Copy the changes as text (handy for reviews and AI prompts)">
          <Icon name="copy" />
        </button>
        <button class="btn" onClick={() => void ctx.chooseCompare()} title="Compare with a different file">
          <Icon name="folder" />
        </button>
        <button class="btn" onClick={() => ctx.clearCompare()} title="Stop comparing">
          <Icon name="x" />
        </button>
      </div>
      {view.same ? (
        <CenterMessage>
          <b>No differences</b>
          <span>The two documents hold the same data{args.ignoreOrder ? ' (ignoring array order)' : ''}.</span>
        </CenterMessage>
      ) : (
        <VirtualList count={visible.length} rowHeight={ROW} render={render} scrollTo={visible.indexOf(active)} />
      )}
    </div>
  );
}
