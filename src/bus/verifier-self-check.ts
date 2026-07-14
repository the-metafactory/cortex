/**
 * cortex#480 — boot-time self-signed envelope sanity check.
 *
 * At boot, after the chain verifier is wired into the dispatch listeners,
 * publish a tiny envelope signed by the receiving stack's own NKey and
 * run it through `verifySignedByChain` using the SAME options shape the
 * production listeners use. If the round-trip fails, log a clear error
 * — the runner is broken in a way that drops adapter-originated chat
 * silently otherwise (cortex#480 root cause).
 *
 * **Why this exists** (per cortex#480 issue body):
 * The bug it was designed to catch (verifier rejecting `did:mf:<stack>`
 * as `unknown_agent`) shipped to production because no boot-time check
 * exercised the verifier against the exact identity it would receive
 * on the wire. Adding this sanity check closes the observability gap
 * — a future regression in the stack-identity short-circuit, the
 * `nkeyToBase64Pubkey` bridge, or the myelin Principal registry shape
 * will fail at boot rather than at first Discord chat.
 *
 * **Failure mode**: stderr WARNING line — boot continues. A failing
 * self-check is not fatal because tests + CI catch the structural cases
 * upstream; this is the production-side last-line-of-defence. The
 * stderr line is grep-friendly (`verifier-self-check`) so the
 * pilot-loop / on-call can pattern-match in `cortex-meta-factory.error.log`.
 *
 * **What's NOT verified here:** the policy gate, the dispatch handler,
 * the substrate dispatch — those are downstream of the verifier. The
 * check exists to validate that a self-signed envelope IS admitted by
 * the verifier, not that the rest of the pipeline accepts it.
 */

import { signEnvelope } from "@the-metafactory/myelin/identity";
import type { TrustResolver } from "../common/agents/trust-resolver";
import { verifySignedByChain } from "./verify-signed-by-chain";
import type { Envelope } from "./myelin/envelope-validator";

export interface VerifierSelfCheckOpts {
  /** The stack's signing DID (e.g. `did:mf:andreas-meta-factory`). */
  stackIdentity: string;
  /** The stack's NKey public key (U-prefixed base32). */
  stackNKeyPub: string;
  /** The 32-byte raw ed25519 seed bytes (from `BusEnvelopeSigner.rawSeedBytes`). */
  stackSeedBytes: Uint8Array;
  /** Trust resolver wired into the production listeners. */
  resolver: TrustResolver;
  /** Receiving agent id — same as production listeners. */
  receivingAgentId: string;
  /** Principal id — same as production listeners. */
  principalId: string;
  /** Optional logger seam (tests; default: console / stderr). */
  log?: (line: string) => void;
  err?: (line: string) => void;
}

export interface VerifierSelfCheckResult {
  /** True when the self-signed envelope round-tripped cleanly. */
  ok: boolean;
  /** Human-readable detail; populated on both success and failure. */
  detail: string;
}

/**
 * Run the self-check. Returns the result rather than throwing — callers
 * decide whether to escalate (today: log + continue boot).
 */
