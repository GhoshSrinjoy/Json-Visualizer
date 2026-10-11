/** Uniform-grid spatial index over axis-aligned boxes (static, rebuilt per layout). */

export class SpatialGrid {
  private cells = new Map<number, number[]>();
  private readonly cell: number;

  constructor(
    private readonly boxes: { x: number; y: number; w: number; h: number }[],
    cellSize?: number,
  ) {
    // Cell ≈ 4× the median box size keeps bucket lists short.
    if (cellSize) this.cell = cellSize;
    else {
      const sample = boxes.slice(0, 500).map((b) => Math.max(b.w, b.h)).sort((a, b) => a - b);
      this.cell = Math.max(64, (sample[Math.floor(sample.length / 2)] ?? 200) * 4);
    }
    boxes.forEach((b, i) => {
      const x0 = Math.floor(b.x / this.cell);
      const y0 = Math.floor(b.y / this.cell);
      const x1 = Math.floor((b.x + b.w) / this.cell);
      const y1 = Math.floor((b.y + b.h) / this.cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const k = key(cx, cy);
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
      }
    });
  }

  /** Indexes of boxes intersecting the query rectangle (deduplicated). */
  query(x: number, y: number, w: number, h: number, out: number[] = []): number[] {
    const x0 = Math.floor(x / this.cell);
    const y0 = Math.floor(y / this.cell);
    const x1 = Math.floor((x + w) / this.cell);
    const y1 = Math.floor((y + h) / this.cell);
    const cellsAcross = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (cellsAcross > this.cells.size) {
      // Zoomed far out: scanning everything is cheaper than visiting empty cells.
      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        if (b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y) out.push(i);
      }
      return out;
    }
    const seen = new Set<number>();
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const list = this.cells.get(key(cx, cy));
        if (!list) continue;
        for (const i of list) {
          if (seen.has(i)) continue;
          seen.add(i);
          const b = this.boxes[i];
          if (b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y) out.push(i);
        }
      }
    }
    return out;
  }
}

function key(cx: number, cy: number): number {
  // Cantor-style pairing over a bounded range keeps keys numeric.
  return (cx + 32768) * 65536 + (cy + 32768);
}
