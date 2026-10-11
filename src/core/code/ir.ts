/**
 * A small language-neutral statement IR. Language specs describe which
 * tree-sitter node types are ifs, loops, switches… and the generic converter
 * below turns any function body into this IR, from which the control-flow
 * and data-flow builders work without knowing the source language.
 */

import { clean, field, fields, firstLine, headerText, isComment, named, unparen } from './syntax';
import type { SyntaxNode } from './treesitter';

export type LoopKind = 'for' | 'forEach' | 'while' | 'doWhile' | 'infinite';

export interface Case {
  label: string;
  body: Stmt[];
  isDefault: boolean;
  node?: SyntaxNode;
}

export interface Handler {
  label: string;
  body: Stmt[];
  node?: SyntaxNode;
}

export type Stmt =
  | { k: 'simple'; node: SyntaxNode; text: string; def?: boolean }
  | { k: 'if'; node: SyntaxNode; cond: string; condNode?: SyntaxNode | null; then: Stmt[]; else?: Stmt[] }
  | {
      k: 'loop';
      node: SyntaxNode;
      loop: LoopKind;
      header: string;
      headerNode?: SyntaxNode | null;
      body: Stmt[];
      else?: Stmt[];
      label?: string;
    }
  | { k: 'switch'; node: SyntaxNode; subject: string; subjectNode?: SyntaxNode | null; cases: Case[]; fallthrough: boolean; label?: string }
  | { k: 'try'; node: SyntaxNode; body: Stmt[]; handlers: Handler[]; else?: Stmt[]; finally?: Stmt[] }
  | { k: 'jump'; node: SyntaxNode; jump: 'return' | 'throw' | 'break' | 'continue' | 'fallthrough'; text: string; label?: string; valueNode?: SyntaxNode | null }
  | { k: 'block'; node: SyntaxNode; header: string; body: Stmt[] }
  | { k: 'labeled'; node: SyntaxNode; label: string; body: Stmt[] };

export interface SwitchShape {
  subject: SyntaxNode | null;
  cases: { label: string; body: SyntaxNode[]; isDefault: boolean; node?: SyntaxNode }[];
}

export interface TryShape {
  body: SyntaxNode | null;
  handlers: { label: string; body: SyntaxNode | SyntaxNode[] | null; node?: SyntaxNode }[];
  else?: SyntaxNode | null;
  finally?: SyntaxNode | SyntaxNode[] | null;
}

export interface FlowRules {
  /** Nodes whose named children are statements. */
  blocks: string[];
  ifs: string[];
  /** Wrappers holding the else branch (`else_clause`, Ruby `else`). */
  elses: string[];
  /** Else-if nodes carrying their own condition (`elif_clause`, `elsif`, `else_if_clause`). */
  elifs?: string[];
  /** Negated ifs (Ruby `unless`). */
  unless?: string[];
  whiles: string[];
  doWhiles?: string[];
  fors: string[];
  forEachs?: string[];
  infinites?: string[];
  switches: string[];
  tries: string[];
  returns: string[];
  throws: string[];
  breaks: string[];
  continues: string[];
  fallthroughs?: string[];
  /** Statements that wrap a body with a header (`with`, `using`, `lock`, `synchronized`, `unsafe`). */
  withs?: string[];
  labeled?: string[];
  /** Wrappers to look through when they hold a control-flow expression (Rust/PHP `expression_statement`). */
  exprStatements?: string[];
  /** Nested definitions, shown as a single `def` statement. */
  definitions: string[];
  /** C-family switch fallthrough between cases. */
  fallthrough: boolean;
  switchShape(node: SyntaxNode): SwitchShape;
  tryShape(node: SyntaxNode): TryShape;
  /** Refines loop kind for grammars with one loop node (Go `for`). */
  loopKind?(node: SyntaxNode, base: LoopKind): LoopKind;
  /** Language-specific statements; return undefined to fall back to the generic rules. */
  special?(node: SyntaxNode, conv: IRConverter): Stmt[] | undefined;
  /** Treat the final expression of a function body as an implicit return (Rust). */
  implicitReturn?: (node: SyntaxNode) => boolean;
}

export class IRConverter {
  private readonly sets: Record<string, Set<string>>;
  private readonly control = new Set<string>();

