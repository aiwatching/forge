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

    // Start ACK timer for non-ack messages
    this.startAckTimer(msg);

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
      status: 'delivered',
    });
    this.emit('message', this.log[this.log.length - 1]);
  }

  notifyStepComplete(agentId: string, stepLabel: string, files?: string[]): void {
    this.log.push({
      id: randomUUID(),
      from: agentId, to: '_system', type: 'notify',
      payload: { action: 'step_complete', content: `Step "${stepLabel}" completed`, files },
      timestamp: Date.now(),
      status: 'delivered',
    });
    this.emit('message', this.log[this.log.length - 1]);
  }

  notifyError(agentId: string, error: string): void {
    this.log.push({
      id: randomUUID(),
      from: agentId, to: '_system', type: 'notify',
      payload: { action: 'error', content: error },
      timestamp: Date.now(),
      status: 'delivered',
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
      pending.msg.status = 'acked';
    }
  }

  private startAckTimer(msg: BusMessage): void {
    const timer = setTimeout(() => {
      this.retryMessage(msg);
    }, ACK_TIMEOUT_MS);

    this.pendingAcks.set(msg.id, { timer, msg, retries: 0 });
  }

  private retryMessage(msg: BusMessage): void {
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
      this.retryMessage(msg);
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
      this.emit('message', msg);
      this.startAckTimer(msg);
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

  loadLog(messages: BusMessage[]): void {
    this.log = [...messages];
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
