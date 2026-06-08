/**
 * TC-1b (#632) — stack-identity provisioning tests.
 *
 * Coverage:
 *   1. generate writes a seed (mode 600) + derives the matching NKey pub +
 *      base64 pubkey (pubkey == nkeyToBase64Pubkey(nkeyPub)).
 *   2. generate REFUSES to clobber an existing seed without force; force
 *      overwrites.
 *   3. PROOF-OF-POSSESSION round-trip: a claim built by `buildRegistrationClaim`
 *      is ACCEPTED by the REAL `POST /principals/{id}/register` route — the
 *      signature verifies against the declared pubkey (same NKey key).
 *   4. A claim TAMPERED after signing is REJECTED by the route (401).
 *   5. materialFromSeedString re-derives identical material from a seed.
 *   6. No secret material (seed) appears in the returned public surface.
 */

import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  statSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  generateStackIdentity,
  materialFromSeedString,
  buildRegistrationClaim,
  fetchExistingStacks,
  fingerprintOf,
} from "../stack-provisioning";
import { nkeyToBase64Pubkey } from "../verify-signed-by-chain";

// Drive the REAL registry Worker route so proof-of-possession is exercised
// end-to-end (not a re-implemented verifier).
import registryApp from "../../services/network-registry/src/index";
import type { Env } from "../../services/network-registry/src/index";
import {
  makeRegistryKey,
  resetStores,
} from "../../services/network-registry/__tests__/helpers";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tc1b-provision-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
  resetStores();
});

