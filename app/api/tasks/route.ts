import { NextResponse } from 'next/server';
import { createTask, listTasks } from '@/lib/task-manager';
import { ensureInitialized } from '@/lib/init';
import { getProjectInfo } from '@/lib/projects';
import type { TaskStatus } from '@/src/types';

// List tasks — optionally filter by status
export async function GET(req: Request) {
  ensureInitialized();
  const url = new URL(req.url);
  const status = url.searchParams.get('status') as TaskStatus | null;
  return NextResponse.json(listTasks(status || undefined));
}

// Create a new task
export async function POST(req: Request) {
  const { projectName, prompt, priority, newSession, conversationId, scheduledAt, mode, watchConfig, agent } = await req.json();

  if (!projectName || !prompt) {
    return NextResponse.json({ error: 'projectName and prompt are required' }, { status: 400 });
  }

  const project = getProjectInfo(projectName);
  if (!project) {
    return NextResponse.json({ error: `Project not found: ${projectName}` }, { status: 404 });
  }

  // conversationId: explicit value → use it; newSession → empty string (force new); otherwise → auto-inherit
  const convId = conversationId || (newSession ? '' : undefined);

  const task = createTask({
    projectName: project.name,
    projectPath: project.path,
    prompt,
    priority: priority || 0,
    conversationId: convId,
    scheduledAt: scheduledAt || undefined,
    mode: mode || 'prompt',
    watchConfig: watchConfig || undefined,
    agent: agent || undefined,
  });

  return NextResponse.json(task);
}
