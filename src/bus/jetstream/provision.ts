/**
 * cortex#338 — idempotent JetStream provisioning for cortex's ReviewConsumer
 * pull subscriptions (cortex#338).
 *
 * After cortex#337 the MyelinRuntime opens a NATS link even
 * when `nats.subjects: []`, so `subscribePull` returns a real subscriber.
 * That subscriber binds to a JetStream pull consumer via
 * `js.consumers.get(stream, durable)` — which throws if the stream OR
 * the durable doesn't exist server-side.
 *
 * Before #338 nothing in cortex provisioned either. Principals ran
 * `nats stream add` / `nats consumer add` by hand or deployed an
 * ops tool. Both are reproducible failure points.
 *
 * This module:
 *
 *   - `provisionReviewStream({ jsm, name, subjects, … })` — `info` then
 *     `add` on 404. Returns `"created"` / `"exists"` so the caller can
 *     log differently. Does NOT auto-update on config drift — logs a
 *     warning instead. Auto-update is too magic for the first cut.
 *     One exception (cortex#1503): subjects this stack needs that the
 *     live stream lacks are ADDED (never removed), because the stream
 *     name is fixed and two stacks of one principal on one NATS account
 *     share it.
 *
 *   - `provisionReviewConsumer({ jsm, stream, durable, … })` — same
 *     pattern for the per-agent durable pull consumer.
 *
 * Anti-criteria:
 *
 *   - Don't drop streams/consumers on shutdown — JetStream state
 *     outlives the process.
 *   - Don't auto-update on config drift in v1 — log + leave alone
 *     (except the additive subject union above; subjects are never
 *     removed and retention is never touched).
 *   - Disabled runtime → caller skips provisioning entirely (no JSM to
 *     call against).
 *
 * The two helpers accept a narrow `ProvisionJsm` shape — the subset of
 * nats.js's `JetStreamManager` we touch — so tests can pass a stub
 * without instantiating the full nats.js JS layer.
 */

// `node_modules/nats` enums are runtime values; importing them as
// values keeps the wire-config strings centralised in nats.js rather
// than duplicating literals here.
import { AckPolicy, DeliverPolicy, RetentionPolicy, StorageType } from "nats";
import type { ConsumerConfig, ConsumerInfo, StreamInfo } from "nats";

// Re-exported from the neutral types module so existing callers
// importing `ProvisionJsm` from this file keep working AND new
// callers (MyelinRuntime, future bus consumers) can import from
// `./types` without dragging review-specific code with them.
// Background: sage review on #338 round 3 (architecture).
export type { ProvisionJsm } from "./types";
import type { ProvisionJsm } from "./types";
import { DEFAULT_STREAM_MAX_BYTES } from "../../common/types/cortex-config";
import { missingSubjects, subjectCovers } from "./subject-set";

/**
 * Outcome of `provisionReviewStream`. Includes `config-drift-warning`
 * for the case where the live stream exists but its config differs
 * from what we'd create — see `describeStreamDrift`. Consumer
 * provisioning has no analogous drift surface in v1, so its outcome
 * is the narrower `ProvisionConsumerOutcome`. `subjects-extended`
 * (cortex#1503): the live stream lacked some of this stack's subjects and
 * gained them by additive union — another stack of the principal, sharing
 * the NATS account, owns the rest.
 */
export type ProvisionStreamOutcome =
  | "created"
  | "exists"
  | "subjects-extended"
  | "config-drift-warning";

/**
 * Outcome of `provisionReviewConsumer`. Narrower than the stream
 * outcome by design — v1 doesn't drift-check consumer configs (the
 * surface is small enough that principals rarely tune it; the
 * subtler-than-stream drift modes are best surfaced when a principal
 * hits one).
 */
export type ProvisionConsumerOutcome = "created" | "exists" | "updated";

/**
 * @deprecated Use `ProvisionStreamOutcome` or `ProvisionConsumerOutcome`
 * — the union here is wider than either helper actually returns and
 * forces callers to handle impossible cases (sage review on #338
 * round 4 — Maintainability). Kept as a transitional alias; remove
 * once no internal callers reference it.
 */
