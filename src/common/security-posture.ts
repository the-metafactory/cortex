/**
 * TC-0 (Trust & Confidentiality, #628) — security-posture → boot-knob resolver.
 *
 * The `security:` block in cortex.yaml (`src/common/types/config.ts`) carries
 * three independent toggles (`signing`, `encryption.*`, `transport.mtls`). This
 * module is the single, DRY mapping from the `signing` toggle to the concrete
 * verifier/signer knobs that `src/cortex.ts` sets at boot. `encryption.*` and
 * `transport.mtls` are SCHEMA-ONLY for now (later slices consume them) — this
 * resolver deliberately does NOT read them.
 *
 * ## DECIDED mapping (a security decision — do not improvise)
 *
 * | `signing`     | attach signer?           | `cryptoVerify` | `rejectEmpty` | `signFailureMode` |
 * | ------------- | ------------------------ | -------------- | ------------- | ----------------- |
 * | `off`         | never (publish unsigned) | true (cheap)   | false         | `"fallback"`      |
 * | `permissive`  | iff a stack seed exists  | true           | false         | `"fallback"`      |
 * | `enforce`     | iff a stack seed exists  | true           | true (reject) | `"drop"`          |
 *
 * - **off** — never attach a signer (publish unsigned). On verify, never reject
 *   (`rejectEmpty: false`, `signFailureMode: "fallback"`). `cryptoVerify` stays
 *   `true` for cheap observability but MUST NOT reject (guaranteed by
 *   `rejectEmpty: false`).
 * - **permissive** — attach the signer IF a stack seed is configured (today's
 *   behaviour). Verify but never reject.
 * - **enforce** — attach signer; REJECT unsigned/invalid envelopes
 *   (`rejectEmpty: true`, `signFailureMode: "drop"`).
 *
 * ## Backward-compat invariant (load-bearing)
 *
 * Most dev stacks declare NO `stack.nkey_seed_path` → already unsigned today.
 * For such a stack the DEFAULT posture (`signing` defaulting to `off`) MUST
 * produce behaviour identical to today: already unsigned, non-rejecting verify
 * (`rejectEmpty: false`, `signFailureMode: "fallback"`). The
 * `__tests__/security-posture.test.ts` backward-compat case pins this.
 *
 * ## Seed-aware default (cortex#1000)
 *
 * The TC-0 decision-for-review ("seed-configured stacks must OPT IN to
 * signing") was revised by the cortex#1000 forged-stamp finding: a stack that
 * configures `stack.nkey_seed_path` but never sets `security.signing` now
 * DEFAULTS to `permissive` — the loader (`applySeedAwareSigningDefault`,
 * `src/common/config/loader.ts`) bumps the raw config before the Zod parse.
 * An EXPLICIT `signing: off` is still respected (boot warns on the
 * seed-present-but-off combination). This resolver is unchanged by that —
 * it still maps whatever mode arrives to the same knobs.
 */

import type { AgentConfig } from "./types/config";

/** The parsed `security:` block (post-transform, always fully populated). */
export type SecurityPosture = AgentConfig["security"];

/** The `signing` toggle's three settable values. */
export type SigningMode = SecurityPosture["signing"];

/**
 * The boot knobs the `signing` toggle resolves to. Applied verbatim at each
 * verifier/signer site in `src/cortex.ts`.
 */
export interface ResolvedSigningKnobs {
  /**
   * Whether a signer SHOULD be attached when a stack seed is available.
   * `off` → `false` (never attach, even with a seed). `permissive`/`enforce`
   * → `true` (attach iff the seed loads). The seed-presence check itself
   * stays at the boot site; this flag only encodes the posture's intent.
   */
  readonly attachSigner: boolean;
  /**
   * Whether to run the ed25519 crypto-verification step on inbound chains.
   * Always `true` — cheap observability that NEVER rejects on its own when
   * `rejectEmpty` is `false` (see `rejectEmpty` doc).
   */
  readonly cryptoVerify: boolean;
  /**
   * Whether an empty `signed_by[]` chain (adapter-originated dispatches) is
   * REJECTED. `false` for `off`/`permissive` (fall through to the policy
   * gate, today's behaviour); `true` only for `enforce`.
   */
  readonly rejectEmpty: boolean;
  /**
   * What `MyelinRuntime.publish` does when signing fails. `"fallback"`
   * (publish unsigned) for `off`/`permissive`; `"drop"` (skip the publish)
   * for `enforce`.
   */
  readonly signFailureMode: "fallback" | "drop";
}

/**
 * Resolve the `signing` toggle to its concrete boot knobs. Single source of
 * truth — applied at the review-consumer verifier, the runner dispatch-
 * listener, the bus-dispatch-listener, and the publish-side signer attach in
 * `src/cortex.ts`.
 *
 * @param signing — `config.security.signing`.
 */
export function resolveSigningKnobs(signing: SigningMode): ResolvedSigningKnobs {
  switch (signing) {
    case "off":
      return {
        attachSigner: false,
        cryptoVerify: true,
        rejectEmpty: false,
        signFailureMode: "fallback",
      };
    case "permissive":
      return {
        attachSigner: true,
        cryptoVerify: true,
        rejectEmpty: false,
        signFailureMode: "fallback",
      };
    case "enforce":
      return {
        attachSigner: true,
        cryptoVerify: true,
        rejectEmpty: true,
        signFailureMode: "drop",
      };
  }
}
