/**
 * Next.js instrumentation — runs once when the server starts.
 * Sets MW_PASSWORD before any request is handled.
 */
export async function register() {
  // Only run on server, not Edge
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Load ~/.forge/.env.local if it exists (works for both pnpm dev and forge-server)
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const envFile = join(homedir(), '.forge', '.env.local');
    if (existsSync(envFile)) {
      for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }

    const { getPassword } = await import('./lib/password');
    const password = getPassword();
    process.env.MW_PASSWORD = password;
    console.log(`[init] Login password: ${password}`);
    console.log('[init] Forgot password? Run: forge password');
  }
}
