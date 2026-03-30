# Forge v0.5.8

Released: 2026-03-30

## Changes since v0.5.7

### Features
- feat: Restart Session button for persistentSession agents
- feat: boundSessionId drives non-primary terminal open flow
- feat: boundSessionId per agent — each agent has its own last session
- feat: execution mode determined by config, not runtime tmux state
- feat: /resolve API for workspace lookup + skills use env var → API fallback
- feat: switch session button (▾) for non-primary agents with active terminal
- feat: auto-fallback to headless when terminal startup fails
- feat: Forge agent monitors all inbox states
- feat: Forge agent — autonomous bus monitor with periodic scanning
- feat: Forge agent auto-requests summary when agent completes without reply
- feat: nudge sender when target agent completes — inject hint into terminal
- feat: restore auto-reply on completion + keep check_outbox as supplement
- feat: auto-reply to message sender on completion + check_outbox tool
- feat: add MCP Server to monitor panel and status script
- feat: get_agents tool + fuzzy send_message matching
- feat: inject FORGE env vars at all terminal launch points
- feat: --mcp-config injected at all claude terminal launch points
- feat: Forge MCP Server — replace HTTP skills with native tool calls
- feat: open terminal button on session list items
- feat: detect CLI startup failures in persistent sessions
- feat: all terminal entry points use fixedSessionId via --resume
- feat: bind button on sessions list to set fixedSessionId
- feat: click-to-change session binding in project header
- feat: show bound session in project header and session list
- feat: session picker dropdown for fixedSessionId binding
- feat: session list shows full ID on expand with copy button
- feat: show and edit fixedSessionId in agent config modal
- feat: primary agent setup prompt for new and existing workspaces
- feat: primary agent checkbox in agent config modal
- feat: terminal dock — inline right panel with tabs and resizable width
- feat: VibeCoding uses workspace primary agent's fixed session
- feat: fixed CLI session binding for primary agent
- feat: primary agent — terminal-only, fixed session, root directory
- feat: persistent terminal session per agent
- feat: watch send_message auto-detects tmux sessions (workspace + VibeCoding)
- feat: watch send_message injects directly into terminal session

### Bug Fixes
- fix: unset profile env vars before setting new ones on agent switch
- fix: normalize workDir paths before encoding session directory
- fix: session list uses agent's workDir, not project root
- fix: clear boundSessionId on agent change even without tmux session
- fix: kill terminal and clear boundSessionId when agent CLI changes
- fix: rename "Keep terminal session alive" to "Terminal mode"
- fix: codex skipPermissionsFlag back to --full-auto
- fix: codex skip flag + -c only when sessions exist
- fix: set FORGE env vars as separate tmux command before CLI start
- fix: set FORGE env vars in tmux, skills use env vars not curl lookup
- fix: mark forge skills as FALLBACK so MCP tools take priority
- fix: nudge explicitly says use MCP tool, not forge-send skill
- fix: skills prefer MCP tools, fix subdirectory workspace lookup
- fix: show headless after Kill, terminal (pending) only before daemon start
- fix: Suspend vs Kill terminal behavior
- fix: Forge agent nudge uses stronger language to trigger send_message
- fix: always resolve agent launch info before opening terminal
- fix: bus log updates immediately after message delete (no refresh needed)
- fix: stop daemon kills tmux sessions + Forge agent only scans new messages
- fix: enlarge session switch button (▾) for easier clicking
- fix: terminal button visible during running state (was hidden)
- fix: daemon persistent session uses -c for non-primary agents
- fix: restore -c flag for non-primary agents to resume latest session
- fix: Forge agent processes historical pending/running, skips done/failed
- fix: Forge agent only scans messages after daemon start, ignores history
- fix: Forge agent restarts message loop for stuck pending messages
- fix: add skipPermissions to FloatingTerminalInline (was missing)
- fix: pass skipPermissions to FloatingTerminal, add --dangerously-skip-permissions
- fix: block terminal open when daemon not started
- fix: re-open terminal when agent config changes (close old first)
- fix: don't use claude -c for workspace agents (subdirs may have no session)
- fix: MCP monitor shows port not pid, add separator after Tunnel
- fix: add type:'sse' to MCP config (required by Claude Code schema)
- fix: MCP server port 7830 → 8406 (follows 8403/8404/8405 sequence)
- fix: MCP agentId resolved by server, not hardcoded in all URLs
- fix: MAX_ACTIVE limits daemon start, not workspace loading
- fix: increase MAX_ACTIVE workspaces from 2 to 5
- fix: move all session action buttons to second row (right-aligned)
- fix: skip message loop when persistent session fails to start
- fix: only primary agent uses fixedSession, others use -c or session dialog
- fix: refresh fixed session display after bind via window event
- fix: resolveFixedSession auto-binds latest session when not set
- fix: add error logging to session bind button for debugging
- fix: session list uses disk files as source of truth, not stale index
- fix: bind button always visible, set session when none bound
- fix: limit fixedSessionId auto-bind to only 3 entry points
- fix: show bind button even when no session is bound yet
- fix: auto-bind fixedSessionId at Next.js API layer
- fix: ensure primary session binding at all entry points
- fix: auto-bind fixedSessionId on agent add and config update
- fix: show terminal (pending) for persistentSession agents without tmux yet
- fix: replace nested button with div+span in terminal dock tabs
- fix: don't auto-open terminal UI on workspace load
- fix: session binding edge cases
- fix: auto-bind latest CLI session on upgrade instead of creating new
- fix: persistent session starts claude with -c (resume last session)
- fix: verify stored tmuxSession is alive before using, fallback to find
- fix: findTmuxSession reads terminal-state.json for VibeCoding sessions
- fix: session watch detects file switch (new session created)
- fix: getAllAgentStates preserves tmuxSession + currentMessageId
- fix: persistent session emits state update so frontend knows tmuxSession
- fix: watch send_message sends configured prompt only + auto-Enter
- fix: open terminal attaches to existing tmux session regardless of mode
- fix: session watch only sends last matching entry, not all content
- fix: remove .js extension from dynamic import for Next.js compat
- fix: workspace terminal defaults to resume last session (-c)
- fix: updateAgentConfig rebuilds worker + emits status update
- fix: CLI backend auto-finds latest session when no sessionId

### Performance
- perf: cache session binding check, defer SessionView loading

### Refactoring
- refactor: MCP context via URL params, remove FORGE env var injection
- refactor: fixedSessionId is project-level, not workspace/agent-level
- refactor: remove manual/auto mode, unify message execution via tmuxSession

### Documentation
- revert auto-resume + document persistent terminal session plan

### Other
- revert: remove orchestrator auto-reply, let agent decide via MCP
- cleanup: remove fixedSessionId from agent config and workspace state
- simplify: remove auto-detect session binding complexity
- revert: restore floating terminal windows, remove dock panel
- revert auto-resume + document persistent terminal session plan


**Full Changelog**: https://github.com/aiwatching/forge/compare/v0.5.7...v0.5.8
