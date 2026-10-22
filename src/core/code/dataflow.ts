/**
 * Intra-procedural data flow: which values flow into which variables, calls
 * and the return value. Deliberately readable rather than SSA-precise — one
 * node per variable, edges labelled with the lines where the flow happens.
 *
 *   const raw = await readFile(file)   file → readFile() → raw
 *   result.push(user)                  user ⟶(push) result
 *   this.name = name                   name → this.name
 *   return result                      result → return
 */

import type { Stmt } from './ir';
import type { DataEdge, DataEdgeKind, DataFlowGraph, DataNode, DataNodeKind, Range } from './model';
import { callInfo, type LanguageSpec } from './spec';
import { clean, field, named } from './syntax';
import type { SyntaxNode } from './treesitter';

const RETURN = 'ret';
const SKIP_TARGET_FIELDS = new Set(['type', 'key', 'default', 'default_value']);
const THROW = 'throw';

interface Target {
  id: string;
  kind: DataEdgeKind;
}

export interface DataFlowOptions {
  name: string;
  symbolId: string;
  range: Range;
}

export function buildDataFlow(
  fnNode: SyntaxNode,
  bodyNode: SyntaxNode | null,
  body: Stmt[],
  spec: LanguageSpec,
  opts: DataFlowOptions,
): DataFlowGraph {
  const b = new DataFlowBuilder(spec, spec.params(fnNode));
  if (bodyNode) b.collectDefs(bodyNode);
  b.stmts(body);
  return b.result(opts);
}

class DataFlowBuilder {
  private readonly nodes = new Map<string, DataNode>();
  private readonly edges = new Map<string, DataEdge>();
  private readonly params: Set<string>;
  private readonly locals = new Set<string>();
  private readonly idents: Set<string>;
  private readonly skip: Set<string>;
  private readonly fnTypes: Set<string>;
  private readonly self: Set<string>;
  private readonly bodyFields: Set<string>;
  /** Names bound by enclosing lambdas/comprehensions (with nesting counts). */
  private readonly shadow = new Map<string, number>();

  constructor(
    private readonly spec: LanguageSpec,
    params: string[],
  ) {
    const d = spec.data;
    this.params = new Set(params);
    this.idents = new Set(d.identifiers);
    this.skip = new Set(d.skip);
    this.fnTypes = new Set(spec.functionTypes);
    this.self = new Set(d.selfNames);
    this.bodyFields = new Set(d.bodyFields ?? ['body', 'consequence', 'alternative']);
    for (const p of params) this.node(`p:${p}`, 'param', p);
  }

  // ------------------------------------------------------------ pass 1: definitions

  collectDefs(body: SyntaxNode): void {
    const visit = (n: SyntaxNode) => {
      for (const c of named(n)) {
        if (this.fnTypes.has(c.type)) continue;
        const a = this.spec.data.assigns[c.type] ?? this.spec.data.loopBindings?.[c.type];
        if (a) {
          const t = a.target(c);
          if (t) for (const name of this.patternNames(t)) if (!this.params.has(name)) this.locals.add(name);
        }
        visit(c);
      }
    };
    visit(body);
  }

  // ------------------------------------------------------------ pass 2: statements

  stmts(list: Stmt[] | undefined): void {
    if (!list) return;
    for (const s of list) this.stmt(s);
  }

