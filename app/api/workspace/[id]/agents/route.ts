import { NextResponse } from 'next/server';
import { getOrchestrator } from '@/lib/workspace/manager';
import { createDevPipeline } from '@/lib/workspace/presets';
import type { WorkspaceAgentConfig } from '@/lib/workspace';

// Agent operations: run, pause, resume, stop, retry, message, approve
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { action, agentId, config, content, input } = body;

  const orch = getOrchestrator(id);
  if (!orch) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    switch (action) {
      case 'add': {
        if (!config) return NextResponse.json({ error: 'config required' }, { status: 400 });
        try {
          orch.addAgent(config as WorkspaceAgentConfig);
          return NextResponse.json({ ok: true });
        } catch (err: any) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
      }
      case 'create_pipeline': {
        const pipeline = createDevPipeline();
        for (const cfg of pipeline) {
          orch.addAgent(cfg);
        }
        return NextResponse.json({ ok: true, agents: pipeline.length });
      }
      case 'remove': {
        if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
        orch.removeAgent(agentId);
        return NextResponse.json({ ok: true });
      }
      case 'update': {
        if (!agentId || !config) return NextResponse.json({ error: 'agentId and config required' }, { status: 400 });
        try {
          orch.updateAgentConfig(agentId, config as WorkspaceAgentConfig);
          return NextResponse.json({ ok: true });
        } catch (err: any) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
      }
      case 'run': {
        if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
        // Sync validation first (catches dependency errors immediately)
        try { orch.validateCanRun(agentId); } catch (err: any) {
          return NextResponse.json({ error: err.message }, { status: 400 });
        }
        // Fire and forget — execution happens async, events via SSE
        orch.runAgent(agentId, input).catch(err => {
          console.error(`[workspace] runAgent error for ${agentId}:`, err.message);
        });
        return NextResponse.json({ ok: true, status: 'started' });
      }
      case 'run_all': {
        orch.runAll().catch(err => {
          console.error('[workspace] runAll error:', err.message);
        });
        return NextResponse.json({ ok: true, status: 'started' });
      }
      case 'complete_input': {
        if (!agentId || !content) return NextResponse.json({ error: 'agentId and content required' }, { status: 400 });
        orch.completeInput(agentId, content);
        return NextResponse.json({ ok: true });
      }
      case 'pause': {
        if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
        orch.pauseAgent(agentId);
        return NextResponse.json({ ok: true });
      }
      case 'resume': {
        if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
        orch.resumeAgent(agentId);
        return NextResponse.json({ ok: true });
      }
      case 'stop': {
        if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
        orch.stopAgent(agentId);
        return NextResponse.json({ ok: true });
      }
      case 'retry': {
        if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
        orch.retryAgent(agentId).catch(err => console.error(`[workspace] retry error:`, err.message));
        return NextResponse.json({ ok: true, status: 'retrying' });
      }
      case 'set_tmux_session': {
        if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
        const { sessionName } = body;
        orch.setTmuxSession(agentId, sessionName);
        return NextResponse.json({ ok: true });
      }
      case 'reset': {
        if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
        orch.resetAgent(agentId);
        return NextResponse.json({ ok: true });
      }
      case 'open_terminal': {
        if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
        const agentState = orch.getAgentState(agentId);
        const agentConfig = orch.getSnapshot().agents.find(a => a.id === agentId);
        if (!agentState || !agentConfig) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

        // Already manual — skip setManualMode to avoid resetting state
        if (agentState.runMode === 'manual') {
          return NextResponse.json({ ok: true, mode: 'manual', alreadyManual: true });
        }

        // Set manual mode
        orch.setManualMode(agentId);

        // Install forge skills
        const { installForgeSkills } = require('@/lib/workspace/skill-installer');
        const port = parseInt(process.env.PORT || '8403');
        const result = installForgeSkills(orch.projectPath, id, agentId, port);

        return NextResponse.json({
          ok: true,
          mode: 'manual',
          skillsInstalled: result.installed,
          agentId,
          label: agentConfig.label,
        });
      }
      case 'message': {
        if (!agentId || !content) return NextResponse.json({ error: 'agentId and content required' }, { status: 400 });
        orch.sendMessageToAgent(agentId, content);
        return NextResponse.json({ ok: true });
      }
      case 'approve': {
        if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
        orch.approveAgent(agentId);
        return NextResponse.json({ ok: true });
      }
      case 'reject': {
        if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
        orch.rejectApproval(agentId);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Get all agent states
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const orch = getOrchestrator(id);
  if (!orch) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  return NextResponse.json({
    agents: orch.getSnapshot().agents,
    states: orch.getAllAgentStates(),
    busLog: orch.getBusLog(),
  });
}