export type ProvisionOutcome = ProvisionStreamOutcome;

/** Logger the provisioning helpers write to. Defaults to `console`. */
export interface ProvisionLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface ProvisionStreamOpts {
  jsm: ProvisionJsm;
  /** Stream name. ReviewConsumer always binds to `"CODE_REVIEW"`. */
  name: string;
  /** Subject filter list. e.g. `["local.alice.default.tasks.code-review.*"]`. */
  subjects: readonly string[];
  /**
   * Max age in nanoseconds. Default 24h (`24 * 3600 * 1e9`). Stale
   * review tasks past this age are dropped — picks up the work-queue
   * semantic that an unclaimed task is effectively lost after a day.
   */
  maxAgeNs?: number;
  /**
   * Stream `max_bytes` cap. Default 64 MiB. Live deployment of #338
   * surfaced that NATS servers running with an account-level storage
   * reservation cap reject `max_bytes: -1` (unlimited) with
   * "insufficient storage resources available" even when raw disk is
   * abundant — so the default must be a finite RESERVATION, not unlimited.
   *
   * cortex#1197: the previous 512 MiB default was ~8000× the actual
   * footprint (these are interest-retention, max-age-bounded CONTROL-plane
   * streams holding KB), and it capped a stack at only TWO streams under
   * the common `max_file: 1gb` JetStream limit (2 × 512 MiB = the whole GB).
   * The third stream a dev-loop stack needs — `DEV_IMPLEMENT` (and the
   * release stream) — then failed to provision with "insufficient storage
   * resources", silently disabling the `dev.implement` consumer. 64 MiB
   * still absorbs ~100k typical envelopes yet fits ~16 streams per GB.
   * Principals can override via `cortex.yaml` `bus.review.maxBytes` once
   * that surface lands (cortex#341).
   */
  maxBytes?: number;
  /**
   * Optional logger. Defaults to `console`. Surfacing this lets tests
   * pin the boot-log shape and lets future deployments swap in a
   * structured logger.
   */
  log?: ProvisionLog;
}

export interface ProvisionConsumerOpts {
  jsm: ProvisionJsm;
  /** Stream the consumer binds to. */
  stream: string;
  /** Durable consumer name, e.g. `"cortex-review-consumer-alice_default-sage"` (see `reviewDurableNames`). */
  durable: string;
  /**
   * Optional narrow filter subject. Omitted → consumer claims every
   * message on the stream. Set to per-flavor subject if cortex
   * eventually wants per-flavor durables (#335 follow-up).
   */
  filterSubject?: string;
  /**
   * Max delivery attempts before JetStream terms the message. Default 5.
   */
  maxDeliver?: number;
  /**
   * Per-message ack deadline in NANOSECONDS. JetStream redelivers a message
   * that isn't acked within this window. Defaults to {@link DEFAULT_ACK_WAIT_NS}
   * (20 min) — comfortably above a review's wall-time so a healthy in-flight
   * review never triggers a redelivery (cortex#422). Left to the JetStream
   * default of 30s, a ~100s review redelivers mid-run and the consumer
   * re-runs the pipeline → duplicate review + duplicate forge post.
   */
  ackWaitNs?: number;
  /**
   * Delivery start policy at consumer-creation time. Defaults to
   * {@link DeliverPolicy.All} — the review-consumer contract, where the
   * stream is interest-retained and replaying its (short) backlog is
   * desirable. Pass {@link DeliverPolicy.New} for a fresh durable on a
   * *limits*-retained stream that carries long-lived history (e.g. the
   * REFLEX stream's activation events): "All" would replay every
   * historical fire on first bind and re-dispatch them. Only honoured
   * when the consumer is created; an existing durable's deliver_policy is
   * never reconciled (JetStream forbids changing it in place).
   */
  deliverPolicy?: DeliverPolicy;
  log?: ProvisionLog;
}

