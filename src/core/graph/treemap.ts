/** Squarified treemap (Bruls, Huizing & van Wijk) over a weighted hierarchy. */

export interface TreemapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Lays out `values` (all > 0) inside `rect`, returning one rectangle per
 * value in input order. Values are sorted internally (largest first).
 */
export function squarify(values: number[], rect: TreemapRect): TreemapRect[] {
  const out: TreemapRect[] = new Array(values.length);
  const total = values.reduce((s, v) => s + v, 0);
  if (!values.length || total <= 0 || rect.w <= 0 || rect.h <= 0) {
    for (let i = 0; i < values.length; i++) out[i] = { x: rect.x, y: rect.y, w: 0, h: 0 };
    return out;
  }
  const scale = (rect.w * rect.h) / total;
  const order = values.map((v, i) => [v * scale, i] as [number, number]).sort((a, b) => b[0] - a[0]);
  let { x, y, w, h } = rect;
  let row: [number, number][] = [];
  let rowSum = 0;

  const worst = (r: [number, number][], sum: number, side: number) => {
    if (!r.length) return Infinity;
    let max = 0;
    let min = Infinity;
    for (const [a] of r) {
      max = Math.max(max, a);
      min = Math.min(min, a);
    }
    const s2 = side * side;
    const sum2 = sum * sum;
    return Math.max((s2 * max) / sum2, sum2 / (s2 * Math.max(min, 1e-9)));
  };
  const flush = () => {
    if (!row.length) return;
    const horizontal = w >= h; // lay the row along the shorter side
    const side = horizontal ? h : w;
    const thickness = rowSum / side;
    let offset = 0;
    for (const [a, i] of row) {
      const len = a / thickness;
      out[i] = horizontal ? { x, y: y + offset, w: thickness, h: len } : { x: x + offset, y, w: len, h: thickness };
      offset += len;
    }
    if (horizontal) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }
    row = [];
    rowSum = 0;
  };
  for (const item of order) {
    const side = Math.min(w, h);
    if (row.length && worst([...row, item], rowSum + item[0], side) > worst(row, rowSum, side)) flush();
    row.push(item);
    rowSum += item[0];
  }
  flush();
  for (let i = 0; i < values.length; i++) out[i] ??= { x: rect.x, y: rect.y, w: 0, h: 0 };
  return out;
}
