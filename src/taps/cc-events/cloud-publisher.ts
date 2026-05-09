/**
 * G-401 + G-501: Cloud Event Publisher
 * Batches published events and POSTs them to the cloud Worker endpoint.
 *
 * G-501 Network-aware routing:
 * - Each event may have a network_id field
 * - NetworkResolver function looks up endpoint/apiKey/operatorId per network
 * - Events without network_id use default network from resolver
 * - Events with unknown network_id are logged and skipped
 *
 * S-154: Stale endpoint detection:
 * - Uses redirect: "manual" to catch 3xx responses from zombie CF Access apps
 * - Startup health check probes each endpoint before publishing begins
 *
 * Behavior:
 * - publish(event) adds to buffer
 * - Every batchIntervalMs (default 2s) or when buffer hits batchSizeLimit (default 50),
 *   POSTs batch to {endpoint}/api/ingest
 * - On failure: retries with exponential backoff, then drops (events are in local JSONL)
 * - On redirect: drops immediately (stale endpoint, retrying won't help)
 * - flush() sends pending events immediately
 * - close() flushes + stops the interval
 */

import type { PublishedEvent } from "./hooks/lib/event-types";
import type { NetworkResolver, NetworkConfig } from "../../common/types/config";
import { fetchWithTimeout } from "../../common/timeout";

export interface CloudPublisherConfig {
  /** Function to resolve network config by network_id. Returns null for unknown networks. */
  networkResolver: NetworkResolver;
  batchIntervalMs?: number;  // default 2000
  batchSizeLimit?: number;   // default 50
  maxRetries?: number;       // default 3
  retryBaseMs?: number;      // default 1000 (backoff = 2^attempt * retryBaseMs)
}