describe("generateStackIdentity (TC-1b #632)", () => {
  test("[1] writes seed chmod 600 + derives matching pubkeys", () => {
    const seedPath = join(freshDir(), "stack.nk");
    const material = generateStackIdentity({ seedPath });

    // Seed file exists, mode 600 (POSIX only).
    expect(existsSync(seedPath)).toBe(true);
    if (process.platform !== "win32") {
      const mode = statSync(seedPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    // Seed on disk is the SU… user-class seed.
    const onDisk = readFileSync(seedPath, "utf-8").trim();
    expect(onDisk.startsWith("SU")).toBe(true);
    expect(onDisk).toBe(material.seed.trim());

    // NKey pub is U… and the base64 pubkey matches the bridge.
    expect(material.nkeyPub.startsWith("U")).toBe(true);
    expect(material.nkeyPub.length).toBe(56);
    const bridged = nkeyToBase64Pubkey(material.nkeyPub);
    expect(bridged).toBeDefined();
    expect(material.pubkeyB64).toBe(bridged!);
    expect(material.pubkeyB64.length).toBe(44); // 32 raw bytes base64
    expect(material.fingerprint).toBe(material.pubkeyB64.slice(0, 12));
  });

  test("[2] refuses to clobber an existing seed without force; force overwrites", () => {
    const seedPath = join(freshDir(), "stack.nk");
    const first = generateStackIdentity({ seedPath });

    // No force → throws, file untouched.
    expect(() => generateStackIdentity({ seedPath })).toThrow(/refusing to overwrite/i);
    expect(readFileSync(seedPath, "utf-8").trim()).toBe(first.seed.trim());

    // force → new identity, file replaced.
    const second = generateStackIdentity({ seedPath, force: true });
    expect(second.nkeyPub).not.toBe(first.nkeyPub);
    expect(readFileSync(seedPath, "utf-8").trim()).toBe(second.seed.trim());
    if (process.platform !== "win32") {
      expect(statSync(seedPath).mode & 0o777).toBe(0o600);
    }
  });

  test("[2b] refuses to follow a dangling symlink at the seed path — no write-through (wx)", () => {
    const dir = freshDir();
    const seedPath = join(dir, "stack.nk");
    const attackerTarget = join(dir, "attacker-capture.nk");
    // Dangling symlink: its target does not exist, so existsSync(seedPath) is
    // FALSE — the userspace no-clobber guard passes. Pre-fix (plain "w"),
    // writeFileSync would FOLLOW the link and create attackerTarget, writing the
    // seed THROUGH it to an attacker-controlled path. O_EXCL ("wx") refuses to
    // create through a symlink.
    symlinkSync(attackerTarget, seedPath);
    expect(existsSync(seedPath)).toBe(false); // dangling → reported absent

    expect(() => generateStackIdentity({ seedPath })).toThrow();
    // The seed was NOT written through to the attacker-controlled target.
    expect(existsSync(attackerTarget)).toBe(false);
  });

  test("[5] materialFromSeedString re-derives identical material", () => {
    const seedPath = join(freshDir(), "stack.nk");
    const generated = generateStackIdentity({ seedPath });
    const reloaded = materialFromSeedString(generated.seed);
    expect(reloaded.nkeyPub).toBe(generated.nkeyPub);
    expect(reloaded.pubkeyB64).toBe(generated.pubkeyB64);
    expect(reloaded.fingerprint).toBe(generated.fingerprint);
  });

  test("[5b] materialFromSeedString rejects a non-user-class seed", () => {
    expect(() => materialFromSeedString("SAABLAH")).toThrow(/user-class/i);
  });
});

describe("proof-of-possession registration (TC-1b #632)", () => {
  async function configuredEnv(): Promise<Env> {
    resetStores();
    const reg = await makeRegistryKey();
    return {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
  }

  test("[3] claim signed with the stack NKey is ACCEPTED by the real route", async () => {
    const env = await configuredEnv();
    const seedPath = join(freshDir(), "stack.nk");
    const material = generateStackIdentity({ seedPath });

    const body = await buildRegistrationClaim({
      principalId: "andreas",
      material,
      stacks: [{ stack_id: "andreas/research", display_name: "Research" }],
      capabilities: [{ id: "tasks.code-review", description: "Reviews TS" }],
    });

    // The claim's declared pubkey is the stack's pubkey (proof binds to it).
    expect(body.claim.principal_pubkey).toBe(material.pubkeyB64);

    const res = await registryApp.fetch(
      new Request("http://localhost/principals/andreas/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { payload: { principal_pubkey: string } };
    // The registry stored the SAME pubkey — possession proven, no swap.
    expect(json.payload.principal_pubkey).toBe(material.pubkeyB64);
  });

  test("[4] a claim TAMPERED after signing is REJECTED (401)", async () => {
    const env = await configuredEnv();
    const seedPath = join(freshDir(), "stack.nk");
    const material = generateStackIdentity({ seedPath });

    const body = await buildRegistrationClaim({
      principalId: "andreas",
      material,
      stacks: [{ stack_id: "andreas/research" }],
    });
    // Tamper: smuggle in an extra stack the signature didn't cover.
    body.claim.stacks.push({ stack_id: "andreas/sneaked-in" });

    const res = await registryApp.fetch(
      new Request("http://localhost/principals/andreas/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  test("[4b] a claim signed by a DIFFERENT key than declared is REJECTED (401)", async () => {
    const env = await configuredEnv();
    const sp1 = join(freshDir(), "a.nk");
    const sp2 = join(freshDir(), "b.nk");
    const keyA = generateStackIdentity({ seedPath: sp1 });
    const keyB = generateStackIdentity({ seedPath: sp2 });

    // Build a valid claim with key A, then swap the declared pubkey to B's —
    // the signature (over the original claim) no longer matches B's pubkey.
    const body = await buildRegistrationClaim({
      principalId: "andreas",
      material: keyA,
      stacks: [{ stack_id: "andreas/research" }],
    });
    body.claim.principal_pubkey = keyB.pubkeyB64;

    const res = await registryApp.fetch(
      new Request("http://localhost/principals/andreas/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe("C-787 — add-stack (multi-stack federation) round-trip against the real route", () => {
  async function configuredEnv(): Promise<Env> {
    resetStores();
    const reg = await makeRegistryKey();
    return {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
  }

  async function postRegister(env: Env, body: unknown): Promise<Response> {
    return registryApp.fetch(
      new Request("http://localhost/principals/andreas/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  test("a root-authorized add-stack claim adds a SECOND stack with its OWN pubkey", async () => {
    const env = await configuredEnv();
    // First stack establishes the root.
    const root = generateStackIdentity({ seedPath: join(freshDir(), "mf.nk") });
    const first = await buildRegistrationClaim({
      principalId: "andreas",
      material: root,
      stacks: [{ stack_id: "andreas/meta-factory" }],
    });
    expect((await postRegister(env, first)).status).toBe(201);

    // Add the community stack: its OWN key is `material`, the ROOT seed signs.
    const community = generateStackIdentity({ seedPath: join(freshDir(), "community.nk") });
    const addStack = await buildRegistrationClaim({
      principalId: "andreas",
      material: community,
      rootMaterial: root,
      stacks: [
        { stack_id: "andreas/meta-factory", stack_pubkey: root.pubkeyB64 },
        { stack_id: "andreas/community" },
      ],
    });
    // The claim is authorized by the root pubkey (so the rotation gate admits it).
    expect(addStack.claim.principal_pubkey).toBe(root.pubkeyB64);

    const res = await postRegister(env, addStack);
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      payload: { stacks: { stack_id: string; stack_pubkey?: string }[] };
    };
    const byId = new Map(json.payload.stacks.map((s) => [s.stack_id, s.stack_pubkey]));
    expect(byId.get("andreas/community")).toBe(community.pubkeyB64);
    expect(byId.get("andreas/meta-factory")).toBe(root.pubkeyB64);
  });

  test("IMPERSONATION — an add-stack signed by ONLY the new stack's key is REJECTED", async () => {
    const env = await configuredEnv();
    const root = generateStackIdentity({ seedPath: join(freshDir(), "mf.nk") });
    const first = await buildRegistrationClaim({
      principalId: "andreas",
      material: root,
      stacks: [{ stack_id: "andreas/meta-factory" }],
    });
    expect((await postRegister(env, first)).status).toBe(201);

    // Attacker holds ONLY the community key and tries to self-authorize an
    // add-stack (no rootMaterial → community key both declares + signs).
    const community = generateStackIdentity({ seedPath: join(freshDir(), "community.nk") });
    const forged = await buildRegistrationClaim({
      principalId: "andreas",
      material: community,
      stacks: [{ stack_id: "andreas/community" }],
    });
    const res = await postRegister(env, forged);
    // The claim's principal_pubkey (community key) ≠ the registered root, so
    // the registry's rotation gate rejects it — a non-root key cannot add a
    // stack under someone else's principal.
    expect(res.status).toBe(409);
  });
});

describe("secrets discipline (TC-1b #632)", () => {
  test("[6] fingerprint is derived from the PUBLIC key only", () => {
    const seedPath = join(freshDir(), "stack.nk");
    const material = generateStackIdentity({ seedPath });
    expect(fingerprintOf(material.pubkeyB64)).toBe(material.fingerprint);
    // The fingerprint must not contain any portion of the seed.
    expect(material.seed).not.toContain(material.fingerprint);
  });
});

describe("C-787 — fetchExistingStacks (read side of add-stack merge)", () => {
  async function configuredEnv(): Promise<Env> {
    resetStores();
    const reg = await makeRegistryKey();
    return {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
  }

  /** A fetch impl routed at the in-memory registry app for `env`. */
  function registryFetch(env: Env): typeof globalThis.fetch {
    return ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
  }

  test("present — returns the principal's stacks with their stack_pubkeys", async () => {
    const env = await configuredEnv();
    const root = generateStackIdentity({ seedPath: join(freshDir(), "mf.nk") });
    const body = await buildRegistrationClaim({
      principalId: "andreas",
      material: root,
      stacks: [{ stack_id: "andreas/meta-factory" }],
    });
    await registryApp.fetch(
      new Request("http://registry.test/principals/andreas/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );

    const res = await fetchExistingStacks({
      registryUrl: "http://registry.test",
      principalId: "andreas",
      fetchImpl: registryFetch(env),
    });
    expect(res.kind).toBe("present");
    if (res.kind === "present") {
      expect(res.stacks).toHaveLength(1);
      expect(res.stacks[0]!.stack_id).toBe("andreas/meta-factory");
      expect(res.stacks[0]!.stack_pubkey).toBe(root.pubkeyB64);
    }
  });

  test("absent — a 404 maps to absent (first registration, nothing to merge)", async () => {
    const env = await configuredEnv();
    const res = await fetchExistingStacks({
      registryUrl: "http://registry.test",
      principalId: "nobody",
      fetchImpl: registryFetch(env),
    });
    expect(res.kind).toBe("absent");
  });

  test("error — a network failure maps to error (caller must abort, not drop stacks)", async () => {
    const failingFetch = (() =>
      Promise.reject(new Error("connection refused"))) as unknown as typeof globalThis.fetch;
    const res = await fetchExistingStacks({
      registryUrl: "http://registry.test",
      principalId: "andreas",
      fetchImpl: failingFetch,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.reason).toMatch(/connection refused/);
    }
  });
});
