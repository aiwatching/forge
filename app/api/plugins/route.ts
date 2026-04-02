import { NextResponse } from 'next/server';
import { listPlugins, getPlugin, installPlugin, uninstallPlugin, updatePluginConfig, listInstalledPlugins, getInstalledPlugin } from '@/lib/plugins/registry';
import { executePluginAction } from '@/lib/plugins/executor';

// GET: list plugins or get plugin details
export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  const installed = url.searchParams.get('installed');

  if (id) {
    // Try as plugin definition first, then as installed instance
    const plugin = getPlugin(id);
    const inst = getInstalledPlugin(id);
    if (!plugin && !inst) return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    return NextResponse.json({
      plugin: inst?.definition || plugin,
      installed: !!inst,
      config: inst?.config,
      instanceName: inst?.instanceName,
      source: inst?.source,
    });
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
      const ok = installPlugin(id, config || {}, body.source ? { source: body.source, name: body.name } : undefined);
      return NextResponse.json({ ok });
    }
    case 'create_instance': {
      const { source, name, instanceId } = body;
      if (!source || !name) return NextResponse.json({ error: 'source and name required' }, { status: 400 });
      const iid = instanceId || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      // Check for duplicate ID
      const existing = getInstalledPlugin(iid);
      if (existing) {
        return NextResponse.json({ error: `Instance ID "${iid}" already exists (used by ${existing.instanceName || existing.definition.name}). Choose a different name.` }, { status: 409 });
      }
      const ok = installPlugin(iid, config || {}, { source, name });
      return NextResponse.json({ ok, instanceId: iid });
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
