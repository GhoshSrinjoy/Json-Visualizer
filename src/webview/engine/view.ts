/**
 * Interactive canvas view of a Scene: pan/zoom camera, viewport culling via
 * a spatial grid, level-of-detail rendering, animated layout transitions,
 * hover/selection/search highlighting, a minimap and PNG/SVG export.
 */

import { curveBetween, drawEdge, drawNode, edgeLabelPoint, fontMono, FONT_SIZE, rowPortY, truncateChars, type DrawContext, type EdgeGeometry } from './draw';
import { EDGE_LABEL_CHARS, EDGE_LABEL_H, edgeLabelWidth, HEADER_H, ROW_H, type Scene, type SceneEdge, type SceneNode } from './scene';
import { SpatialGrid } from './spatial';
import { readPalette, resolveColor, withAlpha, type Palette } from './theme';

export interface ViewEvents {
  onNodeClick?(node: SceneNode, row: number, ev: MouseEvent): void;
  onNodeDoubleClick?(node: SceneNode, row: number, ev: MouseEvent): void;
  /** Clicked an expandable row's port (or the row with alt/expand semantics). */
  onToggle?(node: SceneNode, row: number): void;
  onAction?(node: SceneNode, row: number): void;
  onHover?(node: SceneNode | null, row: number): void;
  onContextMenu?(node: SceneNode | null, row: number, ev: MouseEvent): void;
  onBackgroundClick?(): void;
  onViewport?(k: number): void;
}

export interface Camera {
  k: number;
  tx: number;
  ty: number;
}

interface Anim {
  start: number;
  duration: number;
  from: Map<string, { x: number; y: number; w: number; h: number }>;
  fresh: Set<string>;
}

const MIN_K = 0.02;
const MAX_K = 4;

