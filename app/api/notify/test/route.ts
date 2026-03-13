import { NextResponse } from 'next/server';
import { loadSettings } from '@/lib/settings';

export async function POST() {
  const settings = loadSettings();
  const { telegramBotToken, telegramChatId } = settings;

  if (!telegramBotToken || !telegramChatId) {
    return NextResponse.json({ ok: false, error: 'Telegram bot token or chat ID not configured' });
  }

  try {
    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: '✅ *Forge* — Test notification!\n\nTelegram notifications are working.',
        parse_mode: 'Markdown',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json({ ok: false, error: body });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message });
  }
}
