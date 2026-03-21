/**
 * Logger — adds timestamps + writes to forge.log file.
 * Call `initLogger()` once at startup.
 * Works in both dev mode (terminal + file) and production (file via redirect).
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let initialized = false;

export function initLogger() {
  if (initialized) return;
  initialized = true;

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

  const format = (...args: any[]): string => {
    return args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  };

  console.log = (...args: any[]) => {
    const line = `[${ts()}] ${format(...args)}`;
    origLog(line);
    writeToFile(line);
  };

  console.error = (...args: any[]) => {
    const line = `[${ts()}] [ERROR] ${format(...args)}`;
    origError(line);
    writeToFile(line);
  };

  console.warn = (...args: any[]) => {
    const line = `[${ts()}] [WARN] ${format(...args)}`;
    origWarn(line);
    writeToFile(line);
  };
}
