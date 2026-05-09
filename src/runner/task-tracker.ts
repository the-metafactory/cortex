/**
 * Tracks in-flight async CC sessions for fire-and-forget execution.
 * Enables graceful shutdown (await all pending) and active task listing.
 */

import type { CCSession } from "./cc-session";

export interface TrackedTask {
  id: string;
  session: CCSession;
  channelId: string;
  startedAt: number;
  description?: string;
}

export class TaskTracker {
  private tasks = new Map<string, TrackedTask>();

  /** Register an in-flight async task. */
  track(id: string, session: CCSession, channelId: string, description?: string): void {
    this.tasks.set(id, {
      id,
      session,
      channelId,
      startedAt: Date.now(),
      description,
    });
  }

  /** Mark a task as complete and remove it. */
  complete(id: string): void {
    this.tasks.delete(id);
  }

  /** List all active (in-flight) tasks. */
  active(): Array<{ id: string; channelId: string; durationMs: number; description?: string }> {
    const now = Date.now();
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      channelId: t.channelId,
      durationMs: now - t.startedAt,
      description: t.description,
    }));
  }

  /** Number of in-flight tasks. */
  get size(): number {
    return this.tasks.size;
  }

  /**
   * Graceful shutdown: kill all in-flight sessions and wait for them to exit.
   * Returns after all tasks have exited or timeout.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.tasks.size === 0) return;

    console.log(`grove-bot: shutting down ${this.tasks.size} in-flight task(s)...`);

    const exitPromises: Promise<void>[] = [];

    for (const task of this.tasks.values()) {
      exitPromises.push(
        new Promise<void>((resolve) => {
          task.session.on("exit", () => resolve());
          // Give it a moment to finish naturally, then kill
          setTimeout(() => {
            task.session.kill();
            resolve();
          }, Math.min(timeoutMs, 5_000));
        })
      );
    }

    await Promise.race([
      Promise.all(exitPromises),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    this.tasks.clear();
  }
}
