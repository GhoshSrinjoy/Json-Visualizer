import { describe, expect, it } from 'vitest';
import { layoutLayered } from '../../src/core/graph/layered';
import { layoutTree } from '../../src/core/graph/tree-layout';
import { squarify } from '../../src/core/graph/treemap';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

function randomTree(n: number, seed: number) {
  const r = rng(seed);
  const children: number[][] = Array.from({ length: n }, () => []);
  const parent = new Int32Array(n).fill(-1);
  for (let i = 1; i < n; i++) {
    // Bias towards recent nodes for deeper trees, sometimes wide fan-out.
    const p = r() < 0.3 ? Math.floor(r() * i) : Math.max(0, i - 1 - Math.floor(r() * 5));
    children[p].push(i);
    parent[i] = p;
  }
  const width = Array.from({ length: n }, () => 60 + Math.floor(r() * 200));
  const height = Array.from({ length: n }, () => 20 + Math.floor(r() * 120));
  return { children, parent, width, height };
}

const overlaps = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number) =>
  ax < bx + bw - 1e-6 && bx < ax + aw - 1e-6 && ay < by + bh - 1e-6 && by < ay + ah - 1e-6;

describe('layoutTree', () => {
  for (const layered of [false, true]) {
    for (const direction of ['LR', 'TB'] as const) {
      it(`places random trees without overlaps (${direction}, layered=${layered})`, () => {
        for (let seed = 1; seed <= 12; seed++) {
          const t = randomTree(120, seed);
          const res = layoutTree({ width: t.width, height: t.height, children: t.children, root: 0 }, { direction, layered, levelGap: 40, siblingGap: 10 });
          for (let a = 0; a < 120; a++) {
            for (let b = a + 1; b < 120; b++) {
              if (overlaps(res.x[a], res.y[a], t.width[a], t.height[a], res.x[b], res.y[b], t.width[b], t.height[b])) {
                throw new Error(`overlap seed=${seed} ${a}/${b}`);
              }
            }
            const p = t.parent[a];
            if (p >= 0) {
              if (direction === 'LR') expect(res.x[a]).toBeGreaterThanOrEqual(res.x[p] + t.width[p] + 39.999);
              else expect(res.y[a]).toBeGreaterThanOrEqual(res.y[p] + t.height[p] + 39.999);
            }
            expect(res.x[a]).toBeGreaterThanOrEqual(-1e-6);
            expect(res.y[a]).toBeGreaterThanOrEqual(-1e-6);
            expect(res.x[a] + t.width[a]).toBeLessThanOrEqual(res.width + 1e-6);
            expect(res.y[a] + t.height[a]).toBeLessThanOrEqual(res.height + 1e-6);
          }
        }
      });
    }
  }

  it('centres parents over their children and keeps sibling order', () => {
    const res = layoutTree({ width: [100, 100, 100, 100], height: [40, 40, 40, 40], children: [[1, 2, 3], [], [], []], root: 0 }, { direction: 'TB', siblingGap: 20 });
    const centre = (i: number) => res.x[i] + 50;
    expect(centre(0)).toBeCloseTo((centre(1) + centre(3)) / 2);
    expect(res.x[1]).toBeLessThan(res.x[2]);
    expect(res.x[2]).toBeLessThan(res.x[3]);
  });

  it('handles very deep and very wide trees quickly', () => {
    const n = 200_000;
    const chain = Array.from({ length: n }, (_, i) => (i + 1 < n ? [i + 1] : []));
    const w = new Float64Array(n).fill(100);
    const h = new Float64Array(n).fill(30);
    let t = performance.now();
    const deep = layoutTree({ width: w, height: h, children: chain, root: 0 });
    expect(deep.width).toBeGreaterThan(n * 100);
    const wide = [Array.from({ length: n - 1 }, (_, i) => i + 1), ...Array.from({ length: n - 1 }, () => [])];
    layoutTree({ width: w, height: h, children: wide, root: 0 });
    t = performance.now() - t;
    expect(t).toBeLessThan(3000);
  });
});

describe('layoutLayered', () => {
  it('layers a flowchart with a loop: back edge reversed, no overlaps', () => {
    // start -> a -> loop -> body -> loop (back) ; loop -> end
    const nodes = Array.from({ length: 5 }, () => ({ w: 120, h: 36 }));
    const edges = [
      { from: 0, to: 1 },
      { from: 1, to: 2 },
      { from: 2, to: 3 },
      { from: 3, to: 2 },
      { from: 2, to: 4 },
    ];
    const r = layoutLayered(nodes, edges, { root: 0 });
    expect(Array.from(r.reversed)).toEqual([0, 0, 0, 1, 0]);
    expect(r.layer[0]).toBeLessThan(r.layer[1]);
    expect(r.layer[1]).toBeLessThan(r.layer[2]);
    expect(r.layer[3]).toBeGreaterThan(r.layer[2]);
    // back edge route runs upwards
    const back = r.routes[3];
    expect(back[back.length - 1]).toBeLessThan(back[1]);
  });

  it('separates nodes within layers on random DAGs and routes every edge', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const r = rng(seed);
      const n = 80;
      const nodes = Array.from({ length: n }, () => ({ w: 40 + r() * 160, h: 24 + r() * 40 }));
      const edges: { from: number; to: number }[] = [];
      for (let i = 0; i < 160; i++) {
        const a = Math.floor(r() * n);
        const b = Math.floor(r() * n);
        if (a !== b) edges.push({ from: Math.min(a, b), to: Math.max(a, b) });
      }
      edges.push({ from: 10, to: 3 }); // a cycle
      const res = layoutLayered(nodes, edges, { direction: seed % 2 ? 'TB' : 'LR' });
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          expect(overlaps(res.x[a], res.y[a], nodes[a].w, nodes[a].h, res.x[b], res.y[b], nodes[b].w, nodes[b].h)).toBe(false);
        }
      }
      for (const route of res.routes) expect(route.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('lays out a few thousand nodes fast', () => {
    const r = rng(7);
    const n = 3000;
    const nodes = Array.from({ length: n }, () => ({ w: 120, h: 30 }));
    const edges = Array.from({ length: 6000 }, () => {
      const a = Math.floor(r() * n);
      const b = Math.min(n - 1, a + 1 + Math.floor(r() * 40));
      return { from: a, to: b };
    });
    const t = performance.now();
    layoutLayered(nodes, edges);
    expect(performance.now() - t).toBeLessThan(5000);
  });
});

describe('squarify', () => {
  it('fills the rectangle proportionally without overlaps', () => {
    const values = [500, 300, 120, 80, 50, 30, 10, 5, 3, 2];
    const rects = squarify(values, { x: 10, y: 20, w: 400, h: 250 });
    const total = values.reduce((a, b) => a + b, 0);
    rects.forEach((r, i) => {
      expect(r.w * r.h).toBeCloseTo((values[i] / total) * 400 * 250, 3);
      expect(r.x).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(r.y).toBeGreaterThanOrEqual(20 - 1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(410 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(270 + 1e-6);
    });
    for (let a = 0; a < rects.length; a++)
      for (let b = a + 1; b < rects.length; b++) expect(overlaps(rects[a].x, rects[a].y, rects[a].w, rects[a].h, rects[b].x, rects[b].y, rects[b].w, rects[b].h)).toBe(false);
  });
});
