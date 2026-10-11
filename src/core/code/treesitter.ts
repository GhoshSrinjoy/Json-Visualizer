/**
 * Environment-agnostic tree-sitter loader. Hosts (Node, browser, worker)
 * supply wasm bytes through a WasmSource, so the same analysis code runs in
 * the VS Code extension host, the MCP server and the web UI.
 */

import { Language, Parser, type Node, type Tree } from '@vscode/tree-sitter-wasm';

export type { Node as SyntaxNode, Tree as SyntaxTree };

export interface WasmSource {
  /** Bytes of a bundled wasm file, e.g. `tree-sitter.wasm` or `tree-sitter-python.wasm`. */
  load(file: string): Promise<Uint8Array>;
}

let source: WasmSource | undefined;
let runtime: Promise<void> | undefined;
const languages = new Map<string, Promise<Language>>();
const parsers = new Map<string, Parser>();

export function configureTreeSitter(src: WasmSource): void {
  source = src;
}

export function isTreeSitterConfigured(): boolean {
  return source !== undefined;
}

function requireSource(): WasmSource {
  if (!source) throw new Error('tree-sitter is not configured: call configureTreeSitter() first');
  return source;
}

async function initRuntime(): Promise<void> {
  runtime ??= (async () => {
    const wasmBinary = await requireSource().load('tree-sitter.wasm');
    await Parser.init({ wasmBinary, locateFile: (f: string) => f } as unknown as Parameters<typeof Parser.init>[0]);
  })();
  return runtime;
}

/** Loads (once) the grammar `tree-sitter-<grammar>.wasm`. */
export async function loadLanguage(grammar: string): Promise<Language> {
  await initRuntime();
  let lang = languages.get(grammar);
  if (!lang) {
    lang = requireSource()
      .load(`tree-sitter-${grammar}.wasm`)
      .then((bytes) => Language.load(bytes));
    languages.set(grammar, lang);
    lang.catch(() => languages.delete(grammar));
  }
  return lang;
}

/** Parses `text` with the given grammar. Parsers are cached per grammar. */
export async function parseCode(grammar: string, text: string): Promise<Tree> {
  const lang = await loadLanguage(grammar);
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(lang);
    parsers.set(grammar, parser);
  }
  const tree = parser.parse(text);
  if (!tree) throw new Error(`tree-sitter failed to parse (${grammar})`);
  return tree;
}
