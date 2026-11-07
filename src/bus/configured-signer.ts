import { DID_RE } from "@the-metafactory/myelin/identity";
import { expandTilde, type LoadedConfig } from "../common/config/loader";
import { loadStackSigningKey } from "../common/config/stack-signing-key";
import { resolveSigningKnobs } from "../common/security-posture";
import { deriveStackId } from "../common/types/cortex-config";
import type { BusEnvelopeSigner } from "./myelin/runtime";

function hasRawSeed(pair: unknown): pair is { getRawSeed: () => unknown } {
  return typeof pair === "object" && pair !== null && "getRawSeed" in pair && typeof pair.getRawSeed === "function";
}

export async function buildStackEnvelopeSignerFromConfig(cfg: LoadedConfig): Promise<BusEnvelopeSigner | undefined> {
  const signing = cfg.config.security.signing;
  if (!resolveSigningKnobs(signing).attachSigner) return undefined;
  const seedPath = cfg.stack?.nkey_seed_path;
  if (!seedPath) {
    process.stderr.write(`cortex: configured signer absent under security.signing=${signing}; outbound envelope would be unsigned\n`);
    return undefined;
  }
  let reason = "seed_invalid";
  try {
    const pair = await loadStackSigningKey(expandTilde(seedPath));
    if (cfg.stack?.nkey_pub !== undefined && pair.getPublicKey() !== cfg.stack.nkey_pub) { reason = "public_key_mismatch"; throw new Error("configured signer public key mismatch"); }
    if (!hasRawSeed(pair)) throw new Error("native signer API unavailable");
    const rawSeedBytes: unknown = pair.getRawSeed();
    if (!(rawSeedBytes instanceof Uint8Array) || rawSeedBytes.length !== 32) throw new Error("native signer shape invalid");
    const derived = deriveStackId({ ...(cfg.principal?.id !== undefined && { principal: { id: cfg.principal.id } }), ...(cfg.stack !== undefined && { stack: cfg.stack }) });
    const principal = `did:mf:${derived.id.replace("/", "-").replace(/-+/g, "-")}`;
    if (!DID_RE.test(principal)) { reason = "did_invalid"; throw new Error("configured stack DID invalid"); }
    return { rawSeedBytes, principal };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") reason = "seed_missing";
    else if (error instanceof Error && error.message.includes("chmod 600")) reason = "seed_permissions";
    process.stderr.write(`cortex: configured signer unavailable (${reason})\n`);
    return undefined;
  }
}
