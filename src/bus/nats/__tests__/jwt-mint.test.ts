/**
 * Prereq A for cortex#67: tests for the `mintUserCreds` wrapper.
 *
 * We pin behaviour against the `@nats-io/jwt` primitives by:
 *   - generating a real account signing nkey (cheap — ed25519),
 *   - minting,
 *   - decoding the JWT back with the official decoder, and
 *   - asserting structural + claims-shape properties.
 *
 * We do NOT stand up a NATS server here — the wrapper is pure crypto +
 * JWT encoding, no I/O. The integration test that verifies a real
 * `nats-server` accepts these creds lives downstream of cortex#67.
 */

import { describe, expect, test } from "bun:test";
import {
  createAccount,
  decode,
  fromSeed,
  type User,
} from "@nats-io/jwt";
import { buildUserPermissions, mintUserCreds } from "../jwt-mint";

function freshAccountSigningKey() {
  return createAccount();
}

describe("mintUserCreds", () => {
  test("produces a 3-part user JWT signed by the account key", async () => {
    const accountSigningKey = freshAccountSigningKey();
    const result = await mintUserCreds({
      accountSigningKey,
      agentId: "foo-bot",
      capabilities: ["code-review"],
      org: "acme",
    });

    const parts = result.userJwt.split(".");
    expect(parts.length).toBe(3);
    for (const p of parts) {
      expect(p.length).toBeGreaterThan(0);
    }

    const decoded = decode<User>(result.userJwt);
    expect(decoded.iss).toBe(accountSigningKey.getPublicKey());
    expect(decoded.name).toBe("foo-bot");
    // `@nats-io/jwt` places the entity type inside `nats.type`, not on the
    // top-level claim. Pin both — the top-level field is unset for users
    // (operators / accounts set it) which is itself a useful invariant.
    expect((decoded.nats as { type?: string }).type).toBe("user");
  });

  test("claims grant pub+sub on local.{org}.{cap}.> for each capability", async () => {
    const accountSigningKey = freshAccountSigningKey();
    const result = await mintUserCreds({
      accountSigningKey,
      agentId: "foo-bot",
      capabilities: ["code-review", "typescript"],
      org: "acme",
    });

    const decoded = decode<User>(result.userJwt);
    expect(decoded.nats.pub?.allow).toContain("local.acme.code-review.>");
    expect(decoded.nats.pub?.allow).toContain("local.acme.typescript.>");
    expect(decoded.nats.sub?.allow).toContain("local.acme.code-review.>");
    expect(decoded.nats.sub?.allow).toContain("local.acme.typescript.>");
  });

  test("claims include baseline capability-self-register + creds-handler pub", async () => {
    const accountSigningKey = freshAccountSigningKey();
    const result = await mintUserCreds({
      accountSigningKey,
      agentId: "foo-bot",
      capabilities: ["code-review"],
      org: "acme",
    });

    const decoded = decode<User>(result.userJwt);
    // Baseline pub-only entries
    expect(decoded.nats.pub?.allow).toContain(
      "local.acme.agents.capabilities.foo-bot",
    );
    expect(decoded.nats.pub?.allow).toContain("local.acme.cortex.creds.>");

    // ...and they are NOT in the sub allow-list (baseline is pub-only).
    expect(decoded.nats.sub?.allow ?? []).not.toContain(
      "local.acme.agents.capabilities.foo-bot",
    );
    expect(decoded.nats.sub?.allow ?? []).not.toContain(
      "local.acme.cortex.creds.>",
    );
  });

  test("empty capabilities array yields only baseline perms", async () => {
    const accountSigningKey = freshAccountSigningKey();
    const result = await mintUserCreds({
      accountSigningKey,
      agentId: "bare-bot",
      capabilities: [],
      org: "acme",
    });

    const decoded = decode<User>(result.userJwt);

    // sub allow-list is empty (no capability prefixes; baseline is pub-only)
    expect(decoded.nats.sub?.allow ?? []).toEqual([]);

    // pub allow-list contains exactly the two baseline entries
    const pubAllow = decoded.nats.pub?.allow ?? [];
    expect(pubAllow).toContain("local.acme.agents.capabilities.bare-bot");
    expect(pubAllow).toContain("local.acme.cortex.creds.>");
    expect(pubAllow.length).toBe(2);
  });

  test("userSeed is a valid user nkey seed (SU… prefix, round-trips via fromSeed)", async () => {
    const accountSigningKey = freshAccountSigningKey();
    const result = await mintUserCreds({
      accountSigningKey,
      agentId: "foo-bot",
      capabilities: ["code-review"],
      org: "acme",
    });

    expect(result.userSeed.startsWith("SU")).toBe(true);

    // Round-trip: the seed must decode back to a usable KeyPair whose
    // public key matches the JWT subject. This is the load-bearing check
    // that the seed and JWT belong to the same identity.
    const kp = fromSeed(new TextEncoder().encode(result.userSeed));
    const decoded = decode<User>(result.userJwt);
    expect(decoded.sub).toBe(kp.getPublicKey());
  });

  test("credsFile is a string containing both JWT and SEED PEM-like blocks", async () => {
    const accountSigningKey = freshAccountSigningKey();
    const result = await mintUserCreds({
      accountSigningKey,
      agentId: "foo-bot",
      capabilities: ["code-review"],
      org: "acme",
    });

    // The `@nats-io/jwt` `fmtCreds` produces standard NATS creds files.
    // We assert the block markers are present (case-sensitive) and that
    // the JWT and seed bodies appear inside them. We deliberately do NOT
    // pin the exact dash count — that's an `@nats-io/jwt` implementation
    // detail and would couple us to their internal formatter shape.
    expect(typeof result.credsFile).toBe("string");
    expect(result.credsFile).toContain("BEGIN NATS USER JWT");
    expect(result.credsFile).toContain("END NATS USER JWT");
    expect(result.credsFile).toContain("BEGIN USER NKEY SEED");
    expect(result.credsFile).toContain("END USER NKEY SEED");
    expect(result.credsFile).toContain(result.userJwt);
    expect(result.credsFile).toContain(result.userSeed);
  });

  test("agentId with NATS subject wildcards is rejected", async () => {
    const accountSigningKey = freshAccountSigningKey();
    for (const bad of ["foo.bot", "foo*", "foo>", "foo bot", ""]) {
      await expect(
        mintUserCreds({
          accountSigningKey,
          agentId: bad,
          capabilities: ["code-review"],
          org: "acme",
        }),
      ).rejects.toThrow(/agentId/);
    }
  });

  test("org with NATS subject wildcards is rejected", async () => {
    const accountSigningKey = freshAccountSigningKey();
    await expect(
      mintUserCreds({
        accountSigningKey,
        agentId: "foo-bot",
        capabilities: ["code-review"],
        org: "ac*me",
      }),
    ).rejects.toThrow(/org/);
  });

  test("capability with NATS subject wildcards is rejected", async () => {
    const accountSigningKey = freshAccountSigningKey();
    await expect(
      mintUserCreds({
        accountSigningKey,
        agentId: "foo-bot",
        capabilities: ["code-review.>"],
        org: "acme",
      }),
    ).rejects.toThrow(/capability/);
  });

  test("each call mints a fresh user nkey (non-idempotent)", async () => {
    const accountSigningKey = freshAccountSigningKey();
    const a = await mintUserCreds({
      accountSigningKey,
      agentId: "foo-bot",
      capabilities: ["code-review"],
      org: "acme",
    });
    const b = await mintUserCreds({
      accountSigningKey,
      agentId: "foo-bot",
      capabilities: ["code-review"],
      org: "acme",
    });

    expect(a.userSeed).not.toBe(b.userSeed);
    expect(a.userJwt).not.toBe(b.userJwt);

    const da = decode<User>(a.userJwt);
    const db = decode<User>(b.userJwt);
    expect(da.sub).not.toBe(db.sub);

    // ...but both are signed by the same account.
    expect(da.iss).toBe(db.iss);
  });
});

describe("buildUserPermissions", () => {
  test("returns deterministic permission set for the same inputs", () => {
    const a = buildUserPermissions({
      agentId: "foo",
      capabilities: ["code-review", "typescript"],
      org: "acme",
    });
    const b = buildUserPermissions({
      agentId: "foo",
      capabilities: ["code-review", "typescript"],
      org: "acme",
    });
    expect(a).toEqual(b);
  });

  test("preserves capability order in the pub/sub allow lists", () => {
    const perms = buildUserPermissions({
      agentId: "foo",
      capabilities: ["a", "b", "c"],
      org: "acme",
    });
    expect(perms.pub?.allow?.slice(0, 3)).toEqual([
      "local.acme.a.>",
      "local.acme.b.>",
      "local.acme.c.>",
    ]);
    expect(perms.sub?.allow).toEqual([
      "local.acme.a.>",
      "local.acme.b.>",
      "local.acme.c.>",
    ]);
  });
});
