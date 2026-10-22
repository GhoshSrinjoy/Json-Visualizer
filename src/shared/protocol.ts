/**
 * Messages between the visualizer UI and its host (VS Code webview, the CLI's
 * local web server, or a plain browser). Requests are RPCs (`id` + result or
 * error); events are fire-and-forget notifications from the host.
 */

import type { CallGraph, CodeOutline, FunctionAnalysis } from '../core/code/model';
import type { DataFormat } from '../core/data/tree';
import type { DepGraph } from '../core/repo/deps';
import type { RepoModel } from '../core/repo/model';

export type Mode = 'data' | 'code' | 'repo' | 'welcome';

export type DataView = 'graph' | 'tree' | 'table' | 'schema' | 'text' | 'compare';
export type CodeView = 'structure' | 'flow' | 'dataflow' | 'calls';
export type RepoView = 'tree' | 'treemap' | 'graph' | 'deps' | 'stats';
export type ViewId = DataView | CodeView | RepoView;

export interface UiSettings {
  direction: 'LR' | 'TB';
  initialDepth: number;
  maxVisibleNodes: number;
  childPageSize: number;
  /** Data graph: label each edge with the child's key. */
  edgeLabels: boolean;
  /** Validate data files against their $schema (or the editor's schema associations) when they open. */
  autoValidate: boolean;
  theme: 'auto' | 'dark' | 'light';
  animations: boolean;
  minimap: boolean;
  followCursor: boolean;
}

export const DEFAULT_SETTINGS: UiSettings = {
  direction: 'LR',
  initialDepth: 3,
  maxVisibleNodes: 1500,
  childPageSize: 50,
  edgeLabels: true,
  autoValidate: true,
  theme: 'auto',
  animations: true,
  minimap: true,
  followCursor: true,
};

export interface Target {
  /** Host-specific id (VS Code URI string, or workspace-relative path). */
  uri: string;
  /** Display path. */
  path: string;
  name: string;
  languageId?: string;
  format?: DataFormat;
}

export interface InitPayload {
  mode: Mode;
  target?: Target;
  view?: ViewId;
  /** Code: symbol id or line to focus initially. */
  symbol?: string;
  line?: number;
  /** Message to show on the welcome screen (e.g. a load error). */
  notice?: string;
  /** Data files: compare with this file (URI) right away. */
  compare?: string;
  settings: UiSettings;
  host: 'vscode' | 'server' | 'browser';
  capabilities: {
    /** Jump to a source location in an editor. */
    reveal: boolean;
    /** Code outline/flow/call graph analysis is available. */
    code: boolean;
    /** Folder scanning / dependency graph is available. */
    repo: boolean;
    /** Persist settings changes. */
    settings: boolean;
    /** Data files can be edited from the visualizer. */
    edit?: boolean;
  };
  version: string;
}

export interface SourceEdit {
  offset: number;
  length: number;
  text: string;
  /** Source text expected at [check.from, offset + length) before the edit. */
  check: { from: number; text: string };
}

export interface SourceLocation {
  uri: string;
  line: number;
  col?: number;
  endLine?: number;
  endCol?: number;
  /** Move keyboard focus to the editor (default true); false just highlights. */
  focus?: boolean;
}

export interface RequestMap {
  /** Raw bytes of a data file (UI parses in a worker). */
  getData: { params: { uri: string }; result: { bytes: Uint8Array; format?: DataFormat; version: number } };
  getOutline: { params: { uri: string }; result: CodeOutline | null };
  getFunction: { params: { uri: string; symbolId?: string; line?: number }; result: FunctionAnalysis | null };
  getCallGraph: {
    params: { uris: string[]; focus?: string; depth?: number; direction?: 'callees' | 'callers' | 'both'; externals?: boolean };
    result: CallGraph;
  };
  getRepo: { params: { uri: string; force?: boolean }; result: RepoModel };
  getDeps: { params: { uri: string; under?: string; externals?: boolean; force?: boolean }; result: DepGraph };
  reveal: { params: SourceLocation; result: void };
  /** Open a file in an editor, or visualize it / a folder. */
  open: { params: { uri: string; visualize?: boolean; view?: ViewId; symbol?: string }; result: void };
  saveFile: { params: { name: string; data: string | Uint8Array; mime: string }; result: { saved: boolean; path?: string } };
  copyText: { params: { text: string }; result: void };
  /**
   * Replaces source ranges of a data file (edits made in the visualizer). Each edit carries
   * the text it expects just before and inside its range, so a changed file is never corrupted.
   */
  applyEdit: { params: { uri: string; edits: SourceEdit[] }; result: void };
  /**
   * A JSON Schema for a data file: `ref` (URL, or path relative to the file) when given, otherwise
   * the user's schema associations for the file (VS Code json.schemas / yaml.schemas); null when none.
   */
  loadSchema: { params: { uri: string; ref?: string }; result: { ref: string; text: string } | null };
  /** Lets the user pick another data file (to compare with). */
  pickDataFile: { params: { uri: string }; result: { name: string; bytes: Uint8Array; format?: DataFormat } | null };
  /** Lets the user pick a schema file to validate against. */
  pickSchema: { params: { uri: string }; result: { ref: string; text: string } | null };
  /** Open a web or mailto link in the system browser / mail client. */
  openExternal: { params: { url: string }; result: void };
  setSettings: { params: Partial<UiSettings>; result: void };
  notify: { params: { level: 'info' | 'warn' | 'error'; message: string }; result: void };
}

export type RequestName = keyof RequestMap;

export interface RpcRequest<K extends RequestName = RequestName> {
  kind: 'request';
  id: number;
  method: K;
  params: RequestMap[K]['params'];
}

export interface RpcResponse {
  kind: 'response';
  id: number;
  result?: unknown;
  error?: string;
}

export type HostEvent =
  | { type: 'init'; payload: InitPayload }
  /** The target changed (saved/edited); the UI should reload. */
  | { type: 'changed'; uri: string; version: number }
  /** Editor cursor moved: highlight the matching node. */
  | { type: 'cursor'; uri: string; offset?: number; line?: number }
  | { type: 'settings'; settings: UiSettings }
  /** Switch view / focus a symbol (e.g. from an AI agent request). */
  | { type: 'navigate'; view?: ViewId; symbol?: string; line?: number; query?: string; compare?: string };

export interface EventMessage {
  kind: 'event';
  event: HostEvent;
}

export type UiToHost =
  | RpcRequest
  | { kind: 'ready' }
  | { kind: 'cursorSync'; uri: string; line: number; col?: number }
  /** UI diagnostics (uncaught errors, failed views), shown in the host's log. */
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string };
export type HostToUi = RpcResponse | EventMessage;
