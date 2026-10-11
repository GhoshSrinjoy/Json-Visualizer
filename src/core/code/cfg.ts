/** Builds a control-flow graph (flowchart) from the statement IR. */

import type { FlowEdge, FlowEdgeKind, FlowGraph, FlowNode, FlowNodeKind, Range } from './model';
import type { Stmt } from './ir';
import { clean, rangeOf } from './syntax';

interface Pending {
  from: number;
  kind: FlowEdgeKind;
  label?: string;
}

interface BreakTarget {
  label?: string;
  pending: Pending[];
  isSwitch: boolean;
}

interface ContinueTarget {
  label?: string;
  node: number;
}

interface Ctx {
  breaks: BreakTarget[];
  continues: ContinueTarget[];
  /** Catch nodes that a `throw` inside a try body jumps to. */
  catchNodes?: number[];
  /** Set by `fallthrough` jumps (Go) for the enclosing switch. */
  fallthrough?: Pending[];
  pendingLabel?: string;
}

const MAX_BLOCK_LINES = 6;

export interface CfgOptions {
  name: string;
  symbolId: string;
  signature?: string;
  range: Range;
}

export function buildFlowGraph(body: Stmt[], opts: CfgOptions): FlowGraph {
  return new CfgBuilder(opts).build(body);
}

class CfgBuilder {
  private nodes: FlowNode[] = [];
  private edges: FlowEdge[] = [];
  private edgeKeys = new Set<string>();
  private end = -1;
  private decisions = 0;
  /** Last block node that may absorb following simple statements. */
  private openBlock = -1;

  constructor(private readonly opts: CfgOptions) {}

  build(body: Stmt[]): FlowGraph {
    const start = this.node('start', this.opts.name + (this.opts.signature ? clean(this.opts.signature, 60) : ''), this.opts.range);
    this.end = this.node('end', 'end');
    const exits = this.seq(body, [{ from: start, kind: 'normal' }], { breaks: [], continues: [] });
    this.connect(exits, this.end);
    this.markUnreachable(start);
    // Keep `end` last so it reads naturally in lists and layouts.
    return {
      name: this.opts.name,
      symbolId: this.opts.symbolId,
      signature: this.opts.signature,
      nodes: this.nodes,
      edges: this.edges,
      complexity: this.decisions + 1,
      range: this.opts.range,
    };
  }

  private node(kind: FlowNodeKind, label: string, range?: Range, lines?: string[]): number {
    const id = this.nodes.length;
    this.nodes.push({ id, kind, label, range, lines });
    this.openBlock = -1;
    return id;
  }

