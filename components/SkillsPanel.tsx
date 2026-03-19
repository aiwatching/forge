'use client';

import { useState, useEffect, useCallback } from 'react';

interface Skill {
  name: string;
  displayName: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  score: number;
  sourceUrl: string;
  installedGlobal: boolean;
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
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [skillFiles, setSkillFiles] = useState<{ name: string; path: string; type: string }[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');

  const fetchSkills = useCallback(async () => {
    try {
      const res = await fetch('/api/skills');
      const data = await res.json();
      setSkills(data.skills || []);
      setProjects(data.projects || []);
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

  const loadFile = async (skillName: string, filePath: string) => {
    setActiveFile(filePath);
    setFileContent('Loading...');
    try {
      const res = await fetch(`/api/skills?action=file&name=${encodeURIComponent(skillName)}&path=${encodeURIComponent(filePath)}`);
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

  // Filter skills if viewing a specific project
  const filtered = projectFilter
    ? skills.filter(s => s.installedGlobal || s.installedProjects.includes(projectFilter))
    : skills;

  if (loading) {
    return <div className="p-4 text-xs text-[var(--text-secondary)]">Loading skills...</div>;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--text-primary)]">Skills</span>
          <span className="text-[9px] text-[var(--text-secondary)]">{filtered.length} available</span>
        </div>
        <button
          onClick={sync}
          disabled={syncing}
          className="text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          {syncing ? 'Syncing...' : 'Sync'}
        </button>
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
                    <span className="text-[8px] text-[var(--text-secondary)]">{skill.author}</span>
                    {skill.tags.slice(0, 2).map(t => (
                      <span key={t} className="text-[7px] px-1 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">{t}</span>
                    ))}
                    {isInstalled && <span className="text-[8px] text-[var(--green)] ml-auto">installed</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right: detail panel */}
          <div className="flex-1 flex flex-col min-w-0">
            {expandedSkill ? (() => {
              const skill = skills.find(s => s.name === expandedSkill);
              if (!skill) return null;
              const isInstalled = skill.installedGlobal || skill.installedProjects.length > 0;
              return (
                <>
                  {/* Skill header */}
                  <div className="px-4 py-2 border-b border-[var(--border)] shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-[var(--text-primary)]">{skill.displayName}</span>
                      <span className="text-[9px] text-[var(--text-secondary)] font-mono">v{skill.version}</span>
                      {skill.score > 0 && <span className="text-[9px] text-[var(--yellow)]">{skill.score}pt</span>}

                      {/* Install dropdown */}
                      <div className="relative ml-auto">
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
                      </div>
                    </div>
                    <p className="text-[10px] text-[var(--text-secondary)] mt-0.5">{skill.description}</p>
                    {/* Installed indicators */}
                    {isInstalled && (
                      <div className="flex items-center gap-2 mt-1">
                        {skill.installedGlobal && (
                          <span className="flex items-center gap-1 text-[8px] text-[var(--green)]">
                            Global
                            <button onClick={() => uninstall(skill.name, 'global')} className="text-[var(--text-secondary)] hover:text-[var(--red)]">x</button>
                          </span>
                        )}
                        {skill.installedProjects.map(pp => (
                          <span key={pp} className="flex items-center gap-1 text-[8px] text-[var(--accent)]">
                            {pp.split('/').pop()}
                            <button onClick={() => uninstall(skill.name, pp)} className="text-[var(--text-secondary)] hover:text-[var(--red)]">x</button>
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
                              onClick={() => loadFile(skill.name, f.path)}
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
                      {skill.sourceUrl && (
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