  private stmt(s: Stmt): void {
    switch (s.k) {
      case 'simple':
        if (!s.def) this.effects(s.node);
        return;
      case 'if':
        if (s.condNode) this.reads(s.condNode);
        this.stmts(s.then);
        this.stmts(s.else);
        return;
      case 'loop': {
        const binding = this.spec.data.loopBindings?.[s.node.type];
        const line = s.node.startPosition.row;
        if (binding) {
          const src = binding.value(s.node);
          const tgt = binding.target(s.node);
          if (src && tgt) this.flowInto(src, this.targets(tgt, 'iterate'), line);
        } else this.headerEffects(s.node);
        this.stmts(s.body);
        this.stmts(s.else);
        return;
      }
      case 'switch':
        if (s.subjectNode) this.reads(s.subjectNode);
        for (const c of s.cases) this.stmts(c.body);
        return;
      case 'try':
        this.stmts(s.body);
        for (const h of s.handlers) this.stmts(h.body);
        this.stmts(s.else);
        this.stmts(s.finally);
        return;
      case 'jump':
        if ((s.jump === 'return' || s.jump === 'throw') && s.valueNode) {
          const id = s.jump === 'return' ? RETURN : THROW;
          this.node(id, 'return', s.jump);
          this.flowInto(s.valueNode, [{ id, kind: 'return' }], s.node.startPosition.row);
        }
        return;
      case 'block':
        this.headerEffects(s.node);
        this.stmts(s.body);
        return;
      case 'labeled':
        this.stmts(s.body);
        return;
      case 'check':
        // `expr?`: the statement that follows carries the expression's flows.
        return;
    }
  }

