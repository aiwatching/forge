# Telegram Bot Setup

## Setup Steps

1. Open Telegram, search for [@BotFather](https://t.me/botfather)
2. Send `/newbot`, follow prompts to create a bot
3. Copy the bot token (looks like `6234567890:ABCDefGHIJKLMNOPQRSTUVWXYZ`)
4. In Forge Settings, paste the token into **Telegram Bot Token**
5. To get your Chat ID: send any message to your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` — find `chat.id` in the response
6. Paste the Chat ID into **Telegram Chat ID** in Settings
7. The bot starts automatically after saving

## Commands

| Command | Description |
|---------|-------------|
| `/task <project> <prompt>` | Create a background task |
| `/tasks [status]` | List tasks (running/queued/done/failed) |
| `/sessions [project]` | AI summary of Claude Code sessions |
| `/watch <id>` | Live stream task output |
| `/unwatch <id>` | Stop streaming |
| `/docs <query>` | Search Obsidian vault |
| `/note <text>` | Quick note to vault |
| `/peek <project>` | Preview running session |
| `/cancel <id>` | Cancel a task |
| `/retry <id>` | Retry a failed task |
| `/tunnel_start <password>` | Start Cloudflare Tunnel (returns URL + code) |
| `/tunnel_stop` | Stop tunnel |
| `/tunnel_code <password>` | Get session code for remote login |
| `/projects` | List configured projects |

## Shortcuts
- Reply to a task message to interact with it
- Send `"project: instructions"` to quick-create a task
- Numbered lists — reply with a number to select

## Troubleshooting

- **Bot not responding**: Check token is correct, restart server
- **"Unauthorized"**: Chat ID doesn't match configured value
- **Multiple users**: Set comma-separated Chat IDs (e.g. `123456,789012`)