  constructor(readonly rules: FlowRules) {
    const mk = (xs?: string[]) => new Set(xs ?? []);
    this.sets = {
      blocks: mk(rules.blocks),
      ifs: mk(rules.ifs),
      elses: mk(rules.elses),
      elifs: mk(rules.elifs),
      unless: mk(rules.unless),
      whiles: mk(rules.whiles),
      doWhiles: mk(rules.doWhiles),
      fors: mk(rules.fors),
      forEachs: mk(rules.forEachs),
      infinites: mk(rules.infinites),
      switches: mk(rules.switches),
      tries: mk(rules.tries),
      returns: mk(rules.returns),
      throws: mk(rules.throws),
      breaks: mk(rules.breaks),
      continues: mk(rules.continues),
      fallthroughs: mk(rules.fallthroughs),
      withs: mk(rules.withs),
      labeled: mk(rules.labeled),
      exprStatements: mk(rules.exprStatements),
      definitions: mk(rules.definitions),
    };
    for (const k of ['ifs', 'unless', 'whiles', 'doWhiles', 'fors', 'forEachs', 'infinites', 'switches', 'tries', 'returns', 'throws', 'breaks', 'continues', 'fallthroughs', 'withs', 'labeled']) {
      for (const t of this.sets[k]) this.control.add(t);
    }
  }

  is(kind: keyof FlowRules & string, type: string): boolean {
    return this.sets[kind]?.has(type) ?? false;
  }

  isControl(type: string): boolean {
    return this.control.has(type);
  }

  /** Converts a function body (block or single expression). */
  body(node: SyntaxNode | null): Stmt[] {
    if (!node) return [];
    const out = this.stmts(node);
    const imp = this.rules.implicitReturn;
    if (imp && this.is('blocks', node.type)) {
      const kids = named(node).filter((c) => !isComment(c));
      const last = kids[kids.length - 1];
      if (last && imp(last) && out.length && out[out.length - 1].k === 'simple' && out[out.length - 1].node.id === last.id) {
        out[out.length - 1] = { k: 'jump', node: last, jump: 'return', text: `return ${firstLine(last, 70)}`, valueNode: last };
      }
    } else if (!this.is('blocks', node.type) && out.length === 1 && out[0].k === 'simple') {
      // Expression-bodied function (`x => x + 1`, `def f = expr`): the value is returned.
      out[0] = { k: 'jump', node, jump: 'return', text: `return ${firstLine(node, 70)}`, valueNode: node };
    }
    return out;
  }

  /** Statements of a block, or the single statement `node` as a list. */
  stmts(node: SyntaxNode | null | undefined): Stmt[] {
    if (!node) return [];
    if (this.is('blocks', node.type)) {
      const out: Stmt[] = [];
      for (const c of named(node)) if (!isComment(c)) out.push(...this.stmt(c));
      return out;
    }
    return this.stmt(node);
  }

  /** Statements from a list of sibling nodes. */
  list(nodes: SyntaxNode[]): Stmt[] {
    const out: Stmt[] = [];
    for (const c of nodes) if (!isComment(c)) out.push(...this.stmts(c));
    return out;
  }

  simple(node: SyntaxNode, def = false): Stmt {
    return { k: 'simple', node, text: firstLine(node), def };
  }

