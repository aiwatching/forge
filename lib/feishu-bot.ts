/**
 * Feishu (Lark) Bot — notification & inject interface for Forge.
 *
 * Setup:
 * 1. Create a Feishu bot app: https://open.feishu.cn/app
 * 2. Enable "Bot" capability
 * 3. Add Event Subscription URL: https://<your-forge>/api/feishu/webhook
 * 4. Subscribe to: im.message.receive_v1
 * 5. Set App ID, App Secret, and Chat ID in Forge Settings
 *
 * Features:
 * - /i — inject text into terminal (same as Telegram)
 * - /tasks — list tasks
 * - /help — show commands
 * - Notifications: task done/failed, terminal bell, smith status
 */

import { loadSettings } from './settings';

const FEISHU_API = 'https://open.feishu.cn/open-apis';

// ─── Token management ────────────────────────────────────

let _cachedToken: { token: string; expiresAt: number } | null = null;

/** Get tenant_access_token (auto-refreshes if expired) */
export async function getFeishuToken(): Promise<string | null> {
  const settings = loadSettings();
  if (!settings.feishuAppId || !settings.feishuAppSecret) return null;

  // Return cached if still valid (with 60s buffer)
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60000) {
    return _cachedToken.token;
  }

  try {
    const res = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: settings.feishuAppId,
        app_secret: settings.feishuAppSecret,
      }),
    });
    const data = await res.json();
    if (data.code !== 0 || !data.tenant_access_token) {
      console.error('[feishu] Token fetch failed:', data.msg || data);
      return null;
    }
    _cachedToken = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire || 7200) * 1000,
    };
    return _cachedToken.token;
  } catch (err: any) {
    console.error('[feishu] Token fetch error:', err.message);
    return null;
  }
}

// ─── Send messages ───────────────────────────────────────

/** Send a text message to the configured chat */
export async function sendFeishuMessage(text: string, chatId?: string): Promise<boolean> {
  const settings = loadSettings();
  const targetChat = chatId || settings.feishuChatId;
  if (!targetChat) return false;

  const token = await getFeishuToken();
  if (!token) return false;

  try {
    const res = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: targetChat,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });
    const data = await res.json();
    if (data.code !== 0) {
      console.error('[feishu] Send failed:', data.msg || data);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[feishu] Send error:', err.message);
    return false;
  }
}

/** Send a rich card message */
export async function sendFeishuCard(title: string, content: string, color: 'blue' | 'green' | 'red' | 'yellow' = 'blue'): Promise<boolean> {
  const settings = loadSettings();
  if (!settings.feishuChatId) return false;

  const token = await getFeishuToken();
  if (!token) return false;

  const colorMap: Record<string, string> = { blue: 'blue', green: 'green', red: 'red', yellow: 'yellow' };

  try {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: title },
        template: colorMap[color] || 'blue',
      },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content } },
      ],
    };

    const res = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: settings.feishuChatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      }),
    });
    const data = await res.json();
    if (data.code !== 0) {
      console.error('[feishu] Card send failed:', data.msg || data);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[feishu] Card send error:', err.message);
    return false;
  }
}

// ─── Notifications ───────────────────────────────────────

/** Send a notification (reusable for bell, task complete, etc.) */
export async function notifyFeishu(title: string, body: string, type: 'info' | 'success' | 'error' | 'warning' = 'info'): Promise<void> {
  const colorMap: Record<string, 'blue' | 'green' | 'red' | 'yellow'> = {
    info: 'blue', success: 'green', error: 'red', warning: 'yellow',
  };
  await sendFeishuCard(title, body, colorMap[type]);
}

// ─── Webhook handler (for receiving messages) ────────────

export interface FeishuEvent {
  schema?: string;
  header?: { event_type: string; token: string };
  event?: {
    message?: {
      chat_id?: string;
      message_type?: string;
      content?: string;
    };
    sender?: {
      sender_id?: { open_id?: string; user_id?: string };
    };
  };
  challenge?: string; // URL verification
}

