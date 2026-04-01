import { NextResponse } from 'next/server';
import { listPlugins, getPlugin, installPlugin, uninstallPlugin, updatePluginConfig, listInstalledPlugins, getInstalledPlugin } from '@/lib/plugins/registry';
import { executePluginAction } from '@/lib/plugins/executor';

// GET: list plugins or get plugin details
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const installed = url.searchParams.get('installed');

  if (id) {
    const plugin = getPlugin(id);
    if (!plugin) return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    const inst = getInstalledPlugin(id);
    return NextResponse.json({ plugin, installed: !!inst, config: inst?.config });
  }

  if (installed === 'true') {
    return NextResponse.json({ plugins: listInstalledPlugins() });
  }

  return NextResponse.json({ plugins: listPlugins() });
}

// POST: install, uninstall, update config, or test a plugin action
export async function POST(req: Request) {
  const body = await req.json();
  const { action, id, config, actionName, params } = body;

  switch (action) {
    case 'install': {
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
      const ok = installPlugin(id, config || {});
      return NextResponse.json({ ok });
    }
    case 'uninstall': {
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
      const ok = uninstallPlugin(id);
      return NextResponse.json({ ok });
    }
    case 'update_config': {
      if (!id || !config) return NextResponse.json({ error: 'id and config required' }, { status: 400 });
      const ok = updatePluginConfig(id, config);
      return NextResponse.json({ ok });
    }
    case 'test': {
      // Test-run a plugin action
      if (!id || !actionName) return NextResponse.json({ error: 'id and actionName required' }, { status: 400 });
      const inst = getInstalledPlugin(id);
      if (!inst) return NextResponse.json({ error: 'Plugin not installed' }, { status: 400 });
      const result = await executePluginAction(inst, actionName, params || {});
      return NextResponse.json(result);
    }
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
}
