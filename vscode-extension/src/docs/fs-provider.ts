import * as vscode from 'vscode';
import { ForgeClient } from '../api/client';

/**
 * `forge-docs://` URIs map to forge's HTTP API for read/write — used in
 * remote-forge mode where the doc files live on a different machine.
 *
 *   GET  /api/docs?root=<N>&file=<path>  (text)
 *   GET  /api/docs?root=<N>&image=<path> (binary)
 *   PUT  /api/docs                       (write)
 *
 * VSCode treats files opened via this scheme as real files: the editor tab
 * shows the actual filename, Cmd+S saves through writeFile, all editor
 * features work.
 */
export class ForgeDocsFs implements vscode.FileSystemProvider {
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  onDidChangeFile = this._emitter.event;

  constructor(private client: ForgeClient) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { path } = parseDocUri(uri);
    if (!path) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    return { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: 0 };
  }

  async readDirectory(): Promise<[string, vscode.FileType][]> { return []; }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions(); }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { rootIdx, path } = parseDocUri(uri);
    if (isImagePath(path)) {
      const bytes = await fetchImageBytes(this.client, rootIdx, path);
      if (!bytes) throw vscode.FileSystemError.FileNotFound(uri);
      return bytes;
    }
    const r = await this.client.request<any>(`/api/docs?root=${rootIdx}&file=${encodeURIComponent(path)}`);
    if (!r.ok) throw vscode.FileSystemError.FileNotFound(uri);
    if (r.data?.tooLarge) throw vscode.FileSystemError.NoPermissions('File too large');
    if (r.data?.binary) throw vscode.FileSystemError.NoPermissions(`Binary ${r.data.fileType} file`);
    return Buffer.from(r.data?.content || '', 'utf-8');
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { rootIdx, path } = parseDocUri(uri);
    const text = Buffer.from(content).toString('utf-8');
    const r = await this.client.request('/api/docs', {
      method: 'PUT',
      body: JSON.stringify({ root: rootIdx, file: path, content: text }),
    });
    if (!r.ok) {
      vscode.window.showErrorMessage(`Forge: failed to save ${path} — ${r.error}`);
      throw vscode.FileSystemError.NoPermissions(`Save failed: ${r.error}`);
    }
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(): void { throw vscode.FileSystemError.NoPermissions(); }
  rename(): void { throw vscode.FileSystemError.NoPermissions(); }
}

export function buildDocUri(rootIdx: number, path: string): vscode.Uri {
  return vscode.Uri.parse(`forge-docs:/${rootIdx}/${path.split('/').map(encodeURIComponent).join('/')}`);
}

function parseDocUri(uri: vscode.Uri): { rootIdx: number; path: string } {
  const segments = uri.path.split('/').filter(Boolean);
  const rootIdx = parseInt(segments[0] || '0', 10) || 0;
  const path = segments.slice(1).map(decodeURIComponent).join('/');
  return { rootIdx, path };
}

function isImagePath(path: string): boolean {
  const ext = path.toLowerCase().split('.').pop() || '';
  return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'].includes(ext);
}

async function fetchImageBytes(client: ForgeClient, rootIdx: number, path: string): Promise<Uint8Array | null> {
  const token = await client.getToken();
  const headers: Record<string, string> = {};
  if (token) headers['X-Forge-Token'] = token;
  try {
    const res = await fetch(`${client.baseUrlPublic}/api/docs?root=${rootIdx}&image=${encodeURIComponent(path)}`, { headers });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}
