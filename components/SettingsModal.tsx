'use client';

import { useState, useEffect, useCallback } from 'react';

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
  });
  const [newRoot, setNewRoot] = useState('');
  const [newDocRoot, setNewDocRoot] = useState('');
  const [saved, setSaved] = useState(false);
  const [tunnel, setTunnel] = useState<TunnelStatus>({
    status: 'stopped', url: null, error: null, installed: false, log: [],
  });
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [confirmStopTunnel, setConfirmStopTunnel] = useState(false);

  const refreshTunnel = useCallback(() => {
    fetch('/api/tunnel').then(r => r.json()).then(setTunnel).catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(setSettings);
    refreshTunnel();
  }, [refreshTunnel]);

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
          <input
            value={settings.telegramBotToken}
            onChange={e => setSettings({ ...settings, telegramBotToken: e.target.value })}
            placeholder="Bot token (from @BotFather)"
            className="w-full px-2 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]"
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
            {settings.telegramBotToken && settings.telegramChatId && (
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

          <div className="space-y-1">
            <label className="text-[10px] text-[var(--text-secondary)]">
              Telegram tunnel password (for /tunnel_password command)
            </label>
            <input
              value={settings.telegramTunnelPassword}
              onChange={e => setSettings({ ...settings, telegramTunnelPassword: e.target.value })}
              placeholder="Set a password to get login credentials via Telegram"
              className="w-full px-2 py-1.5 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
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
    </div>
  );
}
