'use client';

import { useState, useEffect, useCallback } from 'react';

type ItemType = 'skill' | 'command';

interface Skill {
  name: string;
  type: ItemType;
  displayName: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  score: number;
  sourceUrl: string;
  installedGlobal: boolean;
  installedVersion: string;
  hasUpdate: boolean;
  installedProjects: string[];
}

interface ProjectInfo {
  path: string;
  name: string;
}

export default function SkillsPanel({ projectFilter }: { projectFilter?: string }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [installTarget, setInstallTarget] = useState<{ skill: string; show: boolean }>({ skill: '', show: false });
  const [typeFilter, setTypeFilter] = useState<'all' | 'skill' | 'command' | 'local'>('all');
  const [localItems, setLocalItems] = useState<{ name: string; type: string; scope: string; fileCount: number; projectPath?: string }[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedLocalSections, setCollapsedLocalSections] = useState<Set<string>>(new Set());
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skillFiles, setSkillFiles] = useState<{ name: string; path: string; type: string }[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');

  const fetchSkills = useCallback(async () => {
    try {
      const [registryRes, localRes] = await Promise.all([
        fetch('/api/skills'),
        fetch('/api/skills/local?action=scan&all=1'),
      ]);
      const data = await registryRes.json();
      setSkills(data.skills || []);
      setProjects(data.projects || []);
      const localData = await localRes.json();
      // Filter out items already in registry
      const registryNames = new Set((data.skills || []).map((s: any) => s.name));
      setLocalItems((localData.items || []).filter((i: any) => !registryNames.has(i.name)));
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  const sync = async () => {
    setSyncing(true);
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sync' }),
    });
    await fetchSkills();
    setSyncing(false);
  };

  const install = async (name: string, target: string) => {
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'install', name, target }),
    });
    setInstallTarget({ skill: '', show: false });
    fetchSkills();
  };

  const toggleDetail = async (name: string) => {
    if (expandedSkill === name) {
      setExpandedSkill(null);
      return;
    }
    setExpandedSkill(name);
    setSkillFiles([]);
    setActiveFile(null);
    setFileContent('');
    // Fetch file list from GitHub API
    try {
      const res = await fetch(`/api/skills?action=files&name=${encodeURIComponent(name)}`);
      const data = await res.json();
      const files = data.files || [];
      setSkillFiles(files);
      // Auto-select skill.md if exists, otherwise first file
      const defaultFile = files.find((f: any) => f.name === 'skill.md') || files.find((f: any) => f.type === 'file');
      if (defaultFile) loadFile(name, defaultFile.path);
    } catch { setSkillFiles([]); }
  };

  const loadFile = async (skillName: string, filePath: string, isLocalItem?: boolean, localType?: string) => {
    setActiveFile(filePath);
    setFileContent('Loading...');
    try {
      let res;
      if (isLocalItem) {
        res = await fetch(`/api/skills/local?action=read&name=${encodeURIComponent(skillName)}&type=${localType || 'command'}&path=${encodeURIComponent(filePath)}`);
      } else {
        res = await fetch(`/api/skills?action=file&name=${encodeURIComponent(skillName)}&path=${encodeURIComponent(filePath)}`);
      }
      const data = await res.json();
      setFileContent(data.content || '(Empty)');
    } catch { setFileContent('(Failed to load)'); }
  };

  const uninstall = async (name: string, target: string) => {
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'uninstall', name, target }),
    });
    fetchSkills();
  };

  // Filter by project, type, and search
  const q = searchQuery.toLowerCase();
  const filtered = typeFilter === 'local' ? [] : skills
    .filter(s => projectFilter ? (s.installedGlobal || s.installedProjects.includes(projectFilter)) : true)
    .filter(s => typeFilter === 'all' ? true : s.type === typeFilter)
    .filter(s => !q || s.name.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));

  const filteredLocal = localItems
    .filter(item => typeFilter === 'local' || typeFilter === 'all' || item.type === typeFilter)
    .filter(item => !q || item.name.toLowerCase().includes(q));

  // Group local items by scope
  const localGroups = new Map<string, typeof localItems>();
  for (const item of filteredLocal) {
    const key = item.scope;
    if (!localGroups.has(key)) localGroups.set(key, []);
    localGroups.get(key)!.push(item);
  }

  const toggleLocalSection = (section: string) => {
    setCollapsedLocalSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const skillCount = skills.filter(s => s.type === 'skill').length;
  const commandCount = skills.filter(s => s.type === 'command').length;
  const localCount = localItems.length;

  if (loading) {
    return <div className="p-4 text-xs text-[var(--text-secondary)]">Loading skills...</div>;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--text-primary)]">Marketplace</span>
          <div className="flex items-center bg-[var(--bg-tertiary)] rounded p-0.5">
            {([['all', `All (${skills.length})`], ['skill', `Skills (${skillCount})`], ['command', `Commands (${commandCount})`], ['local', `Local (${localCount})`]] as const).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setTypeFilter(value)}
                className={`text-[9px] px-2 py-0.5 rounded transition-colors ${
                  typeFilter === value
                    ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={sync}
          disabled={syncing}
          className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          {syncing ? 'Syncing...' : 'Sync'}
        </button>
      </div>
      {/* Search */}
      <div className="px-3 py-1.5 border-b border-[var(--border)] shrink-0">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search skills & commands..."
          className="w-full px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[10px] text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)]"
        />
      </div>

      {skills.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-[var(--text-secondary)]">
          <p className="text-xs">No skills yet</p>
          <button onClick={sync} className="text-xs px-3 py-1 bg-[var(--accent)] text-white rounded hover:opacity-90">
            Sync from Registry
          </button>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Left: skill list */}
          <div className="w-56 border-r border-[var(--border)] overflow-y-auto shrink-0">
            {/* Registry items */}
            {filtered.map(skill => {
              const isInstalled = skill.installedGlobal || skill.installedProjects.length > 0;
              const isActive = expandedSkill === skill.name;
              return (
                <div
                  key={skill.name}
                  className={`px-3 py-2.5 border-b border-[var(--border)]/50 cursor-pointer ${
                    isActive ? 'bg-[var(--accent)]/10 border-l-2 border-l-[var(--accent)]' : 'hover:bg-[var(--bg-tertiary)] border-l-2 border-l-transparent'
                  }`}
                  onClick={() => toggleDetail(skill.name)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-[var(--text-primary)] truncate flex-1">{skill.displayName}</span>
                    <span className="text-[8px] text-[var(--text-secondary)] font-mono shrink-0">v{skill.version}</span>
                    {skill.score > 0 && (
                      <span className="text-[8px] text-[var(--yellow)] shrink-0">{skill.score}pt</span>
                    )}
                  </div>
                  <p className="text-[9px] text-[var(--text-secondary)] mt-0.5 line-clamp-1">{skill.description}</p>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className={`text-[7px] px-1 rounded font-medium ${
                      skill.type === 'skill' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'
                    }`}>{skill.type === 'skill' ? 'SKILL' : 'CMD'}</span>
                    <span className="text-[8px] text-[var(--text-secondary)]">{skill.author}</span>
                    {skill.tags.slice(0, 2).map(t => (
                      <span key={t} className="text-[7px] px-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{t}</span>
                    ))}
                    {skill.hasUpdate && <span className="text-[8px] text-[var(--yellow)] ml-auto">update</span>}
                    {isInstalled && !skill.hasUpdate && <span className="text-[8px] text-[var(--green)] ml-auto">installed</span>}
                  </div>
                </div>
              );
            })}
            {/* Local items — collapsible by scope group */}
            {(typeFilter === 'all' || typeFilter === 'local') && filteredLocal.length > 0 && (
              <>
                {/* Local section header — collapsible */}
                {typeFilter !== 'local' && (
                  <button
                    onClick={() => toggleLocalSection('__local__')}
                    className="w-full px-3 py-1 text-[8px] text-[var(--text-secondary)] uppercase bg-[var(--bg-tertiary)] border-b border-[var(--border)]/50 flex items-center gap-1 hover:text-[var(--text-primary)]"
                  >
                    <span>{collapsedLocalSections.has('__local__') ? '▸' : '▾'}</span>
                    Local ({filteredLocal.length})
                  </button>
                )}
                {(typeFilter === 'local' || !collapsedLocalSections.has('__local__')) && (
                  <>
                    {[...localGroups.entries()].sort(([a], [b]) => a === 'global' ? -1 : b === 'global' ? 1 : a.localeCompare(b)).map(([scope, items]) => (
                      <div key={scope}>
                        {/* Scope group header — collapsible */}
                        <button
                          onClick={() => toggleLocalSection(scope)}
                          className="w-full px-3 py-1 text-[8px] text-[var(--text-secondary)] border-b border-[var(--border)]/30 flex items-center gap-1.5 hover:bg-[var(--bg-tertiary)]"
                        >
                          <span className="text-[7px]">{collapsedLocalSections.has(scope) ? '▸' : '▾'}</span>
                          <span className={scope === 'global' ? 'text-green-400' : 'text-[var(--accent)]'}>{scope}</span>
                          <span className="text-[var(--text-secondary)]">({items.length})</span>
                        </button>
                        {!collapsedLocalSections.has(scope) && items.map(item => {
                          const key = `local:${item.name}:${item.scope}`;
                          const isActive = expandedSkill === key;
                          const projectParam = item.projectPath ? encodeURIComponent(item.projectPath) : '';
                          return (
                            <div
                              key={key}
                              className={`px-3 py-2 border-b border-[var(--border)]/50 cursor-pointer ${
                                isActive ? 'bg-[var(--accent)]/10 border-l-2 border-l-[var(--accent)]' : 'hover:bg-[var(--bg-tertiary)] border-l-2 border-l-transparent'
                              }`}
                              onClick={() => {
                                if (expandedSkill === key) { setExpandedSkill(null); return; }
                                setExpandedSkill(key);
                                setSkillFiles([]);
                                setActiveFile(null);
                                setFileContent('');
                                const fetchUrl = `/api/skills/local?action=files&name=${encodeURIComponent(item.name)}&type=${item.type}${projectParam ? `&project=${projectParam}` : ''}`;
                                fetch(fetchUrl)
                                  .then(r => r.json())
                                  .then(d => {
                                    const files = (d.files || []).map((f: any) => ({ name: f.path.split('/').pop(), path: f.path, type: 'file' }));
                                    setSkillFiles(files);
                                    const first = files.find((f: any) => f.name?.endsWith('.md'));
                                    if (first) {
                                      setActiveFile(first.path);
                                      fetch(`/api/skills/local?action=read&name=${encodeURIComponent(item.name)}&type=${item.type}&path=${encodeURIComponent(first.path)}${projectParam ? `&project=${projectParam}` : ''}`)
                                        .then(r => r.json())
                                        .then(rd => setFileContent(rd.content || ''))
                                        .catch(() => {});
                                    }
                                  })
                                  .catch(() => {});
                              }}
                            >
                              <div className="flex items-center gap-2">
                                <span className={`text-[7px] px-1 rounded font-medium ${
                                  item.type === 'skill' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'
                                }`}>{item.type === 'skill' ? 'S' : 'C'}</span>
                                <span className="text-[10px] text-[var(--text-primary)] truncate flex-1">{item.name}</span>
                                <span className="text-[8px] text-[var(--text-secondary)]">{item.fileCount}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>

          {/* Right: detail panel */}
          <div className="flex-1 flex flex-col min-w-0">
            {expandedSkill ? (() => {
              const isLocal = expandedSkill.startsWith('local:');
              const itemName = isLocal ? expandedSkill.slice(6) : expandedSkill;
              const skill = isLocal ? null : skills.find(s => s.name === expandedSkill);
              const localItem = isLocal ? localItems.find(i => i.name === itemName) : null;
              if (!skill && !localItem) return null;
              const isInstalled = skill ? (skill.installedGlobal || skill.installedProjects.length > 0) : true;
              return (
                <>
                  {/* Skill header */}
                  <div className="px-4 py-2 border-b border-[var(--border)] shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-[var(--text-primary)]">{skill?.displayName || localItem?.name || itemName}</span>
                      <span className={`text-[8px] px-1.5 py-0.5 rounded font-medium ${
                        (skill?.type || localItem?.type) === 'skill' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'
                      }`}>{(skill?.type || localItem?.type) === 'skill' ? 'Skill' : 'Command'}</span>
                      {isLocal && <span className="text-[7px] px-1 rounded bg-green-500/10 text-green-400">local</span>}
                      {skill && <span className="text-[9px] text-[var(--text-secondary)] font-mono">v{skill.version}</span>}
                      {skill?.installedVersion && skill.installedVersion !== skill.version && (
                        <span className="text-[9px] text-[var(--yellow)] font-mono">installed: v{skill.installedVersion}</span>
                      )}
                      {skill && skill.score > 0 && <span className="text-[9px] text-[var(--yellow)]">{skill.score}pt</span>}

                      {/* Update button */}
                      {skill?.hasUpdate && (
                        <button
                          onClick={async () => {
                            // Re-install to update (global if globally installed, plus all project installs)
                            if (skill.installedGlobal) await install(skill.name, 'global');
                            for (const pp of skill.installedProjects) await install(skill.name, pp);
                          }}
                          className="text-[9px] px-2 py-1 bg-[var(--yellow)]/20 text-[var(--yellow)] border border-[var(--yellow)]/50 rounded hover:bg-[var(--yellow)]/30 transition-colors"
                        >
                          Update
                        </button>
                      )}

                      {/* Install dropdown — registry items only */}
                      {skill && <div className="relative ml-auto">
                        <button
                          onClick={() => setInstallTarget(prev =>
                            prev.skill === skill.name && prev.show ? { skill: '', show: false } : { skill: skill.name, show: true }
                          )}
                          className="text-[9px] px-2 py-1 border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--accent)] hover:text-white transition-colors"
                        >
                          Install
                        </button>
                        {installTarget.skill === skill.name && installTarget.show && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => setInstallTarget({ skill: '', show: false })} />
                            <div className="absolute right-0 top-7 w-[180px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl z-50 py-1">
                              <button
                                onClick={() => install(skill.name, 'global')}
                                className={`w-full text-left text-[10px] px-3 py-1.5 hover:bg-[var(--bg-tertiary)] ${
                                  skill.installedGlobal ? 'text-[var(--green)]' : 'text-[var(--text-primary)]'
                                }`}
                              >
                                {skill.installedGlobal ? '✓ ' : ''}Global (~/.claude)
                              </button>
                              <div className="border-t border-[var(--border)] my-0.5" />
                              {projects.map(p => {
                                const inst = skill.installedProjects.includes(p.path);
                                return (
                                  <button
                                    key={p.path}
                                    onClick={() => install(skill.name, p.path)}
                                    className={`w-full text-left text-[10px] px-3 py-1.5 hover:bg-[var(--bg-tertiary)] truncate ${
                                      inst ? 'text-[var(--green)]' : 'text-[var(--text-primary)]'
                                    }`}
                                    title={p.path}
                                  >
                                    {inst ? '✓ ' : ''}{p.name}
                                  </button>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>}
                    </div>
                    <p className="text-[10px] text-[var(--text-secondary)] mt-0.5">{skill?.description || ''}</p>
                    {/* Installed indicators */}
                    {skill && isInstalled && (
                      <div className="flex items-center gap-2 mt-1">
                        {skill.installedGlobal && (
                          <span className="flex items-center gap-1 text-[8px] text-[var(--green)]">
                            Global
                            <button onClick={() => { if (confirm(`Uninstall "${skill.name}" from global?`)) uninstall(skill.name, 'global'); }} className="text-[var(--text-secondary)] hover:text-[var(--red)]">x</button>
                          </span>
                        )}
                        {skill.installedProjects.map(pp => (
                          <span key={pp} className="flex items-center gap-1 text-[8px] text-[var(--accent)]">
                            {pp.split('/').pop()}
                            <button onClick={() => { if (confirm(`Uninstall "${skill.name}" from ${pp.split('/').pop()}?`)) uninstall(skill.name, pp); }} className="text-[var(--text-secondary)] hover:text-[var(--red)]">x</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* File browser */}
                  <div className="flex-1 flex min-h-0 overflow-hidden">
                    {/* File list */}
                    <div className="w-32 border-r border-[var(--border)] overflow-y-auto shrink-0">
                      {skillFiles.length === 0 ? (
                        <div className="p-2 text-[9px] text-[var(--text-secondary)]">Loading...</div>
                      ) : (
                        skillFiles.map(f => (
                          f.type === 'file' ? (
                            <button
                              key={f.path}
                              onClick={() => loadFile(itemName, f.path, isLocal, localItem?.type)}
                              className={`w-full text-left px-2 py-1 text-[10px] truncate ${
                                activeFile === f.path
                                  ? 'bg-[var(--accent)]/15 text-[var(--accent)]'
                                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                              }`}
                              title={f.path}
                            >
                              {f.name}
                            </button>
                          ) : (
                            <div key={f.path} className="px-2 py-1 text-[9px] text-[var(--text-secondary)] font-semibold">
                              {f.name}/
                            </div>
                          )
                        ))
                      )}
                      {skill?.sourceUrl && (
                        <div className="border-t border-[var(--border)] p-2">
                          <a
                            href={skill.sourceUrl.replace(/\/blob\/main\/.*/, '')}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[9px] text-[var(--accent)] hover:underline"
                          >
                            GitHub
                          </a>
                        </div>
                      )}
                    </div>
                    {/* File content */}
                    <div className="flex-1 flex flex-col" style={{ width: 0 }}>
                      {activeFile && (
                        <div className="px-3 py-1 border-b border-[var(--border)] text-[9px] text-[var(--text-secondary)] font-mono shrink-0 truncate">
                          {activeFile}
                        </div>
                      )}
                      <div className="flex-1 overflow-auto">
                        <pre className="p-3 text-[11px] text-[var(--text-primary)] font-mono whitespace-pre-wrap break-all">
                          {fileContent}
                        </pre>
                      </div>
                    </div>
                  </div>
                </>
              );
            })() : (
              <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
                <p className="text-xs">Select a skill to view details</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
