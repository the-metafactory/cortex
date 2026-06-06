/**
 * S3 (Network Join Control Plane, #737) — leaf-remote renderer tests (RED-first).
 *
 * The renderer is the DD-6 unit: given a verified {@link NetworkDescriptor}
 * (hub_url/leaf_port from the registry, DD-12) plus the stack's leaf creds
 * path and bound NATS account, it produces the nats-server leaf-remote
 * config fragment for that network. S4's `cortex network join` writes the
 * output; these tests assert on the produced config ONLY — never on live
 * infra (no `~/.config/nats/local.conf`, no daemon).
 *
 * Design choice under test (documented in the module header): a per-network
 * **include file** (`leafnodes-<network>.conf`) holding a complete
 * `leafnodes { remotes: [...] }` block, composed via a deterministic merge
 * keyed per network so re-render REPLACES rather than DUPLICATES a remote
 * (idempotency). Multi-network (OQ3) composes N keyed remotes into one
 * `leafnodes.remotes` array.
 */

import { describe, expect, test } from "bun:test";

import type { NetworkDescriptor } from "../../registry/types";
import {
  leafIncludeFileName,
  mergeLeafRemotes,
  renderLeafIncludeFile,
  renderLeafRemote,
  type LeafRemote,
  type StackLeafBinding,
} from "../leaf-remote-renderer";

// =============================================================================
// Fixtures — a registry-served descriptor + the stack's local leaf binding.
// Mirrors the hand-built ~/.config/nats/local.conf shape (read-only) without
// touching it: tls hub url, an absolute creds path, an nkey-U account pubkey.
// =============================================================================

const DESCRIPTOR: NetworkDescriptor = {
  network_id: "metafactory",
  hub_url: "tls://nats.meta-factory.dev:7422",
  leaf_port: 7422,
  members: ["andreas", "jc"],
};

const BINDING: StackLeafBinding = {
  credentials: "/Users/andreas/.config/nats/andreas.creds",
  // operator-mode requires each leaf remote to declare which LOCAL account
  // the leaf traffic binds to (nkey-U, the `A…` form in local.conf).
  account: "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
};

describe("renderLeafRemote", () => {
  test("produces a structured remote from a descriptor + binding", () => {
    const remote = renderLeafRemote(DESCRIPTOR, BINDING);
    expect(remote.url).toBe("tls://nats.meta-factory.dev:7422");
    expect(remote.credentials).toBe(
      "/Users/andreas/.config/nats/andreas.creds",
    );
    expect(remote.account).toBe(
      "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
    );
    // The idempotency key is the network id — re-render of the same network
    // replaces, never duplicates.
    expect(remote.network_id).toBe("metafactory");
  });

  test("reconstructs hub url from host + leaf_port when hub_url is bare host", () => {
    // DD-12 carries leaf_port alongside hub_url so the renderer can validate
    // / reconstruct the dial URL independently of URL parsing.
    const bareHost: NetworkDescriptor = {
      ...DESCRIPTOR,
      hub_url: "nats.meta-factory.dev",
    };
    const remote = renderLeafRemote(bareHost, BINDING);
    expect(remote.url).toBe("tls://nats.meta-factory.dev:7422");
  });

  test("preserves an explicit port in hub_url over leaf_port (url wins, no double-port)", () => {
    const remote = renderLeafRemote(DESCRIPTOR, BINDING);
    // hub_url already has :7422 — must not become :7422:7422.
    expect(remote.url).toBe("tls://nats.meta-factory.dev:7422");
    expect(remote.url).not.toContain(":7422:7422");
  });

  test("throws on a descriptor with an empty hub_url (fail loud at the boundary)", () => {
    const bad: NetworkDescriptor = { ...DESCRIPTOR, hub_url: "" };
    expect(() => renderLeafRemote(bad, BINDING)).toThrow();
  });

  test("throws on a non-absolute credentials path (creds must be absolute)", () => {
    const bad: StackLeafBinding = { ...BINDING, credentials: "andreas.creds" };
    expect(() => renderLeafRemote(DESCRIPTOR, bad)).toThrow();
  });

  test("throws on a missing account (operator-mode requires the bound account)", () => {
    const bad: StackLeafBinding = { ...BINDING, account: "" };
    expect(() => renderLeafRemote(DESCRIPTOR, bad)).toThrow();
  });

  test("rejects an account that is not a valid nkey-U (HOCON-injection guard)", () => {
    // The account is the one field emitted BARE (unquoted) into the HOCON
    // fragment. A value with whitespace/braces/newlines would break out of
    // the remotes[] block and inject directives — must be refused at the
    // boundary. nkey-U grammar is `A` + 55 base32 chars.
    const lowercase: StackLeafBinding = { ...BINDING, account: "aadpq7m7" };
    const wrongPrefix: StackLeafBinding = {
      ...BINDING,
      account: "BADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
    };
    const tooShort: StackLeafBinding = { ...BINDING, account: "AABCD" };
    const breakout: StackLeafBinding = {
      ...BINDING,
      account: 'GOOD\n      }\n    ]\n  }\n}\nhttp: 0.0.0.0:9999\nleafnodes {\n  remotes: [\n    { url: "tls://attacker:7422" }',
    };
    expect(() => renderLeafRemote(DESCRIPTOR, lowercase)).toThrow();
    expect(() => renderLeafRemote(DESCRIPTOR, wrongPrefix)).toThrow();
    expect(() => renderLeafRemote(DESCRIPTOR, tooShort)).toThrow();
    expect(() => renderLeafRemote(DESCRIPTOR, breakout)).toThrow();
  });
});

