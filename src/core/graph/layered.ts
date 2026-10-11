/**
 * Layered (Sugiyama-style) layout for directed graphs: flowcharts, call
 * graphs and dependency graphs.
 *
 * 1. cycle breaking by DFS (back edges are reversed, then drawn upwards)
 * 2. longest-path layering, with sources pulled down next to their targets
 * 3. dummy nodes for edges spanning several layers
 * 4. crossing reduction: barycenter sweeps, keeping the best ordering
 *    (exact bilayer crossing counts via an accumulator tree)
 * 5. coordinates: iterative least-squares placement towards neighbours under
 *    ordering/spacing constraints (pool-adjacent-violators per layer)
 */

export interface LayeredNode {
  w: number;
  h: number;
}

export interface LayeredEdge {
  from: number;
  to: number;
  /** Relative importance for straightening (default 1). */
  weight?: number;
}

export interface LayeredOptions {
  direction?: 'TB' | 'LR';
  /** Space between layers. */
  rankSep?: number;
  /** Space between nodes in a layer. */
  nodeSep?: number;
  /** Width reserved for an edge passing through a layer. */
  edgeSep?: number;
  sweeps?: number;
  /** Preferred first node for cycle breaking (e.g. a flowchart's start). */
  root?: number;
  /** Above this many dummy nodes, long edges are drawn without them. */
  maxDummies?: number;
}

export interface LayeredResult {
  /** Top-left corners. */
  x: Float64Array;
  y: Float64Array;
  /** Polyline per input edge, [x0, y0, x1, y1, …] from source to target. */
  routes: number[][];
  /** Input edges that were reversed to break cycles. */
  reversed: Uint8Array;
  layer: Int32Array;
  width: number;
  height: number;
}

