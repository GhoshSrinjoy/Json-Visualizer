/** Canvas drawing primitives for scene nodes and edges (shared by screen, minimap and PNG export). */

import { CARD_PAD_X, HEADER_H, ROW_H, type Row, type SceneEdge, type SceneNode } from './scene';
import { resolveColor, withAlpha, type Palette } from './theme';

export interface DrawContext {
  ctx: CanvasRenderingContext2D;
  p: Palette;
  /** Current zoom (screen px per world px). */
  k: number;
  charW: number;
  hoverKey?: string;
  hoverRow?: number;
  selected?: ReadonlySet<string>;
  matches?: ReadonlySet<string>;
  /** Keys related to the hovered/selected node (neighbour highlighting). */
  related?: ReadonlySet<string>;
  dimOthers?: boolean;
}

export const FONT_SIZE = 12;

export function fontMono(p: Palette, weight = 400, size = FONT_SIZE): string {
  return `${weight} ${size}px ${p.monoFont}`;
}
export function fontUi(p: Palette, weight = 400, size = FONT_SIZE): string {
  return `${weight} ${size}px ${p.uiFont}`;
}

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function shapePath(ctx: CanvasRenderingContext2D, n: SceneNode): void {
  const { x, y, w, h } = n;
  switch (n.shape) {
    case 'diamond':
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w / 2, y + h);
      ctx.lineTo(x, y + h / 2);
      ctx.closePath();
      return;
    case 'hexagon': {
      const d = Math.min(h / 2, 16);
      ctx.beginPath();
      ctx.moveTo(x + d, y);
      ctx.lineTo(x + w - d, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w - d, y + h);
      ctx.lineTo(x + d, y + h);
      ctx.lineTo(x, y + h / 2);
      ctx.closePath();
      return;
    }
    case 'parallelogram': {
      const d = Math.min(14, w * 0.1);
      ctx.beginPath();
      ctx.moveTo(x + d, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w - d, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      return;
    }
    case 'stadium':
    case 'pill':
      roundRectPath(ctx, x, y, w, h, h / 2);
      return;
    case 'circle':
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      return;
    default:
      roundRectPath(ctx, x, y, w, h, 8);
  }
}

export function truncateChars(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return max <= 1 ? '…' : s.slice(0, max - 1) + '…';
}

