import { useState, useRef, useCallback } from 'react';

interface UseSidebarResizeOptions {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
}

/**
 * Provides drag-to-resize behaviour for a vertical split panel sidebar.
 *
 * Usage:
 *   const { sidebarWidth, onSidebarDragStart } = useSidebarResize({ defaultWidth: 224 });
 *
 *   <aside style={{ width: sidebarWidth }} className="flex flex-col shrink-0 overflow-hidden">…</aside>
 *   <div onMouseDown={onSidebarDragStart} className="w-1 cursor-col-resize shrink-0 bg-[var(--border)] hover:bg-[var(--accent)]/50" />
 *   <main className="flex-1 min-w-0">…</main>
 */
export function useSidebarResize({
  defaultWidth = 224,
  minWidth = 120,
  maxWidth = 480,
}: UseSidebarResizeOptions = {}) {
  const [sidebarWidth, setSidebarWidth] = useState(defaultWidth);
  // Track the in-progress drag without causing re-renders in the move handler
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  // Keep a mutable copy so the stable onSidebarDragStart callback always reads the latest width
  const widthRef = useRef(defaultWidth);

  const onSidebarDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: widthRef.current };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const next = Math.max(minWidth, Math.min(maxWidth, dragRef.current.startW + ev.clientX - dragRef.current.startX));
      widthRef.current = next;
      setSidebarWidth(next);
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [minWidth, maxWidth]);

  return { sidebarWidth, onSidebarDragStart };
}
