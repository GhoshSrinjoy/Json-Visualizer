/** Keyboard shortcut reference (press ?). */

import { useEffect } from 'preact/hooks';
import type { Mode } from '../../shared/protocol';

const GROUPS: { title: string; modes?: Mode[]; keys: [string, string][] }[] = [
  {
    title: 'Everywhere',
    keys: [
      ['1 – 5', 'Switch view'],
      ['/  or  Ctrl+F', 'Search (type $ for JSONPath)'],
      ['Enter / Shift+Enter', 'Next / previous match'],
      ['F', 'Fit to view'],
      ['+  −  0', 'Zoom in, out, reset'],
      ['E / C', 'Expand / collapse all'],
      ['D', 'Flip layout direction'],
      ['B / I', 'Toggle side panels'],
      ['R', 'Refresh'],
      ['?', 'This list'],
    ],
  },
  {
    title: 'Data graph and tree',
    modes: ['data'],
    keys: [
      ['↑ ↓', 'Previous / next entry'],
      ['→', 'Expand, then go to the first child'],
      ['←', 'Collapse, then go to the parent'],
      ['Enter / Space', 'Expand or collapse'],
      ['Home', 'Back to the root'],
      ['L', 'Key labels on edges'],
      ['Right-click', 'Copy, convert, focus, find similar, edit'],
    ],
  },
  {
    title: 'Editing (data files)',
    modes: ['data'],
    keys: [
      ['F2', 'Edit the selected value (rename a container)'],
      ['Delete', 'Delete the selected entry (asks first)'],
      ['Ctrl+Enter', 'Save the edit'],
      ['Esc', 'Cancel'],
    ],
  },
];

export function Shortcuts({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal shortcuts" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        {GROUPS.filter((g) => !g.modes || g.modes.includes(mode)).map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.keys.map(([k, what]) => (
                <div key={k}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
