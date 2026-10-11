/** Reusable canvas view: engine + zoom controls + legend + export commands for any Scene. */

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { registerCommands, type CommandId } from '../commands';
import type { Scene, SceneNode } from '../engine/scene';
import { GraphView } from '../engine/view';
import { app, copy, host, useStore } from '../store';
import { exportScene } from '../views/shared';
import { IconButton, Tooltip } from './ui';

export interface CanvasPaneProps {
  /** Builds the scene; receives the monospace char width for sizing. */
  build: (charW: number) => Scene | null;
  /** Changing this re-fits the camera; same key + new scene animates. */
  sceneKey: string;
  /** Bump to rebuild without re-fitting. */
  version?: unknown;
  selected?: string | null;
  matches?: Iterable<string>;
  onSelect?: (node: SceneNode | null, row: number) => void;
  onOpen?: (node: SceneNode, row: number) => void;
  onToggle?: (node: SceneNode, row: number) => void;
  onContextMenu?: (node: SceneNode | null, row: number, ev: MouseEvent) => void;
  tooltip?: (node: SceneNode, row: number) => { head?: string; body: string } | null;
  exportName: string;
  mermaid?: () => string;
  legend?: ComponentChildren;
  /** Extra commands (expandAll, toggleDirection…). */
  commands?: Partial<Record<CommandId, () => void | Promise<void>>>;
  /** Focus this node when it changes (e.g. cursor sync). */
  focusKey?: string | null;
  /** Where to start when the whole scene can't be shown legibly (default: the most connected node). */
  startAt?: { key: string; align: 'left' | 'top' | 'center' } | null;
  children?: ComponentChildren;
}

export function CanvasPane(props: CanvasPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<GraphView | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tip, setTip] = useState<{ x: number; y: number; head?: string; body: string } | null>(null);
  const settings = useStore(app, (s) => s.settings);
  const propsRef = useRef(props);
  propsRef.current = props;
  const lastKey = useRef<string | null>(null);
  const mouse = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const view = new GraphView(hostRef.current!, {
      onNodeClick: (n, row) => propsRef.current.onSelect?.(n, row),
      onBackgroundClick: () => propsRef.current.onSelect?.(null, -1),
      onNodeDoubleClick: (n, row) => propsRef.current.onOpen?.(n, row),
      onToggle: (n, row) => (propsRef.current.onToggle ?? propsRef.current.onSelect)?.(n, row),
      onContextMenu: (n, row, ev) => propsRef.current.onContextMenu?.(n, row, ev),
      onHover: (n, row) => {
        if (!n) return setTip(null);
        const t = propsRef.current.tooltip?.(n, row);
        setTip(t ? { ...t, x: mouse.current.x, y: mouse.current.y } : null);
      },
      onViewport: (k) => setZoom(k),
    });
    const move = (e: MouseEvent) => (mouse.current = { x: e.clientX, y: e.clientY });
    view.canvas.addEventListener('mousemove', move);
    viewRef.current = view;
    return () => {
      view.canvas.removeEventListener('mousemove', move);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // (Re)build the scene.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.animations = settings.animations;
    view.showMinimap = settings.minimap;
    const scene = propsRef.current.build(view.charWidth);
    if (!scene) return;
    const fresh = lastKey.current !== props.sceneKey;
    lastKey.current = props.sceneKey;
    view.setScene(scene, { animate: !fresh });
    // Fit when legible, else start at the entry node (or the busiest node) at a readable zoom.
    if (fresh) view.frameStart(props.startAt?.key, props.startAt?.align);
    setZoom(view.zoom);
  }, [props.sceneKey, props.version, settings.animations, settings.minimap, settings.direction]);

  useEffect(() => {
    viewRef.current?.setSelection(props.selected ?? null);
  }, [props.selected]);

  useEffect(() => {
    viewRef.current?.setMatches(props.matches ?? []);
  }, [props.matches]);

  useEffect(() => {
    if (props.focusKey) viewRef.current?.focus(props.focusKey, { onlyIfHidden: true });
  }, [props.focusKey]);

  useEffect(
    () =>
      registerCommands({
        fit: () => viewRef.current?.fit(),
        zoomIn: () => viewRef.current?.zoomBy(1.25),
        zoomOut: () => viewRef.current?.zoomBy(0.8),
        resetZoom: () => viewRef.current?.resetZoom(),
        center: () => {
          const k = propsRef.current.selected;
          if (k) viewRef.current?.focus(k);
        },
        exportPng: () => exportScene(viewRef.current!, 'png', propsRef.current.exportName),
        exportSvg: () => exportScene(viewRef.current!, 'svg', propsRef.current.exportName),
        exportMermaid: props.mermaid
          ? async () => {
              const text = propsRef.current.mermaid!();
              if (host().kind === 'vscode') await host().request('saveFile', { name: `${propsRef.current.exportName}.mmd`, data: text, mime: 'text/plain' });
              else await copy(text, 'Mermaid diagram copied');
            }
          : undefined,
        ...props.commands,
      }),
    [props.sceneKey, !!props.mermaid, props.commands],
  );

  return (
    <div class="graph-host" ref={hostRef}>
      <div class="floating br">
        <IconButton icon="minus" title="Zoom out" kbd="-" onClick={() => viewRef.current?.zoomBy(0.8)} />
        <span class="zoom-label">{Math.round(zoom * 100)}%</span>
        <IconButton icon="plus" title="Zoom in" kbd="+" onClick={() => viewRef.current?.zoomBy(1.25)} />
        <IconButton icon="fit" title="Fit to view" kbd="F" onClick={() => viewRef.current?.fit()} />
      </div>
      {props.legend && <div class="floating bl legend">{props.legend}</div>}
      {props.children}
      {tip && (
        <Tooltip x={tip.x} y={tip.y}>
          {tip.head && <div class="tt-head">{tip.head}</div>}
          {tip.body}
        </Tooltip>
      )}
    </div>
  );
}

export function LegendItems({ items }: { items: [string, string][] }) {
  return (
    <>
      {items.map(([label, color]) => (
        <span key={label}>
          <i style={{ background: color }} />
          {label}
        </span>
      ))}
    </>
  );
}
