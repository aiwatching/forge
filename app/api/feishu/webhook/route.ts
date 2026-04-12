import { NextResponse } from 'next/server';
import { handleFeishuWebhook, type FeishuEvent } from '@/lib/feishu-bot';

/**
 * POST /api/feishu/webhook
 * Feishu Event Subscription endpoint.
 * Set this URL in Feishu app console → Event Subscriptions → Request URL.
 */
export async function POST(req: Request) {
  try {
    const body: FeishuEvent = await req.json();

    // URL verification (Feishu sends this once when configuring webhook)
    if (body.challenge) {
      return NextResponse.json({ challenge: body.challenge });
    }

    const result = await handleFeishuWebhook(body);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[feishu webhook] Error:', err.message);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
