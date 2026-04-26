import * as vscode from 'vscode';

const KEY_PREFIX = 'forge.token.';
const LEGACY_KEY = 'forge.adminToken';

/** Per-connection token storage backed by VSCode SecretStorage. */
export class Auth {
  constructor(private secrets: vscode.SecretStorage) {}

  async getToken(connectionName: string): Promise<string | undefined> {
    return this.secrets.get(KEY_PREFIX + connectionName);
  }

  async setToken(connectionName: string, token: string): Promise<void> {
    await this.secrets.store(KEY_PREFIX + connectionName, token);
  }

  async clearToken(connectionName: string): Promise<void> {
    await this.secrets.delete(KEY_PREFIX + connectionName);
  }

  /** One-shot migration of the legacy single-token storage to the new
   *  per-connection key. Run on extension activation. */
  async migrateLegacy(defaultName: string): Promise<void> {
    const legacy = await this.secrets.get(LEGACY_KEY);
    if (!legacy) return;
    if (!(await this.getToken(defaultName))) {
      await this.setToken(defaultName, legacy);
    }
    await this.secrets.delete(LEGACY_KEY);
  }
}
