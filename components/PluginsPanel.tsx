'use client';

import { useState, useEffect, useCallback } from 'react';

interface PluginSource {
  id: string;
  name: string;
  icon: string;
  version: string;
  author: string;
  description: string;
  source: 'builtin' | 'local' | 'registry';
  installed: boolean;
}

interface PluginInstance {
  id: string;
  name: string;
  source: string;  // plugin definition ID
  icon: string;
  config: Record<string, any>;
  enabled: boolean;
}

interface PluginDetail {
  id: string;
  name: string;
  icon: string;
  version: string;
  author?: string;
  description?: string;
  config: Record<string, { type: string; label?: string; description?: string; required?: boolean; default?: any; options?: string[] }>;
  params: Record<string, { type: string; label?: string; description?: string; required?: boolean; default?: any }>;
  actions: Record<string, { run: string; method?: string; url?: string; command?: string }>;
  defaultAction?: string;
}

export default function PluginsPanel() {
  const [plugins, setPlugins] = useState<PluginSource[]>([]);
  const [instances, setInstances] = useState<PluginInstance[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [installedConfig, setInstalledConfig] = useState<Record<string, any> | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, any>>({});
  const [configSaved, setConfigSaved] = useState(false);
  const [filter, setFilter] = useState<'all' | 'installed'>('all');
  const [loading, setLoading] = useState(true);
  const [testResult, setTestResult] = useState<{ ok: boolean; output: any; error?: string; duration?: number } | null>(null);
  const [testAction, setTestAction] = useState('');
  const [testParams, setTestParams] = useState('{}');
  const [testing, setTesting] = useState(false);
  // New instance form
  const [showNewInstance, setShowNewInstance] = useState(false);
  const [newInstanceName, setNewInstanceName] = useState('');

  const fetchPlugins = useCallback(async () => {
    setLoading(true);
    try {
      const [allRes, instRes] = await Promise.all([
        fetch('/api/plugins'),
        fetch('/api/plugins?installed=true'),
      ]);
      const allData = await allRes.json();
      const instData = await instRes.json();
      setPlugins(allData.plugins || []);
      // Build instances list from installed plugins
      const inst: PluginInstance[] = (instData.plugins || []).map((p: any) => ({
        id: p.id,
        name: p.instanceName || p.definition?.name || p.id,
        source: p.source || p.id,
        icon: p.definition?.icon || '🔌',
        config: p.config || {},
        enabled: p.enabled !== false,
      }));
      setInstances(inst);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchPlugins(); }, [fetchPlugins]);

  const selectPlugin = useCallback(async (id: string, instanceId?: string) => {
    setSelectedId(id);
    setSelectedInstance(instanceId || null);
    setTestResult(null);
    setShowNewInstance(false);
    try {
      const lookupId = instanceId || id;
      const res = await fetch(`/api/plugins?id=${lookupId}`);
      const data = await res.json();
      setDetail(data.plugin || null);
      setInstalledConfig(data.config ?? null);
      setConfigValues(data.config || {});
      if (data.plugin?.defaultAction) setTestAction(data.plugin.defaultAction);
      else if (data.plugin?.actions) setTestAction(Object.keys(data.plugin.actions)[0] || '');
    } catch {}
  }, []);

  const handleInstall = async () => {
    if (!selectedId) return;
    await fetch('/api/plugins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'install', id: selectedId, config: {} }),
    });
    await fetchPlugins();
    await selectPlugin(selectedId);
    // Auto-open new instance form after install
    setShowNewInstance(true);
    setNewInstanceName('');
    setConfigValues({});
  };

  const handleUninstall = async () => {
    const id = selectedInstance || selectedId;
    if (!id) return;
    await fetch('/api/plugins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'uninstall', id }),
    });
    setInstalledConfig(null);
    setSelectedInstance(null);
    await fetchPlugins();
  };

  const handleSaveConfig = async () => {
    const id = selectedInstance || selectedId;
    if (!id || !detail) return;
    // Merge schema defaults with user-entered values
    const finalConfig: Record<string, any> = {};
    for (const [key, schema] of Object.entries(detail.config)) {
      finalConfig[key] = configValues[key] ?? (schema as any).default ?? '';
    }
    await fetch('/api/plugins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_config', id, config: finalConfig }),
    });
    setConfigSaved(true);
    setTimeout(() => setConfigSaved(false), 2000);
    await selectPlugin(selectedId!, selectedInstance || undefined);
  };

  const handleCreateInstance = async () => {
    if (!selectedId || !newInstanceName.trim() || !detail) return;
    // Merge schema defaults with user-entered values
    const finalConfig: Record<string, any> = {};
    for (const [key, schema] of Object.entries(detail.config)) {
      finalConfig[key] = configValues[key] ?? (schema as any).default ?? '';
    }
    const res = await fetch('/api/plugins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_instance', source: selectedId, name: newInstanceName.trim(), config: finalConfig }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Failed to create instance');
      return;
    }
    setShowNewInstance(false);
    setNewInstanceName('');
    await fetchPlugins();
    // Auto-select the new instance
    if (data.instanceId) {
      await selectPlugin(selectedId, data.instanceId);
    }
  };

  const handleTest = async () => {
    const id = selectedInstance || selectedId;
    if (!id || !testAction) return;
    setTesting(true);
    setTestResult(null);
    try {
      let params = {};
      try { params = JSON.parse(testParams); } catch {}
      const res = await fetch('/api/plugins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', id, actionName: testAction, params }),
      });
      setTestResult(await res.json());
    } catch (err: any) {
      setTestResult({ ok: false, output: {}, error: err.message });
    } finally { setTesting(false); }
  };

  const filtered = filter === 'installed' ? plugins.filter(p => p.installed || instances.some(i => i.source === p.id)) : plugins;
  const pluginInstances = (id: string) => instances.filter(i => i.source === id && i.id !== id);

  if (loading) return <div className="p-4 text-xs text-[var(--text-secondary)]">Loading plugins...</div>;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)] shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--text-primary)]">Plugins</span>
          <span className="text-[10px] text-[var(--text-secondary)]">{instances.length} instances from {plugins.filter(p => p.installed).length} plugins</span>
        </div>
        <div className="flex items-center bg-[var(--bg-tertiary)] rounded p-0.5">
          {(['all', 'installed'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`text-[10px] px-2 py-0.5 rounded transition-colors ${filter === f ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)]'}`}
            >{f === 'all' ? 'All' : 'Installed'}</button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Plugin list with instances */}
        <div className="w-56 overflow-y-auto shrink-0 border-r border-[var(--border)]">
          {filtered.length === 0 && (
            <div className="p-4 text-xs text-[var(--text-secondary)] text-center">No plugins found</div>
          )}
          {filtered.map(p => {
            const pInstances = pluginInstances(p.id);
            const isSelected = selectedId === p.id && !selectedInstance;
            return (
              <div key={p.id}>
                <div
                  onClick={() => selectPlugin(p.id)}
                  className={`px-3 py-2 cursor-pointer border-b border-[var(--border)]/50 transition-colors ${
                    isSelected ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[var(--bg-tertiary)]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{p.icon}</span>
                    <span className="text-[11px] font-semibold text-[var(--text-primary)] truncate flex-1">{p.name}</span>
                    {p.installed && <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />}
                  </div>
                  <div className="text-[10px] text-[var(--text-secondary)] mt-0.5 line-clamp-1">{p.description}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[9px] text-[var(--text-secondary)]">v{p.version}</span>
                    {pInstances.length > 0 && <span className="text-[9px] text-[var(--accent)]">{pInstances.length} instance{pInstances.length > 1 ? 's' : ''}</span>}
                  </div>
                </div>
                {/* Instances */}
                {pInstances.map(inst => (
                  <div key={inst.id}
                    onClick={() => selectPlugin(p.id, inst.id)}
                    className={`pl-8 pr-3 py-1.5 cursor-pointer border-b border-[var(--border)]/30 transition-colors ${
                      selectedInstance === inst.id ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[var(--bg-tertiary)]'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-[9px]">{p.icon}</span>
                      <span className="text-[10px] text-[var(--text-primary)] truncate">{inst.name}</span>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${inst.enabled ? 'bg-green-400' : 'bg-gray-500'}`} />
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        {/* Detail panel */}
        <div className="flex-1 overflow-y-auto p-4">
          {!selectedId || !detail ? (
            <div className="flex-1 flex items-center justify-center text-xs text-[var(--text-secondary)] h-full">
              Select a plugin to view details
            </div>
          ) : (
            <div className="space-y-4 max-w-xl">
              {/* Header */}
              <div className="flex items-center gap-3">
                <span className="text-2xl">{detail.icon}</span>
                <div>
                  <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                    {selectedInstance ? instances.find(i => i.id === selectedInstance)?.name || selectedInstance : detail.name}
                  </h2>
                  <p className="text-[10px] text-[var(--text-secondary)]">
                    {selectedInstance ? `Instance of ${detail.name}` : `v${detail.version} by ${detail.author || 'unknown'}`}
                  </p>
                </div>
                <div className="flex-1" />
                <div className="flex items-center gap-1.5">
                  {/* Create instance button (only for installed base plugins) */}
                  {installedConfig !== null && !selectedInstance && (
                    <button onClick={() => { setShowNewInstance(true); setNewInstanceName(''); setConfigValues({}); }}
                      className="text-[10px] px-3 py-1 rounded bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors"
                    >+ Instance</button>
                  )}
                  {installedConfig !== null || selectedInstance ? (
                    <button onClick={handleUninstall}
                      className="text-[10px] px-3 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                    >{selectedInstance ? 'Delete' : 'Uninstall'}</button>
                  ) : (
                    <button onClick={handleInstall}
                      className="text-[10px] px-3 py-1 rounded bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors"
                    >Install</button>
                  )}
                </div>
              </div>

              {/* New instance form */}
              {showNewInstance && (
                <div className="rounded border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3 space-y-2">
                  <h3 className="text-[11px] font-semibold text-[var(--accent)]">New Instance</h3>
                  <div>
                    <label className="text-[10px] text-[var(--text-secondary)] block mb-0.5">Instance Name</label>
                    <input value={newInstanceName} onChange={e => setNewInstanceName(e.target.value)}
                      placeholder={`e.g., ${detail.name} Production`}
                      className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text-primary)]"
                    />
                  </div>
                  {/* Config fields for new instance */}
                  {Object.entries(detail.config).map(([key, schema]) => (
                    <div key={key}>
                      <label className="text-[10px] text-[var(--text-secondary)] block mb-0.5">
                        {schema.label || key} {schema.required && <span className="text-red-400">*</span>}
                        {schema.description && <span className="text-[8px] text-[var(--text-secondary)]/60 ml-1">{schema.description}</span>}
                      </label>
                      {schema.type === 'select' ? (
                        <select
                          value={configValues[key] || schema.default || ''}
                          onChange={e => setConfigValues({ ...configValues, [key]: e.target.value })}
                          className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text-primary)]"
                        >
                          <option value="">Select...</option>
                          {(schema.options || []).map((o: string) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : schema.type === 'boolean' ? (
                        <input type="checkbox"
                          checked={configValues[key] === true || configValues[key] === 'true'}
                          onChange={e => setConfigValues({ ...configValues, [key]: e.target.checked })}
                          className="accent-[var(--accent)]"
                        />
                      ) : (
                        <input
                          type={schema.type === 'secret' ? 'password' : schema.type === 'number' ? 'number' : 'text'}
                          value={configValues[key] ?? schema.default ?? ''}
                          onChange={e => setConfigValues({ ...configValues, [key]: e.target.value })}
                          placeholder={schema.description || ''}
                          className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text-primary)]"
                        />
                      )}
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <button onClick={handleCreateInstance} disabled={!newInstanceName.trim()}
                      className="text-[10px] px-3 py-1 rounded bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-40"
                    >Create</button>
                    <button onClick={() => setShowNewInstance(false)}
                      className="text-[10px] px-3 py-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >Cancel</button>
                  </div>
                </div>
              )}

              {detail.description && !showNewInstance && (
                <p className="text-[11px] text-[var(--text-secondary)]">{detail.description}</p>
              )}

              {/* Actions */}
              {!showNewInstance && (
                <div>
                  <h3 className="text-[11px] font-semibold text-[var(--text-primary)] mb-1.5">Actions</h3>
                  <div className="grid gap-1.5">
                    {Object.entries(detail.actions).map(([name, action]) => (
                      <div key={name} className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-[var(--bg-tertiary)]">
                        <span className="text-[10px] font-mono font-semibold text-[var(--accent)]">{name}</span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-secondary)]">{action.run}</span>
                        {action.url && <span className="text-[9px] text-[var(--text-secondary)] truncate">{action.method || 'GET'} {action.url}</span>}
                        {action.command && <span className="text-[9px] text-[var(--text-secondary)] truncate font-mono">{action.command.slice(0, 60)}</span>}
                        {detail.defaultAction === name && <span className="text-[8px] px-1 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)]">default</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Hint: create instance if base plugin has no instances */}
              {!showNewInstance && !selectedInstance && installedConfig !== null && pluginInstances(selectedId!).length === 0 && Object.keys(detail.config).length > 0 && (
                <div className="rounded border border-dashed border-[var(--accent)]/30 bg-[var(--accent)]/5 p-3 text-center">
                  <p className="text-[11px] text-[var(--text-secondary)] mb-2">Create an instance to configure and use this plugin</p>
                  <button onClick={() => { setShowNewInstance(true); setNewInstanceName(''); setConfigValues({}); }}
                    className="text-[10px] px-3 py-1 rounded bg-[var(--accent)] text-white hover:opacity-90"
                  >+ Create First Instance</button>
                </div>
              )}

              {/* Config (for installed plugins and instances) */}
              {!showNewInstance && Object.keys(detail.config).length > 0 && installedConfig !== null && (
                <div>
                  <h3 className="text-[11px] font-semibold text-[var(--text-primary)] mb-1.5">Configuration</h3>
                  <div className="space-y-2">
                    {Object.entries(detail.config).map(([key, schema]) => (
                      <div key={key}>
                        <label className="text-[10px] text-[var(--text-secondary)] block mb-0.5">
                          {schema.label || key} {schema.required && <span className="text-red-400">*</span>}
                        </label>
                        {schema.type === 'select' ? (
                          <select
                            value={configValues[key] || schema.default || ''}
                            onChange={e => setConfigValues({ ...configValues, [key]: e.target.value })}
                            className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text-primary)]"
                          >
                            <option value="">Select...</option>
                            {(schema.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : schema.type === 'boolean' ? (
                          <input type="checkbox"
                            checked={configValues[key] === true || configValues[key] === 'true'}
                            onChange={e => setConfigValues({ ...configValues, [key]: e.target.checked })}
                            className="accent-[var(--accent)]"
                          />
                        ) : (
                          <input
                            type={schema.type === 'secret' ? 'password' : schema.type === 'number' ? 'number' : 'text'}
                            value={configValues[key] ?? schema.default ?? ''}
                            onChange={e => setConfigValues({ ...configValues, [key]: e.target.value })}
                            placeholder={schema.description || ''}
                            className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text-primary)]"
                          />
                        )}
                      </div>
                    ))}
                    <button onClick={handleSaveConfig}
                      className="text-[10px] px-3 py-1 rounded bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 transition-colors"
                    >{configSaved ? 'Saved!' : 'Save Config'}</button>
                  </div>
                </div>
              )}

              {/* Run Action (only for instances) */}
              {!showNewInstance && selectedInstance && (
                <div>
                  <h3 className="text-[11px] font-semibold text-[var(--text-primary)] mb-1.5">Run Action</h3>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <select value={testAction} onChange={e => setTestAction(e.target.value)}
                        className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[11px] text-[var(--text-primary)]"
                      >
                        {Object.keys(detail.actions).map(a => <option key={a} value={a}>{a}</option>)}
                      </select>
                      <button onClick={handleTest} disabled={testing}
                        className="text-[10px] px-3 py-1 rounded bg-[var(--accent)] text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                      >{testing ? 'Running...' : 'Run'}</button>
                    </div>
                    <textarea
                      value={testParams}
                      onChange={e => setTestParams(e.target.value)}
                      placeholder='{"key": "value"}'
                      rows={3}
                      className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1.5 text-[10px] font-mono text-[var(--text-primary)] resize-y"
                    />
                    {testResult && (
                      <div className={`rounded p-2.5 text-[10px] font-mono ${testResult.ok ? 'bg-green-500/10 border border-green-500/20' : 'bg-red-500/10 border border-red-500/20'}`}>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={testResult.ok ? 'text-green-400' : 'text-red-400'}>{testResult.ok ? 'OK' : 'FAILED'}</span>
                          {testResult.duration && <span className="text-[var(--text-secondary)]">{testResult.duration}ms</span>}
                        </div>
                        {testResult.error && <div className="text-red-400 mb-1">{testResult.error}</div>}
                        <pre className="text-[var(--text-secondary)] whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                          {JSON.stringify(testResult.output, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
