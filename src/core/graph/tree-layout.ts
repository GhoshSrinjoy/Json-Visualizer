/**
 * Tidy tree layout for variable-sized nodes in linear time
 * (A. J. van der Ploeg, "Drawing Non-layered Tidy Trees in Linear Time",
 * 2014), implemented iteratively so deep trees cannot overflow the stack.
 *
 * Works in an internal top-to-bottom frame ("breadth" = x, "depth" = y) and
 * maps to left-to-right on output. `layered` aligns every depth into one
 * column (cleanest for data graphs); otherwise children start right after
 * their parent (most compact).
 */

export interface TreeLayoutInput {
  /** Node sizes in output (screen) orientation. */
  width: ArrayLike<number>;
  height: ArrayLike<number>;
  /** children[i] = child indices of node i, in order. */
  children: ArrayLike<ArrayLike<number> | undefined>;
  root: number;
}

export interface TreeLayoutOptions {
  direction?: 'LR' | 'TB';
  /** Gap between parent and child (along the depth axis). */
  levelGap?: number;
  /** Gap between siblings / neighbouring subtrees. */
  siblingGap?: number;
  layered?: boolean;
}

export interface TreeLayoutResult {
  /** Top-left corners in output orientation. */
  x: Float64Array;
  y: Float64Array;
  width: number;
  height: number;
}

/** Linked list of left siblings and their lowest depth coordinate. */
interface IYL {
  lowY: number;
  index: number;
  nxt: IYL | null;
}

