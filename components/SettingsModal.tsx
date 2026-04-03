'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

function SecretInput({ value, onChange, placeholder, className }: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={className}
      />
      <button
        type="button"
        onClick={() => setShow(v => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      >
        {show ? '🙈' : '👁'}
      </button>
    </div>
  );
}

// ─── Secret Change Dialog ──────────────────────────────────────

function SecretChangeDialog({ field, label, isSet, onSave, onClose }: {
  field: string;
  label: string;
  isSet: boolean;
  onSave: (field: string, adminPassword: string, newValue: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'change' | 'clear'>('change');
  const [adminPassword, setAdminPassword] = useState('');
  const [newValue, setNewValue] = useState('');
  const [confirmValue, setConfirmValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const canSave = mode === 'clear'
    ? adminPassword.length > 0
    : (adminPassword.length > 0 && newValue.length > 0 && newValue === confirmValue);

  const handleSave = async () => {
    if (mode === 'change' && newValue !== confirmValue) {
      setError('New values do not match');
      return;
    }
    setSaving(true);
    setError('');
    const err = await onSave(field, adminPassword, mode === 'clear' ? '' : newValue);
    setSaving(false);
    if (err) {
      setError(err);
    } else {
      onClose();
    }
  };

  const inputClass = "w-full px-2 py-1.5 pr-8 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg w-[380px] p-4 space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold">{isSet ? `Change ${label}` : `Set ${label}`}</h3>
          {isSet && (
            <div className="flex bg-[var(--bg-tertiary)] rounded p-0.5">
              <button
                onClick={() => { setMode('change'); setError(''); }}
                className={`text-[10px] px-2 py-0.5 rounded ${mode === 'change' ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)]'}`}
              >
                Change
              </button>
              <button
                onClick={() => { setMode('clear'); setError(''); }}
                className={`text-[10px] px-2 py-0.5 rounded ${mode === 'clear' ? 'bg-[var(--red)] text-white shadow-sm' : 'text-[var(--text-secondary)]'}`}
              >
                Clear
              </button>
            </div>
          )}
        </div>

        <div className="space-y-1">
          <label className="text-[10px] text-[var(--text-secondary)]">Admin password (login password)</label>
          <SecretInput
            value={adminPassword}
            onChange={v => { setAdminPassword(v); setError(''); }}
            placeholder="Enter login password to verify"
            className={inputClass}
          />
        </div>

        {mode === 'change' && (
          <>
            <div className="space-y-1">
              <label className="text-[10px] text-[var(--text-secondary)]">New value</label>
              <SecretInput
                value={newValue}
                onChange={v => { setNewValue(v); setError(''); }}
                placeholder="Enter new value"
                className={inputClass}
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] text-[var(--text-secondary)]">Confirm new value</label>
              <SecretInput
                value={confirmValue}
                onChange={v => { setConfirmValue(v); setError(''); }}
                placeholder="Re-enter new value"
                className={inputClass}
              />
              {confirmValue && newValue !== confirmValue && (
                <p className="text-[9px] text-[var(--red)]">Values do not match</p>
              )}
            </div>
          </>
        )}

        {mode === 'clear' && (
          <p className="text-[10px] text-[var(--text-secondary)]">
            Enter admin password to verify, then click Clear to remove this value.
          </p>
        )}

        {error && <p className="text-[10px] text-[var(--red)]">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave || saving}
            className={`px-3 py-1.5 text-xs text-white rounded hover:opacity-90 disabled:opacity-50 ${mode === 'clear' ? 'bg-[var(--red)]' : 'bg-[var(--accent)]'}`}
          >
            {saving ? 'Saving...' : mode === 'clear' ? 'Clear' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Secret Field Display ──────────────────────────────────────

function SecretField({ label, description, isSet, onEdit }: {
  label: string;
  description?: string;
  isSet: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="space-y-1">
      {description && (
        <label className="text-[10px] text-[var(--text-secondary)]">{description}</label>
      )}
      <div className="flex items-center gap-2">
        <div className="flex-1 px-2 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs font-mono text-[var(--text-secondary)]">
          {isSet ? '••••••••' : <span className="italic">Not set</span>}
        </div>
        <button
          onClick={onEdit}
          className="text-[10px] px-2 py-1 border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--accent)] hover:text-white transition-colors"
        >
          {isSet ? 'Change' : 'Set'}
        </button>
      </div>
    </div>
  );
}

// ─── Settings Modal ────────────────────────────────────────────

interface Settings {
  projectRoots: string[];
  docRoots: string[];
  claudePath: string;
  telegramBotToken: string;
  telegramChatId: string;
  notifyOnComplete: boolean;
  notifyOnFailure: boolean;
  tunnelAutoStart: boolean;
  telegramTunnelPassword: string;
  taskModel: string;
  pipelineModel: string;
  telegramModel: string;
  skipPermissions: boolean;
  notificationRetentionDays: number;
  _secretStatus?: Record<string, boolean>;
}

interface TunnelStatus {
  status: 'stopped' | 'starting' | 'running' | 'error';
  url: string | null;
  error: string | null;
  installed: boolean;
  log: string[];
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings>({
    projectRoots: [],
    docRoots: [],
    claudePath: '',
    telegramBotToken: '',
    telegramChatId: '',
    notifyOnComplete: true,
    notifyOnFailure: true,
    tunnelAutoStart: false,
    telegramTunnelPassword: '',
    taskModel: 'sonnet',
    pipelineModel: 'sonnet',
    telegramModel: 'sonnet',
    skipPermissions: false,
    notificationRetentionDays: 30,
  });
  const [secretStatus, setSecretStatus] = useState<Record<string, boolean>>({});
  const [newRoot, setNewRoot] = useState('');
  const [newDocRoot, setNewDocRoot] = useState('');
  const [saved, setSaved] = useState(false);
  const [tunnel, setTunnel] = useState<TunnelStatus>({
    status: 'stopped', url: null, error: null, installed: false, log: [],
  });
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [confirmStopTunnel, setConfirmStopTunnel] = useState(false);
  const [tunnelPasswordPrompt, setTunnelPasswordPrompt] = useState(false);
  const [tunnelPassword, setTunnelPassword] = useState('');
  const [tunnelPasswordError, setTunnelPasswordError] = useState('');
  const [editingSecret, setEditingSecret] = useState<{ field: string; label: string } | null>(null);
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const origSettingsRef = useRef('');

  const refreshTunnel = useCallback(() => {
    fetch('/api/tunnel').then(r => r.json()).then(setTunnel).catch(() => {});
  }, []);

  const fetchSettings = useCallback(() => {
    fetch('/api/settings').then(r => r.json()).then((data: Settings) => {
      const status = data._secretStatus || {};
      delete data._secretStatus;
      setSettings(data);
      origSettingsRef.current = JSON.stringify(data);
      setSecretStatus(status);
    });
  }, []);

  useEffect(() => {
    fetchSettings();
    refreshTunnel();
  }, [fetchSettings, refreshTunnel]);

  // Poll tunnel status while starting
  useEffect(() => {
    if (tunnel.status !== 'starting') return;
    const id = setInterval(refreshTunnel, 2000);
    return () => clearInterval(id);
  }, [tunnel.status, refreshTunnel]);

  const save = async () => {
    const cs = (settings as any).agents?.['claude-sonnet'];
    if (cs) console.log('[save] claude-sonnet at save time:', JSON.stringify({ taskFlags: cs.taskFlags, models: cs.models, cliType: cs.cliType }));
    else console.log('[save] claude-sonnet NOT in settings.agents. keys:', Object.keys((settings as any).agents || {}));
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    origSettingsRef.current = JSON.stringify(settings);
    setHasUnsaved(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // Track unsaved changes
  useEffect(() => {
    if (origSettingsRef.current) {
      setHasUnsaved(JSON.stringify(settings) !== origSettingsRef.current);
    }
  }, [settings]);

  const saveSecret = async (field: string, adminPassword: string, newValue: string): Promise<string | null> => {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _secretUpdate: { field, adminPassword, newValue } }),
    });
    const data = await res.json();
    if (!data.ok) return data.error || 'Failed to save';
    // Refresh status
    setSecretStatus(prev => ({ ...prev, [field]: !!newValue }));
    return null;
  };

  const addRoot = () => {
    const path = newRoot.trim();
    if (!path || settings.projectRoots.includes(path)) return;
    setSettings({ ...settings, projectRoots: [...settings.projectRoots, path] });
    setNewRoot('');
  };

  const removeRoot = (path: string) => {
    setSettings({
      ...settings,
      projectRoots: settings.projectRoots.filter(r => r !== path),
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => {
      if (hasUnsaved && !confirm('You have unsaved changes. Close anyway?')) return;
      onClose();
    }}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg w-[500px] max-h-[80vh] overflow-y-auto p-5 space-y-5"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-sm font-bold">Settings</h2>

        {/* Project Roots */}
        <div className="space-y-2">
          <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">
            Project Directories
          </label>
          <p className="text-[10px] text-[var(--text-secondary)]">
            Add directories containing your projects. Each subdirectory is treated as a project.
          </p>

          {settings.projectRoots.map(root => (
            <div key={root} className="flex items-center gap-2">
              <span className="flex-1 text-xs px-2 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded font-mono truncate">
                {root}
              </span>
              <button
                onClick={() => removeRoot(root)}
                className="text-[10px] px-2 py-1 text-[var(--red)] hover:bg-[var(--red)] hover:text-white rounded transition-colors"
              >
                Remove
              </button>
            </div>
          ))}

          <div className="flex gap-2">
            <input
              value={newRoot}
              onChange={e => setNewRoot(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addRoot()}
              placeholder="/Users/you/projects"
              className="flex-1 px-2 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={addRoot}
              className="text-[10px] px-3 py-1.5 bg-[var(--accent)] text-white rounded hover:opacity-90"
            >
              Add
            </button>
          </div>
        </div>

        {/* Document Roots */}
        <div className="space-y-2">
          <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">
            Document Directories
          </label>
          <p className="text-[10px] text-[var(--text-secondary)]">
            Markdown document directories (e.g. Obsidian vaults). Shown in the Docs tab.
          </p>

          {(settings.docRoots || []).map((root: string) => (
            <div key={root} className="flex items-center gap-2">
              <span className="flex-1 text-xs px-2 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded font-mono truncate">
                {root}
              </span>
              <button
                onClick={() => setSettings({ ...settings, docRoots: settings.docRoots.filter((r: string) => r !== root) })}
                className="text-[10px] px-2 py-1 text-[var(--red)] hover:bg-[var(--red)] hover:text-white rounded transition-colors"
              >
                Remove
              </button>
            </div>
          ))}

          <div className="flex gap-2">
            <input
              value={newDocRoot}
              onChange={e => setNewDocRoot(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newDocRoot.trim()) {
                  if (!settings.docRoots.includes(newDocRoot.trim())) {
                    setSettings({ ...settings, docRoots: [...(settings.docRoots || []), newDocRoot.trim()] });
                  }
                  setNewDocRoot('');
                }
              }}
              placeholder="/Users/you/obsidian-vault"
              className="flex-1 px-2 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={() => {
                if (newDocRoot.trim() && !settings.docRoots.includes(newDocRoot.trim())) {
                  setSettings({ ...settings, docRoots: [...(settings.docRoots || []), newDocRoot.trim()] });
                }
                setNewDocRoot('');
              }}
              className="text-[10px] px-3 py-1.5 bg-[var(--accent)] text-white rounded hover:opacity-90"
            >
              Add
            </button>
          </div>
          <DocsAgentSelect settings={settings} setSettings={setSettings} />
        </div>

        {/* Agents */}
        <AgentsSection settings={settings} setSettings={setSettings} />

        {/* Telegram Notifications */}
        <div className="space-y-2">
          <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">
            Telegram Notifications
          </label>
          <p className="text-[10px] text-[var(--text-secondary)]">
            Get notified when tasks complete or fail. Create a bot via @BotFather, then send /start to it and use the test button below to get your chat ID.
          </p>

          <SecretField
            label="Bot Token"
            description="Telegram Bot API token (from @BotFather)"
            isSet={!!secretStatus.telegramBotToken}
            onEdit={() => setEditingSecret({ field: 'telegramBotToken', label: 'Bot Token' })}

          />

          <input
            value={settings.telegramChatId}
            onChange={e => setSettings({ ...settings, telegramChatId: e.target.value })}
            placeholder="Chat ID (comma-separated for multiple)"
            className="w-full px-2 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]"
          />
          <p className="text-[9px] text-[var(--text-secondary)]">
            Allowed user IDs (whitelist). Multiple IDs separated by commas. Only these users can interact with the bot.
          </p>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={settings.notifyOnComplete}
                onChange={e => setSettings({ ...settings, notifyOnComplete: e.target.checked })}
                className="rounded"
              />
              Notify on complete
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={settings.notifyOnFailure}
                onChange={e => setSettings({ ...settings, notifyOnFailure: e.target.checked })}
                className="rounded"
              />
              Notify on failure
            </label>
            {secretStatus.telegramBotToken && settings.telegramChatId && (
              <button
                type="button"
                onClick={async () => {
                  // Save first, then test
                  await fetch('/api/settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(settings),
                  });
                  const res = await fetch('/api/notify/test', { method: 'POST' });
                  const data = await res.json();
                  alert(data.ok ? 'Test message sent!' : `Failed: ${data.error}`);
                }}
                className="text-[10px] px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--accent)] hover:text-white transition-colors"
              >
                Test
              </button>
            )}
          </div>
          <TelegramAgentSelect settings={settings} setSettings={setSettings} />
        </div>



        {/* Notification Retention */}
        <div className="space-y-2">
          <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">
            Notifications
          </label>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[var(--text-secondary)]">Auto-delete after</span>
            <select
              value={settings.notificationRetentionDays || 30}
              onChange={e => setSettings({ ...settings, notificationRetentionDays: Number(e.target.value) })}
              className="text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)]"
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
        </div>

        {/* Remote Access (Cloudflare Tunnel) */}
        <div className="space-y-2">
          <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">
            Remote Access
          </label>
          <p className="text-[10px] text-[var(--text-secondary)]">
            Expose this instance to the internet via Cloudflare Tunnel. No account needed — generates a temporary public URL.
            {!tunnel.installed && ' First use will download cloudflared (~30MB).'}
          </p>

          <div className="flex items-center gap-2">
            {tunnel.status === 'stopped' || tunnel.status === 'error' ? (
              tunnelPasswordPrompt ? (
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={tunnelPassword}
                    onChange={e => { setTunnelPassword(e.target.value); setTunnelPasswordError(''); }}
                    onKeyDown={async e => {
                      if (e.key === 'Enter' && tunnelPassword) {
                        setTunnelLoading(true);
                        setTunnelPasswordError('');
                        try {
                          const res = await fetch('/api/tunnel', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ action: 'start', password: tunnelPassword }),
                          });
                          const data = await res.json();
                          if (res.status === 403) {
                            setTunnelPasswordError('Wrong password');
                          } else {
                            setTunnel(data);
                            setTunnelPasswordPrompt(false);
                            setTunnelPassword('');
                          }
                        } catch {}
                        setTunnelLoading(false);
                      }
                    }}
                    placeholder="Login password"
                    autoFocus
                    className={`w-[140px] text-[10px] px-2 py-1 bg-[var(--bg-tertiary)] border rounded font-mono focus:outline-none ${
                      tunnelPasswordError ? 'border-[var(--red)]' : 'border-[var(--border)] focus:border-[var(--accent)]'
                    } text-[var(--text-primary)]`}
                  />
                  <button
                    disabled={!tunnelPassword || tunnelLoading}
                    onClick={async () => {
                      setTunnelLoading(true);
                      setTunnelPasswordError('');
                      try {
                        const res = await fetch('/api/tunnel', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'start', password: tunnelPassword }),
                        });
                        const data = await res.json();
                        if (res.status === 403) {
                          setTunnelPasswordError('Wrong password');
                        } else {
                          setTunnel(data);
                          setTunnelPasswordPrompt(false);
                          setTunnelPassword('');
                        }
                      } catch {}
                      setTunnelLoading(false);
                    }}
                    className="text-[10px] px-2 py-1 bg-[var(--green)] text-black rounded hover:opacity-90 disabled:opacity-50"
                  >
                    {tunnelLoading ? 'Starting...' : 'Start'}
                  </button>
                  <button
                    onClick={() => { setTunnelPasswordPrompt(false); setTunnelPassword(''); setTunnelPasswordError(''); }}
                    className="text-[10px] px-2 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    Cancel
                  </button>
                  {tunnelPasswordError && <span className="text-[9px] text-[var(--red)]">{tunnelPasswordError}</span>}
                </div>
              ) : (
              <button
                onClick={() => setTunnelPasswordPrompt(true)}
                className="text-[10px] px-3 py-1.5 bg-[var(--green)] text-black rounded hover:opacity-90"
              >
                Start Tunnel
              </button>
              )
            ) : confirmStopTunnel ? (
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-[var(--text-secondary)]">Stop tunnel?</span>
                <button
                  onClick={async () => {
                    await fetch('/api/tunnel', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'stop' }),
                    });
                    refreshTunnel();
                    setConfirmStopTunnel(false);
                  }}
                  className="text-[10px] px-2 py-1 bg-[var(--red)] text-white rounded hover:opacity-90"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setConfirmStopTunnel(false)}
                  className="text-[10px] px-2 py-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmStopTunnel(true)}
                className="text-[10px] px-3 py-1.5 bg-[var(--red)] text-white rounded hover:opacity-90"
              >
                Stop Tunnel
              </button>
            )}

            <span className="text-[10px] text-[var(--text-secondary)]">
              {tunnel.status === 'running' && (
                <span className="text-[var(--green)]">Running</span>
              )}
              {tunnel.status === 'starting' && (
                <span className="text-[var(--yellow)]">Starting...</span>
              )}
              {tunnel.status === 'error' && (
                <span className="text-[var(--red)]">Error</span>
              )}
              {tunnel.status === 'stopped' && 'Stopped'}
            </span>
          </div>

          {tunnel.url && (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={tunnel.url}
                className="flex-1 px-2 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--green)] font-mono focus:outline-none cursor-text select-all"
                onClick={e => (e.target as HTMLInputElement).select()}
              />
              <button
                onClick={() => {
                  navigator.clipboard.writeText(tunnel.url!);
                }}
                className="text-[10px] px-2 py-1.5 border border-[var(--border)] rounded hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                Copy
              </button>
            </div>
          )}

          {tunnel.error && (
            <p className="text-[10px] text-[var(--red)]">{tunnel.error}</p>
          )}

          {tunnel.log.length > 0 && tunnel.status !== 'stopped' && (
            <details className="text-[10px]">
              <summary className="text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)]">
                Logs ({tunnel.log.length} lines)
              </summary>
              <pre className="mt-1 p-2 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-[9px] text-[var(--text-secondary)] max-h-[120px] overflow-auto font-mono whitespace-pre-wrap">
                {tunnel.log.join('\n')}
              </pre>
            </details>
          )}

          <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={settings.tunnelAutoStart}
              onChange={e => setSettings({ ...settings, tunnelAutoStart: e.target.checked })}
              className="rounded"
            />
            Auto-start tunnel on server startup
          </label>

        </div>

        {/* Display Name */}
        <div className="space-y-2">
          <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">
            Display Name
          </label>
          <input
            type="text"
            value={(settings as any).displayName || ''}
            onChange={e => setSettings({ ...settings, displayName: e.target.value } as any)}
            placeholder="Forge"
            className="w-full px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)]"
          />
        </div>

        {/* Email */}
        <div className="space-y-2">
          <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">
            Email
          </label>
          <input
            type="email"
            value={(settings as any).displayEmail || ''}
            onChange={e => setSettings({ ...settings, displayEmail: e.target.value } as any)}
            placeholder="local@forge"
            className="w-full px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)]"
          />
        </div>

        {/* Admin Password */}
        <div className="space-y-2">
          <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">
            Admin Password
          </label>
          <p className="text-[10px] text-[var(--text-secondary)]">
            Used for local login, tunnel start, secret changes, and Telegram commands. Remote login requires admin password + session code (generated on tunnel start).
          </p>
          <SecretField
            label="Admin Password"
            isSet={!!secretStatus.telegramTunnelPassword}
            onEdit={() => setEditingSecret({ field: 'telegramTunnelPassword', label: 'Admin Password' })}
          />
          <p className="text-[9px] text-[var(--text-secondary)]">
            Forgot? Run: <code className="text-[var(--accent)]">forge --reset-password</code>
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
          <span className="text-[10px] text-[var(--green)]">
            {saved ? '✓ Saved' : ''}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Close
            </button>
            <button
              onClick={save}
              className="px-3 py-1.5 text-xs bg-[var(--accent)] text-white rounded hover:opacity-90"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      {/* Secret Change Dialog */}
      {editingSecret && (
        <SecretChangeDialog
          field={editingSecret.field}
          label={editingSecret.label}
          isSet={!!secretStatus[editingSecret.field]}
          onSave={saveSecret}
          onClose={() => setEditingSecret(null)}
        />
      )}
    </div>
  );
}

