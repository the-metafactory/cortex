/**
 * TC-1b (#632) — `cortex provision-stack` CLI tests.
 *
 * Coverage:
 *   1. generate writes a seed (mode 600) + prints pubkey, NOT the seed.
 *   2. generate --json envelope carries pubkey + fingerprint, no seed.
 *   3. generate refuses to clobber without --force (exit 1); --force succeeds.
 *   4. generate rejects a bad principal-id (exit 2).
 *   5. claim prints a signed body for an existing seed (no network).
 *   6. register POSTs the proof-of-possession claim through an injected
 *      registry route and reports success; a rejecting route → exit 1.
 *   7. no seed material in stdout/stderr on any path.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { dispatchProvisionStack } from "../provision-stack";
// C-819 — seed an existing principal that ALREADY announces network caps (the
// CLI register path announces none), so the add-stack preservation can be
// asserted end-to-end. Same NKey root the CLI uses, so the rotation gate admits
// the later add-stack.
import {
  buildRegistrationClaim,
  materialFromSeedString,
} from "../../../../bus/stack-provisioning";

// Real registry route for the register round-trip.
import registryApp from "../../../../services/network-registry/src/index";
import type { Env } from "../../../../services/network-registry/src/index";
import {
  makeRegistryKey,
  makePrincipalKey,
  makeSignedAdminRead,
  makeSignedAdminDecision,
  resetStores,
  type PrincipalKey,
} from "../../../../services/network-registry/__tests__/helpers";
import type { AdmissionRequest } from "../../../../services/network-registry/src/types";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tc1b-cli-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  resetStores();
});

/** Read the seed off disk so we can assert it never appears in CLI output. */
function seedOnDisk(path: string): string {
  return readFileSync(path, "utf-8").trim();
}

describe("cortex provision-stack generate (TC-1b #632)", () => {
  test("[1] writes seed chmod 600, prints pubkey (not the seed)", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    const res = await dispatchProvisionStack([
      "generate",
      "andreas",
      "--seed-path",
      seedPath,
    ]);
    expect(res.exitCode).toBe(0);
    expect(existsSync(seedPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(seedPath).mode & 0o777).toBe(0o600);
    }
    // stdout shows the NKey pub + the cortex.yaml block.
    expect(res.stdout).toContain("nkey_pub:");
    expect(res.stdout).toContain("andreas/default");
    // SECRET: the seed must NOT be in any output.
    const seed = seedOnDisk(seedPath);
    expect(res.stdout).not.toContain(seed);
    expect(res.stderr).not.toContain(seed);
  });

  test("[2] --json envelope carries pubkey + fingerprint, no seed", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    const res = await dispatchProvisionStack([
      "generate",
      "andreas",
      "--seed-path",
      seedPath,
      "--json",
    ]);
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as {
      status: string;
      data: Record<string, string>;
    };
    expect(env.status).toBe("ok");
    expect(env.data.nkey_pub).toMatch(/^U/);
    const pub = env.data.pubkey_b64 ?? "";
    expect(pub.length).toBe(44);
    expect(env.data.fingerprint).toBe(pub.slice(0, 12));
    expect(env.data.seed_mode).toBe("600");
    // No seed field anywhere in the envelope.
    expect(JSON.stringify(env)).not.toContain(seedOnDisk(seedPath));
  });

  test("[3] refuses to clobber without --force (exit 1); --force succeeds", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);
    const first = seedOnDisk(seedPath);

    const refuse = await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);
    expect(refuse.exitCode).toBe(1);
    expect(refuse.stderr).toMatch(/refusing to overwrite/i);
    expect(seedOnDisk(seedPath)).toBe(first); // unchanged

    const forced = await dispatchProvisionStack([
      "generate",
      "andreas",
      "--seed-path",
      seedPath,
      "--force",
    ]);
    expect(forced.exitCode).toBe(0);
    expect(seedOnDisk(seedPath)).not.toBe(first); // rotated
  });

  test("[4] rejects a bad principal-id (exit 2)", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    const res = await dispatchProvisionStack([
      "generate",
      "BAD_CAPS",
      "--seed-path",
      seedPath,
    ]);
    expect(res.exitCode).toBe(2);
    expect(existsSync(seedPath)).toBe(false);
  });

  test("[4b] rejects --stack-id whose prefix mismatches principal (exit 2)", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    const res = await dispatchProvisionStack([
      "generate",
      "andreas",
      "--seed-path",
      seedPath,
      "--stack-id",
      "someoneelse/research",
    ]);
    expect(res.exitCode).toBe(2);
  });
});

