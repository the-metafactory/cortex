/**
 * R26 P1 (cortex#1371) — the substrate admission module: the KV-arbitrated
 * AdmissionGate (distributed token bucket + in-flight lease counter) at the
 * spawn gate, per `docs/design-substrate-rate-limiting.md` (Design B) and the
 * myelin admission contract (`myelin/specs/admission.md`, myelin#195).
 *
 * Layout:
 *   - `state.ts`     — pure entry formats + refill/prune/check/consume rules
 *   - `provision.ts` — idempotent KV bucket provisioning (boot path)
 *   - `gate.ts`      — the AdmissionGate: CAS arbitration, tiers 1–2,
 *                      degrade-local posture, anonymous fail-closed
 *   - `refusal-seam.ts` — RFC-0010 §2.4 seam-consistency op (mirror-kind ↔
 *                      transport-token agreement) + the §2.2 kind registry
 *
 * Config lives in `policy.admission` (`src/common/types/admission.ts`);
 * enforcement point 1 is the runner dispatch-listener (post-policy,
 * pre-spawn). Absent config ⇒ nothing here is constructed (CO-4 inertness).
 */

export {
  AdmissionGate,
  AdmissionKeyError,
  type AdmissionCheckRequest,
  type AdmissionGateOptions,
  type AdmissionLease,
  type AdmissionOutcome,
  type AdmissionTierName,
  type DegradeMode,
} from "./gate";
export {
  checkSeamConsistency,
  dispositionForRefusalKind,
  isMirrorRefusalKind,
  MIRROR_REFUSAL_KINDS,
  SEAM_MISMATCH_WARNING,
  type MirrorRefusalKind,
  type RefusalKind,
  type SeamConsistency,
  type SeamToken,
} from "./refusal-seam";
export {
  admissionBucketName,
  provisionAdmissionKv,
  type ProvisionAdmissionKvOpts,
  type ProvisionAdmissionKvResult,
  type ProvisionAdmissionOutcome,
} from "./provision";
export {
  DEFAULT_LEASE_TTL_MS,
  RATE_WINDOW_NAMES,
  WINDOW_MS,
  type InflightEntry,
  type InflightLease,
  type RateEntry,
  type RateWindowName,
  type RateWindowState,
} from "./state";