describe("leafIncludeFileName", () => {
  test("names the per-network include file deterministically", () => {
    expect(leafIncludeFileName("metafactory")).toBe(
      "leafnodes-metafactory.conf",
    );
  });

  test("is stable across calls (same network → same name)", () => {
    expect(leafIncludeFileName("acme")).toBe(leafIncludeFileName("acme"));
  });

  test("rejects a network id that would escape the include dir", () => {
    expect(() => leafIncludeFileName("../etc/passwd")).toThrow();
    expect(() => leafIncludeFileName("a/b")).toThrow();
  });
});

describe("mergeLeafRemotes — idempotency key = network_id", () => {
  test("adds a remote to an empty set", () => {
    const r = renderLeafRemote(DESCRIPTOR, BINDING);
    const merged = mergeLeafRemotes([], r);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.network_id).toBe("metafactory");
  });

  test("re-render of the same network REPLACES, does not duplicate", () => {
    const r1 = renderLeafRemote(DESCRIPTOR, BINDING);
    const once = mergeLeafRemotes([], r1);
    // Hub relocated (DD-12) — same network, new url. Must replace in place.
    const relocated: NetworkDescriptor = {
      ...DESCRIPTOR,
      hub_url: "tls://hub2.meta-factory.dev:7422",
    };
    const r2 = renderLeafRemote(relocated, BINDING);
    const twice = mergeLeafRemotes(once, r2);
    expect(twice).toHaveLength(1);
    expect(twice[0]?.url).toBe("tls://hub2.meta-factory.dev:7422");
  });

  test("multi-network (OQ3) composes distinct networks into one array", () => {
    const a = renderLeafRemote(DESCRIPTOR, BINDING);
    const b = renderLeafRemote(
      {
        network_id: "acme",
        hub_url: "tls://hub.acme.test:7422",
        leaf_port: 7422,
        members: ["andreas"],
      },
      BINDING,
    );
    const merged = mergeLeafRemotes(mergeLeafRemotes([], a), b);
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.network_id).sort()).toEqual([
      "acme",
      "metafactory",
    ]);
  });

  test("merge is order-stable (deterministic output for the same inputs)", () => {
    const a = renderLeafRemote(DESCRIPTOR, BINDING);
    const b = renderLeafRemote(
      {
        network_id: "acme",
        hub_url: "tls://hub.acme.test:7422",
        leaf_port: 7422,
        members: [],
      },
      BINDING,
    );
    const m1 = mergeLeafRemotes(mergeLeafRemotes([], a), b);
    const m2 = mergeLeafRemotes(mergeLeafRemotes([], a), b);
    expect(m1).toEqual(m2);
  });

  test("does not mutate the input array (pure merge)", () => {
    const r = renderLeafRemote(DESCRIPTOR, BINDING);
    const existing: LeafRemote[] = [];
    const merged = mergeLeafRemotes(existing, r);
    expect(existing).toHaveLength(0);
    expect(merged).not.toBe(existing);
  });
});

describe("renderLeafIncludeFile — HOCON fragment for a single network", () => {
  test("emits a leafnodes block with the remote's url, credentials, account", () => {
    const conf = renderLeafIncludeFile(DESCRIPTOR, BINDING);
    expect(conf).toContain("leafnodes");
    expect(conf).toContain("remotes");
    expect(conf).toContain('url: "tls://nats.meta-factory.dev:7422"');
    expect(conf).toContain(
      'credentials: "/Users/andreas/.config/nats/andreas.creds"',
    );
    expect(conf).toContain(
      "account: AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
    );
  });

  test("carries a per-network marker comment (the idempotency key, human-visible)", () => {
    const conf = renderLeafIncludeFile(DESCRIPTOR, BINDING);
    expect(conf).toContain("metafactory");
    // The fragment self-documents that it is generated + reversible (S4 leave
    // deletes it), so a human reading the file knows not to hand-edit it.
    expect(conf.toLowerCase()).toContain("generated");
  });

  test("is byte-stable for the same descriptor + binding (idempotent re-render)", () => {
    expect(renderLeafIncludeFile(DESCRIPTOR, BINDING)).toBe(
      renderLeafIncludeFile(DESCRIPTOR, BINDING),
    );
  });
});
