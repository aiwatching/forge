import { NextResponse, type NextRequest } from 'next/server';
import { loadSettings } from '@/lib/settings';
import { handleTelegramMessage } from '@/lib/telegram-bot';

// POST /api/telegram — receives messages from telegram-standalone process
export async function POST(req: NextRequest) {
  const settings = loadSettings();

  // Verify the request comes from our standalone process
  const secret = req.headers.get('x-telegram-secret');
  if (!secret || secret !== settings.telegramBotToken) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const message = await req.json();

  try {
    await handleTelegramMessage(message);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
