/**
 * Model types generated from an inferred schema: TypeScript, Zod, Pydantic,
 * Go, Rust (serde), C# (System.Text.Json), Kotlin (kotlinx.serialization),
 * Swift (Codable) and Java (Jackson).
 *
 * Every distinct object shape becomes one named type (shapes the target would
 * spell identically share it), named after its key with array items
 * singularized, without collisions. Field names follow each language's
 * conventions and always map back to the exact JSON key; values whose type
 * varies fall back to the language's dynamic JSON type. The output accepts the
 * data it was inferred from.
 */

import { detectStringFormat, schemaEnum, type SchemaNode, type SchemaResult } from './schema';
import type { TypeTarget } from './targets';

// The target list lives in the dependency-free targets.ts so UI bundles can import it.
export { TYPE_TARGETS, type TypeTarget } from './targets';

export interface TypeGenOptions {
  /** Name of the top-level type (default `Root`). */
  rootName?: string;
}

/** Source code declaring types for the documents a schema was inferred from. */
export function generateTypes(schema: SchemaResult | SchemaNode, target: TypeTarget, options: TypeGenOptions = {}): string {
  const lang = LANGS[target];
  let rootName = lang.typeName(keyWords(options.rootName ?? '')) || 'Root';
  if (/^\d/.test(rootName)) rootName = `N${rootName}`;
  if (lang.reserved.has(rootName)) rootName += 'Model';
  const shapes: Shape[] = [];
  const root = toTy('root' in schema ? schema.root : schema, rootName, 0, shapes);
  return lang.render(buildModel(root, shapes, lang, rootName));
}

// ---------------------------------------------------------------- model

type NumKind = 'i32' | 'i64' | 'u64' | 'f64';

/** One schema position reduced to what code generators need. */
interface Ty {
  kind: 'any' | 'string' | 'number' | 'boolean' | 'array' | 'map' | 'object';
  nullable: boolean;
  num?: NumKind;
  /** Integers within ±(2^53 - 1). */
  safe?: boolean;
  /** String enum, as JSON string literals. */
  values?: string[];
  /** Array items or map values. */
  of?: Ty;
  shape?: Shape;
}

interface Field {
  key: string;
  ty: Ty;
  optional: boolean;
}

/** An object position: becomes a named type, possibly shared with identical shapes. */
interface Shape {
  fields: Field[];
  /** The key it was found under (singularized for array items). */
  hint: string;
}

interface Model {
  root: Ty;
  rootName: string;
  /** Distinct shapes, root first, then in order of appearance. */
  order: Shape[];
  /** Distinct shapes, each after the shapes it uses. */
  deps: Shape[];
  name(s: Shape): string;
}

type Ref = (s: Shape) => string;

interface Lang {
  /** Names a generated type must not take (builtins, imported names). */
  reserved: Set<string>;
  typeName(words: string[]): string;
  /** Type expression; shapes whose fields have equal expressions share one type. */
  expr(t: Ty, ref: Ref): string;
  render(m: Model): string;
}

/** Deeper values become the dynamic type, which bounds every recursion here. */
const MAX_DEPTH = 64;
const MAX_ENUM = 12;
const ANY: Ty = { kind: 'any', nullable: false };
const KINDS = ['object', 'array', 'string', 'number', 'boolean'] as const;

function toTy(s: SchemaNode, hint: string, depth: number, shapes: Shape[]): Ty {
  const nullable = !!s.types.null;
  const kinds = KINDS.filter((k) => s.types[k]);
  if (kinds.length !== 1 || depth >= MAX_DEPTH) return { kind: 'any', nullable };
  const sub = (c: SchemaNode, h: string) => toTy(c, h, depth + 1, shapes);
  switch (kinds[0]) {
    case 'object': {
      if (s.mapOf) return { kind: 'map', nullable, of: sub(s.mapOf, itemHint(hint, 'Value')) };
      if (!s.fields?.size) return { kind: 'map', nullable, of: ANY };
      const shape: Shape = { fields: [], hint };
      shapes.push(shape);
      for (const [key, f] of s.fields) shape.fields.push({ key, optional: f.count < s.objects, ty: sub(f, key) });
      return { kind: 'object', nullable, shape };
    }
    case 'array':
      return { kind: 'array', nullable, of: s.items?.count ? sub(s.items, itemHint(hint, 'Item')) : ANY };
    case 'string': {
      // Repeated dates, emails or ids are not an enumeration.
      const en = schemaEnum(s);
      const values = en && en.length <= MAX_ENUM && en.every((v) => v[0] === '"' && !detectStringFormat(JSON.parse(v) as string)) ? en : undefined;
      return { kind: 'string', nullable, values };
    }
    case 'number': {
      // min/max are doubles: i64::MAX and u64::MAX read as exactly 2^63 and 2^64.
      const lo = s.min ?? 0;
      const hi = s.max ?? 0;
      const num: NumKind = !s.allIntegers
        ? 'f64'
        : lo >= -(2 ** 31) && hi < 2 ** 31
          ? 'i32'
          : lo >= -(2 ** 63) && hi <= 2 ** 63
            ? 'i64'
            : lo >= 0 && hi <= 2 ** 64
              ? 'u64'
              : 'f64';
      return { kind: 'number', nullable, num, safe: s.allIntegers && Math.max(-lo, hi) <= Number.MAX_SAFE_INTEGER };
    }
    default:
      return { kind: 'boolean', nullable };
  }
}

