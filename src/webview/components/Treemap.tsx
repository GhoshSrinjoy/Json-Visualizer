/** Zoomable, nested squarified treemap of a repository (canvas). */

import { useEffect, useRef, useState } from 'preact/hooks';
import { squarify } from '../../core/graph/treemap';
import { K_DIR, repoChildren, repoPath, type RepoModel } from '../../core/repo/model';
import { formatBytes, withCommas } from '../../core/util/strings';
import { readPalette, withAlpha } from '../engine/theme';
import { langColor } from '../scenes/repo';
import { app, useStore } from '../store';
import { Tooltip } from './ui';

interface Cell {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

export interface TreemapProps {
  repo: RepoModel;
  metric: 'lines' | 'bytes';
  root: number;
  selected: number | null;
  highlight?: Set<number>;
  onZoom: (id: number) => void;
  onSelect: (id: number) => void;
  onOpen: (id: number) => void;
}

const HEADER = 18;
const PAD = 3;

export function Treemap({ repo, metric, root, selected, highlight, onZoom, onSelect, onOpen }: TreemapProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cells = useRef<Cell[]>([]);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<{ id: number; x: number; y: number } | null>(null);
  const theme = useStore(app, (s) => s.theme);

  useEffect(() => {
    const el = ref.current!.parentElement!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const p = readPalette();
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, size.w, size.h);
    const value = (id: number) => Math.max(metric === 'lines' ? Math.max(0, repo.lines[id]) : repo.size[id], repo.kind[id] === K_DIR ? 0 : 1);
    const out: Cell[] = [];
    const layout = (id: number, x: number, y: number, w: number, h: number, depth: number) => {
      out.push({ id, x, y, w, h, depth });
      if (repo.kind[id] !== K_DIR || w < 24 || h < 24) return;
      const kids = repoChildren(repo, id).filter((k) => value(k) > 0);
      if (!kids.length) return;
      const top = depth === 0 ? 0 : HEADER;
      const rects = squarify(kids.map(value), { x: x + PAD, y: y + top + PAD, w: Math.max(0, w - PAD * 2), h: Math.max(0, h - top - PAD * 2) });
      kids.forEach((k, i) => {
        const r = rects[i];
        if (r.w >= 2 && r.h >= 2) layout(k, r.x, r.y, r.w, r.h, depth + 1);
      });
    };
    layout(root, 0, 0, size.w, size.h, 0);
    cells.current = out;
    ctx.textBaseline = 'middle';
    for (const c of out) {
      if (c.depth === 0) continue;
      const isDir = repo.kind[c.id] === K_DIR;
      if (isDir) {
        ctx.fillStyle = withAlpha(p.text, p.dark ? 0.035 : 0.04);
        ctx.fillRect(c.x, c.y, c.w, c.h);
        ctx.strokeStyle = withAlpha(p.text, p.dark ? 0.12 : 0.16);
        ctx.lineWidth = 1;
        ctx.strokeRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1);
        if (c.h > HEADER + 6 && c.w > 40) {
          ctx.font = `600 11px ${p.uiFont}`;
          ctx.fillStyle = p.muted;
          const label = `${repo.names[c.id]}/`;
          const max = Math.floor((c.w - 10) / 6.4);
          ctx.fillText(label.length > max ? label.slice(0, Math.max(1, max - 1)) + '…' : label, c.x + 6, c.y + HEADER / 2 + 1);
        }
      } else {
        const color = langColor(repo, c.id);
        ctx.fillStyle = withAlpha(color, p.dark ? 0.62 : 0.55);
        ctx.fillRect(c.x + 0.5, c.y + 0.5, Math.max(0, c.w - 1), Math.max(0, c.h - 1));
        if (highlight?.has(c.id)) {
          ctx.strokeStyle = p.match;
          ctx.lineWidth = 2;
          ctx.strokeRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
        }
        if (c.w > 46 && c.h > 16) {
          ctx.font = `500 11px ${p.uiFont}`;
          ctx.fillStyle = p.dark ? 'rgba(255,255,255,.92)' : 'rgba(0,0,0,.85)';
          const name = repo.names[c.id];
          const max = Math.floor((c.w - 8) / 6.2);
          ctx.fillText(name.length > max ? name.slice(0, Math.max(1, max - 1)) + '…' : name, c.x + 5, c.y + Math.min(c.h / 2, 11));
        }
      }
      if (selected === c.id) {
        ctx.strokeStyle = p.selection;
        ctx.lineWidth = 2;
        ctx.strokeRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
      }
    }
  }, [repo, metric, root, size, selected, highlight, theme]);

  const hit = (e: MouseEvent): Cell | undefined => {
    const r = ref.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: Cell | undefined;
    for (const c of cells.current) if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h && (!best || c.depth > best.depth)) best = c;
    return best;
  };

  const h = hover !== null ? hover.id : -1;
  return (
    <div class="graph-host" style={{ backgroundImage: 'none' }}>
      <canvas
        ref={ref}
        class="graph-canvas"
        style={{ cursor: 'pointer' }}
        onMouseMove={(e) => {
          const c = hit(e);
          setHover(c ? { id: c.id, x: e.clientX, y: e.clientY } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const c = hit(e);
          if (!c) return;
          // Clicking a directory zooms in; a file selects it.
          if (repo.kind[c.id] === K_DIR && c.depth > 0) onZoom(c.id);
          else onSelect(c.id);
        }}
        onDblClick={(e) => {
          const c = hit(e);
          if (c && repo.kind[c.id] !== K_DIR) onOpen(c.id);
        }}
      />
      {hover && h > 0 && (
        <Tooltip x={hover.x} y={hover.y}>
          <div class="tt-head">{repoPath(repo, h)}</div>
          {repo.kind[h] === K_DIR ? `${withCommas(repo.files[h])} files · ` : ''}
          {repo.lines[h] > 0 ? `${withCommas(repo.lines[h])} lines · ` : ''}
          {formatBytes(repo.size[h])}
          {repo.lang[h] >= 0 ? ` · ${repo.languages[repo.lang[h]].name}` : ''}
        </Tooltip>
      )}
    </div>
  );
}
