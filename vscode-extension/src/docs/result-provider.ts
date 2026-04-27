import * as vscode from 'vscode';

/** Read-only TextDocumentContentProvider for `forge-result://` URIs.
 *
 *  Used for ephemeral detail views (pipeline node result, error dumps, etc).
 *  Each click on the same logical thing reuses the same URI → preview-mode
 *  tabs replace each other, no untitled buffer, no save prompt on close.
 *
 *  URI shape: `forge-result:/<key>.md` — `<key>` should encode whatever makes
 *  the document unique (run id + node name, etc). The `.md` suffix lets
 *  VSCode auto-pick the markdown language.
 */
export class ForgeResultProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this._onDidChange.event;
  private contents = new Map<string, string>();

  setContent(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) || '';
  }
}

export const SCHEME = 'forge-result';

export function buildResultUri(key: string): vscode.Uri {
  // Encode key, ensure .md suffix for markdown highlighting.
  return vscode.Uri.parse(`${SCHEME}:/${encodeURIComponent(key)}.md`);
}