  /** Header expressions of compound statements (C `for` init/update, `with` items…). */
  private headerEffects(node: SyntaxNode): void {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (!c || !c.isNamed) continue;
      const f = node.fieldNameForChild(i);
      if (f && this.bodyFields.has(f)) continue;
      if (/block|body|statement_list|compound_statement|declaration_list/.test(c.type)) continue;
      this.effects(c);
    }
  }

  /** Assignments and calls made by a statement-level node. */
  private effects(node: SyntaxNode): void {
    const line = node.startPosition.row;
    const a = this.spec.data.assigns[node.type];
    if (a) {
      const t = a.target(node);
      const v = a.value(node);
      if (t && v) this.flowInto(v, this.targets(t, 'assign'), line);
      return;
    }
    if (this.spec.calls[node.type]) {
      this.call(node, [], line, true);
      return;
    }
    if (this.fnTypes.has(node.type)) return;
    for (const c of named(node)) this.effects(c);
  }

  /** Records reads without a destination (conditions). */
  private reads(node: SyntaxNode): void {
    const line = node.startPosition.row;
    this.flowInto(node, [], line);
  }

  // ------------------------------------------------------------ expressions

  private flowInto(expr: SyntaxNode, targets: Target[], line: number): void {
    const t = expr.type;
    const scope = this.spec.data.scopes?.[t];
    if (scope) {
      // Lambda/comprehension: analyse the body with its own bindings hidden.
      const bound = scope(expr);
      for (const n of bound) this.shadow.set(n, (this.shadow.get(n) ?? 0) + 1);
      try {
        for (const c of named(expr)) this.flowInto(c, targets, line);
      } finally {
        for (const n of bound) {
          const k = this.shadow.get(n)! - 1;
          if (k) this.shadow.set(n, k);
          else this.shadow.delete(n);
        }
      }
      return;
    }
    if (this.fnTypes.has(t) || this.skip.has(t)) return;
    const assign = this.spec.data.assigns[t];
    if (assign) {
      // Chained assignment `a = b = c`: c flows to b, and to the outer targets.
      const inner = assign.target(expr);
      const v = assign.value(expr);
      const innerTargets = inner ? this.targets(inner, 'assign') : [];
      if (v) this.flowInto(v, [...innerTargets, ...targets], line);
      return;
    }
    if (this.spec.calls[t]) {
      this.call(expr, targets, line, false);
      return;
    }
    const member = this.spec.data.members[t];
    if (member) {
      const ref = this.memberRef(expr);
      if (ref) this.read(ref, targets, line);
      else {
        const obj = field(expr, member.object);
        if (obj) this.flowInto(obj, targets, line);
      }
      // Index expressions also read their index (`a[i]`).
      for (const k of ['index', 'subscript']) {
        const idx = field(expr, k);
        if (idx) this.flowInto(idx, targets, line);
      }
      return;
    }
    if (this.idents.has(t)) {
      const ref = this.identRef(expr);
      if (ref) this.read(ref, targets, line);
      return;
    }
    for (let i = 0; i < expr.childCount; i++) {
      const c = expr.child(i);
      if (!c || !c.isNamed) continue;
      const f = expr.fieldNameForChild(i);
      if (f === 'type' || f === 'key' || (f === 'name' && /pair|keyword_argument|named_argument/.test(t))) continue;
      this.flowInto(c, targets, line);
    }
  }

  private call(node: SyntaxNode, targets: Target[], line: number, statementLevel: boolean): void {
    const info = callInfo(node, this.spec);
    const args = info?.argsNode ?? field(node, 'arguments');
    if (!info) {
      if (args) this.flowInto(args, targets, line);
      return;
    }
    const recvRef = this.receiverRef(info.receiver);
    const recvIsVar = recvRef && (recvRef.kind === 'local' || recvRef.kind === 'param' || recvRef.kind === 'field');
    if (statementLevel && recvIsVar && targets.length === 0) {
      // `result.push(user)`: arguments mutate the receiver.
      const id = this.ensure(recvRef!);
      if (args) this.flowInto(args, [{ id, kind: 'mutate' }], line);
      this.use(id, line);
      return;
    }
    const prefix = info.kind === 'new' ? 'new ' : '';
    const recvLabel = info.receiver && !recvIsVar ? `${info.receiver}.` : recvIsVar ? `${recvRef!.label}.` : '';
    const label = `${prefix}${recvLabel}${info.name}${info.kind === 'macro' ? '!' : ''}()`;
    const id = `c:${label}`;
    this.node(id, 'call', clean(label, 48));
    if (recvIsVar) this.edge(this.ensure(recvRef!), id, 'arg', line);
    if (args) this.flowInto(args, [{ id, kind: 'arg' }], line);
    for (const t of targets) this.edge(id, t.id, t.kind === 'assign' ? 'result' : t.kind, line);
  }

  // ------------------------------------------------------------ references

  private identRef(n: SyntaxNode): { id: string; kind: DataNodeKind; label: string } | null {
    const raw = n.text;
    if (this.self.has(raw)) return null;
    const name = raw.replace(/^\$/, '');
    if (this.shadow.has(name)) return null;
    if (!name || /^[0-9]/.test(name)) return null;
    if (n.type === 'instance_variable' || name.startsWith('@')) return { id: `f:${name}`, kind: 'field', label: name };
    if (this.params.has(name)) return { id: `p:${name}`, kind: 'param', label: name };
    if (this.locals.has(name)) return { id: `v:${name}`, kind: 'local', label: name };
    if (/^(true|false|null|nil|None|undefined|True|False|NULL|nullptr)$/.test(name)) return null;
    return { id: `x:${name}`, kind: 'external', label: name };
  }

  /** `this.x` / `self.x` -> field node; otherwise the root object. */
  private memberRef(n: SyntaxNode): { id: string; kind: DataNodeKind; label: string } | null {
    const m = this.spec.data.members[n.type];
    if (!m) return null;
    const obj = field(n, m.object);
    const prop = field(n, m.property);
    if (obj && prop && this.self.has(obj.text)) {
      const label = `${obj.text}.${prop.text.replace(/^\$/, '')}`;
      return { id: `f:${label}`, kind: 'field', label };
    }
    if (!obj) return null;
    if (this.idents.has(obj.type)) return this.identRef(obj);
    if (this.spec.data.members[obj.type]) return this.memberRef(obj);
    return null;
  }

  private receiverRef(receiver?: string): { id: string; kind: DataNodeKind; label: string } | null {
    if (!receiver) return null;
    const self = [...this.self].find((s) => receiver.startsWith(`${s}.`) || receiver.startsWith(`${s}->`));
    if (self) {
      const label = receiver.replace('->', '.');
      return { id: `f:${label}`, kind: 'field', label };
    }
    const root = receiver.replace(/^\$/, '').split(/[.\[(]|->|::/)[0];
    if (this.params.has(root)) return { id: `p:${root}`, kind: 'param', label: root };
    if (this.locals.has(root)) return { id: `v:${root}`, kind: 'local', label: root };
    return null;
  }

  private read(ref: { id: string; kind: DataNodeKind; label: string }, targets: Target[], line: number): void {
    const id = this.ensure(ref);
    this.use(id, line);
    for (const t of targets) if (t.id !== id || t.kind === 'mutate') this.edge(id, t.id, t.kind, line);
  }

  // ------------------------------------------------------------ targets

  private targets(node: SyntaxNode, kind: DataEdgeKind): Target[] {
    const out: Target[] = [];
    const line = node.startPosition.row;
    const add = (ref: { id: string; kind: DataNodeKind; label: string } | null, k: DataEdgeKind) => {
      if (!ref) return;
      const id = this.ensure(ref);
      this.def(id, line);
      out.push({ id, kind: k });
    };
    const visit = (n: SyntaxNode) => {
      if (this.skip.has(n.type)) return;
      const member = this.spec.data.members[n.type];
      if (member) {
        const ref = this.memberRef(n);
        // `obj.x = v` mutates obj; `this.x = v` defines a field.
        add(ref, ref?.kind === 'field' ? kind : 'mutate');
        return;
      }
      if (this.idents.has(n.type)) {
        add(this.identRef(n), kind);
        return;
      }
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (!c || !c.isNamed) continue;
        const f = n.fieldNameForChild(i);
        if (f && SKIP_TARGET_FIELDS.has(f)) continue;
        // Defaults in patterns (`{ a = 1 }`, `x=1` params) are values, not targets.
        if ((f === 'right' || f === 'value') && /pattern|default/.test(n.type)) continue;
        visit(c);
      }
    };
    visit(node);
    return out;
  }

  private patternNames(node: SyntaxNode): string[] {
    const names: string[] = [];
    const visit = (n: SyntaxNode) => {
      if (this.skip.has(n.type) || this.spec.data.members[n.type]) return;
      if (this.idents.has(n.type)) {
        const t = n.text.replace(/^\$/, '');
        if (!this.self.has(n.text) && !t.startsWith('@')) names.push(t);
        return;
      }
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (!c || !c.isNamed) continue;
        const f = n.fieldNameForChild(i);
        if (f === 'type' || f === 'key') continue;
        visit(c);
      }
    };
    visit(node);
    return names;
  }

  // ------------------------------------------------------------ graph

  private node(id: string, kind: DataNodeKind, label: string): DataNode {
    let n = this.nodes.get(id);
    if (!n) {
      n = { id, kind, label, defs: [], uses: [] };
      this.nodes.set(id, n);
    }
    return n;
  }

  private ensure(ref: { id: string; kind: DataNodeKind; label: string }): string {
    this.node(ref.id, ref.kind, ref.label);
    return ref.id;
  }

  private def(id: string, line: number): void {
    const n = this.nodes.get(id);
    if (n && !n.defs.includes(line)) n.defs.push(line);
  }

  private use(id: string, line: number): void {
    const n = this.nodes.get(id);
    if (n && !n.uses.includes(line)) n.uses.push(line);
  }

  private edge(from: string, to: string, kind: DataEdgeKind, line: number): void {
    if (from === to) return;
    const key = `${from}>${to}:${kind}`;
    const e = this.edges.get(key);
    if (e) {
      if (!e.lines.includes(line)) e.lines.push(line);
      return;
    }
    this.edges.set(key, { from, to, kind, lines: [line] });
  }

  result(opts: DataFlowOptions): DataFlowGraph {
    const connected = new Set<string>();
    for (const e of this.edges.values()) {
      connected.add(e.from);
      connected.add(e.to);
    }
    const nodes = [...this.nodes.values()].filter((n) => n.kind === 'param' || connected.has(n.id));
    return { name: opts.name, symbolId: opts.symbolId, range: opts.range, nodes, edges: [...this.edges.values()] };
  }
}
