'use client';

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// ─── Split tree data model ────────────────────────────────────

type SplitNode =
  | { type: 'terminal'; id: number }
  | { type: 'split'; id: number; direction: 'horizontal' | 'vertical'; ratio: number; first: SplitNode; second: SplitNode };

let nextId = 1;

function makeTerminal(): SplitNode {
  return { type: 'terminal', id: nextId++ };
}

function makeSplit(direction: 'horizontal' | 'vertical', first: SplitNode, second: SplitNode): SplitNode {
  return { type: 'split', id: nextId++, direction, ratio: 0.5, first, second };
}

function splitNodeById(tree: SplitNode, targetId: number, direction: 'horizontal' | 'vertical'): SplitNode {
  if (tree.type === 'terminal') {
    if (tree.id === targetId) return makeSplit(direction, tree, makeTerminal());
    return tree;
  }
  return { ...tree, first: splitNodeById(tree.first, targetId, direction), second: splitNodeById(tree.second, targetId, direction) };
}

function removeNodeById(tree: SplitNode, targetId: number): SplitNode | null {
  if (tree.type === 'terminal') return tree.id === targetId ? null : tree;
  if (tree.first.type === 'terminal' && tree.first.id === targetId) return tree.second;
  if (tree.second.type === 'terminal' && tree.second.id === targetId) return tree.first;
  const f = removeNodeById(tree.first, targetId);
  if (f !== tree.first) return f ? { ...tree, first: f } : tree.second;
  const s = removeNodeById(tree.second, targetId);
  if (s !== tree.second) return s ? { ...tree, second: s } : tree.first;
  return tree;
}

function countTerminals(tree: SplitNode): number {
  if (tree.type === 'terminal') return 1;
  return countTerminals(tree.first) + countTerminals(tree.second);
}

// ─── Main component ───────────────────────────────────────────

export default function WebTerminal() {
  const [tree, setTree] = useState<SplitNode>(() => makeTerminal());
  const [activeId, setActiveId] = useState(1);
  // Store ratios separately to avoid re-rendering the whole tree
  const [ratios, setRatios] = useState<Record<number, number>>({});

  const onSplit = useCallback((id: number, dir: 'horizontal' | 'vertical') => {
    setTree(prev => splitNodeById(prev, id, dir));
  }, []);

  const onClose = useCallback((id: number) => {
    setTree(prev => {
      if (countTerminals(prev) <= 1) return prev;
      return removeNodeById(prev, id) || prev;
    });
  }, []);

  return (
    <div className="h-full w-full flex-1 flex flex-col bg-[#1a1a2e]">
      <div className="flex items-center gap-1 px-2 py-1 bg-[#12122a] border-b border-[#2a2a4a] shrink-0">
        <button onClick={() => onSplit(activeId, 'vertical')} className="text-[10px] px-2 py-0.5 text-gray-400 hover:text-white hover:bg-[#2a2a4a] rounded">
          Split Right
        </button>
        <button onClick={() => onSplit(activeId, 'horizontal')} className="text-[10px] px-2 py-0.5 text-gray-400 hover:text-white hover:bg-[#2a2a4a] rounded">
          Split Down
        </button>
        {countTerminals(tree) > 1 && (
          <button onClick={() => onClose(activeId)} className="text-[10px] px-2 py-0.5 text-gray-400 hover:text-red-400 hover:bg-[#2a2a4a] rounded">
            Close Pane
          </button>
        )}
        <span className="text-[9px] text-gray-600 ml-auto">{countTerminals(tree)} pane(s)</span>
      </div>
      <div className="flex-1 min-h-0">
        <PaneRenderer node={tree} activeId={activeId} onFocus={setActiveId} ratios={ratios} setRatios={setRatios} />
      </div>
    </div>
  );
}

// ─── Pane renderer ────────────────────────────────────────────

function PaneRenderer({
  node, activeId, onFocus, ratios, setRatios,
}: {
  node: SplitNode;
  activeId: number;
  onFocus: (id: number) => void;
  ratios: Record<number, number>;
  setRatios: React.Dispatch<React.SetStateAction<Record<number, number>>>;
}) {
  if (node.type === 'terminal') {
    return (
      <div className={`h-full w-full ${activeId === node.id ? 'ring-1 ring-[#7c5bf0]/50 ring-inset' : ''}`} onMouseDown={() => onFocus(node.id)}>
        <MemoTerminalPane id={node.id} />
      </div>
    );
  }

  const ratio = ratios[node.id] ?? node.ratio;
  const isVert = node.direction === 'vertical';

  return (
    <DraggableSplit
      splitId={node.id}
      direction={node.direction}
      ratio={ratio}
      setRatios={setRatios}
    >
      <PaneRenderer node={node.first} activeId={activeId} onFocus={onFocus} ratios={ratios} setRatios={setRatios} />
      <PaneRenderer node={node.second} activeId={activeId} onFocus={onFocus} ratios={ratios} setRatios={setRatios} />
    </DraggableSplit>
  );
}

