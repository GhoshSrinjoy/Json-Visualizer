/**
 * Finds and reads JSON Schemas for data files: a `$schema` reference (URL or path relative to
 * the file), or the schema associations VS Code users already have (`json.schemas`, `yaml.schemas`).
 */

import * as vscode from 'vscode';

const MAX_BYTES = 20 * 1024 * 1024;

export interface LoadedSchema {
  ref: string;
  text: string;
}

/** The schema `ref` points to, or the one associated with `file` in the user's settings. */
export async function loadSchemaFor(file: vscode.Uri, ref?: string): Promise<LoadedSchema | null> {
  if (ref) return readSchema(ref, vscode.Uri.joinPath(file, '..'));
  const found = associatedSchema(file);
  if (!found) return null;
  return 'inline' in found ? { ref: `${file.toString()}#schema`, text: JSON.stringify(found.inline) } : readSchema(found.ref, found.base);
}

export async function pickSchema(file: vscode.Uri): Promise<LoadedSchema | null> {
  const [picked] =
    (await vscode.window.showOpenDialog({
      defaultUri: vscode.Uri.joinPath(file, '..'),
      canSelectMany: false,
      openLabel: 'Validate against this schema',
      filters: { 'JSON Schema': ['json', 'yaml', 'yml'], 'All files': ['*'] },
    })) ?? [];
  return picked ? readSchema(picked.toString(), vscode.Uri.joinPath(file, '..')) : null;
}

/** Reads a schema by URL, file URI or path (relative to the folder `dir`). */
export async function readSchema(ref: string, dir: vscode.Uri): Promise<LoadedSchema> {
  const clean = ref.replace(/#.*$/, '');
  if (/^https?:/i.test(clean)) {
    if (!vscode.workspace.getConfiguration('json').get<boolean>('schemaDownload.enable', true)) {
      throw new Error('Downloading schemas is turned off (setting json.schemaDownload.enable).');
    }
    const res = await fetch(clean, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/schema+json, application/json, */*' } });
    if (!res.ok) throw new Error(`Could not download ${clean}: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error(`${clean} is too large to be a schema.`);
    return { ref: clean, text };
  }
  let uri: vscode.Uri;
  if (/^file:/i.test(clean)) uri = vscode.Uri.parse(clean);
  else if (/^[a-z][\w+.-]+:/i.test(clean) && !/^[a-z]:[\\/]/i.test(clean)) throw new Error(`Schemas from ${clean.split(':')[0]}: links can't be read here.`);
  else if (/^(?:[a-z]:)?[\\/]/i.test(clean)) uri = vscode.Uri.file(clean);
  else uri = vscode.Uri.joinPath(dir, clean);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.byteLength > MAX_BYTES) throw new Error(`${uri.fsPath} is too large to be a schema.`);
  return { ref: uri.toString(), text: new TextDecoder().decode(bytes) };
}

type Association = { ref: string; base: vscode.Uri } | { inline: unknown };

/** First matching entry of `json.schemas` / `yaml.schemas` (VS Code semantics: the last matching pattern decides). */
function associatedSchema(file: vscode.Uri): Association | null {
  const folder = vscode.workspace.getWorkspaceFolder(file);
  const root = folder?.uri ?? vscode.Uri.joinPath(file, '..');
  const rel = '/' + (folder ? vscode.workspace.asRelativePath(file, false) : file.path.split('/').pop()!).replace(/\\/g, '/');
  const isYaml = /\.ya?ml$/i.test(file.path);
  if (!isYaml) {
    const entries = vscode.workspace.getConfiguration('json').get<{ fileMatch?: string[]; url?: string; schema?: unknown }[]>('schemas', []);
    for (const e of entries) {
      if (!e.fileMatch || !matches(rel, e.fileMatch)) continue;
      if (e.url) return { ref: e.url, base: root };
      if (e.schema) return { inline: e.schema };
    }
    return null;
  }
  const yaml = vscode.workspace.getConfiguration('yaml').get<Record<string, string | string[]>>('schemas', {});
  for (const [url, globs] of Object.entries(yaml)) if (matches(rel, Array.isArray(globs) ? globs : [globs])) return { ref: url, base: root };
  return null;
}

function matches(rel: string, patterns: string[]): boolean {
  let hit = false;
  for (const p of patterns) {
    const negate = p.startsWith('!');
    if (globToRegExp(negate ? p.slice(1) : p).test(rel)) hit = !negate;
  }
  return hit;
}

/** `*` = within a path segment, `**` = across segments; patterns without a leading `/` match at any depth. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/');
  let src = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        src += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else src += '[^/]*';
    } else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(g.startsWith('/') ? `^${src}$` : `(?:^|/)${src}$`, 'i');
}
