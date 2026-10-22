/** Builds a control-flow graph (flowchart) from the statement IR. */

import type { FlowEdge, FlowEdgeKind, FlowGraph, FlowNode, FlowNodeKind, Range } from './model';
import type { Stmt } from './ir';
import { clean, rangeOf } from './syntax';

interface Pending {
  from: number;
  kind: FlowEdgeKind;
  label?: string;
  /** Leaves a `finally` block on behalf of a jump (see `mergeRouted`). */
  routed?: boolean;
}

interface BreakTarget {
  label?: string;
  pending: Pending[];
  isSwitch: boolean;
  /** A labeled block: only `break label` leaves it. */
  labelOnly?: boolean;
  /** Number of enclosing try frames: a jump here passes the `finally` blocks of the frames above. */
  frames: number;
}

interface ContinueTarget {
  label?: string;
  node: number;
  frames: number;
}

/** Where an abrupt exit is headed. */
type Exit = { k: 'return' } | { k: 'throw' } | { k: 'break'; target: BreakTarget } | { k: 'continue'; target: ContinueTarget };

/** A `finally` block that abrupt exits run on their way out. */
interface Finally {
  /** Edges into the block from jumps. */
  entries: Pending[];
  /** Where those jumps go after the block, one entry per target. */
  exits: Exit[];
}

/** A try statement around the code being built. */
interface Frame {
  /** Catch nodes that a `throw` in the try body jumps to. */
  catches?: number[];
  fin?: Finally;
}

interface Ctx {
  breaks: BreakTarget[];
  continues: ContinueTarget[];
  /** Enclosing try statements, innermost last. */
  frames: Frame[];
  /** Set by `fallthrough` jumps (Go) for the enclosing switch. */
  fallthrough?: Pending[];
  pendingLabel?: string;
}

const MAX_BLOCK_LINES = 6;
const EXIT_EDGE: Record<Exit['k'], FlowEdgeKind> = { return: 'return', throw: 'exception', break: 'break', continue: 'continue' };

export interface CfgOptions {
  name: string;
  symbolId: string;
  signature?: string;
  range: Range;
  /** Cyclomatic complexity, counted on the syntax tree (`complexity()` in spec.ts) so outline and flow agree. */
  complexity: number;
}

export function buildFlowGraph(body: Stmt[], opts: CfgOptions): FlowGraph {
  return new CfgBuilder(opts).build(body);
}

class CfgBuilder {
  private nodes: FlowNode[] = [];
  private edges: FlowEdge[] = [];
  private edgeKeys = new Set<string>();
  /** Edges that carry a jump out of a `finally` block. */
  private routed = new Set<FlowEdge>();
  private end = -1;
  /** Last block node that may absorb following simple statements. */
  private openBlock = -1;
  /** First node of each labeled statement, and the `goto`s waiting for them. */
  private labels = new Map<string, number>();
  private gotos: { from: number; label?: string }[] = [];

  constructor(private readonly opts: CfgOptions) {}

  build(body: Stmt[]): FlowGraph {
    const start = this.node('start', this.opts.name + (this.opts.signature ? clean(this.opts.signature, 60) : ''), this.opts.range);
    this.end = this.node('end', 'end');
    const exits = this.seq(body, [{ from: start, kind: 'normal' }], { breaks: [], continues: [], frames: [] });
    this.connect(exits, this.end);
    this.resolveGotos();
    this.mergeRouted();
    this.markUnreachable(start);
    // Keep `end` last so it reads naturally in lists and layouts.
    return {
      name: this.opts.name,
      symbolId: this.opts.symbolId,
      signature: this.opts.signature,
      nodes: this.nodes,
      edges: this.edges,
      complexity: this.opts.complexity,
      range: this.opts.range,
    };
  }

  private node(kind: FlowNodeKind, label: string, range?: Range, lines?: string[]): number {
    const id = this.nodes.length;
    this.nodes.push({ id, kind, label, range, lines });
    this.openBlock = -1;
    return id;
  }

