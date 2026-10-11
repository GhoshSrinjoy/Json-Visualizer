/** Small shared UI building blocks: buttons, menus, tooltips, virtual list. */

import type { ComponentChildren, JSX } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon, type IconName } from './icons';

export function IconButton({
  icon,
  title,
  onClick,
  active,
  disabled,
  label,
  kbd,
  class: cls,
}: {
  icon: IconName;
  title: string;
  onClick?: (e: MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  label?: string;
  kbd?: string;
  class?: string;
}) {
  return (
    <button
      class={`btn ${active ? 'active' : ''} ${cls ?? ''}`}
      title={kbd ? `${title} (${kbd})` : title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
      {label && <span>{label}</span>}
    </button>
  );
}

export interface MenuItem {
  label?: string;
  icon?: IconName;
  kbd?: string;
  checked?: boolean;
  onSelect?: () => void;
  separator?: boolean;
  heading?: string;
  disabled?: boolean;
}

/** Floating menu positioned at a point; closes on outside click / Escape. */
export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
  }, [x, y]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', down), 0);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div class="menu" ref={ref} style={{ left: `${pos.x}px`, top: `${pos.y}px` }} role="menu">
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} class="menu-sep" />
        ) : it.heading ? (
          <div key={i} class="menu-label">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            class="menu-item"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect?.();
            }}
          >
            {it.icon && <Icon name={it.icon} />}
            <span>{it.label}</span>
            {it.checked && <Icon name="check" class="menu-check" />}
            {it.kbd && <kbd>{it.kbd}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Hook managing a menu anchored to an element or a point. */
export function useMenu(): [JSX.Element | null, (items: MenuItem[], at: { x: number; y: number } | Element) => void] {
  const [state, setState] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = (items: MenuItem[], at: { x: number; y: number } | Element) => {
    if (at instanceof Element) {
      const r = at.getBoundingClientRect();
      setState({ x: r.left, y: r.bottom + 4, items });
    } else setState({ ...at, items });
  };
  const el = state ? <Menu x={state.x} y={state.y} items={state.items} onClose={() => setState(null)} /> : null;
  return [el, open];
}

export function Tooltip({ x, y, children }: { x: number; y: number; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: x + 14, y: y + 16 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: x + 14 + r.width > window.innerWidth - 8 ? x - r.width - 10 : x + 14, y: y + 16 + r.height > window.innerHeight - 8 ? y - r.height - 10 : y + 16 });
  }, [x, y, children]);
  return createPortal(
    <div class="tooltip" ref={ref} style={{ left: `${pos.x}px`, top: `${pos.y}px` }}>
      {children}
    </div>,
    document.body,
  );
}

export interface VirtualListProps {
  count: number;
  rowHeight: number;
  render: (index: number) => JSX.Element;
  overscan?: number;
  /** Scroll so this index is visible (changes trigger a scroll). */
  scrollTo?: number;
  onKeyDown?: (e: KeyboardEvent) => void;
  innerRef?: (el: HTMLDivElement | null) => void;
  class?: string;
}

/** Fixed-row-height virtual list: renders only rows in (and near) the viewport. */
export function VirtualList({ count, rowHeight, render, overscan = 8, scrollTo, onKeyDown, innerRef, class: cls }: VirtualListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ top: 0, height: 800 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setRange({ top: el.scrollTop, height: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener('scroll', update, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', update);
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || scrollTo === undefined || scrollTo < 0) return;
    const top = scrollTo * rowHeight;
    if (top < el.scrollTop + rowHeight) el.scrollTop = Math.max(0, top - rowHeight * 2);
    else if (top + rowHeight > el.scrollTop + el.clientHeight - rowHeight) el.scrollTop = top - el.clientHeight + rowHeight * 3;
  }, [scrollTo, rowHeight]);
  const first = Math.max(0, Math.floor(range.top / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((range.top + range.height) / rowHeight) + overscan);
  const rows: JSX.Element[] = [];
  for (let i = first; i < last; i++) rows.push(render(i));
  return (
    <div
      class={`vlist ${cls ?? ''}`}
      ref={(el) => {
        (ref as { current: HTMLDivElement | null }).current = el;
        innerRef?.(el);
      }}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <div class="vlist-inner" style={{ height: `${count * rowHeight}px` }}>
        {rows}
      </div>
    </div>
  );
}

export function CenterMessage({ children, spinner, progress }: { children?: ComponentChildren; spinner?: boolean; progress?: boolean }) {
  return (
    <div class="center-msg">
      {spinner && <div class="spinner" />}
      {progress && (
        <div class="progress">
          <i />
        </div>
      )}
      {children}
    </div>
  );
}
