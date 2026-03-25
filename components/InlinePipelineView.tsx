'use client';

import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import type { TaskLogEntry } from '@/src/types';

const ConversationGraphView = lazy(() => import('./ConversationGraphView'));

// ─── Task stream hook ─────────────────────────────────────

function useTaskStreamInline(taskId: string | undefined, isRunning: boolean) {
  const [log, setLog] = useState<TaskLogEntry[]>([]);
  useEffect(() => {
    if (!taskId || !isRunning) { setLog([]); return; }
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log') setLog(prev => [...prev, data.entry]);
        else if (data.type === 'complete' && data.task) setLog(data.task.log);
      } catch {}
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [taskId, isRunning]);
  return log;
}

// ─── Live log renderer ────────────────────────────────────

function InlineLiveLog({ log }: { log: TaskLogEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [log]);
  if (log.length === 0) return <span className="text-[9px] text-[var(--text-secondary)] italic">Starting...</span>;
  return (
    <div className="max-h-[120px] overflow-y-auto text-[8px] font-mono leading-relaxed space-y-0.5">
      {log.slice(-30).map((entry, i) => (
        <div key={i} className={
          entry.type === 'result' ? 'text-green-400' :
          entry.subtype === 'error' ? 'text-red-400' :
          entry.type === 'system' ? 'text-yellow-400/70' :
          'text-[var(--text-secondary)]'
        }>
          {entry.type === 'assistant' && entry.subtype === 'tool_use'
            ? `⚙ ${entry.tool || 'tool'}: ${entry.content.slice(0, 60)}...`
            : entry.content.slice(0, 120)}{entry.content.length > 120 ? '...' : ''}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

// ─── DAG node card ────────────────────────────────────────

function InlineDagNode({ nodeId, node }: { nodeId: string; node: any }) {
  const isRunning = node.status === 'running';
  const log = useTaskStreamInline(node.taskId, isRunning);
  const statusIcon = node.status === 'done' ? '✅' : node.status === 'failed' ? '❌' : node.status === 'running' ? '🔄' : node.status === 'skipped' ? '⏭' : '⏳';
  return (
    <div className={`border rounded p-2 ${
      isRunning ? 'border-yellow-500/40 bg-yellow-500/5' :
      node.status === 'done' ? 'border-green-500/20 bg-green-500/5' :
      node.status === 'failed' ? 'border-red-500/20 bg-red-500/5' :
      'border-[var(--border)]'
    }`}>
      <div className="flex items-center gap-1.5 text-[9px]">
        <span>{statusIcon}</span>
        <span className="font-semibold text-[var(--text-primary)]">{nodeId}</span>
        {node.taskId && <span className="text-[7px] text-[var(--accent)] font-mono">task:{node.taskId}</span>}
        <span className="text-[var(--text-secondary)] ml-auto">{node.status}</span>
      </div>
      {isRunning && <div className="mt-1.5"><InlineLiveLog log={log} /></div>}
      {node.error && <div className="text-[8px] text-red-400 mt-1">{node.error}</div>}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────

export default function InlinePipelineView({ pipeline, onRefresh }: { pipeline: any; onRefresh: () => void }) {
  useEffect(() => {
    if (pipeline.status !== 'running') return;
    const timer = setInterval(onRefresh, 3000);
    return () => clearInterval(timer);
  }, [pipeline.status, onRefresh]);

  const isConversation = pipeline.type === 'conversation' && pipeline.conversation;

  return (
    <div className="bg-[var(--bg-tertiary)]/50">
      {isConversation ? (
        <div style={{ height: 420 }}>
          <Suspense fallback={<div className="flex items-center justify-center h-full text-[9px] text-[var(--text-secondary)]">Loading graph...</div>}>
            <ConversationGraphView pipeline={pipeline} />
          </Suspense>
        </div>
      ) : (
        <div className="px-3 py-2 space-y-1.5">
          {pipeline.nodeOrder.map((nodeId: string) => (
            <InlineDagNode key={nodeId} nodeId={nodeId} node={pipeline.nodes[nodeId]} />
          ))}
        </div>
      )}
      {pipeline.status !== 'running' && (
        <div className={`text-[8px] text-center py-1 ${pipeline.status === 'done' ? 'text-green-400' : 'text-red-400'}`}>
          Pipeline {pipeline.status}
        </div>
      )}
    </div>
  );
}
