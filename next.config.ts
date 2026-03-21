import type { NextConfig } from 'next';

const terminalPort = parseInt(process.env.TERMINAL_PORT || '') || 3001;

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
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
