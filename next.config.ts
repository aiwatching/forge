import type { NextConfig } from 'next';
import { networkInterfaces } from 'node:os';

const terminalPort = parseInt(process.env.TERMINAL_PORT || '') || 3001;

// Auto-detect local IPs for dev mode cross-origin access
const localIPs = Object.values(networkInterfaces())
  .flat()
  .filter(i => i && !i.internal && i.family === 'IPv4')
  .map(i => i!.address);

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  allowedDevOrigins: localIPs,
  async rewrites() {
    return [
      {
        // Proxy terminal WebSocket through Next.js so it works via Cloudflare Tunnel
        source: '/terminal-ws',
        destination: `http://localhost:${terminalPort}`,
      },
    ];
  },
};

export default nextConfig;
