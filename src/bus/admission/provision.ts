/**
 * R26 P1 (cortex#1371) — idempotent NATS-KV bucket provisioning for the
 * admission gate, mirroring the `src/bus/jetstream/provision.ts` pattern
 * (assert-or-create at boot; never drop on shutdown — KV state outlives the
 * process, and a restarted node inherits live counters).
 *
 * Bucket naming per the myelin admission contract (`myelin/specs/admission.md`
 * §2): `admission_{principal}_{stack}` — one bucket per (principal, stack),
 * the same granularity as the stack's JetStream domain, so the limiter's
 * availability is identical to the dispatch fabric's own.
 *
 * The nats.js KV view (`js.views.kv(name)`) creates the bucket when it does
 * not exist, so "provisioning" here is: peek at the backing stream
 * (`KV_{bucket}`) to report created-vs-exists honestly in the boot log, then
 * open the view. Failure is NON-FATAL by design — a `null` KV hands the gate
 * its degraded posture (node-local approximate buckets + loud `system.*`
 * event; anonymous fail-closed) rather than aborting boot: the failure
 * posture is a designed state, not an exception path (design §4.3 / Q1).
 */

import type { ProvisionJsm, ProvisionKv } from "../jetstream/types";
import { isNotFoundError } from "../jetstream/provision";

/**
 * Build the per-(principal, stack) admission bucket name (myelin admission
 * spec §2). Inputs are subject-grammar segments already (`[a-z0-9-]`);
 * anything outside the KV bucket-name charset is defensively mapped to `-`
 * so a malformed segment degrades to an odd bucket name rather than a boot
 * throw.
 */
export function admissionBucketName(principal: string, stack: string): string {
  const clean = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `admission_${clean(principal)}_${clean(stack)}`;
}

export type ProvisionAdmissionOutcome = "created" | "exists" | "unavailable";

export interface ProvisionAdmissionKvOpts {
  /**
   * Narrow JSM handle (from `runtime.jetstreamManager()`), or `null` when the
   * runtime is disabled / the manager could not be resolved. Only used to
   * report created-vs-exists — the KV open below is what actually creates.
   */
  jsm: ProvisionJsm | null;
  /**
   * Open (creating if absent) the KV bucket — `runtime.kvBucket(name)`.
   * Returns `null` when the runtime is disabled.
   */
  openKv: (bucket: string) => Promise<ProvisionKv | null>;
  bucket: string;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface ProvisionAdmissionKvResult {
  outcome: ProvisionAdmissionOutcome;
  /** The live KV handle, or `null` ⇒ the gate starts degraded (design §4.3). */
  kv: ProvisionKv | null;
}

/**
 * Provision (or assert presence of) the admission KV bucket. Idempotent —
 * safe on every boot. NEVER throws: every failure path resolves to
 * `{ outcome: "unavailable", kv: null }` with a loud warn, because the
 * admission gate has a DESIGNED degraded posture for exactly this state.
 */
export async function provisionAdmissionKv(
  opts: ProvisionAdmissionKvOpts,
): Promise<ProvisionAdmissionKvResult> {
  const log = opts.log ?? console;

  // Peek at the backing stream so the boot log reports created-vs-exists —
  // the same honesty `provisionReviewStream` gives streams. A peek failure
  // (no JSM, transport error) is non-fatal: the open below still decides.
  let preExisting: boolean | undefined;
  if (opts.jsm !== null) {
    try {
      await opts.jsm.streams.info(`KV_${opts.bucket}`);
      preExisting = true;
    } catch (err) {
      if (isNotFoundError(err)) {
        preExisting = false;
      } else {
        // Not a 404 — transport/auth trouble. Leave `preExisting` unknown and
        // let the open below surface the real failure (logged there).
        log.warn(
          `admission-provision: stream peek for bucket "${opts.bucket}" failed (${err instanceof Error ? err.message : String(err)}) — continuing to KV open`,
        );
      }
    }
  }

  let kv: ProvisionKv | null;
  try {
    kv = await opts.openKv(opts.bucket);
  } catch (err) {
    log.warn(
      `admission-provision: KV bucket "${opts.bucket}" open FAILED (${err instanceof Error ? err.message : String(err)}) — admission gate starts DEGRADED (node-local buckets; anonymous fail-closed)`,
    );
    return { outcome: "unavailable", kv: null };
  }
  if (kv === null) {
    log.warn(
      `admission-provision: KV bucket "${opts.bucket}" unavailable (runtime disabled / no JetStream) — admission gate starts DEGRADED (node-local buckets; anonymous fail-closed)`,
    );
    return { outcome: "unavailable", kv: null };
  }

  if (preExisting === false) {
    log.info(
      `admission-provision: created KV bucket "${opts.bucket}" (stream KV_${opts.bucket}, history=1)`,
    );
    return { outcome: "created", kv };
  }
  return { outcome: "exists", kv };
}
