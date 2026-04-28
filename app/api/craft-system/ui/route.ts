import { NextResponse } from 'next/server';
import { getCraft } from '@/lib/crafts/loader';
import { transpileUi } from '@/lib/crafts/runtime';

// GET /api/crafts/_ui?projectPath=...&name=... → returns transpiled JS module
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectPath = url.searchParams.get('projectPath');
  const name = url.searchParams.get('name');
  if (!projectPath || !name) return new NextResponse('projectPath + name required', { status: 400 });

  const craft = getCraft(projectPath, name);
  if (!craft) return new NextResponse('craft not found', { status: 404 });
  if (!craft.hasUi) return new NextResponse('craft has no UI', { status: 404 });

  try {
    const code = await transpileUi(craft);
    return new NextResponse(code, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (e: any) {
    return new NextResponse(`/* craft transpile error */\nconsole.error(${JSON.stringify('Craft ' + name + ' transpile failed: ' + (e?.message || String(e)))});\nexport default function ErrorTab() { return null; }`, {
      status: 200,
      headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
    });
  }
}
