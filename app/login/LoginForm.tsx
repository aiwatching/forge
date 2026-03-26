'use client';

import { useState, useEffect } from 'react';
import { signIn } from 'next-auth/react';

export default function LoginForm({ isRemote }: { isRemote: boolean }) {
  const [password, setPassword] = useState('');
  const [sessionCode, setSessionCode] = useState('');
  const [error, setError] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('forge-theme');
    if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const result = await signIn('credentials', {
      password,
      sessionCode: isRemote ? sessionCode : '',
      isRemote: String(isRemote),
      redirect: false,
    }) as { error?: string; ok?: boolean } | undefined;
    if (result?.error) {
      setError(isRemote ? 'Wrong password or session code' : 'Wrong password');
    } else if (result?.ok) {
      window.location.href = window.location.origin + '/';
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-80 space-y-6">
        <div className="text-center">
          <img src="/icon.png" alt="Forge" width={48} height={48} className="rounded mx-auto mb-2" />
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Forge</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            {isRemote ? 'Remote Access' : 'Local Access'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }}
            placeholder="Admin Password"
            autoFocus
            className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
          />
          {isRemote && (
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              value={sessionCode}
              onChange={e => { setSessionCode(e.target.value.replace(/\D/g, '')); setError(''); }}
              placeholder="Session Code (8 digits)"
              className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] font-mono tracking-widest text-center focus:outline-none focus:border-[var(--accent)]"
            />
          )}
          {error && <p className="text-xs text-[var(--red)]">{error}</p>}
          <button
            type="submit"
            className="w-full py-2 bg-[var(--accent)] text-white rounded text-sm hover:opacity-90"
          >
            Sign In
          </button>
          {isRemote && (
            <p className="text-[10px] text-[var(--text-secondary)] text-center">
              Session code is generated when tunnel starts. Use /tunnel_code in Telegram or <code>forge tcode</code> to get it.
            </p>
          )}
          <div className="text-center">
            <button
              type="button"
              onClick={() => setShowHelp(v => !v)}
              className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Forgot password?
            </button>
            {showHelp && (
              <p className="text-[10px] text-[var(--text-secondary)] mt-1 bg-[var(--bg-tertiary)] rounded p-2">
                Run in terminal:<br />
                <code className="text-[var(--accent)]">forge --reset-password</code>
              </p>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
