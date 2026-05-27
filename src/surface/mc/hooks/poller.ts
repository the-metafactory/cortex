/**
 * Grove Mission Control v2 — Hook stream poller.
 *
 * Polls ~/.claude/events/raw/ for new JSONL lines,
 * ingests events from registered observed sessions.
 */

import { readdirSync, existsSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { HooksConfig } from "../types";
import type { WsClientRegistry } from "../ws/client-registry";
import { JsonlTailReader } from "./jsonl-reader";
import { CursorStore } from "./cursor-store";
import { ingestEvents } from "./ingestor";
import { broadcastEvent } from "../notifications";

export class HookStreamPoller {
  private readonly reader: JsonlTailReader;
  private readonly cursorStore: CursorStore;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly db: Database,
    private readonly config: HooksConfig,
    private readonly wsRegistry?: WsClientRegistry
  ) {
    this.reader = new JsonlTailReader();
    this.cursorStore = new CursorStore(config.cursorPath);

    // Restore cursor state from disk
    const offsets = this.cursorStore.load();
    this.reader.importOffsets(offsets);
  }

  /**
   * Start polling using chained setTimeout.
   * Why setTimeout over setInterval: setInterval fires regardless of whether
   * the previous tick finished. Today poll() is synchronous, but if it ever
   * becomes async (e.g. ingestor does a remote call), setInterval would fire
   * a second poll while the first is still in flight. Chained setTimeout
   * guarantees exactly `pollInterval` ms of idle between ticks.
   */
  start(): void {
    if (this.timer) return;
    this.schedule();
  }

  /**
   * Stop polling and persist cursor.
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Persist cursor on stop
    this.cursorStore.save(this.reader.exportOffsets());
  }

  /**
   * Run a single poll cycle. Returns total events ingested.
   */
  poll(): number {
    const dir = this.config.rawEventsDir;
    if (!existsSync(dir)) return 0;

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch (err) {
      // Directory vanished or became unreadable between existsSync and readdir
      // (e.g. principal moved ~/.claude/events). Log and skip this tick rather
      // than crash — the next tick will recover once the dir returns.
      process.stderr.write(
        `[mission-control] hook-poller: readdir failed for ${dir}: ${(err as Error).message}\n`
      );
      return 0;
    }

    let totalIngested = 0;

    for (const file of files) {
      const path = join(dir, file);
      const rawEvents = this.reader.readNew(path);
      if (rawEvents.length > 0) {
        // F-20 — pass wsRegistry so the ingestor can broadcast
        // dispatched → running and running → completed transitions for
        // observed sessions.
        const result = ingestEvents(this.db, rawEvents, this.wsRegistry);
        totalIngested += result.count;

        // Broadcast each ingested event to connected dashboard clients.
        // This is the F-5 wiring: hook events → DB → WebSocket.
        if (this.wsRegistry && result.events.length > 0) {
          for (const event of result.events) {
            broadcastEvent(this.wsRegistry, event.session_id, event);
          }
        }
      }
    }

    // Always persist cursor — even when no events were ingested the reader
    // may have advanced offsets on files with no matching sessions. Without
    // this, those offset advances are lost on restart and the same bytes
    // would be re-read on next startup (F-4 review finding #4).
    this.cursorStore.save(this.reader.exportOffsets());

    return totalIngested;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.poll();
      this.schedule();
    }, this.config.pollInterval);
  }
}
