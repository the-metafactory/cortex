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
    type: "system.verifier.self_check" as const,
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