export function layoutTree(input: TreeLayoutInput, options: TreeLayoutOptions = {}): TreeLayoutResult {
  const n = input.width.length;
  const lr = (options.direction ?? 'LR') === 'LR';
  const levelGap = options.levelGap ?? 60;
  const siblingGap = options.siblingGap ?? 16;

  // Per-node state (internal frame: w = breadth extent incl. gap, h = depth extent incl. gap).
  const w = new Float64Array(n);
  const h = new Float64Array(n);
  const y = new Float64Array(n);
  const prelim = new Float64Array(n);
  const mod = new Float64Array(n);
  const shift = new Float64Array(n);
  const change = new Float64Array(n);
  const msel = new Float64Array(n);
  const mser = new Float64Array(n);
  const tl = new Int32Array(n).fill(-1);
  const tr = new Int32Array(n).fill(-1);
  const el = new Int32Array(n);
  const er = new Int32Array(n);
  const xs = new Float64Array(n);

  const kids = (i: number): ArrayLike<number> => input.children[i] ?? EMPTY;
  for (let i = 0; i < n; i++) {
    const bw = lr ? input.height[i] : input.width[i];
    const dh = lr ? input.width[i] : input.height[i];
    w[i] = bw + siblingGap;
    h[i] = dh + levelGap;
  }

  // Depth coordinates (pre-order) and post-order sequence.
  const order: number[] = [];
  const depthOf = new Int32Array(n);
  {
    const stack = [input.root];
    while (stack.length) {
      const t = stack.pop()!;
      order.push(t);
      const c = kids(t);
      for (let k = c.length - 1; k >= 0; k--) {
        depthOf[c[k]] = depthOf[t] + 1;
        stack.push(c[k]);
      }
    }
  }
  if (options.layered) {
    let maxDepth = 0;
    for (const t of order) maxDepth = Math.max(maxDepth, depthOf[t]);
    const col = new Float64Array(maxDepth + 1);
    for (const t of order) col[depthOf[t]] = Math.max(col[depthOf[t]], h[t]);
    const start = new Float64Array(maxDepth + 1);
    for (let d = 1; d <= maxDepth; d++) start[d] = start[d - 1] + col[d - 1];
    for (const t of order) {
      y[t] = start[depthOf[t]];
      h[t] = col[depthOf[t]];
    }
  } else {
    y[input.root] = 0;
    for (const t of order) {
      const c = kids(t);
      for (let k = 0; k < c.length; k++) y[c[k]] = y[t] + h[t];
    }
  }

  const bottom = (t: number) => y[t] + h[t];
  const nextLeft = (t: number) => (kids(t).length === 0 ? tl[t] : kids(t)[0]);
  const nextRight = (t: number) => {
    const c = kids(t);
    return c.length === 0 ? tr[t] : c[c.length - 1];
  };
  const setExtremes = (t: number) => {
    const c = kids(t);
    if (c.length === 0) {
      el[t] = t;
      er[t] = t;
      msel[t] = mser[t] = 0;
    } else {
      el[t] = el[c[0]];
      msel[t] = msel[c[0]];
      er[t] = er[c[c.length - 1]];
      mser[t] = mser[c[c.length - 1]];
    }
  };
  const distributeExtra = (t: number, i: number, si: number, dist: number) => {
    if (si !== i - 1) {
      const c = kids(t);
      const nr = i - si;
      shift[c[si + 1]] += dist / nr;
      shift[c[i]] -= dist / nr;
      change[c[i]] -= dist - dist / nr;
    }
  };
  const moveSubtree = (t: number, i: number, si: number, dist: number) => {
    const ci = kids(t)[i];
    mod[ci] += dist;
    msel[ci] += dist;
    mser[ci] += dist;
    distributeExtra(t, i, si, dist);
  };
  const setLeftThread = (t: number, i: number, cl: number, modsumcl: number) => {
    const c = kids(t);
    const li = el[c[0]];
    tl[li] = cl;
    const diff = modsumcl - mod[cl] - msel[c[0]];
    mod[li] += diff;
    prelim[li] -= diff;
    el[c[0]] = el[c[i]];
    msel[c[0]] = msel[c[i]];
  };
  const setRightThread = (t: number, i: number, sr: number, modsumsr: number) => {
    const c = kids(t);
    const ri = er[c[i]];
    tr[ri] = sr;
    const diff = modsumsr - mod[sr] - mser[c[i]];
    mod[ri] += diff;
    prelim[ri] -= diff;
    er[c[i]] = er[c[i - 1]];
    mser[c[i]] = mser[c[i - 1]];
  };
  const separate = (t: number, i: number, ihIn: IYL) => {
    let ih: IYL | null = ihIn;
    const c = kids(t);
    let sr = c[i - 1];
    let mssr = mod[sr];
    let cl = c[i];
    let mscl = mod[cl];
    while (sr >= 0 && cl >= 0) {
      if (ih && bottom(sr) > ih.lowY) ih = ih.nxt;
      const dist = mssr + prelim[sr] + w[sr] - (mscl + prelim[cl]);
      if (dist > 0) {
        mscl += dist;
        moveSubtree(t, i, ih ? ih.index : 0, dist);
      }
      const sy = bottom(sr);
      const cy = bottom(cl);
      if (sy <= cy) {
        sr = nextRight(sr);
        if (sr >= 0) mssr += mod[sr];
      }
      if (sy >= cy) {
        cl = nextLeft(cl);
        if (cl >= 0) mscl += mod[cl];
      }
    }
    if (sr < 0 && cl >= 0) setLeftThread(t, i, cl, mscl);
    else if (sr >= 0 && cl < 0) setRightThread(t, i, sr, mssr);
  };
  const updateIYL = (minY: number, i: number, ih: IYL | null): IYL => {
    while (ih && minY >= ih.lowY) ih = ih.nxt;
    return { lowY: minY, index: i, nxt: ih };
  };

  // First walk in post-order (children before parents).
  for (let k = order.length - 1; k >= 0; k--) {
    const t = order[k];
    const c = kids(t);
    if (c.length === 0) {
      setExtremes(t);
      continue;
    }
    let ih = updateIYL(bottom(el[c[0]]), 0, null);
    for (let i = 1; i < c.length; i++) {
      const minY = bottom(er[c[i]]);
      separate(t, i, ih);
      ih = updateIYL(minY, i, ih);
    }
    const first = c[0];
    const last = c[c.length - 1];
    prelim[t] = (prelim[first] + mod[first] + mod[last] + prelim[last] + w[last]) / 2 - w[t] / 2;
    setExtremes(t);
  }

  // Second walk in pre-order: absolute breadth coordinates.
  {
    const stack: [number, number][] = [[input.root, 0]];
    while (stack.length) {
      const [t, ms] = stack.pop()!;
      const modsum = ms + mod[t];
      xs[t] = prelim[t] + modsum;
      const c = kids(t);
      let d = 0;
      let delta = 0;
      for (let i = 0; i < c.length; i++) {
        d += shift[c[i]];
        delta += d + change[c[i]];
        mod[c[i]] += delta;
      }
      for (let i = c.length - 1; i >= 0; i--) stack.push([c[i], modsum]);
    }
  }

  // Normalise and map to output orientation.
  let minB = Infinity;
  let maxB = -Infinity;
  let maxD = 0;
  for (const t of order) {
    minB = Math.min(minB, xs[t]);
    maxB = Math.max(maxB, xs[t] + w[t] - siblingGap);
    maxD = Math.max(maxD, y[t] + (lr ? input.width[t] : input.height[t]));
  }
  const outX = new Float64Array(n);
  const outY = new Float64Array(n);
  for (const t of order) {
    const b = xs[t] - minB;
    if (lr) {
      outX[t] = y[t];
      outY[t] = b;
    } else {
      outX[t] = b;
      outY[t] = y[t];
    }
  }
  const breadth = order.length ? maxB - minB : 0;
  return { x: outX, y: outY, width: lr ? maxD : breadth, height: lr ? breadth : maxD };
}

const EMPTY: number[] = [];
