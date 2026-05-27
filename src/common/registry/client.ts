/**
 * IAW Phase D.4.3 — Cortex-side RegistryClient consumer.
 *
 * Consults the cortex-network-registry service
 * (`src/services/network-registry/`) at boot and on a background
 * refresh schedule to populate an in-memory cache of verified peer
 * pubkeys. Cortex consumers read via `getPrincipal(principalId)` and
 * receive `undefined` on every failure path — federation issues must
 * not crash the bot.
 *
 * ## Trust anchor (Phase-B caveat)
 *
 * Every `GET` response from the registry is wrapped in a
 * `SignedAssertion<T>` signed by the registry's own Ed25519 key. The
 * client verifies each assertion against a single pinned `registryPubkey`
 * before mutating its cache.
 *
 *   - If `options.pubkey` is supplied, the client pins it at
 *     construction time. This is the recommended posture — the
 *     trust anchor is operator-supplied, out-of-band.
 *   - If `options.pubkey` is absent, the client performs Trust-
 *     On-First-Use at `start()` via `GET /registry/pubkey`. The
 *     first response is pinned for the lifetime of the process.
 *     This is the Phase-B caveat: an attacker controlling the
 *     network path between cortex and the registry on first boot
 *     could substitute their own pubkey. Operators wanting
 *     zero-TOFU should populate `policy.federated.registry.pubkey`
 *     in cortex.yaml.
 *
 * ## Cache invalidation
 *
 * The client refreshes every entry every `refreshIntervalMs` (default
 * 5 minutes). When the eventual `system.operator.published` bus event
 * lands (filed as a follow-up — the producer side isn't wired yet),
 * `invalidate(principalId)` provides the seam to short-circuit the
 * refresh. Until then, TTL is the only invalidation mechanism — the
 * worst-case staleness is one refresh interval.
 *
 * ## Failure modes
 *
 * Every error path is logged via `logError` (defaults to
 * `process.stderr.write`) and returns control — never throws to the
 * caller. The exhaustive list:
 *
 *   - `fetch` rejects (network) → log, leave cache entry as-is
 *   - `fetch` returns non-2xx → log, leave cache entry as-is
 *   - JSON body unparseable → log, leave cache entry as-is
 *   - Assertion shape malformed → log, leave cache entry as-is
 *   - Registry pubkey mismatch → log, leave cache entry as-is
 *   - Signature does not verify → log, leave cache entry as-is
 *   - Assertion `registry === "unconfigured"` → log, leave cache as-is
 *   - Shutdown signalled mid-refresh → AbortError swallowed
 *
 * "Leave cache as-is" is deliberate: a transient failure should not
 * blank a previously-verified record. The cache is fail-safe; only a
 * successful verify writes.
 */

import { canonicalJSON, verifyEd25519 } from "./signing";
import type {
  OperatorRecord,
  RegistryClientOptions,
  RegistryClientReader,
} from "./types";

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * `RegistryClient` — single-process, in-memory cache of registry-
 * resolved peer principal records. Construct, `start()`, query via
 * `getPrincipal()`, `stop()` at shutdown.
 */
export class RegistryClient implements RegistryClientReader {
  private readonly url: string;
  private readonly principalIds: readonly string[];
  private readonly refreshIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly logError: (msg: string) => void;

  /** Pinned registry pubkey. Set in ctor (config) or in `start()` (TOFU). */
  private pinnedPubkey: string | undefined;
  /**
   * Whether the pubkey was supplied at construction time (config-pin)
   * or must be discovered via TOFU. Drives the "retry TOFU each cycle
   * until it succeeds" behaviour in `refreshAll()` — without it, a
   * transient failure on the initial TOFU attempt would leave the
   * client permanently dead even though every subsequent cycle had a
   * fresh chance. Echo cortex#230 round 1.
   */
  private readonly tofuMode: boolean;
  /** In-memory cache: `operator_id → verified OperatorRecord`. */
  private readonly cache = new Map<string, OperatorRecord>();

  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  /** Abort controller scoped to the current cycle's in-flight requests. */
  private cycleAbort: AbortController | undefined;
  /**
   * Re-entrancy guard for `refreshAll()`. Set on entry, cleared in the
   * finally block. If a `setInterval` tick (or a manual caller) fires
   * while the previous cycle is still draining, the new invocation
   * logs and returns rather than reassigning `cycleAbort` — that
   * reassignment would orphan the older cycle's controller and
   * `stop()` could only cancel the newest one. Echo cortex#230
   * round 1.
   */
  private refreshInFlight = false;
  /**
   * Idempotency flag for `start()`. Set on first entry, never cleared
   * (a stopped client can't be restarted — see `stop()`). Distinct
   * from `refreshTimer !== undefined` because tests run with
   * `refreshIntervalMs = 0` and a `refreshTimer`-based check would
   * fail to short-circuit a second `start()` in that mode. Echo
   * cortex#230 round 1.
   */
  private started = false;
  private stopped = false;

