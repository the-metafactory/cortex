/**
 * MIG-7.2d — PagerDuty renderer.
 *
 * Forwards bus envelopes to PagerDuty's events-v2 API
 * (`https://events.pagerduty.com/v2/enqueue`). The G-1111 §4.6 fail-safe
 * rule recommends PagerDuty as one of the two distinct platform classes
 * subscribed to `local.{principal}.system.>` so an operational alert reliably
 * pages even if the dashboard is the thing that broke.
 *
 * Principal chooses what counts as page-worthy via the `subscribe` patterns
 * on the `PagerDutyRendererConfig`. Typical wiring:
 *
 *     - kind: pagerduty
 *       routingKey: ${PAGERDUTY_ROUTING_KEY}
 *       subscribe:
 *         - "local.{principal}.system.adapter.degraded"
 *         - "local.{principal}.system.process.crashed"
 *         - "local.{principal}.system.subscription.dropped"
 *
 * Mapping rules (events-v2 §payload):
 *   - `event_action` is always `"trigger"` for now. Future iteration could
 *     map `system.adapter.recovered` to `"resolve"` once the upstream
 *     adapter emits a matching `dedup_key`.
 *   - `dedup_key` defaults to `${envelope.source}:${envelope.type}` so a
 *     flapping shard doesn't open N tickets.
 *   - `severity` is derived: `system.*.crashed` → `critical`,
 *     `system.*.degraded` → `error`, anything else → `warning`. Override
 *     via `payload.severity` on the envelope.
 *   - `summary` is `${envelope.type}: ${envelope.source}` truncated to 1024
 *     chars per the PagerDuty hard limit.
 *
 * Failure handling (Renderer contract §2): network failures + non-2xx
 * responses log a warning and drop the envelope. Throwing would poison
 * the surface-router's dispatch loop, and PagerDuty's own retry mechanics
 * are out-of-band (re-trigger on subsequent envelopes).
 */

import type { Envelope, RenderTarget, RendererPlugin } from "../surface-sdk";
import { PagerDutyRendererSchema, type PagerDutyRendererConfig } from "../common/types/cortex-config";
import type { Renderer } from "./types";

const EVENTS_V2_URL = "https://events.pagerduty.com/v2/enqueue";
const SUMMARY_MAX_LEN = 1024;

export interface PagerDutyRendererOptions {
  /** Override the events-v2 URL — tests stub the HTTP path here. */
  endpoint?: string;
  /** Override the fetch implementation — tests use a stubbed fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. Default 5s. Pages should be small and fast; if
   *  the events-v2 endpoint is slower than 5s the alert is already noise. */
  timeoutMs?: number;
}

export class PagerDutyRenderer implements Renderer {
  readonly kind = "pagerduty" as const;
  readonly id: string;
  readonly subjects: string[];

  private readonly routingKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly visibility: PagerDutyRendererConfig["visibility"];

  constructor(config: PagerDutyRendererConfig, options: PagerDutyRendererOptions = {}) {
    // cortex#1788 (S3, ADR-0024 OQ10) — `config.id` defaults to `kind`,
    // preserving the pre-OQ10 single-integration-per-deployment id exactly
    // when unset. Two `kind: pagerduty` entries (different routing keys)
    // now need distinct `id:` values in config to avoid colliding in
    // router metrics and to be independently addressable by a future
    // `unload` verb.
    this.id = config.id ?? "pagerduty";
    this.subjects = config.subscribe;
    this.routingKey = config.routingKey;
    this.endpoint = options.endpoint ?? EVENTS_V2_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    // IAW Phase A.4 — capture the optional visibility block. See
    // DashboardRenderer for the rationale; same plumbing applies here.
    this.visibility = config.visibility;
  }

  async start(): Promise<void> {
    // No I/O at start time — the events-v2 endpoint is stateless and
    // PagerDuty doesn't expose a connect handshake. The lifecycle hook
    // exists for symmetry with the Renderer contract.
  }

  async stop(): Promise<void> {
    // Nothing to release. Per-render `AbortSignal.timeout` already bounds
    // in-flight requests; stop() doesn't need to drain them.
  }

