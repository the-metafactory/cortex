/**
 * Session Manager
 * Maps Discord thread IDs to Claude Code session IDs for multi-turn conversations.
 */

export interface SessionEntry {
  sessionId: string;
  threadId: string;
  lastActivity: number;
  createdAt: number;
}

export interface SessionManagerOptions {
  /** Idle timeout in ms before a session is eligible for cleanup (default: 10 min) */
  idleTimeoutMs?: number;
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private idleTimeoutMs: number;

  constructor(options?: SessionManagerOptions) {
    this.idleTimeoutMs = options?.idleTimeoutMs ?? 10 * 60 * 1000;
  }

  /** Get session for a thread, updating lastActivity */
  getSession(threadId: string): SessionEntry | null {
    const entry = this.sessions.get(threadId);
    if (!entry) return null;
    entry.lastActivity = Date.now();
    return entry;
  }

  /** Store a session for a thread */
  setSession(threadId: string, sessionId: string): void {
    this.sessions.set(threadId, {
      sessionId,
      threadId,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    });
  }

  /** Remove a session */
  removeSession(threadId: string): void {
    this.sessions.delete(threadId);
  }

  /** Check if a thread has an active session */
  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  /** List all active sessions */
  listSessions(): SessionEntry[] {
    return Array.from(this.sessions.values());
  }

  /** Remove idle sessions past the timeout. Returns removed thread IDs. */
  cleanupIdle(): string[] {
    const now = Date.now();
    const removed: string[] = [];
    for (const [threadId, entry] of this.sessions) {
      if (now - entry.lastActivity > this.idleTimeoutMs) {
        this.sessions.delete(threadId);
        removed.push(threadId);
      }
    }
    return removed;
  }

  /** Check if a message is in a thread context */
  static isThreadContext(channelId: string, isThread: boolean): boolean {
    return isThread;
  }
}