  private edge(from: number, to: number, kind: FlowEdgeKind, label?: string): void {
    const key = `${from}>${to}:${kind}:${label ?? ''}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push({ from, to, kind, label });
  }

  private connect(pending: Pending[], to: number): void {
    for (const p of pending) this.edge(p.from, to, p.kind, p.label);
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
        this.decisions += 1 + countBoolOps(s.cond);
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

      case 'labeled': {
        return this.seq(s.body, pending, { ...ctx, pendingLabel: s.label });
      }

      case 'jump':
        return this.jump(s, pending, ctx);
    }
  }

  private jump(s: Extract<Stmt, { k: 'jump' }>, pending: Pending[], ctx: Ctx): Pending[] {
    switch (s.jump) {
      case 'return': {
        const id = this.node('return', s.text, rangeOf(s.node));
        this.connect(pending, id);
        this.edge(id, this.end, 'return');
        return [];
      }
      case 'throw': {
        const id = this.node('throw', s.text, rangeOf(s.node));
        this.connect(pending, id);
        if (ctx.catchNodes?.length) for (const c of ctx.catchNodes) this.edge(id, c, 'exception', 'caught');
        else this.edge(id, this.end, 'exception', 'throws');
        return [];
      }
      case 'break': {
        const target = s.label ? [...ctx.breaks].reverse().find((t) => t.label === s.label) : ctx.breaks[ctx.breaks.length - 1];
        const id = this.node('jump', s.label ? `break ${s.label}` : 'break', rangeOf(s.node));
        this.connect(pending, id);
        if (target) target.pending.push({ from: id, kind: 'break' });
        return [];
      }
      case 'continue': {
        const loops = ctx.continues;
        const target = s.label ? [...loops].reverse().find((t) => t.label === s.label) : loops[loops.length - 1];
        // Keep the language's keyword (`continue`, Ruby `next`) without punctuation.
        const word = /^[A-Za-z_]+/.exec(s.text)?.[0] ?? 'continue';
        const id = this.node('jump', s.label ? `${word} ${s.label}` : word, rangeOf(s.node));
        this.connect(pending, id);
        if (target) this.edge(id, target.node, 'continue');
        return [];
      }
      case 'fallthrough': {
        const id = this.node('jump', 'fallthrough', rangeOf(s.node));
        this.connect(pending, id);
        if (ctx.fallthrough) ctx.fallthrough.push({ from: id, kind: 'normal' });
        return [];
      }
    }
  }

  private loop(s: Extract<Stmt, { k: 'loop' }>, pending: Pending[], ctx: Ctx): Pending[] {
    const label = ctx.pendingLabel ?? s.label;
    const brk: BreakTarget = { label, pending: [], isSwitch: false };
    const range = rangeOf(s.node);
    this.decisions += s.loop === 'infinite' ? 0 : 1;

    if (s.loop === 'doWhile') {
      const entry = this.node('loop', 'do', range);
      this.connect(pending, entry);
      const cond = this.node('decision', s.header, s.headerNode ? rangeOf(s.headerNode) : range);
      const inner: Ctx = { ...ctx, pendingLabel: undefined, breaks: [...ctx.breaks, brk], continues: [...ctx.continues, { label, node: cond }] };
      const bodyExits = this.seq(s.body, [{ from: entry, kind: 'normal' }], inner);
      this.connect(bodyExits, cond);
      this.edge(cond, entry, 'back', 'yes');
      return [{ from: cond, kind: 'false', label: 'no' }, ...brk.pending];
    }

    const headerLabel = s.loop === 'infinite' && !s.header ? 'loop' : s.header;
    const head = this.node('loop', headerLabel, range);
    this.connect(pending, head);
    const inner: Ctx = { ...ctx, pendingLabel: undefined, breaks: [...ctx.breaks, brk], continues: [...ctx.continues, { label, node: head }] };
    const enter = s.loop === 'forEach' ? 'each' : s.loop === 'infinite' ? undefined : 'yes';
    const bodyExits = this.seq(s.body, [{ from: head, kind: s.loop === 'infinite' ? 'normal' : 'true', label: enter }], inner);
    for (const e of bodyExits) this.edge(e.from, head, 'back', e.label);
    if (s.loop === 'infinite') return brk.pending;
    let exits: Pending[] = [{ from: head, kind: 'false', label: s.loop === 'forEach' ? 'done' : 'no' }];
    if (s.else) exits = this.seq(s.else, exits, ctx);
    return [...exits, ...brk.pending];
  }

  private switchStmt(s: Extract<Stmt, { k: 'switch' }>, pending: Pending[], ctx: Ctx): Pending[] {
    const d = this.node('switch', s.subject, rangeOf(s.subjectNode ?? s.node));
    this.connect(pending, d);
    const brk: BreakTarget = { label: ctx.pendingLabel, pending: [], isSwitch: true };

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
      if (!c.isDefault) this.decisions++;
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
    this.decisions += catchNodes.length;
    for (const c of catchNodes) this.edge(t, c, 'exception', 'on error');
    const inner: Ctx = { ...ctx, catchNodes: catchNodes.length ? catchNodes : ctx.catchNodes };
    let exits = this.seq(s.body, [{ from: t, kind: 'normal' }], inner);
    if (s.else) exits = this.seq(s.else, exits, ctx);
    s.handlers.forEach((h, i) => exits.push(...this.seq(h.body, [{ from: catchNodes[i], kind: 'normal' }], ctx)));
    if (s.finally) {
      const f = this.node('finally', 'finally');
      this.connect(exits, f);
      exits = this.seq(s.finally, [{ from: f, kind: 'normal' }], ctx);
    }
    return exits;
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

function countBoolOps(cond: string): number {
  const m = cond.match(/&&|\|\||\band\b|\bor\b/g);
  return m ? m.length : 0;
}