export function layoutLayered(nodes: LayeredNode[], edges: LayeredEdge[], options: LayeredOptions = {}): LayeredResult {
  const n = nodes.length;
  const tb = (options.direction ?? 'TB') === 'TB';
  const rankSep = options.rankSep ?? 56;
  const nodeSep = options.nodeSep ?? 28;
  const edgeSep = options.edgeSep ?? 12;
  const sweeps = options.sweeps ?? 10;
  const maxDummies = options.maxDummies ?? 20000;

  // Sizes in the internal top-to-bottom frame.
  const bw = new Float64Array(n); // breadth (along a layer)
  const dh = new Float64Array(n); // depth (across layers)
  for (let i = 0; i < n; i++) {
    bw[i] = tb ? nodes[i].w : nodes[i].h;
    dh[i] = tb ? nodes[i].h : nodes[i].w;
  }

  // ---- 1. cycle breaking
  const reversed = new Uint8Array(edges.length);
  const outAdj: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((e, k) => {
    if (e.from !== e.to) outAdj[e.from].push(k);
  });
  {
    const state = new Uint8Array(n); // 0 new, 1 on stack, 2 done
    const visit = (s: number) => {
      const stack: [number, number][] = [[s, 0]];
      state[s] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const v = top[0];
        if (top[1] < outAdj[v].length) {
          const k = outAdj[v][top[1]++];
          const w = edges[k].to;
          if (state[w] === 1) reversed[k] = 1;
          else if (state[w] === 0) {
            state[w] = 1;
            stack.push([w, 0]);
          }
          continue;
        }
        state[v] = 2;
        stack.pop();
      }
    };
    const indeg = new Int32Array(n);
    for (const e of edges) if (e.from !== e.to) indeg[e.to]++;
    if (options.root !== undefined && options.root < n) visit(options.root);
    for (let i = 0; i < n; i++) if (!state[i] && indeg[i] === 0) visit(i);
    for (let i = 0; i < n; i++) if (!state[i]) visit(i);
  }

  // Effective DAG edges.
  const dagFrom: number[] = [];
  const dagTo: number[] = [];
  const dagW: number[] = [];
  const dagOf: number[] = []; // input edge index
  edges.forEach((e, k) => {
    if (e.from === e.to) return;
    const [a, b] = reversed[k] ? [e.to, e.from] : [e.from, e.to];
    dagFrom.push(a);
    dagTo.push(b);
    dagW.push(e.weight ?? 1);
    dagOf.push(k);
  });

  // ---- 2. layering (longest path from sources)
  const layer = new Int32Array(n);
  {
    const indeg = new Int32Array(n);
    const succ: number[][] = Array.from({ length: n }, () => []);
    const pred: number[][] = Array.from({ length: n }, () => []);
    for (let k = 0; k < dagFrom.length; k++) {
      succ[dagFrom[k]].push(dagTo[k]);
      pred[dagTo[k]].push(dagFrom[k]);
      indeg[dagTo[k]]++;
    }
    const topo: number[] = [];
    const queue: number[] = [];
    for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
    while (queue.length) {
      const v = queue.shift()!;
      topo.push(v);
      for (const w of succ[v]) if (--indeg[w] === 0) queue.push(w);
    }
    for (const v of topo) for (const w of succ[v]) layer[w] = Math.max(layer[w], layer[v] + 1);
    // Pull sources (other than the root) down next to their nearest successor.
    for (let k = topo.length - 1; k >= 0; k--) {
      const v = topo[k];
      if (pred[v].length || !succ[v].length || v === options.root) continue;
      let min = Infinity;
      for (const w of succ[v]) min = Math.min(min, layer[w]);
      layer[v] = Math.max(0, min - 1);
    }
  }
  let layerCount = 0;
  for (let i = 0; i < n; i++) layerCount = Math.max(layerCount, layer[i] + 1);

  // ---- 3. dummy nodes
  // Virtual graph: real nodes 0..n-1, then dummies.
  const vLayer: number[] = Array.from(layer);
  const vW: number[] = Array.from(bw);
  const vUp: number[][] = Array.from({ length: n }, () => []); // neighbours in layer-1
  const vDown: number[][] = Array.from({ length: n }, () => []); // neighbours in layer+1
  const vWeightUp: number[][] = Array.from({ length: n }, () => []);
  const vWeightDown: number[][] = Array.from({ length: n }, () => []);
  const chains: number[][] = new Array(dagFrom.length); // virtual node sequence per dag edge
  let dummies = 0;
  for (let k = 0; k < dagFrom.length; k++) {
    const span = layer[dagTo[k]] - layer[dagFrom[k]];
    dummies += Math.max(0, span - 1);
  }
  const useDummies = dummies <= maxDummies;
  const link = (a: number, b: number, w: number) => {
    vDown[a].push(b);
    vWeightDown[a].push(w);
    vUp[b].push(a);
    vWeightUp[b].push(w);
  };
  for (let k = 0; k < dagFrom.length; k++) {
    const a = dagFrom[k];
    const b = dagTo[k];
    const span = layer[b] - layer[a];
    const chain = [a];
    if (span > 1 && useDummies) {
      let prev = a;
      for (let l = layer[a] + 1; l < layer[b]; l++) {
        const d = vLayer.length;
        vLayer.push(l);
        vW.push(edgeSep);
        vUp.push([]);
        vDown.push([]);
        vWeightUp.push([]);
        vWeightDown.push([]);
        // Long edges are weighted up so they stay straight.
        link(prev, d, dagW[k] * 2);
        chain.push(d);
        prev = d;
      }
      link(prev, b, dagW[k] * 2);
    } else if (span >= 1) link(a, b, dagW[k]);
    chain.push(b);
    chains[k] = chain;
  }
  const vn = vLayer.length;

  // ---- 4. ordering
  const layers: number[][] = Array.from({ length: layerCount }, () => []);
  {
    // Initial order: DFS from roots following edge order (keeps yes/no branches apart).
    const seen = new Uint8Array(vn);
    const visit = (s: number) => {
      const stack = [s];
      while (stack.length) {
        const v = stack.pop()!;
        if (seen[v]) continue;
        seen[v] = 1;
        layers[vLayer[v]].push(v);
        const d = vDown[v];
        for (let i = d.length - 1; i >= 0; i--) if (!seen[d[i]]) stack.push(d[i]);
      }
    };
    if (options.root !== undefined && options.root < n) visit(options.root);
    for (let i = 0; i < n; i++) if (!seen[i] && vUp[i].length === 0) visit(i);
    for (let i = 0; i < vn; i++) if (!seen[i]) visit(i);
  }
  const pos = new Float64Array(vn);
  const setPositions = () => {
    for (const L of layers) L.forEach((v, i) => (pos[v] = i));
  };
  setPositions();

  const crossings = (upper: number[], lower: number[]): number => {
    // Barth/Jünger/Mutzel accumulator-tree bilayer cross count.
    const lowerPos = new Map<number, number>();
    lower.forEach((v, i) => lowerPos.set(v, i));
    const ends: number[] = [];
    for (const u of upper) {
      const list = vDown[u].map((w) => lowerPos.get(w)!).filter((x) => x !== undefined).sort((a, b) => a - b);
      ends.push(...list);
    }
    let first = 1;
    while (first < lower.length) first <<= 1;
    const tree = new Int32Array(2 * first);
    let count = 0;
    for (const e of ends) {
      let idx = e + first;
      tree[idx]++;
      while (idx > 1) {
        if (idx % 2) count += tree[idx - 1];
        idx >>= 1;
        tree[idx]++;
      }
    }
    return count;
  };
  const totalCrossings = () => {
    let c = 0;
    for (let l = 0; l + 1 < layerCount; l++) c += crossings(layers[l], layers[l + 1]);
    return c;
  };
  if (vn <= 20000) {
    let best = layers.map((L) => [...L]);
    let bestCross = totalCrossings();
    for (let s = 0; s < sweeps && bestCross > 0; s++) {
      const down = s % 2 === 0;
      const range = down ? [...Array(layerCount).keys()].slice(1) : [...Array(layerCount).keys()].slice(0, -1).reverse();
      for (const l of range) {
        const L = layers[l];
        const bary = new Map<number, number>();
        for (const v of L) {
          const nbrs = down ? vUp[v] : vDown[v];
          if (!nbrs.length) {
            bary.set(v, pos[v]);
            continue;
          }
          let sum = 0;
          for (const u of nbrs) sum += pos[u];
          bary.set(v, sum / nbrs.length);
        }
        L.sort((a, b) => bary.get(a)! - bary.get(b)! || pos[a] - pos[b]);
        L.forEach((v, i) => (pos[v] = i));
      }
      const c = totalCrossings();
      if (c < bestCross) {
        bestCross = c;
        best = layers.map((L) => [...L]);
      }
    }
    for (let l = 0; l < layerCount; l++) layers[l] = best[l];
    setPositions();
  }

  // ---- 5. coordinates
  const bx = new Float64Array(vn); // breadth centre
  const gap = (a: number, b: number) => vW[a] / 2 + vW[b] / 2 + (a < n && b < n ? nodeSep : edgeSep);
  for (const L of layers) {
    let x = 0;
    L.forEach((v, i) => {
      if (i > 0) x += gap(L[i - 1], v);
      bx[v] = x;
    });
  }
  const place = (L: number[], target: Float64Array, weight: Float64Array) => {
    // Weighted isotonic regression with spacing: minimise Σ w(x - t)² s.t. x[i+1] - x[i] >= gap.
    const m = L.length;
    if (!m) return;
    const off = new Float64Array(m);
    for (let i = 1; i < m; i++) off[i] = off[i - 1] + gap(L[i - 1], L[i]);
    const blockVal: number[] = [];
    const blockW: number[] = [];
    const blockLen: number[] = [];
    for (let i = 0; i < m; i++) {
      let v = target[i] - off[i];
      let w = weight[i];
      let len = 1;
      while (blockVal.length && blockVal[blockVal.length - 1] > v) {
        const pv = blockVal.pop()!;
        const pw = blockW.pop()!;
        const pl = blockLen.pop()!;
        v = (v * w + pv * pw) / (w + pw);
        w += pw;
        len += pl;
      }
      blockVal.push(v);
      blockW.push(w);
      blockLen.push(len);
    }
    let i = 0;
    for (let b = 0; b < blockVal.length; b++) for (let k = 0; k < blockLen[b]; k++, i++) bx[L[i]] = blockVal[b] + off[i];
  };
  const iterations = vn > 5000 ? 4 : 10;
  for (let it = 0; it < iterations; it++) {
    const down = it % 2 === 0;
    const order = down ? [...Array(layerCount).keys()] : [...Array(layerCount).keys()].reverse();
    for (const l of order) {
      const L = layers[l];
      const target = new Float64Array(L.length);
      const weight = new Float64Array(L.length);
      L.forEach((v, i) => {
        const nbrs = down ? vUp[v] : vDown[v];
        const ws = down ? vWeightUp[v] : vWeightDown[v];
        // Final passes also consider the other side.
        const both = it >= iterations - 2;
        const all = both ? [...vUp[v], ...vDown[v]] : nbrs;
        const allW = both ? [...vWeightUp[v], ...vWeightDown[v]] : ws;
        if (!all.length) {
          target[i] = bx[v];
          weight[i] = 0.01;
          return;
        }
        // Weighted median-ish: weighted mean, robust enough with PAV.
        let sum = 0;
        let wsum = 0;
        all.forEach((u, k) => {
          sum += bx[u] * allW[k];
          wsum += allW[k];
        });
        target[i] = sum / wsum;
        weight[i] = wsum * (v >= n ? 1.5 : 1);
      });
      place(L, target, weight);
    }
  }

  // Normalise breadth and compute depth coordinates.
  let minB = Infinity;
  let maxB = -Infinity;
  for (let v = 0; v < vn; v++) {
    minB = Math.min(minB, bx[v] - vW[v] / 2);
    maxB = Math.max(maxB, bx[v] + vW[v] / 2);
  }
  if (!vn) minB = maxB = 0;
  const layerDepth = new Float64Array(layerCount);
  for (let i = 0; i < n; i++) layerDepth[layer[i]] = Math.max(layerDepth[layer[i]], dh[i]);
  const layerStart = new Float64Array(layerCount);
  for (let l = 1; l < layerCount; l++) layerStart[l] = layerStart[l - 1] + layerDepth[l - 1] + rankSep;
  const totalDepth = layerCount ? layerStart[layerCount - 1] + layerDepth[layerCount - 1] : 0;

  const cxv = (v: number) => bx[v] - minB;
  const cyv = (v: number) => layerStart[vLayer[v]] + (v < n ? dh[v] / 2 : layerDepth[vLayer[v]] / 2);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Centre nodes vertically within their layer band.
    const top = layerStart[layer[i]] + (layerDepth[layer[i]] - dh[i]) / 2;
    const left = cxv(i) - bw[i] / 2;
    if (tb) {
      x[i] = left;
      y[i] = top;
    } else {
      x[i] = top;
      y[i] = left;
    }
  }

  // Routes: port on the facing sides, through dummy positions.
  const pt = (b: number, d: number) => (tb ? [b, d] : [d, b]);
  const routes: number[][] = edges.map(() => []);
  for (let k = 0; k < dagFrom.length; k++) {
    const chain = chains[k];
    const a = chain[0];
    const b = chain[chain.length - 1];
    const pts: number[] = [];
    const aTop = layerStart[layer[a]] + (layerDepth[layer[a]] - dh[a]) / 2;
    const bTop = layerStart[layer[b]] + (layerDepth[layer[b]] - dh[b]) / 2;
    pts.push(...pt(cxv(a), aTop + dh[a]));
    for (let i = 1; i < chain.length - 1; i++) pts.push(...pt(cxv(chain[i]), cyv(chain[i])));
    pts.push(...pt(cxv(b), bTop));
    const inputIndex = dagOf[k];
    if (reversed[inputIndex]) {
      // Draw back edges from the original source upwards to the original target.
      const rev: number[] = [];
      for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
      routes[inputIndex] = rev;
    } else routes[inputIndex] = pts;
  }
  // Self loops: a small arc on the side.
  edges.forEach((e, k) => {
    if (e.from !== e.to) return;
    const i = e.from;
    const right = cxv(i) + bw[i] / 2;
    const top = layerStart[layer[i]] + (layerDepth[layer[i]] - dh[i]) / 2;
    routes[k] = [...pt(right, top + dh[i] * 0.3), ...pt(right + 24, top + dh[i] / 2), ...pt(right, top + dh[i] * 0.7)];
  });

  const breadth = maxB - minB;
  return { x, y, routes, reversed, layer, width: tb ? breadth : totalDepth, height: tb ? totalDepth : breadth };
}
