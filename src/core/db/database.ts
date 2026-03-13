import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db: Database.Database | null = null;

export function getDb(dbPath: string): Database.Database {
  if (db) return db;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(db: Database.Database) {
  // Migrations for existing tables
  try { db.exec('ALTER TABLE tasks ADD COLUMN scheduled_at TEXT'); } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      template_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      memory_config TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      token_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      session_id TEXT REFERENCES sessions(id),
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage(provider, created_at);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      priority INTEGER NOT NULL DEFAULT 0,
      conversation_id TEXT,
      log TEXT NOT NULL DEFAULT '[]',
      result_summary TEXT,
      git_diff TEXT,
      git_branch TEXT,
      cost_usd REAL,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      scheduled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, created_at);

    -- Cached Claude CLI sessions for tree view
    CREATE TABLE IF NOT EXISTS cached_sessions (
      project_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      summary TEXT,
      first_prompt TEXT,
      message_count INTEGER DEFAULT 0,
      entry_count INTEGER DEFAULT 0,
      created TEXT,
      modified TEXT,
      git_branch TEXT,
      file_size INTEGER DEFAULT 0,
      last_synced TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_name, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cached_sessions_project ON cached_sessions(project_name, modified);

    -- Session watchers — monitor sessions and notify via Telegram
    CREATE TABLE IF NOT EXISTS session_watchers (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      session_id TEXT,
      label TEXT,
      check_interval INTEGER NOT NULL DEFAULT 60,
      last_entry_count INTEGER DEFAULT 0,
      last_checked TEXT,
      notify_on_change INTEGER NOT NULL DEFAULT 1,
      notify_on_idle INTEGER NOT NULL DEFAULT 1,
      idle_threshold INTEGER NOT NULL DEFAULT 300,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