/** Draws one node at the current transform. `alpha` is used for fade-in animations. */
export function drawNode(dc: DrawContext, n: SceneNode, alpha = 1): void {
  const { ctx, p, k } = dc;
  const accent = resolveColor(p, n.color, p.colors.accent);
  const selected = dc.selected?.has(n.key);
  const matched = dc.matches?.has(n.key);
  const hovered = dc.hoverKey === n.key;
  const dim = (dc.dimOthers && dc.related && !dc.related.has(n.key) && !selected) || n.faded;
  ctx.globalAlpha = alpha * (dim ? 0.38 : 1);

  const tiny = k < 0.05;
  if (tiny) {
    ctx.fillStyle = withAlpha(accent, 0.65);
    ctx.fillRect(n.x, n.y, n.w, n.h);
    ctx.globalAlpha = 1;
    return;
  }

  // Body
  shapePath(ctx, n);
  const isCard = n.shape === 'card' || n.shape === 'note';
  ctx.fillStyle = n.fill !== undefined ? withAlpha(accent, n.fill) : hovered ? p.cardHover : p.card;
  ctx.fill();
  if (!isCard && n.fill === undefined) {
    ctx.fillStyle = withAlpha(accent, 0.13);
    ctx.fill();
  }
  ctx.lineWidth = (selected ? 2.2 : 1.2) / Math.max(k, 0.35);
  ctx.strokeStyle = selected ? p.selection : matched ? p.match : withAlpha(accent, isCard ? 0.42 : 0.75);
  if (n.dashed) ctx.setLineDash([5 / Math.max(k, 0.3), 4 / Math.max(k, 0.3)]);
  ctx.stroke();
  if (n.dashed) ctx.setLineDash([]);

  const rowPx = ROW_H * k;
  if (isCard) {
    let top = n.y;
    if (n.title !== undefined) {
      // Header tint with rounded top corners, then an accent stripe.
      ctx.save();
      shapePath(ctx, n);
      ctx.clip();
      ctx.fillStyle = withAlpha(accent, p.dark ? 0.16 : 0.12);
      ctx.fillRect(n.x, n.y, n.w, HEADER_H);
      ctx.fillStyle = accent;
      ctx.fillRect(n.x, n.y, n.w, 2);
      ctx.restore();
      if (HEADER_H * k >= 7) {
        drawHeader(dc, n, accent);
      }
      top += HEADER_H;
    } else top += 4;
    if (n.rows?.length) drawRows(dc, n, top, rowPx);
    else if (n.lines?.length) drawLines(dc, n, top, rowPx, 'left');
  } else if (n.lines?.length || n.title) {
    const lines = n.lines?.length ? n.lines : [n.title!];
    drawCenteredLines(dc, n, lines, rowPx);
  }

  if (matched && !selected) {
    // Extra halo for search hits.
    ctx.lineWidth = 3 / Math.max(k, 0.3);
    ctx.strokeStyle = withAlpha(p.match, 0.45);
    shapePath(ctx, n);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawHeader(dc: DrawContext, n: SceneNode, accent: string): void {
  const { ctx, p, charW } = dc;
  const cy = n.y + HEADER_H / 2 + 0.5;
  let x = n.x + CARD_PAD_X;
  ctx.textBaseline = 'middle';
  if (n.icon) {
    ctx.font = fontMono(p, 700, 11);
    ctx.fillStyle = accent;
    ctx.fillText(n.icon, x, cy);
    x += charW * (n.icon.length + 0.8);
  }
  const badgeW = n.badge ? (n.badge.length + 1) * charW * 0.92 : 0;
  ctx.font = fontMono(p, 600);
  ctx.fillStyle = p.text;
  const avail = Math.floor((n.x + n.w - CARD_PAD_X - badgeW - x) / charW);
  ctx.fillText(truncateChars(n.title ?? '', avail), x, cy);
  if (n.badge) {
    ctx.font = fontMono(p, 500, 11);
    ctx.fillStyle = p.muted;
    ctx.textAlign = 'right';
    ctx.fillText(n.badge, n.x + n.w - CARD_PAD_X, cy);
    ctx.textAlign = 'left';
  }
}

function drawRows(dc: DrawContext, n: SceneNode, top: number, rowPx: number): void {
  const { ctx, p, charW } = dc;
  const rows = n.rows!;
  const skeleton = rowPx < 9;
  if (rowPx < 3.5) return;
  const right = n.x + n.w - CARD_PAD_X;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ry = top + i * ROW_H;
    const cy = ry + ROW_H / 2 + 0.5;
    if (dc.hoverKey === n.key && dc.hoverRow === i && !skeleton) {
      ctx.fillStyle = withAlpha(p.text, p.dark ? 0.06 : 0.05);
      ctx.fillRect(n.x + 1, ry, n.w - 2, ROW_H);
    }
    let x = n.x + CARD_PAD_X;
    const portSpace = r.child || r.expandable ? 14 : 0;
    if (skeleton) {
      // Text is unreadable at this zoom: draw proportional bars instead.
      const keyLen = Math.min((r.key?.length ?? 0) * charW, n.w * 0.45);
      const valLen = Math.min((r.value?.length ?? 0) * charW, n.w - CARD_PAD_X * 2 - keyLen - 8);
      ctx.fillStyle = withAlpha(resolveColor(p, r.keyColor, p.colors.key), 0.45);
      if (keyLen > 0) ctx.fillRect(x, cy - 2.5, keyLen, 5);
      ctx.fillStyle = withAlpha(resolveColor(p, r.valueColor, p.muted), 0.45);
      if (valLen > 0) ctx.fillRect(x + keyLen + 8, cy - 2.5, valLen, 5);
    } else {
      ctx.textBaseline = 'middle';
      if (r.action) {
        ctx.font = fontMono(p, 400, 11.5);
        ctx.fillStyle = p.colors.accent;
        ctx.fillText(truncateChars(r.value ?? '', Math.floor((n.w - CARD_PAD_X * 2) / charW)), x, cy);
        continue;
      }
      if (r.icon) {
        ctx.font = fontMono(p, 700, 11);
        ctx.fillStyle = resolveColor(p, r.iconColor, p.muted);
        ctx.fillText(r.icon, x, cy);
        x += charW * (r.icon.length + 0.7);
      }
      const asideW = r.aside ? (r.aside.length + 1) * charW : 0;
      const avail = Math.floor((right - portSpace - asideW - x) / charW);
      ctx.font = fontMono(p, 400);
      let used = 0;
      if (r.key !== undefined) {
        const keyText = truncateChars(r.key, Math.max(4, Math.min(avail - 3, Math.ceil(avail * 0.6))));
        ctx.fillStyle = r.muted ? p.muted : resolveColor(p, r.keyColor, p.colors.key);
        ctx.fillText(keyText, x, cy);
        used = keyText.length;
        if (r.value !== undefined) {
          ctx.fillStyle = p.faint;
          ctx.fillText(':', x + used * charW, cy);
          used += 2;
        }
      }
      if (r.value !== undefined) {
        ctx.fillStyle = r.muted ? p.faint : resolveColor(p, r.valueColor, p.text);
        ctx.fillText(truncateChars(r.value, avail - used), x + used * charW, cy);
      }
      if (r.aside) {
        ctx.fillStyle = p.faint;
        ctx.textAlign = 'right';
        ctx.fillText(r.aside, right - portSpace, cy);
        ctx.textAlign = 'left';
      }
    }
    if (r.child || r.expandable) drawPort(dc, n.x + n.w, cy, resolveColor(p, r.valueColor, p.colors.accent), !!r.expanded);
  }
}

function drawPort(dc: DrawContext, x: number, y: number, color: string, expanded: boolean): void {
  const { ctx, p, k } = dc;
  const r = 4.2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = expanded ? color : p.card;
  ctx.fill();
  ctx.lineWidth = 1.4 / Math.max(k, 0.5);
  ctx.strokeStyle = color;
  ctx.stroke();
  if (!expanded && k > 0.6) {
    ctx.beginPath();
    ctx.moveTo(x - 2, y);
    ctx.lineTo(x + 2, y);
    ctx.moveTo(x, y - 2);
    ctx.lineTo(x, y + 2);
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

function drawLines(dc: DrawContext, n: SceneNode, top: number, rowPx: number, align: 'left' | 'center'): void {
  const { ctx, p, charW } = dc;
  if (rowPx < 3.5) return;
  const lines = n.lines!;
  const max = Math.floor((n.w - CARD_PAD_X * 2) / charW);
  for (let i = 0; i < lines.length; i++) {
    const cy = top + i * ROW_H + ROW_H / 2 + 0.5;
    if (rowPx < 9) {
      ctx.fillStyle = withAlpha(p.text, 0.3);
      ctx.fillRect(n.x + CARD_PAD_X, cy - 2.5, Math.min(lines[i].length, max) * charW, 5);
      continue;
    }
    ctx.font = fontMono(p, 400);
    ctx.textBaseline = 'middle';
    ctx.textAlign = align;
    ctx.fillStyle = p.text;
    ctx.fillText(truncateChars(lines[i], max), align === 'left' ? n.x + CARD_PAD_X : n.x + n.w / 2, cy);
    ctx.textAlign = 'left';
  }
}

function drawCenteredLines(dc: DrawContext, n: SceneNode, lines: string[], rowPx: number): void {
  const { ctx, p, charW } = dc;
  if (rowPx < 3.5) return;
  const inset = n.shape === 'diamond' ? n.w * 0.2 : n.shape === 'hexagon' ? 16 : 12;
  const max = Math.floor((n.w - inset * 2) / charW);
  const total = lines.length * 18;
  const startY = n.y + n.h / 2 - total / 2 + 9.5;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (let i = 0; i < lines.length; i++) {
    const cy = startY + i * 18;
    if (rowPx < 9) {
      const len = Math.min(lines[i].length, max) * charW;
      ctx.fillStyle = withAlpha(p.text, 0.3);
      ctx.fillRect(n.x + n.w / 2 - len / 2, cy - 2.5, len, 5);
      continue;
    }
    ctx.font = fontMono(p, i === 0 && (n.shape === 'stadium' || n.shape === 'pill') ? 600 : 400);
    ctx.fillStyle = n.faded ? p.muted : p.text;
    ctx.fillText(truncateChars(lines[i], max), n.x + n.w / 2, cy);
  }
  ctx.textAlign = 'left';
}

// ---------------------------------------------------------------- edges

export interface EdgeGeometry {
  /** Cubic segments flattened as [x0,y0, c1x,c1y,c2x,c2y,x1,y1, …] (curve mode) or polyline points (route mode). */
  pts: number[];
  curve: boolean;
}

/** Port position of a card row (right edge) or a node side. */
export function rowPortY(n: SceneNode, row: number): number {
  const top = n.title !== undefined ? n.y + HEADER_H : n.y + 4;
  return top + row * ROW_H + ROW_H / 2;
}

export function curveBetween(from: SceneNode, to: SceneNode, fromRow: number | undefined, dir: 'LR' | 'TB'): number[] {
  if (dir === 'LR') {
    const x0 = from.x + from.w;
    const y0 = fromRow !== undefined ? rowPortY(from, fromRow) : from.y + from.h / 2;
    const x1 = to.x;
    const y1 = to.title !== undefined ? to.y + HEADER_H / 2 : to.y + to.h / 2;
    const dx = Math.max(30, (x1 - x0) * 0.5);
    return [x0, y0, x0 + dx, y0, x1 - dx, y1, x1, y1];
  }
  const x0 = fromRow !== undefined && from.rows ? from.x + from.w : from.x + from.w / 2;
  const y0 = fromRow !== undefined && from.rows ? rowPortY(from, fromRow) : from.y + from.h;
  const x1 = to.x + to.w / 2;
  const y1 = to.y;
  const dy = Math.max(30, (y1 - y0) * 0.5);
  if (fromRow !== undefined && from.rows) return [x0, y0, x0 + 30, y0, x1, y1 - dy, x1, y1];
  return [x0, y0, x0, y0 + dy, x1, y1 - dy, x1, y1];
}

/** Smooth path through polyline points (quadratic B-spline through midpoints). */
export function tracePolyline(ctx: CanvasRenderingContext2D, pts: number[]): void {
  ctx.moveTo(pts[0], pts[1]);
  if (pts.length === 4) {
    ctx.lineTo(pts[2], pts[3]);
    return;
  }
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2;
    const my = (pts[i + 1] + pts[i + 3]) / 2;
    ctx.quadraticCurveTo(pts[i], pts[i + 1], i + 4 >= pts.length ? pts[i + 2] : mx, i + 4 >= pts.length ? pts[i + 3] : my);
  }
}

export function drawEdge(dc: DrawContext, e: SceneEdge, geom: EdgeGeometry, highlighted: boolean, alpha = 1): void {
  const { ctx, p, k } = dc;
  const color = highlighted ? p.edgeHi : resolveColor(p, e.color, p.edge);
  ctx.globalAlpha = alpha * (dc.dimOthers && !highlighted ? 0.35 : 1);
  ctx.strokeStyle = color;
  ctx.lineWidth = ((e.width ?? 1.3) * (highlighted ? 1.6 : 1)) / Math.max(Math.min(k, 1.5), 0.25);
  if (e.style === 'dashed') ctx.setLineDash([6 / Math.max(k, 0.3), 5 / Math.max(k, 0.3)]);
  else if (e.style === 'dotted') ctx.setLineDash([1.5 / Math.max(k, 0.3), 4 / Math.max(k, 0.3)]);
  ctx.beginPath();
  const pts = geom.pts;
  if (geom.curve) {
    ctx.moveTo(pts[0], pts[1]);
    ctx.bezierCurveTo(pts[2], pts[3], pts[4], pts[5], pts[6], pts[7]);
  } else tracePolyline(ctx, pts);
  ctx.stroke();
  ctx.setLineDash([]);
  if (e.arrow !== false && k > 0.12) drawArrow(dc, pts, geom.curve, color);
  if (e.label && k > 0.35) drawEdgeLabel(dc, e.label, pts, geom.curve, color);
  ctx.globalAlpha = 1;
}

function drawArrow(dc: DrawContext, pts: number[], curve: boolean, color: string): void {
  const { ctx, k } = dc;
  const n = pts.length;
  const x1 = pts[n - 2];
  const y1 = pts[n - 1];
  const x0 = curve ? pts[4] : pts[n - 4];
  const y0 = curve ? pts[5] : pts[n - 3];
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const s = 7 / Math.max(Math.min(k, 1.4), 0.35);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - s * Math.cos(ang - 0.42), y1 - s * Math.sin(ang - 0.42));
  ctx.lineTo(x1 - s * Math.cos(ang + 0.42), y1 - s * Math.sin(ang + 0.42));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawEdgeLabel(dc: DrawContext, label: string, pts: number[], curve: boolean, color: string): void {
  const { ctx, p, charW } = dc;
  // Place near the start so branch labels sit next to their decision.
  let x: number;
  let y: number;
  if (curve) {
    const t = 0.35;
    const mt = 1 - t;
    x = mt ** 3 * pts[0] + 3 * mt * mt * t * pts[2] + 3 * mt * t * t * pts[4] + t ** 3 * pts[6];
    y = mt ** 3 * pts[1] + 3 * mt * mt * t * pts[3] + 3 * mt * t * t * pts[5] + t ** 3 * pts[7];
  } else if (pts.length >= 6) {
    x = (pts[0] + pts[2]) / 2;
    y = (pts[1] + pts[3]) / 2;
  } else {
    x = pts[0] + (pts[2] - pts[0]) * 0.35;
    y = pts[1] + (pts[3] - pts[1]) * 0.35;
  }
  const text = truncateChars(label, 24);
  const w = text.length * charW * 0.9 + 10;
  const h = 16;
  roundRectPath(ctx, x - w / 2, y - h / 2, w, h, 8);
  ctx.fillStyle = p.bg;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = withAlpha(color, 0.8);
  ctx.stroke();
  ctx.font = fontMono(p, 500, 10.5);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.textAlign = 'left';
}

/** Chars per row text helper used for sizing cards. */
export function rowTextLength(r: Row): number {
  return (r.icon ? r.icon.length + 1 : 0) + (r.key?.length ?? 0) + (r.key !== undefined && r.value !== undefined ? 2 : 0) + (r.value?.length ?? 0) + (r.aside ? r.aside.length + 2 : 0);
}
