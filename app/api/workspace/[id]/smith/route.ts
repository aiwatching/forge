import { NextResponse } from 'next/server';
import { getOrchestrator } from '@/lib/workspace/manager';
import { execSync } from 'node:child_process';

/**
 * Smith API — called by Forge skills installed in claude's .claude/skills/
 * These endpoints are designed to be called via curl from within claude terminal.
 */

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const { action, agentId } = body;

  const orch = getOrchestrator(id);
  if (!orch) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  switch (action) {
    case 'done': {
      // Mark agent as done + detect git diff + generate memory
      if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });

      try {
        // Get git diff for memory
        let gitDiff = '';
        try {
          gitDiff = execSync('git diff --stat HEAD', {
            cwd: orch.projectPath,
            encoding: 'utf-8',
            timeout: 5000,
          }).trim();
        } catch {}

        let gitDiffDetail = '';
        try {
          gitDiffDetail = execSync('git diff HEAD --name-only', {
            cwd: orch.projectPath,
            encoding: 'utf-8',
            timeout: 5000,
          }).trim();
        } catch {}

        const changedFiles = gitDiffDetail.split('\n').filter(Boolean);

        // Import memory functions
        const { addObservation, addSessionSummary } = await import('@/lib/workspace/smith-memory');
        const entry = (orch as any).agents?.get(agentId);
        const config = entry?.config;

        if (config && changedFiles.length > 0) {
          await addObservation(id, agentId, config.label, config.role, {
            type: 'change',
            title: `Manual work completed: ${changedFiles.length} files changed`,
            filesModified: changedFiles.slice(0, 10),
            detail: gitDiff.slice(0, 500),
            stepLabel: 'manual',
          });

          await addSessionSummary(id, agentId, {
            request: 'Manual development session',
            investigated: `Worked on ${changedFiles.length} files`,
            learned: '',
            completed: gitDiff.slice(0, 300),
            nextSteps: '',
            filesRead: [],
            filesModified: changedFiles,
          });
        }

        // Parse bus markers from terminal output (if provided)
        const { output } = body;
        let markersSent = 0;
        if (output && typeof output === 'string') {
          const markerRegex = /\[SEND:([^:]+):([^\]]+)\]\s*(.+)/g;
          const snapshot = orch.getSnapshot();
          const labelToId = new Map(snapshot.agents.map(a => [a.label.toLowerCase(), a.id]));
          const seen = new Set<string>();
          let match;
          while ((match = markerRegex.exec(output)) !== null) {
            const targetLabel = match[1].trim();
            const msgAction = match[2].trim();
            const content = match[3].trim();
            const targetId = labelToId.get(targetLabel.toLowerCase());
            if (targetId && targetId !== agentId) {
              const key = `${targetId}:${msgAction}:${content}`;
              if (!seen.has(key)) {
                seen.add(key);
                orch.getBus().send(agentId, targetId, 'notify', { action: msgAction, content });
                markersSent++;
              }
            }
          }
        }

        // Mark agent as done — this triggers downstream
        orch.completeManualAgent(agentId, changedFiles);

        return NextResponse.json({
          ok: true,
          filesChanged: changedFiles.length,
          files: changedFiles.slice(0, 20),
          gitDiff: gitDiff.slice(0, 500),
          markersSent,
        });
      } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
      }
    }

    case 'send': {
      // Send bus message to another agent
      const { to, msgAction, content } = body;
      if (!agentId || !to || !content) {
        return NextResponse.json({ error: 'agentId, to, msgAction, content required' }, { status: 400 });
      }

      // Resolve target agent by label
      const snapshot = orch.getSnapshot();
      const target = snapshot.agents.find(a => a.label.toLowerCase() === to.toLowerCase() || a.id === to);
      if (!target) return NextResponse.json({ error: `Agent "${to}" not found` }, { status: 404 });

      orch.getBus().send(agentId, target.id, 'notify', {
        action: msgAction || 'agent_message',
        content,
      });

      return NextResponse.json({ ok: true, sentTo: target.label });
    }

    case 'inbox': {
      // Get bus messages for this agent
      if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });

      const messages = orch.getBus().getMessagesFor(agentId)
        .filter(m => m.type !== 'ack')
        .slice(-20)
        .map(m => ({
          from: (orch.getSnapshot().agents.find(a => a.id === m.from)?.label || m.from),
          action: m.payload.action,
          content: m.payload.content,
          time: new Date(m.timestamp).toLocaleTimeString(),
        }));

      return NextResponse.json({ messages });
    }

    case 'status': {
      // Get all agent statuses
      const snapshot = orch.getSnapshot();
      const states = orch.getAllAgentStates();
      const agents = snapshot.agents.map(a => ({
        id: a.id,
        label: a.label,
        icon: a.icon,
        type: a.type,
        status: states[a.id]?.status || 'idle',
        currentStep: states[a.id]?.currentStep,
      }));

      return NextResponse.json({ agents });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
