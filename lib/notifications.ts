/**
 * In-app notification system.
 * Stores notifications in SQLite, auto-cleans based on retention setting.
 */

import { getDb } from '@/src/core/db/database';
import { getDbPath } from '@/src/config';
import { loadSettings } from './settings';

export interface Notification {
  id: number;
  type: string;     // 'task_done' | 'task_failed' | 'pipeline_done' | 'pipeline_failed' | 'tunnel' | 'system'
  title: string;
  body: string | null;
  read: boolean;
  taskId: string | null;
  createdAt: string;
}

function db() {
  return getDb(getDbPath());
}

/** Add a notification */
export function addNotification(type: string, title: string, body?: string, taskId?: string) {
  db().prepare(
    'INSERT INTO notifications (type, title, body, task_id) VALUES (?, ?, ?, ?)'
  ).run(type, title, body || null, taskId || null);
}

/** Get recent notifications (newest first) */
export function getNotifications(limit = 50, offset = 0): Notification[] {
  const rows = db().prepare(
    'SELECT * FROM notifications ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset) as any[];
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    read: !!r.read,
    taskId: r.task_id,
    createdAt: r.created_at ? (r.created_at.endsWith('Z') ? r.created_at : r.created_at.replace(' ', 'T') + 'Z') : r.created_at,
  }));
}

/** Count unread notifications */
export function getUnreadCount(): number {
  const row = db().prepare('SELECT COUNT(*) as count FROM notifications WHERE read = 0').get() as any;
  return row?.count || 0;
}

/** Mark one as read */
export function markRead(id: number) {
  db().prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
}

/** Mark all as read */
export function markAllRead() {
  db().prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
}

/** Delete one notification */
export function deleteNotification(id: number) {
  db().prepare('DELETE FROM notifications WHERE id = ?').run(id);
}

/** Clean up old notifications based on retention setting */
export function cleanupNotifications() {
  const settings = loadSettings();
  const days = settings.notificationRetentionDays || 30;
  db().prepare(
    `DELETE FROM notifications WHERE created_at < datetime('now', '-' || ? || ' days')`
  ).run(days);
}
