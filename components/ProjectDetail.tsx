'use client';

import React, { useState, useEffect, useCallback, memo } from 'react';
import { useSidebarResize } from '@/hooks/useSidebarResize';

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
  const [fileLanguage, setFileLanguage] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [projectSkills, setProjectSkills] = useState<{ name: string; displayName: string; type: string; scope: string; version: string; installedVersion: string; hasUpdate: boolean; source: 'registry' | 'local' }[]>([]);
  const [showSkillsDetail, setShowSkillsDetail] = useState(false);
  const [projectTab, setProjectTab] = useState<'code' | 'skills' | 'claudemd' | 'pipelines'>('code');
  // Pipeline bindings state
  const [pipelineBindings, setPipelineBindings] = useState<{ id: number; workflowName: string; enabled: boolean; config: any; lastRunAt: string | null; nextRunAt: string | null }[]>([]);
  const [pipelineRuns, setPipelineRuns] = useState<{ id: string; workflowName: string; pipelineId: string; status: string; summary: string; createdAt: string }[]>([]);
  const [availableWorkflows, setAvailableWorkflows] = useState<{ name: string; description?: string; builtin?: boolean }[]>([]);
  const [showAddPipeline, setShowAddPipeline] = useState(false);
  const [triggerInput, setTriggerInput] = useState<Record<string, string>>({});
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
    setFileLoading(true);
    try {
      const res = await fetch(`/api/code?dir=${encodeURIComponent(projectPath)}&file=${encodeURIComponent(path)}`);
      const data = await res.json();
      setFileContent(data.content || null);
      setFileLanguage(data.language || '');
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
  }, [projectPath, fetchGitInfo, fetchTree]);

  // Lazy load tab-specific data only when switching to that tab
  useEffect(() => {
    if (projectTab === 'skills') fetchProjectSkills();
    if (projectTab === 'pipelines') fetchPipelineBindings();
    if (projectTab === 'claudemd') fetchClaudeMd();
  }, [projectTab, fetchProjectSkills, fetchPipelineBindings, fetchClaudeMd]);

  return (
    <>
      {/* Project header */}
      <div className="px-4 py-2 border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--text-primary)]">{projectName}</span>
          {gitInfo?.branch && (
            <span className="text-[9px] text-[var(--accent)] bg-[var(--accent)]/10 px-1.5 py-0.5 rounded">{gitInfo.branch}</span>
          )}
          {gitInfo?.ahead ? <span className="text-[9px] text-green-400">↑{gitInfo.ahead}</span> : null}
          {gitInfo?.behind ? <span className="text-[9px] text-yellow-400">↓{gitInfo.behind}</span> : null}
          {/* Action buttons */}
          <div className="flex items-center gap-1.5 ml-auto">
            {/* Open Terminal */}
            <button
              onClick={() => {
                const event = new CustomEvent('forge:open-terminal', { detail: { projectPath, projectName } });
                window.dispatchEvent(event);
              }}
              className="text-[9px] px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--accent)] hover:text-white transition-colors"
              title="Open terminal with claude -c"
            >
              Terminal
            </button>
            <button
              onClick={() => { fetchGitInfo(); fetchTree(); if (selectedFile) openFile(selectedFile); }}
              className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              title="Refresh"
            >
              ↻
            </button>
          </div>
        </div>
        <div className="text-[9px] text-[var(--text-secondary)] mt-0.5">
          {projectPath}
          {gitInfo?.remote && (
            <span className="ml-2">{gitInfo.remote.replace(/^https?:\/\//, '').replace(/^git@github\.com:/, 'github.com/').replace(/\.git$/, '')}</span>
          )}
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

      {/* Code content area */}
      {projectTab === 'code' && <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* File tree */}
        <div style={{ width: sidebarWidth }} className="overflow-y-auto p-1 shrink-0">
          {fileTree.map((node: any) => (
            <FileTreeNode key={node.path} node={node} depth={0} selected={selectedFile} onSelect={openFile} />
          ))}
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
                    <button
                      onClick={() => triggerProjectPipeline(b.workflowName, triggerInput)}
                      className="text-[9px] px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--accent)] hover:text-white"
                    >Run</button>
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
                  <div key={run.id} className="flex items-start gap-2 px-3 py-2 border-b border-[var(--border)]/30 last:border-b-0 text-[10px]">
                    <span className={`shrink-0 ${
                      run.status === 'done' ? 'text-green-400' : run.status === 'failed' ? 'text-red-400' : 'text-yellow-400'
                    }`}>●</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[var(--text-primary)] font-medium">{run.workflowName}</span>
                        <span className="text-[8px] text-[var(--text-secondary)] font-mono">{run.pipelineId.slice(0, 8)}</span>
                        <span className="text-[8px] text-[var(--text-secondary)] ml-auto">{new Date(run.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      {run.summary && (
                        <pre className="text-[9px] text-[var(--text-secondary)] mt-1 whitespace-pre-wrap break-words line-clamp-3">{run.summary}</pre>
                      )}
                    </div>
                    <button
                      onClick={async () => {
                        if (!confirm('Delete this run?')) return;
                        await fetch('/api/project-pipelines', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'delete-run', id: run.id }),
                        });
                        fetchPipelineBindings();
                      }}
                      className="text-[8px] text-[var(--text-secondary)] hover:text-[var(--red)] shrink-0"
                    >×</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Git panel — bottom (code tab only) */}
      {projectTab === 'code' && gitInfo && (
        <div className="border-t border-[var(--border)] shrink-0">
          {/* Changes list */}
          {gitInfo.changes.length > 0 && (
            <div className="max-h-32 overflow-y-auto border-b border-[var(--border)]">
              <div className="px-3 py-1 text-[9px] text-[var(--text-secondary)] bg-[var(--bg-tertiary)] sticky top-0">
                {gitInfo.changes.length} changes
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
