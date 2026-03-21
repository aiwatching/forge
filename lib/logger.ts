/**
 * Logger — adds timestamps + writes to forge.log file.
 * Call `initLogger()` once at startup.
 * Works in both dev mode (terminal + file) and production (file via redirect).
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Use globalThis to prevent double-init across forge-server.mjs and init.ts
const loggerKey = Symbol.for('forge-logger-init');

export function initLogger() {
  if ((globalThis as any)[loggerKey]) return;
  (globalThis as any)[loggerKey] = true;

  // Determine log file path
  let logFile: string | null = null;
  try {
    const { getDataDir } = require('./dirs');
    const dataDir = getDataDir();
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    logFile = join(dataDir, 'forge.log');
  } catch {}

  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;

  const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  const writeToFile = (line: string) => {
    if (!logFile) return;
    try { appendFileSync(logFile, line + '\n'); } catch {}
  };

  const SENSITIVE_PATTERNS = [
    /(\d{8,})/g,                                    // session codes (8+ digits)
    /(bot\d+:[A-Za-z0-9_-]{30,})/gi,               // telegram bot tokens
    /(enc:[A-Za-z0-9+/=.]+)/g,                      // encrypted values
    /(sk-ant-[A-Za-z0-9_-]+)/g,                     // anthropic API keys
    /(sk-[A-Za-z0-9]{20,})/g,                       // openai API keys
  ];

  const sanitize = (str: string): string => {
    let result = str;
    for (const pattern of SENSITIVE_PATTERNS) {
      result = result.replace(pattern, (match) => match.slice(0, 4) + '****');
    }
    return result;
  };

  const format = (...args: any[]): string => {
    return args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  };

  console.log = (...args: any[]) => {
    const line = `[${ts()}] ${format(...args)}`;
    origLog(line);
    writeToFile(sanitize(line));
  };

  console.error = (...args: any[]) => {
    const line = `[${ts()}] [ERROR] ${format(...args)}`;
    origError(line);
    writeToFile(sanitize(line));
  };

  console.warn = (...args: any[]) => {
    const line = `[${ts()}] [WARN] ${format(...args)}`;
    origWarn(line);
    writeToFile(sanitize(line));
  };
}
