import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { Target } from '../../../shared/protocol';
import type { DataClient } from '../../worker/client';
import type { Summary } from '../../worker/protocol';

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
}

export const DataContext = createContext<DataCtx | null>(null);

export function useData(): DataCtx {
  const c = useContext(DataContext);
  if (!c) throw new Error('DataContext missing');
  return c;
}
