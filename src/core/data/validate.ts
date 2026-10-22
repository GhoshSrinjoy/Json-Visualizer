/**
 * JSON Schema validation over a DataTree: draft-04, -06, -07, 2019-09 and
 * 2020-12. Every error is pinned to the node that fails, so all input formats
 * (YAML, TOML, CSV…) validate alike and the UI can mark failing cards and
 * reveal the source. Each subschema compiles once, on first use, into a flat
 * plan; values are read straight from the columnar tree, never materialised.
 */

import { plural, truncate } from '../util/strings';
import { DataTree, F_ALIAS, F_NO_POS, F_SYNTHETIC, F_VAL_SYNTH, T_ARRAY, T_BOOLEAN, T_NULL, T_NUMBER, T_OBJECT, T_STRING } from './tree';

export interface ValidationError {
  /** Node the error is pinned to. */
  id: number;
  /** JSONPath of that node, e.g. `$.users[3].email`. */
  path: string;
  /** Failing keyword: `type`, `required`, `format`… */
  keyword: string;
  message: string;
  /** Keyword location in the schema: `#/properties/email/format`, or `uri#/…` inside a `$ref`'d document. */
  schemaPath: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /** Validation stopped at `maxErrors`: there are more errors. */
  truncated: boolean;
  /** Keywords present in the schema that are not checked. */
  unsupported: string[];
}

export interface ValidateOptions {
  /** Default 1000. */
  maxErrors?: number;
  /** Assert `format` (default true). Unknown formats always pass. */
  formats?: boolean;
  /**
   * Returns a `$ref`'d document (parsed JSON, or JSON text) by URI: absolute,
   * or relative to the root schema when that has no `$id`. Each URI is
   * requested once per schema.
   */
  resolve?: (uri: string) => unknown | undefined;
  /** Validate this node instead of the document. */
  rootId?: number;
}

/** Nested evaluations (a few stack frames each) before a branch is skipped as too deep. */
const MAX_DEPTH = 1000;
/** Every this many nested evaluations, a stack overflow (small worker stacks) is caught and only that branch skipped. */
const CHECKPOINT = 64;
/** In-place hops ($ref, allOf…) on one value before a `$ref` cycle is assumed. */
const MAX_IN_PLACE = 128;

/**
 * Validates a document against a JSON Schema (a plain JS value). Multi-document
 * YAML and JSON Lines are checked per document unless the schema describes an
 * array. Schemas are treated as immutable: compiled plans are cached per
 * schema object.
 */
export function validateTree(tree: DataTree, schema: unknown, options: ValidateOptions = {}): ValidationResult {
  const reg = registryFor(schema, options.resolve);
  const outer = rt;
  const r = (rt = runtime(tree, options));
  const at = options.rootId;
  try {
    for (const id of at === undefined ? documents(tree, reg) : at >= 0 && at < tree.count ? [at] : []) run(reg.root, id, undefined);
  } catch (e) {
    if (e instanceof RangeError) {
      // A stack overflow above the first checkpoint: keep what was found.
      const id = r.at >= 0 && r.tree === tree ? r.at : tree.root;
      r.pending.push({ id, path: tree.pathString(id), keyword: 'depth', message: 'too deeply nested to validate', schemaPath: '#' });
    } else if (e !== STOP) throw e;
  } finally {
    rt = outer;
  }
  for (const e of r.pending) {
    if (r.errors.length >= r.max) {
      r.truncated = true;
      break;
    }
    r.errors.push(e);
  }
  r.errors.sort((a, b) => a.id - b.id);
  const unsupported = [...reg.unsupported];
  if (reg.hasFormat && !r.formats) unsupported.push('format');
  return { valid: r.errors.length === 0, errors: r.errors, truncated: r.truncated, unsupported: unsupported.sort() };
}

/**
 * The document's own schema URI: a YAML `# yaml-language-server: $schema=…`
 * modeline, a TOML `#:schema …` directive or a root `$schema` key.
 */
export function schemaUriOf(tree: DataTree): string | undefined {
  const text = tree.text;
  if (tree.format === 'yaml') {
    for (let i = text.indexOf('yaml-language-server'); i >= 0; i = text.indexOf('yaml-language-server', i + 1)) {
      const end = text.indexOf('\n', i);
      const m = MODELINE.exec(text.slice(text.lastIndexOf('\n', i) + 1, end < 0 ? text.length : end));
      if (m) return m[1];
    }
  } else if (tree.format === 'toml') {
    const m = /^[ \t]*#:schema[ \t]+(\S+)/m.exec(text);
    if (m) return m[1];
  }
  let root = tree.root;
  if (tree.flags[root] & F_SYNTHETIC && tree.type[root] === T_ARRAY) root = tree.firstChild(root);
  if (root < 0 || tree.type[root] !== T_OBJECT) return undefined;
  for (let c = tree.firstChild(root); c >= 0; c = tree.nextSibling(c)) {
    if (tree.key(c) === '$schema' && tree.type[c] === T_STRING) return tree.stringValue(c).trim() || undefined;
  }
  return undefined;
}

const MODELINE = /^[ \t]*#[ \t]*yaml-language-server[ \t]*:.*?\$schema=(\S+)/;

/** Values to validate: each document of multi-document YAML / JSON Lines, minus empty YAML documents. */
function documents(tree: DataTree, reg: Registry): number[] {
  const root = tree.root;
  const many = tree.flags[root] & F_SYNTHETIC && tree.type[root] === T_ARRAY && !describesArray(reg.root, 0);
  const docs = many ? tree.children(root) : [root];
  return tree.format === 'yaml' ? docs.filter((id) => !(tree.type[id] === T_NULL && tree.flags[id] & F_NO_POS)) : docs;
}

function describesArray(n: SNode, hops: number): boolean {
  const p = n.plan ?? compile(n);
  if (p.bool !== undefined) return false;
  if (p.types) return (p.types & B_ARRAY) !== 0;
  const t = p.ref && hops < 8 ? target(n, p.ref) : null;
  return (t !== null && describesArray(t, hops + 1)) || (p.arr && !p.obj);
}

// ---------------------------------------------------------------- schema registry

/** 0: undeclared. 2020-12 rules apply, but legacy forms (`items` arrays, `dependencies`) are accepted too. */
type Draft = 0 | 4 | 6 | 7 | 2019 | 2020;

/** A schema resource (document root or `$id` scope), as tracked by the dynamic scope. */
interface Resource {
  root: unknown;
  /** `$dynamicAnchor` name -> schema. */
  dyn: Map<string, object> | undefined;
  /** The root has `$recursiveAnchor: true`. */
  recursive: boolean;
}

interface Meta {
  /** Base URI for `$ref` (no fragment); empty when the root schema has no `$id`. */
  base: string;
  /** Location for `schemaPath`. */
  loc: string;
  draft: Draft;
  res: Resource;
}

interface Located {
  value: unknown;
  meta: Meta;
}

