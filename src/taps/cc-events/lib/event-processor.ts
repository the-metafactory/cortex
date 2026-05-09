/**
 * T-4.3: Event Processor
 * Wires JSONL reader and policy engine together.
 *
 * MIG-5b — Optional bus publishing: when constructed with an `onPublished`
 * callback, the processor invokes it for every event that survives the
 * relay policy. The relay binary uses this seam to wrap each PublishedEvent
 * in a Myelin envelope and publish it to NATS via `MyelinRuntime.publish`.
 *
 * The callback is invoked synchronously per event before the event is
 * appended to the published JSONL; this keeps publish ordering identical
 * to JSONL ordering. Errors thrown by the callback are caught and logged —
 * a misbehaving bus consumer must NOT break the JSONL pipeline (per the
 * design intent of "JSONL is the durable backup, bus is the live tap").
 */

import { appendFileSync, mkdirSync, chmodSync, existsSync } from "fs";
import { dirname } from "path";
import type { RelayPolicy } from "./policy-schema";
import { processEvent } from "./policy-engine";
import { JsonlReader } from "./jsonl-reader";
import type { PublishedEvent } from "../hooks/lib/event-types";

/**
 * Optional bus-publish hook. The processor invokes this for every event
 * that survives the relay policy. The hook is responsible for any
 * envelope construction, async publishing, and its own error handling —
 * the processor catches and logs throws but does not retry.
 *
 * Synchronous-call shape: the hook returns `void` (or a fire-and-forget
 * Promise). The processor does not await; the bus path is best-effort.
 */
export type OnPublishedHook = (event: PublishedEvent) => void;

export interface EventProcessorOptions {
  /**
   * Optional bus-publish hook called once per filtered event. See
   * `OnPublishedHook` for the contract. When omitted, the processor
   * behaves identically to its pre-MIG-5b form (JSONL only).
   */
  onPublished?: OnPublishedHook;
}

export class EventProcessor {
  private reader = new JsonlReader();
  private readonly onPublished?: OnPublishedHook;

  constructor(private policy: RelayPolicy, options?: EventProcessorOptions) {
    this.onPublished = options?.onPublished;
  }

  /**
   * Process new events from a raw JSONL file and write to published.
   * Returns count of events published.
   *
   * For each event surviving the relay policy:
   *   1. Append to published JSONL (durable archive, primary path)
   *   2. Invoke `onPublished` hook if provided (live bus tap, secondary path)
   *
   * Errors from the bus tap are logged and swallowed — the JSONL path is
   * the source of truth, and a flaky bus consumer must not stall the
   * relay's primary job.
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

        // MIG-5b: Best-effort bus tap. JSONL append above is the primary
        // durable path; this is a live secondary stream for in-process
        // subscribers. Failures are logged + swallowed so a flaky NATS
        // doesn't break the relay's primary archival job.
        if (this.onPublished) {
          try {
            this.onPublished(result);
          } catch (err) {
            process.stderr.write(
              `grove-relay: onPublished hook threw for event_id=${result.event_id}: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            );
          }
        }
      }
    }

    return published;
  }
}
