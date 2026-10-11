/** Maps files to language adapters (tree-sitter specs or regex fallbacks). */

import type { LanguageSpec } from './spec';

export interface LanguageInfo {
  id: string;
  name: string;
  extensions: string[];
  /** tree-sitter backed adapter (full outline + flow + data flow). */
  spec?: LanguageSpec;
}

/** Languages without a bundled grammar: outline comes from regex heuristics. */
export const FALLBACK_LANGUAGES: LanguageInfo[] = [
  { id: 'kotlin', name: 'Kotlin', extensions: ['kt', 'kts'] },
  { id: 'swift', name: 'Swift', extensions: ['swift'] },
  { id: 'scala', name: 'Scala', extensions: ['scala', 'sc'] },
  { id: 'dart', name: 'Dart', extensions: ['dart'] },
  { id: 'lua', name: 'Lua', extensions: ['lua'] },
  { id: 'elixir', name: 'Elixir', extensions: ['ex', 'exs'] },
  { id: 'perl', name: 'Perl', extensions: ['pl', 'pm'] },
  { id: 'r', name: 'R', extensions: ['r'] },
  { id: 'julia', name: 'Julia', extensions: ['jl'] },
  { id: 'groovy', name: 'Groovy', extensions: ['groovy', 'gradle'] },
  { id: 'objective-c', name: 'Objective-C', extensions: ['m', 'mm'] },
  { id: 'shellscript', name: 'Shell', extensions: ['sh', 'bash', 'zsh'] },
  { id: 'powershell', name: 'PowerShell', extensions: ['ps1', 'psm1'] },
  { id: 'fsharp', name: 'F#', extensions: ['fs', 'fsx'] },
  { id: 'vb', name: 'Visual Basic', extensions: ['vb'] },
  { id: 'zig', name: 'Zig', extensions: ['zig'] },
  { id: 'nim', name: 'Nim', extensions: ['nim'] },
  { id: 'haskell', name: 'Haskell', extensions: ['hs'] },
  { id: 'ocaml', name: 'OCaml', extensions: ['ml'] },
  { id: 'clojure', name: 'Clojure', extensions: ['clj', 'cljs', 'cljc'] },
  { id: 'erlang', name: 'Erlang', extensions: ['erl'] },
  { id: 'solidity', name: 'Solidity', extensions: ['sol'] },
  { id: 'vue', name: 'Vue', extensions: ['vue'] },
  { id: 'svelte', name: 'Svelte', extensions: ['svelte'] },
];

/** VS Code language ids that differ from our ids. */
const LANGUAGE_ID_ALIASES: Record<string, string> = {
  javascriptreact: 'javascript',
  'objective-cpp': 'objective-c',
  bat: 'shellscript',
};

const byExt = new Map<string, LanguageInfo>();
const byId = new Map<string, LanguageInfo>();

function register(info: LanguageInfo) {
  byId.set(info.id, info);
  for (const e of info.extensions) if (!byExt.has(e)) byExt.set(e, info);
}

for (const f of FALLBACK_LANGUAGES) register(f);

/** Adds an adapter at runtime (more languages register themselves on import). */
export function registerLanguage(spec: LanguageSpec): void {
  const info: LanguageInfo = { id: spec.id, name: spec.name, extensions: spec.extensions, spec };
  byId.set(spec.id, info);
  for (const e of spec.extensions) byExt.set(e, info);
  for (const n of spec.fileNames ?? []) byExt.set(`name:${n.toLowerCase()}`, info);
}

export function languageFor(path: string, languageId?: string): LanguageInfo | undefined {
  const base = path.split(/[\\/]/).pop() ?? path;
  const named = byExt.get(`name:${base.toLowerCase()}`);
  if (named) return named;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (ext === 'h') {
    // Headers: C++ if the file looks like C++, else C.
    return byId.get('cpp') ?? byExt.get(ext);
  }
  const hit = byExt.get(ext);
  if (hit) return hit;
  if (languageId) return byId.get(LANGUAGE_ID_ALIASES[languageId] ?? languageId);
  return undefined;
}

export function languageById(id: string): LanguageInfo | undefined {
  return byId.get(LANGUAGE_ID_ALIASES[id] ?? id);
}

export function allLanguages(): LanguageInfo[] {
  return [...byId.values()];
}

/** File extensions with full (grammar-backed) support. */
export function fullySupportedExtensions(): string[] {
  return [...byExt.entries()].filter(([k, v]) => v.spec && !k.startsWith('name:')).map(([k]) => k);
}
