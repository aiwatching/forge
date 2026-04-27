import * as vscode from 'vscode';
import { join } from 'node:path';
import { ForgeClient } from '../api/client';
import { ForgePty } from '../terminal/pseudoterm';
import { buildDocUri } from '../docs/fs-provider';
import { detectDocsTransport } from '../docs/transport';

/** Open a doc file. In local mode, hand VSCode the on-disk path so it's
 *  treated as a regular file. In remote (http) mode, use the forge-docs://
 *  FileSystemProvider so reads/writes go through forge's HTTP API. */
export async function openDocCommand(
  _client: ForgeClient,
  arg?: { rootIdx: number; rootPath?: string; path: string; fileType?: string; name?: string },
): Promise<void> {
  if (!arg?.path) return;
  const transport = detectDocsTransport();

  let uri: vscode.Uri;
  if (transport === 'local' && arg.rootPath) {
    uri = vscode.Uri.file(join(arg.rootPath, arg.path));
  } else {
    uri = buildDocUri(arg.rootIdx, arg.path);
  }

  await vscode.commands.executeCommand('vscode.open', uri);
}

/** Open a forge terminal cd'd into a directory — the docRoot or any subdir.
 *  Always goes through the forge terminal WebSocket, so works for remote
 *  forges too (tmux runs on the forge host, not the local VSCode machine). */
export async function openDocsTerminalCommand(client: ForgeClient, arg?: { rootIdx?: number; rootPath?: string; rootName?: string; path?: string }): Promise<void> {
  if (!arg?.rootPath) return;
  // For sub-dirs, use rootPath joined with the relative `path`.
  const cwd = arg.path ? `${arg.rootPath}/${arg.path}` : arg.rootPath;
  const terminalLabel = arg.path ? `${arg.rootName || 'docs'}/${arg.path.split('/').pop()}` : (arg.rootName || 'docs');
  const launchCommand = `cd "${cwd}" && claude --dangerously-skip-permissions`;
  const pty = new ForgePty({ url: client.terminalUrl, cwd, launchCommand });
  const term = vscode.window.createTerminal({ name: `forge: ${terminalLabel}`, pty });
  term.show();
}
