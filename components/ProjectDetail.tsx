'use client';

import React, { useState, useEffect, useCallback, useRef, memo, lazy, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useSidebarResize } from '@/hooks/useSidebarResize';

import { TerminalSessionPickerLazy, fetchProjectSessions } from './TerminalLauncher';
const InlinePipelineView = lazy(() => import('./InlinePipelineView'));
const WorkspaceViewLazy = lazy(() => import('./WorkspaceView'));
const SessionViewLazy = lazy(() => import('./SessionView'));

// ─── Syntax highlighting ─────────────────────────────────
const KEYWORDS = new Set([
  'import', 'export', 'from', 'const', 'let', 'var', 'function', 'return',
  'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue',
  'class', 'extends', 'new', 'this', 'super', 'typeof', 'instanceof',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
  'default', 'interface', 'type', 'enum', 'implements', 'readonly',
  'public', 'private', 'protected', 'static', 'abstract',
  'true', 'false', 'null', 'undefined', 'void',
  'def', 'self', 'None', 'True', 'False', 'lambda', 'with', 'as', 'in', 'not', 'and', 'or',
  'package', 'final', 'synchronized', 'volatile', 'transient', 'native',
  'throws', 'int', 'long', 'double', 'float', 'char', 'byte', 'short', 'boolean',
  'override', 'struct', 'func', 'go', 'defer', 'select', 'chan', 'range',
  'val', 'var', 'def', 'object', 'trait', 'sealed', 'implicit', 'lazy', 'match',
]);

function highlightLine(line: string): React.ReactNode {
  if (!line) return ' ';
  const commentIdx = line.indexOf('//');
  if (commentIdx === 0 || (commentIdx > 0 && /^\s*$/.test(line.slice(0, commentIdx)))) {
    return <span className="text-gray-500 italic">{line}</span>;
  }
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  const regex = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+\.?\d*\b)|(\/\/.*$|#.*$)|(\b[A-Z_][A-Z_0-9]+\b)|(\b\w+\b)/g;
  let match;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIdx) parts.push(line.slice(lastIdx, match.index));
    if (match[1]) parts.push(<span key={match.index} className="text-green-400">{match[0]}</span>);
    else if (match[2]) parts.push(<span key={match.index} className="text-orange-300">{match[0]}</span>);
    else if (match[3]) parts.push(<span key={match.index} className="text-gray-500 italic">{match[0]}</span>);
    else if (match[4]) parts.push(<span key={match.index} className="text-cyan-300">{match[0]}</span>);
    else if (match[5] && KEYWORDS.has(match[5])) parts.push(<span key={match.index} className="text-purple-400">{match[0]}</span>);
    else parts.push(match[0]);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < line.length) parts.push(line.slice(lastIdx));
  return parts.length > 0 ? <>{parts}</> : line;
}

interface GitInfo {
  branch: string;
  branches: { name: string; upstream: string; hash: string; current: boolean }[];
  changes: { status: string; path: string }[];
  remote: string;
  ahead: number;
  behind: number;
  lastCommit: string;
  log: { hash: string; message: string; author: string; date: string }[];
}

