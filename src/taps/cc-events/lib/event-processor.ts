/**
 * T-4.3: Event Processor
 * Wires JSONL reader and policy engine together.
 */

import { appendFileSync, mkdirSync, chmodSync, existsSync } from "fs";
import { dirname } from "path";
import type { RelayPolicy } from "./policy-schema";
import { processEvent } from "./policy-engine";
import { JsonlReader } from "./jsonl-reader";

export class EventProcessor {
  private reader = new JsonlReader();

  constructor(private policy: RelayPolicy) {}

  /**
   * Process new events from a raw JSONL file and write to published.
   * Returns count of events published.
   */
  processFile(rawPath: string, publishedPath: string): number {
    const events = this.reader.readNew(rawPath);
    if (events.length === 0) return 0;

    // Ensure published directory exists
    const pubDir = dirname(publishedPath);
    if (!existsSync(pubDir)) {
      mkdirSync(pubDir, { recursive: true, mode: 0o755 });
    }

    let published = 0;
    for (const raw of events) {
      const result = processEvent(raw, this.policy);
      if (result) {
        appendFileSync(publishedPath, JSON.stringify(result) + "\n");
        chmodSync(publishedPath, 0o644);
        published++;
      }
    }

    return published;
  }
}
