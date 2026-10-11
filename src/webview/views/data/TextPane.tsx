/** Source text of the document; editable in the stand-alone browser (re-parses as you type). */

import { useEffect, useRef, useState } from 'preact/hooks';
import { BrowserHost } from '../../host/browser';
import { host } from '../../store';
import { useData } from './context';

const MAX = 8 * 1024 * 1024;

export function TextPane() {
  const { client, target, summary } = useData();
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const editable = host() instanceof BrowserHost && !truncated;

  useEffect(() => {
    void client.call('text', { maxChars: MAX }).then((r) => {
      setText(r.text);
      setTruncated(r.truncated);
    });
  }, [client, summary]);

  const onInput = (e: Event) => {
    const value = (e.target as HTMLTextAreaElement).value;
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => (host() as BrowserHost).updateDocument(target.uri, value), 500);
  };

  return (
    <div class="view-fill">
      {truncated && <div class="table-bar">Showing the first {(MAX / 1024 / 1024).toFixed(0)} MB (read-only). Use the graph, tree or table views to explore the rest.</div>}
      {!editable && !truncated && host().kind === 'vscode' && <div class="table-bar">Read-only preview — edit the file in the editor and the views update automatically.</div>}
      <div class="textview">
        <textarea spellcheck={false} readOnly={!editable} value={text ?? ''} onInput={editable ? onInput : undefined} wrap="off" />
      </div>
    </div>
  );
}
