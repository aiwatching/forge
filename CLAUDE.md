## Project: Forge (@aion0/forge)

### Scripts
```bash
# ── Start ──
./start.sh              # production (kill old processes → build → start)
./start.sh dev           # development (hot-reload)
forge server start              # production via npm link/install
forge server start --dev        # dev mode
forge server start              # background by default, logs to ~/.forge/forge.log
forge server start --foreground # foreground mode
forge server stop               # stop background server
forge server restart            # stop + start (safe for remote)
forge server rebuild            # force rebuild
forge server start --port 4000 --terminal-port 4001 --dir ~/.forge-staging
forge server start --reset-terminal  # kill terminal server (loses tmux attach)
forge --version                 # show version

# ── Test ──
./dev-test.sh            # test instance (port 4000, data ~/.forge-test)

# ── Install ──
./install.sh             # install from npm
./install.sh --local     # install from local source (npm link + build)

# ── Publish ──
./publish.sh             # bump patch version, commit, tag
./publish.sh minor       # bump minor
./publish.sh 1.0.0       # explicit version
npm login && npm publish --access public --otp=<code>

# ── Monitor ──
./check-forge-status.sh  # show process status + tmux sessions

# ── CLI ──
forge                    # help
forge --version          # show version
forge tcode              # show tunnel URL + session code
forge tasks              # list tasks
forge task <project> "prompt"  # submit task
forge watch <id>         # live stream task output
```

### Key Paths
- Data: `~/.forge/` (settings, db, password, terminal-state, flows, bin)
- npm package: `@aion0/forge`
- GitHub: `github.com/aiwatching/forge`

### Architecture
- `forge-server.mjs` starts: Next.js + terminal-standalone + telegram-standalone
- `pnpm dev` / `start.sh dev` starts: Next.js (init.ts spawns terminal + telegram)
- `FORGE_EXTERNAL_SERVICES=1` → init.ts skips spawning (forge-server manages them)

## Obsidian Vault
Location: /Users/zliu/MyDocuments/obsidian-project/Projects/Bastion
When I ask about my notes, use bash to search and read files from this directory.
Example: find /Users/zliu/MyDocuments/obsidian-project -name "*.md" | head -20
