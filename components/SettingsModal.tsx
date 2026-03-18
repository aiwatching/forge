'use client';

import { useState, useEffect, useCallback } from 'react';

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
  onSave: (field: string, oldValue: string, newValue: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'change' | 'clear'>('change');
  const [oldValue, setOldValue] = useState('');
  const [newValue, setNewValue] = useState('');
  const [confirmValue, setConfirmValue] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const canSave = mode === 'clear'
    ? (isSet && oldValue.length > 0)
    : ((!isSet || oldValue.length > 0) && newValue.length > 0 && newValue === confirmValue);

  const handleSave = async () => {
    if (mode === 'change' && newValue !== confirmValue) {
      setError('New values do not match');
      return;
    }
    setSaving(true);
    setError('');
    const err = await onSave(field, oldValue, mode === 'clear' ? '' : newValue);
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

        {isSet && (
          <div className="space-y-1">
            <label className="text-[10px] text-[var(--text-secondary)]">Current value</label>
            <SecretInput
              value={oldValue}
              onChange={v => { setOldValue(v); setError(''); }}
              placeholder="Enter current value to verify"
              className={inputClass}
            />
          </div>
        )}

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
            Enter the current value to verify, then click Clear to remove it.
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
  const [editingSecret, setEditingSecret] = useState<{ field: string; label: string } | null>(null);

  const refreshTunnel = useCallback(() => {
    fetch('/api/tunnel').then(r => r.json()).then(setTunnel).catch(() => {});
  }, []);

  const fetchSettings = useCallback(() => {
    fetch('/api/settings').then(r => r.json()).then((data: Settings) => {
      const status = data._secretStatus || {};
      delete data._secretStatus;
      setSettings(data);
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
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const saveSecret = async (field: string, oldValue: string, newValue: string): Promise<string | null> => {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _secretUpdate: { field, oldValue, newValue } }),
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
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

          {(settings.docRoots || []).map(root => (
            <div key={root} className="flex items-center gap-2">
              <span className="flex-1 text-xs px-2 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded font-mono truncate">
                {root}
              </span>
              <button
                onClick={() => setSettings({ ...settings, docRoots: settings.docRoots.filter(r => r !== root) })}
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
        </div>

        {/* Claude Path */}
        <div className="space-y-2">
          <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">
            Claude Code Path
          </label>
          <p className="text-[10px] text-[var(--text-secondary)]">
            Full path to the claude binary. Run `which claude` to find it.
          </p>
          <input
            value={settings.claudePath}
            onChange={e => setSettings({ ...settings, claudePath: e.target.value })}
            placeholder="/usr/local/bin/claude"
            className="w-full px-2 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]"
          />
        </div>

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
        </div>

        {/* Model Settings */}
        <div className="space-y-2">
          <label className="text-xs text-[var(--text-secondary)] font-semibold uppercase">
            Models
          </label>
          <p className="text-[10px] text-[var(--text-secondary)]">
            Claude model for each feature. Uses your Claude Code subscription. Options: sonnet, opus, haiku, or default (subscription default).
          </p>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[9px] text-[var(--text-secondary)] block mb-0.5">Tasks</label>
              <select
                value={settings.taskModel || 'sonnet'}
                onChange={e => setSettings({ ...settings, taskModel: e.target.value })}
                className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)]"
              >
                <option value="default">Default</option>
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
                <option value="haiku">Haiku</option>
              </select>
            </div>
            <div>
              <label className="text-[9px] text-[var(--text-secondary)] block mb-0.5">Pipelines</label>
              <select
                value={settings.pipelineModel || 'sonnet'}
                onChange={e => setSettings({ ...settings, pipelineModel: e.target.value })}
                className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)]"
              >
                <option value="default">Default</option>
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
                <option value="haiku">Haiku</option>
              </select>
            </div>
            <div>
              <label className="text-[9px] text-[var(--text-secondary)] block mb-0.5">Telegram</label>
              <select
                value={settings.telegramModel || 'sonnet'}
                onChange={e => setSettings({ ...settings, telegramModel: e.target.value })}
                className="w-full text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)]"
              >
                <option value="default">Default</option>
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
                <option value="haiku">Haiku</option>
              </select>
            </div>
          </div>
        </div>

        {/* Permissions */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs text-[var(--text-primary)] cursor-pointer">
            <input
              type="checkbox"
              checked={settings.skipPermissions || false}
              onChange={e => setSettings({ ...settings, skipPermissions: e.target.checked })}
              className="rounded"
            />
            Skip permissions check (--dangerously-skip-permissions)
          </label>
          <p className="text-[9px] text-[var(--text-secondary)]">
            When enabled, all Claude Code tasks and pipelines run without permission prompts. Useful for background automation but less safe.
          </p>
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
              <button
                disabled={tunnelLoading}
                onClick={async () => {
                  setTunnelLoading(true);
                  try {
                    const res = await fetch('/api/tunnel', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'start' }),
                    });
                    const data = await res.json();
                    setTunnel(data);
                  } catch {}
                  setTunnelLoading(false);
                }}
                className="text-[10px] px-3 py-1.5 bg-[var(--green)] text-black rounded hover:opacity-90 disabled:opacity-50"
              >
                {tunnelLoading ? (tunnel.installed ? 'Starting...' : 'Downloading...') : 'Start Tunnel'}
              </button>
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

          <SecretField
            label="Tunnel Password"
            description="Telegram tunnel password (for /tunnel_password command)"
            isSet={!!secretStatus.telegramTunnelPassword}
            onEdit={() => setEditingSecret({ field: 'telegramTunnelPassword', label: 'Tunnel Password' })}

          />
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
