/** Helpers shared by views. */

import type { GraphView } from '../engine/view';
import { host, toast } from '../store';

export function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function stem(name: string): string {
  return baseName(name).replace(/\.[^.]+$/, '') || 'structlens';
}

/** Saves the current scene as PNG or SVG through the host (save dialog / download). */
export async function exportScene(view: GraphView, kind: 'png' | 'svg', name: string, suffix = ''): Promise<void> {
  try {
    const file = `${stem(name)}${suffix ? `-${suffix}` : ''}.${kind}`;
    if (kind === 'png') {
      const blob = await view.exportPng(2);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const r = await host().request('saveFile', { name: file, data: bytes, mime: 'image/png' });
      if (r.saved && r.path) toast(`Saved ${r.path}`);
    } else {
      const r = await host().request('saveFile', { name: file, data: view.exportSvg(), mime: 'image/svg+xml' });
      if (r.saved && r.path) toast(`Saved ${r.path}`);
    }
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, 'error');
  }
}