/** Merges identical shapes, names them breadth-first and orders them for output. */
function buildModel(root: Ty, shapes: Shape[], lang: Lang, rootName: string): Model {
  const canon = new Map<Shape, Shape>();
  const ids = new Map<Shape, string>();
  const bySig = new Map<string, Shape>();
  const sigRef: Ref = (s) => ids.get(canon.get(s)!)!;
  // Shapes are in pre-order, so walking backwards sees children before parents.
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    const sig = s.fields.map((f) => `${JSON.stringify(f.key)}${f.optional ? '?' : ''}:${lang.expr(f.ty, sigRef)}`).sort().join(',');
    let c = bySig.get(sig);
    if (!c) {
      bySig.set(sig, (c = s));
      ids.set(s, `#${ids.size}`);
    }
    canon.set(s, c);
  }

  const hints = new Map<Shape, string[]>();
  for (const s of shapes) {
    const c = canon.get(s)!;
    const h = hints.get(c);
    if (!h) hints.set(c, [s.hint]);
    else if (!h.includes(s.hint)) h.push(s.hint);
  }
  const used = new Set(lang.reserved);
  used.add(rootName);
  const names = new Map<Shape, string>();
  const claim = (n: string) => (used.add(n), n);
  const pick = (s: Shape, hint: string, from?: Shape): string => {
    const all = hints.get(s)!;
    let n = lang.typeName(keyWords((all.length > 1 && sharedName(all)) || hint)) || 'Item';
    if (/^\d/.test(n)) n = `N${n}`;
    if (!used.has(n)) return claim(n);
    // `CompanyAddress` beside `Address`, but `Child2` rather than `ChildChild`.
    const parent = from && names.get(from);
    if (parent && !parent.includes(n) && !used.has(parent + n)) return claim(parent + n);
    for (let i = 2; ; i++) if (!used.has(`${n}${i}`)) return claim(`${n}${i}`);
  };
  if (root.shape) names.set(canon.get(root.shape)!, rootName);
  const queue: { s: Shape; hint: string; from?: Shape }[] = [];
  const seen = new Set<Shape>();
  const reach = (t: Ty, from?: Shape) => {
    while (t.of) t = t.of;
    const c = t.shape && canon.get(t.shape);
    if (c && !seen.has(c)) {
      seen.add(c);
      queue.push({ s: c, hint: t.shape!.hint, from });
    }
  };
  reach(root);
  for (let i = 0; i < queue.length; i++) {
    const { s, hint, from } = queue[i];
    if (!names.has(s)) names.set(s, pick(s, hint, from));
    for (const f of s.fields) reach(f.ty, s);
  }

  const order: Shape[] = [];
  const deps: Shape[] = [];
  const done = new Set<Shape>();
  const visit = (t: Ty) => {
    while (t.of) t = t.of;
    const c = t.shape && canon.get(t.shape);
    if (!c || done.has(c)) return;
    done.add(c);
    order.push(c);
    for (const f of c.fields) visit(f.ty);
    deps.push(c);
  };
  visit(root);
  return { root, rootName, order, deps, name: (s) => names.get(canon.get(s)!)! };
}

// ---------------------------------------------------------------- names

const set = (s: string) => new Set(s.split(' '));
const isUpper = (c: string) => c >= 'A' && c <= 'Z';
const isLower = (c: string) => c >= 'a' && c <= 'z';
const isDigit = (c: string) => c >= '0' && c <= '9';

/** Words of a key: `userID` → user, ID; `first-name` → first, name; `URLsList` → URLs, List. */
function keyWords(key: string): string[] {
  const out: string[] = [];
  const ascii = key.normalize('NFKD').replace(/\p{M}+/gu, '');
  for (const chunk of ascii.split(/[^A-Za-z0-9]+/)) {
    let start = 0;
    for (let i = 1; i < chunk.length; i++) {
      const [a, b, c = '', d = ''] = [chunk[i - 1], chunk[i], chunk[i + 1], chunk[i + 2]];
      const camel = (isLower(a) || isDigit(a)) && isUpper(b);
      const acronymEnd = isUpper(a) && isUpper(b) && isLower(c) && !(c === 's' && !isLower(d));
      if (camel || acronymEnd) {
        out.push(chunk.slice(start, i));
        start = i;
      }
    }
    if (chunk) out.push(chunk.slice(start));
  }
  return out;
}

const ACRONYM = /^[A-Z][A-Z\d]*s?$/;
const GO_INITIALISMS = set(
  'acl api ascii cpu css dns eof guid html http https id ip json lhs qps ram rhs rpc sla smtp sql ssh tcp tls ttl udp ui uid uuid uri url utf8 vm xml xmpp xsrf xss',
);

/** Joins words in Pascal/camel case; acronyms in mixed-case keys stay as written (`userID` → userID, `FIRST_NAME` → firstName). */
function caseWords(ws: string[], lowerFirst: boolean, initialisms = false): string {
  const mixed = ws.some((w) => /[a-z]/.test(w));
  return ws
    .map((w, i) => {
      const l = w.toLowerCase();
      if (i === 0 && lowerFirst) return l;
      if (initialisms && GO_INITIALISMS.has(l)) return l.toUpperCase();
      if (initialisms && l.endsWith('s') && GO_INITIALISMS.has(l.slice(0, -1))) return `${l.slice(0, -1).toUpperCase()}s`;
      return mixed && ACRONYM.test(w) ? w : l[0].toUpperCase() + l.slice(1);
    })
    .join('');
}

const pascal = (ws: string[]) => caseWords(ws, false);
const camel = (ws: string[]) => caseWords(ws, true);
const snake = (ws: string[]) => ws.map((w) => w.toLowerCase()).join('_');
const goName = (ws: string[]) => caseWords(ws, false, true);

