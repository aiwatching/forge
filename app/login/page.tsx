'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLocal = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await signIn('credentials', {
      password,
      callbackUrl: window.location.origin + '/',
    }) as { error?: string } | undefined;
    if (result?.error) setError('Wrong password');
  };

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-80 space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-[var(--text-primary)]">Forge</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">Unified AI Platform</p>
        </div>

        {/* Local password login */}
        <form onSubmit={handleLocal} className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
          />
          {error && <p className="text-xs text-[var(--red)]">{error}</p>}
          <button
            type="submit"
            className="w-full py-2 bg-[var(--accent)] text-white rounded text-sm hover:opacity-90"
          >
            Sign In
          </button>
        </form>

        <div className="flex items-center gap-3 text-[var(--text-secondary)] text-xs">
          <div className="flex-1 h-px bg-[var(--border)]" />
          <span>or</span>
          <div className="flex-1 h-px bg-[var(--border)]" />
        </div>

        {/* Google OAuth */}
        <button
          onClick={() => signIn('google', { callbackUrl: window.location.origin + '/' })}
          className="w-full py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded text-sm text-[var(--text-primary)] hover:bg-[var(--border)] transition-colors"
        >
          Sign in with Google
        </button>
      </div>
    </div>
  );
}