  constructor(options: RegistryClientOptions) {
    // Trailing slash normalisation so callers can pass either form.
    this.url = options.url.replace(/\/+$/, "");
    this.principalIds = [...options.principalIds];
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.logError =
      options.logError ??
      ((msg: string) => {
        // Per CLAUDE.md "no empty catches": every failure path logs to
        // stderr. Surface through the same channel the rest of cortex
        // uses for non-fatal warnings.
        process.stderr.write(`registry-client: ${msg}\n`);
      });
    this.pinnedPubkey = options.pubkey;
    this.tofuMode = options.pubkey === undefined;
  }

  /**
   * Start the client. Steps:
   *   1. If no pubkey was supplied to the ctor, perform TOFU via
   *      `GET /registry/pubkey` and pin the response.
   *   2. Run one immediate refresh cycle so the cache is warm before
   *      callers start querying.
   *   3. Install the `setInterval` background refresh loop (skipped
   *      when `refreshIntervalMs === 0`).
   *
   * Idempotent: a second `start()` call is a no-op regardless of
   * whether a `setInterval` timer was installed. This matters for
   * test setups using `refreshIntervalMs: 0`, where a `refreshTimer`-
   * based guard would not short-circuit. Echo cortex#230 round 1.
   *
   * Note that when TOFU fails on the initial call, the client stays
   * "started" but with `pinnedPubkey === undefined` — every subsequent
   * `refreshAll()` retries TOFU at the top of the cycle and pins the
   * key on first success. The client recovers automatically without
   * an external nudge. Echo cortex#230 round 1.
   */
  async start(): Promise<void> {
    if (this.stopped) {
      this.logError("start() called after stop(); ignoring");
      return;
    }
    if (this.started) return;
    this.started = true;

    if (this.pinnedPubkey === undefined) {
      await this.fetchAndPinRegistryPubkey();
    }

    // One eager refresh so the cache is populated before any caller
    // queries `getPrincipal()`. Errors are already logged inside the
    // cycle; we deliberately don't propagate — a refresh failure must
    // not block cortex boot.
    await this.refreshAll();

    // Re-check `stopped`: `refreshAll()` above is async, so stop() may
    // have arrived during the eager-refresh window. Don't install a
    // timer that would race a concurrent shutdown.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (this.refreshIntervalMs > 0 && !this.stopped) {
      const timer = setInterval(() => {
        void this.refreshAll();
      }, this.refreshIntervalMs);
      // Don't keep the event loop alive solely for refreshing peer
      // pubkeys — cortex's shutdown path explicitly calls `stop()`.
      // In Node/Bun, `setInterval` returns a `Timeout` object with an
      // `unref()` method; in pure browser-DOM lib targets it's just a
      // number, hence the runtime guard.
      const maybeUnrefable = timer as unknown as { unref?: () => void };
      if (typeof maybeUnrefable.unref === "function") {
        maybeUnrefable.unref();
      }
      this.refreshTimer = timer;
    }
  }

  /**
   * Stop the client. Cancels the refresh timer, aborts any in-flight
   * request, and prevents further `start()` calls. Idempotent.
   */
  stop(): void {
    this.stopped = true;
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.cycleAbort !== undefined) {
      this.cycleAbort.abort();
      this.cycleAbort = undefined;
    }
  }

  /** RegistryClientReader.getPrincipal — see interface JSDoc. */
  getPrincipal(principalId: string): OperatorRecord | undefined {
    return this.cache.get(principalId);
  }

  /**
   * Invalidate a single cache entry. The next `refreshAll()` (or an
   * explicit `refreshPrincipal(principalId)`) will repopulate it.
   * Exposed for the future `system.operator.published` event handler.
   */
  invalidate(principalId: string): void {
    this.cache.delete(principalId);
  }

  /**
   * Drive one refresh cycle manually. Tests use this to avoid waiting
   * for the `setInterval` tick. Exposed as an internal seam — not on
   * `RegistryClientReader`.
   *
   * Serial: each peer is fetched + verified in turn. A cycle runs at
   * most one at a time across the whole client — if a `setInterval`
   * tick (or a concurrent manual caller) fires while the previous
   * cycle is still draining, the new invocation logs and returns.
   * Without this guard the new cycle would overwrite `this.cycleAbort`
   * and orphan the older cycle's controller — `stop()` could then only
   * cancel the newest cycle, leaving older in-flight requests to run
   * to their per-request timeout. Echo cortex#230 round 1.
   */
  async refreshAll(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshInFlight) {
      // Worst-case: peer-list × per-request timeout > refreshIntervalMs.
      // Drop the redundant cycle rather than queue — by the time the
      // current cycle finishes, the network state is fresher than what
      // a queued cycle would have observed anyway.
      this.logError(
        "refreshAll() invoked while previous cycle still draining; skipping this tick",
      );
      return;
    }
    this.refreshInFlight = true;
    // Fresh AbortController per cycle so stop() during the cycle
    // cancels in-flight requests but doesn't poison the next cycle.
    this.cycleAbort = new AbortController();
    const signal = this.cycleAbort.signal;

    try {
      // Recovery path: if we're in TOFU mode and the initial attempt
      // at boot failed, retry it at the top of every cycle. Without
      // this, a transient outage at boot would leave the client
      // permanently dead. Echo cortex#230 round 1.
      if (this.pinnedPubkey === undefined && this.tofuMode) {
        await this.fetchAndPinRegistryPubkey();
      }
      if (this.pinnedPubkey === undefined) {
        this.logError(
          "refreshAll: no pinned pubkey (TOFU still failing or pubkey never supplied); skipping operator fetches this cycle",
        );
        return;
      }
      // Serial rather than parallel: peer lists are short (single-digit
      // typical, dozens worst-case), the registry is shared, and serial
      // is more polite under load. Parallelise later if measured-needed.
      for (const principalId of this.principalIds) {
        if (signal.aborted) break;
        await this.refreshPrincipal(principalId, signal);
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  // =============================================================================
  // Private — TOFU + per-principal refresh
  // =============================================================================

  private async fetchAndPinRegistryPubkey(): Promise<void> {
    const url = `${this.url}/registry/pubkey`;
    const raw = await this.fetchJson(url, undefined);
    if (raw === undefined) {
      this.logError(
        `TOFU failed: could not fetch ${url}; client will start with no pinned key and reject all operators`,
      );
      return;
    }
    // Treat the response as untrusted JSON until we've verified shape.
    if (
      typeof raw !== "object" ||
      raw === null ||
      (raw as { algorithm?: unknown }).algorithm !== "Ed25519" ||
      typeof (raw as { public_key?: unknown }).public_key !== "string"
    ) {
      this.logError(`TOFU failed: malformed /registry/pubkey response`);
      return;
    }
    const publicKey = (raw as { public_key: string }).public_key;
    // Refuse the unconfigured sentinel — it means the registry has no
    // signing key, and we cannot verify any assertion against it.
    if (publicKey === "" || publicKey === "unconfigured") {
      this.logError(
        "TOFU failed: registry returned unconfigured pubkey; refusing to pin",
      );
      return;
    }
    this.pinnedPubkey = publicKey;
  }

  private async refreshPrincipal(
    principalId: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Wire path stays `/operators/:operator_id` until PR-R7c-network-registry
    // renames the registry service.
    const url = `${this.url}/operators/${encodeURIComponent(principalId)}`;
    const raw = await this.fetchJson(url, signal);
    if (raw === undefined) return; // already logged inside fetchJson

    const verified = await this.verifyAssertion(principalId, raw);
    if (verified === undefined) return; // already logged inside verifyAssertion
    this.cache.set(principalId, verified);
  }

  /**
   * Verify a registry assertion against the pinned pubkey. Returns the
   * payload on success, `undefined` on any failure (with a log line).
   *
   * Accepts `unknown` rather than a typed assertion: at this layer the
   * input is untrusted JSON straight off the wire, and the shape checks
   * below ARE the validation. Trusting the type at the boundary would
   * defeat the purpose of the check.
   */
  private async verifyAssertion(
    principalId: string,
    raw: unknown,
  ): Promise<OperatorRecord | undefined> {
    const pinned = this.pinnedPubkey;
    if (pinned === undefined) {
      this.logError(
        `refresh(${principalId}): no pinned pubkey; refusing to trust assertion`,
      );
      return undefined;
    }
    // Shape check first — cheaper than crypto and gives a clearer log.
    if (raw === null || typeof raw !== "object") {
      this.logError(`refresh(${principalId}): assertion not an object; ignoring`);
      return undefined;
    }
    const assertion = raw as Record<string, unknown>;
    if (
      typeof assertion.signature !== "string" ||
      typeof assertion.issued_at !== "string" ||
      typeof assertion.registry !== "string" ||
      assertion.payload === null ||
      typeof assertion.payload !== "object"
    ) {
      this.logError(
        `refresh(${principalId}): malformed assertion envelope; ignoring`,
      );
      return undefined;
    }
    const registry = assertion.registry;
    if (registry === "unconfigured") {
      this.logError(
        `refresh(${principalId}): registry assertion says "unconfigured"; refusing`,
      );
      return undefined;
    }
    if (registry !== pinned) {
      this.logError(
        `refresh(${principalId}): registry pubkey mismatch (got ${registry.slice(0, 8)}…, pinned ${pinned.slice(0, 8)}…); ignoring`,
      );
      return undefined;
    }
    // Sanity-check the payload looks like an OperatorRecord. We don't
    // re-validate the deep structure here — the registry is the source
    // of truth for its own shape — but we do require the same
    // operator_id we requested, defending against a swapped payload.
    // Wire-field reads (`payload.operator_id`, `payload.operator_pubkey`)
    // stay until PR-R7c-network-registry renames the registry service.
    const payload = assertion.payload as Record<string, unknown>;
    if (payload.operator_id !== principalId) {
      this.logError(
        `refresh(${principalId}): payload.operator_id mismatch (got "${String(payload.operator_id)}"); ignoring`,
      );
      return undefined;
    }
    if (typeof payload.operator_pubkey !== "string") {
      this.logError(
        `refresh(${principalId}): payload.operator_pubkey missing or non-string; ignoring`,
      );
      return undefined;
    }
    // Shape-validate the peer pubkey grammar BEFORE the signature
    // verifies — a cheap structural gate runs first so we don't pay
    // for an Ed25519 verify on a payload we'd reject anyway. A
    // signed-but-malformed peer pubkey is still a wire-contract
    // violation, and downstream callers expect to get a string that
    // decodes as a 32-byte Ed25519 key. Either ordering catches the
    // attack (sig-verifying-but-malformed cannot bypass either
    // gate); pre-verify is the perf-conscious choice. Defend at the
    // boundary so the cache never holds a poison value. Echo
    // cortex#230 rounds 1 + 3.
    //
    // Grammar: 43 chars of standard-base64 alphabet + one `=` of
    // padding = 44 chars total, matching `OperatorRecord.operator_pubkey`
    // on the producer side (base64 of 32 raw bytes).
    if (!/^[A-Za-z0-9+/]{43}=$/.test(payload.operator_pubkey)) {
      this.logError(
        `refresh(${principalId}): payload.operator_pubkey is not base64-Ed25519 (got "${payload.operator_pubkey.slice(0, 12)}…"); ignoring`,
      );
      return undefined;
    }

    // Reconstruct the canonical bound triple and verify.
    const bound = canonicalJSON({
      payload: assertion.payload,
      issued_at: assertion.issued_at,
      registry,
    });
    const message = new TextEncoder().encode(bound);
    let ok: boolean;
    try {
      ok = await verifyEd25519(pinned, assertion.signature, message);
    } catch (err) {
      this.logError(
        `refresh(${principalId}): verify threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
    if (!ok) {
      this.logError(
        `refresh(${principalId}): signature did not verify; ignoring`,
      );
      return undefined;
    }
    // Defensive: the producer types include arrays we trust the
    // service to populate, but a corrupted payload could send the
    // wrong shape past the structural checks above. Normalise.
    return {
      operator_id: principalId,
      operator_pubkey: payload.operator_pubkey,
      stacks: Array.isArray(payload.stacks) ? (payload.stacks as OperatorRecord["stacks"]) : [],
      capabilities: Array.isArray(payload.capabilities) ? (payload.capabilities as OperatorRecord["capabilities"]) : [],
      updated_at: typeof payload.updated_at === "string" ? payload.updated_at : "",
    };
  }

  // =============================================================================
  // Private — transport
  // =============================================================================

  /**
   * Issue a JSON GET. Wraps timeout + abort + non-2xx + parse failure
   * into a single `undefined` return path with a structured log line.
   * `cycleSignal`, when supplied, is OR'd with the per-request timeout
   * via the controller below so `stop()` cancels in-flight work.
   */
  private async fetchJson(
    url: string,
    cycleSignal: AbortSignal | undefined,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(
      () => { controller.abort(); },
      this.requestTimeoutMs,
    );
    const cycleAbortListener = (): void => { controller.abort(); };
    if (cycleSignal !== undefined) {
      if (cycleSignal.aborted) {
        clearTimeout(timeoutHandle);
        return undefined;
      }
      cycleSignal.addEventListener("abort", cycleAbortListener, { once: true });
    }
    try {
      const res = await this.fetchImpl(url, { signal: controller.signal });
      if (!res.ok) {
        this.logError(`GET ${url} returned ${res.status}`);
        return undefined;
      }
      try {
        return await res.json();
      } catch (err) {
        this.logError(
          `GET ${url} JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
    } catch (err) {
      // AbortError on shutdown is expected — log at a lower fidelity
      // but do log, so silent stop-mid-fetch is still observable.
      if (err instanceof Error && err.name === "AbortError") {
        this.logError(`GET ${url} aborted`);
      } else {
        this.logError(
          `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return undefined;
    } finally {
      clearTimeout(timeoutHandle);
      if (cycleSignal !== undefined) {
        cycleSignal.removeEventListener("abort", cycleAbortListener);
      }
    }
  }
}