  get surfaceConfig(): RenderTarget {
    return {
      id: this.id,
      subjects: this.subjects,
      // IAW Phase A.4 — conditional spread so undeclared visibility leaves
      // the field absent on the adapter (matches pre-A.4 behaviour). See
      // DashboardRenderer.surfaceConfig for the full rationale.
      ...(this.visibility !== undefined && { visibility: this.visibility }),
      render: (envelope, signal) => this.render(envelope, signal),
    };
  }

  async render(envelope: Envelope, signal?: AbortSignal): Promise<void> {
    // Per Renderer contract §2: NEVER throw. Any failure logs + drops.
    try {
      const body = this.buildPayload(envelope);
      // Compose the abort signal: prefer the router's signal when supplied
      // (router has the canonical timeout); else fall back to our own.
      const ownTimeout = AbortSignal.timeout(this.timeoutMs);
      const composedSignal = signal ? AbortSignal.any([signal, ownTimeout]) : ownTimeout;

      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: composedSignal,
      });
      if (!res.ok) {
        console.warn(
          `pagerduty-renderer: POST events-v2 returned HTTP ${res.status} ${res.statusText} for envelope ${envelope.id}`,
        );
      }
    } catch (err) {
      // Defense-in-depth: a null envelope bypassing the surface-router
      // makes `buildPayload` throw, which lands here — accessing
      // `envelope.id` raw would then TypeError inside the catch and
      // surface as an unhandled rejection. Match the DashboardRenderer
      // pattern (Holly cycle 2 nit).
      // The TS type says `envelope: Envelope` (non-null), but the catch
      // exists for the defense-in-depth case where a bug routes a null/
      // undefined envelope through. Keep the optional chain + fallback
      // so a thrown TypeError doesn't escape as an unhandled rejection.
      /* eslint-disable @typescript-eslint/no-unnecessary-condition */
      console.warn(
        `pagerduty-renderer: failed to forward envelope ${envelope?.id ?? "<unknown>"}:`,
        err instanceof Error ? err.message : err,
      );
      /* eslint-enable @typescript-eslint/no-unnecessary-condition */
    }
  }

  private buildPayload(envelope: Envelope): {
    routing_key: string;
    event_action: "trigger";
    dedup_key: string;
    payload: {
      summary: string;
      source: string;
      severity: "critical" | "error" | "warning" | "info";
      class: string;
      custom_details: Envelope;
    };
  } {
    const payload = (envelope.payload as Record<string, unknown> | undefined) ?? {};
    const severityOverride = typeof payload.severity === "string" ? payload.severity : undefined;
    return {
      routing_key: this.routingKey,
      event_action: "trigger",
      dedup_key: `${envelope.source}:${envelope.type}`,
      payload: {
        summary: `${envelope.type}: ${envelope.source}`.slice(0, SUMMARY_MAX_LEN),
        source: envelope.source,
        severity: this.classifySeverity(envelope.type, severityOverride),
        class: envelope.type,
        custom_details: envelope,
      },
    };
  }

  private classifySeverity(
    type: string,
    override: string | undefined,
  ): "critical" | "error" | "warning" | "info" {
    if (override === "critical" || override === "error" || override === "warning" || override === "info") {
      return override;
    }
    if (type.includes(".crashed") || type.includes(".overflowed")) return "critical";
    if (type.includes(".degraded") || type.includes(".dropped")) return "error";
    return "warning";
  }
}

/**
 * cortex#1788 (S3, ADR-0024 §8.1) — `pagerduty`'s `RendererPlugin`. The
 * renderer track's extraction pilot (leaf-y, zero npm deps, R10) — it
 * registers through the registry now (dogfooding, ADR-0024 §3.3) and stays
 * in-tree until S12b extracts it (gated on OQ9, the boot-coverage hard-fail).
 */
export const pagerdutyRendererPlugin: RendererPlugin = {
  kind: "renderer",
  id: "pagerduty",
  rendererKind: "pagerduty",
  // cortex#1789 (S4) — the real per-kind schema, incl. the REQUIRED
  // `routingKey` secret field. `createRenderer` parses the raw entry through
  // this before construction; a Zod validation failure never echoes the
  // rejected value (only the field path + message), so a malformed
  // `routingKey` is never leaked into the thrown error.
  configSchema: PagerDutyRendererSchema,
  createRenderer: (config) => new PagerDutyRenderer(config as PagerDutyRendererConfig),
};
