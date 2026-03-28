# Forge v0.5.0

Released: 2026-03-28

## Changes since v0.4.16

### Features
- feat: watch actions (log/analyze/approve) + config UI
- feat: agent watch — autonomous periodic monitoring
- feat: Workspace — multi-agent terminal view per project
- feat: requires-driven scheduling for delivery engine
- feat: standardized envelope format + request/response audit trail
- feat: visible data contracts on flow editor — artifact names on edges and nodes
- feat: ReactFlow-based delivery role editor — drag & connect agent topology
- feat: customizable delivery roles — users compose agent phases from presets
- feat: show all 4 agent panels in 2x2 grid with SVG flow arrows
- feat: Delivery Workspace — multi-agent orchestrated software delivery
- feat: conversation terminal view with inline input and data flow
- feat: Conversation Mode — multi-agent dialogue with graph view and live logs
- feat: Pipeline editor node edit modal has Agent + Mode selectors
- feat: Pipeline UI shows agent per node
- feat: per-doc-root agent config (Settings + Docs toolbar)
- feat: Telegram default agent + Docs agent config
- feat: TTY support for agents that need terminal (e.g. Codex)
- feat: per-agent skip permissions flag with presets
- feat: Telegram agent support — @agent syntax + /agents command
- feat: agent selection for Pipeline, Mobile, Help
- feat: per-scene model config for each agent
- feat: model config moved from global to per-agent
- feat: task system uses agent adapter + agent selector in NewTaskModal
- feat: terminal tab agent selection
- feat: Agents management UI in Settings
- feat: multi-agent foundation — registry, adapters, API

### Bug Fixes
- fix: tolerate Next.js 16 _global-error prerender bug in build
- fix: Log panel reads from persistent logs.jsonl + clear logs button
- fix: restart watch loop when agent config is updated
- fix: watch directory picker uses correct tree type and flattens nested dirs
- fix: send block only when message is still running, not after done
- fix: block forge-send reply to message sender + skill prompt hint
- fix: hasRunning check uses worker's current message, not all bus log
- fix: no extra reply message when processing downstream request
- fix: smith send API returns messageId for outbox tracking
- fix: inject FORGE_AGENT_ID/WORKSPACE_ID/PORT into manual terminal env
- fix: forge skills use $FORGE_AGENT_ID instead of hardcoded 'unknown'
- fix: deduplicate bus_message SSE events by message ID
- fix: emit done before markMessageDone so causedBy can read messageId
- fix: remove notifyDownstreamForRevalidation + prevent multiple running messages
- fix: abort_message no longer errors on already-aborted messages
- fix: getAllAgentStates returns worker state with entry mode override
- fix: manual stays in mode field, displayed as purple 'manual' on node
- fix: show 'manual' task status when agent is in manual mode
- fix: close terminal uses close_terminal action instead of reset
- fix: restartAgentDaemon recreates worker after resetAgent kills it
- fix: parseBusMarkers re-scanning entire history causes message loops
- fix: restartAgentDaemon aligned with simplified setManualMode
- fix: manual mode shows down because worker async cleanup overrides state
- fix: buffered wake prevents lost messages in daemon loop
- fix: simplify retry — reset original message to pending, no emit
- fix: retry creates new message, preserves original for history
- fix: message retry causing duplicate execution
- fix: PTY spawn in ESM — use createRequire for node-pty
- fix: TTY detection for codex profiles + clear agent cache on terminal open
- fix: project terminal dialog loads sessions from claude-sessions API
- fix: bypass GitHub CDN cache on skills sync
- fix: merge tags from info.json during v2 registry sync
- fix: enable allowProposedApi for search decorations
- fix: profile env/model propagation across all terminal launch paths
- fix: saveAgentConfig preserves profile fields (base/env/model/type)
- fix: sessions API uses orch.projectPath, ESM imports, non-claude compat
- fix: stricter workDir validation — block .. and sibling dir escape
- fix: workDir with leading / treated as relative to project, not absolute
- fix: workDir normalize strips ./ prefix, default to smith label
- fix: only use claude -c (resume) if existing session exists
- fix: handle unknown agentId in smith send API
- fix: whitelist /api/workspace in middleware for forge skill auto-discover
- fix: install skills as directories with SKILL.md (Claude Code format)
- fix: use imported resolve instead of require('node:path') in ESM context
- fix: orchestrator actively manages smith lifecycle in start/stop daemon
- fix: startDaemon error handling + stopDaemon cleanup
- fix: close terminal should enter listening, not execute steps
- fix: workspace terminal uses correct message types from terminal server
- fix: workspace terminal input + keep alive when switching tabs
- fix: rewrite WorkspaceView — each agent is a real interactive terminal
- fix: move ssr:false dynamic import to client wrapper component
- fix: disable SSR for Dashboard to eliminate hydration mismatch
- fix: default phases missing _outputArtifactName/_label/_icon metadata
- fix: data flow arrows based on requires/produces, not sequential order
- fix: suppress hydration warning from locale/extension mismatch
- fix: pipeline node shows 'default' instead of 'claude' when no agent set
- fix: PTY onExit/onData registered once, fixes stuck tasks after cancel
- fix: auto-kill PTY agents after 15s idle
- fix: strip ANSI/terminal control codes from PTY agent output
- fix: retryTask preserves original agent selection
- fix: use pipe stdin for task spawn, close immediately after
- fix: non-claude agents no longer fallback to claude or show claude model
- fix: settings agent config debounced save + unsaved warning on close
- fix: generic agents use taskFlags from settings, log raw text output
- fix: only pass model flag to agents that support it, show agent in task
- fix: settings agent colors match terminal — use API detected status
- fix: show all configured agents, not just detected ones