  private edge(from: number, to: number, kind: FlowEdgeKind, label?: string, routed?: boolean): void {
    const key = `${from}>${to}:${kind}:${label ?? ''}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    const e: FlowEdge = { from, to, kind, label };
    this.edges.push(e);
    if (routed) this.routed.add(e);
  }

  private connect(pending: Pending[], to: number): void {
    for (const p of pending) this.edge(p.from, to, p.kind, p.label, p.routed);
  }

  private seq(stmts: Stmt[], pending: Pending[], ctx: Ctx): Pending[] {
    let cur = pending;
    for (const s of stmts) cur = this.stmt(s, cur, ctx);
    return cur;
  }

  private stmt(s: Stmt, pending: Pending[], ctx: Ctx): Pending[] {
    switch (s.k) {
      case 'simple': {
        const text = s.def ? `def ${s.text}` : s.text;
        const p = pending[0];
        if (pending.length === 1 && p.kind === 'normal' && !p.label && p.from === this.openBlock) {
          const n = this.nodes[p.from];
          if ((n.lines?.length ?? 0) < MAX_BLOCK_LINES) {
            n.lines!.push(text);
            n.label = n.lines![0];
            if (n.range) n.range = { start: n.range.start, end: rangeOf(s.node).end };
            return pending;
          }
        }
        const id = this.node('block', text, rangeOf(s.node), [text]);
        this.connect(pending, id);
        this.openBlock = id;
        return [{ from: id, kind: 'normal' }];
      }

      case 'if': {
        const d = this.node('decision', s.cond, rangeOf(s.condNode ?? s.node));
        this.connect(pending, d);
        const thenExits = this.seq(s.then, [{ from: d, kind: 'true', label: 'yes' }], ctx);
        const elseExits = s.else ? this.seq(s.else, [{ from: d, kind: 'false', label: 'no' }], ctx) : [{ from: d, kind: 'false' as const, label: 'no' }];
        return [...thenExits, ...elseExits];
      }

      case 'loop':
        return this.loop(s, pending, ctx);

      case 'switch':
        return this.switchStmt(s, pending, ctx);

      case 'try':
        return this.tryStmt(s, pending, ctx);

      case 'block': {
        const id = this.node('block', s.header, rangeOf(s.node), [s.header]);
        this.connect(pending, id);
        this.openBlock = -1;
        return this.seq(s.body, [{ from: id, kind: 'normal' }], ctx);
      }

      case 'labeled':
        return this.labeled(s, pending, ctx);

      case 'check': {
        // `expr?`: goes on with the value, or returns the error right away.
        const d = this.node('decision', s.text, rangeOf(s.node));
        this.connect(pending, d);
        this.exit([{ from: d, kind: 'return', label: s.fail }], { k: 'return' }, ctx);
        return [{ from: d, kind: 'true', label: 'ok' }];
      }

      case 'jump':
        return this.jump(s, pending, ctx);
    }
  }

  private labeled(s: Extract<Stmt, { k: 'labeled' }>, pending: Pending[], ctx: Ctx): Pending[] {
    // A label is a jump target, so it starts a node of its own.
    this.openBlock = -1;
    const first = this.nodes.length;
    const [only] = s.body;
    let exits: Pending[];
    if (!s.body.length) {
      // A bare label (`end:`): an anchor for `goto`.
      const id = this.node('merge', `${s.label}:`, rangeOf(s.node));
      this.connect(pending, id);
      exits = [{ from: id, kind: 'normal' }];
    } else if (s.body.length === 1 && (only.k === 'loop' || only.k === 'switch')) {
      exits = this.stmt(only, pending, { ...ctx, pendingLabel: s.label });
    } else {
      // A labeled block: `break label` leaves it.
      const brk: BreakTarget = { label: s.label, pending: [], isSwitch: false, labelOnly: true, frames: ctx.frames.length };
      exits = [...this.seq(s.body, pending, { ...ctx, pendingLabel: undefined, breaks: [...ctx.breaks, brk] }), ...brk.pending];
    }
    if (!this.labels.has(s.label)) this.labels.set(s.label, this.nodes.length > first ? first : this.end);
    return exits;
  }

  private jump(s: Extract<Stmt, { k: 'jump' }>, pending: Pending[], ctx: Ctx): Pending[] {
    switch (s.jump) {
      case 'return': {
        const id = this.node('return', s.text, rangeOf(s.node));
        this.connect(pending, id);
        this.exit([{ from: id, kind: 'return' }], { k: 'return' }, ctx);
        return [];
      }
      case 'throw': {
        const id = this.node('throw', s.text, rangeOf(s.node));
        this.connect(pending, id);
        this.exit([{ from: id, kind: 'exception' }], { k: 'throw' }, ctx);
        return [];
      }
      case 'break': {
        // An unlabeled break leaves the innermost loop or switch, never a labeled block.
        const target = [...ctx.breaks].reverse().find((t) => (s.label ? t.label === s.label : !t.labelOnly));
        const id = this.node('jump', s.label ? `break ${s.label}` : 'break', rangeOf(s.node));
        this.connect(pending, id);
        if (target) this.exit([{ from: id, kind: 'break' }], { k: 'break', target }, ctx);
        return [];
      }
      case 'continue': {
        const loops = ctx.continues;
        const target = s.label ? [...loops].reverse().find((t) => t.label === s.label) : loops[loops.length - 1];
        // Keep the language's keyword (`continue`, Ruby `next`) without punctuation.
        const word = /^[A-Za-z_]+/.exec(s.text)?.[0] ?? 'continue';
        const id = this.node('jump', s.label ? `${word} ${s.label}` : word, rangeOf(s.node));
        this.connect(pending, id);
        if (target) this.exit([{ from: id, kind: 'continue' }], { k: 'continue', target }, ctx);
        return [];
      }
      case 'fallthrough': {
        const id = this.node('jump', 'fallthrough', rangeOf(s.node));
        this.connect(pending, id);
        if (ctx.fallthrough) ctx.fallthrough.push({ from: id, kind: 'normal' });
        return [];
      }
      case 'goto': {
        // Labels may come later in the function: resolved once the whole body is built.
        const id = this.node('jump', s.label ? `goto ${s.label}` : clean(s.text, 40), rangeOf(s.node));
        this.connect(pending, id);
        this.gotos.push({ from: id, label: s.label });
        return [];
      }
    }
  }

  /**
   * Sends `from` on to an abrupt exit's target. A `throw` stops at the innermost catch clauses;
   * on the way, every enclosing `finally` runs first: the jump enters the block and the block's
   * exits continue to the target (see `tryStmt`).
   */
  private exit(from: Pending[], ex: Exit, ctx: Ctx): void {
    const floor = ex.k === 'break' || ex.k === 'continue' ? ex.target.frames : 0;
    for (let i = ctx.frames.length - 1; i >= floor; i--) {
      const f = ctx.frames[i];
      if (f.catches && ex.k === 'throw') {
        for (const c of f.catches) for (const p of from) this.edge(p.from, c, p.kind, p.label ?? 'caught', p.routed);
        return;
      }
      if (f.fin) {
        f.fin.entries.push(...from);
        if (!f.fin.exits.some((e) => sameExit(e, ex))) f.fin.exits.push(ex);
        return;
      }
    }
    switch (ex.k) {
      case 'return':
        this.connect(from, this.end);
        return;
      case 'throw':
        for (const p of from) this.edge(p.from, this.end, p.kind, p.label ?? 'throws', p.routed);
        return;
      case 'break':
        ex.target.pending.push(...from);
        return;
      case 'continue':
        this.connect(from, ex.target.node);
        return;
    }
  }

  private loop(s: Extract<Stmt, { k: 'loop' }>, pending: Pending[], ctx: Ctx): Pending[] {
    const label = ctx.pendingLabel ?? s.label;
    const frames = ctx.frames.length;
    const brk: BreakTarget = { label, pending: [], isSwitch: false, frames };
    const range = rangeOf(s.node);

    if (s.loop === 'doWhile') {
      const entry = this.node('loop', 'do', range);
      this.connect(pending, entry);
      const cond = this.node('decision', s.header, s.headerNode ? rangeOf(s.headerNode) : range);
      const inner: Ctx = { ...ctx, pendingLabel: undefined, breaks: [...ctx.breaks, brk], continues: [...ctx.continues, { label, node: cond, frames }] };
      const bodyExits = this.seq(s.body, [{ from: entry, kind: 'normal' }], inner);
      this.connect(bodyExits, cond);
      this.edge(cond, entry, 'back', 'yes');
      return [{ from: cond, kind: 'false', label: 'no' }, ...brk.pending];
    }

    const headerLabel = s.loop === 'infinite' && !s.header ? 'loop' : s.header;
    const head = this.node('loop', headerLabel, range);
    this.connect(pending, head);
    const inner: Ctx = { ...ctx, pendingLabel: undefined, breaks: [...ctx.breaks, brk], continues: [...ctx.continues, { label, node: head, frames }] };
    const enter = s.loop === 'forEach' ? 'each' : s.loop === 'infinite' ? undefined : 'yes';
    const bodyExits = this.seq(s.body, [{ from: head, kind: s.loop === 'infinite' ? 'normal' : 'true', label: enter }], inner);
    for (const e of bodyExits) this.edge(e.from, head, 'back', e.label);
    if (s.loop === 'infinite') {
      // Only `break` leaves it, so a Python `else:` clause never runs.
      if (s.else) this.seq(s.else, [], ctx);
      return brk.pending;
    }
    let exits: Pending[] = [{ from: head, kind: 'false', label: s.loop === 'forEach' ? 'done' : 'no' }];
    if (s.else) exits = this.seq(s.else, exits, ctx);
    return [...exits, ...brk.pending];
  }

  private switchStmt(s: Extract<Stmt, { k: 'switch' }>, pending: Pending[], ctx: Ctx): Pending[] {
    const d = this.node('switch', s.subject, rangeOf(s.subjectNode ?? s.node));
    this.connect(pending, d);
    const brk: BreakTarget = { label: ctx.pendingLabel, pending: [], isSwitch: true, frames: ctx.frames.length };

    // Merge empty fall-through cases into the next one: `case 1: case 2: …`.
    const cases: { label: string; body: Stmt[]; isDefault: boolean }[] = [];
    let carry: string[] = [];
    let carryDefault = false;
    for (const c of s.cases) {
      if (s.fallthrough && c.body.length === 0) {
        carry.push(c.label);
        carryDefault ||= c.isDefault;
        continue;
      }
      cases.push({ label: [...carry, c.label].join(', '), body: c.body, isDefault: c.isDefault || carryDefault });
      carry = [];
      carryDefault = false;
    }
    if (carry.length) cases.push({ label: carry.join(', '), body: [], isDefault: carryDefault });

    const exits: Pending[] = [];
    let fall: Pending[] = [];
    let hasDefault = false;
    for (const c of cases) {
      hasDefault ||= c.isDefault;
      const ftTarget: Pending[] = [];
      const inner: Ctx = { ...ctx, pendingLabel: undefined, breaks: [...ctx.breaks, brk], fallthrough: ftTarget };
      const entry: Pending[] = [{ from: d, kind: 'case', label: c.label }, ...fall];
      const caseExits = this.seq(c.body, entry, inner);
      if (s.fallthrough) {
        fall = caseExits;
      } else {
        exits.push(...caseExits);
        fall = ftTarget;
      }
    }
    exits.push(...fall, ...brk.pending);
    if (!hasDefault) exits.push({ from: d, kind: 'case', label: 'otherwise' });
    return exits;
  }

  private tryStmt(s: Extract<Stmt, { k: 'try' }>, pending: Pending[], ctx: Ctx): Pending[] {
    const t = this.node('try', 'try', rangeOf(s.node));
    this.connect(pending, t);
    const catchNodes = s.handlers.map((h) => this.node('catch', h.label, h.node ? rangeOf(h.node) : undefined));
    for (const c of catchNodes) this.edge(t, c, 'exception', 'on error');
    // Jumps out of the body, the catch clauses and `else` run the finally block first;
    // only throws from the body reach the catch clauses.
    const fin: Finally | undefined = s.finally ? { entries: [], exits: [] } : undefined;
    const guarded: Ctx = fin ? { ...ctx, frames: [...ctx.frames, { fin }] } : ctx;
    const inner: Ctx = catchNodes.length ? { ...guarded, frames: [...guarded.frames, { catches: catchNodes }] } : guarded;
    let exits = this.seq(s.body, [{ from: t, kind: 'normal' }], inner);
    if (s.else) exits = this.seq(s.else, exits, guarded);
    s.handlers.forEach((h, i) => exits.push(...this.seq(h.body, [{ from: catchNodes[i], kind: 'normal' }], guarded)));
    if (!fin || !s.finally) return exits;
    const f = this.node('finally', 'finally');
    this.connect(exits, f);
    this.connect(fin.entries, f);
    const finExits = this.seq(s.finally, [{ from: f, kind: 'normal' }], ctx);
    // After the block, each jump goes on to its own target, labelled with its kind.
    for (const ex of fin.exits) {
      const onward = finExits.map((p) => ({ from: p.from, kind: EXIT_EDGE[ex.k], label: p.label ? `${p.label}, ${ex.k}` : ex.k, routed: true }));
      this.exit(onward, ex, ctx);
    }
    // The block's last node also leads elsewhere: what follows must not merge into it.
    if (fin.exits.length) this.openBlock = -1;
    return exits.length ? finExits : [];
  }

  /** Links each `goto` to its label's statement (an unknown label ends the function). */
  private resolveGotos(): void {
    for (const g of this.gotos) {
      const to = (g.label !== undefined ? this.labels.get(g.label) : undefined) ?? this.end;
      // Forward jumps read like `break`, backward ones like `continue` (they form a loop).
      this.edge(g.from, to, to === this.end || to > g.from ? 'break' : 'continue');
    }
  }

  /**
   * A finally block's onward jumps can run parallel to its normal exit (both reach `end`, or the
   * loop head) or to each other: keep one edge per pair of nodes.
   */
  private mergeRouted(): void {
    if (!this.routed.size) return;
    const pairs = new Map<string, FlowEdge[]>();
    for (const e of this.edges) {
      const key = `${e.from}>${e.to}`;
      const list = pairs.get(key);
      if (list) list.push(e);
      else pairs.set(key, [e]);
    }
    const drop = new Set<FlowEdge>();
    for (const list of pairs.values()) {
      const routed = list.filter((e) => this.routed.has(e));
      if (!routed.length || list.length < 2) continue;
      if (routed.length < list.length) {
        for (const e of routed) drop.add(e);
        continue;
      }
      routed[0].label = [...new Set(routed.map((e) => e.label).filter(Boolean))].join(' / ') || undefined;
      for (const e of routed.slice(1)) drop.add(e);
    }
    if (drop.size) this.edges = this.edges.filter((e) => !drop.has(e));
  }

  private markUnreachable(start: number): void {
    const out = new Map<number, number[]>();
    for (const e of this.edges) {
      const a = out.get(e.from);
      if (a) a.push(e.to);
      else out.set(e.from, [e.to]);
    }
    const seen = new Uint8Array(this.nodes.length);
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const n = stack.pop()!;
      for (const m of out.get(n) ?? []) {
        if (!seen[m]) {
          seen[m] = 1;
          stack.push(m);
        }
      }
    }
    for (const n of this.nodes) if (!seen[n.id] && n.kind !== 'end') n.unreachable = true;
  }
}

function sameExit(a: Exit, b: Exit): boolean {
  if (a.k !== b.k) return false;
  if (a.k === 'break' || a.k === 'continue') return a.target === (b as typeof a).target;
  return true;
}
