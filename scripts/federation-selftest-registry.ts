/**
 * federation-selftest-registry.ts — hermetic in-process network-registry for the
 * federation self-test. Serves the REAL hono app (src/services/network-registry)
 * with an IN-MEMORY store (no `DB` binding) and an ephemeral signing keypair
 * generated at boot, so no secret ever leaves this process.
 *
 * Env in:
 *   SELFTEST_REG_PORT        listen port (default 8788)
 *   SELFTEST_ADMIN_PUBKEYS   base64 admin pubkey(s) for REGISTRY_ADMIN_PUBKEYS
 *   SELFTEST_REG_PUBKEY_OUT  path to write the registry's raw base64 public key
 *                            (the joiner pins this as policy.federated.registry.pubkey)
 */
import app from "../src/services/network-registry/src/index.ts";
import { generateKeypair } from "../src/services/network-registry/src/signing.ts";

const port = Number(process.env.SELFTEST_REG_PORT ?? "8788");
const adminPubkeys = process.env.SELFTEST_ADMIN_PUBKEYS ?? "";
const pubkeyOut = process.env.SELFTEST_REG_PUBKEY_OUT ?? "";

const { privateKeyB64, publicKeyB64 } = await generateKeypair();

const env = {
  REGISTRY_SIGNING_KEY: privateKeyB64,
  REGISTRY_PUBLIC_KEY: publicKeyB64,
  REGISTRY_ADMIN_PUBKEYS: adminPubkeys,
  REGISTRY_HUB_ADMIN_PUBKEYS: adminPubkeys,
  ENVIRONMENT: "selftest",
  // no DB binding → InMemoryRegistryStore / InMemoryNonceCache (README §In-memory fallback)
};

if (pubkeyOut) await Bun.write(pubkeyOut, publicKeyB64);

Bun.serve({
  port,
  fetch: (req: Request) => app.fetch(req, env),
});

// eslint-disable-next-line no-console
console.log(`selftest-registry: listening on http://127.0.0.1:${port} (in-memory, pubkey ${publicKeyB64.slice(0, 12)}…)`);