export class GraphView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly minimap: HTMLCanvasElement;
  private readonly mctx: CanvasRenderingContext2D;
  private scene: Scene = { nodes: [], edges: [], direction: 'LR', width: 0, height: 0, edgeMode: 'curve' };
  private byKey = new Map<string, SceneNode>();
  private grid = new SpatialGrid([]);
  private edgeGrid = new SpatialGrid([]);
  private edgeBoxes: { x: number; y: number; w: number; h: number }[] = [];
  private adjacency = new Map<string, Set<string>>();
  private cam: Camera = { k: 1, tx: 0, ty: 0 };
  private camAnim: { from: Camera; to: Camera; start: number; duration: number } | null = null;
  private anim: Anim | null = null;
  private palette: Palette;
  private charW = 7.2;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private dirty = true;
  private raf = 0;
  private hover: { key: string; row: number } | null = null;
  private selected = new Set<string>();
  private selectedRow: { key: string; row: number } | null = null;
  private matches = new Set<string>();
  private errors = new Set<string>();
  private minimapImage: HTMLCanvasElement | null = null;
  private resizeObs: ResizeObserver;
  /** Re-applies the automatic framing on resize until the user moves the camera. */
  private reframe: (() => void) | null = null;
  private themeObs: MutationObserver;
  private disposed = false;
  showMinimap = true;
  animations = true;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: ViewEvents = {},
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'graph-canvas';
    this.canvas.tabIndex = 0;
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: true })!;
    this.minimap = document.createElement('canvas');
    this.minimap.className = 'graph-minimap';
    host.appendChild(this.minimap);
    this.mctx = this.minimap.getContext('2d')!;
    this.palette = readPalette();
    this.measureFont();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(host);
    this.themeObs = new MutationObserver(() => this.refreshTheme());
    this.themeObs.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    this.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    this.bindInput();
    this.resize();
  }

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.themeObs.disconnect();
    this.canvas.remove();
    this.minimap.remove();
  }

  refreshTheme(): void {
    this.palette = readPalette();
    this.measureFont();
    this.minimapImage = null;
    this.invalidate();
  }

  private measureFont(): void {
    this.ctx.font = fontMono(this.palette, 400, FONT_SIZE);
    this.charW = this.ctx.measureText('MMMMMMMMMM').width / 10 || 7.2;
  }

  /** Monospace character width used for sizing nodes. */
  get charWidth(): number {
    return this.charW;
  }

  get zoom(): number {
    return this.cam.k;
  }

  /** Current pan/zoom (to restore a view later). */
  get camera(): Camera {
    return { ...this.cam };
  }

  set camera(c: Camera) {
    this.reframe = null;
    this.moveCamera({ k: clamp(c.k, MIN_K, MAX_K), tx: c.tx, ty: c.ty }, false);
  }

  getScene(): Scene {
    return this.scene;
  }

  node(key: string): SceneNode | undefined {
    return this.byKey.get(key);
  }

  // ------------------------------------------------------------ scene

  setScene(scene: Scene, opts: { animate?: boolean; fit?: boolean; anchor?: string } = {}): void {
    const prev = this.byKey;
    const anchorBefore = opts.anchor ? prev.get(opts.anchor) : undefined;
    this.scene = scene;
    this.byKey = new Map(scene.nodes.map((n) => [n.key, n]));
    this.grid = new SpatialGrid(scene.nodes);
    this.edgeBoxes = scene.edges.map((e) => this.edgeBox(e));
    this.edgeGrid = new SpatialGrid(this.edgeBoxes);
    this.adjacency = new Map();
    for (const e of scene.edges) {
      if (!this.adjacency.has(e.from)) this.adjacency.set(e.from, new Set());
      if (!this.adjacency.has(e.to)) this.adjacency.set(e.to, new Set());
      this.adjacency.get(e.from)!.add(e.to);
      this.adjacency.get(e.to)!.add(e.from);
    }
    this.minimapImage = null;
    for (const k of [...this.selected]) if (!this.byKey.has(k)) this.selected.delete(k);

    const animate = opts.animate && this.animations && prev.size > 0 && scene.nodes.length < 3000;
    if (animate) {
      const from = new Map<string, { x: number; y: number; w: number; h: number }>();
      const fresh = new Set<string>();
      for (const n of scene.nodes) {
        const old = prev.get(n.key);
        if (old) from.set(n.key, { x: old.x, y: old.y, w: old.w, h: old.h });
        else fresh.add(n.key);
      }
      this.anim = { start: performance.now(), duration: 260, from, fresh };
    } else this.anim = null;

    // Keep the anchor node visually still (expand/collapse should not jump).
    if (anchorBefore && !opts.fit) {
      const after = this.byKey.get(opts.anchor!);
      if (after) {
        this.cam.tx += (anchorBefore.x - after.x) * this.cam.k;
        this.cam.ty += (anchorBefore.y - after.y) * this.cam.k;
        if (this.anim) {
          // Animate in the anchor's frame so the anchor stays put.
          const dx = after.x - anchorBefore.x;
          const dy = after.y - anchorBefore.y;
          for (const [k, b] of this.anim.from) this.anim.from.set(k, { ...b, x: b.x + dx, y: b.y + dy });
        }
      }
    }
    if (opts.fit) this.fit(false);
    else this.reframe = null;
    this.invalidate();
  }

  private edgeBox(e: SceneEdge): { x: number; y: number; w: number; h: number } {
    const pts = this.edgeGeometry(e).pts;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]);
      y1 = Math.max(y1, pts[i + 1]);
    }
    if (!isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
    // Labels can stick out sideways from steep edges.
    const pad = 20 + (e.label ? edgeLabelWidth(e.label, this.charW) / 2 : 0);
    return { x: x0 - pad, y: y0 - 20, w: x1 - x0 + pad * 2, h: y1 - y0 + 40 };
  }

  private edgeGeometry(e: SceneEdge, pos?: (key: string) => SceneNode | undefined): EdgeGeometry {
    const get = pos ?? ((k: string) => this.byKey.get(k));
    if (e.points && this.scene.edgeMode === 'route' && !pos) return { pts: e.points, curve: false };
    const a = get(e.from);
    const b = get(e.to);
    if (!a || !b) return { pts: [0, 0, 0, 0], curve: false };
    if (e.points && this.scene.edgeMode === 'route') {
      // During animation: shift the route with its endpoints.
      const a0 = this.byKey.get(e.from)!;
      const dx = a.x - a0.x;
      const dy = a.y - a0.y;
      return { pts: e.points.map((v, i) => v + (i % 2 ? dy : dx)), curve: false };
    }
    return { pts: curveBetween(a, b, e.fromRow, this.scene.direction), curve: true };
  }

  setSelection(keys: Iterable<string> | string | null): void {
    this.selected = new Set(keys === null ? [] : typeof keys === 'string' ? [keys] : keys);
    this.invalidate();
  }

  /** Highlights one row of a card (keyboard / row selection). */
  setSelectedRow(key: string | null, row = -1): void {
    this.selectedRow = key === null || row < 0 ? null : { key, row };
    this.invalidate();
  }

  /** Pans (without zooming) just enough to bring a node's row, or its top, into view. */
  reveal(key: string, row = -1, animate = true): void {
    const n = this.byKey.get(key);
    if (!n || !this.width) return;
    const { k, tx, ty } = this.cam;
    const top = row >= 0 && n.rows ? rowPortY(n, row) - ROW_H / 2 : n.y;
    const bottom = row >= 0 && n.rows ? top + ROW_H : n.y + Math.min(n.h, HEADER_H + ROW_H * 3);
    const right = n.x + Math.min(n.w, this.width / k - 80 / k);
    const margin = 40;
    const shift = (lo: number, hi: number, size: number) => (lo < margin ? margin - lo : hi > size - margin ? Math.max(size - margin - hi, margin - lo) : 0);
    const dx = shift(n.x * k + tx, right * k + tx, this.width);
    const dy = shift(top * k + ty, bottom * k + ty, this.height);
    if (dx || dy) {
      this.reframe = null;
      this.moveCamera({ k, tx: tx + dx, ty: ty + dy }, animate);
    }
  }

  /** Nodes outlined as invalid (schema validation). */
  setErrors(keys: Iterable<string>): void {
    this.errors = new Set(keys);
    this.invalidate();
  }

  setMatches(keys: Iterable<string>): void {
    this.matches = new Set(keys);
    this.invalidate();
  }

  // ------------------------------------------------------------ camera

  private toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.cam.tx) / this.cam.k, (sy - this.cam.ty) / this.cam.k];
  }

  /** World-space bounding box of the scene. */
  private bounds(): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of this.scene.nodes) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x + n.w);
      y1 = Math.max(y1, n.y + n.h);
    }
    return { x0, y0, x1, y1 };
  }

  fit(animate = true, padding = 40): void {
    if (!this.scene.nodes.length || !this.width) return;
    const { x0, y0, x1, y1 } = this.bounds();
    const k = clamp(Math.min((this.width - padding * 2) / (x1 - x0 || 1), (this.height - padding * 2) / (y1 - y0 || 1)), MIN_K, 1.25);
    const to: Camera = { k, tx: (this.width - (x1 - x0) * k) / 2 - x0 * k, ty: (this.height - (y1 - y0) * k) / 2 - y0 * k };
    this.moveCamera(to, animate);
    this.reframe = () => this.fit(false, padding);
  }

  /**
   * Initial camera: fits the scene while it stays legible (zoom ≥ `readable`);
   * otherwise starts at `key` (or the most connected node) at a readable zoom,
   * on the leading edge for `align` left/top, filling the viewport with as much
   * of the scene as possible.
   */
  frameStart(key?: string, align: 'left' | 'top' | 'center' = 'center', readable = 0.5): void {
    this.fit(false);
    this.reframe = () => this.frameStart(key, align, readable);
    if (this.cam.k >= readable || !this.width) return;
    const n = (key ? this.byKey.get(key) : undefined) ?? this.hub();
    if (!n) return;
    const k = 0.85;
    const pad = 40;
    const b = this.bounds();
    let tx = this.width / 2 - (n.x + Math.min(n.w, this.width / k) / 2) * k;
    let ty = this.height / 2 - (n.y + Math.min(n.h, (this.height / k) * 0.8) / 2) * k;
    if (align === 'left') tx = 48 - n.x * k;
    if (align === 'top') ty = pad - n.y * k;
    // Cross axis: centre the scene when it fits, else avoid empty margins.
    const fill = (t: number, lo: number, hi: number, size: number) => {
      const span = (hi - lo) * k;
      return span <= size - 2 * pad ? (size - span) / 2 - lo * k : clamp(t, size - pad - hi * k, pad - lo * k);
    };
    if (align !== 'top') ty = fill(ty, b.y0, b.y1, this.height);
    if (align !== 'left') tx = fill(tx, b.x0, b.x1, this.width);
    this.moveCamera({ k, tx, ty }, false);
  }

  /** The node with the most connections (a good starting point for big graphs). */
  private hub(): SceneNode | undefined {
    let best: SceneNode | undefined;
    let degree = -1;
    for (const n of this.scene.nodes) {
      const d = this.adjacency.get(n.key)?.size ?? 0;
      if (d > degree) {
        degree = d;
        best = n;
      }
    }
    return best;
  }

  /** Centres a node; `zoom` keeps the current scale when omitted (but ensures legibility). */
  focus(key: string, opts: { zoom?: number; animate?: boolean; onlyIfHidden?: boolean; align?: 'center' | 'left' | 'top' } = {}): void {
    const n = this.byKey.get(key);
    if (!n || !this.width) return;
    const k = opts.zoom ?? Math.max(this.cam.k, 0.8);
    if (opts.onlyIfHidden) {
      const sx = n.x * this.cam.k + this.cam.tx;
      const sy = n.y * this.cam.k + this.cam.ty;
      if (sx > 20 && sy > 20 && sx + n.w * this.cam.k < this.width - 20 && sy + n.h * this.cam.k < this.height - 20 && this.cam.k > 0.45) return;
    }
    this.reframe = null;
    const cx = n.x + Math.min(n.w, this.width / k) / 2;
    const cy = n.y + Math.min(n.h, (this.height / k) * 0.8) / 2;
    let tx = this.width / 2 - cx * k;
    let ty = this.height / 2 - cy * k;
    if (opts.align === 'left') tx = 48 - n.x * k;
    else if (opts.align === 'top') ty = 40 - n.y * k;
    this.moveCamera({ k, tx, ty }, opts.animate ?? true);
  }

  zoomBy(factor: number, sx = this.width / 2, sy = this.height / 2, animate = true): void {
    this.reframe = null;
    const k = clamp(this.cam.k * factor, MIN_K, MAX_K);
    const [wx, wy] = this.toWorld(sx, sy);
    this.moveCamera({ k, tx: sx - wx * k, ty: sy - wy * k }, animate);
  }

  resetZoom(): void {
    this.zoomBy(1 / this.cam.k);
  }

  private moveCamera(to: Camera, animate: boolean): void {
    if (animate && this.animations) this.camAnim = { from: { ...this.cam }, to, start: performance.now(), duration: 280 };
    else {
      this.cam = to;
      this.camAnim = null;
    }
    this.invalidate();
  }

  // ------------------------------------------------------------ rendering

  invalidate(): void {
    this.dirty = true;
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(() => this.frame());
  }

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.floor(r.width));
    const h = Math.max(1, Math.floor(r.height));
    const changed = w !== this.width || h !== this.height;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    if (changed && this.reframe && !this.camAnim) {
      this.reframe();
      this.events.onViewport?.(this.cam.k);
    }
    this.invalidate();
  }

  private frame(): void {
    this.raf = 0;
    if (this.disposed) return;
    const now = performance.now();
    let more = false;
    if (this.camAnim) {
      const t = Math.min(1, (now - this.camAnim.start) / this.camAnim.duration);
      const e = easeOut(t);
      const { from, to } = this.camAnim;
      // Interpolate zoom geometrically for a natural feel.
      const k = from.k * Math.pow(to.k / from.k, e);
      const f = (k - from.k) / (to.k - from.k || 1);
      const mix = Math.abs(to.k - from.k) < 1e-9 ? e : f;
      this.cam = { k, tx: from.tx + (to.tx - from.tx) * mix, ty: from.ty + (to.ty - from.ty) * mix };
      if (t >= 1) {
        this.cam = to;
        this.camAnim = null;
      } else more = true;
      this.events.onViewport?.(this.cam.k);
    }
    let progress = 1;
    if (this.anim) {
      progress = Math.min(1, (now - this.anim.start) / this.anim.duration);
      if (progress >= 1) this.anim = null;
      else more = true;
    }
    if (this.dirty || more) this.render(easeOut(progress));
    this.dirty = false;
    if (more) this.raf = requestAnimationFrame(() => this.frame());
  }

  private render(progress: number): void {
    const ctx = this.ctx;
    const p = this.palette;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.updateGridBackground();
    const { k, tx, ty } = this.cam;
    ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, this.dpr * tx, this.dpr * ty);
    const [vx, vy] = this.toWorld(0, 0);
    const vw = this.width / k;
    const vh = this.height / k;
    const margin = 40 / k;

    // Interpolated positions while animating.
    const anim = this.anim;
    let pos: ((key: string) => SceneNode | undefined) | undefined;
    if (anim && progress < 1) {
      const cache = new Map<string, SceneNode>();
      pos = (key) => {
        const n = this.byKey.get(key);
        if (!n) return undefined;
        const from = anim.from.get(key);
        if (!from) return n;
        let c = cache.get(key);
        if (!c) {
          c = { ...n, x: lerp(from.x, n.x, progress), y: lerp(from.y, n.y, progress), w: lerp(from.w, n.w, progress), h: lerp(from.h, n.h, progress) };
          cache.set(key, c);
        }
        return c;
      };
    }

    const focusKey = this.hover?.key ?? (this.selected.size === 1 ? [...this.selected][0] : undefined);
    const related = focusKey ? new Set([focusKey, ...(this.adjacency.get(focusKey) ?? [])]) : undefined;
    const dc: DrawContext = {
      ctx,
      p,
      k,
      charW: this.charW,
      hoverKey: this.hover?.key,
      hoverRow: this.hover?.row,
      selectedRow: this.selectedRow ?? undefined,
      selected: this.selected,
      matches: this.matches,
      errors: this.errors,
      related,
      dimOthers: false,
    };

    // Edges
    const edgeIdx = anim ? this.scene.edges.map((_, i) => i) : this.edgeGrid.query(vx - margin, vy - margin, vw + margin * 2, vh + margin * 2);
    const heavy = edgeIdx.length > 4000 && k < 0.15;
    for (const i of edgeIdx) {
      const e = this.scene.edges[i];
      const hi = !!focusKey && (e.from === focusKey || e.to === focusKey);
      if (heavy && !hi) continue;
      const fresh = anim && (anim.fresh.has(e.to) || anim.fresh.has(e.from));
      drawEdge(dc, e, this.edgeGeometry(e, pos), hi, fresh ? progress : 1);
    }

    // Nodes
    const nodeIdx = anim ? this.scene.nodes.map((_, i) => i) : this.grid.query(vx - margin, vy - margin, vw + margin * 2, vh + margin * 2);
    for (const i of nodeIdx) {
      const base = this.scene.nodes[i];
      const n = pos ? (pos(base.key) ?? base) : base;
      if (n.x > vx + vw + margin || n.x + n.w < vx - margin || n.y > vy + vh + margin || n.y + n.h < vy - margin) continue;
      const alpha = anim?.fresh.has(n.key) ? progress : 1;
      drawNode(dc, n, alpha);
    }
    this.renderMinimap();
  }

  private updateGridBackground(): void {
    // Dot grid as a CSS background on the host: free to render and always crisp.
    const { k, tx, ty } = this.cam;
    const size = 24 * k;
    const style = this.host.style;
    if (size < 6) {
      style.backgroundImage = 'none';
      return;
    }
    style.backgroundImage = '';
    style.backgroundSize = `${size}px ${size}px`;
    style.backgroundPosition = `${tx}px ${ty}px`;
  }

  private renderMinimap(): void {
    const mm = this.minimap;
    const s = this.scene;
    const show = this.showMinimap && s.nodes.length > 1 && (s.width * this.cam.k > this.width * 1.1 || s.height * this.cam.k > this.height * 1.1);
    mm.style.display = show ? 'block' : 'none';
    if (!show) return;
    const W = 180;
    const H = 120;
    const dpr = this.dpr;
    if (mm.width !== W * dpr) {
      mm.width = W * dpr;
      mm.height = H * dpr;
      mm.style.width = `${W}px`;
      mm.style.height = `${H}px`;
    }
    const scale = Math.min(W / (s.width || 1), H / (s.height || 1)) * 0.92;
    const ox = (W - s.width * scale) / 2;
    const oy = (H - s.height * scale) / 2;
    if (!this.minimapImage) {
      const img = document.createElement('canvas');
      img.width = W * dpr;
      img.height = H * dpr;
      const c = img.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const n of s.nodes) {
        c.fillStyle = withAlpha(resolveColor(this.palette, n.color, this.palette.colors.accent), 0.75);
        c.fillRect(ox + n.x * scale, oy + n.y * scale, Math.max(1, n.w * scale), Math.max(1, n.h * scale));
      }
      this.minimapImage = img;
    }
    const m = this.mctx;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, mm.width, mm.height);
    m.drawImage(this.minimapImage, 0, 0);
    m.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [vx, vy] = this.toWorld(0, 0);
    m.strokeStyle = this.palette.selection;
    m.lineWidth = 1.5;
    m.fillStyle = withAlpha(this.palette.selection, 0.08);
    const rx = ox + vx * scale;
    const ry = oy + vy * scale;
    const rw = (this.width / this.cam.k) * scale;
    const rh = (this.height / this.cam.k) * scale;
    m.fillRect(rx, ry, rw, rh);
    m.strokeRect(rx, ry, rw, rh);
    (mm as HTMLCanvasElement & { _map?: { scale: number; ox: number; oy: number } })._map = { scale, ox, oy };
  }

  // ------------------------------------------------------------ hit testing

  hitTest(sx: number, sy: number): { node: SceneNode; row: number; port: boolean } | null {
    const [wx, wy] = this.toWorld(sx, sy);
    const hits = this.grid.query(wx - 6 / this.cam.k, wy - 2, 12 / this.cam.k, 4);
    for (let j = hits.length - 1; j >= 0; j--) {
      const n = this.scene.nodes[hits[j]];
      const portSlack = 7 / this.cam.k;
      if (wx < n.x || wx > n.x + n.w + portSlack || wy < n.y || wy > n.y + n.h) continue;
      let row = -1;
      let port = false;
      if (n.rows?.length) {
        const top = n.title !== undefined ? n.y + HEADER_H : n.y + 4;
        const r = Math.floor((wy - top) / ROW_H);
        if (r >= 0 && r < n.rows.length) {
          row = r;
          const rr = n.rows[r];
          port = !!(rr.child || rr.expandable) && wx > n.x + n.w - 16;
        }
      }
      if (wx > n.x + n.w && !port) continue;
      return { node: n, row, port };
    }
    return null;
  }

  // ------------------------------------------------------------ input

  private bindInput(): void {
    const c = this.canvas;
    let down: { x: number; y: number; tx: number; ty: number; moved: boolean; id: number } | null = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      c.setPointerCapture(e.pointerId);
      down = { x: e.clientX, y: e.clientY, tx: this.cam.tx, ty: this.cam.ty, moved: false, id: e.pointerId };
      this.camAnim = null;
    });
    c.addEventListener('pointermove', (e) => {
      const r = c.getBoundingClientRect();
      if (down) {
        const dx = e.clientX - down.x;
        const dy = e.clientY - down.y;
        if (!down.moved && Math.hypot(dx, dy) > 3) {
          down.moved = true;
          this.reframe = null;
          c.classList.add('panning');
        }
        if (down.moved) {
          this.cam.tx = down.tx + dx;
          this.cam.ty = down.ty + dy;
          this.invalidate();
        }
        return;
      }
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      const next = hit ? { key: hit.node.key, row: hit.row } : null;
      if (next?.key !== this.hover?.key || next?.row !== this.hover?.row) {
        this.hover = next;
        c.style.cursor = hit ? (hit.port || hit.node.rows?.[hit.row]?.action || hit.node.rows?.[hit.row]?.expandable ? 'pointer' : 'default') : 'grab';
        this.events.onHover?.(hit?.node ?? null, hit?.row ?? -1);
        this.invalidate();
      }
    });
    const end = (e: PointerEvent) => {
      if (!down) return;
      const wasMove = down.moved;
      c.classList.remove('panning');
      try {
        c.releasePointerCapture(down.id);
      } catch {
        // already released
      }
      down = null;
      if (wasMove || e.type === 'pointercancel') return;
      const r = c.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      if (!hit) {
        this.events.onBackgroundClick?.();
        return;
      }
      const row = hit.row >= 0 ? hit.node.rows![hit.row] : undefined;
      if (row?.action) this.events.onAction?.(hit.node, hit.row);
      else if (hit.port) this.events.onToggle?.(hit.node, hit.row);
      else this.events.onNodeClick?.(hit.node, hit.row, e);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (this.hover) {
        this.hover = null;
        this.events.onHover?.(null, -1);
        this.invalidate();
      }
    });
    c.addEventListener('dblclick', (e) => {
      const r = c.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      if (hit) this.events.onNodeDoubleClick?.(hit.node, hit.row, e);
      else this.zoomBy(1.6, e.clientX - r.left, e.clientY - r.top);
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const hit = this.hitTest(e.clientX - r.left, e.clientY - r.top);
      this.events.onContextMenu?.(hit?.node ?? null, hit?.row ?? -1, e);
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const sx = e.clientX - r.left;
        const sy = e.clientY - r.top;
        // Pinch / ctrl+wheel and mouse wheels zoom; trackpad two-finger scrolls pan.
        const lineMode = e.deltaMode === 1;
        const trackpadPan = !e.ctrlKey && !lineMode && (Math.abs(e.deltaX) > 0.5 || (Math.abs(e.deltaY) < 40 && !Number.isInteger(e.deltaY)));
        if (trackpadPan || e.shiftKey) {
          this.cam.tx -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
          this.cam.ty -= e.shiftKey && !e.deltaX ? 0 : e.deltaY;
          this.camAnim = null;
          this.reframe = null;
          this.invalidate();
          return;
        }
        const delta = lineMode ? e.deltaY * 33 : e.deltaY;
        const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015));
        this.zoomBy(factor, sx, sy, false);
        this.events.onViewport?.(this.cam.k);
      },
      { passive: false },
    );
    // Minimap navigation.
    const navigate = (e: PointerEvent) => {
      const map = (this.minimap as HTMLCanvasElement & { _map?: { scale: number; ox: number; oy: number } })._map;
      if (!map) return;
      const r = this.minimap.getBoundingClientRect();
      const wx = (e.clientX - r.left - map.ox) / map.scale;
      const wy = (e.clientY - r.top - map.oy) / map.scale;
      this.cam.tx = this.width / 2 - wx * this.cam.k;
      this.cam.ty = this.height / 2 - wy * this.cam.k;
      this.camAnim = null;
      this.reframe = null;
      this.invalidate();
    };
    this.minimap.addEventListener('pointerdown', (e) => {
      this.minimap.setPointerCapture(e.pointerId);
      navigate(e);
      const move = (ev: PointerEvent) => navigate(ev);
      const up = () => {
        this.minimap.removeEventListener('pointermove', move);
        this.minimap.removeEventListener('pointerup', up);
      };
      this.minimap.addEventListener('pointermove', move);
      this.minimap.addEventListener('pointerup', up);
    });
  }

  // ------------------------------------------------------------ export

  /** Renders the whole scene to a PNG (scaled down to stay within canvas limits). */
  async exportPng(scale = 2): Promise<Blob> {
    const s = this.scene;
    const pad = 32;
    const maxSide = 16000;
    const k = Math.min(scale, maxSide / (s.width + pad * 2), maxSide / (s.height + pad * 2));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil((s.width + pad * 2) * k));
    c.height = Math.max(1, Math.ceil((s.height + pad * 2) * k));
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = this.palette.bg;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(k, 0, 0, k, pad * k, pad * k);
    const dc: DrawContext = { ctx, p: this.palette, k: Math.max(k, 1), charW: this.charW, selected: new Set(), matches: new Set() };
    for (const e of s.edges) drawEdge(dc, e, this.edgeGeometry(e), false);
    for (const n of s.nodes) drawNode(dc, n);
    return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png'));
  }

  /** Vector export with the same geometry as the canvas. */
  exportSvg(): string {
    const s = this.scene;
    const p = this.palette;
    const pad = 32;
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const out: string[] = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${s.width + pad * 2}" height="${s.height + pad * 2}" viewBox="${-pad} ${-pad} ${s.width + pad * 2} ${s.height + pad * 2}" font-family="${esc(p.monoFont)}" font-size="${FONT_SIZE}">`);
    out.push(`<rect x="${-pad}" y="${-pad}" width="${s.width + pad * 2}" height="${s.height + pad * 2}" fill="${p.bg}"/>`);
    out.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + p.edge + '"/></marker></defs>');
    for (const e of s.edges) {
      const g = this.edgeGeometry(e);
      const d = g.curve
        ? `M${g.pts[0]},${g.pts[1]} C${g.pts[2]},${g.pts[3]} ${g.pts[4]},${g.pts[5]} ${g.pts[6]},${g.pts[7]}`
        : 'M' + g.pts.reduce<string[]>((acc, v, i) => (i % 2 ? (acc[acc.length - 1] += `,${v}`, acc) : (acc.push(String(v)), acc)), []).join(' L');
      const dash = e.style === 'dashed' ? ' stroke-dasharray="6 5"' : e.style === 'dotted' ? ' stroke-dasharray="2 4"' : '';
      out.push(`<path d="${d}" fill="none" stroke="${resolveColor(p, e.color, p.edge)}" stroke-width="${e.width ?? 1.3}"${dash}${e.arrow !== false ? ' marker-end="url(#arrow)"' : ''}/>`);
      if (e.label) {
        const [lx, ly] = edgeLabelPoint(e, g);
        const text = truncateChars(e.label, EDGE_LABEL_CHARS);
        const lw = edgeLabelWidth(text, this.charW);
        const color = resolveColor(p, e.color, p.edge);
        out.push(`<rect x="${lx - lw / 2}" y="${ly - EDGE_LABEL_H / 2}" width="${lw}" height="${EDGE_LABEL_H}" rx="8" fill="${p.bg}" stroke="${withAlpha(color, 0.8)}"/>`);
        out.push(`<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="central" font-size="10.5" font-weight="500" fill="${color}">${esc(text)}</text>`);
      }
    }
    for (const n of s.nodes) {
      const accent = resolveColor(p, n.color, p.colors.accent);
      const r = n.shape === 'stadium' || n.shape === 'pill' ? n.h / 2 : 8;
      if (n.shape === 'diamond') {
        out.push(`<polygon points="${n.x + n.w / 2},${n.y} ${n.x + n.w},${n.y + n.h / 2} ${n.x + n.w / 2},${n.y + n.h} ${n.x},${n.y + n.h / 2}" fill="${p.card}" stroke="${accent}"/>`);
      } else {
        out.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${r}" fill="${p.card}" stroke="${withAlpha(accent, 0.6)}"${n.dashed ? ' stroke-dasharray="5 4"' : ''}/>`);
      }
      let ty = n.y + 4;
      if (n.title !== undefined && (n.shape === 'card' || n.shape === 'note')) {
        out.push(`<rect x="${n.x}" y="${n.y}" width="${n.w}" height="2" fill="${accent}"/>`);
        out.push(`<text x="${n.x + 10}" y="${n.y + HEADER_H / 2 + 4}" font-weight="600" fill="${p.text}">${esc(n.title)}</text>`);
        if (n.badge) out.push(`<text x="${n.x + n.w - 10}" y="${n.y + HEADER_H / 2 + 4}" text-anchor="end" fill="${p.muted}">${esc(n.badge)}</text>`);
        ty = n.y + HEADER_H;
      }
      if (n.rows) {
        n.rows.forEach((row, i) => {
          const y = ty + i * ROW_H + ROW_H / 2 + 4;
          const key = row.key !== undefined ? `<tspan fill="${resolveColor(p, row.keyColor, p.colors.key)}">${esc(row.key)}</tspan>${row.value !== undefined ? `<tspan fill="${p.faint}">: </tspan>` : ''}` : '';
          const val = row.value !== undefined ? `<tspan fill="${resolveColor(p, row.valueColor, p.text)}">${row.swatch ? '\u00A0\u00A0' : ''}${esc(row.value)}</tspan>` : '';
          if (row.swatch) {
            const sx = n.x + 10 + ((row.icon ? row.icon.length + 1 : 0) + (row.key !== undefined ? row.key.length + 2 : 0)) * this.charW;
            out.push(`<rect x="${sx}" y="${y - 9}" width="10" height="10" rx="2.5" fill="${esc(row.swatch)}" stroke="${withAlpha(p.text, 0.3)}"/>`);
          }
          out.push(`<text x="${n.x + 10}" y="${y}">${row.icon ? `<tspan fill="${resolveColor(p, row.iconColor, p.muted)}">${esc(row.icon)} </tspan>` : ''}${key}${val}</text>`);
        });
      } else if (n.lines || n.title) {
        const lines = n.lines ?? [n.title!];
        const centred = n.shape !== 'card' && n.shape !== 'note';
        lines.forEach((l, i) => {
          const y = centred ? n.y + n.h / 2 - (lines.length * 18) / 2 + 13 + i * 18 : ty + i * ROW_H + ROW_H / 2 + 4;
          out.push(`<text x="${centred ? n.x + n.w / 2 : n.x + 10}" y="${y}"${centred ? ' text-anchor="middle"' : ''} fill="${p.text}">${esc(l)}</text>`);
        });
      }
    }
    out.push('</svg>');
    return out.join('\n');
  }
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
