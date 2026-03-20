/**
 * Encryption utilities for storing secrets in settings.yaml
 * Uses AES-256-GCM with a persistent key stored in <dataDir>/.encrypt-key
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { getDataDir } from './dirs';

const KEY_FILE = join(getDataDir(), '.encrypt-key');
const PREFIX = 'enc:';

function getEncryptionKey(): Buffer {
  if (existsSync(KEY_FILE)) {
    return Buffer.from(readFileSync(KEY_FILE, 'utf-8').trim(), 'hex');
  }
  // Generate a new 32-byte key
  const key = randomBytes(32);
  const dir = dirname(KEY_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
  return key;
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: enc:<iv>:<tag>:<ciphertext> (all base64)
  return `${PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptSecret(value: string): string {
  if (!value || !isEncrypted(value)) return value;
  try {
    const payload = value.slice(PREFIX.length);
    const [ivB64, tagB64, dataB64] = payload.split('.');
    const key = getEncryptionKey();
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  } catch {
    // If decryption fails (key changed, corrupted), return empty
    return '';
  }
}

export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Hash a secret for comparison without exposing plaintext */
export function hashSecret(value: string): string {
  if (!value) return '';
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Secret field names in settings */
export const SECRET_FIELDS = ['telegramBotToken', 'telegramTunnelPassword'] as const;
export type SecretField = typeof SECRET_FIELDS[number];
