## Project: Forge (@aion0/forge)

### Dev Commands
```bash
# Development (hot-reload)
pnpm dev

# Production (local)
pnpm build && pnpm start

# Publish to npm (bump version in package.json first)
npm login
npm publish --access public --otp=<code>

# Install globally from local source (for testing)
npm install -g /Users/zliu/IdeaProjects/my-workflow

# Install from npm
npm install -g @aion0/forge

# Run via npm global install
forge-server              # foreground (auto-builds if needed)
forge-server --dev        # dev mode
forge-server --background # background, logs to ~/.forge/forge.log
forge-server --stop       # stop background server
forge-server --rebuild    # force rebuild

# CLI
forge                     # help
forge password            # show today's login password
forge tasks               # list tasks
forge task <project> "prompt"  # submit task

# Terminal server runs on port 3001 (auto-started by Next.js)
# Data directory: ~/.forge/
# Config: ~/.forge/settings.yaml
# Env: ~/.forge/.env.local
```

### Key Paths
- Data: `~/.forge/` (settings, db, password, terminal-state, flows, bin)
- npm package: `@aion0/forge`
- GitHub: `github.com/aiwatching/forge`

## Obsidian Vault
Location: /Users/zliu/MyDocuments/obsidian-project/Projects/Bastion
When I ask about my notes, use bash to search and read files from this directory.
Example: find /Users/zliu/MyDocuments/obsidian-project -name "*.md" | head -20