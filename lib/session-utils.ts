/**
 * Shared session utilities for client-side components.
 * Resolves fixedSessionId from project-level binding.
 */

/** Fetch the fixedSessionId for a project. Returns null if not set. */
export async function resolveFixedSession(projectPath: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/project-sessions?projectPath=${encodeURIComponent(projectPath)}`);
    const data = await res.json();
    return data?.fixedSessionId || null;
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