export async function runVerifierSelfCheck(
  opts: VerifierSelfCheckOpts,
): Promise<VerifierSelfCheckResult> {
  const log = opts.log ?? ((line: string) => {
    console.log(line);
  });
  const err = opts.err ?? ((line: string) => {
    process.stderr.write(line + "\n");
  });

  // Build a minimal envelope shape that satisfies the validator. We do
  // NOT use the production envelope-builder helpers because we want the
  // check to be self-contained and trivially auditable — the whole point
  // is to flag wiring drift, so depending on the same wiring this is
  // testing would defeat the purpose.
  const base = {
    id: crypto.randomUUID(),
    source: `${opts.principalId}.cortex.self-check`,
    type: "system.verifier.self-check" as const,
    timestamp: new Date().toISOString(),
    sovereignty: {
      classification: "local" as const,
      data_residency: "NZ" as const,
      max_hop: 0,
      frontier_ok: false,
      model_class: "any" as const,
    },
    payload: { note: "cortex#480 boot-time self-check" },
  };

  let signed: Envelope;
  try {
    // `signEnvelope` expects base64-encoded raw seed; convert from raw
    // bytes the same way `BusEnvelopeSigner` → MyelinRuntime conversion
    // does internally.
    const seedB64 = Buffer.from(opts.stackSeedBytes).toString("base64");
    // signEnvelope returns a myelin envelope shape with the new
    // signed_by stamp appended. Structurally compatible with cortex's
    // Envelope (which carries a back-compat union shim on `signed_by`)
    // so the return assignment requires no cast.
    signed = await signEnvelope(base, seedB64, opts.stackIdentity);
  } catch (signErr) {
    const detail = signErr instanceof Error ? signErr.message : String(signErr);
    err(
      `verifier-self-check: FAILED to sign self-check envelope: ${detail} ` +
        `— stack signing keypair may be malformed. Outbound publish will ` +
        `produce broken stamps; adapter-originated chat will be dropped by ` +
        `peer verifiers. See cortex#480 + cortex.yaml stack.nkey_seed_path.`,
    );
    return { ok: false, detail: `sign failed: ${detail}` };
  }

  try {
    const result = await verifySignedByChain(signed, {
      resolver: opts.resolver,
      receivingAgentId: opts.receivingAgentId,
      rejectEmpty: false,
      cryptoVerify: true,
      principalId: opts.principalId,
      stackIdentity: opts.stackIdentity,
      stackNKeyPub: opts.stackNKeyPub,
    });
    if (result.valid) {
      log(
        `cortex: verifier-self-check OK — self-signed envelope round-tripped ` +
          `through verifySignedByChain (stack=${opts.stackIdentity})`,
      );
      return { ok: true, detail: "self-signed round-trip verified" };
    }
    const reason = result.reason.kind;
    const fullReason =
      result.reason.kind === "crypto_verify_failed"
        ? `${reason} (${result.reason.myelinReason})`
        : reason;
    err(
      `verifier-self-check: FAILED — self-signed envelope REJECTED at chain ` +
        `index ${result.rejectedAt} with reason=${fullReason}. ` +
        `Adapter-originated dispatches (Discord/Mattermost/Slack chat) will ` +
        `be silently dropped by the runner. This is the cortex#480 class of ` +
        `bug; check stackIdentity (${opts.stackIdentity}) + stackNKeyPub ` +
        `wiring + signing-key consistency.`,
    );
    return { ok: false, detail: `rejected: ${fullReason}` };
  } catch (verifyErr) {
    const detail = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
    err(
      `verifier-self-check: FAILED — verifySignedByChain threw: ${detail}`,
    );
    return { ok: false, detail: `threw: ${detail}` };
  }
}

// =============================================================================
// TC-1b (#632) — posture-aware boot gate
// =============================================================================

/**
 * The three settable `security.signing` postures, re-exported here so the
 * boot gate can be unit-tested without importing the full cortex-config
 * schema graph.
 */
export type SigningPosture = "off" | "permissive" | "enforce";

/**
 * Inputs to the posture-aware boot self-check. A subset of the boot context
 * in `src/cortex.ts`: the signing posture plus the (possibly-absent) stack
 * identity captured at signer attach. When `identity` is `undefined` the
 * stack has NO usable signing identity wired (no seed, or seed load failed).
 */
