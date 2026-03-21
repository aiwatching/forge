# Troubleshooting

## Common Issues

### "fork failed: Device not configured" (macOS)
PTY device limit exhausted:
```bash
sudo sysctl kern.tty.ptmx_max=2048
echo 'kern.tty.ptmx_max=2048' | sudo tee -a /etc/sysctl.conf
```

### Session cookie invalid after restart
Fix AUTH_SECRET so it persists:
```bash
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> ~/.forge/data/.env.local
```

### Orphan processes after Ctrl+C
Use `forge server stop` or:
```bash
pkill -f 'telegram-standalone|terminal-standalone|next-server|cloudflared'
```

### Tunnel stuck at "starting"
```bash
pkill -f cloudflared
# Then restart tunnel from UI or Telegram
```

### Forgot admin password
```bash
forge --reset-password
```

### Terminal tabs lost after restart
Terminal state is saved in `~/.forge/data/terminal-state.json`. If corrupted:
```bash
rm ~/.forge/data/terminal-state.json
# Restart server — tabs will be empty but tmux sessions survive
```

### gh CLI not authenticated (Issue Scanner)
```bash
gh auth login
```

### Skills not syncing
Click "Sync" in Skills tab. Check `skillsRepoUrl` in Settings points to valid registry.

### Multiple instances conflict
Use different ports and data directories:
```bash
forge server start --port 4000 --dir ~/.forge/data_demo
forge server stop --port 4000 --dir ~/.forge/data_demo
```

### Page shows "Failed to load chunk"
Clear build cache:
```bash
rm -rf .next
pnpm build  # or forge server rebuild
```

### npm install fails with ENOTEMPTY
Previous install was interrupted. Clean up and retry:
```bash
rm -rf $(npm root -g)/@aion0/forge $(npm root -g)/@aion0/.forge-*
npm install -g @aion0/forge
```

## Logs

- Background server: `~/.forge/data/forge.log`
- Dev mode: terminal output
- View with: `tail -f ~/.forge/data/forge.log`

## Reset Everything

```bash
# Stop server
forge server stop

# Reset password
forge --reset-password

# Clear all data (nuclear option)
rm -rf ~/.forge/data
# Restart — will create fresh data directory
```
