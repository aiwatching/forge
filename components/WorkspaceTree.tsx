'use client';

import { useState, useEffect, useCallback } from 'react';

// ─── Types ───────────────────────────────────────────────

interface Project {
  name: string;
  path: string;
}

interface AgentInfo {
  id: string;
  label: string;
  icon: string;
  type?: 'agent' | 'input';
  status: string;
  currentStep?: string;
}

interface WorkspaceSummary {
  id: string;
  projectName: string;
  projectPath: string;
  agents: AgentInfo[];
}

// ─── Status indicators ───────────────────────────────────

const STATUS_DOT: Record<string, { char: string; color: string }> = {
  idle: { char: '○', color: 'text-gray-500' },
  running: { char: '◐', color: 'text-green-400' },
  paused: { char: '⏸', color: 'text-yellow-400' },
  waiting_approval: { char: '⏳', color: 'text-yellow-400' },
  done: { char: '●', color: 'text-blue-400' },
  failed: { char: '✕', color: 'text-red-400' },
  interrupted: { char: '◌', color: 'text-gray-400' },
};

// ─── Component ───────────────────────────────────────────

export default function WorkspaceTree({
  activeProjectPath,
  onSelectProject,
  onSelectAgent,
  onCreateWorkspace,
}: {
  activeProjectPath: string | null;
  onSelectProject: (project: Project) => void;
  onSelectAgent: (agentId: string) => void;
  onCreateWorkspace: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaces, setWorkspaces] = useState<Map<string, WorkspaceSummary>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Fetch projects
  useEffect(() => {
    fetch('/api/projects').then(r => r.json())
      .then((data: any[]) => {
        const projs = data.map(p => ({ name: p.name, path: p.path }));
        setProjects(projs);
        // Auto-expand active project
        if (activeProjectPath) {
          setExpanded(prev => new Set([...prev, activeProjectPath]));
        }
      })
      .catch(() => {});
  }, [activeProjectPath]);

  // Fetch workspace summaries for expanded projects
  useEffect(() => {
    for (const path of expanded) {
      if (workspaces.has(path)) continue;
      fetch(`/api/workspace?projectPath=${encodeURIComponent(path)}`)
        .then(r => r.json())
        .then(ws => {
          if (!ws?.id) return;
          // Fetch agent states
          fetch(`/api/workspace/${ws.id}/agents`).then(r => r.json())
            .then(data => {
              const agents: AgentInfo[] = (data.agents || []).map((a: any) => {
                const state = data.states?.[a.id] || {};
                return {
                  id: a.id,
                  label: a.label,
                  icon: a.icon,
                  type: a.type,
                  status: state.status || 'idle',
                  currentStep: state.currentStep !== undefined
                    ? a.steps?.[state.currentStep]?.label
                    : undefined,
                };
              });
              setWorkspaces(prev => new Map([...prev, [path, {
                id: ws.id,
                projectName: ws.projectName,
                projectPath: ws.projectPath,
                agents,
              }]]));
            })
            .catch(() => {});
        })
        .catch(() => {
          // No workspace for this project
          setWorkspaces(prev => new Map([...prev, [path, {
            id: '',
            projectName: '',
            projectPath: path,
            agents: [],
          }]]));
        });
    }
  }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleExpand = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0">
        <span className="text-xs font-bold text-[var(--text-primary)]">Workspace</span>
        <button onClick={() => setExpanded(new Set())}
          className="text-[8px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] ml-auto"
          title="Collapse all">
          ⇱
        </button>
        <button onClick={onCreateWorkspace}
          className="text-[8px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          +
        </button>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-auto py-1">
        {projects.length === 0 && (
          <div className="text-[10px] text-[var(--text-secondary)] text-center mt-4">No projects</div>
        )}
        {projects.map(project => {
          const isExpanded = expanded.has(project.path);
          const isActive = project.path === activeProjectPath;
          const ws = workspaces.get(project.path);

          return (
            <div key={project.path}>
              {/* Project row */}
              <div
                className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer text-[11px] hover:bg-[var(--bg-secondary)] ${
                  isActive ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
                }`}
                onClick={() => {
                  toggleExpand(project.path);
                  onSelectProject(project);
                }}
              >
                <span className="text-[8px] w-3 text-center shrink-0">{isExpanded ? '▾' : '▸'}</span>
                <span className="text-[10px]">📂</span>
                <span className="truncate flex-1">{project.name}</span>
                {ws && ws.agents.length > 0 && (
                  <span className="text-[8px] text-[var(--text-secondary)]">{ws.agents.length}</span>
                )}
              </div>

              {/* Agents */}
              {isExpanded && ws && ws.agents.length > 0 && (
                <div className="ml-4">
                  {ws.agents.map(agent => {
                    const dot = STATUS_DOT[agent.status] || STATUS_DOT.idle;
                    return (
                      <div
                        key={agent.id}
                        className="flex items-center gap-1.5 px-2 py-0.5 cursor-pointer text-[10px] hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectProject(project);
                          setTimeout(() => onSelectAgent(agent.id), 100);
                        }}
                      >
                        <span className="text-[9px]">{agent.icon}</span>
                        <span className="truncate flex-1">{agent.label}</span>
                        <span className={`text-[8px] ${dot.color}`} title={agent.status}>
                          {dot.char}
                        </span>
                        {agent.status === 'running' && agent.currentStep && (
                          <span className="text-[7px] text-green-400/60 truncate max-w-16">{agent.currentStep}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* No workspace yet */}
              {isExpanded && ws && ws.agents.length === 0 && ws.id === '' && (
                <div className="ml-6 py-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectProject(project);
                    }}
                    className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--accent)]"
                  >
                    + Create workspace
                  </button>
                </div>
              )}

              {/* Empty workspace */}
              {isExpanded && ws && ws.agents.length === 0 && ws.id !== '' && (
                <div className="ml-6 py-1 text-[9px] text-[var(--text-secondary)]">
                  No agents yet
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