/** Handle incoming webhook event from Feishu */
export async function handleFeishuWebhook(body: FeishuEvent): Promise<{ challenge?: string; ok: boolean }> {
  // URL verification challenge
  if (body.challenge) {
    return { challenge: body.challenge, ok: true };
  }

  const eventType = body.header?.event_type;
  if (eventType !== 'im.message.receive_v1') {
    return { ok: true };
  }

  const msg = body.event?.message;
  if (!msg || msg.message_type !== 'text') return { ok: true };

  let text = '';
  try {
    const content = JSON.parse(msg.content || '{}');
    text = content.text?.trim() || '';
  } catch {
    return { ok: true };
  }

  if (!text) return { ok: true };

  const chatId = msg.chat_id || '';

  // Handle commands
  const [cmd, ...args] = text.split(/\s+/);

  switch (cmd) {
    case '/help':
      await sendFeishuMessage(
        '🤖 Forge\n\n' +
        '🎯 /i — 选择 terminal 并注入文字\n' +
        '/iclear — 清除注入目标\n\n' +
        '📋 /tasks — 任务列表\n' +
        '/projects — 项目列表\n\n' +
        '🌐 /tunnel — 隧道状态',
        chatId,
      );
      break;

    case '/i':
    case '/inject':
      await handleFeishuInject(chatId, args);
      break;

    case '/iclear':
      feishuInjectTarget.delete(chatId);
      await sendFeishuMessage('Inject target cleared.', chatId);
      break;

    case '/tasks': {
      try {
        const { listTasks } = require('./task-manager');
        const tasks = listTasks();
        if (tasks.length === 0) {
          await sendFeishuMessage('No tasks.', chatId);
        } else {
          const lines = tasks.slice(0, 10).map((t: any, i: number) =>
            `${i + 1}. [${t.status}] ${t.projectName}: ${t.prompt.slice(0, 40)}...`
          );
          await sendFeishuMessage(`📋 Tasks:\n${lines.join('\n')}`, chatId);
        }
      } catch {
        await sendFeishuMessage('Failed to load tasks.', chatId);
      }
      break;
    }

    case '/projects': {
      try {
        const { scanProjects } = require('./projects');
        const projects = scanProjects();
        const lines = projects.slice(0, 15).map((p: any, i: number) =>
          `${i + 1}. ${p.name} ${p.hasGit ? '(git)' : ''}`
        );
        await sendFeishuMessage(`📁 Projects:\n${lines.join('\n')}`, chatId);
      } catch {
        await sendFeishuMessage('Failed to load projects.', chatId);
      }
      break;
    }

    case '/tunnel': {
      try {
        const { getTunnelStatus } = require('./cloudflared');
        const status = getTunnelStatus();
        await sendFeishuMessage(
          status.status === 'running' && status.url
            ? `🌐 Tunnel: ${status.url}`
            : `🌐 Tunnel: ${status.status}`,
          chatId,
        );
      } catch {
        await sendFeishuMessage('Tunnel not available.', chatId);
      }
      break;
    }

    default:
      // Plain text — if inject mode, inject to terminal
      if (feishuInjectTarget.has(chatId)) {
        await handleFeishuInjectSend(chatId, text);
      } else {
        await sendFeishuMessage(`Unknown command. Use /help.`, chatId);
      }
  }

  return { ok: true };
}

// ─── Feishu inject ───────────────────────────────────────

const feishuInjectTarget = new Map<string, string>(); // chatId → tmux session
const feishuInjectAutoClear = new Map<string, ReturnType<typeof setTimeout>>();

