/**
 * Command bus: the active view registers handlers (fit, expandAll, export…);
 * the toolbar, keyboard shortcuts and menus run them by name.
 */

import { app } from './store';

export type CommandId =
  | 'fit'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'
  | 'center'
  | 'expandAll'
  | 'collapseAll'
  | 'toggleDirection'
  | 'exportPng'
  | 'exportSvg'
  | 'exportJson'
  | 'exportMermaid'
  | 'copyImage'
  | 'searchNext'
  | 'searchPrev'
  | 'reveal'
  | 'refresh';

type Handler = () => void | Promise<void>;
const handlers = new Map<CommandId, Handler>();

function publish(): void {
  app.set({ commands: [...handlers.keys()] });
}

export function registerCommands(map: Partial<Record<CommandId, Handler | undefined>>): () => void {
  const added: CommandId[] = [];
  for (const [id, h] of Object.entries(map) as [CommandId, Handler | undefined][]) {
    if (!h) continue;
    handlers.set(id, h);
    added.push(id);
  }
  publish();
  return () => {
    for (const id of added) if (handlers.get(id) === map[id]) handlers.delete(id);
    publish();
  };
}

export function runCommand(id: CommandId): boolean {
  const h = handlers.get(id);
  if (!h) return false;
  void h();
  return true;
}
