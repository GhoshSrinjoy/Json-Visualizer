import { VERSION } from '../../shared/version';
import { app, copy, useStore } from '../store';

export function StatusBar() {
  const crumb = useStore(app, (s) => s.crumb);
  const status = useStore(app, (s) => s.status);
  const summary = useStore(app, (s) => s.summary);
  const mode = useStore(app, (s) => s.mode);
  return (
    <footer class="statusbar">
      <span class="crumb" title={crumb ? 'Click to copy' : undefined} onClick={() => crumb && copy(crumb, `Copied ${crumb}`)} style={{ cursor: crumb ? 'pointer' : undefined }}>
        {crumb}
      </span>
      {status && <span>{status}</span>}
      {mode === 'data' && summary && (
        <>
          <span class="sep" />
          <span>
            {summary.nodes.toLocaleString()} values · depth {summary.maxDepth} · {Math.round(summary.parseMs)} ms
          </span>
        </>
      )}
      <span class="sep" />
      <span title="StructLens version">StructLens {VERSION}</span>
    </footer>
  );
}
