import { NextResponse } from 'next/server';
import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import { execSync } from 'node:child_process';

export async function POST() {
  try {
    // Check if installed via npm link (symlink = local dev)
    let isLinked = false;
    try { isLinked = lstatSync(join(process.cwd())).isSymbolicLink(); } catch {}

    if (isLinked) {
      return NextResponse.json({
        ok: false,
        error: 'Local dev install (npm link). Run: git pull && pnpm install && pnpm build',
      });
    }

    // Upgrade from npm
    execSync('cd /tmp && npm install -g @aion0/forge', { timeout: 120000 });

    // Install devDependencies for build (npm -g doesn't install them)
    const pkgRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 5000 }).trim();
    const forgeRoot = join(pkgRoot, '@aion0', 'forge');
    try {
      execSync('npm install --include=dev', { cwd: forgeRoot, timeout: 120000 });
    } catch {}

    return NextResponse.json({
      ok: true,
      message: 'Upgraded. Restart server to apply.',
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: `Upgrade failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}
