/**
 * Auto-generated login password.
 * Rotates daily. Saved to ~/.forge/password.json with date.
 * CLI can read it via `forge password`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const PASSWORD_FILE = join(homedir(), '.forge', 'password.json');

function generatePassword(): string {
  // 8-char alphanumeric, easy to type
  return randomBytes(6).toString('base64url').slice(0, 8);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

interface PasswordData {
  password: string;
  date: string;
}

function readPasswordData(): PasswordData | null {
  try {
    if (!existsSync(PASSWORD_FILE)) return null;
    return JSON.parse(readFileSync(PASSWORD_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function savePasswordData(data: PasswordData) {
  const dir = dirname(PASSWORD_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PASSWORD_FILE, JSON.stringify(data), { mode: 0o600 });
}

/**
 * Get the current password. Priority:
 * 1. MW_PASSWORD env var (user explicitly set, never rotates)
 * 2. Saved password file if still valid today
 * 3. Generate new one, save with today's date
 */
export function getPassword(): string {
  // If user explicitly set MW_PASSWORD, use it (no rotation)
  if (process.env.MW_PASSWORD && process.env.MW_PASSWORD !== 'auto') {
    return process.env.MW_PASSWORD;
  }

  const today = todayStr();
  const saved = readPasswordData();

  // Valid for today
  if (saved && saved.date === today && saved.password) {
    return saved.password;
  }

  // Expired or missing — generate new
  const password = generatePassword();
  savePasswordData({ password, date: today });
  console.log(`[password] New daily password generated for ${today}`);
  return password;
}

/** Read password from file (for CLI use) */
export function readPasswordFile(): string | null {
  const data = readPasswordData();
  if (!data) return null;
  // Only return if still valid today
  if (data.date !== todayStr()) return null;
  return data.password;
}
