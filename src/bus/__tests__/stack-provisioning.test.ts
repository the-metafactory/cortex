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
  resolveMergedStacks,
  resolveMergedCapabilities,
  resolveCapabilitiesAfterLeave,
  buildStackRetireClaim,
  retireStackIdentity,
  fingerprintOf,
  signAdminRequest,
  randomNonce,
} from "../stack-provisioning";
import { nkeyToBase64Pubkey } from "../verify-signed-by-chain";
import { canonicalJSON, verifyEd25519 } from "../../common/registry/signing";

// Drive the REAL registry Worker route so proof-of-possession is exercised
// end-to-end (not a re-implemented verifier).
import registryApp from "../../services/network-registry/src/index";
import type { Env } from "../../services/network-registry/src/index";
import {
  makeRegistryKey,
  makePrincipalKey,
  makeSignedAdminRead,
  makeSignedAdminDecision,
  resetStores,
  type PrincipalKey,
} from "../../services/network-registry/__tests__/helpers";
import type { AdmissionRequest } from "../../services/network-registry/src/types";

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

describe("C-787 / C-791 — fetchExistingStacks (verified read side of add-stack merge)", () => {
  let registryPubkey = "";
  async function configuredEnv(): Promise<Env> {
    resetStores();
    const reg = await makeRegistryKey();
    registryPubkey = reg.publicKey;
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

  /** Register a principal with one stack so the GET has something to return. */
  async function seedPrincipal(env: Env): Promise<{ rootPubkey: string }> {
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
    return { rootPubkey: root.pubkeyB64 };
  }

  test("present — VERIFIED read returns the principal's stacks + capabilities", async () => {
    const env = await configuredEnv();
    const { rootPubkey } = await seedPrincipal(env);

    const res = await fetchExistingStacks({
      registryUrl: "http://registry.test",
      principalId: "andreas",
      registryPubkey,
      fetchImpl: registryFetch(env),
    });
    expect(res.kind).toBe("present");
    if (res.kind === "present") {
      expect(res.stacks).toHaveLength(1);
      expect(res.stacks[0]!.stack_id).toBe("andreas/meta-factory");
      expect(res.stacks[0]!.stack_pubkey).toBe(rootPubkey);
      expect(Array.isArray(res.capabilities)).toBe(true);
    }
  });

  test("absent — a 404 maps to absent (first registration, nothing to merge)", async () => {
    const env = await configuredEnv();
    const res = await fetchExistingStacks({
      registryUrl: "http://registry.test",
      principalId: "nobody",
      registryPubkey,
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
      registryPubkey: "anything",
      fetchImpl: failingFetch,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.reason).toMatch(/connection refused/);
    }
  });

  test("C-791 SECURITY — NO pinned pubkey fails closed (refuses to merge off an unverifiable read)", async () => {
    const env = await configuredEnv();
    await seedPrincipal(env);
    const res = await fetchExistingStacks({
      registryUrl: "http://registry.test",
      principalId: "andreas",
      // registryPubkey omitted
      fetchImpl: registryFetch(env),
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.reason).toMatch(/no pinned registry pubkey/i);
    }
  });

  test("C-791 SECURITY — a TAMPERED principal-read (dropped stack, stale signature) fails closed", async () => {
    const env = await configuredEnv();
    await seedPrincipal(env);
    // Malicious proxy: serve the real assertion but with stacks wiped, keeping
    // the now-invalid signature. The verify gate must reject it.
    const tamperingFetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const res = await registryApp.fetch(req, env);
      const json = (await res.json()) as { payload: Record<string, unknown> };
      json.payload = { ...json.payload, stacks: [] };
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const res = await fetchExistingStacks({
      registryUrl: "http://registry.test",
      principalId: "andreas",
      registryPubkey,
      fetchImpl: tamperingFetch,
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.reason).toMatch(/did not verify/i);
    }
  });

  test("C-791 SECURITY — a pubkey MISMATCH (wrong/spoofed registry) fails closed", async () => {
    const env = await configuredEnv();
    await seedPrincipal(env);
    // Pin a DIFFERENT registry pubkey than the one that signed → mismatch.
    const otherKey = await makeRegistryKey();
    const res = await fetchExistingStacks({
      registryUrl: "http://registry.test",
      principalId: "andreas",
      registryPubkey: otherKey.publicKey,
      fetchImpl: registryFetch(env),
    });
    expect(res.kind).toBe("error");
    if (res.kind === "error") {
      expect(res.reason).toMatch(/did not verify/i);
    }
  });
});

// =============================================================================
// C-819 — capability merge-preserve across re-register (ADR-0018 Gap-B model)
// =============================================================================
//
// The register route does a FULL-OVERWRITE upsert of the `capabilities` column
// (store.ts: `capabilities = excluded.capabilities`), identical to the stacks
// column. `resolveMergedCapabilities` is the capability twin of
// `resolveMergedStacks`: on the add-stack path it fetches the (verified)
// existing set and unions the announce in, so an EMPTY announce preserves the
// existing caps unchanged. That cap-merge behaviour is the C-819 concern and is
// STILL valid — pinned by the unit tests below.
//
// What CHANGED (ADR-0018 Gap-B / Q3=ii): roster membership is no longer
// capability-derived. The served roster `members[]` is now sourced from
// ADMITTED admission rows, NOT from `capability.networks[]`. So the old
// coupling "a caps-wipe evicts the principal from every roster" no longer
// holds — membership and capabilities are independent facets. A principal is
// "in" network X iff they hold an ADMITTED admission row for X; wiping their
// caps (e.g. via a bare re-register) cannot evict an admitted member, and a
// principal with caps-but-no-ADMITTED-row is NOT on the roster. The
// silent-eviction footgun C-819 worked around is now structurally impossible.
// These tests pin (a) the cap-merge semantics, and (b) that an ADMITTED
// member's roster membership survives a bare re-register because it is
// admission-derived, independent of the cap set.
describe("C-819 — resolveMergedCapabilities preserves caps across re-register", () => {
  let registryPubkey = "";
  let adminKey: PrincipalKey | undefined;
  async function configuredEnv(): Promise<Env> {
    resetStores();
    const reg = await makeRegistryKey();
    registryPubkey = reg.publicKey;
    adminKey = await makePrincipalKey();
    return {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      REGISTRY_ADMIN_PUBKEYS: adminKey.publicKeyB64,
      ENVIRONMENT: "test",
    };
  }

  /**
   * ADR-0018 Gap-B — admit the principal's PENDING request for `networkId` so
   * they appear on the (admission-sourced) roster. Membership is no longer
   * capability-derived; an admit is required.
   */
  async function admitInto(env: Env, principalId: string, networkId: string): Promise<void> {
    const read = await makeSignedAdminRead(adminKey!);
    const listRes = await registryApp.fetch(
      new Request("http://registry.test/admission-requests?status=PENDING", {
        headers: { "x-admin-signed": JSON.stringify(read) },
      }),
      env,
    );
    const list = (await listRes.json()) as AdmissionRequest[];
    const req = list.find((r) => r.principal_id === principalId && r.network_id === networkId);
    expect(req).toBeDefined();
    const decision = await makeSignedAdminDecision(req!.request_id, "admit", adminKey!);
    const admitRes = await registryApp.fetch(
      new Request(`http://registry.test/admission-requests/${req!.request_id}/admit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision),
      }),
      env,
    );
    expect(admitRes.status).toBe(200);
  }

  function registryFetch(env: Env): typeof globalThis.fetch {
    return ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
  }

  async function post(env: Env, path: string, body: unknown): Promise<Response> {
    return registryApp.fetch(
      new Request(`http://registry.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  async function rosterMembers(env: Env, networkId: string): Promise<string[]> {
    const res = await registryApp.fetch(
      new Request(`http://registry.test/networks/${networkId}/roster`),
      env,
    );
    const json = (await res.json()) as {
      payload: { members: { principal_id: string }[] };
    };
    return json.payload.members.map((m) => m.principal_id).sort();
  }

  /**
   * Seed principal `jc` with a single stack that announces a `community-net`
   * capability AND targets `community-net` for admission (ADR-0018 Gap-A), then
   * ADMIT the resulting PENDING request (Gap-B) — so JC lands on the
   * `community-net` roster via an ADMITTED row (the live repro:
   * `metafactory-community` listed `jc`). Returns the root material so a later
   * re-register can sign as the same root (the rotation gate requires it).
   */
  async function seedJcWithCommunityCaps(env: Env) {
    const root = generateStackIdentity({ seedPath: join(freshDir(), "jc-root.nk") });
    const body = await buildRegistrationClaim({
      principalId: "jc",
      material: root,
      stacks: [{ stack_id: "jc/meta-factory" }],
      capabilities: [
        { id: "tasks.code-review", description: "JC reviews", networks: ["community-net"] },
      ],
      // ADR-0018 Gap-A — name the target network so a PENDING admission row is
      // raised for it; Gap-B then sources roster membership from the ADMITTED row.
      networkId: "community-net",
    });
    await post(env, "/principals/jc/register", body);
    // ADR-0018 Gap-B — admit JC into community-net so they are on the roster.
    await admitInto(env, "jc", "community-net");
    return root;
  }

  test("ACCEPTANCE — a bare add-stack register (empty announce) preserves JC's caps + admission-derived roster membership", async () => {
    const env = await configuredEnv();
    const root = await seedJcWithCommunityCaps(env);

    // Precondition: JC is on the community roster — via an ADMITTED row
    // (ADR-0018 Gap-B), not via the announced capability.
    expect(await rosterMembers(env, "community-net")).toEqual(["jc"]);

    // Now stand up `jc/clawbox` (the live repro). It is a SECOND stack added by
    // the principal root, announcing NO capabilities of its own. The CLI mirrors
    // the stacks merge: resolveMergedCapabilities with an EMPTY announce.
    const caps = await resolveMergedCapabilities({
      principalId: "jc",
      registryUrl: "http://registry.test",
      registryPubkey,
      announce: [], // provision-stack register announces no caps
      mergeExisting: true,
      fetchImpl: registryFetch(env),
    });
    expect(caps.ok).toBe(true);
    if (!caps.ok) throw new Error(caps.reason);
    // Empty ∪ existing = existing — the community cap survives the merge.
    expect(caps.capabilities.map((cc) => cc.id)).toEqual(["tasks.code-review"]);
    expect(caps.capabilities[0]!.networks).toEqual(["community-net"]);

    // The new stack (root re-attests the FULL stack set, here just the merged
    // caps drive the assertion). Build + POST the re-register the CLI would.
    const newStack = generateStackIdentity({ seedPath: join(freshDir(), "jc-clawbox.nk") });
    const body = await buildRegistrationClaim({
      principalId: "jc",
      material: newStack,
      rootMaterial: root, // root signs the add-stack
      stacks: [{ stack_id: "jc/meta-factory" }, { stack_id: "jc/clawbox" }],
      capabilities: caps.capabilities, // the PRESERVED set
    });
    const res = await post(env, "/principals/jc/register", body);
    expect(res.status).toBe(201);

    // JC is STILL on the community roster — the bare re-register left JC's
    // ADMITTED community-net row untouched (membership is admission-derived,
    // ADR-0018 Gap-B), and the cap-merge preserved the capability facet too.
    expect(await rosterMembers(env, "community-net")).toEqual(["jc"]);
  });

  test("REGRESSION GUARD — under Gap-B a caps-wipe does NOT evict an ADMITTED member (silent eviction structurally impossible)", async () => {
    // Pre-ADR-0018 this same re-register (empty caps claim → full-overwrite to
    // []) zeroed JC's cap set AND evicted JC from every roster, because
    // membership was capability-derived. Under ADR-0018 Gap-B membership is
    // ADMITTED-derived and INDEPENDENT of caps: the cap-overwrite still happens
    // (the cap facet is wiped), but JC's ADMITTED community-net row is untouched
    // so JC stays on the roster. The silent-eviction footgun is now structurally
    // impossible. (The cap-merge in the ACCEPTANCE test remains load-bearing for
    // preserving the capability FACET — proven here by the caps actually wiping.)
    const env = await configuredEnv();
    const root = await seedJcWithCommunityCaps(env);
    expect(await rosterMembers(env, "community-net")).toEqual(["jc"]);

    const newStack = generateStackIdentity({ seedPath: join(freshDir(), "jc-clawbox.nk") });
    const body = await buildRegistrationClaim({
      principalId: "jc",
      material: newStack,
      rootMaterial: root,
      stacks: [{ stack_id: "jc/meta-factory" }, { stack_id: "jc/clawbox" }],
      // capabilities omitted → defaults to [] → full-overwrite to empty.
    });
    const res = await post(env, "/principals/jc/register", body);
    expect(res.status).toBe(201);

    // The cap FACET was wiped (full-overwrite to empty) — this is the behaviour
    // the ACCEPTANCE test's merge guards against for the capability set.
    const getRes = await registryApp.fetch(
      new Request("http://registry.test/principals/jc"),
      env,
    );
    const principal = (await getRes.json()) as {
      payload: { capabilities: { id: string }[] };
    };
    expect(principal.payload.capabilities).toEqual([]);

    // But roster membership is ADMITTED-derived → the caps-wipe did NOT evict
    // JC. The old "caps-wipe → roster eviction" coupling no longer holds.
    expect(await rosterMembers(env, "community-net")).toEqual(["jc"]);
  });

  test("union — a NEW announce is added, existing unrelated caps are kept (same-id new wins)", async () => {
    const env = await configuredEnv();
    const root = generateStackIdentity({ seedPath: join(freshDir(), "p-root.nk") });
    // Seed with two caps across two networks.
    await post(
      env,
      "/principals/p/register",
      await buildRegistrationClaim({
        principalId: "p",
        material: root,
        stacks: [{ stack_id: "p/s1" }],
        capabilities: [
          { id: "tasks.review", description: "old desc", networks: ["net-a"] },
          { id: "tasks.deploy", networks: ["net-b"] },
        ],
      }),
    );

    const caps = await resolveMergedCapabilities({
      principalId: "p",
      registryUrl: "http://registry.test",
      registryPubkey,
      // Re-announce an EXISTING id into a new network + add a brand-new id.
      announce: [
        { id: "tasks.review", description: "new desc", networks: ["net-c"] },
        { id: "tasks.fresh", networks: ["net-d"] },
      ],
      mergeExisting: true,
      fetchImpl: registryFetch(env),
    });
    expect(caps.ok).toBe(true);
    if (!caps.ok) throw new Error(caps.reason);

    const byId = new Map(caps.capabilities.map((cc) => [cc.id, cc]));
    // Unrelated existing cap kept untouched.
    expect(byId.get("tasks.deploy")?.networks).toEqual(["net-b"]);
    // Same-id: networks UNIONED, description updated to the new claim's.
    expect(byId.get("tasks.review")?.networks).toEqual(["net-a", "net-c"]);
    expect(byId.get("tasks.review")?.description).toBe("new desc");
    // Brand-new id appended.
    expect(byId.get("tasks.fresh")?.networks).toEqual(["net-d"]);
  });

  test("first register (mergeExisting=false) — announce passes through unchanged, no fetch", async () => {
    // On a first register there is nothing on record to preserve; the merge is
    // a pure pass-through and never touches the registry (a failing fetch would
    // throw if it did).
    const failingFetch = (() =>
      Promise.reject(new Error("must not be called"))) as unknown as typeof globalThis.fetch;
    const caps = await resolveMergedCapabilities({
      principalId: "newcomer",
      registryUrl: "http://registry.test",
      registryPubkey: "unused",
      announce: [{ id: "tasks.x", networks: ["net-z"] }],
      mergeExisting: false,
      fetchImpl: failingFetch,
    });
    expect(caps.ok).toBe(true);
    if (!caps.ok) throw new Error(caps.reason);
    expect(caps.capabilities).toEqual([{ id: "tasks.x", networks: ["net-z"] }]);
  });

  test("error — an unverifiable read ABORTS (never overwrites caps off a partial/unverified read)", async () => {
    const failingFetch = (() =>
      Promise.reject(new Error("connection refused"))) as unknown as typeof globalThis.fetch;
    const caps = await resolveMergedCapabilities({
      principalId: "jc",
      registryUrl: "http://registry.test",
      registryPubkey: "anything",
      announce: [],
      mergeExisting: true,
      fetchImpl: failingFetch,
    });
    expect(caps.ok).toBe(false);
    if (!caps.ok) {
      expect(caps.reason).toMatch(/connection refused|without dropping/i);
    }
  });
});

describe("C-820 — capability networks[] union on join + set-difference on leave", () => {
  let registryPubkey = "";
  async function configuredEnv(): Promise<Env> {
    resetStores();
    const reg = await makeRegistryKey();
    registryPubkey = reg.publicKey;
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

  /**
   * Register `jc` with a single capability `chat` already tagged into the
   * `metafactory` network (the FIRST join's effect) — so the merge/leave helpers
   * have a verified prior-network state to read.
   */
  async function seedJcInMetafactory(env: Env): Promise<{ root: ReturnType<typeof generateStackIdentity> }> {
    const root = generateStackIdentity({ seedPath: join(freshDir(), "jc.nk") });
    const body = await buildRegistrationClaim({
      principalId: "jc",
      material: root,
      stacks: [{ stack_id: "jc/clawbox" }],
      capabilities: [{ id: "chat.message", networks: ["metafactory"] }],
    });
    await registryApp.fetch(
      new Request("http://registry.test/principals/jc/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
    return { root };
  }

  test("JOIN UNION — a second-network announce ADDS to networks[] (metafactory ∪ community), no clobber, no dup", async () => {
    const env = await configuredEnv();
    await seedJcInMetafactory(env);

    // The community join announces the SAME cap `chat` tagged community.
    const res = await resolveMergedCapabilities({
      principalId: "jc",
      registryUrl: "http://registry.test",
      registryPubkey,
      announce: [{ id: "chat.message", networks: ["community"] }],
      mergeExisting: true,
      fetchImpl: registryFetch(env),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const chat = res.capabilities.find((c) => c.id === "chat.message");
    expect(chat).toBeDefined();
    // BOTH networks present — the prior metafactory tag survived the community join.
    expect(new Set(chat!.networks)).toEqual(new Set(["metafactory", "community"]));
    // No duplicate network ids.
    expect(chat!.networks).toHaveLength(2);
  });

  test("JOIN UNION — re-announcing the SAME network is idempotent (no duplicate id)", async () => {
    const env = await configuredEnv();
    await seedJcInMetafactory(env);

    const res = await resolveMergedCapabilities({
      principalId: "jc",
      registryUrl: "http://registry.test",
      registryPubkey,
      announce: [{ id: "chat.message", networks: ["metafactory"] }],
      mergeExisting: true,
      fetchImpl: registryFetch(env),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const chat = res.capabilities.find((c) => c.id === "chat.message");
    expect(chat!.networks).toEqual(["metafactory"]);
  });

  test("JOIN UNION — mergeExisting:false uses the announce verbatim (first-register, nothing on record)", async () => {
    const res = await resolveMergedCapabilities({
      principalId: "jc",
      registryUrl: "http://registry.test",
      registryPubkey,
      announce: [{ id: "chat.message", networks: ["community"] }],
      mergeExisting: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.capabilities).toEqual([{ id: "chat.message", networks: ["community"] }]);
  });

  test("JOIN UNION — absent principal (404) falls back to the announce (clean first registration)", async () => {
    const env = await configuredEnv();
    // nobody registered → 404 → absent → announce verbatim.
    const res = await resolveMergedCapabilities({
      principalId: "nobody",
      registryUrl: "http://registry.test",
      registryPubkey,
      announce: [{ id: "chat.message", networks: ["metafactory"] }],
      mergeExisting: true,
      fetchImpl: registryFetch(env),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.capabilities).toEqual([{ id: "chat.message", networks: ["metafactory"] }]);
  });

  test("JOIN UNION SECURITY — an unverifiable read ABORTS (never clobbers off a partial read)", async () => {
    const failingFetch = (() =>
      Promise.reject(new Error("connection refused"))) as unknown as typeof globalThis.fetch;
    const res = await resolveMergedCapabilities({
      principalId: "jc",
      registryUrl: "http://registry.test",
      registryPubkey: "anything",
      announce: [{ id: "chat.message", networks: ["community"] }],
      mergeExisting: true,
      fetchImpl: failingFetch,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/connection refused/);
  });

  test("LEAVE SET-DIFF — leaving community removes ONLY community, metafactory survives", async () => {
    const env = await configuredEnv();
    // Seed jc with `chat` tagged into BOTH networks (the post-union state).
    const root = generateStackIdentity({ seedPath: join(freshDir(), "jc.nk") });
    const body = await buildRegistrationClaim({
      principalId: "jc",
      material: root,
      stacks: [{ stack_id: "jc/clawbox" }],
      capabilities: [{ id: "chat.message", networks: ["metafactory", "community"] }],
    });
    await registryApp.fetch(
      new Request("http://registry.test/principals/jc/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );

    const res = await resolveCapabilitiesAfterLeave({
      principalId: "jc",
      registryUrl: "http://registry.test",
      registryPubkey,
      networkId: "community",
      fetchImpl: registryFetch(env),
    });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.present) {
      throw new Error("expected present capability set");
    }
    const chat = res.capabilities.find((c) => c.id === "chat.message");
    expect(chat).toBeDefined();
    // Only community removed; metafactory remains.
    expect(chat!.networks).toEqual(["metafactory"]);
  });

  test("LEAVE SET-DIFF — leaving the LAST network drops the now-empty networks[] key (cap kept)", async () => {
    const env = await configuredEnv();
    await seedJcInMetafactory(env); // chat tagged metafactory only.

    const res = await resolveCapabilitiesAfterLeave({
      principalId: "jc",
      registryUrl: "http://registry.test",
      registryPubkey,
      networkId: "metafactory",
      fetchImpl: registryFetch(env),
    });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.present) {
      throw new Error("expected present capability set");
    }
    const chat = res.capabilities.find((c) => c.id === "chat.message");
    // The capability is KEPT (still announced on the public index), but its
    // networks[] is gone (no roster membership) — the convention: drop the key.
    expect(chat).toBeDefined();
    expect(chat!.networks).toBeUndefined();
  });

  test("LEAVE SET-DIFF — absent principal is a clean no-op (present:false)", async () => {
    const env = await configuredEnv();
    const res = await resolveCapabilitiesAfterLeave({
      principalId: "nobody",
      registryUrl: "http://registry.test",
      registryPubkey,
      networkId: "community",
      fetchImpl: registryFetch(env),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.present).toBe(false);
  });

  test("LEAVE SET-DIFF SECURITY — an unverifiable read ABORTS (never re-attests off a partial read)", async () => {
    const failingFetch = (() =>
      Promise.reject(new Error("connection refused"))) as unknown as typeof globalThis.fetch;
    const res = await resolveCapabilitiesAfterLeave({
      principalId: "jc",
      registryUrl: "http://registry.test",
      registryPubkey: "anything",
      networkId: "community",
      fetchImpl: failingFetch,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/connection refused/);
  });
});

// =============================================================================
// C-1351 Slice 2 (#1351) — retire round-trip + merge-preserves-retired
// =============================================================================

describe("C-1351 — provision-stack retire round-trip + merge preserves a retired tombstone", () => {
  async function configuredEnv(): Promise<{ env: Env; registryPubkey: string }> {
    resetStores();
    const reg = await makeRegistryKey();
    return {
      env: {
        REGISTRY_SIGNING_KEY: reg.signingKey,
        REGISTRY_PUBLIC_KEY: reg.publicKey,
        ENVIRONMENT: "test",
      },
      registryPubkey: reg.publicKey,
    };
  }

  function registryFetch(env: Env): typeof globalThis.fetch {
    return ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
  }

  async function updatedAt(env: Env, principalId: string): Promise<string> {
    const res = await registryApp.fetch(
      new Request(`http://registry.test/principals/${principalId}`),
      env,
    );
    const body = (await res.json()) as { payload: { updated_at: string } };
    return body.payload.updated_at;
  }

  test("retire POST tombstones the stack; a later add-stack merge PRESERVES retired_at", async () => {
    const { env, registryPubkey } = await configuredEnv();
    const fetchImpl = registryFetch(env);

    // Seed andreas with two stacks, both signed by the root.
    const root = generateStackIdentity({ seedPath: join(freshDir(), "root.nk") });
    const community = generateStackIdentity({ seedPath: join(freshDir(), "community.nk") });
    const reg = await buildRegistrationClaim({
      principalId: "andreas",
      material: root,
      stacks: [
        { stack_id: "andreas/meta-factory", stack_pubkey: root.pubkeyB64 },
        { stack_id: "andreas/community", stack_pubkey: community.pubkeyB64 },
      ],
    });
    expect(
      (await registryApp.fetch(
        new Request("http://registry.test/principals/andreas/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reg),
        }),
        env,
      )).status,
    ).toBe(201);

    // Retire andreas/community — root-signed, CAS on the current updated_at.
    const cas = await updatedAt(env, "andreas");
    const retireBody = await buildStackRetireClaim({
      principalId: "andreas",
      stackId: "andreas/community",
      rootMaterial: root,
      expectedUpdatedAt: cas,
    });
    const retireRes = await retireStackIdentity({
      registryUrl: "http://registry.test",
      principalId: "andreas",
      body: retireBody,
      fetchImpl,
    });
    expect(retireRes.ok).toBe(true);
    expect(retireRes.status).toBe(200);

    // Verify the tombstone via a verified read.
    const afterRetire = await fetchExistingStacks({
      registryUrl: "http://registry.test",
      principalId: "andreas",
      registryPubkey,
      fetchImpl,
    });
    expect(afterRetire.kind).toBe("present");
    if (afterRetire.kind !== "present") return;
    const retiredEntry = afterRetire.stacks.find((s) => s.stack_id === "andreas/community");
    expect(retiredEntry?.retired_at).toBeDefined();

    // Now add a NEW stack via resolveMergedStacks — the merged set MUST carry the
    // retired community entry (with its retired_at) through, not drop/resurrect it.
    const laptop = generateStackIdentity({ seedPath: join(freshDir(), "laptop.nk") });
    const merged = await resolveMergedStacks({
      principalId: "andreas",
      stackId: "andreas/laptop",
      stackPubkey: laptop.pubkeyB64,
      registryUrl: "http://registry.test",
      registryPubkey,
      isAddStack: true,
      fetchImpl,
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const mergedCommunity = merged.stacks.find((s) => s.stack_id === "andreas/community");
    expect(mergedCommunity?.retired_at).toBe(retiredEntry!.retired_at);
    // The new stack is present + active; meta-factory stayed active.
    expect(merged.stacks.find((s) => s.stack_id === "andreas/laptop")?.retired_at).toBeUndefined();
    expect(merged.stacks.find((s) => s.stack_id === "andreas/meta-factory")?.retired_at).toBeUndefined();
  });

  test("retire refused (409) when the stack has a live ADMITTED membership", async () => {
    const { env } = await configuredEnv();
    const fetchImpl = registryFetch(env);
    const admin = await makePrincipalKey();
    const envWithAdmin: Env = { ...env, REGISTRY_ADMIN_PUBKEYS: admin.publicKeyB64 };
    const adminFetch = registryFetch(envWithAdmin);

    // Register + admit so andreas/default holds a live ADMITTED row.
    const root = generateStackIdentity({ seedPath: join(freshDir(), "root.nk") });
    const reg = await buildRegistrationClaim({
      principalId: "andreas",
      material: root,
      stacks: [{ stack_id: "andreas/default", stack_pubkey: root.pubkeyB64 }],
      networkId: "metafactory",
    });
    await registryApp.fetch(
      new Request("http://registry.test/principals/andreas/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reg),
      }),
      envWithAdmin,
    );
    const read = await makeSignedAdminRead(admin);
    const listRes = await adminFetch(
      new Request("http://registry.test/admission-requests?status=PENDING", {
        headers: { "x-admin-signed": JSON.stringify(read) },
      }),
    );
    const list = (await listRes.json()) as AdmissionRequest[];
    const decision = await makeSignedAdminDecision(list[0]!.request_id, "admit", admin);
    await adminFetch(
      new Request(`http://registry.test/admission-requests/${list[0]!.request_id}/admit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision),
      }),
    );

    const casRes = await adminFetch(new Request("http://registry.test/principals/andreas"));
    const cas = ((await casRes.json()) as { payload: { updated_at: string } }).payload.updated_at;
    const retireBody = await buildStackRetireClaim({
      principalId: "andreas",
      stackId: "andreas/default",
      rootMaterial: root,
      expectedUpdatedAt: cas,
    });
    const retireRes = await retireStackIdentity({
      registryUrl: "http://registry.test",
      principalId: "andreas",
      body: retireBody,
      fetchImpl,
    });
    expect(retireRes.ok).toBe(false);
    expect(retireRes.status).toBe(409);
  });
});

// =============================================================================
// cortex#1517 (S3, epic #1514) — signAdminRequest byte-identical + round-trip
// tests. Moved here (from a first draft in common/registry/__tests__/) so the
// signer lives with its own module — see the jsdoc on signAdminRequest in
// stack-provisioning.ts for why it's sited here rather than in
// common/registry/signing.ts (breaking, not documenting, an import cycle).
//
// Two guarantees this pins:
//   1. BYTE-IDENTICAL: a fixed seed + claim always produces the EXACT same
//      `{ claim, signature }` wire bytes — a regression in canonicalJSON key
//      order, encoding, or the `{claim,signature}` property order would flip
//      this pinned expectation. Ed25519 signing is deterministic, so this is
//      a stable pin, not a flaky one.
//   2. PRODUCER↔CONSUMER: the wire strings signAdminRequest produces verify
//      against the REAL registry pipeline — validate.ts's structural parse +
//      the route's own verifyEd25519 — for BOTH shapes it feeds: the
//      `x-admin-signed` HEADER (read claims, no nonce) and the POST BODY
//      (write claims, with nonce). No verifier is re-implemented here; the
//      test drives the real registry Worker app.
// =============================================================================

describe("signAdminRequest — byte-identical wire output", () => {
  // A fixed, throwaway NKey seed — generated once for this test, not tied to
  // any real principal/stack. Ed25519 signing is deterministic for a fixed
  // seed+message, so the expected values below are stable across runs.
  const SEED = "SUAMQMLLA3EQSHCIDTOI2TUIUOF55GWLQMYYCLKYWEVVA7KCXDXMWFQDWE";
  const EXPECTED_PUBKEY = "ZwMZ+myA1ULKR4Z80gGkcPNduFT4dYGosPWtrQ/EOqg=";
  const EXPECTED_SIGNATURE =
    "IQTqqP2W7hpYRmHCPXbEjozYIFbHbZ98IANfKKUz28t9Jmg2FoQLp2jqdXQXUma6rZ0DhTpGXduLFmSluER1Dw==";
  const EXPECTED_JSON =
    '{"claim":{"admin_pubkey":"ZwMZ+myA1ULKR4Z80gGkcPNduFT4dYGosPWtrQ/EOqg=","issued_at":"2026-01-01T00:00:00.000Z"},"signature":"IQTqqP2W7hpYRmHCPXbEjozYIFbHbZ98IANfKKUz28t9Jmg2FoQLp2jqdXQXUma6rZ0DhTpGXduLFmSluER1Dw=="}';

  test("fixed seed + claim → exact pinned signature and wire string", async () => {
    const material = materialFromSeedString(SEED);
    expect(material.pubkeyB64).toBe(EXPECTED_PUBKEY);

    const claim = { admin_pubkey: material.pubkeyB64, issued_at: "2026-01-01T00:00:00.000Z" };
    const signed = await signAdminRequest(material.seed, claim);

    // Key order matters here — this is a plain JSON.stringify, not
    // canonicalJSON — so `{claim, signature}` must stay in that order for
    // every hand-rolled copy this replaces to have produced identical bytes.
    expect(signed.signature).toBe(EXPECTED_SIGNATURE);
    expect(JSON.stringify(signed)).toBe(EXPECTED_JSON);
  });

  test("the pinned wire string verifies against the client-side verifier", async () => {
    const parsed = JSON.parse(EXPECTED_JSON) as { claim: Record<string, unknown>; signature: string };
    const message = new TextEncoder().encode(canonicalJSON(parsed.claim));
    const ok = await verifyEd25519(EXPECTED_PUBKEY, parsed.signature, message);
    expect(ok).toBe(true);
  });

  test("re-signing the SAME seed+claim is deterministic", async () => {
    const material = materialFromSeedString(SEED);
    const claim = { admin_pubkey: material.pubkeyB64, issued_at: "2026-01-01T00:00:00.000Z" };
    const a = await signAdminRequest(material.seed, claim);
    const b = await signAdminRequest(material.seed, claim);
    expect(a.signature).toBe(b.signature);
  });
});

describe("signAdminRequest — round-trips through the live registry (validate.ts + verify)", () => {
  async function configuredEnv(): Promise<{ env: Env; adminMaterial: ReturnType<typeof materialFromSeedString> }> {
    resetStores();
    const reg = await makeRegistryKey();
    const adminMaterial = generateStackIdentity({ seedPath: join(freshDir(), "admin.nk") });
    return {
      env: {
        REGISTRY_SIGNING_KEY: reg.signingKey,
        REGISTRY_PUBLIC_KEY: reg.publicKey,
        REGISTRY_ADMIN_PUBKEYS: adminMaterial.pubkeyB64,
        ENVIRONMENT: "test",
      },
      adminMaterial,
    };
  }

  test("READ claim (x-admin-signed header) — the exact CLI wire value is accepted", async () => {
    // The SAME claim shape + call every read call site (network.ts,
    // network-secret-adapters.ts, network-authorize-adapters.ts) builds.
    const { env, adminMaterial } = await configuredEnv();
    const claim = { admin_pubkey: adminMaterial.pubkeyB64, issued_at: new Date().toISOString() };
    const signed = await signAdminRequest(adminMaterial.seed, claim);

    const res = await registryApp.fetch(
      new Request("http://localhost/admission-requests?status=ADMITTED", {
        headers: { "x-admin-signed": JSON.stringify(signed) },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("WRITE claim (POST body) — an admit decision built the same way the CLI builds it is accepted", async () => {
    const { env, adminMaterial } = await configuredEnv();

    // Register a principal to get a PENDING admission request to decide on.
    const principal = generateStackIdentity({ seedPath: join(freshDir(), "carol.nk") });
    const regBody = await buildRegistrationClaim({
      principalId: "carol",
      material: principal,
      stacks: [{ stack_id: "carol/main", stack_pubkey: principal.pubkeyB64 }],
    });
    const regRes = await registryApp.fetch(
      new Request("http://localhost/principals/carol/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regBody),
      }),
      env,
    );
    expect(regRes.status).toBe(201);

    // Admin-signed read to find the request_id (same read-claim shape above).
    const readClaim = { admin_pubkey: adminMaterial.pubkeyB64, issued_at: new Date().toISOString() };
    const signedRead = await signAdminRequest(adminMaterial.seed, readClaim);
    const listRes = await registryApp.fetch(
      new Request("http://localhost/admission-requests?status=PENDING", {
        headers: { "x-admin-signed": JSON.stringify(signedRead) },
      }),
      env,
    );
    const list = (await listRes.json()) as AdmissionRequest[];
    const found = list.find((r) => r.principal_id === "carol");
    expect(found).toBeDefined();

    // The admit-decision claim — the exact shape `buildAdmissionDecisionBody`
    // (network.ts) builds and POSTs as the body, now routed through
    // signAdminRequest (S3).
    const decisionClaim = {
      request_id: found!.request_id,
      decision: "admit" as const,
      admin_pubkey: adminMaterial.pubkeyB64,
      issued_at: new Date().toISOString(),
      nonce: randomNonce(),
    };
    const signedDecision = await signAdminRequest(adminMaterial.seed, decisionClaim);

    const admitRes = await registryApp.fetch(
      new Request(`http://localhost/admission-requests/${found!.request_id}/admit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signedDecision),
      }),
      env,
    );
    expect(admitRes.status).toBe(200);
    const updated = (await admitRes.json()) as AdmissionRequest;
    expect(updated.status).toBe("ADMITTED");
  });
});
