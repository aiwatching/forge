/**
 * Password management.
 *
 * - Admin password: set in Settings, encrypted in settings.yaml
 *   Used for: local login, tunnel start, secret changes, Telegram commands
 * - Session code: random 8-digit numeric, generated each time tunnel starts
 *   Used for: remote login 2FA (admin password + session code)
 *
 * Local login: admin password only
 * Remote login (tunnel): admin password + session code
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomInt } from 'node:crypto';
import { getDataDir } from './dirs';

const DATA_DIR = getDataDir();
const SESSION_CODE_FILE = join(DATA_DIR, 'session-code.json');

/** Generate a random 8-digit numeric code */
function generateSessionCode(): string {
  return String(randomInt(10000000, 99999999));
}

function readSessionCode(): string {
  try {
    if (!existsSync(SESSION_CODE_FILE)) return '';
    const data = JSON.parse(readFileSync(SESSION_CODE_FILE, 'utf-8'));
    return data?.code || '';
  } catch {
    return '';
  }
}

function saveSessionCode(code: string) {
  const dir = dirname(SESSION_CODE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SESSION_CODE_FILE, JSON.stringify({ code }), { mode: 0o600 });
}

/** Get the admin password from settings */
export function getAdminPassword(): string {
  try {
    const { loadSettings } = require('./settings');
    const settings = loadSettings();
    return settings.telegramTunnelPassword || '';
  } catch {
    return '';
  }
}

/** Get current session code (empty if none) */
export function getSessionCode(): string {
  return readSessionCode();
}

/** Generate new session code. Called on tunnel start. */
export function rotateSessionCode(): string {
  const code = generateSessionCode();
  saveSessionCode(code);
  console.log(`[password] New session code: ${code}`);
  return code;
}

/**
 * Verify login credentials.
 * @param password - admin password
 * @param sessionCode - session code (required for remote, empty for local)
 * @param isRemote - true if accessing via tunnel
 */
export function verifyLogin(password: string, sessionCode?: string, isRemote?: boolean): boolean {
  if (!password) return false;

  const admin = getAdminPassword();
  if (!admin) return false;
  if (password !== admin) return false;

  // Remote access requires session code as 2FA
  if (isRemote) {
    const currentCode = readSessionCode();
    if (!currentCode || sessionCode !== currentCode) return false;
  }

  return true;
}

/**
 * Verify admin password for privileged operations
 * (tunnel start, secret changes, Telegram commands).
 */
export function verifyAdmin(input: string): boolean {
  if (!input) return false;
  const admin = getAdminPassword();
  return admin ? input === admin : false;
}

