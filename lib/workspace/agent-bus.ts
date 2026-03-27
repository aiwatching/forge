/**
 * Agent Bus — reliable one-to-one message delivery for workspace agents.
 *
 * Features:
 * - One-to-one delivery (no broadcast)
 * - ACK confirmation from receiver
 * - 30-second retry on no ACK (max 3 retries)
 * - Message dedup by ID
 * - Outbox for messages to down/unavailable agents
 * - Inbox persistence per agent
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { BusMessage, AgentLiveness } from './types';

const ACK_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

export class AgentBus extends EventEmitter {
  private log: BusMessage[] = [];
  private seen = new Set<string>();                                    // dedup: message IDs already processed
  private outbox = new Map<string, BusMessage[]>();                    // agentId → undelivered messages
  private pendingAcks = new Map<string, { timer: NodeJS.Timeout; msg: BusMessage; retries: number }>();
  private pendingRequests = new Map<string, { resolve: (msg: BusMessage) => void; timer: NodeJS.Timeout }>();
  private agentStatus = new Map<string, AgentLiveness>();

  // ─── Agent status tracking ─────────────────────────────

  setAgentStatus(agentId: string, status: AgentLiveness): void {
    const prev = this.agentStatus.get(agentId);
    this.agentStatus.set(agentId, status);

    // If agent came back alive, flush its outbox
    if (status === 'alive' && prev === 'down') {
      this.flushOutbox(agentId);
    }
  }

  getAgentStatus(agentId: string): AgentLiveness {
    return this.agentStatus.get(agentId) || 'down';
  }

  // ─── Send (one-to-one, reliable) ──────────────────────

  send(from: string, to: string, type: BusMessage['type'], payload: BusMessage['payload']): BusMessage {
    const msg: BusMessage = {
      id: randomUUID(),
      from, to, type, payload,
      timestamp: Date.now(),
      status: 'pending',
      retries: 0,
    };

    this.log.push(msg);
    this.emit('message', msg);

    // ACK messages don't need delivery tracking
    if (type === 'ack') {
      this.handleAck(msg);
      return msg;
    }

    // Check if target is available
    const targetStatus = this.getAgentStatus(to);
    if (targetStatus === 'down') {
      // Store in outbox, deliver when agent comes back
      this.addToOutbox(to, msg);
      return msg;
    }

    // No ACK timer — in same-process architecture, messages are handled synchronously
    // Status is managed directly by orchestrator (pending → acked/failed)

    // Check if this resolves a pending request
    if (type === 'response' && payload.replyTo) {
      const pending = this.pendingRequests.get(payload.replyTo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(payload.replyTo);
        pending.resolve(msg);
      }
    }

    return msg;
  }

  /** Convenience: send ACK back to original sender */
  ack(receiverId: string, senderId: string, messageId: string): void {
    this.send(receiverId, senderId, 'ack', { action: 'ack', replyTo: messageId });
  }

  // ─── Request-Response ──────────────────────────────────

  request(from: string, to: string, payload: BusMessage['payload'], timeoutMs = 300_000): Promise<BusMessage> {
    const msg = this.send(from, to, 'request', payload);

    return new Promise<BusMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(msg.id);
        reject(new Error(`Bus request timed out: ${payload.action}`));
      }, timeoutMs);

      this.pendingRequests.set(msg.id, { resolve, timer });
    });
  }

  // ─── Convenience methods ───────────────────────────────

  notifyTaskComplete(agentId: string, files: string[], summary?: string): void {
    // Only notify agents that depend on this one — caller handles routing
    this.log.push({
      id: randomUUID(),
      from: agentId, to: '_system', type: 'notify',
      payload: { action: 'task_complete', content: summary, files },
      timestamp: Date.now(),
      status: 'done',
    });
    this.emit('message', this.log[this.log.length - 1]);
  }

  notifyStepComplete(agentId: string, stepLabel: string, files?: string[]): void {
    this.log.push({
      id: randomUUID(),
      from: agentId, to: '_system', type: 'notify',
      payload: { action: 'step_complete', content: `Step "${stepLabel}" completed`, files },
      timestamp: Date.now(),
      status: 'done',
    });
    this.emit('message', this.log[this.log.length - 1]);
  }

  notifyError(agentId: string, error: string): void {
    this.log.push({
      id: randomUUID(),
      from: agentId, to: '_system', type: 'notify',
      payload: { action: 'error', content: error },
      timestamp: Date.now(),
      status: 'done',
    });
    this.emit('message', this.log[this.log.length - 1]);
  }

  // ─── ACK handling ──────────────────────────────────────

  private handleAck(ackMsg: BusMessage): void {
    const originalId = ackMsg.payload.replyTo;
    if (!originalId) return;

    const pending = this.pendingAcks.get(originalId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingAcks.delete(originalId);
      pending.msg.status = 'done';
    }
  }

  private startAckTimer(msg: BusMessage): void {
    const timer = setTimeout(() => {
      this.retryAckTimeout(msg);
    }, ACK_TIMEOUT_MS);

    this.pendingAcks.set(msg.id, { timer, msg, retries: 0 });
  }

  private retryAckTimeout(msg: BusMessage): void {
    const pending = this.pendingAcks.get(msg.id);
    if (!pending) return;

    pending.retries++;
    msg.retries = pending.retries;

    if (pending.retries >= MAX_RETRIES) {
      // Give up — mark as failed
      this.pendingAcks.delete(msg.id);
      msg.status = 'failed';
      console.log(`[bus] Message to ${msg.to} failed after ${MAX_RETRIES} retries: ${msg.payload.action}`);
      return;
    }

    console.log(`[bus] Retrying message to ${msg.to} (attempt ${pending.retries + 1}): ${msg.payload.action}`);

    // Check if target is still available
    if (this.getAgentStatus(msg.to) === 'down') {
      this.pendingAcks.delete(msg.id);
      this.addToOutbox(msg.to, msg);
      return;
    }

    // Re-emit for delivery
    this.emit('message', msg);

    // Reset timer
    pending.timer = setTimeout(() => {
      this.retryAckTimeout(msg);
    }, ACK_TIMEOUT_MS);
  }

  // ─── Outbox (for down agents) ──────────────────────────

  private addToOutbox(agentId: string, msg: BusMessage): void {
    if (!this.outbox.has(agentId)) this.outbox.set(agentId, []);
    this.outbox.get(agentId)!.push(msg);
    msg.status = 'pending';
    console.log(`[bus] Agent ${agentId} is down, queued message: ${msg.payload.action}`);
  }

  private flushOutbox(agentId: string): void {
    const queued = this.outbox.get(agentId);
    if (!queued || queued.length === 0) return;

    console.log(`[bus] Agent ${agentId} is back, flushing ${queued.length} queued messages`);
    this.outbox.delete(agentId);

    for (const msg of queued) {
      // Remove from seen set so handleBusMessage won't dedup it
      this.unsee(msg.id);
      this.emit('message', msg);
    }
  }

  // ─── Dedup ─────────────────────────────────────────────

  /** Check if a message was already processed (for receiver side) */
  isDuplicate(messageId: string): boolean {
    if (this.seen.has(messageId)) return true;
    this.seen.add(messageId);
    // Keep seen set bounded
    if (this.seen.size > 1000) {
      const arr = Array.from(this.seen);
      this.seen = new Set(arr.slice(-500));
    }
    return false;
  }

  /** Remove a message ID from the seen set (allow re-processing, e.g. after outbox flush) */
  unsee(messageId: string): void {
    this.seen.delete(messageId);
  }

  /** Mark a message as delivered by ID */
  markDelivered(messageId: string): void {
    const msg = this.log.find(m => m.id === messageId);
    if (msg && msg.status === 'pending') {
      msg.status = 'done';
    }
  }

  /** Get undelivered messages for an agent (pending status only, excludes ACKs) */
  getPendingMessagesFor(agentId: string): BusMessage[] {
    return this.log.filter(m => m.to === agentId && m.status === 'pending' && m.type !== 'ack');
  }

  /** Retry a failed message by ID — mark as pending and re-emit for delivery */
  /** Retry/re-run a message — set back to pending and re-deliver */
  retryMessage(messageId: string): BusMessage | null {
    const msg = this.log.find(m => m.id === messageId);
    if (!msg || msg.status === 'pending') return null; // already pending, skip
    const prevStatus = msg.status;
    msg.status = 'pending';
    msg.retries = 0;
    // Remove from seen set so handleBusMessage won't dedup
    this.unsee(messageId);
    // Re-emit for delivery
    this.emit('message', msg);
    console.log(`[bus] ${prevStatus === 'done' ? 'Re-running' : 'Retrying'} message ${msg.payload.action} from ${msg.from} to ${msg.to}`);
    return msg;
  }

  /** Delete a message from the log (only done/failed) */
  deleteMessage(messageId: string): void {
    const idx = this.log.findIndex(m => m.id === messageId);
    if (idx !== -1 && (this.log[idx].status === 'done' || this.log[idx].status === 'failed')) {
      this.log.splice(idx, 1);
    }
  }

  /** Abort a pending message — mark as failed */
  abortMessage(messageId: string): BusMessage | null {
    const msg = this.log.find(m => m.id === messageId);
    if (!msg || msg.status !== 'pending') return null;
    msg.status = 'failed';
    console.log(`[bus] Aborted message ${msg.payload.action} from ${msg.from} to ${msg.to}`);
    return msg;
  }

  /** Mark all running messages as failed — called on stopDaemon/crash */
  markAllRunningAsFailed(): void {
    let count = 0;
    for (const msg of this.log) {
      if (msg.status === 'running' && msg.type !== 'ack') {
        msg.status = 'failed';
        count++;
      }
    }
    if (count > 0) console.log(`[bus] Marked ${count} running messages as failed (shutdown)`);
  }

  /** Mark all pending (non-ack) messages as failed — called on restart/reload */
  markAllPendingAsFailed(): void {
    let count = 0;
    for (const msg of this.log) {
      if (msg.status === 'pending' && msg.type !== 'ack') {
        msg.status = 'failed';
        count++;
      }
    }
    if (count > 0) console.log(`[bus] Marked ${count} pending messages as failed (restart cleanup)`);
  }

  // ─── Query ─────────────────────────────────────────────

  getMessagesFor(agentId: string): BusMessage[] {
    return this.log.filter(m => m.to === agentId);
  }

  getMessagesFrom(agentId: string): BusMessage[] {
    return this.log.filter(m => m.from === agentId);
  }

  getConversation(a: string, b: string): BusMessage[] {
    return this.log.filter(m =>
      (m.from === a && m.to === b) || (m.from === b && m.to === a)
    );
  }

  getOutbox(agentId: string): BusMessage[] {
    return this.outbox.get(agentId) || [];
  }

  getLog(): readonly BusMessage[] {
    return this.log;
  }

  /** Get all outbox queues (for persistence) */
  getAllOutbox(): Record<string, BusMessage[]> {
    const result: Record<string, BusMessage[]> = {};
    for (const [id, msgs] of this.outbox) {
      if (msgs.length > 0) result[id] = [...msgs];
    }
    return result;
  }

  loadLog(messages: BusMessage[]): void {
    this.log = [...messages];
  }

  /** Restore outbox from persisted state */
  loadOutbox(outbox: Record<string, BusMessage[]>): void {
    this.outbox.clear();
    for (const [id, msgs] of Object.entries(outbox)) {
      this.outbox.set(id, [...msgs]);
    }
  }

  clear(): void {
    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      try { pending.resolve({ id: '', from: '', to: '', type: 'response', payload: { action: 'cancelled' }, timestamp: Date.now() }); } catch {}
    }
    this.pendingRequests.clear();

    // Clear all pending ACK timers
    for (const [, pending] of this.pendingAcks) {
      clearTimeout(pending.timer);
    }
    this.pendingAcks.clear();

    this.log = [];
    this.outbox.clear();
    this.seen.clear();
  }
}