  stmt(node: SyntaxNode): Stmt[] {
    const t = node.type;
    const special = this.rules.special?.(node, this);
    if (special) return special;
    if (this.is('blocks', t)) return this.stmts(node);
    if (this.is('exprStatements', t)) {
      const inner = named(node).filter((c) => !isComment(c));
      if (inner.length === 1 && this.isControl(inner[0].type)) return this.stmt(inner[0]);
      return [this.simple(node)];
    }
    if (this.is('ifs', t) || this.is('unless', t)) return [this.ifStmt(node, this.is('unless', t))];
    if (this.is('whiles', t)) return [this.loop(node, 'while')];
    if (this.is('doWhiles', t)) return [this.loop(node, 'doWhile')];
    if (this.is('fors', t)) return [this.loop(node, 'for')];
    if (this.is('forEachs', t)) return [this.loop(node, 'forEach')];
    if (this.is('infinites', t)) return [this.loop(node, 'infinite')];
    if (this.is('switches', t)) return [this.switchStmt(node)];
    if (this.is('tries', t)) return [this.tryStmt(node)];
    if (this.is('returns', t)) return [this.jump(node, 'return')];
    if (this.is('throws', t)) return [this.jump(node, 'throw')];
    if (this.is('breaks', t)) return [this.jump(node, 'break')];
    if (this.is('continues', t)) return [this.jump(node, 'continue')];
    if (this.is('fallthroughs', t)) return [this.jump(node, 'fallthrough')];
    if (this.is('withs', t)) {
      const body = field(node, 'body') ?? lastBlockChild(node, this);
      return [{ k: 'block', node, header: headerText(node, body), body: this.stmts(body) }];
    }
    if (this.is('labeled', t)) {
      const label = (field(node, 'label') ?? named(node)[0])?.text.replace(/[:']/g, '') ?? '';
      const body = field(node, 'body') ?? named(node).filter((c) => c.text.replace(/[:']/g, '') !== label).pop() ?? null;
      return [{ k: 'labeled', node, label, body: this.stmts(body) }];
    }
    if (this.is('definitions', t)) return [this.simple(node, true)];
    return [this.simple(node)];
  }

  jump(node: SyntaxNode, jump: 'return' | 'throw' | 'break' | 'continue' | 'fallthrough', text?: string): Stmt {
    const kidsNamed = named(node).filter((c) => !isComment(c));
    let label: string | undefined;
    if (jump === 'break' || jump === 'continue') {
      const l = field(node, 'label') ?? kidsNamed.find((c) => /label|identifier/.test(c.type));
      if (l) label = l.text.replace(/^'/, '');
    }
    const valueNode = jump === 'return' || jump === 'throw' ? (kidsNamed[0] ?? null) : null;
    return { k: 'jump', node, jump, text: text ?? firstLine(node, 80), label, valueNode };
  }

  ifStmt(node: SyntaxNode, negated = false): Stmt {
    const condNode = field(node, 'condition');
    const thenNode = field(node, 'consequence') ?? field(node, 'body');
    const alts = fields(node, 'alternative');
    let cond = condNode ? unparen(clean(conditionText(condNode))) : headerText(node, thenNode).replace(/^(if|unless)\s*/, '');
    if (negated) cond = `not (${cond})`;
    return {
      k: 'if',
      node,
      cond,
      condNode,
      then: this.stmts(thenNode),
      else: this.alternatives(alts),
    };
  }

  private alternatives(alts: SyntaxNode[]): Stmt[] | undefined {
    if (!alts.length) return undefined;
    const [first, ...rest] = alts;
    if (this.is('elifs', first.type)) {
      const condNode = field(first, 'condition');
      const body = field(first, 'consequence') ?? field(first, 'body');
      const nested = [...fields(first, 'alternative'), ...rest];
      return [
        {
          k: 'if',
          node: first,
          cond: condNode ? unparen(clean(conditionText(condNode))) : headerText(first, body),
          condNode,
          then: this.stmts(body),
          else: this.alternatives(nested),
        },
      ];
    }
    if (this.is('elses', first.type)) {
      const body = field(first, 'body');
      if (body) return this.stmts(body);
      const inner = named(first).filter((c) => !isComment(c));
      if (inner.length === 1 && (this.is('ifs', inner[0].type) || this.is('blocks', inner[0].type))) return this.stmts(inner[0]);
      return this.list(inner);
    }
    return this.stmts(first);
  }

  loop(node: SyntaxNode, base: LoopKind): Stmt {
    const kind = this.rules.loopKind ? this.rules.loopKind(node, base) : base;
    const body = field(node, 'body') ?? lastBlockChild(node, this);
    const elseNode = field(node, 'alternative');
    let header: string;
    let headerNode: SyntaxNode | null = null;
    if (kind === 'doWhile') {
      headerNode = field(node, 'condition');
      header = `while ${headerNode ? unparen(clean(headerNode.text)) : '…'}`;
    } else {
      header = headerText(node, body);
      headerNode = field(node, 'condition') ?? field(node, 'right') ?? field(node, 'value');
    }
    return {
      k: 'loop',
      node,
      loop: kind,
      header,
      headerNode,
      body: this.stmts(body),
      else: elseNode ? this.alternatives([elseNode]) : undefined,
    };
  }

  switchStmt(node: SyntaxNode): Stmt {
    const shape = this.rules.switchShape(node);
    const cases: Case[] = shape.cases.map((c) => ({
      label: c.label,
      isDefault: c.isDefault,
      node: c.node,
      body: this.list(c.body),
    }));
    return {
      k: 'switch',
      node,
      subject: shape.subject ? unparen(clean(conditionText(shape.subject))) : headerText(node, null),
      subjectNode: shape.subject,
      cases,
      fallthrough: this.rules.fallthrough,
    };
  }

  tryStmt(node: SyntaxNode): Stmt {
    const shape = this.rules.tryShape(node);
    const toStmts = (b: SyntaxNode | SyntaxNode[] | null | undefined) => (Array.isArray(b) ? this.list(b) : this.stmts(b));
    return {
      k: 'try',
      node,
      body: toStmts(shape.body),
      handlers: shape.handlers.map((h) => ({ label: h.label, body: toStmts(h.body), node: h.node })),
      else: shape.else ? this.stmts(shape.else) : undefined,
      finally: shape.finally ? toStmts(shape.finally) : undefined,
    };
  }
}

/** Unwraps C++ `condition_clause` and similar holders. */
function conditionText(node: SyntaxNode): string {
  if (node.type === 'condition_clause') {
    const v = field(node, 'value');
    const init = field(node, 'initializer');
    if (v) return init ? `${init.text} ${v.text}` : v.text;
  }
  return node.text;
}

function lastBlockChild(node: SyntaxNode, conv: IRConverter): SyntaxNode | null {
  const ns = named(node);
  for (let i = ns.length - 1; i >= 0; i--) if (conv.is('blocks', ns[i].type)) return ns[i];
  return null;
}

// ---------------------------------------------------------------- generic shapes

/**
 * Generic switch shape for grammars where cases are children (possibly
 * inside a body node) carrying `value` fields and statement children.
 */
export function genericSwitch(
  node: SyntaxNode,
  opts: {
    subjectFields?: string[];
    bodyField?: string;
    caseTypes: string[];
    defaultTypes?: string[];
    /** Child types that are labels rather than statements (patterns, `switch_label`). */
    labelTypes?: string[];
    labelFields?: string[];
  },
): SwitchShape {
  const subject = (opts.subjectFields ?? ['value', 'condition', 'subject']).map((f) => field(node, f)).find(Boolean) ?? null;
  const body = field(node, opts.bodyField ?? 'body') ?? node;
  const caseSet = new Set(opts.caseTypes);
  const defSet = new Set(opts.defaultTypes ?? []);
  const labelTypes = new Set(opts.labelTypes ?? []);
  const labelFields = opts.labelFields ?? ['value', 'pattern', 'label'];
  const cases: SwitchShape['cases'] = [];
  for (const c of named(body)) {
    if (!caseSet.has(c.type) && !defSet.has(c.type)) continue;
    const labels: string[] = [];
    const labelNodes = new Set<number>();
    for (const f of labelFields) {
      for (const ln of fields(c, f)) {
        labels.push(clean(ln.text, 40));
        labelNodes.add(ln.id);
      }
    }
    for (const k of named(c)) {
      if (labelTypes.has(k.type) && !labelNodes.has(k.id)) {
        labels.push(clean(k.text.replace(/^(case|default)\b\s*/, '').replace(/:\s*$/, ''), 40));
        labelNodes.add(k.id);
      }
    }
    const isDefault = defSet.has(c.type) || /^\s*default\b/.test(c.text) || labels.some((l) => l === '_' || l === 'else');
    const stmts = named(c).filter((k) => !labelNodes.has(k.id) && !isComment(k));
    cases.push({ label: isDefault && !labels.length ? 'default' : labels.join(', ') || 'case', body: stmts, isDefault, node: c });
  }
  return { subject, cases };
}

/** Generic try shape: `body` field + catch/finally/else children. */
export function genericTry(
  node: SyntaxNode,
  opts: { catchTypes: string[]; finallyTypes: string[]; elseTypes?: string[]; handlerBodyFields?: string[] },
): TryShape {
  const body = field(node, 'body');
  const catchSet = new Set(opts.catchTypes);
  const finSet = new Set(opts.finallyTypes);
  const elseSet = new Set(opts.elseTypes ?? []);
  const handlers: TryShape['handlers'] = [];
  let fin: SyntaxNode | SyntaxNode[] | null = null;
  let els: SyntaxNode | null = null;
  for (const c of named(node)) {
    if (catchSet.has(c.type)) {
      const hb = (opts.handlerBodyFields ?? ['body']).map((f) => field(c, f)).find(Boolean) ?? lastStatementBlock(c);
      handlers.push({ label: headerText(c, hb, 60) || 'catch', body: hb, node: c });
    } else if (finSet.has(c.type)) {
      fin = field(c, 'body') ?? lastStatementBlock(c) ?? named(c);
    } else if (elseSet.has(c.type)) {
      els = field(c, 'body') ?? c;
    }
  }
  return { body, handlers, finally: fin, else: els };
}

function lastStatementBlock(node: SyntaxNode): SyntaxNode | null {
  const ns = named(node);
  for (let i = ns.length - 1; i >= 0; i--) if (/block|statement|body|then/.test(ns[i].type)) return ns[i];
  return null;
}
