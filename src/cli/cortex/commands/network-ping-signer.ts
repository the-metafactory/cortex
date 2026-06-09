/**
 * `cortex network ping` — stack signer construction (PR #822 review, MAJOR-1).
 *
 * A faithful CLI-side mirror of `cortex.ts`'s boot-time signer build: under a
 * `permissive`/`enforce` posture, load the stack signing key (chmod-600 gated,
 * `SU`-prefixed) and return a {@link BusEnvelopeSigner} so the probe REQUEST is
 * signed exactly like every other federated dispatch. Under `signing: off`
 * (the schema default) it returns `undefined` — the probe publishes unsigned,
 * byte-identical to pre-#822.
 *
 * ## Why this matters (the MAJOR the review caught)
 *
 * `cortex network ping` against an `enforce`-posture peer must carry a signed
 * `signed_by[]` chain + signed `originator` or the peer's gate fail-closes the
 * request → the probe reports `timeout`/`refused`, NEVER `reachable`, breaking
 * the spec §9 enforce close-criterion. The seam was already plumbed
 * (`createLiveProbeBus(config, signer?)`); this helper feeds it. It fails
 * CLOSED (under-signs on any load error → unsigned publish → at worst a false
 * `timeout`, never an over-trust), matching `cortex.ts`'s non-fatal catch.
 *
 * The recipe is copied deliberately from `src/cortex.ts` (posture gate → seed
 * load → pubkey-consistency check → raw-seed extract → DID derivation with the
 * slash→hyphen + `--`-collapse canonicalisation). If `cortex.ts`'s signer build
 * changes, change this too — the two MUST agree on the DID + seed shape, or a
 * probe would sign with a different identity than the daemon.
 */

import { DID_RE } from "@the-metafactory/myelin/identity";

import { expandTilde } from "../../../common/config/loader";
import type { LoadedConfig } from "../../../common/config/loader";
import { loadStackSigningKey } from "../../../common/config/stack-signing-key";
import { resolveSigningKnobs } from "../../../common/security-posture";
import { deriveStackId } from "../../../common/types/cortex-config";
import type { BusEnvelopeSigner } from "../../../bus/myelin/runtime";

/**
 * Build the stack {@link BusEnvelopeSigner} from the loaded config, or
 * `undefined` when the posture is `off` / no seed is configured / the seed
 * fails to load (fail-closed: unsigned publish, never an over-trust).
 *
 * Mirrors `cortex.ts`'s boot signer build 1:1 (see file docblock). A load /
 * derivation failure is logged to stderr (per the no-empty-catch rule) and
 * returns `undefined` — the probe then publishes unsigned, exactly as under
 * `signing: off`.
 */
export async function buildPingSignerFromConfig(
  cfg: LoadedConfig,
): Promise<BusEnvelopeSigner | undefined> {
  const signing = cfg.config.security.signing;
  const knobs = resolveSigningKnobs(signing);

  // Posture gate — `off` never attaches a signer (publish unsigned), exactly
  // like `cortex.ts`. A seed configured under `off` is intentionally ignored.
  if (!knobs.attachSigner) return undefined;

  const seedPath = cfg.stack?.nkey_seed_path;
  if (seedPath === undefined || seedPath === "") {
    // `permissive`/`enforce` posture but no seed staged — nothing to sign with.
    // Fail closed (unsigned). cortex.ts logs the same default-on warning; here
    // a probe is a one-shot CLI run, so a single stderr note suffices.
    process.stderr.write(
      `cortex network ping: security.signing=${signing} but no stack.nkey_seed_path ` +
        `configured — probe will be published UNSIGNED (an enforce-posture peer will drop it)\n`,
    );
    return undefined;
  }

  try {
    const kp = await loadStackSigningKey(expandTilde(seedPath));

    // Pubkey-consistency check — same split-brain guard as cortex.ts.
    if (
      cfg.stack?.nkey_pub !== undefined &&
      kp.getPublicKey() !== cfg.stack.nkey_pub
    ) {
      throw new Error(
        `seed file pubkey ${kp.getPublicKey()} does not match declared ` +
          `stack.nkey_pub ${cfg.stack.nkey_pub} — rotation split-brain hazard`,
      );
    }

    const rawSeedBytes = (
      kp as unknown as { getRawSeed(): Uint8Array }
    ).getRawSeed();

    // Derive the requester DID from the resolved stack id, identical to
    // cortex.ts: `{principal}/{stack}` → `did:mf:{principal}-{stack}`, with the
    // slash→hyphen swap + `--`-run collapse so DID_RE's consecutive-hyphen
    // guard holds for trailing-hyphen stack-segment edge cases.
    const derived = deriveStackId({
      ...(cfg.principal?.id !== undefined && { principal: { id: cfg.principal.id } }),
      ...(cfg.stack !== undefined && { stack: cfg.stack }),
    });
    const principal = `did:mf:${derived.id.replace("/", "-").replace(/-+/g, "-")}`;
    if (!DID_RE.test(principal)) {
      throw new Error(
        `derived DID "${principal}" does not match myelin DID_RE — ` +
          `check stack.id segments for trailing-hyphen edge cases`,
      );
    }

    return { rawSeedBytes, principal };
  } catch (err) {
    // Non-fatal — fail closed (unsigned publish), same posture as cortex.ts's
    // boot-time catch. Deliberately omit the seed-derived message detail.
    process.stderr.write(
      `cortex network ping: stack signing key load failed (probe will be unsigned): ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return undefined;
  }
}