async function handleFeishuInject(chatId: string, args: string[]) {
  if (args.length === 0) {
    // List sessions
    try {
      const { execSync } = require('node:child_process');
      const out = execSync('tmux list-sessions -F "#{session_name}|#{session_attached}" 2>/dev/null', {
        encoding: 'utf-8', timeout: 3000,
      }).trim();
      if (!out) {
        await sendFeishuMessage('No active tmux sessions.', chatId);
        return;
      }
      const sessions = out.split('\n')
        .map((line: string) => { const [name, attached] = line.split('|'); return { name, attached: attached !== '0' }; })
        .filter((s: { name: string }) => s.name.startsWith('mw'));

      if (sessions.length === 0) {
        await sendFeishuMessage('No active Forge terminals.', chatId);
        return;
      }

      const lines = sessions.slice(0, 15).map((s: { name: string; attached: boolean }, i: number) => {
        const marker = s.attached ? '👁' : '⚫';
        const display = s.name.replace(/^mw-?/, '');
        return `${i + 1}. ${marker} ${display}`;
      });

      // Store mapping
      const sessionMap = new Map<string, string>();
      sessions.forEach((s: { name: string }, i: number) => sessionMap.set(String(i + 1), s.name));
      (feishuInjectTarget as any)._sessionMap = (feishuInjectTarget as any)._sessionMap || new Map();
      (feishuInjectTarget as any)._sessionMap.set(chatId, sessionMap);

      await sendFeishuMessage(`🎯 Pick a terminal:\n\n${lines.join('\n')}\n\nReply /i <num> to select`, chatId);
    } catch (e: any) {
      await sendFeishuMessage(`Error: ${e.message}`, chatId);
    }
    return;
  }

  // /i <num> [text]
  const num = args[0];
  if (/^\d+$/.test(num)) {
    const sessionMap = (feishuInjectTarget as any)?._sessionMap?.get(chatId) as Map<string, string> | undefined;
    const sessionName = sessionMap?.get(num);
    if (!sessionName) {
      await sendFeishuMessage('Invalid number. Use /i to refresh list.', chatId);
      return;
    }
    feishuInjectTarget.set(chatId, sessionName);

    // Auto-clear after 3 min
    const existing = feishuInjectAutoClear.get(chatId);
    if (existing) clearTimeout(existing);
    feishuInjectAutoClear.set(chatId, setTimeout(() => {
      feishuInjectTarget.delete(chatId);
      feishuInjectAutoClear.delete(chatId);
      sendFeishuMessage('⏰ Inject auto-cleared (3 min idle).', chatId).catch(() => {});
    }, 3 * 60 * 1000));

    if (args.length > 1) {
      // /i 1 text — select + send
      await handleFeishuInjectSend(chatId, args.slice(1).join(' '));
    } else {
      await sendFeishuMessage(`🎯 Target: ${sessionName.replace(/^mw-?/, '')}\nSend text → inject + Enter.\n/iclear to cancel.`, chatId);
    }
    return;
  }

  // /i text — use last picked target
  if (feishuInjectTarget.has(chatId)) {
    await handleFeishuInjectSend(chatId, args.join(' '));
  } else {
    await sendFeishuMessage('No target. Use /i to pick one first.', chatId);
  }
}

async function handleFeishuInjectSend(chatId: string, text: string) {
  const sessionName = feishuInjectTarget.get(chatId);
  if (!sessionName || !text.trim()) {
    await sendFeishuMessage('No target or empty text.', chatId);
    return;
  }
  try {
    const { execSync } = require('node:child_process');
    const fs = require('node:fs');
    const os = require('node:os');
    const buf = os.tmpdir() + `/forge-inject-${Date.now()}.txt`;
    fs.writeFileSync(buf, text);
    execSync(`tmux load-buffer -t "${sessionName}" "${buf}" && tmux paste-buffer -t "${sessionName}" && sleep 0.2 && tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 });
    fs.unlinkSync(buf);

    // Reset auto-clear timer
    const existing = feishuInjectAutoClear.get(chatId);
    if (existing) clearTimeout(existing);
    feishuInjectAutoClear.set(chatId, setTimeout(() => {
      feishuInjectTarget.delete(chatId);
      feishuInjectAutoClear.delete(chatId);
      sendFeishuMessage('⏰ Inject auto-cleared (3 min idle).', chatId).catch(() => {});
    }, 3 * 60 * 1000));

    const preview = text.length > 60 ? text.slice(0, 60) + '...' : text;
    await sendFeishuMessage(`✅ Sent to ${sessionName.replace(/^mw-?/, '')}\n> ${preview}`, chatId);
  } catch (e: any) {
    await sendFeishuMessage(`❌ Failed: ${e.message}`, chatId);
    feishuInjectTarget.delete(chatId);
  }
}

// ─── Check if Feishu is configured ───────────────────────

export function isFeishuConfigured(): boolean {
  const settings = loadSettings();
  return !!(settings.feishuAppId && settings.feishuAppSecret && settings.feishuChatId);
}