export interface BootVerifierSelfCheckOpts {
  /** Resolved `config.security.signing`. */
  posture: SigningPosture;
  /**
   * The stack identity captured at signer attach, or `undefined` when no
   * signing identity is wired. Under `enforce` a `undefined` identity is a
   * fatal misconfiguration (the boot gate throws); under `off`/`permissive`
   * it is the expected unsigned-dev shape (the gate no-ops).
   */
  identity:
    | {
        /** Stack signing DID — `signer.principal`. */
        stackIdentity: string;
        /** Stack NKey public key. */
        stackNKeyPub: string;
        /** Raw 32-byte ed25519 seed bytes — `signer.rawSeedBytes`. */
        stackSeedBytes: Uint8Array;
      }
    | undefined;
  /** Trust resolver wired into the production listeners. */
  resolver: TrustResolver;
  /** Receiving agent id — same as production listeners. */
  receivingAgentId: string;
  /** Principal id — same as production listeners. */
  principalId: string;
  /** Optional logger seams (tests; default console / stderr). */
  log?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * TC-1b boot gate around {@link runVerifierSelfCheck}, posture-aware per
 * `docs/design-trust-confidentiality.md` §4 Phase 1.1b
 * ("`verifier-self-check` passes on every stack at boot").
 *
 * Behaviour by posture:
 *
 *   - **`enforce`** — a stack serving SIGNED traffic MUST have a valid,
 *     self-verifiable signing identity. If `identity` is missing (no seed /
 *     load failed) OR the self-check round-trip fails, this **throws** so the
 *     boot path aborts rather than silently serving traffic peers will reject.
 *     A passing self-check returns normally.
 *   - **`permissive`** — run the self-check when an identity is wired and WARN
 *     (do not throw) on failure; no-op when no identity is wired. This is the
 *     shadow rung: prove signing against live boot before gating.
 *   - **`off`** — advisory. Run the self-check only when an identity happens
 *     to be wired (observability), WARN on failure, never throw; no-op when
 *     unsigned (today's dev default).
 *
 * Throwing (only under `enforce`) is the fail-fast contract: the caller does
 * NOT wrap this in a swallow — a thrown error propagates to the CLI exit so
 * launchd / the principal sees the refusal.
 */
export async function bootVerifierSelfCheck(
  opts: BootVerifierSelfCheckOpts,
): Promise<void> {
  const err = opts.err ?? ((line: string) => {
    process.stderr.write(line + "\n");
  });

  // No signing identity wired.
  if (opts.identity === undefined) {
    if (opts.posture === "enforce") {
      // Fail fast: enforce with no signing identity means every outbound
      // envelope would be unsigned and every inbound empty-chain rejected —
      // the stack cannot serve. Refuse to boot with an actionable message.
      throw new Error(
        "verifier-self-check: REFUSING TO BOOT — security.signing=enforce but no " +
          "stack signing identity is wired. Provision one with " +
          "`cortex provision-stack` (writes stack.nkey_seed_path chmod 600 + " +
          "registers the pubkey), set stack.nkey_seed_path in cortex.yaml, then " +
          "restart. See docs/design-trust-confidentiality.md §Phase 1.1b.",
      );
    }
    // off / permissive with no identity — the expected unsigned-dev shape.
    // Nothing to check; stay silent (the unsigned-publish WARNING already
    // fired upstream at signer-attach).
    return;
  }

  const result = await runVerifierSelfCheck({
    stackIdentity: opts.identity.stackIdentity,
    stackNKeyPub: opts.identity.stackNKeyPub,
    stackSeedBytes: opts.identity.stackSeedBytes,
    resolver: opts.resolver,
    receivingAgentId: opts.receivingAgentId,
    principalId: opts.principalId,
    ...(opts.log !== undefined && { log: opts.log }),
    ...(opts.err !== undefined && { err: opts.err }),
  });

  if (result.ok) return;

  if (opts.posture === "enforce") {
    // Fail fast: the stack has an identity but it does not round-trip through
    // the verifier — serving SIGNED traffic with it would silently drop every
    // adapter-originated dispatch. Refuse to boot.
    throw new Error(
      `verifier-self-check: REFUSING TO BOOT — security.signing=enforce and the ` +
        `stack signing identity (${opts.identity.stackIdentity}) failed the boot ` +
        `self-check: ${result.detail}. The verifier would reject this stack's own ` +
        `signatures; fix the stack.nkey_pub / registration / signing-key consistency ` +
        `before serving signed traffic.`,
    );
  }

  // off / permissive — advisory. runVerifierSelfCheck already logged the
  // detailed FAILED line via `err`; add a posture note so the principal knows
  // the boot deliberately continued under the non-enforcing posture.
  err(
    `verifier-self-check: continuing boot under signing=${opts.posture} despite ` +
      `failed self-check (advisory; set signing=enforce to fail fast).`,
  );
}
