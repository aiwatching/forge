import * as vscode from 'vscode';

export type DocsTransport = 'local' | 'http';

/** Detect whether forge is reachable as the local filesystem (we can use
 *  `vscode.Uri.file(absPath)`) or only over the wire (we must go through
 *  the forge-docs:// FileSystemProvider). */
export function detectDocsTransport(): DocsTransport {
  const cfg = vscode.workspace.getConfiguration('forge');
  const setting = cfg.get<string>('docs.transport', 'auto');
  if (setting === 'local') return 'local';
  if (setting === 'http') return 'http';
  // Auto: localhost / 127.0.0.1 / [::1] → local, else http
  const serverUrl = cfg.get<string>('serverUrl', 'http://localhost:8403');
  try {
    const u = new URL(serverUrl);
    const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
    return local ? 'local' : 'http';
  } catch {
    return 'http';
  }
}
