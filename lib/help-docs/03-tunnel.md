# Remote Access (Cloudflare Tunnel)

## How It Works

Forge creates a temporary Cloudflare Tunnel — a secure public URL that routes to your local Forge server. No Cloudflare account needed.

## Start Tunnel

**From UI**: Click the "Tunnel" button in the top-right header.

**From Telegram**: `/tunnel_start <admin_password>`

**Auto-start**: Set `tunnelAutoStart: true` in Settings.

## Login Flow

- **Local access** (localhost, LAN): Admin password only
- **Remote access** (via tunnel, `.trycloudflare.com`): Admin password + Session Code (2FA)

Session code is generated when tunnel starts. Get it via:
- Telegram: `/tunnel_code <password>`
- CLI: `forge tcode`

## Troubleshooting

- **Tunnel stuck at "starting"**: Kill old cloudflared processes: `pkill -f cloudflared`
- **URL not reachable**: Tunnel may have timed out, restart it
- **Session cookie invalid after restart**: Set `AUTH_SECRET` in `~/.forge/data/.env.local`:
  ```bash
  echo "AUTH_SECRET=$(openssl rand -hex 32)" >> ~/.forge/data/.env.local
  ```
