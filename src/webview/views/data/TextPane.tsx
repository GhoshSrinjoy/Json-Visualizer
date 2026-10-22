/**
 * Source text with line numbers, parse issues in the gutter and two-way selection sync
 * (select a node anywhere to highlight its source; click the text to select the node there).
 * Editable in the stand-alone browser, where it re-parses as you type.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BrowserHost } from '../../host/browser';
import { host } from '../../store';
import { useData } from './context';

const MAX = 8 * 1024 * 1024;
const LINE_H = 20;
const PAD_TOP = 14;

/** Textareas turn CRLF into LF: maps between source offsets and textarea offsets. */
function offsetMapper(text: string) {
  const cr: number[] = [];
  for (let i = text.indexOf('\r\n'); i >= 0; i = text.indexOf('\r\n', i + 2)) cr.push(i);
  const before = (raw: number) => {
    let lo = 0;
    let hi = cr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cr[mid] < raw) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return {
    toArea: (raw: number) => raw - before(raw),
    toSource: (area: number) => {
      // The i-th CRLF sits at textarea offset cr[i] - i.
      let lo = 0;
      let hi = cr.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cr[mid] - mid < area) lo = mid + 1;
        else hi = mid;
      }
      return area + lo;
    },
  };
}

export function TextPane() {
  const ctx = useData();
  const { client, target, summary, selected } = ctx;
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [scroll, setScroll] = useState({ top: 0, height: 800 });
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [issue, setIssue] = useState(-1);
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fromText = useRef(false);
  const editable = host() instanceof BrowserHost && !truncated;

  useEffect(() => {
    void client.call('text', { maxChars: MAX }).then((r) => {
      setText(r.text);
      setTruncated(r.truncated);
    });
  }, [client, summary]);

  const map = useMemo(() => offsetMapper(text ?? ''), [text]);
  const lines = useMemo(() => {
    if (text === null) return 0;
    let n = 1;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
    return n;
  }, [text]);
  const errorsByLine = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const e of summary.errors) m.set(e.line - 1, [...(m.get(e.line - 1) ?? []), `${e.line}:${e.col} ${e.message}`]);
    return m;
  }, [summary]);

  // Selection elsewhere → highlight (and scroll to) its source lines.
  useEffect(() => {
    if (selected === null) return setRange(null);
    if (fromText.current) {
      fromText.current = false;
      return;
    }
    let alive = true;
    void client.call('detail', { id: selected, maxChars: 0 }).then((d) => {
      if (!alive || !d.start) return setRange(null);
      const r = { from: d.start.line, to: d.end?.line ?? d.start.line };
      setRange(r);
      const el = area.current;
      if (el && (r.from * LINE_H < el.scrollTop || r.from * LINE_H > el.scrollTop + el.clientHeight - LINE_H * 2)) el.scrollTop = Math.max(0, r.from * LINE_H - el.clientHeight / 3);
    });
    return () => {
      alive = false;
    };
  }, [selected, summary]);

  const onScroll = () => {
    const el = area.current;
    if (el) setScroll({ top: el.scrollTop, height: el.clientHeight });
  };
  useEffect(onScroll, [text]);

  /** Click / caret move → the node at that position. */
  const onCaret = () => {
    const el = area.current;
    if (!el || el.selectionStart !== el.selectionEnd) return;
    const offset = map.toSource(el.selectionStart);
    void client.call('nodeAtOffset', { offset }).then((id) => {
      if (id < 0 || id === ctx.selected) return;
      fromText.current = true;
      const line = (text ?? '').slice(0, el.selectionStart).split('\n').length - 1;
      setRange({ from: line, to: line });
      ctx.select(id, { source: 'text' });
    });
  };

  const goToIssue = (i: number) => {
    const e = summary.errors[i];
    const el = area.current;
    if (!e || !el) return;
    setIssue(i);
    const at = map.toArea(e.offset);
    el.focus({ preventScroll: true });
    el.setSelectionRange(at, at);
    el.scrollTop = Math.max(0, (e.line - 1) * LINE_H - el.clientHeight / 3);
  };

  const onInput = (e: Event) => {
    const value = (e.target as HTMLTextAreaElement).value;
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => (host() as BrowserHost).updateDocument(target.uri, value), 500);
  };

  const first = Math.max(0, Math.floor((scroll.top - PAD_TOP) / LINE_H) - 5);
  const last = Math.min(lines, Math.ceil((scroll.top + scroll.height) / LINE_H) + 5);
  const gutterW = Math.max(3, String(lines).length) * 8 + 26;
  const issues = summary.errors.length;
  return (
    <div class="view-fill">
      {issues > 0 && (
        <div class="table-bar issues-bar">
          <span class={summary.errors.some((e) => !('severity' in e && e.severity === 'warning')) ? 'issue-error' : 'issue-warn'}>
            {issues} {issues === 1 ? 'issue' : 'issues'}
          </span>
          <span class="issue-text" title={summary.errors[Math.max(0, issue)]?.message}>
            {summary.errors[Math.max(0, issue)] && `${summary.errors[Math.max(0, issue)].line}:${summary.errors[Math.max(0, issue)].col}  ${summary.errors[Math.max(0, issue)].message}`}
          </span>
          <span class="spacer" />
          <button class="btn" onClick={() => goToIssue((issue - 1 + issues) % issues)} title="Previous issue">
            ‹
          </button>
          <button class="btn" onClick={() => goToIssue((issue + 1) % issues)} title="Next issue">
            ›
          </button>
        </div>
      )}
      {truncated && <div class="table-bar">Showing the first {(MAX / 1024 / 1024).toFixed(0)} MB (read-only). Use the graph, tree or table views to explore the rest.</div>}
      {!editable && !truncated && host().kind === 'vscode' && <div class="table-bar">Read-only preview — edit the file in the editor and the views update automatically.</div>}
      <div class="textview">
        <div class="gutter" style={{ width: `${gutterW}px` }} aria-hidden="true">
          <div style={{ transform: `translateY(${PAD_TOP - scroll.top}px)` }}>
            {Array.from({ length: Math.max(0, last - first) }, (_, i) => {
              const n = first + i;
              const errs = errorsByLine.get(n);
              const inRange = range && n >= range.from && n <= range.to;
              return (
                <div key={n} class={`ln ${errs ? 'err' : ''} ${inRange ? 'sel' : ''}`} style={{ top: `${n * LINE_H}px` }} title={errs?.join('\n')}>
                  {n + 1}
                </div>
              );
            })}
          </div>
        </div>
        <div class="text-wrap">
          {range && (
            <div class="text-band" style={{ top: `${PAD_TOP + range.from * LINE_H - scroll.top}px`, height: `${(range.to - range.from + 1) * LINE_H}px` }} />
          )}
          {[...errorsByLine.keys()]
            .filter((n) => n >= first && n <= last)
            .map((n) => (
              <div key={`e${n}`} class="text-err" style={{ top: `${PAD_TOP + n * LINE_H - scroll.top}px` }} />
            ))}
          <textarea
            ref={area}
            spellcheck={false}
            readOnly={!editable}
            value={text ?? ''}
            onInput={editable ? onInput : undefined}
            onScroll={onScroll}
            onClick={onCaret}
            onKeyUp={(e) => e.key.startsWith('Arrow') && onCaret()}
            wrap="off"
          />
        </div>
      </div>
    </div>
  );
}