describe("cortex provision-stack claim (TC-1b #632)", () => {
  test("[5] prints a signed body for an existing seed (no network)", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);

    const res = await dispatchProvisionStack(["claim", "andreas", "--seed-path", seedPath]);
    expect(res.exitCode).toBe(0);
    const body = JSON.parse(res.stdout) as {
      claim: { principal_id: string; principal_pubkey: string; stacks: { stack_id: string }[] };
      signature: string;
    };
    expect(body.claim.principal_id).toBe("andreas");
    expect(body.claim.stacks[0]!.stack_id).toBe("andreas/default");
    expect(body.signature.length).toBeGreaterThan(0);
    // The printed body is public — but the raw seed must still not appear.
    expect(res.stdout).not.toContain(seedOnDisk(seedPath));
  });
});

describe("cortex provision-stack register (TC-1b #632)", () => {
  async function configuredEnv(): Promise<Env> {
    resetStores();
    const reg = await makeRegistryKey();
    return {
      REGISTRY_SIGNING_KEY: reg.signingKey,
      REGISTRY_PUBLIC_KEY: reg.publicKey,
      ENVIRONMENT: "test",
    };
  }

  test("[6] register POSTs proof-of-possession and reports success", async () => {
    const env = await configuredEnv();
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);

    // Patch global fetch to route to the in-memory registry app.
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
    try {
      const res = await dispatchProvisionStack([
        "register",
        "andreas",
        "--seed-path",
        seedPath,
        "--registry-url",
        "http://registry.test",
        "--json",
      ]);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as { status: string; data: Record<string, string> };
      expect(out.status).toBe("ok");
      expect(out.data.registered).toContain("HTTP 201");
      expect(res.stdout).not.toContain(seedOnDisk(seedPath));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("[6c] register --network surfaces the admission request_id + PENDING state (C-1315)", async () => {
    const env = await configuredEnv();
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
    try {
      const res = await dispatchProvisionStack([
        "register",
        "andreas",
        "--seed-path",
        seedPath,
        "--registry-url",
        "http://registry.test",
        "--network",
        "metafactory",
        "--json",
      ]);
      expect(res.exitCode).toBe(0);
      const out = JSON.parse(res.stdout) as { data: Record<string, string> };
      // C-1315 — the register response itself carries no request_id; the CLI
      // does a PoP `/admission-requests/mine` read to surface it.
      expect(out.data.network_id).toBe("metafactory");
      expect(out.data.admission_status).toBe("PENDING");
      expect(out.data.sealed_secret).toBe("missing");
      expect(typeof out.data.request_id).toBe("string");
      expect(out.data.request_id!.length).toBeGreaterThan(0);
      expect(out.data.next_for_admin).toContain("cortex network admit");
      expect(out.data.next_for_admin).toContain("secret add-member metafactory");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("[6d] register --network human output prints the request-id + next-for-admin (C-1315)", async () => {
    const env = await configuredEnv();
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "jc", "--seed-path", seedPath]);

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
    try {
      const res = await dispatchProvisionStack([
        "register",
        "jc",
        "--seed-path",
        seedPath,
        "--registry-url",
        "http://registry.test",
        "--network",
        "metafactory",
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("request-id:");
      expect(res.stdout).toContain("admission: PENDING");
      expect(res.stdout).toContain("next (admin):");
      // The seed never leaks into human output.
      expect(res.stdout).not.toContain(seedOnDisk(seedPath));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("[6b] register surfaces a registry rejection as exit 1", async () => {
    // Unconfigured registry → 503 registry_unconfigured.
    const env: Env = { ENVIRONMENT: "test" };
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);

    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
    try {
      const res = await dispatchProvisionStack([
        "register",
        "andreas",
        "--seed-path",
        seedPath,
        "--registry-url",
        "http://registry.test",
      ]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toMatch(/registry rejected/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("cortex provision-stack register — C-787 add-stack (no data loss)", () => {
  // C-791 — the add-stack merge-read is signature-verified, so tests must thread
  // the registry pubkey. We keep it alongside the env so each test can pass it
  // via --registry-pubkey.
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

  /** Route the CLI's global fetch at the in-memory registry app for `env`. */
  function routeFetchToRegistry(env: Env): () => void {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      return registryApp.fetch(req, env);
    }) as typeof globalThis.fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  test("adding a 2nd stack via --principal-seed PRESERVES the existing stack (each with its own pubkey)", async () => {
    const env = await configuredEnv();
    const dir = freshDir();
    const rootSeed = join(dir, "meta-factory.nk"); // the principal ROOT (first stack)
    const communitySeed = join(dir, "community.nk"); // the joining stack's own key

    // Generate both keys locally.
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", rootSeed]);
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", communitySeed]);

    const restore = routeFetchToRegistry(env);
    try {
      // 1. First registration — establishes andreas/meta-factory + the root.
      const first = await dispatchProvisionStack([
        "register",
        "andreas",
        "--seed-path",
        rootSeed,
        "--stack-id",
        "andreas/meta-factory",
        "--registry-url",
        "http://registry.test",
      ]);
      expect(first.exitCode).toBe(0);

      // 2. Add-stack — register andreas/community signed by the ROOT seed.
      const add = await dispatchProvisionStack([
        "register",
        "andreas",
        "--seed-path",
        communitySeed,
        "--stack-id",
        "andreas/community",
        "--principal-seed",
        rootSeed,
        "--registry-url",
        "http://registry.test",
        // C-791 — pin the registry pubkey so the merge-read verifies.
        "--registry-pubkey",
        registryPubkey,
      ]);
      expect(add.exitCode).toBe(0);

      // 3. Assert the registry now holds BOTH stacks — meta-factory MUST survive
      //    (this is the federation #787 exists to preserve), each with its own
      //    stack_pubkey.
      const getRes = await registryApp.fetch(
        new Request("http://registry.test/principals/andreas"),
        env,
      );
      expect(getRes.status).toBe(200);
      const json = (await getRes.json()) as {
        payload: { stacks: { stack_id: string; stack_pubkey?: string }[] };
      };
      const byId = new Map(json.payload.stacks.map((s) => [s.stack_id, s.stack_pubkey]));
      expect([...byId.keys()].sort()).toEqual([
        "andreas/community",
        "andreas/meta-factory",
      ]);
      // Each carries a distinct, well-formed per-stack key.
      expect(byId.get("andreas/meta-factory")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(byId.get("andreas/community")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(byId.get("andreas/meta-factory")).not.toBe(byId.get("andreas/community"));
    } finally {
      restore();
    }
  });

  test("ADR-0018 Gap-A — register --network pins the PENDING admission request to the network", async () => {
    const env = await configuredEnv();
    const dir = freshDir();
    const seed = join(dir, "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seed]);

    const restore = routeFetchToRegistry(env);
    try {
      const res = await dispatchProvisionStack([
        "register",
        "andreas",
        "--seed-path",
        seed,
        "--stack-id",
        "andreas/meta-factory",
        "--registry-url",
        "http://registry.test",
        "--network",
        "research-collab",
      ]);
      expect(res.exitCode).toBe(0);

      // The admission request created by the register hook carries network_id.
      const read = await makeSignedAdminRead(adminKey!);
      const listRes = await registryApp.fetch(
        new Request("http://registry.test/admission-requests?status=PENDING", {
          headers: { "x-admin-signed": JSON.stringify(read) },
        }),
        env,
      );
      const list = (await listRes.json()) as AdmissionRequest[];
      const andreas = list.filter((r) => r.principal_id === "andreas");
      expect(andreas.length).toBe(1);
      expect(andreas[0]!.network_id).toBe("research-collab");
    } finally {
      restore();
    }
  });

  test("ADR-0018 Gap-A — register rejects a malformed --network (exit 2, no POST)", async () => {
    const env = await configuredEnv();
    const dir = freshDir();
    const seed = join(dir, "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seed]);
    const res = await dispatchProvisionStack([
      "register",
      "andreas",
      "--seed-path",
      seed,
      "--registry-url",
      "http://registry.test",
      "--network",
      "Bad_Net",
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/--network/);
    void env;
  });

  test("first registration (principal absent) still works — fetch+merge degrades to just the new stack", async () => {
    const env = await configuredEnv();
    const dir = freshDir();
    const seed = join(dir, "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seed]);

    const restore = routeFetchToRegistry(env);
    try {
      const res = await dispatchProvisionStack([
        "register",
        "andreas",
        "--seed-path",
        seed,
        "--stack-id",
        "andreas/meta-factory",
        "--registry-url",
        "http://registry.test",
      ]);
      expect(res.exitCode).toBe(0);
      const getRes = await registryApp.fetch(
        new Request("http://registry.test/principals/andreas"),
        env,
      );
      const json = (await getRes.json()) as {
        payload: { stacks: { stack_id: string }[] };
      };
      expect(json.payload.stacks.map((s) => s.stack_id)).toEqual(["andreas/meta-factory"]);
    } finally {
      restore();
    }
  });

  test("C-791 SECURITY — add-stack WITHOUT --registry-pubkey fails closed (unverifiable merge-read)", async () => {
    const env = await configuredEnv();
    const dir = freshDir();
    const rootSeed = join(dir, "meta-factory.nk");
    const communitySeed = join(dir, "community.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", rootSeed]);
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", communitySeed]);

    const restore = routeFetchToRegistry(env);
    try {
      // Establish the principal (first register — no merge-read needed).
      const first = await dispatchProvisionStack([
        "register", "andreas", "--seed-path", rootSeed,
        "--stack-id", "andreas/meta-factory", "--registry-url", "http://registry.test",
        "--registry-pubkey", registryPubkey,
      ]);
      expect(first.exitCode).toBe(0);

      // Add-stack WITHOUT --registry-pubkey: the destructive merge-read cannot be
      // verified, so the command MUST fail closed rather than re-attest off an
      // unverifiable read. The existing meta-factory stack is preserved.
      const add = await dispatchProvisionStack([
        "register", "andreas", "--seed-path", communitySeed,
        "--stack-id", "andreas/community", "--principal-seed", rootSeed,
        "--registry-url", "http://registry.test",
      ]);
      expect(add.exitCode).toBe(1);
      expect(add.stderr).toMatch(/no pinned registry pubkey|unverif/i);

      const getRes = await registryApp.fetch(
        new Request("http://registry.test/principals/andreas"),
        env,
      );
      const json = (await getRes.json()) as { payload: { stacks: { stack_id: string }[] } };
      expect(json.payload.stacks.map((s) => s.stack_id)).toEqual(["andreas/meta-factory"]);
    } finally {
      restore();
    }
  });

  // ===========================================================================
  // C-819 — add-stack register PRESERVES the principal's capabilities (and thus
  // their roster membership). Live repro: standing up `jc/clawbox` dropped JC's
  // community caps → `metafactory-community` roster went `jc → empty`.
  // ===========================================================================
  test("C-819 — adding a 2nd stack PRESERVES the principal's caps + roster membership", async () => {
    const env = await configuredEnv();
    const dir = freshDir();
    const rootSeed = join(dir, "jc-root.nk"); // principal ROOT (first stack)
    const clawboxSeed = join(dir, "jc-clawbox.nk"); // the joining stack's own key

    await dispatchProvisionStack(["generate", "jc", "--seed-path", rootSeed]);
    await dispatchProvisionStack(["generate", "jc", "--seed-path", clawboxSeed]);

    const restore = routeFetchToRegistry(env);
    try {
      // 1. Seed `jc` WITH a community capability so JC lands on the community
      //    roster. The CLI register announces no caps, so build this first claim
      //    (with caps) directly using the SAME NKey root the CLI generated.
      const root = materialFromSeedString(readFileSync(rootSeed, "utf-8"));
      const seedBody = await buildRegistrationClaim({
        principalId: "jc",
        material: root,
        stacks: [{ stack_id: "jc/meta-factory" }],
        capabilities: [
          { id: "tasks.code-review", description: "JC reviews", networks: ["community-net"] },
        ],
        // ADR-0018 Gap-A — name the target network so admission is pinned to it.
        networkId: "community-net",
      });
      const seedRes = await registryApp.fetch(
        new Request("http://registry.test/principals/jc/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(seedBody),
        }),
        env,
      );
      expect(seedRes.status).toBe(201);
      // ADR-0018 Gap-B — admit JC into community-net so they appear on the
      // (admission-sourced) roster.
      await admitInto(env, "jc", "community-net");

      // Precondition: JC is on the community roster.
      const rosterBefore = await registryApp.fetch(
        new Request("http://registry.test/networks/community-net/roster"),
        env,
      );
      const before = (await rosterBefore.json()) as {
        payload: { members: { principal_id: string }[] };
      };
      expect(before.payload.members.map((m) => m.principal_id)).toEqual(["jc"]);

      // 2. Stand up `jc/clawbox` via the CLI add-stack path (root-signed). It
      //    announces NO caps — pre-fix this zeroed JC's cap set.
      const add = await dispatchProvisionStack([
        "register", "jc",
        "--seed-path", clawboxSeed,
        "--stack-id", "jc/clawbox",
        "--principal-seed", rootSeed,
        "--registry-url", "http://registry.test",
        "--registry-pubkey", registryPubkey,
      ]);
      expect(add.exitCode).toBe(0);

      // 3. JC's admission survived the add-stack re-register → JC is STILL on the
      //    community roster (ADR-0018 Gap-B: membership is admission-sourced; the
      //    add-stack register raises a separate network-less PENDING row and does
      //    not disturb the ADMITTED community-net row). Caps preservation (the
      //    C-819 footgun) is asserted directly on the principal record below.
      const rosterAfter = await registryApp.fetch(
        new Request("http://registry.test/networks/community-net/roster"),
        env,
      );
      const after = (await rosterAfter.json()) as {
        payload: { members: { principal_id: string }[] };
      };
      expect(after.payload.members.map((m) => m.principal_id)).toEqual(["jc"]);

      // And both stacks are present (no regression to the C-787 stack merge).
      const getRes = await registryApp.fetch(
        new Request("http://registry.test/principals/jc"),
        env,
      );
      const principal = (await getRes.json()) as {
        payload: {
          stacks: { stack_id: string }[];
          capabilities: { id: string; networks?: string[] }[];
        };
      };
      expect(principal.payload.stacks.map((s) => s.stack_id).sort()).toEqual([
        "jc/clawbox",
        "jc/meta-factory",
      ]);
      expect(principal.payload.capabilities.map((cc) => cc.id)).toEqual(["tasks.code-review"]);
    } finally {
      restore();
    }
  });
});

// =============================================================================
// C-1269 — register DETECTS `admission_request: "failed"`, retries ONCE, and
// fails loud (never a silent success). These mock the registry HTTP responses
// directly so the admission flag can be controlled per-attempt — the first
// external walker (#1262) ended up registered with NO PENDING admission row and
// nothing to admit, precisely because the client ignored this signal.
// =============================================================================
describe("cortex provision-stack register — C-1269 admission-request detection", () => {
  /**
   * Queue registry responses; each POST /register pops the next (last repeats).
   * The first-register path makes exactly ONE POST per attempt (no GET, since
   * it is not an add-stack), so `posts()` counts retry attempts directly.
   */
  function mockRegistry(responses: { status: number; body: unknown }[]): {
    fetch: typeof globalThis.fetch;
    posts: () => number;
  } {
    let i = 0;
    let posts = 0;
    const fn = ((input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.method === "POST") {
        const r = responses[Math.min(i, responses.length - 1)]!;
        i += 1;
        posts += 1;
        return Promise.resolve(
          new Response(JSON.stringify(r.body), {
            status: r.status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      // The first-register path issues no GET; anything else is a test bug.
      return Promise.resolve(new Response(JSON.stringify({ error: "unexpected_get" }), { status: 500 }));
    }) as typeof globalThis.fetch;
    return { fetch: fn, posts: () => posts };
  }

  const ASSERTION = { payload: { principal_id: "andreas" }, issued_at: "t", registry: "R", signature: "sig" };
  const FAILED_WARNING =
    "registered, but the PENDING admission request could not be created; re-register to retry (the upsert is idempotent)";
  const failedBody = { ...ASSERTION, admission_request: "failed", warning: FAILED_WARNING };

  async function withFetch<T>(f: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = f;
    try {
      return await run();
    } finally {
      globalThis.fetch = real;
    }
  }

  test("(a) clean register — PENDING landed → exit 0, admission_request=ok, single POST", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);
    const mock = mockRegistry([{ status: 201, body: ASSERTION }]);
    const res = await withFetch(mock.fetch, () =>
      dispatchProvisionStack([
        "register", "andreas", "--seed-path", seedPath,
        "--registry-url", "http://registry.test", "--json",
      ]),
    );
    expect(res.exitCode).toBe(0);
    expect(mock.posts()).toBe(1); // no retry on a clean register
    const out = JSON.parse(res.stdout) as { status: string; data: Record<string, string> };
    expect(out.status).toBe("ok");
    expect(out.data.admission_request).toBe("ok");
    expect(out.data.registered).not.toContain("automatic retry");
  });

  test("(b) admission failed then retry OK → exit 0, retried once, admission_request=ok", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);
    const mock = mockRegistry([
      { status: 201, body: failedBody },   // first attempt: admission did not land
      { status: 201, body: ASSERTION },    // retry: clean
    ]);
    const res = await withFetch(mock.fetch, () =>
      dispatchProvisionStack([
        "register", "andreas", "--seed-path", seedPath,
        "--registry-url", "http://registry.test", "--network", "research-collab", "--json",
      ]),
    );
    expect(res.exitCode).toBe(0);
    expect(mock.posts()).toBe(2); // retried exactly once
    const out = JSON.parse(res.stdout) as { status: string; data: Record<string, string> };
    expect(out.status).toBe("ok");
    expect(out.data.admission_request).toBe("ok");
    expect(out.data.registered).toContain("landed on automatic retry");
  });

  test("(c) admission failed then retry STILL failed → exit 1, actionable, retried once", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);
    const mock = mockRegistry([{ status: 201, body: failedBody }]); // every attempt fails admission
    const res = await withFetch(mock.fetch, () =>
      dispatchProvisionStack([
        "register", "andreas", "--seed-path", seedPath,
        "--registry-url", "http://registry.test", "--network", "research-collab",
      ]),
    );
    expect(res.exitCode).toBe(1); // NON-ZERO — never a silent success
    expect(mock.posts()).toBe(2); // one initial + one retry
    // Actionable: names the network, the warning, and the manual re-register fallback.
    expect(res.stderr).toContain("research-collab");
    expect(res.stderr).toContain(FAILED_WARNING);
    expect(res.stderr).toMatch(/re-register/i);
    expect(res.stderr).toContain("cortex provision-stack register andreas");
    expect(res.stderr).toContain("--network research-collab");
  });

  test("(c-json) failed-after-retry with --json → error envelope carries admission context", async () => {
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);
    const mock = mockRegistry([{ status: 201, body: failedBody }]);
    const res = await withFetch(mock.fetch, () =>
      dispatchProvisionStack([
        "register", "andreas", "--seed-path", seedPath,
        "--registry-url", "http://registry.test", "--network", "research-collab", "--json",
      ]),
    );
    expect(res.exitCode).toBe(1);
    const env = JSON.parse(res.stderr) as {
      status: string;
      error: { reason: string; context: Record<string, string> };
    };
    expect(env.status).toBe("error");
    expect(env.error.context.admission_request).toBe("failed");
    expect(env.error.context.network).toBe("research-collab");
    expect(env.error.context.warning).toBe(FAILED_WARNING);
    expect(env.error.context.manual_fallback).toContain("cortex provision-stack register andreas");
  });

  test("(d) admission failed then retry POST itself errors → exit 1, SAME actionable fallback (#1377)", async () => {
    // #1377 review nit — when the RETRY POST fails at the transport/registry
    // layer (not "2xx but admission failed"), the exit must still be non-zero
    // AND carry the SAME actionable manual-fallback command, not a bare reason
    // that omits it. The retry's error is folded into the surfaced warning.
    const seedPath = join(freshDir(), "stack.nk");
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", seedPath]);
    const mock = mockRegistry([
      { status: 201, body: failedBody },                  // attempt 1: 2xx but admission failed
      { status: 500, body: { error: "registry_down" } },  // retry: registry/transport error
    ]);
    const res = await withFetch(mock.fetch, () =>
      dispatchProvisionStack([
        "register", "andreas", "--seed-path", seedPath,
        "--registry-url", "http://registry.test", "--network", "research-collab",
      ]),
    );
    expect(res.exitCode).toBe(1); // NON-ZERO — never a silent success
    expect(mock.posts()).toBe(2); // one initial + one retry
    // Same actionable surface as path (c): network + manual re-register fallback.
    expect(res.stderr).toContain("research-collab");
    expect(res.stderr).toMatch(/re-register/i);
    expect(res.stderr).toContain("cortex provision-stack register andreas");
    // The retry's transport error is folded into the warning.
    expect(res.stderr).toMatch(/automatic retry also failed/i);
  });

  test("(e) generate --register --json surfaces admission_request (parity with register, #1377)", async () => {
    // #1377 review major — the generate --register success --json path must
    // carry admission_request too, matching the standalone register contract.
    const seedPath = join(freshDir(), "stack.nk");
    const mock = mockRegistry([{ status: 201, body: ASSERTION }]);
    const res = await withFetch(mock.fetch, () =>
      dispatchProvisionStack([
        "generate", "andreas", "--seed-path", seedPath,
        "--register", "--registry-url", "http://registry.test", "--json",
      ]),
    );
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout) as { status: string; data: Record<string, string> };
    expect(out.status).toBe("ok");
    expect(out.data.admission_request).toBe("ok");
  });
});

// =============================================================================
// C-1269 (#1377 review) — the SUBTLEST guarantee: on the ADD-STACK path the
// retry must REBUILD the claim (fresh signature-verified merge-read → fresh
// `expected_updated_at` CAS token), NOT blind re-POST attempt-1's now-stale
// body. Attempt 1 already bumped `updated_at`, so a blind re-POST would 409
// `stale_record`. This exercises the real in-memory registry (not a canned
// mock) so the CAS is genuinely enforced: exit 0 is proof the retry rebuilt.
// =============================================================================
describe("cortex provision-stack register — C-1269 add-stack CAS-rebuild-on-retry (#1377)", () => {
  async function configuredEnv(): Promise<{ env: Env; registryPubkey: string }> {
    resetStores();
    const reg = await makeRegistryKey();
    const adminKey = await makePrincipalKey();
    return {
      env: {
        REGISTRY_SIGNING_KEY: reg.signingKey,
        REGISTRY_PUBLIC_KEY: reg.publicKey,
        REGISTRY_ADMIN_PUBKEYS: adminKey.publicKeyB64,
        ENVIRONMENT: "test",
      },
      registryPubkey: reg.publicKey,
    };
  }

  test("add-stack retry REBUILDS with a fresh CAS token → 2xx instead of 409 stale_record", async () => {
    const { env, registryPubkey } = await configuredEnv();
    const dir = freshDir();
    const rootSeed = join(dir, "meta-factory.nk"); // principal ROOT (first stack)
    const communitySeed = join(dir, "community.nk"); // the joining stack's key
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", rootSeed]);
    await dispatchProvisionStack(["generate", "andreas", "--seed-path", communitySeed]);

    const realFetch = globalThis.fetch;
    let registerPosts = 0;
    let mergeReadGets = 0;
    let injectFailedOnNextPost = false;
    // Route the CLI fetch at the real registry, but on the FIRST add-stack POST
    // rewrite the (real, state-changing) 2xx response body to carry
    // `admission_request: "failed"`. The principal record still commits +
    // `updated_at` still bumps — so a blind re-POST of attempt-1's stale CAS
    // token would 409. Only a genuine rebuild (fresh merge-read) yields 2xx.
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname.startsWith("/principals/")) mergeReadGets += 1;
      const res = await registryApp.fetch(req, env);
      if (req.method === "POST") {
        registerPosts += 1;
        if (injectFailedOnNextPost && res.ok) {
          injectFailedOnNextPost = false;
          const body = (await res.clone().json()) as Record<string, unknown>;
          return new Response(
            JSON.stringify({ ...body, admission_request: "failed", warning: "injected: PENDING upsert failed" }),
            { status: res.status, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      return res;
    }) as typeof globalThis.fetch;

    try {
      // 1. First registration — clean (establishes the root + andreas/meta-factory).
      const first = await dispatchProvisionStack([
        "register", "andreas", "--seed-path", rootSeed,
        "--stack-id", "andreas/meta-factory", "--registry-url", "http://registry.test",
      ]);
      expect(first.exitCode).toBe(0);

      // 2. Add-stack — inject an admission failure on the first add-stack POST so
      //    the client MUST retry. Attempt 1 bumps updated_at; the retry must
      //    re-read it or the registry 409s.
      const postsBefore = registerPosts;
      const getsBefore = mergeReadGets;
      injectFailedOnNextPost = true;
      const add = await dispatchProvisionStack([
        "register", "andreas", "--seed-path", communitySeed,
        "--stack-id", "andreas/community", "--principal-seed", rootSeed,
        "--registry-url", "http://registry.test", "--registry-pubkey", registryPubkey,
      ]);

      // Exit 0 is the proof: a blind re-POST of the stale token would 409 →
      // exit 1. Success means the retry rebuilt with the fresh CAS token.
      expect(add.exitCode).toBe(0);
      expect(registerPosts - postsBefore).toBe(2); // one initial + exactly one retry
      // Each add-stack attempt re-issued its own signature-verified merge-read.
      expect(mergeReadGets - getsBefore).toBeGreaterThanOrEqual(2);

      // Registry ended consistent — both stacks survive (no data loss on retry).
      const getRes = await registryApp.fetch(new Request("http://registry.test/principals/andreas"), env);
      const json = (await getRes.json()) as { payload: { stacks: { stack_id: string }[] } };
      expect(json.payload.stacks.map((s) => s.stack_id).sort()).toEqual([
        "andreas/community",
        "andreas/meta-factory",
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