const DEFAULT_MAX_AGE_NS = 24 * 3600 * 1_000_000_000;
const DEFAULT_MAX_BYTES = DEFAULT_STREAM_MAX_BYTES;
const DEFAULT_MAX_DELIVER = 5;
/**
 * Default per-message ack deadline: 20 minutes in nanoseconds. Sized well
 * above a review's wall-time (sage's per-lens timeout is 600s; the pipeline
 * self-terminates long before this) so a healthy in-flight review never
 * redelivers. The JetStream default is 30s — far below a ~100s review — which
 * caused the duplicate-review/duplicate-post bug (cortex#422).
 */
export const DEFAULT_ACK_WAIT_NS = 20 * 60 * 1_000_000_000;

/**
 * Provision (or assert presence of) the JetStream stream that carries
 * `tasks.code-review.*` envelopes. Idempotent — safe to call on every
 * boot.
 */
export async function provisionReviewStream(
  opts: ProvisionStreamOpts,
): Promise<ProvisionStreamOutcome> {
  const log = opts.log ?? console;
  const maxAgeNs = opts.maxAgeNs ?? DEFAULT_MAX_AGE_NS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let existing: StreamInfo | null = null;
  try {
    existing = await opts.jsm.streams.info(opts.name);
  } catch (err) {
    // nats.js surfaces "stream not found" as a thrown error with
    // api_error.code === 404 OR a message containing "not found".
    // Anything else (auth, network) should propagate so the caller
    // can decide whether to abort boot or continue degraded.
    if (!isNotFoundError(err)) {
      throw err;
    }
  }

  if (existing) {
    // cortex#1503 — add this stack's missing subjects before judging drift, so
    // a stream another stack of the principal created is extended rather than
    // left capturing only that stack's subjects.
    const extension = await extendStreamSubjects(opts.jsm, opts.name, existing, opts.subjects, log);
    const drift = describeStreamDrift(extension.info, opts.subjects, maxAgeNs);
    if (drift !== null) {
      log.warn(
        `jetstream-provision: stream "${opts.name}" exists but config drifts (${drift}); leaving alone (v1 policy — no auto-update). Update manually with \`nats stream edit\` if intentional.`,
      );
      return "config-drift-warning";
    }
    return extension.extended ? "subjects-extended" : "exists";
  }

  await opts.jsm.streams.add({
    name: opts.name,
    subjects: [...opts.subjects],
    // `Interest` retention (not Workqueue): JetStream keeps a message
    // only while at least one consumer has unacked interest in it.
    // Workqueue would block the per-agent-durable model — each new
    // unfiltered durable on the same subject space conflicts with the
    // first under Workqueue semantics. Interest lets sage / fern /
    // future reviewers each maintain their own durable on the same
    // stream without provisioning collisions. Competing-consumer
    // semantics (one of N agents claims a given task) are layered at
    // the consumer level by sharing a durable name; cortex#237's
    // current per-agent durable model is fan-out per agent, which is
    // the intended shape for sage#43 + fern routing (each agent sees
    // every task it claims a capability for, then the routing layer
    // decides via the cortex.yaml `provided_by` table).
    retention: RetentionPolicy.Interest,
    storage: StorageType.File,
    max_age: maxAgeNs,
    max_msgs: -1,
    max_bytes: maxBytes,
    num_replicas: 1,
  });
  log.info(
    `jetstream-provision: created stream "${opts.name}" (subjects=[${opts.subjects.join(", ")}], retention=interest, max_age=${Math.round(maxAgeNs / 1_000_000_000)}s, max_bytes=${Math.round(maxBytes / 1024 / 1024)}MiB)`,
  );
  return "created";
}

/**
 * Bounded retries for the additive subject union. JetStream's stream update
 * has no compare-and-swap: two stacks extending the same stream at the same
 * instant can each write the subject set they read, dropping the other's
 * addition. Re-reading after every write and retrying closes the window for
 * the writer that loses; a stack whose addition is dropped AFTER its own
 * verification is repaired on its next boot (documented residual, cortex#1503).
 */
