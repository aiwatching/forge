import { NextResponse } from 'next/server';
import { loadSettings } from '@/lib/settings';
import { addNotification } from '@/lib/notifications';

export async function POST(req: Request) {
  const { tabLabel, source } = await req.json();
  const label = tabLabel || 'Terminal';

  // Check settings — terminal bell can be disabled (but workspace smith bells always go through)
  const settings = loadSettings();
  if ((settings as any).terminalBellEnabled === false && source !== 'workspace') {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // In-app notification
  try {
    addNotification('terminal_bell', `Terminal idle: ${label}`, `Claude appears to have finished in "${label}".`);
  } catch {}

  // Telegram notification
  const { telegramBotToken, telegramChatId } = settings;
  if (telegramBotToken && telegramChatId) {
    try {
      const chatIds = String(telegramChatId).split(',').map(s => s.trim()).filter(Boolean);
      for (const chatId of chatIds) {
        await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: `🔔 Forge — Terminal idle\n\n"${label}" appears to have finished.`,
          }),
        });
      }
    } catch {}
  }

  return NextResponse.json({ ok: true });
}