export class CloudPublisher {
  private networkResolver: NetworkResolver;
  private readonly batchIntervalMs: number;
  private readonly batchSizeLimit: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  private static readonly MAX_BUFFER_SIZE = 500;
  private buffer: PublishedEvent[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private flushInProgress: Promise<void> | null = null;

  constructor(config: CloudPublisherConfig) {
    this.networkResolver = config.networkResolver;
    this.batchIntervalMs = config.batchIntervalMs ?? 2000;
    this.batchSizeLimit = config.batchSizeLimit ?? 50;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseMs = config.retryBaseMs ?? 1000;

    this.interval = setInterval(() => {
      this.flushInternal();
    }, this.batchIntervalMs);
  }

  /**
   * G-500: Update the network resolver on config reload.
   * Safe to call mid-flight: JS is single-threaded, so this won't race with sendBatch().
   */
  updateResolver(resolver: NetworkResolver): void {
    this.networkResolver = resolver;
  }

  /** Add an event to the buffer. Triggers immediate flush if batch size limit reached. */
  publish(event: PublishedEvent): void {
    this.buffer.push(event);

    // Cap buffer to prevent unbounded memory growth (events are in local JSONL as backup)
    if (this.buffer.length > CloudPublisher.MAX_BUFFER_SIZE) {
      const dropped = this.buffer.length - CloudPublisher.MAX_BUFFER_SIZE;
      this.buffer.splice(0, dropped);
      console.warn(`cloud-publisher: dropped ${dropped} oldest event(s) (buffer full)`);
    }

    if (this.buffer.length >= this.batchSizeLimit) {
      this.flushInternal();
    }
  }

  /** Send any pending events immediately. Returns when the batch has been sent (or dropped). */
  async flush(): Promise<void> {
    await this.flushInternal();
  }

  /** Flush remaining events and stop the interval timer. */
  async close(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await this.flush();
  }

  /**
   * S-154: Startup health check — probe each network's endpoint to verify it's reachable.
   * Detects stale endpoints (redirects from zombie CF Access apps), timeouts, and DNS failures.
   * Non-blocking — logs warnings but does not prevent startup.
   */
  static async checkEndpoints(resolver: NetworkResolver, networkIds: string[]): Promise<void> {
    for (const networkId of networkIds) {
      const config = resolver(networkId);
      if (!config) continue;

      const url = `${config.endpoint.replace(/\/+$/, "")}/api/health`;
      try {
        const headers: Record<string, string> = {};
        if (config.cfAccessClientId && config.cfAccessClientSecret) {
          headers["CF-Access-Client-Id"] = config.cfAccessClientId;
          headers["CF-Access-Client-Secret"] = config.cfAccessClientSecret;
        }
        const res = await fetchWithTimeout("cloud_publisher", 5_000, url, {
          method: "GET",
          headers,
          redirect: "manual",
        });

        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location") ?? "(unknown)";
          console.error(
            `cloud-publisher: endpoint STALE for network "${networkId}"\n` +
            `  URL: ${url}\n` +
            `  Got: HTTP ${res.status} -> ${location}\n` +
            `  This usually means the Worker route was changed but the network config still has the old URL.\n` +
            `  Fix: update cloud.endpoint in the network config file, then restart.`,
          );
        } else if (res.ok) {
          console.log(`cloud-publisher: endpoint OK for network "${networkId}" (${config.endpoint})`);
        } else {
          console.warn(
            `cloud-publisher: endpoint returned HTTP ${res.status} for network "${networkId}" (${url})`,
          );
        }
      } catch (err) {
        console.error(
          `cloud-publisher: endpoint UNREACHABLE for network "${networkId}" (${url}): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private flushInternal(): Promise<void> {
    if (this.buffer.length === 0) {
      return Promise.resolve();
    }

    // Drain buffer into a local batch
    const batch = this.buffer.splice(0);

    // If a flush is already in progress, chain after it
    const sendPromise = (this.flushInProgress ?? Promise.resolve()).then(() =>
      this.sendBatch(batch),
    );

    this.flushInProgress = sendPromise;
    return sendPromise;
  }

  private async sendBatch(events: PublishedEvent[]): Promise<void> {
    // Group events by network_id
    const eventsByNetwork = new Map<string, PublishedEvent[]>();
    for (const event of events) {
      const networkId = event.network_id ?? "default";
      if (!eventsByNetwork.has(networkId)) {
        eventsByNetwork.set(networkId, []);
      }
      eventsByNetwork.get(networkId)!.push(event);
    }

    // Send each network's batch separately
    for (const [networkId, networkEvents] of eventsByNetwork) {
      await this.sendNetworkBatch(networkId, networkEvents);
    }
  }

  private async sendNetworkBatch(networkId: string, events: PublishedEvent[]): Promise<void> {
    // Resolve network config
    const networkConfig = this.networkResolver(networkId === "default" ? undefined : networkId);

    if (!networkConfig) {
      console.warn(
        `cloud-publisher: unknown network "${networkId}" — skipping ${events.length} event(s). ` +
        `Check networks[] config or ensure GROVE_NETWORK matches a configured network.`,
      );
      return;
    }

    const url = `${networkConfig.endpoint.replace(/\/+$/, "")}/api/ingest`;
    const body = JSON.stringify({
      operator_id: networkConfig.operatorId,
      events,
    });

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${networkConfig.apiKey}`,
        };
        // S-001: Include CF Access service token for machine-to-machine auth
        if (networkConfig.cfAccessClientId && networkConfig.cfAccessClientSecret) {
          headers["CF-Access-Client-Id"] = networkConfig.cfAccessClientId;
          headers["CF-Access-Client-Secret"] = networkConfig.cfAccessClientSecret;
        }
        const res = await fetch(url, { method: "POST", headers, body, redirect: "manual" });

        if (res.ok) {
          return; // Success
        }

        // S-154: Detect stale endpoints returning redirects (e.g. zombie CF Access apps)
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location") ?? "(unknown)";
          console.error(
            `cloud-publisher: endpoint STALE for network "${networkId}" — got HTTP ${res.status} -> ${location}\n` +
            `  URL: ${url}\n` +
            `  This usually means the Worker route was changed but the network config still has the old URL.\n` +
            `  Fix: update cloud.endpoint in the network config file, then restart.\n` +
            `  Dropping ${events.length} event(s) (retrying won't help).`,
          );
          return; // Do NOT retry on redirects — the endpoint is misconfigured
        }

        console.error(
          `cloud-publisher: publish failed for network "${networkId}" (attempt ${attempt}/${this.maxRetries}): HTTP ${res.status}`,
        );
      } catch (err) {
        console.error(
          `cloud-publisher: publish error for network "${networkId}" (attempt ${attempt}/${this.maxRetries}):`,
          err instanceof Error ? err.message : err,
        );
      }

      // Exponential backoff before retry (skip if last attempt)
      if (attempt < this.maxRetries) {
        const delayMs = Math.pow(2, attempt) * this.retryBaseMs; // 2s, 4s, 8s (default)
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // All retries exhausted -- drop the batch (events are in local JSONL)
    console.error(
      `cloud-publisher: publish dropped ${events.length} event(s) for network "${networkId}" after ${this.maxRetries} retries`,
    );
  }
}