const MAX_SUBJECT_UNION_ATTEMPTS = 3;

/**
 * cortex#1503 — add the desired subjects the live stream does not yet cover.
 * Never removes a subject (other stacks sharing the stream own them) and
 * never touches any other field: the update re-sends the live config with
 * only `subjects` grown. A desired subject that partially overlaps a live one
 * is not added, and a rejected update (no stream-edit permission, a subject
 * another stream owns) is logged — in both cases `describeStreamDrift` then
 * reports the uncovered subjects and the caller keeps the v1 warn-and-leave.
 */
async function extendStreamSubjects(
  jsm: ProvisionJsm,
  name: string,
  existing: StreamInfo,
  desired: readonly string[],
  log: ProvisionLog,
): Promise<{ info: StreamInfo; extended: boolean }> {
  let info = existing;
  let extended = false;
  for (let attempt = 1; attempt <= MAX_SUBJECT_UNION_ATTEMPTS; attempt++) {
    const live = info.config.subjects;
    const missing = missingSubjects(live, desired);
    if (missing.length === 0) return { info, extended };
    try {
      await jsm.streams.update(name, { ...info.config, subjects: [...live, ...missing] });
    } catch (err) {
      log.warn(
        `jetstream-provision: could not extend stream "${name}" subjects with [${missing.join(", ")}] (${err instanceof Error ? err.message : String(err)}) (cortex#1503)`,
      );
      return { info, extended };
    }
    log.info(
      `jetstream-provision: extended stream "${name}" subjects with [${missing.join(", ")}] (shared by another stack of this principal — cortex#1503)`,
    );
    extended = true;
    // Verify against a fresh read: a concurrent writer may have dropped ours.
    info = await jsm.streams.info(name);
  }
  return { info, extended };
}