// ─── Agents Configuration Section ─────────────────────────────

interface AgentEntry {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  type: string;
  taskFlags: string;
  interactiveCmd: string;
  resumeFlag: string;
  outputFormat: string;
  models: { terminal: string; task: string; telegram: string; help: string; mobile: string };
  skipPermissionsFlag: string;
  requiresTTY: boolean;
  detected: boolean;
  isProfile?: boolean;
  base?: string;
  backendType?: string;
}

function ProfileRow({ id, cfg, inputClass, onUpdate, onDelete }: {
  id: string; cfg: any; inputClass: string;
  onUpdate: (cfg: any) => void; onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isApi = cfg.type === 'api';
  const summary = isApi
    ? `API: ${cfg.provider || '?'} / ${cfg.model || '?'}`
    : `CLI: ${cfg.cliType || cfg.base || '?'} / ${cfg.model || cfg.models?.task || 'default'}`;
  const envStr = cfg.env ? Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`).join('\n') : '';

  return (
    <div className="mb-1 rounded" style={{ background: 'var(--bg-tertiary)' }}>
      <div className="flex items-center gap-2 px-2 py-1.5 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <span className="text-[8px] text-[var(--text-secondary)]">{expanded ? '▼' : '▶'}</span>
        <span className="text-[9px] text-[var(--accent)] font-mono w-28 truncate">{id}</span>
        <span className="text-[9px] text-[var(--text-secondary)]">{summary}</span>
        <span className="text-[8px] text-[var(--text-secondary)]">{cfg.name || ''}</span>
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="text-[9px] text-gray-500 hover:text-red-400 ml-auto">✕</button>
      </div>
      {expanded && (
        <div className="px-3 pb-2 space-y-1.5 border-t border-[var(--border)]">
          <div className="flex gap-2 mt-1.5">
            <div className="flex-1">
              <label className="text-[8px] text-[var(--text-secondary)]">Name</label>
              <input value={cfg.name || ''} onChange={e => onUpdate({ ...cfg, name: e.target.value })} className={inputClass} />
            </div>
            <div className="flex-1">
              <label className="text-[8px] text-[var(--text-secondary)]">Model</label>
              <input value={cfg.model || ''} onChange={e => onUpdate({ ...cfg, model: e.target.value })}
                list={`profile-model-${id}`} className={inputClass} />
              {(cfg.cliType === 'claude-code' || (!cfg.cliType && !cfg.base && !isApi)) && (
                <datalist id={`profile-model-${id}`}>
                  <option value="claude-opus-4-6" />
                  <option value="claude-sonnet-4-6" />
                  <option value="claude-haiku-4-5-20251001" />
                </datalist>
              )}
              {(cfg.cliType === 'codex' || cfg.base === 'codex') && (
                <datalist id={`profile-model-${id}`}>
                  <option value="codex-mini" />
                  <option value="o4-mini" />
                  <option value="gpt-4o" />
                </datalist>
              )}
            </div>
          </div>
          {isApi ? (
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-[8px] text-[var(--text-secondary)]">Provider</label>
                <select value={cfg.provider || 'anthropic'} onChange={e => onUpdate({ ...cfg, provider: e.target.value })} className={inputClass}>
                  <option value="anthropic">Anthropic</option>
                  <option value="google">Google</option>
                  <option value="openai">OpenAI</option>
                  <option value="grok">Grok</option>
                </select>
              </div>
              <div className="flex-1">
                <label className="text-[8px] text-[var(--text-secondary)]">API Key (optional)</label>
                <input type="password" value={cfg.apiKey || ''} onChange={e => onUpdate({ ...cfg, apiKey: e.target.value })} className={inputClass} />
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="text-[8px] text-[var(--text-secondary)]">CLI Type</label>
                <select value={cfg.cliType === 'claude-code' ? 'claude' : (cfg.cliType || cfg.base || 'claude')} onChange={e => onUpdate({ ...cfg, cliType: e.target.value === 'claude' ? 'claude-code' : e.target.value })} className={inputClass}>
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                  <option value="aider">Aider</option>
                  <option value="generic">Generic</option>
                </select>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <label className="text-[8px] text-[var(--text-secondary)]">Environment Variables (KEY=VALUE per line)</label>
                  {(cfg.cliType || cfg.base) && (
                    <button onClick={() => {
                      const templates: Record<string, string> = {
                        'claude-code': 'ANTHROPIC_AUTH_TOKEN=\nANTHROPIC_BASE_URL=\nANTHROPIC_SMALL_FAST_MODEL=\nCLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true\nDISABLE_TELEMETRY=true\nDISABLE_ERROR_REPORTING=true\nDISABLE_AUTOUPDATER=true\nDISABLE_NON_ESSENTIAL_MODEL_CALLS=true',
                        claude: 'ANTHROPIC_AUTH_TOKEN=\nANTHROPIC_BASE_URL=\nANTHROPIC_SMALL_FAST_MODEL=\nCLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true\nDISABLE_TELEMETRY=true\nDISABLE_ERROR_REPORTING=true\nDISABLE_AUTOUPDATER=true\nDISABLE_NON_ESSENTIAL_MODEL_CALLS=true',
                        codex: 'OPENAI_API_KEY=\nOPENAI_BASE_URL=',
                        aider: 'ANTHROPIC_API_KEY=\nOPENAI_API_KEY=',
                      };
                      const tpl = templates[cfg.cliType || cfg.base!];
                      if (tpl) {
                        const env: Record<string, string> = {};
                        for (const line of tpl.split('\n')) {
                          const eq = line.indexOf('=');
                          if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
                        }
                        // Merge with existing (don't overwrite filled values)
                        const merged = { ...env, ...(cfg.env || {}) };
                        onUpdate({ ...cfg, env: merged });
                      }
                    }} className="text-[7px] px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20">
                      Fill {cfg.cliType === 'claude-code' ? 'claude' : (cfg.cliType || cfg.base)} template
                    </button>
                  )}
                </div>
                <textarea
                  value={envStr}
                  onChange={e => {
                    const env: Record<string, string> = {};
                    for (const line of e.target.value.split('\n')) {
                      const eq = line.indexOf('=');
                      if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
                    }
                    onUpdate({ ...cfg, env: Object.keys(env).length > 0 ? env : undefined });
                  }}
                  rows={5}
                  placeholder="ANTHROPIC_AUTH_TOKEN=sk-...\nANTHROPIC_BASE_URL=http://..."
                  className={inputClass + ' resize-none font-mono'} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AddProfileForm({ type, baseAgents, onAdd }: {
  type: 'cli' | 'api';
  baseAgents: AgentEntry[];
  onAdd: (id: string, cfg: any) => void;
}) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [base, setBase] = useState(baseAgents[0]?.id || 'claude');
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('anthropic');
  const [envText, setEnvText] = useState('');
  const [apiKey, setApiKey] = useState('');

  const inputClass = "w-full px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]";

  // Env var templates per CLI type
  const envTemplates: Record<string, string> = {
    claude: [
      'ANTHROPIC_AUTH_TOKEN=',
      'ANTHROPIC_BASE_URL=',
      'ANTHROPIC_SMALL_FAST_MODEL=',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=true',
      'DISABLE_TELEMETRY=true',
      'DISABLE_ERROR_REPORTING=true',
      'DISABLE_AUTOUPDATER=true',
      'DISABLE_NON_ESSENTIAL_MODEL_CALLS=true',
    ].join('\n'),
    codex: [
      'OPENAI_API_KEY=',
      'OPENAI_BASE_URL=',
    ].join('\n'),
    aider: [
      'ANTHROPIC_API_KEY=',
      'OPENAI_API_KEY=',
    ].join('\n'),
  };

  const fillEnvTemplate = () => {
    const tpl = envTemplates[base] || '';
    if (tpl && (!envText.trim() || confirm('Replace current env vars with template?'))) {
      setEnvText(tpl);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="text-[9px] px-2 py-0.5 border border-dashed border-[var(--border)] text-[var(--text-secondary)] rounded hover:text-[var(--text-primary)] mt-1">
        + {type === 'cli' ? 'CLI Profile' : 'API Profile'}
      </button>
    );
  }

  const parseEnv = (): Record<string, string> | undefined => {
    if (!envText.trim()) return undefined;
    const env: Record<string, string> = {};
    for (const line of envText.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
    }
    return Object.keys(env).length > 0 ? env : undefined;
  };

  const handleAdd = () => {
    if (!id) return;
    if (type === 'cli') {
      onAdd(id, { cliType: base === 'claude' ? 'claude-code' : base, name: name || id, model: model || undefined, env: parseEnv() });
    } else {
      onAdd(id, { type: 'api', name: name || id, provider, model: model || undefined, apiKey: apiKey || undefined });
    }
    setOpen(false);
    setId(''); setName(''); setModel(''); setApiKey(''); setEnvText('');
  };

  return (
    <div className="mt-2 p-2 rounded border border-[var(--border)] space-y-1.5" style={{ background: 'var(--bg-secondary)' }}>
      <div className="text-[9px] text-[var(--text-secondary)] font-semibold">New {type === 'cli' ? 'CLI' : 'API'} Profile</div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-[8px] text-[var(--text-secondary)]">Profile ID</label>
          <input value={id} onChange={e => setId(e.target.value.replace(/\s+/g, '-').toLowerCase())} placeholder={type === 'cli' ? 'claude-opus' : 'api-sonnet'} className={inputClass} />
        </div>
        <div className="flex-1">
          <label className="text-[8px] text-[var(--text-secondary)]">Display Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Claude Opus" className={inputClass} />
        </div>
      </div>
      {type === 'cli' ? (<>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-[8px] text-[var(--text-secondary)]">CLI Type</label>
            <select value={base} onChange={e => setBase(e.target.value)}
              className={inputClass}>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
              <option value="aider">Aider</option>
              <option value="generic">Generic</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="text-[8px] text-[var(--text-secondary)]">Model</label>
            <input value={model} onChange={e => setModel(e.target.value)}
              placeholder={base === 'claude' ? 'claude-sonnet-4-6' : base === 'codex' ? 'codex-mini' : ''}
              list={`model-list-${base}`} className={inputClass} />
            {base === 'claude' && (
              <datalist id="model-list-claude">
                <option value="claude-opus-4-6" />
                <option value="claude-sonnet-4-6" />
                <option value="claude-haiku-4-5-20251001" />
              </datalist>
            )}
            {base === 'codex' && (
              <datalist id="model-list-codex">
                <option value="codex-mini" />
                <option value="o4-mini" />
                <option value="gpt-4o" />
              </datalist>
            )}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-2">
            <label className="text-[8px] text-[var(--text-secondary)]">Environment Variables (KEY=VALUE per line)</label>
            {envTemplates[base] && (
              <button onClick={fillEnvTemplate} className="text-[7px] px-1.5 py-0.5 rounded bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20">
                Fill {base} template
              </button>
            )}
          </div>
          <textarea value={envText} onChange={e => setEnvText(e.target.value)} rows={5}
            placeholder={envTemplates[base] || 'KEY=VALUE\nKEY2=VALUE2'}
            className={inputClass + ' resize-none font-mono'} />
        </div>
      </>) : (
        <>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[8px] text-[var(--text-secondary)]">Provider</label>
              <select value={provider} onChange={e => setProvider(e.target.value)} className={inputClass}>
                <option value="anthropic">Anthropic</option>
                <option value="google">Google</option>
                <option value="openai">OpenAI</option>
                <option value="grok">Grok</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="text-[8px] text-[var(--text-secondary)]">Model</label>
              <input value={model} onChange={e => setModel(e.target.value)} placeholder="claude-sonnet-4-6" className={inputClass} />
            </div>
          </div>
          <div>
            <label className="text-[8px] text-[var(--text-secondary)]">API Key (optional, uses provider key if empty)</label>
            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-..." className={inputClass} />
          </div>
        </>
      )}
      <div className="flex gap-2">
        <button onClick={handleAdd} disabled={!id} className="text-[10px] px-3 py-1 bg-[var(--accent)] text-white rounded disabled:opacity-50">Add</button>
        <button onClick={() => setOpen(false)} className="text-[10px] px-3 py-1 border border-[var(--border)] text-[var(--text-secondary)] rounded">Cancel</button>
      </div>
    </div>
  );
}

function AgentsSection({ settings, setSettings }: { settings: any; setSettings: (s: any) => void }) {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const cliDefaults: Record<string, any> = {
    'claude-code': { taskFlags: '-p --verbose --output-format stream-json --dangerously-skip-permissions', resumeFlag: '-c', outputFormat: 'stream-json', skipPermissionsFlag: '--dangerously-skip-permissions' },
    'codex': { taskFlags: '', resumeFlag: '', outputFormat: 'text', skipPermissionsFlag: '--full-auto' },
    'aider': { taskFlags: '--message', resumeFlag: '', outputFormat: 'text', skipPermissionsFlag: '--yes' },
    'generic': { taskFlags: '', resumeFlag: '', outputFormat: 'text', skipPermissionsFlag: '' },
  };
  const makeNewAgent = (cliType = 'claude-code') => ({
    id: '', name: '', path: '', interactiveCmd: '',
    models: { terminal: 'default', task: 'default', telegram: 'default', help: 'default', mobile: 'default' },
    requiresTTY: false, cliType,
    ...cliDefaults[cliType],
  });
  const [newAgent, setNewAgent] = useState(makeNewAgent());

  // Fetch detected + configured agents
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // Fetch both agents and settings together to avoid race condition
        // (settings prop may not be loaded yet when this effect runs)
        const [agentsRes, settingsRes] = await Promise.all([
          fetch('/api/agents'),
          fetch('/api/settings'),
        ]);
        const data = await agentsRes.json();
        const settingsData = await settingsRes.json();
        const detected = (data.agents || []) as any[];
        const configured = settingsData.agents || {};

        const merged: AgentEntry[] = [];

        // Add agents from API (may be detected or configured-only)
        for (const a of detected) {
          const cfg = configured[a.id] || {};
          merged.push({
            id: a.id,
            name: cfg.name ?? a.name,
            path: cfg.path ?? a.path,
            enabled: cfg.enabled !== false,
            type: a.type || 'generic',
            taskFlags: cfg.taskFlags ?? (a.id === 'claude' ? '-p --verbose --output-format stream-json --dangerously-skip-permissions' : cfg.flags?.join(' ') ?? ''),
            interactiveCmd: cfg.interactiveCmd ?? a.path,
            resumeFlag: cfg.resumeFlag ?? (a.capabilities?.supportsResume ? '-c' : ''),
            outputFormat: cfg.outputFormat ?? (a.capabilities?.supportsStreamJson ? 'stream-json' : 'text'),
            models: cfg.models ?? { terminal: "default", task: "default", telegram: "default", help: "default", mobile: "default" },
            skipPermissionsFlag: cfg.skipPermissionsFlag ?? a.skipPermissionsFlag ?? "",
            requiresTTY: cfg.requiresTTY ?? a.capabilities?.requiresTTY ?? false,
            detected: a.detected !== false,
          });
        }

        // Add configured but not detected agents
        for (const [id, cfg] of Object.entries(configured) as [string, any][]) {
          if (merged.find(a => a.id === id)) continue;
          merged.push({
            id,
            name: cfg.name ?? id,
            path: cfg.path ?? '',
            enabled: cfg.enabled !== false,
            type: 'generic',
            taskFlags: cfg.taskFlags ?? cfg.flags?.join(' ') ?? '',
            interactiveCmd: cfg.interactiveCmd ?? cfg.path ?? '',
            resumeFlag: cfg.resumeFlag ?? '',
            outputFormat: cfg.outputFormat ?? 'text',
            models: cfg.models ?? { terminal: "default", task: "default", telegram: "default", help: "default", mobile: "default" },
            skipPermissionsFlag: cfg.skipPermissionsFlag ?? '',
            requiresTTY: cfg.requiresTTY ?? false,
            detected: false,
          });
        }

        setAgents(merged);
      } catch {}
      setLoading(false);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only fetch once on mount

  const defaultAgent = settings.defaultAgent || 'claude';

  const saveAgentConfig = (updated: AgentEntry[]) => {
    const csEntry = updated.find(a => a.id === 'claude-sonnet');
    if (csEntry) console.log('[saveAgentConfig] claude-sonnet in updated:', JSON.stringify({ taskFlags: csEntry.taskFlags, models: csEntry.models }));
    // Use functional update to avoid stale closure — each call sees the latest settings
    setSettings((prev: any) => {
      const agentsCfg: Record<string, any> = { ...(prev.agents || {}) };
      for (const a of updated) {
        const existing = agentsCfg[a.id] || {};
        agentsCfg[a.id] = {
          ...existing, // preserve profile-specific fields
          name: a.name,
          path: a.path,
          enabled: a.enabled,
          taskFlags: a.taskFlags,
          interactiveCmd: a.interactiveCmd,
          resumeFlag: a.resumeFlag,
          outputFormat: a.outputFormat,
          models: a.models,
          skipPermissionsFlag: a.skipPermissionsFlag,
          requiresTTY: a.requiresTTY,
          cliType: (a as any).cliType || existing.cliType,
        };
      }
      const claude = updated.find(a => a.id === 'claude');
      return { ...prev, agents: agentsCfg, claudePath: claude?.path || prev.claudePath };
    });
  };

  const [agentsDirty, setAgentsDirty] = useState(false);
  const saveTimerRef = useRef<any>(null);

  const debouncedSave = useCallback((updated: AgentEntry[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveAgentConfig(updated);
      setAgentsDirty(false);
    }, 1000); // save after 1s of no changes
  }, [saveAgentConfig]);

  const updateAgent = (id: string, field: string, value: any) => {
    const updated = agents.map(a => a.id === id ? { ...a, [field]: value } : a);
    setAgents(updated);
    // Sync to settings immediately (no debounce) so global Save always has latest data
    saveAgentConfig(updated);
  };

  const saveAgents = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveAgentConfig(agents);
    setAgentsDirty(false);
  };

  const removeAgent = (id: string) => {
    if (!confirm(`Remove "${id}" agent?`)) return;
    const updated = agents.filter(a => a.id !== id);
    setAgents(updated);
    debouncedSave(updated);
  };

  const addAgent = () => {
    if (!newAgent.id || !newAgent.path) return;
    const entry: AgentEntry = {
      ...newAgent,
      enabled: true,
      type: 'generic',
      detected: false,
    };
    const updated = [...agents, entry];
    setAgents(updated);
    debouncedSave(updated);
    setShowAdd(false);
    setNewAgent(makeNewAgent());
  };

  const inputClass = "w-full px-2 py-1 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">Agents</label>
        <button
          onClick={async () => {
            try {
              const res = await fetch('/api/agents');
              const data = await res.json();
              if (data.agents?.length) alert(`Detected: ${data.agents.map((a: any) => a.name).join(', ')}`);
              else alert('No agents detected');
            } catch { alert('Detection failed'); }
          }}
          className="text-[9px] px-2 py-0.5 border border-[var(--accent)] text-[var(--accent)] rounded hover:bg-[var(--accent)] hover:text-white ml-auto"
        >Detect</button>
        <button
          onClick={() => {
            // Auto-fill path from detected claude agent when opening Add form
            const claude = agents.find(a => a.id === 'claude');
            if (claude?.path && !newAgent.path) setNewAgent((prev: any) => ({ ...prev, path: claude.path, interactiveCmd: claude.path }));
            setShowAdd(v => !v);
          }}
          className="text-[9px] px-2 py-0.5 border border-[var(--border)] text-[var(--text-secondary)] rounded hover:text-[var(--text-primary)]"
        >+ Add</button>
        {agentsDirty && (
          <button
            onClick={saveAgents}
            className="text-[9px] px-2 py-0.5 bg-[var(--accent)] text-white rounded"
          >Save Agents</button>
        )}
      </div>

      {/* Default agent selector */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[var(--text-secondary)]">Default:</span>
        <select
          value={defaultAgent}
          onChange={e => setSettings({ ...settings, defaultAgent: e.target.value })}
          className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--text-primary)]"
        >
          {agents.filter(a => a.enabled).map(a => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <span className="text-[9px] text-[var(--text-secondary)]">Used for Task, Terminal, Pipeline, Mobile, Help</span>
      </div>

      {loading ? (
        <p className="text-[10px] text-[var(--text-secondary)]">Loading agents...</p>
      ) : agents.length === 0 ? (
        <p className="text-[10px] text-[var(--text-secondary)]">No agents detected. Click Detect or Add manually.</p>
      ) : (
        <div className="space-y-2">
          {agents.map(a => (
            <div key={a.id} className="border border-[var(--border)] rounded-lg overflow-hidden">
              {/* Agent header */}
              <div
                className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--bg-tertiary)]"
                onClick={() => setExpandedAgent(expandedAgent === a.id ? null : a.id)}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${
                  !a.detected ? 'bg-gray-500' : a.id === defaultAgent ? 'bg-green-500' : 'bg-green-400/60'
                }`} title={!a.detected ? 'Not installed' : a.id === defaultAgent ? 'Default agent' : 'Installed'} />
                <span className={`text-xs font-medium ${!a.detected ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)]'}`}>{a.name}</span>
                <span className="text-[9px] text-[var(--text-secondary)] font-mono">{a.id}</span>
                {a.id === defaultAgent && <span className="text-[8px] px-1 rounded bg-green-500/20 text-green-400">default</span>}
                {!a.detected && <span className="text-[8px] text-gray-500">not installed</span>}
                <label className="flex items-center gap-1 ml-auto text-[9px] text-[var(--text-secondary)]" onClick={e => e.stopPropagation()}>
                  <input type="checkbox" checked={a.enabled} onChange={e => updateAgent(a.id, 'enabled', e.target.checked)} className="accent-[var(--accent)]" />
                  Enabled
                </label>
                <span className="text-[10px] text-[var(--text-secondary)]">{expandedAgent === a.id ? '▾' : '▸'}</span>
              </div>

              {/* Agent detail */}
              {expandedAgent === a.id && (
                <div className="px-3 py-2 border-t border-[var(--border)] space-y-2 bg-[var(--bg-secondary)]">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-[9px] text-[var(--text-secondary)]">Name</label>
                      <input value={a.name} onChange={e => updateAgent(a.id, 'name', e.target.value)} className={inputClass} />
                    </div>
                    <div className="w-36">
                      <label className="text-[9px] text-[var(--text-secondary)]">CLI Type</label>
                      <select value={(settings.agents?.[a.id] as any)?.cliType || (a.id === 'claude' ? 'claude-code' : a.id === 'codex' ? 'codex' : a.id === 'aider' ? 'aider' : 'generic')}
                        onChange={e => setSettings({ ...settings, agents: { ...settings.agents, [a.id]: { ...(settings.agents?.[a.id] || {}), cliType: e.target.value } } })}
                        className={inputClass}>
                        <option value="claude-code">Claude Code</option>
                        <option value="codex">Codex</option>
                        <option value="aider">Aider</option>
                        <option value="generic">Generic</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-[9px] text-[var(--text-secondary)]">Binary Path</label>
                    <input value={a.path} onChange={e => updateAgent(a.id, 'path', e.target.value)} placeholder="/usr/local/bin/agent" className={inputClass} />
                  </div>
                  <div>
                    <label className="text-[9px] text-[var(--text-secondary)]">Task Flags <span className="text-[8px]">(non-interactive mode, e.g. -p --output-format json)</span></label>
                    <input value={a.taskFlags} onChange={e => updateAgent(a.id, 'taskFlags', e.target.value)} placeholder="-p --verbose" className={inputClass} />
                  </div>
                  <div>
                    <label className="text-[9px] text-[var(--text-secondary)]">Interactive Command <span className="text-[8px]">(terminal startup)</span></label>
                    <input value={a.interactiveCmd} onChange={e => updateAgent(a.id, 'interactiveCmd', e.target.value)} placeholder="claude" className={inputClass} />
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="text-[9px] text-[var(--text-secondary)]">Resume Flag <span className="text-[8px]">(empty = no resume)</span></label>
                      <input value={a.resumeFlag} onChange={e => updateAgent(a.id, 'resumeFlag', e.target.value)} placeholder="-c or --resume" className={inputClass} />
                    </div>
                    <div className="w-32">
                      <label className="text-[9px] text-[var(--text-secondary)]">Output Format</label>
                      <select value={a.outputFormat} onChange={e => updateAgent(a.id, 'outputFormat', e.target.value)} className={inputClass}>
                        <option value="stream-json">stream-json</option>
                        <option value="json">json</option>
                        <option value="text">text</option>
                      </select>
                    </div>
                  </div>
                  {/* Per-scene model config */}
                  <div>
                    <label className="text-[9px] text-[var(--text-secondary)] mb-1 block">
                      Models per scene <span className="text-[8px]">(type or pick from presets below)</span>
                    </label>
                    <div className="grid grid-cols-5 gap-1">
                      {(['terminal', 'task', 'telegram', 'help', 'mobile'] as const).map(scene => (
                        <div key={scene}>
                          <label className="text-[8px] text-[var(--text-secondary)] capitalize">{scene}</label>
                          <input
                            value={a.models[scene]}
                            onChange={e => {
                              const updated = { ...a.models, [scene]: e.target.value };
                              updateAgent(a.id, 'models', updated);
                            }}
                            placeholder="default"
                            className="w-full px-1.5 py-0.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-[9px] text-[var(--text-primary)] font-mono"
                          />
                        </div>
                      ))}
                    </div>
                    {/* Preset models */}
                    <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                      <span className="text-[8px] text-[var(--text-secondary)]">Presets:</span>
                      {((() => {
                        const ct = (settings.agents?.[a.id] as any)?.cliType || (a.id === 'claude' ? 'claude-code' : a.id === 'codex' ? 'codex' : a.id === 'aider' ? 'aider' : 'generic');
                        if (ct === 'claude-code') return ['default', 'sonnet', 'opus', 'haiku', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'];
                        if (ct === 'codex') return ['default', 'o3-mini', 'o4-mini', 'gpt-4.1'];
                        return ['default'];
                      })()).map(preset => (
                        <button
                          key={preset}
                          onClick={() => navigator.clipboard.writeText(preset)}
                          className="text-[8px] px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
                          title={`Click to copy "${preset}"`}
                        >{preset}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-[9px] text-[var(--text-secondary)]">Auto-approve flag <span className="text-[8px]">(empty = requires manual approval)</span></label>
                    <input value={a.skipPermissionsFlag} onChange={e => updateAgent(a.id, 'skipPermissionsFlag', e.target.value)} placeholder="e.g. --dangerously-skip-permissions" className={inputClass} />
                    <div className="flex gap-1 mt-1">
                      {[
                        { label: 'Claude', flag: '--dangerously-skip-permissions' },
                        { label: 'Codex', flag: '--full-auto' },
                        { label: 'Aider', flag: '--yes' },
                      ].map(p => (
                        <button key={p.label} onClick={() => updateAgent(a.id, 'skipPermissionsFlag', p.flag)}
                          className="text-[8px] px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        >{p.label}: {p.flag}</button>
                      ))}
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[9px] text-[var(--text-secondary)] cursor-pointer">
                    <input type="checkbox" checked={a.requiresTTY} onChange={e => updateAgent(a.id, 'requiresTTY', e.target.checked)} className="accent-[var(--accent)]" />
                    Requires terminal environment (TTY)
                    <span className="text-[8px]">— enable for agents that need a terminal to run (e.g. Codex)</span>
                  </label>
                  {a.id !== 'claude' && (
                    <button onClick={() => removeAgent(a.id)} className="text-[9px] text-red-400 hover:underline">Remove Agent</button>
                  )}

                  {/* Profile selector */}
                  <div>
                    <label className="text-[9px] text-[var(--text-secondary)]">Profile <span className="text-[8px]">— select to override model, env vars, API endpoint</span></label>
                    <select
                      value={(settings.agents?.[a.id] as any)?.profile || ''}
                      onChange={e => setSettings({ ...settings, agents: { ...settings.agents, [a.id]: { ...(settings.agents?.[a.id] || {}), profile: e.target.value || undefined } } })}
                      className={inputClass}
                    >
                      <option value="">Default (no profile)</option>
                      {Object.entries(settings.agents || {}).filter(([, cfg]: [string, any]) => cfg.base || cfg.type === 'profile').map(([pid, cfg]: [string, any]) => (
                        <option key={pid} value={pid}>{cfg.name || pid}{cfg.model ? ` (${cfg.model})` : ''}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add agent form */}
      {showAdd && (
        <div className="border border-[var(--accent)]/30 rounded-lg p-3 space-y-2 bg-[var(--bg-secondary)]">
          <div className="text-[10px] text-[var(--text-primary)] font-semibold">Add Custom Agent</div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[9px] text-[var(--text-secondary)]">ID (unique)</label>
              <input value={newAgent.id} onChange={e => setNewAgent({ ...newAgent, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="my-agent" className={inputClass} />
            </div>
            <div>
              <label className="text-[9px] text-[var(--text-secondary)]">Display Name</label>
              <input value={newAgent.name} onChange={e => setNewAgent({ ...newAgent, name: e.target.value })} placeholder="My Agent" className={inputClass} />
            </div>
            <div>
              <label className="text-[9px] text-[var(--text-secondary)]">CLI Type</label>
              <select value={newAgent.cliType} onChange={e => {
                const ct = e.target.value;
                // Auto-fill path from detected agent if available
                const baseId = ct === 'claude-code' ? 'claude' : ct;
                const detected = agents.find(a => a.id === baseId);
                setNewAgent({ ...newAgent, cliType: ct, ...(cliDefaults[ct] || {}), path: detected?.path || newAgent.path, interactiveCmd: detected?.path || newAgent.interactiveCmd });
              }} className={inputClass}>
                <option value="claude-code">Claude Code</option>
                <option value="codex">Codex</option>
                <option value="aider">Aider</option>
                <option value="generic">Generic</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[9px] text-[var(--text-secondary)]">Binary Path</label>
              <input value={newAgent.path} onChange={e => setNewAgent({ ...newAgent, path: e.target.value })}
                placeholder={newAgent.cliType === 'claude-code' ? 'claude' : newAgent.cliType === 'codex' ? 'codex' : newAgent.cliType === 'aider' ? 'aider' : '/usr/local/bin/agent'}
                className={inputClass} />
            </div>
            <div>
              <label className="text-[9px] text-[var(--text-secondary)]">Task Flags (non-interactive)</label>
              <input value={newAgent.taskFlags} onChange={e => setNewAgent({ ...newAgent, taskFlags: e.target.value })} placeholder="--prompt" className={inputClass} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[9px] text-[var(--text-secondary)]">Resume Flag</label>
              <input value={newAgent.resumeFlag} onChange={e => setNewAgent({ ...newAgent, resumeFlag: e.target.value })} placeholder="-c or --resume" className={inputClass} />
            </div>
            <div>
              <label className="text-[9px] text-[var(--text-secondary)]">Output Format</label>
              <select value={newAgent.outputFormat} onChange={e => setNewAgent({ ...newAgent, outputFormat: e.target.value })} className={inputClass}>
                <option value="stream-json">stream-json</option>
                <option value="json">json</option>
                <option value="text">text</option>
              </select>
            </div>
            <div>
              <label className="text-[9px] text-[var(--text-secondary)]">Skip Permissions Flag</label>
              <input value={newAgent.skipPermissionsFlag} onChange={e => setNewAgent({ ...newAgent, skipPermissionsFlag: e.target.value })} placeholder="--dangerously-skip-permissions" className={inputClass} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={addAgent} disabled={!newAgent.id || !newAgent.path} className="text-[10px] px-3 py-1 bg-[var(--accent)] text-white rounded disabled:opacity-50">Add</button>
            <button onClick={() => setShowAdd(false)} className="text-[10px] px-3 py-1 border border-[var(--border)] text-[var(--text-secondary)] rounded">Cancel</button>
          </div>
        </div>
      )}

      {/* ── Profiles Section ── */}
      <div className="mt-4 pt-3 border-t border-[var(--border)]">
        <div className="flex items-center gap-2 mb-2">
          <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">Profiles</label>
          <span className="text-[8px] text-[var(--text-secondary)]">Shared across workspace and terminal — override model, env vars, API endpoint</span>
        </div>

        {/* All profiles (CLI + API) */}
        {Object.entries(settings.agents || {}).filter(([, cfg]: [string, any]) => cfg.base || cfg.type === 'api').map(([id, cfg]: [string, any]) => (
          <ProfileRow key={id} id={id} cfg={cfg} inputClass={inputClass}
            onUpdate={(updated) => setSettings({ ...settings, agents: { ...settings.agents, [id]: updated } })}
            onDelete={() => {
              const updated = { ...settings.agents };
              delete updated[id];
              setSettings({ ...settings, agents: updated });
            }}
          />
        ))}

        <div className="flex gap-2 mt-1">
          <AddProfileForm type="cli" baseAgents={agents.filter(a => !a.isProfile && a.detected)} onAdd={(id, cfg) => {
            setSettings({ ...settings, agents: { ...settings.agents, [id]: cfg } });
          }} />
          <AddProfileForm type="api" baseAgents={[]} onAdd={(id, cfg) => {
            setSettings({ ...settings, agents: { ...settings.agents, [id]: cfg } });
          }} />
        </div>
      </div>

      {/* ── Providers Section ── */}
      <div className="mt-4 pt-3 border-t border-[var(--border)]">
        <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase mb-2 block">API Providers</label>
        {['anthropic', 'google', 'openai', 'grok'].map(name => {
          const provider = settings.providers?.[name] || {};
          const secretKey = `providers.${name}.apiKey`;
          const hasKey = (provider.apiKey && provider.apiKey !== '••••••••') || settings._secretStatus?.[secretKey];
          return (
            <div key={name} className="flex items-center gap-2 px-2 py-1.5 mb-1 rounded" style={{ background: 'var(--bg-tertiary)' }}>
              <span className="text-[10px] text-[var(--text-primary)] w-20 font-semibold capitalize">{name}</span>
              <input
                type="password"
                placeholder="API Key"
                value={provider.apiKey || ''}
                onChange={e => setSettings({
                  ...settings,
                  providers: { ...settings.providers, [name]: { ...provider, apiKey: e.target.value } }
                })}
                className="flex-1 text-[9px] px-2 py-0.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]"
              />
              <span className={`text-[8px] ${hasKey ? 'text-green-400' : 'text-gray-600'}`}>
                {hasKey ? '● set' : '○'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Telegram Agent Selector ──────────────────────────────

function TelegramAgentSelect({ settings, setSettings }: { settings: any; setSettings: (s: any) => void }) {
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetch('/api/agents').then(r => r.json())
      .then(data => setAgents((data.agents || []).filter((a: any) => a.enabled)))
      .catch(() => {});
  }, []);

  if (agents.length <= 1) return null;

  return (
    <div className="flex items-center gap-2 mt-1">
      <span className="text-[9px] text-[var(--text-secondary)]">Default Agent:</span>
      <select
        value={settings.telegramAgent || ''}
        onChange={e => setSettings({ ...settings, telegramAgent: e.target.value })}
        className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-0.5 text-[10px] text-[var(--text-primary)]"
      >
        <option value="">Global default ({settings.defaultAgent || 'claude'})</option>
        {agents.map(a => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      <span className="text-[8px] text-[var(--text-secondary)]">Used for /task without @agent</span>
    </div>
  );
}

// ─── Docs Agent Selector ──────────────────────────────

function DocsAgentSelect({ settings, setSettings }: { settings: any; setSettings: (s: any) => void }) {
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    fetch('/api/agents').then(r => r.json())
      .then(data => setAgents((data.agents || []).filter((a: any) => a.enabled)))
      .catch(() => {});
  }, []);

  if (agents.length <= 1) return null;

  return (
    <div className="flex items-center gap-2 mt-1">
      <span className="text-[9px] text-[var(--text-secondary)]">Docs Agent:</span>
      <select
        value={settings.docsAgent || ''}
        onChange={e => setSettings({ ...settings, docsAgent: e.target.value })}
        className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-0.5 text-[10px] text-[var(--text-primary)]"
      >
        <option value="">Global default ({settings.defaultAgent || 'claude'})</option>
        {agents.map(a => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
    </div>
  );
}
