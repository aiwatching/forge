import { NextResponse } from 'next/server';
import { loadSettings, loadSettingsMasked, saveSettings, type Settings } from '@/lib/settings';
import { restartTelegramBot } from '@/lib/init';
import { SECRET_FIELDS } from '@/lib/crypto';

export async function GET() {
  return NextResponse.json(loadSettingsMasked());
}

export async function PUT(req: Request) {
  const body = await req.json();

  // Handle secret field updates separately
  if (body._secretUpdate) {
    const { field, oldValue, newValue } = body._secretUpdate as {
      field: string;
      oldValue: string;
      newValue: string;
    };

    // Validate field name
    if (!SECRET_FIELDS.includes(field as any)) {
      return NextResponse.json({ ok: false, error: 'Invalid field' }, { status: 400 });
    }

    // Load current settings
    const current = loadSettings();
    const currentValue = (current as any)[field] || '';

    // If field has a value, verify old password
    if (currentValue && currentValue !== oldValue) {
      return NextResponse.json({ ok: false, error: 'Old value does not match' }, { status: 403 });
    }

    // Update the specific field
    (current as any)[field] = newValue;
    saveSettings(current);

    // Restart Telegram bot if token changed
    if (field === 'telegramBotToken') {
      restartTelegramBot();
    }

    return NextResponse.json({ ok: true });
  }

  // Normal settings update — strip masked secrets so we don't overwrite with placeholder
  const settings = loadSettings();
  const updated = body as Settings;

  for (const field of SECRET_FIELDS) {
    // Keep existing encrypted value if frontend sent masked placeholder
    if (updated[field] === '••••••••' || updated[field] === '') {
      updated[field] = settings[field];
    }
  }

  // Remove internal fields
  delete (updated as any)._secretStatus;

  saveSettings(updated);
  restartTelegramBot();
  return NextResponse.json({ ok: true });
}