/** Read a consumer, or `null` when it doesn't exist. Other errors propagate. */
async function consumerInfoOrNull(
  jsm: ProvisionJsm,
  stream: string,
  durable: string,
): Promise<ConsumerInfo | null> {
  try {
    return await jsm.consumers.info(stream, durable);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

/** A legacy durable is provably this stack's only when its filter is exactly this durable's filter. */
function isLegacyOurs(legacy: ConsumerInfo, filterSubject: string | undefined): boolean {
  const legacyFilter = legacy.config.filter_subject ?? "";
  return filterSubject !== undefined && filterSubject !== "" && legacyFilter === filterSubject;
}

/**
 * Idle = nothing in flight and nobody pulling. The server prunes pull
 * requests whose connection has gone when it builds consumer info, so
 * `num_waiting > 0` means a live puller (e.g. an old-version Cortex runtime of
 * the same stack still running), not a request left by the stopped process.
 */
function isIdle(c: ConsumerInfo): boolean {
  return c.num_ack_pending === 0 && c.num_waiting === 0;
}

/** Outcome of {@link provisionStackScopedConsumer}: the durable to bind, and what provisioning did. */
export interface StackScopedConsumerResult {
  /** The durable `consumer.start({ durable })` must bind this boot. */
  durable: string;
  /** `deferred`: the busy legacy durable is bound this boot; migration retries next boot. */
  outcome: ProvisionConsumerOutcome | "deferred";
}

/**
 * cortex#1503 — provision a stack-scoped durable that replaces a pre-#1503
 * unscoped one (`legacyDurable`), and say which durable to bind.
 *
 * The legacy durable is read BEFORE the scoped one can be created, and it
 * never goes through the filter-drift recreate in {@link ensureConsumer}
 * (which would rewrite another stack's durable). Cases:
 *
 *  - No legacy durable → the scoped durable with the caller's default policy
 *    (a fresh stack behaves exactly as before).
 *  - Legacy filter is another stack's (or empty) → never touched. The scoped
 *    durable starts from `New`: the legacy's positions say nothing about this
 *    stack's subjects, and `All` would re-run reviews.
 *  - Legacy is ours and idle → the scoped durable starts at
 *    `legacy.delivered.stream_seq + 1` (nothing already delivered is
 *    replayed; every request stored after, including one published during the
 *    upgrade, is delivered), then the legacy durable is deleted.
 *  - Legacy is ours and busy, scoped absent → migration DEFERRED: the legacy
 *    durable is bound this boot. A live legacy puller keeps competing-consumer
 *    semantics (no double delivery), and ack-pending requests redeliver as on
 *    any restart. The first idle boot migrates.
 *  - Legacy is ours and busy, scoped present → an old-version runtime of this
 *    stack recreated it after migration. Kept and warned: the two durables
 *    double-deliver until every runtime of the stack is upgraded.
 */
export async function provisionStackScopedConsumer(
  opts: ProvisionConsumerOpts & { legacyDurable: string },
): Promise<StackScopedConsumerResult> {
  const log = opts.log ?? console;
  const { legacyDurable } = opts;
  if (legacyDurable === opts.durable) {
    return { durable: opts.durable, outcome: await ensureConsumer(opts, undefined) };
  }

  let legacy: ConsumerInfo | null;
  let scopedExists: boolean;
  try {
    legacy = await consumerInfoOrNull(opts.jsm, opts.stream, legacyDurable);
    scopedExists = (await consumerInfoOrNull(opts.jsm, opts.stream, opts.durable)) !== null;
  } catch (err) {
    // Unknown state: never replay, never touch the legacy durable.
    log.warn(
      `jetstream-provision: could not read durables "${legacyDurable}"/"${opts.durable}" on stream "${opts.stream}" (${err instanceof Error ? err.message : String(err)}) — "${opts.durable}" starts from New if created; legacy left in place (cortex#1503)`,
    );
    return {
      durable: opts.durable,
      outcome: await ensureConsumer(opts, { deliver_policy: DeliverPolicy.New }),
    };
  }

  if (legacy === null) {
    return { durable: opts.durable, outcome: await ensureConsumer(opts, undefined) };
  }

  if (!isLegacyOurs(legacy, opts.filterSubject)) {
    const legacyFilter = legacy.config.filter_subject ?? "";
    log.info(
      `jetstream-provision: legacy durable "${legacyDurable}" on stream "${opts.stream}" filters "${legacyFilter || "<none>"}", not this stack's "${opts.filterSubject ?? "<none>"}" — left in place (cortex#1503)`,
    );
    return {
      durable: opts.durable,
      outcome: await ensureConsumer(opts, scopedExists ? undefined : { deliver_policy: DeliverPolicy.New }),
    };
  }

  if (!isIdle(legacy) && !scopedExists) {
    log.warn(
      `jetstream-provision: legacy durable "${legacyDurable}" on stream "${opts.stream}" is busy (ack_pending=${legacy.num_ack_pending}, waiting=${legacy.num_waiting}) — binding it this boot; migration to "${opts.durable}" retries on the next boot (cortex#1503)`,
    );
    // Same filter, so this only reconciles ack_wait (never a recreate).
    await ensureConsumer({ ...opts, durable: legacyDurable }, undefined);
    return { durable: legacyDurable, outcome: "deferred" };
  }

  const outcome = await ensureConsumer(
    opts,
    scopedExists
      ? undefined
      : { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: legacy.delivered.stream_seq + 1 },
  );
  if (!isIdle(legacy)) {
    log.warn(
      `jetstream-provision: legacy durable "${legacyDurable}" on stream "${opts.stream}" is busy (ack_pending=${legacy.num_ack_pending}, waiting=${legacy.num_waiting}) although "${opts.durable}" exists — an old-version runtime of this stack recreated it; both durables receive this stack's requests until every runtime is upgraded (cortex#1503)`,
    );
    return { durable: opts.durable, outcome };
  }
  try {
    await opts.jsm.consumers.delete(opts.stream, legacyDurable);
    log.info(
      `jetstream-provision: removed legacy durable "${legacyDurable}" on stream "${opts.stream}" (replaced by "${opts.durable}", cortex#1503)`,
    );
  } catch (err) {
    // The scoped durable is provisioned; a failed delete only leaves an idle
    // orphan behind, retried on the next boot.
    log.warn(
      `jetstream-provision: removing legacy durable "${legacyDurable}" on stream "${opts.stream}" failed (${err instanceof Error ? err.message : String(err)}) — retried next boot (cortex#1503)`,
    );
  }
  return { durable: opts.durable, outcome };
}

/**
 * Provision (or assert presence of) a per-agent durable pull consumer on
 * the given stream. Idempotent — safe on every boot.
 */
export async function provisionReviewConsumer(
  opts: ProvisionConsumerOpts,
): Promise<ProvisionConsumerOutcome> {
  return ensureConsumer(opts, undefined);
}

/**
 * The idempotent ensure behind {@link provisionReviewConsumer}. `start`
 * overrides the caller's deliver policy on a genuine first create (the
 * cortex#1503 migration start position); a filter-drift recreate still
 * forces `New`.
 */
async function ensureConsumer(
  opts: ProvisionConsumerOpts,
  start: Pick<ConsumerConfig, "deliver_policy" | "opt_start_seq"> | undefined,
): Promise<ProvisionConsumerOutcome> {
  const log = opts.log ?? console;
  const maxDeliver = opts.maxDeliver ?? DEFAULT_MAX_DELIVER;
  const ackWaitNs = opts.ackWaitNs ?? DEFAULT_ACK_WAIT_NS;

  // Set when the drift branch deletes a durable to migrate its (immutable)
  // filter_subject — the recreated durable then starts from `New` (see below).
  let recreatedForFilter = false;

  try {
    const existing = await opts.jsm.consumers.info(opts.stream, opts.durable);
    // cortex#1186 — `filter_subject` is IMMUTABLE on a JetStream durable, so a
    // drift can't be patched in place: it must be deleted + recreated. This is
    // the migration path for durables created before the per-scope filter was
    // wired (those carry `filter_subject: ""` and therefore claim EVERY message
    // on the stream — the multi-durable fan-out that double-posts a review).
    //
    // SAFETY: the recreated durable is forced to `DeliverPolicy.New` (below), so
    // it does NOT replay the stream backlog — a migration must not re-review +
    // re-post every historical PR. A message in-flight on the OLD durable at
    // migration time is dropped (the new durable starts from "now"); that is the
    // safe direction for a one-shot fix (a missed review is re-fireable; a
    // re-posted one is not). Provisioning runs at boot, BEFORE the consumer
    // pulls, so there is no concurrently-processing delivery to race.
    const desiredFilter = opts.filterSubject ?? "";
    const existingFilter = existing.config.filter_subject ?? "";
    if (existingFilter !== desiredFilter) {
      log.info(
        `jetstream-provision: consumer "${opts.durable}" filter drift ("${existingFilter || "<none>"}" → "${desiredFilter || "<none>"}") — recreating durable from New (cortex#1186)`,
      );
      await opts.jsm.consumers.delete(opts.stream, opts.durable);
      recreatedForFilter = true;
      // Fall through to the create path below (re-applies the correct filter).
    } else {
      // cortex#422 — `ack_wait` is the one consumer field we reconcile in place
      // (no filter drift, so an in-place update is legal). The original durable
      // was created without it (JetStream default 30s); update it so a redeploy
      // fixes live durables without a manual `nats consumer rm`. Other fields
      // stay un-reconciled (v1 policy).
      if (existing.config.ack_wait !== ackWaitNs) {
        await opts.jsm.consumers.update(opts.stream, opts.durable, {
          ...existing.config,
          ack_wait: ackWaitNs,
        });
        log.info(
          `jetstream-provision: updated consumer "${opts.durable}" ack_wait ${Math.round((existing.config.ack_wait ?? 0) / 1_000_000_000)}s → ${Math.round(ackWaitNs / 1_000_000_000)}s (cortex#422)`,
        );
        return "updated";
      }
      return "exists";
    }
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw err;
    }
  }

  const cfg: Partial<ConsumerConfig> = {
    durable_name: opts.durable,
    ack_policy: AckPolicy.Explicit,
    // A filter-drift recreate forces `New` so the migration never replays the
    // backlog (cortex#1186). A genuine first create honours the caller's policy.
    // cortex#1503: a durable replacing a legacy one starts where `start` says.
    deliver_policy: recreatedForFilter
      ? DeliverPolicy.New
      : (start?.deliver_policy ?? opts.deliverPolicy ?? DeliverPolicy.All),
    max_deliver: maxDeliver,
    ack_wait: ackWaitNs,
  };
  if (!recreatedForFilter && start?.opt_start_seq !== undefined) {
    cfg.opt_start_seq = start.opt_start_seq;
  }
  if (opts.filterSubject !== undefined) {
    cfg.filter_subject = opts.filterSubject;
  }
  await opts.jsm.consumers.add(opts.stream, cfg);
  log.info(
    `jetstream-provision: created consumer "${opts.durable}" on stream "${opts.stream}" (ack=explicit, max_deliver=${maxDeliver}, ack_wait=${Math.round(ackWaitNs / 1_000_000_000)}s${opts.filterSubject ? `, filter=${opts.filterSubject}` : ""})`,
  );
  return "created";
}

/**
 * Recognise a JetStream "not found" error across the nats.js shapes we
 * see in this codebase. Exported for tests that simulate the no-stream
 * / no-consumer paths via a stub jsm.
 *
 * - nats.js 2.x throws errors whose `.api_error?.err_code === 10059`
 *   (stream not found) or `10014` (consumer not found). The message
 *   forms also include "stream not found" / "consumer not found".
 * - Recogniser is permissive on the message string so a future nats.js
 *   error-class refactor doesn't silently break the recogniser; the
 *   `err_code` path is the authoritative recognition.
 */
export function isNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const apiError = (err as { api_error?: { err_code?: number; code?: number } })
    .api_error;
  const code = apiError?.err_code ?? apiError?.code;
  if (code === 10059 || code === 10014 || code === 404) return true;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /not found|no.*stream.*matched|404/i.test(msg);
}

