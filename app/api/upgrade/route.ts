import { NextResponse } from 'next/server';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

export async function POST() {
  try {
    // Run upgrade with cache bypass
    const output = execSync(
      'cd /tmp && npm install -g @aion0/forge@latest --prefer-online 2>&1',
      { encoding: 'utf-8', timeout: 120000 }
    );

    // Verify the installed version
    const pkgRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 5000 }).trim();
    const forgeRoot = join(pkgRoot, '@aion0', 'forge');

    // Install devDependencies for build (npm -g doesn't install them)
    try {
      execSync('npm install --include=dev 2>&1', { cwd: forgeRoot, timeout: 120000 });
    } catch {}

    // Read installed version
    let installedVersion = '';
    try {
      const pkg = JSON.parse(require('fs').readFileSync(join(forgeRoot, 'package.json'), 'utf-8'));
      installedVersion = pkg.version;
    } catch {}

    return NextResponse.json({
      ok: true,
      message: `Upgraded to v${installedVersion}. Restart server to apply.`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      ok: false,
      error: `Upgrade failed: ${msg.slice(0, 200)}`,
    });
  }
}
