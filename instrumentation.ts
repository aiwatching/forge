/**
 * Next.js instrumentation — runs once when the server starts.
 * Loads .env.local and prints login password.
 */
export async function register() {
  // Only run on server, not Edge
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Load ~/.forge/.env.local if it exists (works for both pnpm dev and forge-server)
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { getDataDir } = await import('./lib/dirs');
    const dataDir = getDataDir();
    const envFile = join(dataDir, '.env.local');
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

    // Print password info
    const { getAdminPassword } = await import('./lib/password');
    const admin = getAdminPassword();
    if (admin) {
      console.log(`[init] Admin password: configured`);
    } else {
      console.log('[init] No admin password set — configure in Settings');
    }
  }
}