const pairs = (s: string) => Object.fromEntries(s.split(' ').map((p) => p.split(':'))) as Record<string, string>;
const IRREGULAR = pairs(
  'people:person men:man women:woman children:child mice:mouse geese:goose teeth:tooth feet:foot oxen:ox ' +
    'criteria:criterion phenomena:phenomenon indices:index matrices:matrix vertices:vertex appendices:appendix axes:axis ' +
    'analyses:analysis diagnoses:diagnosis hypotheses:hypothesis theses:thesis crises:crisis synopses:synopsis ' +
    'parentheses:parenthesis quizzes:quiz radii:radius cacti:cactus fungi:fungus alumni:alumnus stimuli:stimulus ' +
    'leaves:leaf wolves:wolf halves:half knives:knife wives:wife lives:life shelves:shelf thieves:thief calves:calf ' +
    'loaves:loaf scarves:scarf selves:self elves:elf heroes:hero potatoes:potato tomatoes:tomato echoes:echo ' +
    'vetoes:veto torpedoes:torpedo mosquitoes:mosquito embargoes:embargo dominoes:domino cargoes:cargo volcanoes:volcano ' +
    'movies:movie cookies:cookie zombies:zombie calories:calorie selfies:selfie rookies:rookie hoodies:hoodie ' +
    'genies:genie brownies:brownie smoothies:smoothie goodies:goodie newbies:newbie pixies:pixie prairies:prairie ' +
    'sorties:sortie aunties:auntie hippies:hippie techies:techie caches:cache niches:niche headaches:headache ' +
    'avalanches:avalanche cliches:cliche quiches:quiche mustaches:mustache moustaches:moustache psyches:psyche',
);
/** Singular words ending in s (and plural-looking words that are not plurals). */
const SINGULAR_S = set(
  'status bus bonus virus campus census chorus focus genius radius corpus octopus cactus nexus consensus circus minus ' +
    'plus surplus stimulus terminus abacus fetus hiatus lotus onus opus sinus walrus apparatus prospectus syllabus ' +
    'thesaurus nucleus alias atlas bias canvas gas lens iris tennis redis this his yes news series species means physics ' +
    'mathematics economics politics ethics chaos kudos dns gps sms css tls rss cms nfs https fps rps qps tps bps kbps ' +
    'mbps gbps aws ios macos os pos saas paas iaas faas',
);
const PLURAL_US = set('menus skus cpus gpus tpus npus vpus apus gurus emus haikus tutus tofus sudokus');

/** Singular of an English plural, keeping its casing; undefined when the word is not plural. */
function singularWord(w: string): string | undefined {
  const l = w.toLowerCase();
  let s: string | undefined;
  if (w.length > 2 && /^[A-Z\d]+s$/.test(w)) s = l.slice(0, -1); // URLs, IDs
  else if (IRREGULAR[l]) s = IRREGULAR[l];
  else if (SINGULAR_S.has(l) || l.length < 3 || !l.endsWith('s') || l.endsWith('ss')) return undefined;
  else if (l.endsWith('es') && SINGULAR_S.has(l.slice(0, -2))) s = l.slice(0, -2); // statuses, aliases
  else if (l.endsWith('ies')) s = l.length > 4 ? `${l.slice(0, -3)}y` : l.slice(0, -1);
  else if (/(ss|x|ch|sh|zz)es$/.test(l)) s = l.slice(0, -2);
  else if (l.endsWith('us')) s = PLURAL_US.has(l) ? l.slice(0, -1) : undefined;
  else if (!/(sis|xis)$/.test(l)) s = l.slice(0, -1);
  if (!s) return undefined;
  let p = 0;
  while (p < s.length && s[p] === l[p]) p++;
  return w.slice(0, p) + (w === w.toUpperCase() ? s.slice(p).toUpperCase() : s.slice(p));
}

/** Name hint for array items / map values: `categories` → category, otherwise the key plus `suffix`. */
function itemHint(key: string, suffix: string): string {
  const ws = keyWords(key);
  const one = ws.length ? singularWord(ws[ws.length - 1]) : undefined;
  return (one ? [...ws.slice(0, -1), one] : [...ws, suffix]).join('_');
}

/** For a shape found under several keys: the trailing words most of them share (`billingAddress`, `shippingAddress`, `home` → Address). */
function sharedName(hints: string[]): string | undefined {
  const lists = hints.map(keyWords).filter((ws) => ws.length);
  const word = (ws: string[], i: number) => ws[ws.length - 1 - i]?.toLowerCase();
  const lasts = lists.map((ws) => word(ws, 0));
  let best: string | undefined;
  let count = 1;
  for (const w of lasts) {
    const n = lasts.filter((x) => x === w).length;
    if (n > count) [best, count] = [w, n];
  }
  const group = lists.filter((ws) => word(ws, 0) === best);
  if (!group.length) return undefined;
  let n = 1;
  while (group.every((ws) => ws.length > n && word(ws, n) === word(group[0], n))) n++;
  return group[0].slice(group[0].length - n).join('_');
}

interface Member {
  field: Field;
  name: string;
  /** The name differs from the JSON key, so the language's rename mechanism is needed. */
  renamed: boolean;
}

interface MemberStyle {
  cased(words: string[]): string;
  /** Prefix for names that would start with a digit. */
  digit: string;
  /** Separator before the numbers that make names unique. */
  sep: string;
  /** Escapes keywords and other names a member cannot have (`owner` is the type's name). */
  escape(name: string, owner: string): string;
  /** The JSON key a serializer derives from a member name. */
  wire(name: string): string;
}

/**
 * Member names of one type: idiomatic and unique. Keys that need no rename
 * claim their names first, then plain keys (`id` gets `ID` before `_id` does).
 */