/** Keywords whose value is one subschema, a list of them or a map of them. */
const ONE = ['additionalItems', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties', 'contentSchema', 'items'];
const LIST = ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'];
const MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'];
/** Assertions that are recognised but not checked. */
const UNCHECKED = ['contentEncoding', 'contentMediaType', 'contentSchema', 'disallow', 'divisibleBy', 'extends'];

const registries = new WeakMap<object, Registry>();

function registryFor(schema: unknown, resolve: ValidateOptions['resolve']): Registry {
  const cached = isObj(schema) ? registries.get(schema) : undefined;
  if (cached && cached.resolve === resolve) return cached;
  const reg = new Registry(schema, resolve);
  if (isObj(schema)) registries.set(schema, reg);
  return reg;
}

/** Schema documents by URI, their `$id`s and anchors, and one compiled node per subschema. */
class Registry {
  readonly root: SNode;
  readonly resources = new Map<string, Located>();
  readonly anchors = new Map<string, object>();
  readonly meta = new Map<object, Meta>();
  readonly unsupported = new Set<string>();
  hasFormat = false;
  private readonly nodes = new Map<object, SNode>();
  private readonly tried = new Set<string>();
  private readonly draft: Draft;

  constructor(
    schema: unknown,
    readonly resolve: ValidateOptions['resolve'],
  ) {
    this.draft = (isObj(schema) && draftOf(schema.$schema)) || 0;
    const doc = this.add(schema, '');
    this.root = this.node(doc.value, doc.meta);
  }

  /** Compiled node of a subschema (one per object; booleans get one per position). */
  node(value: unknown, meta: Meta, slot: Slot = 'any', kw = 'false', limit = 0): SNode {
    if (!isObj(value)) return { reg: this, schema: value, meta, plan: undefined, slot, kw, limit, shape: undefined };
    let n = this.nodes.get(value);
    if (!n) this.nodes.set(value, (n = { reg: this, schema: value, meta, plan: undefined, slot, kw, limit, shape: undefined }));
    return n;
  }

  nodeOf(value: object): SNode {
    return this.node(value, this.meta.get(value)!);
  }

  /** Resolves an absolute reference (URI and fragment), loading external documents on demand. */
  lookup(abs: string): Located | undefined {
    const h = abs.indexOf('#');
    const uri = h < 0 ? abs : abs.slice(0, h);
    const frag = h < 0 ? '' : abs.slice(h + 1);
    let doc = this.resources.get(uri);
    if (!doc && this.resolve && !this.tried.has(uri)) {
      this.tried.add(uri);
      let v: unknown;
      try {
        v = this.resolve(uri);
        if (typeof v === 'string') v = JSON.parse(v);
      } catch {
        v = undefined;
      }
      if (v !== undefined) doc = this.add(v, uri);
    }
    if (!doc || !frag) return doc;
    if (frag[0] === '/') return this.pointer(doc, frag);
    const a = this.anchors.get(`${doc.meta.base}#${unpct(frag)}`) ?? this.anchors.get(`${uri}#${unpct(frag)}`);
    return a ? { value: a, meta: this.meta.get(a)! } : undefined;
  }

  private pointer(doc: Located, frag: string): Located | undefined {
    let v = doc.value;
    let meta = doc.meta;
    for (const raw of frag.slice(1).split('/')) {
      const seg = unpct(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (Array.isArray(v)) v = /^(0|[1-9]\d*)$/.test(seg) ? v[+seg] : undefined;
      else v = isObj(v) && Object.hasOwn(v, seg) ? v[seg] : undefined;
      if (v === undefined) return undefined;
      meta = this.metaOf(v, meta, `/${esc(seg)}`);
    }
    return { value: v, meta };
  }

  /** Metadata of `v` (a child of a schema with metadata `parent` at `path`), derived and kept if the walk missed it. */
  metaOf(v: unknown, parent: Meta, path: string): Meta {
    let meta = isObj(v) ? this.meta.get(v) : undefined;
    if (!meta) {
      meta = derive(parent, path, v);
      if (isObj(v)) this.meta.set(v, meta);
    }
    return meta;
  }

  /** Registers a document: its `$id`s, anchors and the metadata of every subschema. */
  private add(doc: unknown, uri: string): Located {
    const draft = (isObj(doc) && draftOf(doc.$schema)) || this.draft;
    const top: Resource = { root: doc, dyn: undefined, recursive: false };
    const stack: [unknown, string, string, Draft, Resource][] = [[doc, uri, `${uri}#`, draft, top]];
    while (stack.length) {
      const [v, parentBase, loc, parentDraft, parentRes] = stack.pop()!;
      if (!isObj(v) || this.meta.has(v)) continue;
      const d = draftOf(v.$schema) ?? parentDraft;
      // Before 2019-09, `$ref` makes every sibling keyword (`$id` included) ignored.
      const refOnly = (d === 4 || d === 6 || d === 7) && typeof v.$ref === 'string';
      let base = parentBase;
      let res = parentRes;
      if (!refOnly) {
        const id = d === 4 ? v.id : v.$id;
        if (typeof id === 'string' && id) {
          if (id[0] === '#') this.anchors.set(base + id, v);
          else {
            const abs = resolveUri(base, id);
            const h = abs.indexOf('#');
            base = h < 0 ? abs : abs.slice(0, h);
            if (h >= 0 && h + 1 < abs.length && abs[h + 1] !== '/') this.anchors.set(abs, v);
            if (v !== doc) res = { root: v, dyn: undefined, recursive: false };
          }
        }
        if (typeof v.$anchor === 'string' && (d === 0 || d >= 2019)) this.anchors.set(`${base}#${v.$anchor}`, v);
        if (typeof v.$dynamicAnchor === 'string' && (d === 0 || d === 2020)) {
          this.anchors.set(`${base}#${v.$dynamicAnchor}`, v);
          (res.dyn ??= new Map()).set(v.$dynamicAnchor, v);
        }
        if (v.$recursiveAnchor === true && res.root === v && (d === 0 || d === 2019)) res.recursive = true;
      }
      const meta: Meta = { base, loc, draft: d, res };
      this.meta.set(v, meta);
      if (res.root === v && !this.resources.has(base)) this.resources.set(base, { value: v, meta });
      if (refOnly) continue;
      for (const k of UNCHECKED) if (k in v) this.unsupported.add(k);
      if (typeof v.format === 'string') {
        this.hasFormat = true;
        if (!Object.hasOwn(FORMATS, v.format)) this.unsupported.add(`format "${v.format}"`);
      }
      for (const k of ONE) if (isObj(v[k])) stack.push([v[k], base, `${loc}/${k}`, d, res]);
      for (const k of LIST) {
        const list = v[k];
        if (Array.isArray(list)) list.forEach((x, i) => stack.push([x, base, `${loc}/${k}/${i}`, d, res]));
      }
      for (const k of MAP) {
        const map = v[k];
        if (isObj(map)) for (const key of Object.keys(map)) stack.push([map[key], base, `${loc}/${k}/${esc(key)}`, d, res]);
      }
    }
    const located: Located = { value: doc, meta: (isObj(doc) && this.meta.get(doc)) || { base: uri, loc: `${uri}#`, draft, res: top } };
    if (!this.resources.has(uri)) this.resources.set(uri, located);
    return located;
  }
}

/** Metadata of a subschema the registry walk did not reach (inside an unknown keyword, or a boolean). */
function derive(m: Meta, path: string, v: unknown): Meta {
  let base = m.base;
  let res = m.res;
  const id = isObj(v) ? (m.draft === 4 ? v.id : v.$id) : undefined;
  if (isObj(v) && typeof id === 'string' && id && id[0] !== '#') {
    base = resolveUri(base, id).replace(/#.*$/s, '');
    res = { root: v, dyn: undefined, recursive: v.$recursiveAnchor === true };
  }
  return { base, loc: m.loc + path, draft: (isObj(v) && draftOf(v.$schema)) || m.draft, res };
}

function draftOf(uri: unknown): Draft | undefined {
  if (typeof uri !== 'string') return undefined;
  const m = /draft-0?(\d)\b|draft\/(\d{4})-/.exec(uri);
  if (!m) return undefined;
  if (m[2]) return m[2] === '2019' ? 2019 : 2020;
  const n = +m[1];
  return n <= 5 ? 4 : n === 6 ? 6 : 7;
}

// ---------------------------------------------------------------- compiled plans

/** Where a `false` schema sits; picks its error message. */
type Slot = 'any' | 'prop' | 'additional' | 'unevaluated' | 'item' | 'extra' | 'unevaluatedItem';

interface SNode {
  reg: Registry;
  schema: unknown;
  meta: Meta;
  plan: Plan | undefined;
  slot: Slot;
  /** Keyword reported for a `false` schema. */
  kw: string;
  /** Tuple length, for `false` additional-item messages. */
  limit: number;
  shape: Shape | undefined;
}

interface Ref {
  kind: '$ref' | '$dynamicRef' | '$recursiveRef';
  ref: string;
  abs: string;
  /** Static target: undefined until resolved, null when unresolvable. */
  node: SNode | null | undefined;
  /** `$dynamicRef` landing on a `$dynamicAnchor` of this name: re-resolved in the dynamic scope. */
  dyn: string | undefined;
  /** `$recursiveRef` landing on `$recursiveAnchor: true`. */
  recursive: boolean;
}

interface Pattern {
  src: string;
  re: RegExp | undefined;
  error: string;
}

interface KeyRule {
  node: SNode | undefined;
  /** Index in `required`, or -1. */
  bit: number;
}

interface Enum {
  values: unknown[];
  strs: Set<string>;
  nums: Set<number>;
  /** 1: false, 2: true. */
  bools: number;
  nul: boolean;
  others: unknown[];
  msg: string;
}

/** Types a branch accepts and its constant properties: picks the anyOf/oneOf branch a value was meant for. */
interface Shape {
  types: number;
  disc: [string, unknown][];
}

interface Plan {
  /** Boolean schema. */
  bool: boolean | undefined;
  /** Draft-04…07 `$ref`: siblings are ignored. */
  refOnly: boolean;
  ref: Ref | undefined;
  dyn: Ref | undefined;
  types: number;
  typeMsg: string;
  hasConst: boolean;
  constVal: unknown;
  constMsg: string;
  enumVals: Enum | undefined;
  num: boolean;
  multipleOf: number | undefined;
  minimum: number | undefined;
  maximum: number | undefined;
  exMin: number | undefined;
  exMax: number | undefined;
  str: boolean;
  minLength: number | undefined;
  maxLength: number | undefined;
  pattern: Pattern | undefined;
  format: ((s: string) => boolean) | undefined;
  formatName: string;
  arr: boolean;
  minItems: number | undefined;
  maxItems: number | undefined;
  tuple: SNode[] | undefined;
  rest: SNode | undefined;
  contains: SNode | undefined;
  containsKw: string;
  minContains: number;
  maxContains: number | undefined;
  unique: boolean;
  uItems: SNode | undefined;
  obj: boolean;
  /** Any per-property work: properties, required, patterns, additionalProperties, names, dependencies. */
  iterate: boolean;
  minProps: number | undefined;
  maxProps: number | undefined;
  keys: Map<string, KeyRule> | undefined;
  required: string[] | undefined;
  patterns: [Pattern, SNode][] | undefined;
  additional: SNode | undefined;
  names: SNode | undefined;
  depReq: [string, string[], string][] | undefined;
  depSchemas: [string, SNode][] | undefined;
  uProps: SNode | undefined;
  apply: boolean;
  allOf: SNode[] | undefined;
  anyOf: SNode[] | undefined;
  oneOf: SNode[] | undefined;
  not: SNode | undefined;
  if: SNode | undefined;
  then: SNode | undefined;
  else: SNode | undefined;
}

const B_OBJECT = 1;
const B_ARRAY = 2;
const B_STRING = 4;
const B_INTEGER = 8;
const B_NUMBER = 16;
const B_BOOLEAN = 32;
const B_NULL = 64;
/** An empty intersection of types. */
const B_NEVER = 128;
const TYPE_BITS: Record<string, number> = {
  object: B_OBJECT,
  array: B_ARRAY,
  string: B_STRING,
  integer: B_INTEGER,
  number: B_NUMBER | B_INTEGER,
  boolean: B_BOOLEAN,
  null: B_NULL,
};
const TYPE_ORDER: [string, number][] = [['object', B_OBJECT], ['array', B_ARRAY], ['string', B_STRING], ['number', B_NUMBER], ['integer', B_INTEGER], ['boolean', B_BOOLEAN], ['null', B_NULL]];

function newPlan(): Plan {
  return {
    bool: undefined, refOnly: false, ref: undefined, dyn: undefined, types: 0, typeMsg: '', hasConst: false, constVal: undefined, constMsg: '',
    enumVals: undefined, num: false, multipleOf: undefined, minimum: undefined, maximum: undefined, exMin: undefined, exMax: undefined,
    str: false, minLength: undefined, maxLength: undefined, pattern: undefined, format: undefined, formatName: '',
    arr: false, minItems: undefined, maxItems: undefined, tuple: undefined, rest: undefined, contains: undefined, containsKw: 'contains',
    minContains: 1, maxContains: undefined, unique: false, uItems: undefined,
    obj: false, iterate: false, minProps: undefined, maxProps: undefined, keys: undefined, required: undefined, patterns: undefined,
    additional: undefined, names: undefined, depReq: undefined, depSchemas: undefined, uProps: undefined,
    apply: false, allOf: undefined, anyOf: undefined, oneOf: undefined, not: undefined, if: undefined, then: undefined, else: undefined,
  };
}

/** Child node of `n` at `path` (relative JSON pointer, already escaped). */
function sub(n: SNode, value: unknown, path: string, slot: Slot = 'any', kw = 'false', limit = 0): SNode {
  return n.reg.node(value, n.reg.metaOf(value, n.meta, path), slot, kw, limit);
}

function compile(n: SNode): Plan {
  const p = newPlan();
  n.plan = p;
  const s = n.schema;
  if (!isObj(s)) {
    p.bool = s !== false;
    return p;
  }
  const { base, draft } = n.meta;
  // A declared draft ignores keywords of later drafts; an undeclared one accepts all of them.
  const modern = draft === 0 || draft >= 2019;
  if (typeof s.$ref === 'string') {
    p.ref = mkRef('$ref', s.$ref, base);
    if (!modern) {
      p.refOnly = true;
      return p;
    }
  }
  if (typeof s.$dynamicRef === 'string' && (draft === 0 || draft === 2020)) p.dyn = mkRef('$dynamicRef', s.$dynamicRef, base);
  else if (typeof s.$recursiveRef === 'string' && (draft === 0 || draft === 2019)) p.dyn = mkRef('$recursiveRef', s.$recursiveRef, base);

  const types = (Array.isArray(s.type) ? s.type : [s.type]).filter((t): t is string => typeof t === 'string' && Object.hasOwn(TYPE_BITS, t));
  for (const t of types) p.types |= TYPE_BITS[t];
  if (types.length) p.typeMsg = `must be ${orList(types)}`;
  if (Object.hasOwn(s, 'const')) {
    p.hasConst = true;
    p.constVal = s.const;
    p.constMsg = `must be equal to ${show(s.const)}`;
  }
  if (Array.isArray(s.enum)) p.enumVals = mkEnum(s.enum);

  const step = finite(s.multipleOf);
  p.multipleOf = step !== undefined && step > 0 ? step : undefined;
  // Draft-04 spells exclusive bounds as booleans next to minimum / maximum.
  if (s.exclusiveMinimum === true) p.exMin = finite(s.minimum);
  else [p.minimum, p.exMin] = [finite(s.minimum), finite(s.exclusiveMinimum)];
  if (s.exclusiveMaximum === true) p.exMax = finite(s.maximum);
  else [p.maximum, p.exMax] = [finite(s.maximum), finite(s.exclusiveMaximum)];
  p.num = p.multipleOf !== undefined || p.minimum !== undefined || p.maximum !== undefined || p.exMin !== undefined || p.exMax !== undefined;

  p.minLength = count(s.minLength);
  p.maxLength = count(s.maxLength);
  if (typeof s.pattern === 'string') p.pattern = mkPattern(s.pattern);
  if (typeof s.format === 'string' && Object.hasOwn(FORMATS, s.format)) {
    // Before draft-07, hostname is plain RFC 1123 (no IDNA hyphen rule).
    p.format = s.format === 'hostname' && (draft === 4 || draft === 6) ? (h) => isHostname(h, false) : FORMATS[s.format];
    p.formatName = s.format;
  }
  p.str = p.minLength !== undefined || p.maxLength !== undefined || !!p.pattern || !!p.format;

  const items = s.items;
  if (Array.isArray(s.prefixItems) && (draft === 0 || draft === 2020)) {
    p.tuple = s.prefixItems.map((v, i) => sub(n, v, `/prefixItems/${i}`, 'item', 'prefixItems'));
    if (items !== undefined && !Array.isArray(items)) p.rest = sub(n, items, '/items', 'extra', 'items', p.tuple.length);
  } else if (Array.isArray(items)) {
    p.tuple = items.map((v, i) => sub(n, v, `/items/${i}`, 'item', 'items'));
    if (s.additionalItems !== undefined) p.rest = sub(n, s.additionalItems, '/additionalItems', 'extra', 'additionalItems', p.tuple.length);
  } else if (items !== undefined) p.rest = sub(n, items, '/items', 'extra', 'items');
  if (s.contains !== undefined) {
    p.contains = sub(n, s.contains, '/contains');
    const min = modern ? count(s.minContains) : undefined;
    if (min !== undefined) [p.minContains, p.containsKw] = [min, 'minContains'];
    p.maxContains = modern ? count(s.maxContains) : undefined;
  }
  p.minItems = count(s.minItems);
  p.maxItems = count(s.maxItems);
  p.unique = s.uniqueItems === true;
  if (s.unevaluatedItems !== undefined && modern) p.uItems = sub(n, s.unevaluatedItems, '/unevaluatedItems', 'unevaluatedItem', 'unevaluatedItems');
  p.arr = !!(p.tuple || p.rest || p.contains) || p.minItems !== undefined || p.maxItems !== undefined || p.unique;

  const keys = new Map<string, KeyRule>();
  const props = s.properties;
  if (isObj(props)) for (const k of Object.keys(props)) keys.set(k, { node: sub(n, props[k], `/properties/${esc(k)}`, 'prop', 'properties'), bit: -1 });
  if (Array.isArray(s.required)) {
    const req = [...new Set(s.required.filter((k): k is string => typeof k === 'string'))];
    req.forEach((k, i) => {
      const rule = keys.get(k);
      if (rule) rule.bit = i;
      else keys.set(k, { node: undefined, bit: i });
    });
    if (req.length) p.required = req;
  }
  if (keys.size) p.keys = keys;
  const pp = s.patternProperties;
  if (isObj(pp) && Object.keys(pp).length) {
    p.patterns = Object.keys(pp).map((src): [Pattern, SNode] => [mkPattern(src), sub(n, pp[src], `/patternProperties/${esc(src)}`, 'prop', 'patternProperties')]);
  }
  if (s.additionalProperties !== undefined) p.additional = sub(n, s.additionalProperties, '/additionalProperties', 'additional', 'additionalProperties');
  if (s.propertyNames !== undefined) p.names = sub(n, s.propertyNames, '/propertyNames');
  for (const kw of modern ? ['dependencies', 'dependentRequired', 'dependentSchemas'] : ['dependencies']) {
    const deps = s[kw];
    if (!isObj(deps)) continue;
    for (const k of Object.keys(deps)) {
      const v = deps[k];
      if (Array.isArray(v)) (p.depReq ??= []).push([k, v.filter((x): x is string => typeof x === 'string'), kw]);
      else (p.depSchemas ??= []).push([k, sub(n, v, `/${kw}/${esc(k)}`)]);
    }
  }
  p.minProps = count(s.minProperties);
  p.maxProps = count(s.maxProperties);
  if (s.unevaluatedProperties !== undefined && modern) p.uProps = sub(n, s.unevaluatedProperties, '/unevaluatedProperties', 'unevaluated', 'unevaluatedProperties');
  p.iterate = !!(p.keys || p.patterns || p.additional || p.names || p.depReq || p.depSchemas);
  p.obj = p.iterate || p.minProps !== undefined || p.maxProps !== undefined;

  const list = (k: string): SNode[] | undefined => {
    const v = s[k];
    return Array.isArray(v) && v.length ? v.map((x, i) => sub(n, x, `/${k}/${i}`)) : undefined;
  };
  p.allOf = list('allOf');
  p.anyOf = list('anyOf');
  p.oneOf = list('oneOf');
  if (s.not !== undefined) p.not = sub(n, s.not, '/not');
  if (s.if !== undefined) {
    p.if = sub(n, s.if, '/if');
    if (s.then !== undefined) p.then = sub(n, s.then, '/then');
    if (s.else !== undefined) p.else = sub(n, s.else, '/else');
  }
  p.apply = !!(p.ref || p.dyn || p.allOf || p.anyOf || p.oneOf || p.not || p.if);
  return p;
}

function mkRef(kind: Ref['kind'], ref: string, base: string): Ref {
  return { kind, ref, abs: resolveUri(base, ref), node: undefined, dyn: undefined, recursive: false };
}

/** Static target of a reference, resolved (and external documents loaded) on first use. */
function target(n: SNode, r: Ref): SNode | null {
  if (r.node !== undefined) return r.node;
  const hit = n.reg.lookup(r.abs);
  if (!hit) return (r.node = null);
  const v = hit.value;
  if (isObj(v)) {
    const h = r.abs.indexOf('#');
    const name = h < 0 ? '' : unpct(r.abs.slice(h + 1));
    if (r.kind === '$dynamicRef' && name && name[0] !== '/' && v.$dynamicAnchor === name) r.dyn = name;
    if (r.kind === '$recursiveRef' && v.$recursiveAnchor === true) r.recursive = true;
  }
  return (r.node = n.reg.node(v, hit.meta));
}

const patternCache = new Map<string, Pattern>();

/** ECMA-262 pattern, with the `u` flag when the source allows it. */
function mkPattern(src: string): Pattern {
  let p = patternCache.get(src);
  if (p) return p;
  try {
    p = { src, re: new RegExp(src, 'u'), error: '' };
  } catch {
    try {
      p = { src, re: new RegExp(src), error: '' };
    } catch (e) {
      p = { src, re: undefined, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (patternCache.size < 5000) patternCache.set(src, p);
  return p;
}

/** `format: regex` is strict ECMA-262 (no web-compatibility escapes such as `\a`). */
function isRegex(s: string): boolean {
  try {
    new RegExp(s, 'u');
    return true;
  } catch {
    return false;
  }
}

function mkEnum(values: unknown[]): Enum {
  const e: Enum = { values, strs: new Set(), nums: new Set(), bools: 0, nul: false, others: [], msg: '' };
  for (const v of values) {
    if (typeof v === 'string') e.strs.add(v);
    else if (typeof v === 'number') e.nums.add(v);
    else if (typeof v === 'boolean') e.bools |= v ? 2 : 1;
    else if (v === null) e.nul = true;
    else e.others.push(v);
  }
  e.msg = valuesMessage(values);
  return e;
}

function valuesMessage(values: unknown[]): string {
  const shown = values.slice(0, 8).map(show).join(', ');
  return values.length === 1 ? `must be equal to ${shown}` : `must be one of: ${shown}${values.length > 8 ? `, … (${values.length} values)` : ''}`;
}

// ---------------------------------------------------------------- evaluation

/** Annotations of one value: what adjacent keywords evaluated, for unevaluatedProperties / unevaluatedItems. */
interface Ev {
  props: Set<string> | undefined;
  allProps: boolean;
  /** Leading items evaluated by a tuple. */
  items: number;
  allItems: boolean;
  /** Items matched by `contains`. */
  itemSet: Set<number> | undefined;
}

interface Runtime {
  main: DataTree;
  /** `main`, or the scratch tree while a property name is checked. */
  tree: DataTree;
  yaml: boolean;
  /** False: fail fast without reporting (inside anyOf, oneOf, not, if, contains). */
  collect: boolean;
  /** Collects errors aside instead of reporting them (property names, branch comparison). */
  capture: ValidationError[] | undefined;
  /** Captured errors allowed before the capture is abandoned. */
  budget: number;
  errors: ValidationError[];
  seen: Set<string>;
  max: number;
  truncated: boolean;
  /** Schema problems met while not collecting, reported at the end. */
  pending: ValidationError[];
  issued: Set<string>;
  formats: boolean;
  depth: number;
  /** Value being evaluated, and how many in-place hops deep on it. */
  at: number;
  same: number;
  /** Dynamic scope: resources entered, outermost first. */
  scope: Resource[];
  scratch: DataTree | undefined;
  /** Property whose name is being checked. */
  owner: number;
  names: Map<SNode, Map<string, boolean>>;
}

/** Thrown past maxErrors. */
const STOP = { stop: true };
/** Thrown when a capture has enough errors to rank its branch. */
const ENOUGH = { enough: true };
const CAPTURE_MAX = 100;

function runtime(tree: DataTree, o: ValidateOptions): Runtime {
  return {
    main: tree, tree, yaml: tree.format === 'yaml', collect: true, capture: undefined, budget: Infinity, errors: [], seen: new Set(),
    max: Math.max(1, o.maxErrors ?? 1000), truncated: false, pending: [], issued: new Set(), formats: o.formats ?? true,
    depth: 0, at: -1, same: 0, scope: [], scratch: undefined, owner: -1, names: new Map(),
  };
}

let rt: Runtime = runtime(new DataTree('', 'json'), {});

function newEv(): Ev {
  return { props: undefined, allProps: false, items: 0, allItems: false, itemSet: undefined };
}

function mergeEv(a: Ev, b: Ev): void {
  if (b.props) for (const k of b.props) (a.props ??= new Set()).add(k);
  if (b.itemSet) for (const i of b.itemSet) (a.itemSet ??= new Set()).add(i);
  a.allProps ||= b.allProps;
  a.allItems ||= b.allItems;
  if (b.items > a.items) a.items = b.items;
}

/** Validates node `id` against `n`; reports errors when collecting. */
function run(n: SNode, id: number, ev: Ev | undefined): boolean {
  const p = n.plan ?? compile(n);
  if (p.bool !== undefined) return p.bool || falseSchema(n, id);
  const r = rt;
  // An alias the parser could not expand (circular, unknown, over its cap) has no value to check.
  if (r.yaml && r.tree.flags[id] & F_ALIAS) return true;
  const at = r.at;
  const same = r.same;
  if (id !== at) {
    r.at = id;
    r.same = 0;
  } else if (same < MAX_IN_PLACE) r.same = same + 1;
  else {
    issue(id, '$ref', 'circular $ref: the schema refers to itself without moving into the value', n.meta.loc);
    return true;
  }
  if (r.depth >= MAX_DEPTH) {
    r.at = at;
    r.same = same;
    issue(id, 'depth', 'too deeply nested to validate', n.meta.loc, 'depth');
    return true;
  }
  r.depth++;
  const scope = r.scope;
  const pushed = scope[scope.length - 1] !== n.meta.res;
  if (pushed) scope.push(n.meta.res);
  const ok = r.depth % CHECKPOINT ? evaluate(n, p, id, ev) : guarded(n, p, id, ev);
  if (pushed) scope.pop();
  r.depth--;
  r.at = at;
  r.same = same;
  return ok;
}

/** evaluate(), surviving a stack overflow below: the branch is reported as too deep and skipped. */
function guarded(n: SNode, p: Plan, id: number, ev: Ev | undefined): boolean {
  const r = rt;
  const saved = snapshot(r);
  try {
    return evaluate(n, p, id, ev);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    restore(r, saved);
    issue(id, 'depth', 'too deeply nested to validate', n.meta.loc, 'depth');
    return true;
  }
}

/** Runtime state that an exception thrown mid-evaluation can leave changed. */
function snapshot(r: Runtime) {
  const { depth, at, same, collect, capture, budget, tree, yaml, owner } = r;
  return { depth, at, same, collect, capture, budget, tree, yaml, owner, scope: r.scope.length };
}

function restore(r: Runtime, s: ReturnType<typeof snapshot>): void {
  const { scope, ...rest } = s;
  Object.assign(r, rest);
  r.scope.length = scope;
}

function evaluate(n: SNode, p: Plan, id: number, ev: Ev | undefined): boolean {
  if (p.refOnly) return refRun(n, p.ref!, id, ev);
  const tree = rt.tree;
  const collect = rt.collect;
  const t = tree.type[id];
  if (p.types && !typeMatches(p.types, tree, t, id)) return collect && fail(n, id, 'type', p.typeMsg);
  let ok = true;
  // unevaluated* only see annotations from this schema object and its in-place subschemas.
  const fresh = (p.uProps && t === T_OBJECT) || (p.uItems && t === T_ARRAY) ? newEv() : undefined;
  const local = fresh ?? ev;
  if (p.hasConst && !equalsJs(tree, id, p.constVal, 0)) {
    if (!collect) return false;
    ok = fail(n, id, 'const', p.constMsg);
  }
  if (p.enumVals && !inEnum(p.enumVals, tree, id)) {
    if (!collect) return false;
    ok = fail(n, id, 'enum', p.enumVals.msg);
  }
  let typed = true;
  if (t === T_NUMBER) typed = !p.num || numChecks(n, p, tree, id, collect);
  else if (t === T_STRING) typed = !p.str || strChecks(n, p, tree, id, collect);
  else if (t === T_OBJECT) typed = !p.obj || objChecks(n, p, id, local, collect);
  else if (t === T_ARRAY) typed = !p.arr || arrChecks(n, p, id, local, collect);
  if (!typed) {
    if (!collect) return false;
    ok = false;
  }
  if (p.apply && !applicators(n, p, id, local, collect)) {
    if (!collect) return false;
    ok = false;
  }
  if (fresh) {
    if (!unevaluated(p, id, fresh, collect)) {
      if (!collect) return false;
      ok = false;
    }
    if (ev) mergeEv(ev, fresh);
  }
  return ok;
}

function numChecks(n: SNode, p: Plan, tree: DataTree, id: number, collect: boolean): boolean {
  const v = num(tree, id);
  let ok = true;
  if (p.minimum !== undefined && !(v >= p.minimum)) {
    if (!collect) return false;
    ok = fail(n, id, 'minimum', `must be ≥ ${p.minimum}`);
  }
  if (p.exMin !== undefined && !(v > p.exMin)) {
    if (!collect) return false;
    ok = fail(n, id, 'exclusiveMinimum', `must be > ${p.exMin}`);
  }
  if (p.maximum !== undefined && !(v <= p.maximum)) {
    if (!collect) return false;
    ok = fail(n, id, 'maximum', `must be ≤ ${p.maximum}`);
  }
  if (p.exMax !== undefined && !(v < p.exMax)) {
    if (!collect) return false;
    ok = fail(n, id, 'exclusiveMaximum', `must be < ${p.exMax}`);
  }
  if (p.multipleOf !== undefined && !isMultipleOf(v, p.multipleOf)) {
    if (!collect) return false;
    ok = fail(n, id, 'multipleOf', `must be a multiple of ${p.multipleOf}`);
  }
  return ok;
}

function strChecks(n: SNode, p: Plan, tree: DataTree, id: number, collect: boolean): boolean {
  const s = tree.stringValue(id);
  let ok = true;
  if (p.minLength !== undefined || p.maxLength !== undefined) {
    const len = codePoints(s);
    if (p.minLength !== undefined && len < p.minLength) {
      if (!collect) return false;
      ok = fail(n, id, 'minLength', `must have at least ${plural(p.minLength, 'character')}`);
    }
    if (p.maxLength !== undefined && len > p.maxLength) {
      if (!collect) return false;
      ok = fail(n, id, 'maxLength', `must have at most ${plural(p.maxLength, 'character')}`);
    }
  }
  const pt = p.pattern;
  if (pt && !pt.re) patternIssue(n, id, pt, 'pattern');
  else if (pt && !pt.re!.test(s)) {
    if (!collect) return false;
    ok = fail(n, id, 'pattern', `must match pattern "${truncate(pt.src.replace(/[\n\r\t]/g, (c) => (c === '\n' ? '\\n' : c === '\r' ? '\\r' : '\\t')), 120)}"`);
  }
  if (p.format && rt.formats && !p.format(s)) {
    if (!collect) return false;
    ok = fail(n, id, 'format', `must be a valid ${p.formatName}`);
  }
  return ok;
}

function arrChecks(n: SNode, p: Plan, id: number, ev: Ev | undefined, collect: boolean): boolean {
  const tree = rt.tree;
  const len = tree.childCount[id];
  const size = tree.size;
  let ok = true;
  if (p.minItems !== undefined && len < p.minItems) {
    if (!collect) return false;
    ok = fail(n, id, 'minItems', `must have at least ${plural(p.minItems, 'item')}`);
  }
  if (p.maxItems !== undefined && len > p.maxItems) {
    if (!collect) return false;
    ok = fail(n, id, 'maxItems', `must have at most ${plural(p.maxItems, 'item')}`);
  }
  const { tuple, rest } = p;
  if (tuple || rest) {
    const fixed = tuple ? tuple.length : 0;
    for (let i = 0, c = id + 1; i < len; i++, c += size[c]) {
      const s = i < fixed ? tuple![i] : rest;
      if (!s) break;
      if (!run(s, c, undefined)) {
        if (!collect) return false;
        ok = false;
      }
    }
    if (ev) {
      ev.items = Math.max(ev.items, Math.min(fixed, len));
      if (rest) ev.allItems = true;
    }
  }
  if (p.contains) {
    const { minContains: min, maxContains: max } = p;
    const prev = rt.collect;
    rt.collect = false;
    let matches = 0;
    for (let i = 0, c = id + 1; i < len; i++, c += size[c]) {
      if (!run(p.contains, c, undefined)) continue;
      matches++;
      if (ev) (ev.itemSet ??= new Set()).add(i);
      else if (matches >= min && max === undefined) break;
    }
    rt.collect = prev;
    if (matches < min) {
      if (!collect) return false;
      ok = fail(n, id, p.containsKw, `must contain at least ${plural(min, 'matching item')}`);
    }
    if (max !== undefined && matches > max) {
      if (!collect) return false;
      ok = fail(n, id, 'maxContains', `must contain at most ${plural(max, 'matching item')}`);
    }
  }
  if (p.unique && len > 1) {
    const seen = new Map<string, number>();
    for (let i = 0, c = id + 1; i < len; i++, c += size[c]) {
      const key = canon(tree, c, 0);
      const first = seen.get(key);
      if (first === undefined) seen.set(key, i);
      else {
        if (!collect) return false;
        ok = fail(n, c, 'uniqueItems', `must be unique (same as item [${first}])`);
      }
    }
  }
  return ok;
}

function objChecks(n: SNode, p: Plan, id: number, ev: Ev | undefined, collect: boolean): boolean {
  const tree = rt.tree;
  const count = tree.childCount[id];
  let ok = true;
  if (p.minProps !== undefined && count < p.minProps) {
    if (!collect) return false;
    ok = fail(n, id, 'minProperties', `must have at least ${plural(p.minProps, 'property', 'properties')}`);
  }
  if (p.maxProps !== undefined && count > p.maxProps) {
    if (!collect) return false;
    ok = fail(n, id, 'maxProperties', `must have at most ${plural(p.maxProps, 'property', 'properties')}`);
  }
  if (!p.iterate) return ok;
  const { keys, patterns, additional, names, required } = p;
  // Required keys seen, as bits (or a byte per key for long lists).
  let seen = 0;
  const seenMany = required && required.length > 30 ? new Uint8Array(required.length) : undefined;
  const present = p.depReq || p.depSchemas ? new Set<string>() : undefined;
  const size = tree.size;
  for (let i = 0, c = id + 1; i < count; i++, c += size[c]) {
    const key = String(tree.key(c));
    present?.add(key);
    let matched = false;
    const rule = keys?.get(key);
    if (rule) {
      if (rule.bit >= 0) {
        if (seenMany) seenMany[rule.bit] = 1;
        else seen |= 1 << rule.bit;
      }
      if (rule.node) {
        matched = true;
        if (!run(rule.node, c, undefined)) {
          if (!collect) return false;
          ok = false;
        }
      }
    }
    if (patterns) {
      for (const [pt, s] of patterns) {
        if (!pt.re) patternIssue(n, c, pt, 'patternProperties');
        else if (pt.re.test(key)) {
          matched = true;
          if (!run(s, c, undefined)) {
            if (!collect) return false;
            ok = false;
          }
        }
      }
    }
    if (!matched && additional) {
      matched = true;
      if (!run(additional, c, undefined)) {
        if (!collect) return false;
        ok = false;
      }
    }
    if (names && !nameOk(n, names, key, c, collect)) {
      if (!collect) return false;
      ok = false;
    }
    if (ev && matched) (ev.props ??= new Set()).add(key);
  }
  if (required) {
    for (let b = 0; b < required.length; b++) {
      if (seenMany ? seenMany[b] : seen & (1 << b)) continue;
      if (!collect) return false;
      ok = fail(n, id, 'required', `missing required property ${q(required[b])}`);
    }
  }
  if (p.depReq) {
    for (const [k, deps, kw] of p.depReq) {
      if (!present!.has(k)) continue;
      for (const dep of deps) {
        if (present!.has(dep)) continue;
        if (!collect) return false;
        ok = fail(n, id, kw, `missing property ${q(dep)} required by ${q(k)}`, `${kw}/${esc(k)}`);
      }
    }
  }
  if (p.depSchemas) {
    for (const [k, s] of p.depSchemas) {
      if (!present!.has(k) || run(s, id, ev)) continue;
      if (!collect) return false;
      ok = false;
    }
  }
  return ok;
}

/** unevaluatedProperties / unevaluatedItems against what this schema's other keywords evaluated. */
function unevaluated(p: Plan, id: number, ev: Ev, collect: boolean): boolean {
  const tree = rt.tree;
  const count = tree.childCount[id];
  const object = tree.type[id] === T_OBJECT;
  const s = object ? p.uProps! : p.uItems!;
  let ok = true;
  if (object ? !ev.allProps : !ev.allItems) {
    for (let i = 0, c = id + 1; i < count; i++, c += tree.size[c]) {
      if (object ? ev.props?.has(String(tree.key(c))) : i < ev.items || ev.itemSet?.has(i)) continue;
      if (!run(s, c, undefined)) {
        if (!collect) return false;
        ok = false;
      }
    }
  }
  if (object) ev.allProps = true;
  else ev.allItems = true;
  return ok;
}

function applicators(n: SNode, p: Plan, id: number, ev: Ev | undefined, collect: boolean): boolean {
  let ok = true;
  if (p.ref && !refRun(n, p.ref, id, ev)) {
    if (!collect) return false;
    ok = false;
  }
  if (p.dyn && !refRun(n, p.dyn, id, ev)) {
    if (!collect) return false;
    ok = false;
  }
  if (p.allOf) {
    for (const s of p.allOf) {
      if (run(s, id, ev)) continue;
      if (!collect) return false;
      ok = false;
    }
  }
  if (p.anyOf && !anyOf(n, p.anyOf, id, ev, collect)) {
    if (!collect) return false;
    ok = false;
  }
  if (p.oneOf && !oneOf(n, p.oneOf, id, ev, collect)) {
    if (!collect) return false;
    ok = false;
  }
  if (p.not) {
    const prev = rt.collect;
    rt.collect = false;
    const matched = run(p.not, id, undefined);
    rt.collect = prev;
    if (matched) {
      if (!collect) return false;
      ok = fail(n, id, 'not', 'must NOT match the "not" schema');
    }
  }
  if (p.if && (p.then || p.else || ev)) {
    const prev = rt.collect;
    rt.collect = false;
    const annotations = ev && newEv();
    const cond = run(p.if, id, annotations);
    rt.collect = prev;
    if (cond && annotations) mergeEv(ev!, annotations);
    const branch = cond ? p.then : p.else;
    if (branch && !run(branch, id, ev)) {
      if (!collect) return false;
      ok = false;
    }
  }
  return ok;
}

function anyOf(n: SNode, list: SNode[], id: number, ev: Ev | undefined, collect: boolean): boolean {
  const prev = rt.collect;
  rt.collect = false;
  let passed = false;
  for (const s of list) {
    // With annotations wanted, every passing branch contributes; otherwise the first one decides.
    const annotations = ev && newEv();
    if (!run(s, id, annotations)) continue;
    passed = true;
    if (!annotations) break;
    mergeEv(ev!, annotations);
  }
  rt.collect = prev;
  if (passed || !collect) return passed;
  return explain(n, list, id, ev, 'anyOf', 'must match at least one schema in anyOf');
}

function oneOf(n: SNode, list: SNode[], id: number, ev: Ev | undefined, collect: boolean): boolean {
  const prev = rt.collect;
  rt.collect = false;
  let matches = 0;
  let first: Ev | undefined;
  for (const s of list) {
    const annotations = ev && newEv();
    if (!run(s, id, annotations)) continue;
    if (++matches === 1) first = annotations;
    else if (!collect) break;
  }
  rt.collect = prev;
  if (matches === 1) {
    if (first) mergeEv(ev!, first);
    return true;
  }
  if (!collect) return false;
  if (matches) return fail(n, id, 'oneOf', `must match exactly one schema in oneOf (matched ${matches})`);
  return explain(n, list, id, ev, 'oneOf', 'must match exactly one schema in oneOf');
}

/**
 * No branch matched: report the most specific error instead of a summary. The
 * branch the value was meant for (the only one fitting its type and `const`
 * tags, as in discriminated unions, or else the one failing least badly)
 * reports its own errors; a tag no branch accepts is reported on the tag, and
 * a type no branch accepts as `must be X or Y`.
 */
function explain(n: SNode, list: SNode[], id: number, ev: Ev | undefined, keyword: string, message: string): false {
  let fits = list.filter((s) => fitsShape(s, id));
  if (fits.length > 1 && fits.length <= 8 && !rt.capture) {
    // Several plausible branches: the one failing least badly (fewest errors on the value itself,
    // then fewest overall) is the one meant; on a tie, their own errors are joined with "or".
    const scored = fits.map((s) => {
      const errors = captureRun(s, id);
      const own = errors.filter((e) => e.id === id);
      return { s, own, rank: own.length * 1000 + Math.min(errors.length, 999) };
    });
    const low = Math.min(...scored.map((x) => x.rank));
    const top = scored.filter((x) => x.rank === low);
    if (top.length === 1) fits = [top[0].s];
    else if (top.every((x) => x.own.length)) message = joinMessages(top.map((x) => x.own[0].message));
  }
  if (fits.length === 1) {
    const before = errorCount();
    run(fits[0], id, ev);
    if (errorCount() > before) return false;
  } else if (!fits.length) {
    const tree = rt.tree;
    const shapes = list.map((s) => shapeOf(s, 0));
    if (shapes.every((s) => s.types && !typeMatches(s.types, tree, tree.type[id], id))) {
      const types = typeList(shapes.reduce((m, s) => m | s.types, 0));
      if (types) message = `must be ${types}`;
    } else if (tree.type[id] === T_OBJECT) {
      // Every branch rejects the same tag property (`kind: "triangle"`): point at it.
      for (const [k] of shapes[0].disc) {
        const values = shapes.map((s) => s.disc.find((d) => d[0] === k));
        const c = childByKey(tree, id, k);
        if (c >= 0 && values.every((v) => v && !equalsJs(tree, c, v[1], 0))) return fail(n, c, keyword, valuesMessage(values.map((v) => v![1])));
      }
    }
  }
  return fail(n, id, keyword, message);
}

/** `missing required property "a"` and `… "b"` become `missing required property "a" or "b"`. */
function joinMessages(messages: string[]): string {
  const unique = [...new Set(messages)];
  const parts = unique.map((m) => /^(.*) ("(?:[^"\\]|\\.)*")$/.exec(m));
  if (unique.length > 1 && parts.every((p) => p && p[1] === parts[0]![1])) return `${parts[0]![1]} ${orList(parts.map((p) => p![2]))}`;
  return unique.join(' or ');
}

function errorCount(): number {
  return rt.capture ? rt.capture.length : rt.errors.length;
}

/** Errors of one branch, collected aside (at most CAPTURE_MAX) to compare branches. */
function captureRun(s: SNode, id: number): ValidationError[] {
  const r = rt;
  const saved = snapshot(r);
  const errors: ValidationError[] = [];
  r.collect = true;
  r.capture = errors;
  r.budget = CAPTURE_MAX;
  try {
    run(s, id, undefined);
  } catch (e) {
    if (e !== ENOUGH) throw e;
  }
  restore(r, saved);
  return errors;
}

function shapeOf(n: SNode, hops: number): Shape {
  if (n.shape) return n.shape;
  const shape: Shape = { types: 0, disc: [] };
  n.shape = shape;
  const p = n.plan ?? compile(n);
  if (p.bool !== undefined) {
    if (!p.bool) shape.types = B_NEVER;
    return shape;
  }
  shape.types = p.types;
  if (p.keys) {
    for (const [k, rule] of p.keys) {
      const c = rule.node && (rule.node.plan ?? compile(rule.node));
      if (c?.hasConst) shape.disc.push([k, c.constVal]);
      else if (c?.enumVals?.values.length === 1) shape.disc.push([k, c.enumVals.values[0]]);
    }
  }
  const parts = p.allOf ? [...p.allOf] : [];
  const t = p.ref && hops < 8 ? target(n, p.ref) : null;
  if (t) parts.push(t);
  for (const part of parts) {
    const s = shapeOf(part, hops + 1);
    if (s.types) shape.types = shape.types ? shape.types & s.types || B_NEVER : s.types;
    shape.disc.push(...s.disc);
  }
  return shape;
}

function fitsShape(n: SNode, id: number): boolean {
  const s = shapeOf(n, 0);
  const tree = rt.tree;
  const t = tree.type[id];
  if (s.types && !typeMatches(s.types, tree, t, id)) return false;
  if (t !== T_OBJECT) return true;
  for (const [k, v] of s.disc) {
    const c = childByKey(tree, id, k);
    if (c >= 0 && !equalsJs(tree, c, v, 0)) return false;
  }
  return true;
}

function childByKey(tree: DataTree, id: number, key: string): number {
  for (let c = tree.firstChild(id); c >= 0; c = tree.nextSibling(c)) if (tree.key(c) === key) return c;
  return -1;
}

function refRun(n: SNode, r: Ref, id: number, ev: Ev | undefined): boolean {
  let t = r.node === undefined ? target(n, r) : r.node;
  if (!t) {
    issue(id, r.kind, `cannot resolve ${r.kind} ${q(r.ref)}`, `${n.meta.loc}/${r.kind}`);
    return true;
  }
  // Dynamic references land on the outermost matching anchor of the resources entered so far.
  if (r.dyn !== undefined) {
    for (const res of rt.scope) {
      const o = res.dyn?.get(r.dyn);
      if (o) {
        t = n.reg.nodeOf(o);
        break;
      }
    }
  } else if (r.recursive) {
    for (const res of rt.scope) {
      if (res.recursive && isObj(res.root)) {
        t = n.reg.nodeOf(res.root);
        break;
      }
    }
  }
  return run(t, id, ev);
}

/** propertyNames: the key is validated as a string; failures are reported on the property. */
function nameOk(n: SNode, names: SNode, key: string, id: number, collect: boolean): boolean {
  const r = rt;
  let cache = r.names.get(names);
  if (!cache) r.names.set(names, (cache = new Map()));
  let ok = cache.get(key);
  if (ok === undefined) {
    ok = onKey(names, key, id, undefined);
    if (cache.size < 10_000) cache.set(key, ok);
  }
  if (ok || !collect) return ok;
  const errors: ValidationError[] = [];
  onKey(names, key, id, errors);
  const what = `property name ${q(key)}`;
  if (!errors.length) return fail(n, id, 'propertyNames', `${what} is invalid`);
  for (const e of errors) report(id, 'propertyNames', `${what} ${e.message}`, e.schemaPath);
  return false;
}

/** Runs `s` on a string value held by a one-node scratch tree. */
function onKey(s: SNode, key: string, owner: number, capture: ValidationError[] | undefined): boolean {
  const r = rt;
  const saved = snapshot(r);
  const tree = (r.scratch ??= scratchTree());
  tree.synthVals.set(0, key);
  Object.assign(r, { tree, yaml: false, collect: capture !== undefined, capture, at: -1, same: 0, owner });
  const ok = run(s, 0, undefined);
  restore(r, saved);
  return ok;
}

function scratchTree(): DataTree {
  const t = new DataTree('', 'json', 16);
  t.count = 1;
  t.type[0] = T_STRING;
  t.flags[0] = F_VAL_SYNTH;
  t.parent[0] = -1;
  t.size[0] = 1;
  return t;
}

function falseSchema(n: SNode, id: number): false {
  if (!rt.collect) return false;
  const k = rt.tree.key(id);
  let message: string;
  switch (n.slot) {
    case 'prop':
      message = `must NOT have property ${q(String(k))}`;
      break;
    case 'additional':
      message = `must NOT have additional property ${q(String(k))}`;
      break;
    case 'unevaluated':
      message = `must NOT have unevaluated property ${q(String(k))}`;
      break;
    case 'item':
      message = `must NOT have item [${k}]`;
      break;
    case 'extra':
      message = n.limit ? `must NOT have additional item [${k}] (at most ${plural(n.limit, 'item')})` : `must NOT have any items`;
      break;
    case 'unevaluatedItem':
      message = `must NOT have unevaluated item [${k}]`;
      break;
    default:
      message = 'is not allowed (schema is false)';
  }
  report(id, n.kw, message, n.meta.loc);
  return false;
}

// ---------------------------------------------------------------- reporting

/** Records an error (only while collecting); throws STOP past maxErrors. */
function report(id: number, keyword: string, message: string, schemaPath: string): void {
  const r = rt;
  if (r.capture) {
    if (r.capture.length >= r.budget) throw ENOUGH;
    r.capture.push({ id, path: '', keyword, message, schemaPath });
    return;
  }
  const key = `${id}\u0000${schemaPath}\u0000${message}`;
  if (r.seen.has(key)) return;
  if (r.errors.length >= r.max) {
    r.truncated = true;
    throw STOP;
  }
  const path = r.main.pathString(id);
  r.seen.add(key);
  r.errors.push({ id, path, keyword, message, schemaPath });
}

function fail(n: SNode, id: number, keyword: string, message: string, at = keyword): false {
  report(id, keyword, message, `${n.meta.loc}/${at}`);
  return false;
}

/** A problem in the schema itself (bad pattern, unresolvable $ref…): reported once per run, even from a fail-fast branch. */
function issue(id: number, keyword: string, message: string, schemaPath: string, key = schemaPath): void {
  const r = rt;
  if (r.issued.has(key)) return;
  if (r.tree !== r.main) id = r.owner;
  if (r.collect && !r.capture) report(id, keyword, message, schemaPath);
  else r.pending.push({ id, path: r.main.pathString(id), keyword, message, schemaPath });
  // Marked only once recorded: a stack overflow while reporting leaves it to an outer checkpoint.
  r.issued.add(key);
}

function patternIssue(n: SNode, id: number, pt: Pattern, keyword: string): void {
  const at = keyword === 'pattern' ? 'pattern' : `${keyword}/${esc(pt.src)}`;
  issue(id, keyword, `invalid pattern ${q(pt.src)} in the schema: ${pt.error}`, `${n.meta.loc}/${at}`);
}

// ---------------------------------------------------------------- values

function num(tree: DataTree, id: number): number {
  const n = +tree.rawValue(id);
  if (n === n) return n;
  const v = tree.value(id);
  return typeof v === 'number' ? v : NaN;
}

function typeMatches(mask: number, tree: DataTree, t: number, id: number): boolean {
  switch (t) {
    case T_OBJECT:
      return (mask & B_OBJECT) !== 0;
    case T_ARRAY:
      return (mask & B_ARRAY) !== 0;
    case T_STRING:
      return (mask & B_STRING) !== 0;
    case T_NUMBER:
      return (mask & B_NUMBER) !== 0 || ((mask & B_INTEGER) !== 0 && Number.isInteger(num(tree, id)));
    case T_BOOLEAN:
      return (mask & B_BOOLEAN) !== 0;
    default:
      return (mask & B_NULL) !== 0;
  }
}

function inEnum(e: Enum, tree: DataTree, id: number): boolean {
  switch (tree.type[id]) {
    case T_STRING:
      return e.strs.has(tree.stringValue(id));
    case T_NUMBER:
      return e.nums.has(num(tree, id));
    case T_BOOLEAN:
      return (e.bools & (tree.value(id) ? 2 : 1)) !== 0;
    case T_NULL:
      return e.nul;
    default:
      return e.others.some((v) => equalsJs(tree, id, v, 0));
  }
}

/** Deep equality of a node and a JS value (numbers by value: 1 equals 1.0). */
function equalsJs(tree: DataTree, id: number, v: unknown, depth: number): boolean {
  const t = tree.type[id];
  switch (t) {
    case T_STRING:
      return typeof v === 'string' && tree.stringValue(id) === v;
    case T_NUMBER:
      return typeof v === 'number' && num(tree, id) === v;
    case T_BOOLEAN:
      return v === tree.value(id);
    case T_NULL:
      return v === null;
  }
  if (depth > 100) return false;
  const n = tree.childCount[id];
  if (t === T_ARRAY) {
    if (!Array.isArray(v) || v.length !== n) return false;
    for (let i = 0, c = id + 1; i < n; i++, c += tree.size[c]) if (!equalsJs(tree, c, v[i], depth + 1)) return false;
    return true;
  }
  if (!isObj(v) || Object.keys(v).length !== n) return false;
  for (let c = id + 1, i = 0; i < n; i++, c += tree.size[c]) {
    const k = String(tree.key(c));
    if (!Object.hasOwn(v, k) || !equalsJs(tree, c, v[k], depth + 1)) return false;
  }
  return true;
}

/** Canonical text of a value for uniqueItems (object keys sorted, numbers by value). */
function canon(tree: DataTree, id: number, depth: number): string {
  const t = tree.type[id];
  switch (t) {
    case T_STRING:
      return JSON.stringify(tree.stringValue(id));
    case T_NUMBER:
      return `n${num(tree, id)}`;
    case T_BOOLEAN:
      return tree.value(id) ? 't' : 'f';
    case T_NULL:
      return 'z';
  }
  if (depth > 100) return `#${id}`;
  const parts: string[] = [];
  for (let c = id + 1, i = tree.childCount[id]; i > 0; i--, c += tree.size[c]) {
    parts.push(t === T_ARRAY ? canon(tree, c, depth + 1) : `${JSON.stringify(String(tree.key(c)))}:${canon(tree, c, depth + 1)}`);
  }
  return t === T_ARRAY ? `[${parts.join(',')}]` : `{${parts.sort().join(',')}}`;
}

/** Float-safe multipleOf on the decimal values: 0.3 is a multiple of 0.1, and so is 1e308. */
function isMultipleOf(v: number, m: number): boolean {
  if (!Number.isFinite(v)) return false;
  const quotient = v / m;
  if (Number.isInteger(quotient)) return true;
  const d = Math.max(decimals(v), decimals(m));
  if (d > 0 && d <= 20) {
    const f = 10 ** d;
    const a = Math.round(v * f);
    const b = Math.round(m * f);
    if (b !== 0 && Number.isSafeInteger(b)) {
      if (Number.isSafeInteger(a)) return a % b === 0;
      // A huge integer: scale exactly instead of overflowing.
      if (Number.isInteger(v)) return (BigInt(v) * 10n ** BigInt(d)) % BigInt(b) === 0n;
    }
  }
  return Number.isFinite(quotient) ? Math.abs(quotient - Math.round(quotient)) < 1e-9 : v % m === 0;
}

function decimals(n: number): number {
  const s = String(n);
  const e = s.indexOf('e');
  const mantissa = e < 0 ? s : s.slice(0, e);
  const dot = mantissa.indexOf('.');
  const d = dot < 0 ? 0 : mantissa.length - dot - 1;
  return e < 0 ? d : Math.max(0, d - Number(s.slice(e + 1)));
}

/** String length in code points, as JSON Schema counts it. */
function codePoints(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- formats

const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:z|([+-])(\d{2}):(\d{2}))$/i;
/** RFC 3339 appendix A: units in order, none skipped in the middle, weeks alone. */
const DURATION = /^P(?:(?:\d+D|\d+M(?:\d+D)?|\d+Y(?:\d+M(?:\d+D)?)?)(?:T(?:\d+S|\d+M(?:\d+S)?|\d+H(?:\d+M(?:\d+S)?)?))?|T(?:\d+S|\d+M(?:\d+S)?|\d+H(?:\d+M(?:\d+S)?)?)|\d+W)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const RESERVED_HYPHENS = /(?:^|\.)(?!xn--)[^.]{2}--/i;
const ATOM = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
const QUOTED = /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e\t])*"$/;
const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;
const REL_POINTER = /^(?:0|[1-9]\d*)(?:#|(?:\/(?:[^~/]|~[01])*)*)$/;
const URI_PARTS = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#([\s\S]*))?$/;
const PCT = '%[0-9a-f]{2}';
const SUB = "a-z0-9\\-._~!$&'()*+,;=";
const URI_PATH = new RegExp(`^(?:[${SUB}:@/]|${PCT})*$`, 'i');
const URI_QUERY = new RegExp(`^(?:[${SUB}:@/?]|${PCT})*$`, 'i');
const USERINFO = new RegExp(`^(?:[${SUB}:]|${PCT})*$`, 'i');
const REG_NAME = new RegExp(`^(?:[${SUB}]|${PCT})*$`, 'i');

const FORMATS: Record<string, (s: string) => boolean> = {
  'date-time': (s) => {
    const m = /^(\d{4}-\d{2}-\d{2})[Tt ](.+)$/.exec(s);
    return !!m && isDate(m[1]) && isTime(m[2]);
  },
  date: isDate,
  time: isTime,
  duration: (s) => DURATION.test(s),
  email: isEmail,
  hostname: (s) => isHostname(s),
  ipv4: (s) => IPV4.test(s),
  ipv6: isIpv6,
  uri: (s) => isUri(s, false),
  'uri-reference': (s) => isUri(s, true),
  uuid: (s) => UUID.test(s),
  regex: isRegex,
  'json-pointer': (s) => POINTER.test(s),
  'relative-json-pointer': (s) => REL_POINTER.test(s),
};

function isDate(s: string): boolean {
  const m = DATE.exec(s);
  if (!m) return false;
  const y = +m[1];
  const month = +m[2];
  const day = +m[3];
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && leap ? 29 : DAYS[month]);
}

/** RFC 3339 full-time; a leap second is only valid at 23:59:60 UTC. */
function isTime(s: string): boolean {
  const m = TIME.exec(s);
  if (!m) return false;
  const h = +m[1];
  const min = +m[2];
  const sec = +m[3];
  const offset = m[4] ? (m[4] === '-' ? -1 : 1) * (+m[5] * 60 + +m[6]) : 0;
  if (h > 23 || min > 59 || sec > 60 || (m[4] && (+m[5] > 23 || +m[6] > 59))) return false;
  return sec < 60 || (((h * 60 + min - offset) % 1440) + 1440) % 1440 === 1439;
}

/** RFC 1123 host name; with `idna`, `--` in positions 3–4 is reserved for `xn--` A-labels. */
function isHostname(s: string, idna = true): boolean {
  return HOSTNAME.test(s) && !(idna && RESERVED_HYPHENS.test(s));
}

function isEmail(s: string): boolean {
  const at = s.lastIndexOf('@');
  if (at <= 0) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!ATOM.test(local) && !QUOTED.test(local)) return false;
  if (domain[0] !== '[' || !domain.endsWith(']')) return isHostname(domain);
  const ip = domain.slice(1, -1);
  return /^ipv6:/i.test(ip) ? isIpv6(ip.slice(5)) : IPV4.test(ip);
}

function isIpv6(s: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(s)) return false;
  const gap = s.indexOf('::');
  if (gap >= 0 && s.indexOf('::', gap + 1) >= 0) return false;
  const head = gap < 0 ? s : s.slice(0, gap);
  const tail = gap < 0 ? '' : s.slice(gap + 2);
  const groups = [...(head ? head.split(':') : []), ...(tail ? tail.split(':') : [])];
  let n = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (i === groups.length - 1 && g.includes('.')) {
      if (!IPV4.test(g)) return false;
      n += 2;
    } else if (/^[0-9a-f]{1,4}$/i.test(g)) n++;
    else return false;
  }
  return gap < 0 ? n === 8 : n <= 7;
}

/** RFC 3986 URI (scheme required) or URI reference. */
function isUri(s: string, reference: boolean): boolean {
  const m = URI_PARTS.exec(s);
  if (!m) return false;
  const [, scheme, authority, path, query, fragment] = m;
  if (scheme === undefined ? !reference : !/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return false;
  if (authority !== undefined && !isAuthority(authority)) return false;
  return URI_PATH.test(path) && (query === undefined || URI_QUERY.test(query)) && (fragment === undefined || URI_QUERY.test(fragment));
}

function isAuthority(a: string): boolean {
  const at = a.lastIndexOf('@');
  if (at >= 0 && !USERINFO.test(a.slice(0, at))) return false;
  let host = a.slice(at + 1);
  if (host[0] === '[') {
    const end = host.indexOf(']');
    if (end < 0 || !/^(?::\d*)?$/.test(host.slice(end + 1))) return false;
    const literal = host.slice(1, end);
    return isIpv6(literal) || /^v[0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+$/i.test(literal);
  }
  const colon = host.lastIndexOf(':');
  if (colon >= 0) {
    if (!/^\d*$/.test(host.slice(colon + 1))) return false;
    host = host.slice(0, colon);
  }
  return REG_NAME.test(host);
}

// ---------------------------------------------------------------- URIs and helpers

/** RFC 3986 reference resolution; relative and empty bases resolve to relative results. */
function resolveUri(base: string, ref: string): string {
  const r = URI_PARTS.exec(ref)!;
  let [, scheme, authority, path, query] = r;
  if (scheme === undefined) {
    const b = URI_PARTS.exec(base)!;
    scheme = b[1];
    if (authority === undefined) {
      authority = b[2];
      if (!path) {
        path = b[3];
        if (query === undefined) query = b[4];
      } else if (path[0] !== '/') {
        const bp = b[3];
        path = (authority !== undefined && !bp ? '/' : bp.slice(0, bp.lastIndexOf('/') + 1)) + path;
      }
    }
  }
  return (
    (scheme !== undefined ? `${scheme}:` : '') +
    (authority !== undefined ? `//${authority}` : '') +
    removeDots(path) +
    (query !== undefined ? `?${query}` : '') +
    (r[5] !== undefined ? `#${r[5]}` : '')
  );
}

/** RFC 3986 remove_dot_segments, keeping leading `..` of relative paths. */
function removeDots(path: string): string {
  if (!/(^|\/)\.\.?(\/|$)/.test(path)) return path;
  const absolute = path[0] === '/';
  const segs = (absolute ? path.slice(1) : path).split('/');
  const out: string[] = [];
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else if (s !== '.') out.push(s);
    if (last && (s === '.' || s === '..')) out.push('');
  });
  return (absolute ? '/' : '') + out.join('/');
}

function unpct(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** JSON-pointer escaping of one segment. */
function esc(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Non-negative integer keyword value (minLength, maxItems…). */
function count(v: unknown): number | undefined {
  return typeof v === 'number' && v >= 0 && Number.isFinite(v) ? Math.floor(v) : undefined;
}

function q(s: string): string {
  return JSON.stringify(truncate(s, 80));
}

function show(v: unknown): string {
  return truncate(JSON.stringify(v) ?? String(v), 40);
}

function orList(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function typeList(mask: number): string {
  return orList(TYPE_ORDER.filter(([name, bit]) => mask & bit && !(name === 'integer' && mask & B_NUMBER)).map(([name]) => name));
}
