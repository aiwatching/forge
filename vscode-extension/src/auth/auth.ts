import * as vscode from 'vscode';

const SECRET_KEY = 'forge.adminToken';

export class Auth {
  constructor(private secrets: vscode.SecretStorage) {}

  async getToken(): Promise<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  async setToken(token: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, token);
  }

  async clearToken(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }
}