function members(s: Shape, style: MemberStyle, owner: string): Member[] {
  const base = s.fields.map((f) => {
    const n = style.cased(keyWords(f.key)) || style.cased(['field']);
    return /^\d/.test(n) ? style.digit + n : n;
  });
  const rank = s.fields.map((f, i) => (style.wire(style.escape(base[i], owner)) === f.key ? 0 : /^[A-Za-z][A-Za-z\d]*$/.test(f.key) ? 1 : 2));
  const names: string[] = [];
  const used = new Set<string>();
  for (const r of [0, 1, 2]) {
    s.fields.forEach((_, i) => {
      if (rank[i] !== r) return;
      let name = style.escape(base[i], owner);
      for (let j = 2; used.has(name); j++) name = style.escape(base[i] + style.sep + j, owner);
      used.add((names[i] = name));
    });
  }
  return s.fields.map((field, i) => ({ field, name: names[i], renamed: style.wire(names[i]) !== field.key }));
}

/** Double-quoted literal: JSON escapes, or `\u{…}` (Rust, Swift) / `\$` (Kotlin) where the language needs them. */
function quote(s: string, style: 'json' | 'brace' | 'kotlin' = 'json'): string {
  if (style === 'json') return JSON.stringify(s);
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"' || ch === '\\' || (ch === '$' && style === 'kotlin')) out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += style === 'brace' ? `\\u{${c.toString(16)}}` : `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** The names from `table` that code uses outside string literals, for imports. */
function uses(code: string, table: [RegExp, string][]): string[] {
  const bare = code.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  return table.filter(([re]) => re.test(bare)).map(([, name]) => name);
}

// ---------------------------------------------------------------- TypeScript / Zod

const TS_RESERVED = set('Array Record Object String Number Boolean Symbol BigInt Date Map Set Promise Error Function JSON Math RegExp');
const tsKey = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

function tsExpr(t: Ty, ref: Ref): string {
  if (t.kind === 'any') return 'unknown';
  let s: string;
  if (t.kind === 'object') s = ref(t.shape!);
  else if (t.kind === 'array') {
    const item = tsExpr(t.of!, ref);
    s = item.includes(' | ') ? `Array<${item}>` : `${item}[]`;
  } else if (t.kind === 'map') s = `Record<string, ${tsExpr(t.of!, ref)}>`;
  else if (t.kind === 'string') s = t.values ? t.values.join(' | ') : 'string';
  else s = t.kind;
  return t.nullable ? `${s} | null` : s;
}

const typescript: Lang = {
  reserved: TS_RESERVED,
  typeName: pascal,
  expr: tsExpr,
  render(m) {
    const out: string[] = [];
    if (!m.root.shape) out.push(`export type ${m.rootName} = ${tsExpr(m.root, m.name)};`);
    for (const s of m.order) {
      const lines = s.fields.map((f) => `  ${tsKey(f.key)}${f.optional ? '?' : ''}: ${tsExpr(f.ty, m.name)};`);
      out.push(`export interface ${m.name(s)} {\n${lines.join('\n')}\n}`);
    }
    return `${out.join('\n\n')}\n`;
  },
};

function zodExpr(t: Ty, ref: Ref): string {
  if (t.kind === 'any') return 'z.unknown()';
  let s: string;
  if (t.kind === 'object') s = `${ref(t.shape!)}Schema`;
  else if (t.kind === 'array') s = `z.array(${zodExpr(t.of!, ref)})`;
  else if (t.kind === 'map') s = `z.record(z.string(), ${zodExpr(t.of!, ref)})`;
  else if (t.kind === 'string') s = t.values ? `z.enum([${t.values.join(', ')}])` : 'z.string()';
  else if (t.kind === 'number') s = t.num !== 'f64' && t.safe ? 'z.number().int()' : 'z.number()';
  else s = 'z.boolean()';
  return t.nullable ? `${s}.nullable()` : s;
}

const zod: Lang = {
  reserved: TS_RESERVED,
  typeName: pascal,
  expr: zodExpr,
  render(m) {
    const decl = (name: string, schema: string) => `export const ${name}Schema = ${schema};\nexport type ${name} = z.infer<typeof ${name}Schema>;`;
    // `__proto__: …` in an object literal would set the prototype instead of defining a key.
    const key = (k: string) => (k === '__proto__' ? '["__proto__"]' : tsKey(k));
    const out = ['import { z } from "zod";'];
    for (const s of m.deps) {
      const lines = s.fields.map((f) => `  ${key(f.key)}: ${zodExpr(f.ty, m.name)}${f.optional ? '.optional()' : ''},`);
      out.push(decl(m.name(s), `z.object({\n${lines.join('\n')}\n})`));
    }
    if (!m.root.shape) out.push(decl(m.rootName, zodExpr(m.root, m.name)));
    return `${out.join('\n\n')}\n`;
  },
};

// ---------------------------------------------------------------- Python (Pydantic v2)

const PY_MEMBER_RESERVED = set(
  'and as assert async await break class continue def del elif else except finally for from global if import in is lambda ' +
    'nonlocal not or pass raise return try while with yield str int float bool list dict copy json schema schema_json ' +
    'validate construct parse_obj parse_raw parse_file from_orm update_forward_refs model_config model_fields ' +
    'model_computed_fields model_extra model_fields_set model_construct model_copy model_dump model_dump_json ' +
    'model_json_schema model_parametrized_name model_post_init model_rebuild model_validate model_validate_json ' +
    'model_validate_strings',
);

const pyMembers: MemberStyle = {
  cased: snake,
  digit: 'n_',
  sep: '_',
  escape: (n) => (PY_MEMBER_RESERVED.has(n) ? `${n}_` : n),
  wire: (n) => n,
};

function pyExpr(t: Ty, ref: Ref): string {
  if (t.kind === 'any') return 'Any';
  let s: string;
  if (t.kind === 'object') s = ref(t.shape!);
  else if (t.kind === 'array') s = `list[${pyExpr(t.of!, ref)}]`;
  else if (t.kind === 'map') s = `dict[str, ${pyExpr(t.of!, ref)}]`;
  else if (t.kind === 'string') s = t.values ? `Literal[${t.values.join(', ')}]` : 'str';
  else if (t.kind === 'number') s = t.num === 'f64' ? 'float' : 'int';
  else s = 'bool';
  return t.nullable ? `Optional[${s}]` : s;
}

const python: Lang = {
  reserved: set('Any Literal Optional BaseModel ConfigDict Field RootModel None True False'),
  typeName: pascal,
  expr: pyExpr,
  render(m) {
    const classes: string[] = [];
    for (const s of m.deps) {
      const ms = members(s, pyMembers, m.name(s));
      const config: string[] = [];
      if (ms.some((x) => x.renamed)) config.push('populate_by_name=True');
      // Pydantic before 2.10 warns about any field in the `model_` namespace.
      if (ms.some((x) => x.name.startsWith('model_'))) config.push('protected_namespaces=()');
      const body = config.length ? [`model_config = ConfigDict(${config.join(', ')})`, ''] : [];
      for (const { field: f, name, renamed } of ms) {
        let type = pyExpr(f.ty, m.name);
        if (f.optional && type !== 'Any' && !type.startsWith('Optional[')) type = `Optional[${type}]`;
        const alias = renamed ? `alias=${quote(f.key)}` : '';
        const value = f.optional ? (alias ? ` = Field(default=None, ${alias})` : ' = None') : alias ? ` = Field(${alias})` : '';
        body.push(`${name}: ${type}${value}`);
      }
      classes.push(`class ${m.name(s)}(BaseModel):\n${body.map((l) => (l ? `    ${l}` : '')).join('\n')}`);
    }
    if (!m.root.shape) classes.push(`class ${m.rootName}(RootModel[${pyExpr(m.root, m.name)}]):\n    pass`);
    const code = classes.join('\n\n\n');
    const typing = uses(code, [
      [/\bAny\b/, 'Any'],
      [/\bLiteral\[/, 'Literal'],
      [/\bOptional\[/, 'Optional'],
    ]);
    const pydantic = uses(code, [
      [/\(BaseModel\)/, 'BaseModel'],
      [/\bConfigDict\(/, 'ConfigDict'],
      [/\bField\(/, 'Field'],
      [/\(RootModel\[/, 'RootModel'],
    ]);
    const head = [typing.length ? `from typing import ${typing.join(', ')}\n\n` : '', `from pydantic import ${pydantic.join(', ')}`].join('');
    return `${head}\n\n\n${code}\n`;
  },
};

// ---------------------------------------------------------------- Go

const goMembers: MemberStyle = { cased: goName, digit: 'N', sep: '', escape: (n) => n, wire: (n) => n };

/** Pointers for nullable or optional scalars and structs; slices, maps and `any` are nil-able already. */
function goExpr(t: Ty, ref: Ref, optional = false): string {
  const ptr = t.nullable || optional ? '*' : '';
  if (t.kind === 'any') return 'any';
  if (t.kind === 'array') return `[]${goExpr(t.of!, ref)}`;
  if (t.kind === 'map') return `map[string]${goExpr(t.of!, ref)}`;
  if (t.kind === 'object') return ptr + ref(t.shape!);
  if (t.kind === 'number') return ptr + (t.num === 'u64' ? 'uint64' : t.num === 'f64' ? 'float64' : 'int64');
  return ptr + (t.kind === 'string' ? 'string' : 'bool');
}

/** Tag names encoding/json accepts; for other keys it would fall back to the field name (or split at the comma). */
const GO_TAG_NAME = /^[\p{L}\p{Nd}!#$%&()*+\-./:;<=>?@[\]^_{|}~ ]+$/u;

function goTag(key: string, optional: boolean): { tag: string; note: string } {
  if (!GO_TAG_NAME.test(key)) return { tag: '`json:"-"`', note: `// encoding/json cannot map the key ${JSON.stringify(key)}; decode it by hand` };
  // `json:"-"` skips a field; the key "-" itself is spelled `-,`.
  const tag = `json:${JSON.stringify(key + (optional || key === '-' ? `,${optional ? 'omitempty' : ''}` : ''))}`;
  return { tag: tag.includes('`') ? JSON.stringify(tag) : `\`${tag}\``, note: '' };
}

/** Lines of `cells` padded to columns the way gofmt (tabwriter) aligns them: a column spans consecutive lines that continue past it. */
function gofmtColumns(rows: string[][]): string[] {
  const widths = rows.map((r) => r.map(() => 0));
  for (let c = 0; ; c++) {
    let any = false;
    for (let i = 0; i < rows.length; ) {
      if (rows[i].length <= c + 1) {
        i++;
        continue;
      }
      let j = i;
      while (j < rows.length && rows[j].length > c + 1) j++;
      const w = Math.max(...rows.slice(i, j).map((r) => r[c].length));
      for (let k = i; k < j; k++) widths[k][c] = w;
      any = true;
      i = j;
    }
    if (!any) break;
  }
  return rows.map((r, i) => r.map((cell, c) => (c < r.length - 1 ? cell.padEnd(widths[i][c]) : cell)).join(' '));
}

const go: Lang = {
  reserved: new Set(),
  typeName: goName,
  expr: (t, ref) => goExpr(t, ref),
  render(m) {
    const out = ['package model'];
    if (!m.root.shape) out.push(`type ${m.rootName} ${goExpr(m.root, m.name)}`);
    for (const s of m.order) {
      const rows = members(s, goMembers, m.name(s)).map(({ field: f, name }) => {
        const { tag, note } = goTag(f.key, f.optional);
        return [name, goExpr(f.ty, m.name, f.optional), tag, ...(note ? [note] : [])];
      });
      out.push(`type ${m.name(s)} struct {\n${gofmtColumns(rows).map((l) => `\t${l}`).join('\n')}\n}`);
    }
    return `${out.join('\n\n')}\n`;
  },
};

// ---------------------------------------------------------------- Rust (serde)

const RUST_KEYWORDS = set(
  'as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self ' +
    'static struct super trait true type unsafe use where while async await dyn abstract become box do final macro ' +
    'override priv typeof unsized virtual yield try gen',
);

const rustMembers: MemberStyle = {
  cased: snake,
  digit: 'n_',
  sep: '_',
  // serde strips `r#`, so raw identifiers need no rename; these three cannot be raw.
  escape: (n) => (!RUST_KEYWORDS.has(n) ? n : /^(crate|self|super)$/.test(n) ? `${n}_` : `r#${n}`),
  wire: (n) => n.replace(/^r#/, ''),
};

function rustExpr(t: Ty, ref: Ref): string {
  if (t.kind === 'any') return 'serde_json::Value';
  let s: string;
  if (t.kind === 'object') s = ref(t.shape!);
  else if (t.kind === 'array') s = `Vec<${rustExpr(t.of!, ref)}>`;
  else if (t.kind === 'map') s = `HashMap<String, ${rustExpr(t.of!, ref)}>`;
  else if (t.kind === 'number') s = t.num === 'u64' ? 'u64' : t.num === 'f64' ? 'f64' : 'i64';
  else s = t.kind === 'string' ? 'String' : 'bool';
  return t.nullable ? `Option<${s}>` : s;
}

const rust: Lang = {
  reserved: set(
    'Self Option Some None Result Ok Err Vec String Box HashMap Serialize Deserialize Clone Copy Default Debug PartialEq Eq ' +
      'Send Sync Sized Drop Fn Iterator From Into ToString ToOwned',
  ),
  typeName: pascal,
  expr: rustExpr,
  render(m) {
    const out: string[] = [];
    if (!m.root.shape) out.push(`pub type ${m.rootName} = ${rustExpr(m.root, m.name)};`);
    for (const s of m.order) {
      const lines: string[] = [];
      for (const { field: f, name, renamed } of members(s, rustMembers, m.name(s))) {
        let type = rustExpr(f.ty, m.name);
        if (f.optional && !type.startsWith('Option<')) type = `Option<${type}>`;
        const attrs = [renamed ? `rename = ${quote(f.key, 'brace')}` : '', f.optional ? 'default, skip_serializing_if = "Option::is_none"' : ''];
        if (renamed || f.optional) lines.push(`    #[serde(${attrs.filter(Boolean).join(', ')})]`);
        lines.push(`    pub ${name}: ${type},`);
      }
      out.push(`#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\npub struct ${m.name(s)} {\n${lines.join('\n')}\n}`);
    }
    const code = out.join('\n\n');
    const head = [m.order.length ? 'use serde::{Deserialize, Serialize};' : '', ...uses(code, [[/\bHashMap</, 'use std::collections::HashMap;']])];
    return `${[head.filter(Boolean).join('\n'), code].filter(Boolean).join('\n\n')}\n`;
  },
};

// ---------------------------------------------------------------- C# (System.Text.Json)

const CS_MEMBER_RESERVED = set('Equals GetHashCode GetType ToString MemberwiseClone ReferenceEquals Finalize');

const csMembers: MemberStyle = {
  cased: pascal,
  digit: 'N',
  sep: '',
  // A member cannot share its class's name.
  escape: (n, owner) => (n === owner || CS_MEMBER_RESERVED.has(n) ? `${n}Value` : n),
  wire: (n) => n,
};

const CS_NUM: Record<NumKind, string> = { i32: 'int', i64: 'long', u64: 'ulong', f64: 'double' };

function csExpr(t: Ty, ref: Ref): string {
  let s: string;
  if (t.kind === 'any') s = 'JsonElement';
  else if (t.kind === 'object') s = ref(t.shape!);
  else if (t.kind === 'array') s = `List<${csExpr(t.of!, ref)}>`;
  else if (t.kind === 'map') s = `Dictionary<string, ${csExpr(t.of!, ref)}>`;
  else if (t.kind === 'number') s = CS_NUM[t.num!];
  else s = t.kind === 'string' ? 'string' : 'bool';
  return t.nullable ? `${s}?` : s;
}

/** `using` alias targets for a primitive root. */
const CS_SYSTEM: Record<string, string> = {
  string: 'System.String',
  int: 'System.Int32',
  long: 'System.Int64',
  ulong: 'System.UInt64',
  double: 'System.Double',
  bool: 'System.Boolean',
  JsonElement: 'System.Text.Json.JsonElement',
};

const csharp: Lang = {
  reserved: set('List Dictionary JsonElement JsonPropertyName JsonPropertyNameAttribute JsonSerializer Object String System'),
  typeName: pascal,
  expr: csExpr,
  render(m) {
    const classes: string[] = [];
    const head: string[] = [];
    const root = m.root.shape ? '' : csExpr({ ...m.root, nullable: false }, m.name);
    if (m.root.kind === 'array' || m.root.kind === 'map') classes.push(`public class ${m.rootName} : ${root}\n{\n}`);
    else if (root) head.push(`using ${m.rootName} = ${CS_SYSTEM[root]};`);
    for (const s of m.order) {
      const owner = m.name(s);
      const props = members(s, csMembers, owner).map(({ field: f, name }) => {
        let type = csExpr(f.ty, m.name);
        if (f.optional && !type.endsWith('?')) type += '?';
        const init = type.endsWith('?') ? '' : f.ty.kind === 'string' ? ' = "";' : /^(object|array|map)$/.test(f.ty.kind) ? ' = new();' : '';
        return `    [JsonPropertyName(${quote(f.key)})]\n    public ${type} ${name} { get; set; }${init}`;
      });
      classes.push(`public class ${owner}\n{\n${props.join('\n\n')}\n}`);
    }
    const code = classes.join('\n\n');
    const usings = uses(code, [
      [/\b(List|Dictionary)</, 'using System.Collections.Generic;'],
      [/\bJsonElement\b/, 'using System.Text.Json;'],
      [/\[JsonPropertyName\(/, 'using System.Text.Json.Serialization;'],
    ]);
    const header = [...(classes.length ? ['#nullable enable'] : []), ...usings, ...head].join('\n');
    return `${[header, code].filter(Boolean).join('\n\n')}\n`;
  },
};

// ---------------------------------------------------------------- Kotlin (kotlinx.serialization)

const KOTLIN_KEYWORDS = set(
  'as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while',
);

const kotlinMembers: MemberStyle = {
  cased: camel,
  digit: 'n',
  sep: '',
  // A `class` property's JVM getter would be getClass().
  escape: (n) => (n === 'class' ? 'clazz' : KOTLIN_KEYWORDS.has(n) ? `\`${n}\`` : n),
  wire: (n) => n.replace(/`/g, ''),
};

const KOTLIN_NUM: Record<NumKind, string> = { i32: 'Int', i64: 'Long', u64: 'ULong', f64: 'Double' };

function kotlinExpr(t: Ty, ref: Ref): string {
  let s: string;
  if (t.kind === 'any') s = 'JsonElement';
  else if (t.kind === 'object') s = ref(t.shape!);
  else if (t.kind === 'array') s = `List<${kotlinExpr(t.of!, ref)}>`;
  else if (t.kind === 'map') s = `Map<String, ${kotlinExpr(t.of!, ref)}>`;
  else if (t.kind === 'number') s = KOTLIN_NUM[t.num!];
  else s = t.kind === 'string' ? 'String' : 'Boolean';
  return t.nullable ? `${s}?` : s;
}

const kotlin: Lang = {
  reserved: set(
    'Any Boolean Byte Char Double Float Int Long Short String Unit Nothing List Map Set Array Number ULong UInt Pair Triple ' +
      'Serializable SerialName JsonElement Transient Required Comparable Enum Throwable Exception Error',
  ),
  typeName: pascal,
  expr: kotlinExpr,
  render(m) {
    const out: string[] = [];
    if (!m.root.shape) out.push(`typealias ${m.rootName} = ${kotlinExpr(m.root, m.name)}`);
    for (const s of m.order) {
      const params = members(s, kotlinMembers, m.name(s)).map(({ field: f, name, renamed }) => {
        let type = kotlinExpr(f.ty, m.name);
        if (f.optional && !type.endsWith('?')) type += '?';
        return `    ${renamed ? `@SerialName(${quote(f.key, 'kotlin')}) ` : ''}val ${name}: ${type}${f.optional ? ' = null' : ''},`;
      });
      out.push(`@Serializable\ndata class ${m.name(s)}(\n${params.join('\n')}\n)`);
    }
    const code = out.join('\n\n');
    const imports = [...(m.order.length ? ['import kotlinx.serialization.*'] : []), ...uses(code, [[/\bJsonElement\b/, 'import kotlinx.serialization.json.JsonElement']])];
    return `${[imports.join('\n'), code].filter(Boolean).join('\n\n')}\n`;
  },
};

// ---------------------------------------------------------------- Swift (Codable)

const SWIFT_KEYWORDS = set(
  'associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private ' +
    'precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default ' +
    'defer do else fallthrough for guard if in repeat return throw switch where while as await false is nil super throws ' +
    'true try',
);

const swiftMembers: MemberStyle = {
  cased: camel,
  digit: 'n',
  sep: '',
  // `self` and the special declaration names are not safe even in backticks.
  escape: (n) => (/^(self|init|deinit|subscript)$/.test(n) ? `${n}Value` : SWIFT_KEYWORDS.has(n) ? `\`${n}\`` : n),
  wire: (n) => n.replace(/`/g, ''),
};

function swiftExpr(t: Ty, ref: Ref): string {
  let s: string;
  if (t.kind === 'any') s = 'JSONValue';
  else if (t.kind === 'object') s = ref(t.shape!);
  else if (t.kind === 'array') s = `[${swiftExpr(t.of!, ref)}]`;
  else if (t.kind === 'map') s = `[String: ${swiftExpr(t.of!, ref)}]`;
  else if (t.kind === 'number') s = t.num === 'u64' ? 'UInt64' : t.num === 'f64' ? 'Double' : 'Int';
  else s = t.kind === 'string' ? 'String' : 'Bool';
  return t.nullable ? `${s}?` : s;
}

/** Any JSON value, for positions whose type varies. */
const SWIFT_JSON_VALUE = `enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}`;

const swift: Lang = {
  reserved: set(
    'String Int Double Bool Array Dictionary Optional Any AnyObject Type Protocol Self JSONValue Codable Decodable Encodable ' +
      'Hashable Equatable CodingKey CodingKeys Decoder Encoder Data Date URL UUID Error Character Float Set Never Void UInt64',
  ),
  typeName: pascal,
  expr: swiftExpr,
  render(m) {
    const out: string[] = [];
    if (!m.root.shape) out.push(`typealias ${m.rootName} = ${swiftExpr(m.root, m.name)}`);
    for (const s of m.order) {
      const ms = members(s, swiftMembers, m.name(s));
      const props = ms.map(({ field: f, name }) => {
        let type = swiftExpr(f.ty, m.name);
        if (f.optional && !type.endsWith('?')) type += '?';
        return `    let ${name}: ${type}`;
      });
      // Declared CodingKeys must list every property; only renamed ones need a raw value.
      const keys = ms.some((x) => x.renamed)
        ? [``, `    enum CodingKeys: String, CodingKey {`, ...ms.map((x) => `        case ${x.name}${x.renamed ? ` = ${quote(x.field.key, 'brace')}` : ''}`), `    }`]
        : [];
      out.push(`struct ${m.name(s)}: Codable {\n${[...props, ...keys].join('\n')}\n}`);
    }
    const code = out.join('\n\n');
    return `${uses(code, [[/\bJSONValue\b/, 'JSONValue']]).length ? `${code}\n\n${SWIFT_JSON_VALUE}` : code}\n`;
  },
};

// ---------------------------------------------------------------- Java (Jackson)

const JAVA_KEYWORDS = set(
  'abstract assert boolean break byte case catch char class const continue default do double else enum extends final ' +
    'finally float for goto if implements import instanceof int interface long native new package private protected public ' +
    'return short static strictfp super switch synchronized this throw throws transient try void volatile while true false ' +
    'null var yield record sealed permits',
);

const javaMembers: MemberStyle = {
  cased: camel,
  digit: 'n',
  sep: '',
  escape: (n) => (JAVA_KEYWORDS.has(n) ? `${n}_` : n),
  wire: (n) => n,
};

/** Boxed types where null must be representable and in generic arguments. */
function javaExpr(t: Ty, ref: Ref, boxed = false): string {
  const box = boxed || t.nullable;
  if (t.kind === 'any') return 'JsonNode';
  if (t.kind === 'object') return ref(t.shape!);
  if (t.kind === 'array') return `List<${javaExpr(t.of!, ref, true)}>`;
  if (t.kind === 'map') return `Map<String, ${javaExpr(t.of!, ref, true)}>`;
  if (t.kind === 'string') return 'String';
  if (t.kind === 'boolean') return box ? 'Boolean' : 'boolean';
  if (t.num === 'u64') return 'BigInteger';
  if (t.num === 'f64') return box ? 'Double' : 'double';
  return t.num === 'i64' ? (box ? 'Long' : 'long') : box ? 'Integer' : 'int';
}

const java: Lang = {
  reserved: set(
    'Object String Integer Long Double Float Short Byte Character Boolean Number Math System Class Enum Record Void Thread ' +
      'Runtime Process Exception Error Throwable Iterable Comparable Override Deprecated List Map ArrayList HashMap JsonNode ' +
      'JsonProperty JsonIgnoreProperties BigInteger',
  ),
  typeName: pascal,
  expr: (t, ref) => javaExpr(t, ref),
  render(m) {
    // One public class per file: the root; the others are package-private.
    const out: string[] = [];
    if (m.root.kind === 'array') out.push(`public class ${m.rootName} extends ArrayList<${javaExpr(m.root.of!, m.name, true)}> {\n}`);
    else if (m.root.kind === 'map') out.push(`public class ${m.rootName} extends HashMap<String, ${javaExpr(m.root.of!, m.name, true)}> {\n}`);
    else if (!m.root.shape) out.push(`// The document is a single ${javaExpr(m.root, m.name, true)} value; no classes are needed.`);
    for (const s of m.order) {
      const ms = members(s, javaMembers, m.name(s));
      const fields = ms
        .filter((x) => x.field.key !== '')
        .map(({ field: f, name, renamed }) => `${renamed ? `    @JsonProperty(${quote(f.key)})\n` : ''}    public ${javaExpr(f.ty, m.name, f.optional)} ${name};`);
      // @JsonProperty("") means "the field's own name", so an empty key cannot be bound: accept and skip it.
      const ignore = fields.length < ms.length ? '@JsonIgnoreProperties({""})\n' : '';
      out.push(`${ignore}${m.name(s) === m.rootName ? 'public ' : ''}class ${m.name(s)} {\n${fields.join('\n')}\n}`);
    }
    const code = out.join('\n\n');
    const imports = uses(code, [
      [/@JsonIgnoreProperties\(/, 'import com.fasterxml.jackson.annotation.JsonIgnoreProperties;'],
      [/@JsonProperty\(/, 'import com.fasterxml.jackson.annotation.JsonProperty;'],
      [/\bJsonNode\b/, 'import com.fasterxml.jackson.databind.JsonNode;'],
      [/\bBigInteger\b/, 'import java.math.BigInteger;'],
      [/\bArrayList</, 'import java.util.ArrayList;'],
      [/\bHashMap</, 'import java.util.HashMap;'],
      [/\bList</, 'import java.util.List;'],
      [/\bMap</, 'import java.util.Map;'],
    ]);
    return `${[imports.join('\n'), code].filter(Boolean).join('\n\n')}\n`;
  },
};

const LANGS: Record<TypeTarget, Lang> = { typescript, zod, python, go, rust, csharp, kotlin, swift, java };
