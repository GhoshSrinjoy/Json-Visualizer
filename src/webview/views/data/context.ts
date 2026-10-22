import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { DiffKind } from '../../../core/data/diff';
import type { EditMode, EditOp } from '../../../core/data/edit';
import type { Target } from '../../../shared/protocol';
import type { DataClient } from '../../worker/client';
import type { Summary, ValidationView } from '../../worker/protocol';

export interface DataCtx {
  client: DataClient;
  summary: Summary;
  target: Target;
  selected: number | null;
  select(id: number | null, opts?: { focus?: boolean; source?: string }): void;
  /** Search hits (node ids) and the active hit index. */
  hits: number[];
  hitIndex: number;
  /** Bumped when the hit index changes so panes can navigate. */
  hitVersion: number;
  /** Request from another pane / the host to bring a node into view. */
  reveal: { id: number; seq: number } | null;
  /** Jump to the node's source location in the editor. */
  revealInEditor(id: number): void;
  /** Table pane target (container id). */
  tableTarget: number | null;
  openTable(id: number): void;
  /**
   * Runs `fn` before the document is re-parsed (node ids change then), e.g. to
   * remember expanded nodes by path. Returns an unsubscribe function.
   */
  beforeReload(fn: () => Promise<void> | void): () => void;
  /** Per-document scratch space that outlives a pane (view state across tab switches). */
  memo: Map<string, unknown>;
  /** Writes a change to the file (absent when the host can't edit); `select` is the path to select afterwards. */
  edit?(op: EditOp, select?: string): Promise<boolean>;
  /** Opens the inspector's editor for a node (from menus and shortcuts). */
  requestEdit(id: number, mode: EditMode): void;
  editRequest: { id: number; mode: EditMode; seq: number } | null;
  /** The file this document is compared with (`seq` changes when it is reloaded). */
  compare: { name: string; seq: number } | null;
  /** Picks a file to compare with (or loads `uri` directly). */
  chooseCompare(uri?: string): Promise<void>;
  clearCompare(): void;
  /** Result of validating against a JSON Schema (null: no schema). */
  validation: ValidationState | null;
  /** Validates against a schema the user picks, or the one at `ref` (URL or path relative to the file). */
  validateWith(ref?: string): Promise<void>;
  clearValidation(): void;
  /** Changes in this document from the last diff, by node id (shown on the graph and tree). */
  diffMarks: ReadonlyMap<number, DiffKind> | null;
  setDiffMarks(marks: ReadonlyMap<number, DiffKind> | null): void;
}

export interface ValidationState {
  /** Where the schema came from, and a short name for it. */
  ref: string;
  name: string;
  /** How it was found: the document's $schema, the editor's associations, or picked by the user. */
  source: 'document' | 'settings' | 'picked';
  result: ValidationView | null;
  error?: string;
  /** Error messages by node id. */
  byId: Map<number, string[]>;
  /** $ref'd documents that could not be loaded (treated as accepting anything). */
  unresolved: string[];
}

export const DataContext = createContext<DataCtx | null>(null);

export function useData(): DataCtx {
  const c = useContext(DataContext);
  if (!c) throw new Error('DataContext missing');
  return c;
}
