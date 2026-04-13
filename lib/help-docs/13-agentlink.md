# AgentLink Integration

[AgentLink](http://localhost:8080) is a local agent-to-agent / user-to-agent platform with a Telegram-compatible API. Forge can register as an agent and provide the same commands as the Telegram bot through AgentLink.

## Setup

### 1. Run AgentLink

Start the AgentLink server (default port 8080):

```bash
# Refer to AgentLink's own setup docs
```

### 2. Register an Agent

Use AgentLink's `/api/v1/registerAgent` endpoint to create an agent for Forge. You'll get back an **agent token** — keep it secret.

```bash
curl -X POST http://localhost:8080/api/v1/registerAgent \
  -H "Authorization: Bearer <your-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"bot_id":"forge","name":"Forge Bot","is_public":false}'
```

### 3. Configure Forge

Edit `~/.forge/data/settings.yaml`:

```yaml
agentlinkEnabled: true
agentlinkBaseUrl: "http://localhost:8080/api/v1"
agentlinkAgentToken: "<token from registerAgent>"
agentlinkAllowedAccounts: "your_account_id,another_account_id"  # or "*" for everyone
```

Or set via Settings UI in the browser.

### 4. Restart Forge

```bash
forge server restart
```

You should see in the logs:
```
[agentlink] Bot 'Forge Bot' (bot_id=forge) online
[agentlink] Commands registered
[agentlink] Polling started
```

## Commands

Same as the Telegram bot:

| Command | Description |
|---------|-------------|
| `/i` (`/inject`) | Inject text into a terminal — pick session, then send text |
| `/i <num>` | Select session by number |
| `/i <num> <text>` | One-shot select + send |
| `/iclear` | Clear inject target |
| `/tasks` (`/t`) | List background tasks |
| `/task <project> <prompt>` | Create a new task |
| `/projects` (`/p`) | List projects |
| `/cancel <id>` | Cancel a task |
| `/retry <id>` | Retry a failed task |
| `/tunnel` | Tunnel status |
| `/help` | Show command list |

Plain text in format `project: prompt` creates a task (same as Telegram).

## Inject Mode

After selecting a session with `/i <num>`, plain text messages are typed + Enter submitted into that terminal automatically. Auto-clears after 3 minutes idle. Use `/iclear` to cancel.

## Access Control

`agentlinkAllowedAccounts` is a comma-separated list of `account_id`s that are allowed to talk to Forge. AgentLink does not enforce access control itself — Forge checks each incoming message.

- `*` (or empty) → accept all (use only with `is_public=true` agents on a trusted network)
- `acc_xxx,acc_yyy` → whitelist specific account IDs

## vs Telegram

| Feature | Telegram | AgentLink |
|---------|----------|-----------|
| Hosting | Cloud (Telegram BotFather) | Self-hosted (local AgentLink server) |
| Auth | Bot token | Agent token |
| Polling | `getUpdates` long-poll | `getUpdates` long-poll |
| Slash commands | ✅ | ✅ |
| Inject | ✅ | ✅ |
| Task management | ✅ Full | ✅ List/create/cancel/retry |
| Inline buttons | ✅ | ✅ (basic, callbacks acked) |
| Sensitive messages + TTL | ❌ | ✅ Native |
| Notifications | ✅ | ✅ (via `broadcastAgentlinkNotification`) |

Both can run simultaneously — they're independent.

## Troubleshooting

### Bot doesn't respond
- Check `agentlinkEnabled: true`
- Verify `agentlinkAgentToken` is correct: `curl http://localhost:8080/api/v1/getAgentMe?token=<token>`
- Check Forge logs: `tail -f ~/.forge/data/forge.log | grep agentlink`

### "Access denied"
- Your `chat_id` (account_id) is not in `agentlinkAllowedAccounts`
- Set to `*` to allow all, or add your account ID

### Token verification failed
- Wrong token — regenerate via `/api/v1/agents/<bot_id>/regenerateToken`
- AgentLink server not running on the configured `agentlinkBaseUrl`
