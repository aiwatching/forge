#!/usr/bin/env -S npx tsx
/**
 * Standalone Telegram bot process.
 * Runs as a single process — no duplication from Next.js workers.
 */

import { loadSettings } from './settings';

const settings = loadSettings();
if (!settings.telegramBotToken || !settings.telegramChatId) {
  console.log('[telegram] No token or chatId configured, exiting');
  process.exit(0);
}

const TOKEN = settings.telegramBotToken;
const ALLOWED_IDS = settings.telegramChatId.split(',').map(s => s.trim()).filter(Boolean);
let lastUpdateId = 0;
let polling = true;
const processedMsgIds = new Set<number>();

// Skip stale messages on startup
async function init() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1`);
    const data = await res.json();
    if (data.ok && data.result?.length > 0) {
      lastUpdateId = data.result[data.result.length - 1].update_id;
    }
  } catch {}
  console.log('[telegram] Bot started (standalone)');
  poll();
}

async function poll() {
  if (!polling) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);

    const res = await fetch(
      `https://api.telegram.org/bot${TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    const data = await res.json();
    if (data.ok && data.result) {
      for (const update of data.result) {
        if (update.update_id <= lastUpdateId) continue;
        lastUpdateId = update.update_id;

        if (update.message?.text) {
          const msgId = update.message.message_id;
          if (processedMsgIds.has(msgId)) continue;
          processedMsgIds.add(msgId);
          if (processedMsgIds.size > 200) {
            const oldest = [...processedMsgIds].slice(0, 100);
            oldest.forEach(id => processedMsgIds.delete(id));
          }

          // Forward to Next.js API for processing
          try {
            await fetch(`http://localhost:${process.env.PORT || 8403}/api/telegram`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-telegram-secret': TOKEN },
              body: JSON.stringify(update.message),
            });
          } catch {}
        }
      }
    }
  } catch {
    // Network error — silent retry
  }

  setTimeout(poll, 1000);
}

process.on('SIGTERM', () => { polling = false; process.exit(0); });
process.on('SIGINT', () => { polling = false; process.exit(0); });

init();
