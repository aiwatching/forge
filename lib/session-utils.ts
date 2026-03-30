/**
 * Shared session utilities for client-side components.
 * Resolves fixedSessionId from project-level binding.
 */

/** Fetch the fixedSessionId for a project. If not set, auto-binds the latest session. */
export async function resolveFixedSession(projectPath: string): Promise<string | null> {
  try {
    // Check existing binding
    const res = await fetch(`/api/project-sessions?projectPath=${encodeURIComponent(projectPath)}`);
    const data = await res.json();
    if (data?.fixedSessionId) return data.fixedSessionId;

    // Not set — find latest session and auto-bind
    const projectName = projectPath.replace(/\/+$/, '').split('/').pop() || '';
    const sessRes = await fetch(`/api/claude-sessions/${encodeURIComponent(projectName)}`);
    const sessions = await sessRes.json();
    if (!Array.isArray(sessions) || sessions.length === 0) return null;

    const latestId = sessions[0].sessionId || sessions[0].id;
    if (!latestId) return null;

    // Save binding
    await fetch('/api/project-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectPath, fixedSessionId: latestId }),
    });

    return latestId;
  } catch {
    return null;
  }
}

/** Build the resume flag: --resume <id> if fixedSession exists, else -c if hasSession */
export function buildResumeFlag(fixedSessionId: string | null, hasExistingSessions: boolean): string {
  if (fixedSessionId) return ` --resume ${fixedSessionId}`;
  if (hasExistingSessions) return ' -c';
  return '';
}