### Performance
- perf: watch heartbeat only logs to console, not to files/history
- perf: watch uses timestamp comparison instead of full snapshot

### Refactoring
- refactor: remove Delivery tab, keep only Workspace

### Documentation
- docs: update workspace help with message system design
- docs: add workspace help, update settings/projects/overview docs

### Other
- watch: push heartbeat + alert logs to agent history for Log panel
- watch: log heartbeat on each check cycle
- ui: structured watch target builder with directory picker
- debug: log deleteMessage results for diagnosing message reappearance
- persist currentMessageId as task trigger identifier
- inbox: abort all pending button for batch operations
- inbox/outbox: batch select + delete for completed messages
- Phase 3: ticket UI, retry limits, ticket API actions
- Phase 2: causedBy chain + ticket messages + receive rules
- Phase 1: anti-loop — DAG cycle detection, directional broadcast, disable SEND markers
- ui: show mode (auto/manual) as separate line on agent node
- simplify: setManualMode only changes mode, message loop skips manual
- debug: log when agent message loop skips due to not-listening state
- skills: auto-loop sync with progress indicator
- skills: incremental sync — registry fast, info.json in batches
- terminal: add Ctrl/Cmd+F search in terminal buffer
- terminal: add WebGL rendering + Unicode 11 support
- unified terminal launch: resolveTerminalLaunch for both VibeCoding + Workspace
- settings: agent has profile selector dropdown
- settings: profiles are global/shared, not per-agent
- settings: add cliType selector to agent config panel
- settings: profiles nested inside each agent, not standalone section
- open_terminal: return cliType + cliCmd from agent registry
- settings: env var templates per CLI type for profiles
- agent config: add cliType field (claude-code/codex/aider/generic)
- vibecoding: profile selector + session picker + env injection for terminal
- terminal profile: env var injection via export, not settings.json
- terminal: session picker with recent sessions list
- terminal: styled launch dialog — New Session / Resume Latest
- terminal: simple prompt dialog for new/resume before opening
- terminal: prompt user to choose new session or resume
- cleanup: simplify resume flag check in FloatingTerminal
- UI: show resolved workDir path hint below input
- forge skills: explicit 2-step commands, no env var checks
- forge skills: inline auto-discover, no separate setup step
- workDir validation: unique per smith, must be within project, no nesting
- profile settings: write to smith workDir, not project root
- profile terminal: apply env/model to .claude/settings.json on open_terminal
- forge skills: install/update on every forge startup
- forge skills: auto-discover workspace context with fallback defaults
- skills: install once in startDaemon, remove per-smith install
- skills: install to ~/.claude/skills/ globally + fix project deny rules
- skill installer: auto-fix .claude/settings.json curl permissions
- forge skills: env var injection + auto-install on smith startup
- agent profiles: editable profile rows with expand/collapse
- agent profiles: env vars support for custom CLI configs (e.g., FortiAI)
- agent profiles UI: settings management + workspace profile selector
- agent profiles + provider config data layer
- smith message-driven architecture: independent message loop, inbox management, status simplification
- multiple agent implementation
- fix issue
- fix issue for workspace
- optmized projects
- refactoring workspace
- implement workspace and fix issue
- implement multiple agents
- ui: show agent badge on ReactFlow node blocks in pipeline editor
- simplify: single docs agent instead of per-root
- ui: remove Docs page agent selector, keep Settings-only config
- ui: remove leftover model/permissions migration notes from Settings
- ui: consistent agent colors across terminal and settings
- ui: agent buttons green=installed, gray=not installed
- ui: agent buttons ≤3 inline, >3 overflow with dropdown
- ui: agent buttons inline with project name in new tab modal


**Full Changelog**: https://github.com/aiwatching/forge/compare/v0.4.16...v0.5.0