export default memo(function ProjectDetail({ projectPath, projectName, hasGit }: { projectPath: string; projectName: string; hasGit: boolean }) {
  const { sidebarWidth, onSidebarDragStart } = useSidebarResize({ defaultWidth: 208, minWidth: 120, maxWidth: 400 });
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [gitLoading, setGitLoading] = useState(false);
  const [gitResult, setGitResult] = useState<{ ok?: boolean; error?: string } | null>(null);
  const [fileTree, setFileTree] = useState<any[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileImageUrl, setFileImageUrl] = useState<string | null>(null);
  const [fileBinaryInfo, setFileBinaryInfo] = useState<{ fileType: string; sizeLabel: string; message?: string } | null>(null);
  const [fileLanguage, setFileLanguage] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [changesExpanded, setChangesExpanded] = useState(false);
  const [codeSearch, setCodeSearch] = useState('');
  const [codeSearchResults, setCodeSearchResults] = useState<{ file: string; line: number; content: string }[]>([]);
  const [codeSearching, setCodeSearching] = useState(false);
  const [changesHeight, setChangesHeight] = useState(120);
  const changesResizeRef = useRef<{ startY: number; origH: number } | null>(null);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [projectSkills, setProjectSkills] = useState<{ name: string; displayName: string; type: string; scope: string; version: string; installedVersion: string; hasUpdate: boolean; source: 'registry' | 'local' }[]>([]);
  const [showSkillsDetail, setShowSkillsDetail] = useState(false);
  const [projectTab, setProjectTab] = useState<'workspace' | 'sessions' | 'code' | 'skills' | 'claudemd' | 'pipelines' | 'temper'>('code');
  const [temperData, setTemperData] = useState<any>(null);
  const wsViewRef = useRef<import('./WorkspaceView').WorkspaceViewHandle>(null);
  // Pipeline bindings state
  const [pipelineBindings, setPipelineBindings] = useState<{ id: number; workflowName: string; enabled: boolean; config: any; lastRunAt: string | null; nextRunAt: string | null }[]>([]);
  const [pipelineRuns, setPipelineRuns] = useState<{ id: string; workflowName: string; pipelineId: string; status: string; summary: string; dedupKey: string | null; createdAt: string }[]>([]);
  const [availableWorkflows, setAvailableWorkflows] = useState<{ name: string; description?: string; builtin?: boolean; type?: string }[]>([]);
  const [boundSession, setBoundSession] = useState<{ sessionId: string } | null>(null);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [availableSessions, setAvailableSessions] = useState<{ id: string; modified: string; size: number }[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [expandedPipeline, setExpandedPipeline] = useState<any>(null);
  const [showAddPipeline, setShowAddPipeline] = useState(false);
  const [triggerInput, setTriggerInput] = useState<Record<string, string>>({});
  const [runMenu, setRunMenu] = useState<string | null>(null); // workflowName of open run menu
  const [issueInput, setIssueInput] = useState('');
  const [claudeMdContent, setClaudeMdContent] = useState('');
  const [claudeMdExists, setClaudeMdExists] = useState(false);
  const [claudeTemplates, setClaudeTemplates] = useState<{ id: string; name: string; description: string; tags: string[]; builtin: boolean; content: string }[]>([]);
  const [claudeInjectedIds, setClaudeInjectedIds] = useState<Set<string>>(new Set());
  const [claudeEditing, setClaudeEditing] = useState(false);
  const [claudeEditContent, setClaudeEditContent] = useState('');
  const [claudeSelectedTemplate, setClaudeSelectedTemplate] = useState<string | null>(null);
  const [expandedSkillItem, setExpandedSkillItem] = useState<string | null>(null);
  const [skillItemFiles, setSkillItemFiles] = useState<{ path: string; size: number }[]>([]);
  const [skillFileContent, setSkillFileContent] = useState('');
  const [skillFileHash, setSkillFileHash] = useState('');
  const [skillActivePath, setSkillActivePath] = useState('');
  const [skillEditing, setSkillEditing] = useState(false);
  const [skillEditContent, setSkillEditContent] = useState('');
  const [skillSaving, setSkillSaving] = useState(false);
  const [temperStatus, setTemperStatus] = useState<{ installed: boolean; enabled: boolean; initialized: boolean; version?: string; stats?: any } | null>(null);
  const [temperAction, setTemperAction] = useState<string | null>(null);

  // Fetch git info
  const fetchGitInfo = useCallback(async () => {
    if (!hasGit) { setGitInfo(null); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/git?dir=${encodeURIComponent(projectPath)}`);
      const data = await res.json();
      if (!data.error) setGitInfo(data);
      else setGitInfo(null);
    } catch { setGitInfo(null); }
    setLoading(false);
  }, [projectPath, hasGit]);

  // Fetch file tree
  const fetchTree = useCallback(async () => {
    try {
      const res = await fetch(`/api/code?dir=${encodeURIComponent(projectPath)}`);
      const data = await res.json();
      setFileTree(data.tree || []);
    } catch { setFileTree([]); }
  }, [projectPath]);

  const openFile = useCallback(async (path: string) => {
    setSelectedFile(path);
    setDiffContent(null);
    setDiffFile(null);
    setFileContent(null);
    setFileImageUrl(null);
    setFileBinaryInfo(null);
    setFileLoading(true);
    try {
      const res = await fetch(`/api/code?dir=${encodeURIComponent(projectPath)}&file=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.image) {
        setFileImageUrl(data.dataUrl);
      } else if (data.binary) {
        setFileBinaryInfo({ fileType: data.fileType, sizeLabel: data.sizeLabel, message: data.message });
      } else if (data.tooLarge) {
        setFileBinaryInfo({ fileType: '', sizeLabel: data.sizeLabel, message: data.message });
      } else {
        setFileContent(data.content || null);
        setFileLanguage(data.language || '');
      }
    } catch { setFileContent(null); }
    setFileLoading(false);
  }, [projectPath]);

  const openDiff = useCallback(async (filePath: string) => {
    setDiffFile(filePath);
    setDiffContent(null);
    setSelectedFile(null);
    setFileContent(null);
    try {
      const res = await fetch(`/api/code?dir=${encodeURIComponent(projectPath)}&diff=${encodeURIComponent(filePath)}`);
      const data = await res.json();
      setDiffContent(data.diff || 'No changes');
    } catch { setDiffContent('(Failed to load diff)'); }
  }, [projectPath]);

  const toggleSkillItem = useCallback(async (name: string, type: string, scope: string) => {
    if (expandedSkillItem === name) {
      setExpandedSkillItem(null);
      setSkillEditing(false);
      return;
    }
    setExpandedSkillItem(name);
    setSkillItemFiles([]);
    setSkillFileContent('');
    setSkillActivePath('');
    setSkillEditing(false);
    const isGlobal = scope === 'global';
    const project = isGlobal ? '' : projectPath;
    try {
      const res = await fetch(`/api/skills/local?action=files&name=${encodeURIComponent(name)}&type=${type}&project=${encodeURIComponent(project)}`);
      const data = await res.json();
      setSkillItemFiles(data.files || []);
      const firstMd = (data.files || []).find((f: any) => f.path.endsWith('.md'));
      if (firstMd) loadSkillFile(name, type, firstMd.path, project);
    } catch {}
  }, [expandedSkillItem, projectPath]);

  const loadSkillFile = async (name: string, type: string, path: string, project: string) => {
    setSkillActivePath(path);
    setSkillEditing(false);
    setSkillFileContent('Loading...');
    try {
      const res = await fetch(`/api/skills/local?action=read&name=${encodeURIComponent(name)}&type=${type}&path=${encodeURIComponent(path)}&project=${encodeURIComponent(project)}`);
      const data = await res.json();
      setSkillFileContent(data.content || '');
      setSkillFileHash(data.hash || '');
    } catch { setSkillFileContent('(Failed to load)'); }
  };

  const saveSkillFile = async (name: string, type: string, path: string) => {
    setSkillSaving(true);
    const res = await fetch('/api/skills/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, project: projectPath, path, content: skillEditContent, expectedHash: skillFileHash }),
    });
    const data = await res.json();
    if (data.ok) {
      setSkillFileContent(skillEditContent);
      setSkillFileHash(data.hash);
      setSkillEditing(false);
    } else {
      alert(data.error || 'Save failed');
    }
    setSkillSaving(false);
  };

  const handleUpdate = async (name: string) => {
    const checkRes = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check-modified', name }),
    });
    const checkData = await checkRes.json();
    if (checkData.modified) {
      if (!confirm('Local files have been modified. Overwrite with remote version?')) return;
    }
    const target = projectPath || 'global';
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'install', name, target, force: true }),
    });
    fetchProjectSkills();
  };

  const uninstallSkill = async (name: string, scope: string) => {
    const target = scope === 'global' ? 'global' : projectPath;
    const label = scope === 'global' ? 'global' : projectName;
    if (!confirm(`Uninstall "${name}" from ${label}?`)) return;
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'uninstall', name, target }),
    });
    fetchProjectSkills();
  };

  const fetchPipelineBindings = useCallback(async () => {
    try {
      const res = await fetch(`/api/project-pipelines?project=${encodeURIComponent(projectPath)}`);
      if (!res.ok) return;
      const data = await res.json();
      setPipelineBindings(data.bindings || []);
      setPipelineRuns(data.runs || []);
      setAvailableWorkflows(data.workflows || []);
    } catch {}
  }, [projectPath]);

  const triggerProjectPipeline = async (workflowName: string, input?: Record<string, string>) => {
    try {
      const res = await fetch('/api/project-pipelines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'trigger', projectPath, projectName, workflowName, input }),
      });
      const data = await res.json();
      if (data.ok) { fetchPipelineBindings(); }
      else { alert(data.error || 'Failed'); }
    } catch { alert('Failed to trigger pipeline'); }
  };

  const fetchClaudeMd = useCallback(async () => {
    try {
      const [contentRes, statusRes, listRes] = await Promise.all([
        fetch(`/api/claude-templates?action=read-claude-md&project=${encodeURIComponent(projectPath)}`),
        fetch(`/api/claude-templates?action=status&project=${encodeURIComponent(projectPath)}`),
        fetch('/api/claude-templates?action=list'),
      ]);
      const contentData = await contentRes.json();
      setClaudeMdContent(contentData.content || '');
      setClaudeMdExists(contentData.exists || false);
      const statusData = await statusRes.json();
      setClaudeInjectedIds(new Set((statusData.status || []).filter((s: any) => s.injected).map((s: any) => s.id)));
      const listData = await listRes.json();
      setClaudeTemplates(listData.templates || []);
    } catch {}
  }, [projectPath]);

  const injectToProject = async (templateId: string) => {
    await fetch('/api/claude-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'inject', templateId, projects: [projectPath] }),
    });
    fetchClaudeMd();
  };

  const removeFromProject = async (templateId: string) => {
    if (!confirm(`Remove template from this project's CLAUDE.md?`)) return;
    await fetch('/api/claude-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove', templateId, project: projectPath }),
    });
    fetchClaudeMd();
  };

  const saveClaudeMd = async (content: string) => {
    await fetch('/api/claude-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save-claude-md', project: projectPath, content }),
    });
    setClaudeMdContent(content);
    setClaudeEditing(false);
    fetchClaudeMd();
  };

  const fetchProjectSkills = useCallback(async () => {
    try {
      const [registryRes, localRes] = await Promise.all([
        fetch('/api/skills'),
        fetch(`/api/skills/local?action=scan&project=${encodeURIComponent(projectPath)}`),
      ]);
      const registryData = await registryRes.json();
      const localData = await localRes.json();

      const registryItems = (registryData.skills || []).filter((s: any) =>
        s.installedGlobal || (s.installedProjects || []).includes(projectPath)
      ).map((s: any) => ({
        name: s.name,
        displayName: s.displayName,
        type: s.type || 'command',
        version: s.version || '',
        installedVersion: s.installedVersion || '',
        hasUpdate: s.hasUpdate || false,
        source: 'registry' as const,
        scope: s.installedGlobal && (s.installedProjects || []).includes(projectPath) ? 'global + project'
          : s.installedGlobal ? 'global'
          : 'project',
      }));

      const registryNames = new Set(registryItems.map((s: any) => s.name));
      const localItems = (localData.items || [])
        .filter((item: any) => !registryNames.has(item.name))
        .map((item: any) => ({
          name: item.name,
          displayName: item.name,
          type: item.type,
          version: '',
          installedVersion: '',
          hasUpdate: false,
          source: 'local' as const,
          scope: item.scope,
        }));

      const merged = new Map<string, any>();
      for (const item of [...registryItems, ...localItems]) {
        const existing = merged.get(item.name);
        if (existing) {
          if (existing.scope !== item.scope) {
            existing.scope = existing.scope.includes(item.scope) ? existing.scope : `${existing.scope} + ${item.scope}`;
          }
          if (item.source === 'registry') {
            Object.assign(existing, { ...item, scope: existing.scope });
          }
        } else {
          merged.set(item.name, { ...item });
        }
      }
      setProjectSkills([...merged.values()]);
    } catch { setProjectSkills([]); }
  }, [projectPath]);

  // Git operations
  const gitAction = async (action: string, extra?: any) => {
    setGitLoading(true);
    setGitResult(null);
    try {
      const res = await fetch('/api/git', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, dir: projectPath, ...extra }),
      });
      const data = await res.json();
      setGitResult(data);
      if (data.ok) fetchGitInfo();
    } catch (e: any) {
      setGitResult({ error: e.message });
    }
    setGitLoading(false);
  };

  // Load essential data on mount (git + file tree only)
  useEffect(() => {
    setSelectedFile(null);
    setFileContent(null);
    setGitResult(null);
    setCommitMsg('');
    // Fetch git info and file tree in parallel
    fetchGitInfo();
    fetchTree();
    // Fetch project-level fixed session
    fetchBoundSession();
    // Fetch temper status
    fetch(`/api/temper?project=${encodeURIComponent(projectPath)}&action=status`)
      .then(r => r.json()).then(setTemperStatus).catch(() => {});
  }, [projectPath, fetchGitInfo, fetchTree]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchBoundSession = useCallback(() => {
    fetch(`/api/project-sessions?projectPath=${encodeURIComponent(projectPath)}`)
      .then(r => r.json())
      .then(data => {
        if (data?.fixedSessionId) setBoundSession({ sessionId: data.fixedSessionId });
        else setBoundSession(null);
      })
      .catch(() => {});
  }, [projectPath]);

  // Listen for session binding changes (from SessionView or other components)
  useEffect(() => {
    const handler = () => fetchBoundSession();
    window.addEventListener('forge:session-bound', handler);
    return () => window.removeEventListener('forge:session-bound', handler);
  }, [fetchBoundSession]);

  // Lazy load tab-specific data only when switching to that tab
  useEffect(() => {
    if (projectTab === 'skills') fetchProjectSkills();
    if (projectTab === 'pipelines') fetchPipelineBindings();
    if (projectTab === 'claudemd') fetchClaudeMd();
    if (projectTab === 'temper') {
      fetch(`/api/temper?project=${encodeURIComponent(projectPath)}&action=data`)
        .then(r => r.json()).then(setTemperData).catch(() => {});
    }
  }, [projectTab, fetchProjectSkills, fetchPipelineBindings, fetchClaudeMd, projectPath]);

  // Auto-refresh pipeline runs while any is running
  useEffect(() => {
    if (projectTab !== 'pipelines') return;
    const hasRunning = pipelineRuns.some(r => r.status === 'running');
    if (!hasRunning) return;
    const timer = setInterval(fetchPipelineBindings, 4000);
    return () => clearInterval(timer);
  }, [projectTab, pipelineRuns, fetchPipelineBindings]);

  return (
    <>
      {/* Project header */}
      <div className="px-4 py-2 border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">{projectName}</span>
          {gitInfo?.branch && (
            <div className="relative">
              <select
                value={gitInfo.branch}
                onChange={async (e) => {
                  const branch = e.target.value;
                  if (branch === gitInfo.branch) return;
                  try {
                    await fetch('/api/git', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'checkout', dir: projectPath, branch }) });
                    fetchGitInfo(); fetchTree();
                  } catch {}
                }}
                className="text-[9px] text-[var(--accent)] bg-[var(--accent)]/10 px-1.5 py-0.5 rounded border-none cursor-pointer appearance-none pr-4 focus:outline-none"
                style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'8\' height=\'8\' viewBox=\'0 0 8 8\'%3E%3Cpath d=\'M0 2l4 4 4-4z\' fill=\'%2358a6ff\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center' }}
              >
                {(gitInfo.branches || []).map(b => (
                  <option key={b.name} value={b.name}>{b.name}{b.current ? ' ●' : ''}</option>
                ))}
              </select>
            </div>
          )}
          {gitInfo?.ahead ? <span className="text-[9px] text-green-400">↑{gitInfo.ahead}</span> : null}
          {gitInfo?.behind ? <span className="text-[9px] text-yellow-400">↓{gitInfo.behind}</span> : null}
          {/* Action buttons */}
          <div className="flex items-center gap-1.5 ml-auto">
            {/* Open Terminal with agent selection */}
            <AgentTerminalButton projectPath={projectPath} projectName={projectName} />
            <button
              onClick={() => { fetchGitInfo(); fetchTree(); if (selectedFile) openFile(selectedFile); }}
              className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              title="Refresh"
            >
              ↻
            </button>
          </div>
        </div>
        <div className="text-[9px] text-[var(--text-secondary)] mt-0.5 flex items-center gap-2 flex-wrap">
          <span>{projectPath}</span>
          {gitInfo?.remote && (
            <span>{gitInfo.remote.replace(/^https?:\/\//, '').replace(/^git@github\.com:/, 'github.com/').replace(/\.git$/, '')}</span>
          )}
          {/* Fixed session: show current or "set session" */}
          <span className="inline-flex items-center gap-1 px-1.5 py-0 rounded bg-[#f0883e]/10 text-[#f0883e] relative">
            {boundSession?.sessionId ? (
              <>
                <span className="text-[8px]">session:</span>
                <button onClick={() => {
                  fetch(`/api/claude-sessions/${encodeURIComponent(projectName)}`)
                    .then(r => r.json())
                    .then(data => { if (Array.isArray(data)) setAvailableSessions(data.map((s: any) => ({ id: s.sessionId || s.id, modified: s.modified || '', size: s.size || 0 }))); })
                    .catch(() => {});
                  setShowSessionPicker(!showSessionPicker);
                }}
                  className="font-mono text-[8px] hover:text-white underline decoration-dotted" title="Click to change">
                  {boundSession.sessionId.slice(0, 8)}
                </button>
                <button onClick={() => navigator.clipboard.writeText(boundSession.sessionId)}
                  className="text-[7px] hover:text-white" title={boundSession.sessionId}>copy</button>
              </>
            ) : (
              <button onClick={() => {
                fetch(`/api/claude-sessions/${encodeURIComponent(projectName)}`)
                  .then(r => r.json())
                  .then(data => { if (Array.isArray(data)) setAvailableSessions(data.map((s: any) => ({ id: s.sessionId || s.id, modified: s.modified || '', size: s.size || 0 }))); })
                  .catch(() => {});
                setShowSessionPicker(!showSessionPicker);
              }}
                className="text-[8px] hover:text-white underline decoration-dotted">
                set session
              </button>
            )}
            {/* Session picker dropdown */}
            {showSessionPicker && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-xl p-2 min-w-[280px]"
                onClick={e => e.stopPropagation()}>
                <div className="text-[9px] text-[var(--text-secondary)] mb-1.5 font-medium">{boundSession?.sessionId ? 'Change session' : 'Select session'}</div>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {availableSessions.map(s => (
                    <button key={s.id} onClick={async () => {
                      try {
                        await fetch('/api/project-sessions', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ projectPath, fixedSessionId: s.id }),
                        });
                        setBoundSession({ sessionId: s.id });
                        window.dispatchEvent(new Event('forge:session-bound'));
                      } catch {}
                      setShowSessionPicker(false);
                    }}
                      className={`w-full text-left px-2 py-1.5 rounded text-[9px] flex items-center gap-2 ${
                        s.id === boundSession?.sessionId
                          ? 'bg-[#f0883e]/20 text-[#f0883e]'
                          : 'hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
                      }`}>
                      <span className="font-mono">{s.id.slice(0, 8)}</span>
                      {s.id === boundSession?.sessionId && <span className="text-[7px]">current</span>}
                      {s.modified && <span className="text-[8px] opacity-60">{(() => { const d = Date.now() - new Date(s.modified).getTime(); return d < 3600000 ? `${Math.floor(d/60000)}m ago` : d < 86400000 ? `${Math.floor(d/3600000)}h ago` : new Date(s.modified).toLocaleDateString(); })()}</span>}
                      {s.size > 0 && <span className="text-[8px] opacity-60">{s.size < 1048576 ? `${(s.size/1024).toFixed(0)}KB` : `${(s.size/1048576).toFixed(1)}MB`}</span>}
                    </button>
                  ))}
                  {availableSessions.length === 0 && <div className="text-[9px] text-[var(--text-secondary)] px-2 py-1">No sessions found</div>}
                </div>
                <button onClick={() => setShowSessionPicker(false)}
                  className="w-full mt-1.5 text-[8px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] pt-1 border-t border-[var(--border)]">Close</button>
              </div>
            )}
          </span>
        </div>
        {/* Tab switcher */}
        <div className="flex items-center gap-2 mt-1.5">
          <div className="flex bg-[var(--bg-tertiary)] rounded p-0.5">
            <button
              onClick={() => setProjectTab('code')}
              className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
                projectTab === 'code' ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >Code</button>
            <button
              onClick={() => setProjectTab('workspace')}
              className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
                projectTab === 'workspace' ? 'bg-[var(--accent)]/20 text-[var(--accent)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >🔨 Workspace</button>
            <button
              onClick={() => setProjectTab('sessions')}
              className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
                projectTab === 'sessions' ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >Sessions</button>
            <button
              onClick={() => setProjectTab('skills')}
              className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
                projectTab === 'skills' ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Skills & Cmds
              {projectSkills.length > 0 && <span className="ml-1 text-[8px] text-[var(--text-secondary)]">({projectSkills.length})</span>}
              {projectSkills.some(s => s.hasUpdate) && <span className="ml-1 text-[8px] text-[var(--yellow)]">!</span>}
            </button>
            <button
              onClick={() => setProjectTab('claudemd')}
              className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
                projectTab === 'claudemd' ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              CLAUDE.md
              {claudeMdExists && <span className="ml-1 text-[8px] text-[var(--green)]">•</span>}
            </button>
            <button
              onClick={() => setProjectTab('pipelines')}
              className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
                projectTab === 'pipelines' ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Pipelines
              {pipelineBindings.length > 0 && <span className="ml-1 text-[8px] text-[var(--text-secondary)]">({pipelineBindings.length})</span>}
            </button>
            {/* Memory tab button — show when enabled (scanning or initialized) */}
            {temperStatus?.enabled && (
              <button
                onClick={() => setProjectTab('temper')}
                className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
                  projectTab === 'temper' ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {temperAction === 'init' ? <span className="animate-pulse">Memory...</span> : 'Memory'}
                {temperStatus.stats?.nodes ? <span className="ml-1 text-[8px] text-[var(--text-secondary)]">({temperStatus.stats.nodes})</span> : null}
              </button>
            )}
            {/* Temper status indicator */}
            {temperStatus && (
              <TemperIndicator
                status={temperStatus}
                projectPath={projectPath}
                activeAction={temperAction}
                onAction={async (action) => {
                  setTemperAction(action);
                  try {
                    const r = await fetch('/api/temper', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ projectPath, action }),
                    });
                    const result = await r.json();
                    if (result.error) {
                      console.error('Temper action failed:', result.error);
                    }
                    const s = await fetch(`/api/temper?project=${encodeURIComponent(projectPath)}&action=status`).then(r => r.json());
                    setTemperStatus(s);
                    // Refresh data after scan completes
                    if (action === 'init' && !result.error) {
                      const d = await fetch(`/api/temper?project=${encodeURIComponent(projectPath)}&action=data`).then(r => r.json());
                      setTemperData(d);
                    }
                  } catch (e) {
                    console.error('Temper action error:', e);
                  } finally { setTemperAction(null); }
                }}
              />
            )}
          </div>
        </div>
        {projectTab === 'code' && gitInfo?.lastCommit && (
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[9px] text-[var(--text-secondary)] font-mono truncate">{gitInfo.lastCommit}</span>
            <button
              onClick={() => setShowLog(v => !v)}
              className={`text-[9px] px-1.5 py-0.5 rounded shrink-0 ${showLog ? 'text-white bg-[var(--accent)]/30' : 'text-[var(--accent)] hover:bg-[var(--accent)]/10'}`}
            >
              History
            </button>
          </div>
        )}
      </div>

      {/* Git log */}
      {projectTab === 'code' && showLog && gitInfo?.log && gitInfo.log.length > 0 && (
        <div className="max-h-48 overflow-y-auto border-b border-[var(--border)] bg-[var(--bg-tertiary)]">
          {gitInfo.log.map(c => (
            <div key={c.hash} className="px-4 py-1.5 border-b border-[var(--border)]/30 text-xs flex items-start gap-2">
              <span className="font-mono text-[var(--accent)] shrink-0 text-[10px]">{c.hash}</span>
              <span className="text-[var(--text-primary)] truncate flex-1">{c.message}</span>
              <span className="text-[var(--text-secondary)] text-[9px] shrink-0">{c.author}</span>
              <span className="text-[var(--text-secondary)] text-[9px] shrink-0 w-16 text-right">{c.date}</span>
            </div>
          ))}
        </div>
      )}

      {/* Workspace tab */}
      {projectTab === 'workspace' && (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <WorkspaceViewLazy
              ref={wsViewRef}
              projectPath={projectPath}
              projectName={projectName}
              onClose={() => setProjectTab('code')}
            />
          </Suspense>
        </div>
      )}

      {/* Sessions tab */}
      {projectTab === 'sessions' && (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          <Suspense fallback={<div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">Loading...</div>}>
            <SessionViewLazy
              projectName={projectName}
              projects={[{ name: projectName, path: projectPath, language: null }]}
              singleProject
            />
          </Suspense>
        </div>
      )}

      {/* Code content area */}
      {projectTab === 'code' && <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* File tree + search */}
        <div style={{ width: sidebarWidth }} className="flex flex-col shrink-0">
          {/* Search input */}
          <div className="p-1 border-b border-[var(--border)]">
            <input
              value={codeSearch}
              onChange={e => setCodeSearch(e.target.value)}
              onKeyDown={async e => {
                if (e.key === 'Enter' && codeSearch.trim()) {
                  setCodeSearching(true);
                  try {
                    const res = await fetch(`/api/code?dir=${encodeURIComponent(projectPath)}&search=${encodeURIComponent(codeSearch.trim())}`);
                    const data = await res.json();
                    setCodeSearchResults(data.matches || []);
                  } catch { setCodeSearchResults([]); }
                  setCodeSearching(false);
                }
                if (e.key === 'Escape') { setCodeSearch(''); setCodeSearchResults([]); }
              }}
              placeholder="Search code... (Enter)"
              className="w-full text-[10px] bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] placeholder-[var(--text-secondary)]"
            />
          </div>
          {/* Search results */}
          {codeSearchResults.length > 0 && (
            <div className="overflow-y-auto border-b border-[var(--border)] max-h-60">
              <div className="px-2 py-0.5 text-[8px] text-[var(--text-secondary)] bg-[var(--bg-tertiary)] sticky top-0 flex items-center justify-between">
                <span>{codeSearchResults.length} results for "{codeSearch}"</span>
                <button onClick={() => { setCodeSearch(''); setCodeSearchResults([]); }} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">✕</button>
              </div>
              {codeSearchResults.map((r, i) => (
                <div key={i} onClick={() => openFile(r.file)} className="px-2 py-0.5 cursor-pointer hover:bg-[var(--bg-tertiary)] border-b border-[var(--border)]/30">
                  <div className="text-[9px] text-[var(--accent)] truncate">{r.file}:{r.line}</div>
                  <div className="text-[8px] text-[var(--text-secondary)] font-mono truncate">{r.content}</div>
                </div>
              ))}
            </div>
          )}
          {codeSearching && <div className="px-2 py-1 text-[9px] text-[var(--text-secondary)]">Searching...</div>}
          {/* File tree */}
          <div className="overflow-y-auto flex-1 p-1">
            {fileTree.map((node: any) => (
              <FileTreeNode key={node.path} node={node} depth={0} selected={selectedFile} onSelect={openFile} />
            ))}
          </div>
        </div>

        {/* Sidebar resize handle */}
        <div
          onMouseDown={onSidebarDragStart}
          className="w-1 bg-[var(--border)] cursor-col-resize shrink-0 hover:bg-[var(--accent)]/50 transition-colors"
        />

        {/* File content */}
        <div className="flex-1 min-w-0 overflow-auto bg-[var(--bg-primary)]" style={{ width: 0 }}>
          {/* Diff view */}
          {diffContent !== null && diffFile ? (
            <>
              <div className="px-3 py-1 border-b border-[var(--border)] text-[10px] sticky top-0 bg-[var(--bg-primary)] z-10 flex items-center gap-2">
                <span className="text-[var(--yellow)]">DIFF</span>
                <span className="text-[var(--text-secondary)]">{diffFile}</span>
                <button onClick={() => { if (diffFile) openFile(diffFile); }} className="ml-auto text-[9px] text-[var(--accent)] hover:underline">Open Source</button>
              </div>
              <pre className="p-4 text-[12px] leading-[1.5] font-mono whitespace-pre" style={{ fontFamily: 'Menlo, Monaco, "Courier New", monospace', tabSize: 2 }}>
                {diffContent.split('\n').map((line, i) => {
                  const color = line.startsWith('+') ? 'text-green-400 bg-green-900/20'
                    : line.startsWith('-') ? 'text-red-400 bg-red-900/20'
                    : line.startsWith('@@') ? 'text-cyan-400'
                    : line.startsWith('diff') || line.startsWith('index') ? 'text-[var(--text-secondary)]'
                    : 'text-[var(--text-primary)]';
                  return <div key={i} className={`${color} px-2`}>{line || ' '}</div>;
                })}
              </pre>
            </>
          ) : fileLoading ? (
            <div className="h-full flex items-center justify-center text-xs text-[var(--text-secondary)]">Loading...</div>
          ) : selectedFile && fileImageUrl ? (
            <>
              <div className="px-3 py-1 border-b border-[var(--border)] text-[10px] text-[var(--text-secondary)] sticky top-0 bg-[var(--bg-primary)] z-10">{selectedFile}</div>
              <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
                <img src={fileImageUrl} alt={selectedFile} className="max-w-full max-h-full object-contain rounded" />
              </div>
            </>
          ) : selectedFile && fileBinaryInfo ? (
            <>
              <div className="px-3 py-1 border-b border-[var(--border)] text-[10px] text-[var(--text-secondary)] sticky top-0 bg-[var(--bg-primary)] z-10">{selectedFile}</div>
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--text-secondary)]">
                <span className="text-2xl">📄</span>
                <span className="text-xs">{fileBinaryInfo.fileType ? fileBinaryInfo.fileType.toUpperCase() + ' file' : 'File'} — {fileBinaryInfo.sizeLabel}</span>
                {fileBinaryInfo.message && <span className="text-[10px]">{fileBinaryInfo.message}</span>}
                <span className="text-[10px]">Binary file cannot be displayed</span>
              </div>
            </>
          ) : selectedFile && fileContent !== null ? (
            <>
              <div className="px-3 py-1 border-b border-[var(--border)] text-[10px] text-[var(--text-secondary)] sticky top-0 bg-[var(--bg-primary)] z-10">{selectedFile}</div>
              <pre className="p-4 text-[12px] leading-[1.5] font-mono text-[var(--text-primary)] whitespace-pre" style={{ fontFamily: 'Menlo, Monaco, "Courier New", monospace', tabSize: 2 }}>
                {fileContent.split('\n').map((line, i) => (
                  <div key={i} className="flex hover:bg-[var(--bg-tertiary)]/50">
                    <span className="select-none text-[var(--text-secondary)]/40 text-right pr-4 w-10 shrink-0">{i + 1}</span>
                    <span className="flex-1">{highlightLine(line)}</span>
                  </div>
                ))}
              </pre>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-secondary)]">
              Select a file to view
            </div>
          )}
        </div>
      </div>}

      {/* Skills & Commands tab */}
      {projectTab === 'skills' && (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Left: skill/command tree */}
          <div style={{ width: sidebarWidth }} className="overflow-y-auto p-1 shrink-0">
            {projectSkills.length === 0 ? (
              <p className="text-[9px] text-[var(--text-secondary)] p-2">No skills or commands installed</p>
            ) : (
              projectSkills.map(s => (
                <div key={`${s.name}-${s.scope}-${s.source}`}>
                  <button
                    onClick={() => toggleSkillItem(s.name, s.type, s.scope)}
                    className={`w-full text-left px-2 py-1 text-[10px] rounded flex items-center gap-1.5 group ${
                      expandedSkillItem === s.name ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                    }`}
                  >
                    <span className="text-[8px] text-[var(--text-secondary)]">{expandedSkillItem === s.name ? '▾' : '▸'}</span>
                    <span className={`text-[7px] px-1 rounded font-medium shrink-0 ${
                      s.type === 'skill' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'
                    }`}>{s.type === 'skill' ? 'S' : 'C'}</span>
                    <span className="truncate flex-1">{s.name}</span>
                    <span className={`text-[7px] shrink-0 ${s.scope === 'global' ? 'text-green-400' : 'text-[var(--accent)]'}`}>{s.scope === 'global' ? 'G' : s.scope === 'project' ? 'P' : 'G+P'}</span>
                    {s.hasUpdate && <span className="text-[7px] text-[var(--yellow)] shrink-0">!</span>}
                    {s.source === 'local' && <span className="text-[7px] text-[var(--text-secondary)] shrink-0">local</span>}
                    {s.source === 'registry' && <span className="text-[7px] text-[var(--accent)] shrink-0">mkt</span>}
                    <span
                      onClick={(e) => { e.stopPropagation(); uninstallSkill(s.name, s.scope); }}
                      className="text-[8px] text-[var(--text-secondary)] hover:text-[var(--red)] shrink-0 opacity-0 group-hover:opacity-100 cursor-pointer"
                    >x</span>
                  </button>
                  {/* Expanded file list */}
                  {expandedSkillItem === s.name && skillItemFiles.length > 0 && (
                    <div className="ml-4">
                      {skillItemFiles.map(f => (
                        <button
                          key={f.path}
                          onClick={() => loadSkillFile(s.name, s.type, f.path, s.scope === 'global' ? '' : projectPath)}
                          className={`w-full text-left px-2 py-0.5 text-[9px] rounded truncate ${
                            skillActivePath === f.path ? 'text-[var(--accent)] bg-[var(--accent)]/10' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                          }`}
                          title={f.path}
                        >
                          {f.path.split('/').pop()}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Sidebar resize handle */}
          <div
            onMouseDown={onSidebarDragStart}
            className="w-1 bg-[var(--border)] cursor-col-resize shrink-0 hover:bg-[var(--accent)]/50 transition-colors"
          />

          {/* Right: file content / editor */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-[var(--bg-primary)]">
            {skillActivePath ? (
              <>
                <div className="flex items-center gap-2 px-3 py-1 border-b border-[var(--border)] shrink-0">
                  <span className="text-[10px] text-[var(--text-secondary)] font-mono truncate flex-1">{skillActivePath}</span>
                  {expandedSkillItem && (() => {
                    const s = projectSkills.find(x => x.name === expandedSkillItem);
                    return s && (
                      <div className="flex items-center gap-2 shrink-0">
                        {s.version && <span className="text-[8px] text-[var(--text-secondary)] font-mono">v{s.installedVersion || s.version}</span>}
                        {s.hasUpdate && (
                          <button
                            onClick={() => handleUpdate(s.name)}
                            className="text-[8px] px-1.5 py-0.5 rounded bg-[var(--yellow)]/20 text-[var(--yellow)] hover:bg-[var(--yellow)]/30"
                          >Update → v{s.version}</button>
                        )}
                      </div>
                    );
                  })()}
                  {!skillEditing ? (
                    <button
                      onClick={() => { setSkillEditing(true); setSkillEditContent(skillFileContent); }}
                      className="text-[9px] text-[var(--accent)] hover:underline shrink-0"
                    >Edit</button>
                  ) : (
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => { if (expandedSkillItem) saveSkillFile(expandedSkillItem, projectSkills.find(x => x.name === expandedSkillItem)?.type || 'command', skillActivePath); }}
                        disabled={skillSaving}
                        className="text-[9px] px-2 py-0.5 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50"
                      >{skillSaving ? '...' : 'Save'}</button>
                      <button
                        onClick={() => setSkillEditing(false)}
                        className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      >Cancel</button>
                    </div>
                  )}
                </div>
                <div className="flex-1 overflow-auto">
                  {skillEditing ? (
                    <textarea
                      value={skillEditContent}
                      onChange={e => setSkillEditContent(e.target.value)}
                      className="w-full h-full p-3 text-[11px] font-mono bg-[var(--bg-primary)] text-[var(--text-primary)] border-none outline-none resize-none"
                      spellCheck={false}
                    />
                  ) : (
                    <pre className="p-3 text-[11px] leading-[1.5] font-mono text-[var(--text-primary)] whitespace-pre-wrap break-words">
                      {skillFileContent}
                    </pre>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-secondary)]">
                Select a skill or command to view
              </div>
            )}
          </div>
        </div>
      )}

      {/* CLAUDE.md tab */}
      {projectTab === 'claudemd' && (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Left: templates list */}
          <div style={{ width: sidebarWidth }} className="overflow-y-auto shrink-0 flex flex-col">
            <button
              onClick={() => { setClaudeSelectedTemplate(null); setClaudeEditing(false); }}
              className={`w-full px-2 py-1.5 border-b border-[var(--border)] text-[10px] text-left flex items-center gap-1 ${
                !claudeSelectedTemplate && !claudeEditing ? 'text-[var(--accent)] bg-[var(--accent)]/5' : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
              }`}
            >
              <span className="font-mono">CLAUDE.md</span>
              {claudeMdExists && <span className="text-[var(--green)] text-[8px]">•</span>}
            </button>
            <div className="px-2 py-1 border-b border-[var(--border)] text-[8px] text-[var(--text-secondary)] uppercase">Templates</div>
            <div className="flex-1 overflow-y-auto">
              {claudeTemplates.map(t => {
                const injected = claudeInjectedIds.has(t.id);
                const isSelected = claudeSelectedTemplate === t.id;
                return (
                  <div
                    key={t.id}
                    className={`px-2 py-1.5 border-b border-[var(--border)]/30 cursor-pointer ${isSelected ? 'bg-[var(--accent)]/10' : 'hover:bg-[var(--bg-tertiary)]'}`}
                    onClick={() => setClaudeSelectedTemplate(isSelected ? null : t.id)}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-[var(--text-primary)] truncate flex-1">{t.name}</span>
                      {t.builtin && <span className="text-[7px] text-[var(--text-secondary)]">built-in</span>}
                      {injected ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); removeFromProject(t.id); }}
                          className="text-[7px] px-1 rounded bg-green-500/10 text-green-400 hover:bg-red-500/10 hover:text-red-400"
                          title="Remove from CLAUDE.md"
                        >added</button>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); injectToProject(t.id); }}
                          className="text-[7px] px-1 rounded bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20"
                          title="Add to CLAUDE.md"
                        >+ add</button>
                      )}
                    </div>
                    <p className="text-[8px] text-[var(--text-secondary)] mt-0.5 line-clamp-1">{t.description}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Sidebar resize handle */}
          <div
            onMouseDown={onSidebarDragStart}
            className="w-1 bg-[var(--border)] cursor-col-resize shrink-0 hover:bg-[var(--accent)]/50 transition-colors"
          />

          {/* Right: CLAUDE.md content or template preview */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-[var(--bg-primary)]">
            {/* Header bar */}
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] shrink-0">
              {claudeSelectedTemplate ? (
                <>
                  <span className="text-[10px] text-[var(--text-secondary)]">Preview:</span>
                  <span className="text-[10px] text-[var(--text-primary)] font-semibold">{claudeTemplates.find(t => t.id === claudeSelectedTemplate)?.name}</span>
                  <button
                    onClick={() => setClaudeSelectedTemplate(null)}
                    className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] ml-auto"
                  >Show CLAUDE.md</button>
                </>
              ) : (
                <>
                  <span className="text-[10px] text-[var(--text-primary)] font-mono">CLAUDE.md</span>
                  {!claudeMdExists && <span className="text-[8px] text-[var(--yellow)]">not created</span>}
                  <div className="flex items-center gap-1 ml-auto">
                    {!claudeEditing ? (
                      <button
                        onClick={() => { setClaudeEditing(true); setClaudeEditContent(claudeMdContent); }}
                        className="text-[9px] text-[var(--accent)] hover:underline"
                      >Edit</button>
                    ) : (
                      <>
                        <button
                          onClick={() => saveClaudeMd(claudeEditContent)}
                          className="text-[9px] px-2 py-0.5 bg-[var(--accent)] text-white rounded hover:opacity-90"
                        >Save</button>
                        <button
                          onClick={() => setClaudeEditing(false)}
                          className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >Cancel</button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto" style={{ width: 0, minWidth: '100%' }}>
              {claudeSelectedTemplate ? (
                <pre className="p-3 text-[11px] font-mono text-[var(--text-primary)] whitespace-pre-wrap break-words">
                  {claudeTemplates.find(t => t.id === claudeSelectedTemplate)?.content || ''}
                </pre>
              ) : claudeEditing ? (
                <textarea
                  value={claudeEditContent}
                  onChange={e => setClaudeEditContent(e.target.value)}
                  className="w-full h-full p-3 text-[11px] font-mono bg-[var(--bg-primary)] text-[var(--text-primary)] border-none outline-none resize-none"
                  spellCheck={false}
                />
              ) : (
                <pre className="p-3 text-[11px] font-mono text-[var(--text-primary)] whitespace-pre-wrap break-words">
                  {claudeMdContent || '(Empty — add templates or edit directly)'}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Pipelines tab */}
      {projectTab === 'pipelines' && (
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Bound workflows */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[var(--text-primary)]">Bound Pipelines</span>
              <button
                onClick={() => setShowAddPipeline(v => !v)}
                className="text-[9px] px-2 py-0.5 bg-[var(--accent)] text-white rounded hover:opacity-90 ml-auto"
              >+ Add</button>
            </div>

            {/* Add pipeline form */}
            {showAddPipeline && (
              <div className="border border-[var(--border)] rounded p-2 space-y-2">
                {availableWorkflows.filter(w => !pipelineBindings.find(b => b.workflowName === w.name)).map(w => (
                  <button
                    key={w.name}
                    onClick={async () => {
                      await fetch('/api/project-pipelines', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'add', projectPath, projectName, workflowName: w.name }),
                      });
                      setShowAddPipeline(false);
                      fetchPipelineBindings();
                    }}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] text-[10px] flex items-center gap-2"
                  >
                    {w.builtin && <span className="text-[7px] text-[var(--text-secondary)]">⚙</span>}
                    <span className="text-[var(--text-primary)]">{w.name}</span>
                    {w.description && <span className="text-[var(--text-secondary)] truncate ml-auto text-[8px]">{w.description}</span>}
                  </button>
                ))}
                {availableWorkflows.filter(w => !pipelineBindings.find(b => b.workflowName === w.name)).length === 0 && (
                  <p className="text-[9px] text-[var(--text-secondary)] p-2">All workflows already bound</p>
                )}
              </div>
            )}

            {/* Bound pipeline list */}
            {pipelineBindings.length === 0 ? (
              <p className="text-[10px] text-[var(--text-secondary)]">No pipelines bound. Click + Add to attach a workflow.</p>
            ) : (
              pipelineBindings.map(b => (
                <div key={b.workflowName} className="border border-[var(--border)] rounded p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-[var(--text-primary)]">{b.workflowName}</span>
                    <label className="flex items-center gap-1 text-[9px] text-[var(--text-secondary)] cursor-pointer ml-auto">
                      <input type="checkbox" checked={b.enabled} onChange={async (e) => {
                        await fetch('/api/project-pipelines', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'update', projectPath, workflowName: b.workflowName, enabled: e.target.checked }),
                        });
                        fetchPipelineBindings();
                      }} className="accent-[var(--accent)]" />
                      Enabled
                    </label>
                    <div className="relative">
                      <button
                        onClick={() => {
                          const isIssueWf = b.workflowName === 'issue-auto-fix' || b.workflowName === 'issue-fix-and-review';
                          if (!isIssueWf) {
                            triggerProjectPipeline(b.workflowName, triggerInput);
                          } else {
                            setRunMenu(runMenu === b.workflowName ? null : b.workflowName);
                            setIssueInput('');
                          }
                        }}
                        className="text-[9px] px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--accent)] hover:text-white"
                      >Run</button>
                      {runMenu === b.workflowName && (
                        <div className="absolute top-full right-0 mt-1 z-20 bg-[var(--bg-secondary)] border border-[var(--border)] rounded shadow-lg p-2 space-y-2 w-[200px]">
                          <button
                            onClick={async () => {
                              setRunMenu(null);
                              try {
                                const res = await fetch('/api/project-pipelines', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ action: 'scan-now', projectPath, projectName, workflowName: b.workflowName }),
                                });
                                const data = await res.json();
                                if (data.error) alert(`Scan error: ${data.error}`);
                                else alert(`Scanned ${data.total} issues, triggered ${data.triggered} fix${data.pending > 0 ? ` (${data.pending} more pending)` : ''}`);
                                fetchPipelineBindings();
                              } catch { alert('Scan failed'); }
                            }}
                            className="w-full text-[9px] px-2 py-1.5 rounded border border-green-500/50 text-green-400 hover:bg-green-500/10 font-medium"
                          >Auto Scan — fix all new issues</button>
                          <div className="border-t border-[var(--border)]/50 my-1" />
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              value={issueInput}
                              onChange={e => setIssueInput(e.target.value)}
                              placeholder="Issue #"
                              className="flex-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[9px] text-[var(--text-primary)]"
                              onKeyDown={e => {
                                if (e.key === 'Enter' && issueInput.trim()) {
                                  setRunMenu(null);
                                  triggerProjectPipeline(b.workflowName, {
                                    ...triggerInput,
                                    issue_id: issueInput.trim(),
                                    base_branch: b.config.baseBranch || 'auto-detect',
                                  });
                                }
                              }}
                              autoFocus
                            />
                            <button
                              onClick={() => {
                                if (!issueInput.trim()) return;
                                setRunMenu(null);
                                triggerProjectPipeline(b.workflowName, {
                                  ...triggerInput,
                                  issue_id: issueInput.trim(),
                                  base_branch: b.config.baseBranch || 'auto-detect',
                                });
                              }}
                              className="text-[9px] px-2 py-1 bg-[var(--accent)] text-white rounded hover:opacity-80"
                            >Fix</button>
                          </div>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={async () => {
                        if (!confirm(`Remove "${b.workflowName}" from this project?`)) return;
                        await fetch('/api/project-pipelines', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'remove', projectPath, workflowName: b.workflowName }),
                        });
                        fetchPipelineBindings();
                      }}
                      className="text-[9px] text-[var(--red)] hover:underline"
                    >Remove</button>
                  </div>
                  {/* Schedule config */}
                  <div className="flex items-center gap-2 text-[9px]">
                    <span className="text-[var(--text-secondary)]">Schedule:</span>
                    <select
                      value={b.config.interval || 0}
                      onChange={async (e) => {
                        const interval = Number(e.target.value);
                        const newConfig = { ...b.config, interval };
                        await fetch('/api/project-pipelines', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'update', projectPath, workflowName: b.workflowName, config: newConfig }),
                        });
                        fetchPipelineBindings();
                      }}
                      className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[9px] text-[var(--text-primary)]"
                    >
                      <option value={0}>Manual only</option>
                      <option value={15}>Every 15 min</option>
                      <option value={30}>Every 30 min</option>
                      <option value={60}>Every 1 hour</option>
                      <option value={120}>Every 2 hours</option>
                      <option value={360}>Every 6 hours</option>
                      <option value={720}>Every 12 hours</option>
                      <option value={1440}>Every 24 hours</option>
                    </select>
                    {b.config.interval > 0 && b.nextRunAt && (
                      <span className="text-[8px] text-[var(--text-secondary)]">
                        Next: {new Date(b.nextRunAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                    {b.lastRunAt && (
                      <span className="text-[8px] text-[var(--text-secondary)] ml-auto">
                        Last: {new Date(b.lastRunAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                  {/* Issue scan config (for issue-fix-and-review workflow) */}
                  {(b.workflowName === 'issue-auto-fix' || b.workflowName === 'issue-fix-and-review') && (
                    <div className="space-y-1.5 pt-1 border-t border-[var(--border)]/30">
                      <div className="text-[8px] text-[var(--text-secondary)]">
                        {b.config.interval > 0
                          ? 'Scheduled mode: auto-scans GitHub issues and fixes new ones'
                          : 'Requires: gh auth login (run in terminal first)'}
                      </div>
                      <div className="flex items-center gap-2 text-[9px]">
                          <label className="text-[var(--text-secondary)]">Labels:</label>
                          <input
                            type="text"
                            defaultValue={(b.config.labels || []).join(', ')}
                            placeholder="bug, autofix (empty = all)"
                            onBlur={async (e) => {
                              const labels = e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean);
                              const newConfig = { ...b.config, labels };
                              await fetch('/api/project-pipelines', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: 'update', projectPath, workflowName: b.workflowName, config: newConfig }),
                              });
                              fetchPipelineBindings();
                            }}
                            className="flex-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[9px] text-[var(--text-primary)]"
                          />
                          <label className="text-[var(--text-secondary)]">Base:</label>
                          <input
                            type="text"
                            defaultValue={b.config.baseBranch || ''}
                            placeholder="auto-detect"
                            onBlur={async (e) => {
                              const newConfig = { ...b.config, baseBranch: e.target.value.trim() || undefined };
                              await fetch('/api/project-pipelines', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: 'update', projectPath, workflowName: b.workflowName, config: newConfig }),
                              });
                              fetchPipelineBindings();
                            }}
                            className="w-20 bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[9px] text-[var(--text-primary)]"
                          />
                        </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Execution history */}
          {pipelineRuns.length > 0 && (
            <div className="border-t border-[var(--border)] pt-3">
              <div className="text-[9px] text-[var(--text-secondary)] uppercase mb-2">Execution History</div>
              <div className="border border-[var(--border)] rounded overflow-hidden">
                {pipelineRuns.map(run => (
                  <div key={run.id} className="border-b border-[var(--border)]/30 last:border-b-0">
                    <div className="flex items-start gap-2 px-3 py-2 text-[10px]">
                      <span className={`shrink-0 mt-0.5 ${
                        run.status === 'done' ? 'text-green-400' : run.status === 'failed' ? 'text-red-400' : run.status === 'skipped' ? 'text-gray-400' : 'text-yellow-400'
                      }`}>{run.status === 'running' ? '●' : '●'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[var(--text-primary)] font-medium">{run.workflowName}</span>
                          {run.dedupKey && (
                            <span className="text-[8px] text-[var(--accent)] font-mono">{run.dedupKey.replace('issue:', '#')}</span>
                          )}
                          <button
                            onClick={async () => {
                              if (expandedRunId === run.pipelineId) {
                                setExpandedRunId(null);
                                setExpandedPipeline(null);
                              } else {
                                setExpandedRunId(run.pipelineId);
                                const res = await fetch(`/api/pipelines/${run.pipelineId}`);
                                if (res.ok) setExpandedPipeline(await res.json());
                              }
                            }}
                            className={`text-[8px] font-mono hover:underline ${expandedRunId === run.pipelineId ? 'text-[var(--accent)] font-bold' : 'text-[var(--accent)]'}`}
                            title="Expand / View in Pipelines"
                          >{run.status === 'running' ? '▾ ' : ''}{run.pipelineId.slice(0, 8)}</button>
                          <button
                            onClick={() => window.dispatchEvent(new CustomEvent('forge:navigate', { detail: { view: 'pipelines', pipelineId: run.pipelineId } }))}
                            className="text-[7px] text-[var(--text-secondary)] hover:text-[var(--accent)]"
                            title="Open in Pipeline page"
                          >↗</button>
                          <span className="text-[8px] text-[var(--text-secondary)] ml-auto">{new Date(run.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        {!expandedRunId && run.summary && (
                          <pre className="text-[9px] text-[var(--text-secondary)] mt-1 whitespace-pre-wrap break-words line-clamp-3">{run.summary}</pre>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {run.status === 'running' && (
                          <button
                            onClick={async () => {
                              await fetch(`/api/pipelines/${run.pipelineId}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: 'cancel' }),
                              });
                              fetchPipelineBindings();
                            }}
                            className="text-[8px] text-red-400 hover:underline"
                          >Cancel</button>
                        )}
                        {run.status === 'failed' && run.dedupKey && (
                          <button
                            onClick={async () => {
                              await fetch('/api/project-pipelines', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: 'reset-dedup', projectPath, workflowName: run.workflowName, dedupKey: run.dedupKey }),
                              });
                              await fetch('/api/project-pipelines', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: 'delete-run', id: run.id }),
                              });
                              fetchPipelineBindings();
                            }}
                            className="text-[8px] text-[var(--accent)] hover:underline"
                          >Retry</button>
                        )}
                        <button
                          onClick={async () => {
                            if (!confirm('Delete this run?')) return;
                            await fetch('/api/project-pipelines', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ action: 'delete-run', id: run.id }),
                            });
                            if (expandedRunId === run.pipelineId) { setExpandedRunId(null); setExpandedPipeline(null); }
                            fetchPipelineBindings();
                          }}
                          className="text-[8px] text-[var(--text-secondary)] hover:text-[var(--red)]"
                        >×</button>
                      </div>
                    </div>
                    {/* Expanded inline pipeline view */}
                    {expandedRunId === run.pipelineId && expandedPipeline && (
                      <Suspense fallback={<div className="p-2 text-[9px] text-[var(--text-secondary)]">Loading...</div>}>
                        <InlinePipelineView
                          pipeline={expandedPipeline}
                          onRefresh={async () => {
                            const res = await fetch(`/api/pipelines/${run.pipelineId}`);
                            if (res.ok) setExpandedPipeline(await res.json());
                          }}
                        />
                      </Suspense>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Memory (Temper) tab */}
      {projectTab === 'temper' && (
        <div className="flex-1 min-h-0 flex flex-col p-3 gap-2">
          {temperAction === 'init' ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2">
              <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              <span className="text-[10px] text-[var(--text-secondary)]">Initializing memory...</span>
              <span className="text-[8px] text-[var(--text-secondary)]">Scanning code & generating modules</span>
            </div>
          ) : (
            <TemperPanel data={temperData} projectPath={projectPath} onRefresh={() => {
              fetch(`/api/temper?project=${encodeURIComponent(projectPath)}&action=data`)
                .then(r => r.json()).then(setTemperData).catch(() => {});
            }} />
          )}
        </div>
      )}

      {/* Git panel — bottom (code tab only) */}
      {projectTab === 'code' && gitInfo && (
        <div className="border-t border-[var(--border)] shrink-0">
          {/* Changes list */}
          {gitInfo.changes.length > 0 && (
            <>
              <div className="overflow-y-auto border-b border-[var(--border)]" style={{ height: changesHeight }}>
                <div className="px-3 py-1 text-[9px] text-[var(--text-secondary)] bg-[var(--bg-tertiary)] sticky top-0 flex items-center gap-1 cursor-pointer z-10" onClick={() => {
                  setChangesExpanded(!changesExpanded);
                  setChangesHeight(changesExpanded ? 120 : Math.min(400, gitInfo.changes.length * 22 + 24));
                }}>
                  <span>{changesExpanded ? '▼' : '▶'}</span>
                  <span>{gitInfo.changes.length} changes</span>
                  <button onClick={(e) => { e.stopPropagation(); fetchGitInfo(); }} className="ml-auto text-[8px] hover:text-[var(--accent)]" title="Refresh">↻</button>
                </div>
                {gitInfo.changes.map(g => (
                  <div key={g.path} className="flex items-center px-3 py-0.5 text-xs hover:bg-[var(--bg-tertiary)] group">
                    <span className={`text-[10px] font-mono w-4 shrink-0 ${
                      g.status.includes('M') ? 'text-yellow-500' :
                      g.status.includes('?') ? 'text-green-500' :
                      g.status.includes('D') ? 'text-red-500' : 'text-[var(--text-secondary)]'
                    }`}>
                      {g.status.includes('?') ? '+' : g.status[0]}
                    </span>
                    <button
                      onClick={() => openDiff(g.path)}
                      className={`truncate flex-1 text-left ml-1 ${diffFile === g.path ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                      title="View diff"
                    >
                      {g.path}
                    </button>
                    <button
                      onClick={() => openFile(g.path)}
                      className="text-[8px] text-[var(--text-secondary)] hover:text-[var(--accent)] opacity-0 group-hover:opacity-100 shrink-0 ml-1"
                      title="Open source file"
                    >
                      src
                    </button>
                  </div>
                ))}
              </div>
              {/* Drag handle to resize changes list */}
              <div
                className="h-1 cursor-ns-resize hover:bg-[var(--accent)]/30 border-b border-[var(--border)]"
                onMouseDown={(e) => {
                  e.preventDefault();
                  changesResizeRef.current = { startY: e.clientY, origH: changesHeight };
                  const onMove = (ev: MouseEvent) => {
                    if (!changesResizeRef.current) return;
                    setChangesHeight(Math.max(60, Math.min(600, changesResizeRef.current.origH + ev.clientY - changesResizeRef.current.startY)));
                  };
                  const onUp = () => { changesResizeRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
                  window.addEventListener('mousemove', onMove);
                  window.addEventListener('mouseup', onUp);
                }}
              />
            </>
          )}

          {/* Git actions */}
          <div className="px-3 py-2 flex items-center gap-2">
            <input
              value={commitMsg}
              onChange={e => setCommitMsg(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && commitMsg.trim() && gitAction('commit', { message: commitMsg.trim() })}
              placeholder="Commit message..."
              className="flex-1 text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={() => commitMsg.trim() && gitAction('commit', { message: commitMsg.trim() })}
              disabled={gitLoading || !commitMsg.trim() || gitInfo.changes.length === 0}
              className="text-[10px] px-3 py-1.5 bg-[var(--accent)] text-white rounded hover:opacity-90 disabled:opacity-50 shrink-0"
            >
              Commit
            </button>
            <button
              onClick={() => gitAction('push')}
              disabled={gitLoading || gitInfo.ahead === 0}
              className="text-[10px] px-3 py-1.5 border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--accent)] hover:text-white disabled:opacity-50 shrink-0"
            >
              Push{gitInfo.ahead > 0 ? ` (${gitInfo.ahead})` : ''}
            </button>
            <button
              onClick={() => gitAction('pull')}
              disabled={gitLoading}
              className="text-[10px] px-3 py-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0"
            >
              Pull{gitInfo.behind > 0 ? ` (${gitInfo.behind})` : ''}
            </button>
          </div>

          {/* Result */}
          {gitResult && (
            <div className={`px-3 py-1 text-[10px] ${gitResult.ok ? 'text-green-400' : 'text-red-400'}`}>
              {gitResult.ok ? 'Done' : gitResult.error}
            </div>
          )}
        </div>
      )}

    </>
  );
});

// Simple file tree node
const FileTreeNode = memo(function FileTreeNode({ node, depth, selected, onSelect }: {
  node: { name: string; path: string; type: string; children?: any[] };
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);

  if (node.type === 'dir') {
    return (
      <div>
        <button
          onClick={() => setExpanded(v => !v)}
          className="w-full text-left flex items-center gap-1 px-1 py-0.5 hover:bg-[var(--bg-tertiary)] rounded text-xs"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          <span className="text-[10px] text-[var(--text-secondary)] w-3">{expanded ? '▾' : '▸'}</span>
          <span className="text-[var(--text-primary)]">{node.name}</span>
        </button>
        {expanded && node.children?.map((child: any) => (
          <FileTreeNode key={child.path} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
        ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`w-full text-left px-1 py-0.5 rounded text-xs truncate ${
        selected === node.path ? 'bg-[var(--accent)]/20 text-[var(--accent)]' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
      }`}
      style={{ paddingLeft: depth * 12 + 16 }}
    >
      {node.name}
    </button>
  );
});

// ─── Temper Panel (tab content) ──────────────────────────

const MemoryGraph = dynamic(() => import('./MemoryGraph'), { ssr: false });

const KNOWLEDGE_ICONS: Record<string, string> = {
  decision: '🎯', bug: '🐛', constraint: '⚠️', experience: '💡', note: '📝',
};

function TemperPanel({ data, projectPath, onRefresh }: {
  data: any;
  projectPath: string;
  onRefresh: () => void;
}) {
  const [knowledgeFilter, setKnowledgeFilter] = useState<string>('');
  const [expandedModule, setExpandedModule] = useState<string | null>(null);
  const [memoryView, setMemoryView] = useState<'graph' | 'knowledge' | 'experiences'>('graph');

  if (!data) {
    return <div className="text-[10px] text-[var(--text-secondary)] p-4">Loading...</div>;
  }

  const { graph, moduleGraph, modules, knowledge, experiences, causal } = data;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      {/* Header: stats bar + view toggle */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          {graph && <>
            <span className="text-[9px] text-[var(--text-secondary)]"><span className="font-mono text-[var(--text-primary)]">{graph.stats.files}</span> files</span>
            <span className="text-[9px] text-[var(--text-secondary)]"><span className="font-mono text-[var(--text-primary)]">{graph.stats.functions}</span> fn</span>
            <span className="text-[9px] text-[var(--text-secondary)]"><span className="font-mono text-[var(--text-primary)]">{graph.stats.edges}</span> edges</span>
          </>}
          {graph?.meta?.last_scan_at && (
            <span className="text-[8px] text-[var(--text-secondary)]">
              {new Date(graph.meta.last_scan_at * 1000).toLocaleDateString()}
              {graph.meta.last_scan_commit && <span className="ml-1 font-mono">{graph.meta.last_scan_commit.slice(0, 7)}</span>}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(['graph', 'knowledge', 'experiences'] as const).map(v => (
            <button key={v} onClick={() => setMemoryView(v)}
              className={`text-[8px] px-1.5 py-0.5 rounded ${memoryView === v ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              {v === 'graph' ? 'Graph' : v === 'knowledge' ? `Knowledge${knowledge?.length ? ` (${knowledge.length})` : ''}` : `Exp${experiences?.length ? ` (${experiences.length})` : ''}`}
            </button>
          ))}
          <button onClick={onRefresh} className="text-[8px] px-1.5 py-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="Refresh">↻</button>
        </div>
      </div>

      {/* Graph view */}
      {memoryView === 'graph' && (
        <div className="flex-1 min-h-0 flex flex-col gap-2">
          {/* Module dependency graph */}
          {moduleGraph && moduleGraph.nodes.length > 0 ? (
            <div className="flex-1 min-h-0 rounded border border-[var(--border)] overflow-hidden">
              <MemoryGraph moduleGraph={moduleGraph} />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-[10px] text-[var(--text-secondary)]">
              No module graph data
            </div>
          )}

          {/* Module summary below graph */}
          {moduleGraph?.modules?.length > 0 && (
            <div className="shrink-0 flex flex-wrap gap-1.5 px-1">
              {moduleGraph.modules
                .sort((a: any, b: any) => b.files - a.files)
                .map((mod: any) => (
                <span key={mod.id} className="flex items-center gap-1 bg-[var(--bg-secondary)] rounded px-2 py-0.5 text-[8px]">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: mod.color }} />
                  <span className="font-medium text-[var(--text-primary)]">{mod.id}</span>
                  <span className="text-[var(--text-secondary)]">{mod.files} files</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Knowledge view */}
      {memoryView === 'knowledge' && (
        <div className="flex-1 min-h-0 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="text"
              placeholder="Filter knowledge..."
              value={knowledgeFilter}
              onChange={e => setKnowledgeFilter(e.target.value)}
              className="text-[9px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-1.5 py-0.5 flex-1 text-[var(--text-primary)]"
            />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
            {knowledge && knowledge.length > 0 ? knowledge
              .filter((k: any) => !knowledgeFilter || k.title?.toLowerCase().includes(knowledgeFilter.toLowerCase()) || k.module?.toLowerCase().includes(knowledgeFilter.toLowerCase()))
              .map((k: any) => (
              <div key={k.id} className="bg-[var(--bg-secondary)] rounded px-2 py-1.5">
                <div className="flex items-center gap-1">
                  <span className="text-[9px]">{KNOWLEDGE_ICONS[k.type] || '📄'}</span>
                  <span className="text-[9px] font-medium text-[var(--text-primary)] flex-1 truncate">{k.title}</span>
                  <span className="text-[7px] px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{k.type}</span>
                </div>
                {k.module && <div className="text-[8px] text-[var(--accent)] mt-0.5">{k.module}</div>}
                {k.content && <div className="text-[8px] text-[var(--text-secondary)] mt-0.5 line-clamp-2">{k.content}</div>}
                {k.tags?.length > 0 && (
                  <div className="flex gap-1 mt-0.5">
                    {k.tags.map((t: string) => <span key={t} className="text-[7px] text-[var(--text-secondary)]">#{t}</span>)}
                  </div>
                )}
              </div>
            )) : (
              <div className="text-[10px] text-[var(--text-secondary)] text-center py-8">No knowledge entries yet</div>
            )}
          </div>

          {/* Causal relations */}
          {causal && causal.length > 0 && (
            <div className="shrink-0 border-t border-[var(--border)] pt-1.5">
              <div className="text-[9px] font-medium text-[var(--text-primary)] mb-1">Causal Relations ({causal.length})</div>
              <div className="space-y-0.5 max-h-24 overflow-y-auto">
                {causal.map((rel: any) => (
                  <div key={rel.id} className="flex items-center gap-1 text-[8px] px-1">
                    <span className="font-mono text-[var(--text-primary)] truncate max-w-[35%]">{rel.from_entity}</span>
                    <span className="text-[var(--accent)] shrink-0">→ {rel.relation_type} →</span>
                    <span className="font-mono text-[var(--text-primary)] truncate max-w-[35%]">{rel.to_entity}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Experiences view */}
      {memoryView === 'experiences' && (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
          {experiences && experiences.length > 0 ? experiences.map((exp: any) => (
            <div key={exp.id} className="bg-[var(--bg-secondary)] rounded px-2 py-1.5">
              <div className="text-[9px] text-[var(--text-primary)]">
                <span className="text-red-400">Symptom:</span> {exp.symptom}
              </div>
              <div className="text-[8px] text-[var(--text-secondary)] mt-0.5">
                <span className="text-yellow-400">Cause:</span> {exp.cause}
              </div>
              <div className="text-[8px] text-[var(--text-secondary)]">
                <span className="text-[var(--green)]">Fix:</span> {exp.fix}
              </div>
              {exp.module && <div className="text-[7px] text-[var(--accent)] mt-0.5">{exp.module}</div>}
            </div>
          )) : (
            <div className="text-[10px] text-[var(--text-secondary)] text-center py-8">No experiences recorded yet</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Temper Indicator ────────────────────────────────────

function TemperIndicator({ status, projectPath, activeAction, onAction }: {
  status: { installed: boolean; enabled: boolean; initialized: boolean; version?: string; stats?: any };
  projectPath: string;
  activeAction: string | null;
  onAction: (action: string) => void;
}) {
  const busy = activeAction !== null;

  // Show ongoing action status
  if (activeAction === 'install') {
    return (
      <span className="text-[9px] px-2 py-0.5 flex items-center gap-1 text-[var(--text-secondary)] animate-pulse">
        Installing Memory...
      </span>
    );
  }

  // Not installed
  if (!status.installed) {
    return (
      <button
        onClick={() => onAction('install')}
        disabled={busy}
        className="text-[9px] px-2 py-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
        title="Install code memory (@aion0/temper)"
      >
        Memory ↓
      </button>
    );
  }

  // Installed but not enabled
  if (!status.enabled) {
    return (
      <button
        onClick={() => onAction('enable')}
        disabled={busy}
        className="text-[9px] px-2 py-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
        title="Enable code memory for this project"
      >
        {activeAction === 'enable' ? 'Enabling...' : '○ Memory'}
      </button>
    );
  }

  // Enabled but not scanned — show scan button (unless Memory tab already visible)
  if (!status.initialized) {
    return (
      <span className="text-[9px] px-2 py-0.5 flex items-center gap-1 text-[var(--text-secondary)]">
        <span className="text-yellow-500">●</span>
        <button
          onClick={() => onAction('init')}
          disabled={busy}
          className="hover:text-[var(--text-primary)] disabled:opacity-50"
          title="Initialize memory (scan + modules)"
        >
          {activeAction === 'init' ? <span className="animate-pulse">Init...</span> : 'Init'}
        </button>
        {!busy && <button onClick={() => onAction('disable')} className="text-[7px] hover:text-red-400 ml-0.5" title="Disable">×</button>}
      </span>
    );
  }

  // Active
  return (
    <span className="text-[9px] px-2 py-0.5 flex items-center gap-1 text-[var(--text-secondary)]"
      title={status.version || 'Memory active'}>
      <span className="text-[var(--green)]">●</span> Memory
      <button onClick={() => onAction('disable')} className="text-[7px] hover:text-red-400 ml-0.5" title="Disable memory">×</button>
    </span>
  );
}

// ─── Agent Terminal Button ───────────────────────────────

function AgentTerminalButton({ projectPath, projectName }: { projectPath: string; projectName: string }) {
  const [agents, setAgents] = useState<{ id: string; name: string; detected?: boolean; isProfile?: boolean; base?: string; backendType?: string; env?: Record<string, string>; model?: string }[]>([]);
  const [showMenu, setShowMenu] = useState(false);
  const [pickerInfo, setPickerInfo] = useState<{ agentId: string; agentName: string; env?: Record<string, string>; model?: string; supportsSession: boolean; currentSessionId: string | null } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/agents').then(r => r.json())
      .then(d => setAgents(d.agents || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!showMenu) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as globalThis.Node)) setShowMenu(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showMenu]);

  const openTerminal = (agentId: string, resumeMode?: boolean, sessionId?: string, env?: Record<string, string>, model?: string) => {
    setPickerInfo(null);
    setShowMenu(false);
    const profileEnv: Record<string, string> = { ...(env || {}) };
    if (model) profileEnv.CLAUDE_MODEL = model;
    window.dispatchEvent(new CustomEvent('forge:open-terminal', {
      detail: { projectPath, projectName, agentId, resumeMode, sessionId, profileEnv: Object.keys(profileEnv).length > 0 ? profileEnv : undefined },
    }));
  };

  const handleAgentClick = async (a: typeof agents[0]) => {
    setShowMenu(false);
    try {
      const res = await fetch(`/api/agents?resolve=${encodeURIComponent(a.id)}`);
      const info = await res.json();
      // Resolve current session (fixedSession for this project)
      let currentSessionId: string | null = null;
      if (info.supportsSession) {
        try {
          const { resolveFixedSession } = await import('@/lib/session-utils');
          currentSessionId = await resolveFixedSession(projectPath) || null;
        } catch {}
      }
      setPickerInfo({
        agentId: a.id, agentName: a.name,
        env: info.env, model: info.model,
        supportsSession: info.supportsSession ?? true,
        currentSessionId,
      });
    } catch {
      openTerminal(a.id);
    }
  };

  const allAgents = agents.filter(a => a.detected !== false || a.isProfile);

  return (
    <>
      <div ref={ref} className="relative">
        <div className="flex items-center">
          <button
            onClick={() => handleAgentClick({ id: 'claude', name: 'Claude' })}
            className="text-[9px] px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] rounded-l hover:bg-[var(--accent)] hover:text-white transition-colors"
            title="Open terminal"
          >
            Terminal
          </button>
          {allAgents.length > 1 && (
            <button
              onClick={() => setShowMenu(v => !v)}
              className="text-[9px] px-1 py-0.5 border border-l-0 border-[var(--accent)] text-[var(--accent)] rounded-r hover:bg-[var(--accent)] hover:text-white transition-colors"
            >
              ▾
            </button>
          )}
        </div>
        {showMenu && (
          <div className="absolute right-0 top-full mt-1 w-44 rounded border border-[var(--border)] shadow-lg z-40 overflow-hidden" style={{ background: 'var(--bg-primary)' }}>
            {allAgents.map(a => (
              <button key={a.id} onClick={() => handleAgentClick(a)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] text-left">
                <span className="font-bold w-4 text-center text-[var(--accent)]">
                  {a.isProfile ? '●' : a.id === 'claude' ? 'C' : a.id === 'codex' ? 'X' : a.id === 'aider' ? 'A' : a.id.charAt(0).toUpperCase()}
                </span>
                <span>{a.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Unified Terminal Session Picker */}
      {pickerInfo && (
        <TerminalSessionPickerLazy
          agentLabel={pickerInfo.agentName}
          currentSessionId={pickerInfo.currentSessionId}
          supportsSession={pickerInfo.supportsSession}
          fetchSessions={() => fetchProjectSessions(projectName)}
          onSelect={(sel) => {
            if (sel.mode === 'new') {
              openTerminal(pickerInfo.agentId, false, undefined, pickerInfo.env, pickerInfo.model);
            } else {
              openTerminal(pickerInfo.agentId, true, sel.sessionId, pickerInfo.env, pickerInfo.model);
            }
          }}
          onCancel={() => setPickerInfo(null)}
        />
      )}
    </>
  );
}