// ─── Draggable split — uses pointer capture for reliable drag ─────────

function DraggableSplit({
  splitId,
  direction,
  ratio,
  setRatios,
  children,
}: {
  splitId: number;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  setRatios: React.Dispatch<React.SetStateAction<Record<number, number>>>;
  children: [React.ReactNode, React.ReactNode];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const secondRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const isVert = direction === 'vertical';

  // Apply ratio via DOM directly (no React re-render during drag)
  useEffect(() => {
    if (!firstRef.current || !secondRef.current) return;
    const prop = isVert ? 'width' : 'height';
    firstRef.current.style[prop] = `calc(${ratio * 100}% - 4px)`;
    secondRef.current.style[prop] = `calc(${(1 - ratio) * 100}% - 4px)`;
  }, [ratio, isVert]);

  // Attach pointer events natively to bypass React synthetic event issues
  useEffect(() => {
    const divider = dividerRef.current;
    const container = containerRef.current;
    const first = firstRef.current;
    const second = secondRef.current;
    if (!divider || !container || !first || !second) return;

    const vertical = isVert;
    const prop = vertical ? 'width' : 'height';
    let lastRatio = ratio;

    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      divider.setPointerCapture(e.pointerId);
      draggingRef.current = true;
      lastRatio = ratio;
      document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      const rect = container.getBoundingClientRect();
      let r = vertical
        ? (e.clientX - rect.left) / rect.width
        : (e.clientY - rect.top) / rect.height;
      r = Math.max(0.1, Math.min(0.9, r));
      lastRatio = r;
      first.style[prop] = `calc(${r * 100}% - 4px)`;
      second.style[prop] = `calc(${(1 - r) * 100}% - 4px)`;
    };

    const onPointerUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setRatios(prev => ({ ...prev, [splitId]: lastRatio }));
    };

    divider.addEventListener('pointerdown', onPointerDown);
    divider.addEventListener('pointermove', onPointerMove);
    divider.addEventListener('pointerup', onPointerUp);
    divider.addEventListener('lostpointercapture', onPointerUp);

    return () => {
      divider.removeEventListener('pointerdown', onPointerDown);
      divider.removeEventListener('pointermove', onPointerMove);
      divider.removeEventListener('pointerup', onPointerUp);
      divider.removeEventListener('lostpointercapture', onPointerUp);
    };
  }, [isVert, ratio, splitId, setRatios]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: 'flex', flexDirection: isVert ? 'row' : 'column' }}
    >
      <div ref={firstRef} style={{ minWidth: 0, minHeight: 0, overflow: 'hidden', [isVert ? 'width' : 'height']: `calc(${ratio * 100}% - 4px)` }}>
        {children[0]}
      </div>
      <div
        ref={dividerRef}
        className={`shrink-0 ${isVert ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'} bg-[#2a2a4a] hover:bg-[#7c5bf0] active:bg-[#7c5bf0] transition-colors`}
        style={{ touchAction: 'none', zIndex: 10 }}
      />
      <div ref={secondRef} style={{ minWidth: 0, minHeight: 0, overflow: 'hidden', [isVert ? 'width' : 'height']: `calc(${(1 - ratio) * 100}% - 4px)` }}>
        {children[1]}
      </div>
    </div>
  );
}

// ─── Memoized terminal pane — never re-renders unless id changes ──

const MemoTerminalPane = memo(function TerminalPane({ id }: { id: number }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#7c5bf0',
        selectionBackground: '#7c5bf044',
        black: '#1a1a2e',
        red: '#ff6b6b',
        green: '#69db7c',
        yellow: '#ffd43b',
        blue: '#7c5bf0',
        magenta: '#da77f2',
        cyan: '#66d9ef',
        white: '#e0e0e0',
        brightBlack: '#555',
        brightRed: '#ff8787',
        brightGreen: '#8ce99a',
        brightYellow: '#ffe066',
        brightBlue: '#9775fa',
        brightMagenta: '#e599f7',
        brightCyan: '#99e9f2',
        brightWhite: '#ffffff',
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    requestAnimationFrame(() => fit.fit());

    const wsHost = window.location.hostname;
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${wsProtocol}//${wsHost}:3001`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') term.write(msg.data);
        else if (msg.type === 'exit') term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
      } catch {}
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    const handleResize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="h-full w-full" />;
});
