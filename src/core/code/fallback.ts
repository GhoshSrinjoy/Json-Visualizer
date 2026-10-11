/**
 * Regex-based outline for languages without a bundled grammar. Finds
 * classes/functions/imports line by line and nests by brace depth or
 * indentation. Marked `approximate` so the UI can say so.
 */

import { countLines } from './loc';
import type { CodeOutline, CodeSymbol, ImportRef, SymbolKind } from './model';
import type { LanguageInfo } from './registry';

interface Pattern {
  re: RegExp;
  kind: SymbolKind | ((m: RegExpExecArray) => SymbolKind);
  /** Capture group holding the name. */
  name: number;
}

interface FallbackRules {
  symbols: Pattern[];
  imports: { re: RegExp; source: number }[];
  /** Nest by indentation (Python-like) instead of braces. */
  indent?: boolean;
  lineComment: string[];
}

const C_LIKE_COMMENT = ['//'];

const RULES: Record<string, FallbackRules> = {
  kotlin: {
    symbols: [
      { re: /^\s*(?:(?:public|private|internal|protected|open|abstract|sealed|data|enum|annotation|inner|value)\s+)*(class|interface|object)\s+(\w+)/, kind: (m) => (m[1] === 'interface' ? 'interface' : 'class'), name: 2 },
      { re: /^\s*(?:(?:public|private|internal|protected|open|override|suspend|inline|operator|infix|tailrec|abstract)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.<>?]+\.)?(\w+)\s*\(/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*import\s+([\w.*]+)/, source: 1 }],
    lineComment: C_LIKE_COMMENT,
  },
  swift: {
    symbols: [
      { re: /^\s*(?:(?:public|private|internal|fileprivate|open|final)\s+)*(class|struct|enum|protocol|extension|actor)\s+(\w+)/, kind: (m) => (m[1] === 'protocol' ? 'interface' : m[1] === 'struct' ? 'struct' : m[1] === 'enum' ? 'enum' : 'class'), name: 2 },
      { re: /^\s*(?:(?:public|private|internal|fileprivate|open|static|class|override|mutating|final|@\w+)\s+)*func\s+(\w+)/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*import\s+(\w+)/, source: 1 }],
    lineComment: C_LIKE_COMMENT,
  },
  scala: {
    symbols: [
      { re: /^\s*(?:(?:case|abstract|final|sealed|private|protected|implicit)\s+)*(class|object|trait|enum)\s+(\w+)/, kind: (m) => (m[1] === 'trait' ? 'trait' : m[1] === 'enum' ? 'enum' : 'class'), name: 2 },
      { re: /^\s*(?:(?:override|private|protected|final|implicit|inline)\s+)*def\s+(\w+)/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*import\s+([\w.{},*\s]+)/, source: 1 }],
    lineComment: C_LIKE_COMMENT,
  },
  dart: {
    symbols: [
      { re: /^\s*(?:abstract\s+)?(class|mixin|extension|enum)\s+(\w+)/, kind: (m) => (m[1] === 'enum' ? 'enum' : 'class'), name: 2 },
      { re: /^\s*(?:static\s+|async\s+|external\s+)*(?:[\w<>?,\[\]]+\s+)?(\w+)\s*\([^;]*\)\s*(?:async\*?\s*)?(?:\{|=>)/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*(?:import|export)\s+['"]([^'"]+)['"]/, source: 1 }],
    lineComment: C_LIKE_COMMENT,
  },
  lua: {
    symbols: [{ re: /^\s*(?:local\s+)?function\s+([\w.:]+)\s*\(/, kind: 'function', name: 1 }],
    imports: [{ re: /require\s*\(?\s*['"]([^'"]+)['"]/, source: 1 }],
    indent: false,
    lineComment: ['--'],
  },
  elixir: {
    symbols: [
      { re: /^\s*defmodule\s+([\w.]+)/, kind: 'module', name: 1 },
      { re: /^\s*defp?\s+(\w+[?!]?)/, kind: 'function', name: 1 },
      { re: /^\s*defmacrop?\s+(\w+)/, kind: 'macro', name: 1 },
    ],
    imports: [{ re: /^\s*(?:alias|import|use|require)\s+([\w.]+)/, source: 1 }],
    indent: true,
    lineComment: ['#'],
  },
  perl: {
    symbols: [
      { re: /^\s*package\s+([\w:]+)/, kind: 'module', name: 1 },
      { re: /^\s*sub\s+(\w+)/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*(?:use|require)\s+([\w:]+)/, source: 1 }],
    lineComment: ['#'],
  },
  r: {
    symbols: [{ re: /^\s*([\w.]+)\s*(?:<-|=)\s*function\s*\(/, kind: 'function', name: 1 }],
    imports: [{ re: /(?:library|require)\(\s*['"]?([\w.]+)/, source: 1 }],
    lineComment: ['#'],
  },
  julia: {
    symbols: [
      { re: /^\s*(?:mutable\s+)?struct\s+(\w+)/, kind: 'struct', name: 1 },
      { re: /^\s*module\s+(\w+)/, kind: 'module', name: 1 },
      { re: /^\s*function\s+([\w.!]+)/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*(?:using|import)\s+([\w.]+)/, source: 1 }],
    indent: true,
    lineComment: ['#'],
  },
  groovy: {
    symbols: [
      { re: /^\s*(?:(?:public|private|protected|abstract|final|static)\s+)*(class|interface|enum|trait)\s+(\w+)/, kind: (m) => (m[1] === 'interface' ? 'interface' : 'class'), name: 2 },
      { re: /^\s*(?:(?:public|private|protected|static|final|def|void|[\w<>]+)\s+)+(\w+)\s*\([^)]*\)\s*\{/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*import\s+([\w.*]+)/, source: 1 }],
    lineComment: C_LIKE_COMMENT,
  },
  'objective-c': {
    symbols: [
      { re: /^\s*@(interface|implementation|protocol)\s+(\w+)/, kind: (m) => (m[1] === 'protocol' ? 'interface' : 'class'), name: 2 },
      { re: /^\s*[-+]\s*\([^)]*\)\s*(\w+)/, kind: 'method', name: 1 },
    ],
    imports: [{ re: /^\s*#(?:import|include)\s+["<]([^">]+)[">]/, source: 1 }],
    lineComment: C_LIKE_COMMENT,
  },
  shellscript: {
    symbols: [{ re: /^\s*(?:function\s+)?([\w:.-]+)\s*\(\)\s*\{?|^\s*function\s+([\w:.-]+)/, kind: 'function', name: 1 }],
    imports: [{ re: /^\s*(?:source|\.)\s+(\S+)/, source: 1 }],
    lineComment: ['#'],
  },
  powershell: {
    symbols: [
      { re: /^\s*class\s+(\w+)/i, kind: 'class', name: 1 },
      { re: /^\s*function\s+([\w-]+)/i, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*(?:Import-Module|using\s+module|\.)\s+(\S+)/i, source: 1 }],
    lineComment: ['#'],
  },
  fsharp: {
    symbols: [
      { re: /^\s*module\s+([\w.]+)/, kind: 'module', name: 1 },
      { re: /^\s*type\s+(\w+)/, kind: 'type', name: 1 },
      { re: /^\s*(?:let|member)\s+(?:rec\s+|inline\s+|private\s+)*(?:\w+\.)?(\w+)\s*(?:\(|\w)/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*open\s+([\w.]+)/, source: 1 }],
    indent: true,
    lineComment: ['//'],
  },
  vb: {
    symbols: [
      { re: /^\s*(?:(?:Public|Private|Friend|Protected|Partial|MustInherit|NotInheritable)\s+)*(Class|Module|Interface|Structure|Enum)\s+(\w+)/i, kind: (m) => (/interface/i.test(m[1]) ? 'interface' : /module/i.test(m[1]) ? 'module' : 'class'), name: 2 },
      { re: /^\s*(?:(?:Public|Private|Friend|Protected|Shared|Overrides|Overridable|Async)\s+)*(?:Sub|Function)\s+(\w+)/i, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*Imports\s+([\w.]+)/i, source: 1 }],
    indent: true,
    lineComment: ["'"],
  },
  zig: {
    symbols: [
      { re: /^\s*(?:pub\s+)?const\s+(\w+)\s*=\s*(?:struct|enum|union)/, kind: 'struct', name: 1 },
      { re: /^\s*(?:pub\s+)?(?:export\s+)?fn\s+(\w+)/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /@import\(\s*"([^"]+)"/, source: 1 }],
    lineComment: C_LIKE_COMMENT,
  },
  nim: {
    symbols: [
      { re: /^\s*type\s+(\w+)/, kind: 'type', name: 1 },
      { re: /^\s*(?:proc|func|method|iterator|template|macro)\s+(\w+)/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*(?:import|include|from)\s+([\w/.]+)/, source: 1 }],
    indent: true,
    lineComment: ['#'],
  },
  haskell: {
    symbols: [
      { re: /^module\s+([\w.]+)/, kind: 'module', name: 1 },
      { re: /^(?:data|newtype|type|class)\s+(\w+)/, kind: 'type', name: 1 },
      { re: /^(\w+)\s*::/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^import\s+(?:qualified\s+)?([\w.]+)/, source: 1 }],
    lineComment: ['--'],
  },
  ocaml: {
    symbols: [
      { re: /^\s*module\s+(\w+)/, kind: 'module', name: 1 },
      { re: /^\s*type\s+(\w+)/, kind: 'type', name: 1 },
      { re: /^\s*let\s+(?:rec\s+)?(\w+)/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*open\s+(\w+)/, source: 1 }],
    lineComment: [],
  },
  clojure: {
    symbols: [
      { re: /^\s*\(ns\s+([\w.-]+)/, kind: 'module', name: 1 },
      { re: /^\s*\(defn-?\s+([\w!?*<>=-]+)/, kind: 'function', name: 1 },
      { re: /^\s*\(def(?:record|type|protocol)\s+(\w+)/, kind: 'class', name: 1 },
    ],
    imports: [{ re: /\(:require\s+\[([\w.-]+)/, source: 1 }],
    lineComment: [';'],
  },
  erlang: {
    symbols: [
      { re: /^-module\((\w+)\)/, kind: 'module', name: 1 },
      { re: /^([a-z]\w*)\s*\(.*\)\s*(?:when.*)?->/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^-(?:import|include)\(\s*"?([\w./]+)/, source: 1 }],
    lineComment: ['%'],
  },
  solidity: {
    symbols: [
      { re: /^\s*(?:abstract\s+)?(contract|interface|library)\s+(\w+)/, kind: (m) => (m[1] === 'interface' ? 'interface' : 'class'), name: 2 },
      { re: /^\s*(?:function|modifier)\s+(\w+)/, kind: 'function', name: 1 },
      { re: /^\s*(?:event|struct|enum)\s+(\w+)/, kind: 'type', name: 1 },
    ],
    imports: [{ re: /^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/, source: 1 }],
    lineComment: C_LIKE_COMMENT,
  },
  vue: {
    symbols: [
      { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, kind: 'function', name: 1 },
      { re: /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/, kind: 'function', name: 1 },
    ],
    imports: [{ re: /^\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/, source: 1 }],
    lineComment: C_LIKE_COMMENT,
  },
};
RULES.svelte = RULES.vue;

export function fallbackOutline(path: string, text: string, lang: LanguageInfo): CodeOutline {
  const started = Date.now();
  const rules = RULES[lang.id] ?? { symbols: [], imports: [], lineComment: ['//', '#'] };
  const symbols: CodeSymbol[] = [];
  const imports: ImportRef[] = [];
  // Open scopes: brace languages track the depth where the body opened,
  // indentation languages track the declaration's indent.
  const stack: { sym: CodeSymbol; level: number; opened: boolean }[] = [];
  const used = new Set<string>();
  const lines = text.split(/\r?\n/);
  let depth = 0;

  const close = (i: number) => {
    const top = stack.pop()!;
    top.sym.range.end = { line: Math.max(top.sym.range.start.line, i), col: 0 };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || rules.lineComment.some((c) => c && trimmed.startsWith(c))) continue;
    const indent = line.length - line.trimStart().length;

    if (rules.indent) {
      while (stack.length && indent <= stack[stack.length - 1].level) close(i - 1);
    } else {
      // A declaration whose body did not open on its own line opens on this
      // line (Allman braces) or was a one-liner.
      const top = stack[stack.length - 1];
      if (top && !top.opened) {
        if (trimmed.startsWith('{')) top.opened = true;
        else close(i - 1);
      }
    }

    for (const imp of rules.imports) {
      const m = imp.re.exec(line);
      if (m && m[imp.source]) imports.push({ source: m[imp.source].trim(), names: [{ name: '*' }], kind: 'import', line: i });
    }

    let found: CodeSymbol | undefined;
    for (const pat of rules.symbols) {
      const m = pat.re.exec(line);
      if (!m) continue;
      const name = m[pat.name] ?? m[pat.name + 1];
      if (!name) continue;
      const kind = typeof pat.kind === 'function' ? pat.kind(m) : pat.kind;
      const parent = stack.length ? stack[stack.length - 1].sym : null;
      const finalKind: SymbolKind = kind === 'function' && parent && /class|struct|interface|trait|module/.test(parent.kind) ? 'method' : kind;
      let id = parent ? `${parent.id}.${name}` : name;
      if (used.has(id)) id = `${id}@${i + 1}`;
      used.add(id);
      found = { id, name, kind: finalKind, range: { start: { line: i, col: 0 }, end: { line: i, col: line.length } }, hasBody: false };
      if (parent) (parent.children ??= []).push(found);
      else symbols.push(found);
      break;
    }

    if (rules.indent) {
      if (found) stack.push({ sym: found, level: indent, opened: true });
      continue;
    }
    const before = depth;
    depth += braceDelta(line);
    if (found) {
      const opened = depth > before;
      stack.push({ sym: found, level: before, opened });
      // `fun f() = x` or `function f() { … }` on one line: nothing stays open.
      if (!opened && /[;=]|\}\s*$/.test(trimmed) && !trimmed.endsWith('{')) close(i);
    }
    while (stack.length && stack[stack.length - 1].opened && depth <= stack[stack.length - 1].level) close(i);
  }
  while (stack.length) close(lines.length - 1);
  const { lines: total, loc } = countLines(text, { lineComment: rules.lineComment });
  return {
    path,
    language: lang.id,
    languageName: lang.name,
    lines: total,
    loc,
    imports,
    exports: [],
    symbols,
    syntaxErrors: 0,
    parseMs: Date.now() - started,
    approximate: true,
  };
}

function braceDelta(line: string): number {
  let d = 0;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') break;
    else if (c === '{') d++;
    else if (c === '}') d--;
  }
  return d;
}
