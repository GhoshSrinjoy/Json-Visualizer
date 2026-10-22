/** High-level code analysis API used by the extension, CLI and MCP server. */

import './languages';

export { findAtLine, findById, findByName, flattenSymbols, MODULE_SYMBOL } from './symbols';
export type { FunctionAnalysis } from './model';
import { buildFlowGraph } from './cfg';
import { buildDataFlow } from './dataflow';
import { fallbackOutline } from './fallback';
import { IRConverter } from './ir';
import type { CodeOutline, CodeSymbol, FunctionAnalysis } from './model';
import { findAtLine, findById, MODULE_SYMBOL } from './symbols';
import { countLines } from './loc';
import { languageFor, type LanguageInfo } from './registry';
import { complexity, SymbolBuilder, type LanguageSpec } from './spec';
import { countErrors, rangeOf } from './syntax';
import { isTreeSitterConfigured, parseCode, type SyntaxNode } from './treesitter';

/**
 * Outlines by path and content, least recently used first, bounded by an estimate of their
 * memory in bytes (see `analyzeCode`): a workspace call graph over thousands of files fits, so
 * a focused second pass does not parse everything again.
 */
const cache = new Map<string, { outline: CodeOutline; size: number }>();
const CACHE_BUDGET = 128 * 1024 * 1024;
let cachedSize = 0;

function remember(key: string, outline: CodeOutline, size: number): void {
  const old = cache.get(key);
  if (old) {
    cache.delete(key);
    cachedSize -= old.size;
  }
  cache.set(key, { outline, size });
  cachedSize += size;
  while (cachedSize > CACHE_BUDGET && cache.size > 1) {
    const [k, v] = cache.entries().next().value!;
    cache.delete(k);
    cachedSize -= v.size;
  }
}

/** FNV-1a over the full text: cheap enough (~1 ms/MB) to key caches safely. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + text.length.toString(36);
}

export function isCodeFile(path: string, languageId?: string): boolean {
  return languageFor(path, languageId) !== undefined;
}

/** Symbols, imports and exports of a source file (undefined for non-code files). */
export async function analyzeCode(path: string, text: string, languageId?: string): Promise<CodeOutline | undefined> {
  const lang = languageFor(path, languageId);
  if (!lang) return undefined;
  const key = `${path}\0${lang.id}\0${hashText(text)}`;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used goes last.
    cache.delete(key);
    cache.set(key, hit);
    return hit.outline;
  }
  const outline = lang.spec && isTreeSitterConfigured() ? await outlineWithGrammar(path, text, lang) : fallbackOutline(path, text, lang);
  // An outline (symbols, calls, ranges) takes about 3 bytes per source character.
  remember(key, outline, 3 * text.length + key.length);
  return outline;
}

async function outlineWithGrammar(path: string, text: string, lang: LanguageInfo): Promise<CodeOutline> {
  const started = now();
  const spec = lang.spec!;
  const tree = await parseCode(spec.grammar, text);
  try {
    const b = new SymbolBuilder(spec);
    const parts = spec.outline(tree.rootNode, b);
    const { lines, loc } = countLines(text, spec);
    return {
      path,
      language: lang.id,
      languageName: lang.name,
      lines,
      loc,
      imports: parts.imports,
      exports: parts.exports,
      symbols: parts.symbols,
      syntaxErrors: countErrors(tree.rootNode),
      parseMs: now() - started,
    };
  } finally {
    tree.delete();
  }
}

/** Flow and data-flow graphs for one function (by symbol id or by a line inside it). */
export async function analyzeFunction(
  path: string,
  text: string,
  target: { symbolId?: string; line?: number },
  languageId?: string,
): Promise<FunctionAnalysis | undefined> {
  const lang = languageFor(path, languageId);
  if (!lang?.spec || !isTreeSitterConfigured()) return undefined;
  const spec = lang.spec;
  const tree = await parseCode(spec.grammar, text);
  try {
    const b = new SymbolBuilder(spec);
    const parts = spec.outline(tree.rootNode, b);
    if (target.symbolId === MODULE_SYMBOL) return moduleAnalysis(tree.rootNode, spec, path);
    const sym = target.symbolId ? findById(parts.symbols, target.symbolId) : target.line !== undefined ? findAtLine(parts.symbols, target.line) : undefined;
    if (!sym) return target.line !== undefined && !target.symbolId ? moduleAnalysis(tree.rootNode, spec, path) : undefined;
    const node = b.nodes.get(sym.id);
    if (!node) return undefined;
    return functionAnalysis(node, sym, spec);
  } finally {
    tree.delete();
  }
}

function functionAnalysis(node: SyntaxNode, sym: CodeSymbol, spec: LanguageSpec): FunctionAnalysis {
  const conv = new IRConverter(spec.flow);
  const bodyNode = spec.functionBody(node);
  const ir = conv.body(bodyNode);
  const opts = { name: sym.name, symbolId: sym.id, signature: sym.signature, range: sym.range };
  return {
    symbol: sym,
    // The same count as the outline's `sym.complexity`.
    flow: buildFlowGraph(ir, { ...opts, complexity: bodyNode ? complexity(bodyNode, spec) : 1 }),
    data: buildDataFlow(node, bodyNode, ir, spec, opts),
  };
}

function moduleAnalysis(root: SyntaxNode, spec: LanguageSpec, path: string): FunctionAnalysis {
  const conv = new IRConverter({ ...spec.flow, blocks: [...spec.flow.blocks, root.type] });
  const ir = conv.stmts(root);
  const name = path.split(/[\\/]/).pop() ?? MODULE_SYMBOL;
  const range = rangeOf(root);
  const cx = complexity(root, spec);
  const sym: CodeSymbol = { id: MODULE_SYMBOL, name, kind: 'module', range, hasBody: true, complexity: cx };
  const opts = { name, symbolId: MODULE_SYMBOL, range };
  return { symbol: sym, flow: buildFlowGraph(ir, { ...opts, complexity: cx }), data: buildDataFlow(root, root, ir, spec, opts) };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
