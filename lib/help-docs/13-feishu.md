# Feishu / Lark Integration

Forge supports Feishu (飞书/Lark) as a messaging channel alongside Telegram. You can inject text into terminals, view tasks, and receive notifications via Feishu bot.

## Setup

### 1. Create Feishu Bot App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app)
2. Click **Create Custom App**
3. Enable **Bot** capability in Features
4. Note down **App ID** and **App Secret**

### 2. Configure Event Subscription

1. In the app settings, go to **Event Subscriptions**
2. Set **Request URL** to: `https://<your-forge-url>/api/feishu/webhook`
   - If using Cloudflare tunnel: `https://<tunnel-url>/api/feishu/webhook`
   - Must be HTTPS and publicly accessible
3. Subscribe to event: `im.message.receive_v1` (receive messages)

### 3. Get Chat ID

To find the chat ID where the bot should send notifications:

1. Add the bot to a group chat (or start a P2P chat with it)
2. Send any message to the bot
3. Check Forge server logs — the incoming webhook will log the `chat_id`
4. Or use Feishu API: `GET /im/v1/chats` to list bot's chats

### 4. Configure Forge Settings

Add to `~/.forge/data/settings.yaml`:

```yaml
feishuAppId: "cli_xxxxxxxxxxxxxxxx"
feishuAppSecret: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
feishuChatId: "oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Or set via Settings UI in the browser.

### 5. Publish the App

In Feishu Open Platform → **Version & Release**, create a version and publish.
For internal use, set visibility to your organization.

## Commands

| Command | Description |
|---------|-------------|
| `/i` | List active terminal sessions, pick one to inject text |
| `/i <num>` | Select session by number |
| `/i <num> <text>` | Select + inject in one shot |
| `/iclear` | Clear inject target |
| `/tasks` | List background tasks (last 10) |
| `/projects` | List projects (up to 15) |
| `/tunnel` | Show tunnel status & URL |
| `/help` | Show command list |

### Inject Mode

After selecting a session with `/i <num>`, all subsequent plain text messages are injected directly into that terminal (typed + Enter submitted). This is the same behavior as the Telegram `/i` command.

- **Auto-clear**: If idle for 3 minutes, inject target is automatically cleared
- **Manual clear**: Send `/iclear`
- **One-shot**: `/i 1 your text here` selects session 1 and injects immediately

## Notifications

Feishu receives the same notifications as Telegram:

| Event | Format |
|-------|--------|
| **Terminal bell** (vibecoding) | Text message: idle detection |
| **Smith task done/failed** (workspace) | Card message with color (green/red) |

Notifications are sent as **interactive cards** with color-coded headers:
- 🟢 Green: success/done
- 🔴 Red: error/failed
- 🔵 Blue: info
- 🟡 Yellow: warning

## vs Telegram

Both channels are fully independent — you can use one or both:

| Feature | Telegram | Feishu |
|---------|----------|--------|
| Bot setup | @BotFather | Open Platform app |
| Auth | Bot token | App ID + Secret (OAuth) |
| Webhook | Polling (standalone process) | Event subscription (HTTP push) |
| Message format | Markdown | Interactive cards + text |
| Inject | ✅ `/i` command | ✅ `/i` command |
| Task management | ✅ Full (create/cancel/retry) | ✅ List only (create via Forge UI) |
| Tunnel control | ✅ Start/stop/code | ✅ Status only |
| Session watch | ✅ `/watch` | ❌ Not yet |
| Docs | ✅ `/docs` `/note` | ❌ Not yet |

## Troubleshooting

### Bot doesn't respond
- Check **App ID** and **App Secret** are correct in settings
- Verify webhook URL is reachable (try `curl -X POST <url>`)
- Check Forge logs: `tail -f ~/.forge/data/forge.log | grep feishu`
- Ensure the app is published and the bot is added to the chat

### "Token fetch failed"
- App ID or App Secret is wrong
- The app hasn't been approved/published yet

### Notifications not received
- Verify `feishuChatId` is correct
- The bot must be a member of the target chat
- Check if `terminalBellEnabled` is false (workspace bells bypass this, but vibecoding bells don't)

### Webhook verification fails
- Feishu sends a `challenge` request when you first set the URL
- Forge responds automatically — if it fails, check the URL is correct and Forge is running