/**
 * Describe stream-config drift between the live `StreamInfo` and the
 * config we'd have created. Returns `null` when the relevant fields
 * match, otherwise a short human-readable string for the log line.
 *
 * Drift detection is deliberately narrow — only the fields that
 * meaningfully affect routing (`subjects`) and retention (`max_age`).
 * Principals tuning `max_bytes` / `num_replicas` for their own reasons
 * should NOT see a drift warning every boot.
 */
export function describeStreamDrift(
  existing: StreamInfo,
  expectedSubjects: readonly string[],
  expectedMaxAgeNs: number,
): string | null {
  const cfg = existing.config;
  const actualSubjects = cfg.subjects;
  // cortex#1503 — drift means some expected subject is NOT captured by the
  // live stream. Extra live subjects are not drift: another stack of the
  // principal sharing the NATS account owns them, and a deliberately broader
  // subject (arc's `local.*.*.tasks.code-review.>`, or `local.>`) captures
  // ours. Coverage is order-independent, so a re-ordered live config never
  // false-warns (sage review on #338 round 3).
  const uncovered = [...new Set(expectedSubjects)].filter(
    (e) => !actualSubjects.some((a) => subjectCovers(a, e)),
  );
  if (uncovered.length > 0) {
    return `subjects differ (expected {${[...new Set(expectedSubjects)].sort().join(", ")}}, got {${[...new Set(actualSubjects)].sort().join(", ")}}; not captured: {${uncovered.sort().join(", ")}})`;
  }
  // Allow ±1s slack on max_age to absorb floating-point round-trips
  // through the wire JSON.
  if (Math.abs(cfg.max_age - expectedMaxAgeNs) > 1_000_000_000) {
    return `max_age differs (expected ${expectedMaxAgeNs}ns, got ${cfg.max_age}ns)`;
  }
  return null;
}
