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
  natsConfigHasAccountTree,
  natsConfigMonitorUrl,
  natsConfigClientListen,
  leafIncludeFileName,
  mergeLeafRemotes,
  renderLeafIncludeFile,
  renderLeafRemote,
  renderBaseIsolatedConfig,
  renderOperatorModeBlocks,
  resolveLeafBindMode,
  parseLoopbackListen,
  type LeafRemote,
  type StackLeafBinding,
  type OperatorModeLeafPackage,
} from "../leaf-remote-renderer";
import { readFileSync } from "fs";
import { join } from "path";

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

  // #799 — a missing account is NO LONGER an error: it is the $G/default-bus
  // mode where the binding rides in the creds JWT. The remote renders WITHOUT
  // an account.
  test("#799 omits account when none is supplied ($G/default bus)", () => {
    const noAccount: StackLeafBinding = { credentials: BINDING.credentials };
    const remote = renderLeafRemote(DESCRIPTOR, noAccount);
    expect(remote.account).toBeUndefined();
    expect(remote.url).toBe("tls://nats.meta-factory.dev:7422");
    expect(remote.credentials).toBe(BINDING.credentials);
  });

  test("#799 treats an empty-string account the same as absent (no account)", () => {
    const empty: StackLeafBinding = { ...BINDING, account: "" };
    const remote = renderLeafRemote(DESCRIPTOR, empty);
    expect(remote.account).toBeUndefined();
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

// =============================================================================
// cortex#1480 (join-1, epic #1479) — the leaf binds the FED account, and the
// FED pubkey appears as a literal preload KEY in the rendered resolver_preload.
// This is the end-to-end pure composition of the two renderers `cortex network
// join` runs back to back: convert the bus (renderOperatorModeBlocks), then
// render the leaf against it (renderLeafRemote) — the exact invariant whose
// violation is the real "does not define account <FED>" fail-closed. With fake
// JWTs these are text-structure checks, NOT nats-server-verified.
// =============================================================================

/**
 * INDEPENDENT structural parse of the rendered `resolver_preload { … }` block:
 * the account pubkeys that appear as literal `<pubkey>:` KEY lines inside it.
 * Deliberately does NOT call the production `natsConfigCanBindAccount`, so the
 * keystone assertion is not circular with the code under test.
 */
function preloadKeys(conf: string): string[] {
  const m = /resolver_preload\s*[:=]?\s*\{/.exec(conf);
  if (m === null) return [];
  const open = m.index + m[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = open; i < conf.length; i++) {
    if (conf[i] === "{") depth++;
    else if (conf[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  const keys: string[] = [];
  for (const line of conf.slice(open + 1, end).split("\n")) {
    const km = /^\s*(A[A-Z2-7]{55})\s*:/.exec(line);
    if (km?.[1] !== undefined) keys.push(km[1]);
  }
  return keys;
}

describe("cortex#1480 — the leaf binds FED, and FED is present in the rendered resolver_preload", () => {
  const OPERATOR_JWT =
    "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_OPERATOR_JWT_BODY.sig";
  const FED_ACCOUNT = "A" + "F".repeat(55);
  const FED_ACCOUNT_JWT =
    "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_FED_JWT_BODY.sig";
  const AGENTS_ACCOUNT = "A" + "G".repeat(55);
  const AGENTS_ACCOUNT_JWT =
    "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_AGENTS_JWT_BODY.sig";
  const SYS_ACCOUNT = "A" + "S".repeat(55);
  const SYS_ACCOUNT_JWT =
    "eyJhbGciOiJlZDI1NTE5LW5rZXkiLCJ0eXAiOiJKV1QifQ.FAKE_SYS_JWT_BODY.sig";

  const ANON_CONF = [
    "server_name: community-andreas",
    "listen: 127.0.0.1:4224",
    "jetstream { store_dir: /Users/andreas/.config/nats/community-jetstream }",
    "",
  ].join("\n");

  const PKG: OperatorModeLeafPackage = {
    operatorJwt: OPERATOR_JWT,
    account: FED_ACCOUNT,
    accountJwt: FED_ACCOUNT_JWT,
    agentsAccount: AGENTS_ACCOUNT,
    agentsAccountJwt: AGENTS_ACCOUNT_JWT,
    systemAccount: SYS_ACCOUNT,
    systemAccountJwt: SYS_ACCOUNT_JWT,
  };

  test("the converted config's resolver_preload carries FED, AGENTS, and SYS — the leaf's bind target is present", () => {
    const result = renderOperatorModeBlocks(ANON_CONF, PKG);
    expect(result.status).toBe("converted");
    if (result.status !== "converted") throw new Error("expected converted");

    // ACCEPTANCE KEYSTONE — the FED (+AGENTS +SYS) pubkeys appear as literal
    // preload KEYs, asserted by an INDEPENDENT structural parse (not the
    // production predicate). Text-structure-verified, not nats-server-verified.
    const keys = preloadKeys(result.conf);
    expect(keys).toContain(FED_ACCOUNT);
    expect(keys).toContain(AGENTS_ACCOUNT);
    expect(keys).toContain(SYS_ACCOUNT);

    // The leaf remote binds the FED account key — never AGENTS, never SYS.
    const binding: StackLeafBinding = {
      credentials: "/Users/andreas/.config/nats/andreas.creds",
      account: FED_ACCOUNT,
    };
    const remote = renderLeafRemote(DESCRIPTOR, binding);
    expect(remote.account).toBe(FED_ACCOUNT);
    expect(remote.account).not.toBe(AGENTS_ACCOUNT);
    expect(remote.account).not.toBe(SYS_ACCOUNT);

    // Integration check (a DIFFERENT function): #799's pre-flight bind-mode
    // resolver reports operator-account for the converted config — the decision
    // `cortex network join` makes immediately before rendering the leaf.
    const bindMode = resolveLeafBindMode(result.conf, FED_ACCOUNT, true);
    expect(bindMode.mode).toBe("operator-account");
  });

  test("re-resolving the leaf remote's include file renders `account: <FED pubkey>`, matching resolver_preload's key", () => {
    const converted = renderOperatorModeBlocks(ANON_CONF, PKG);
    if (converted.status !== "converted") throw new Error("expected converted");
    const includeFile = renderLeafIncludeFile(DESCRIPTOR, {
      credentials: "/Users/andreas/.config/nats/andreas.creds",
      account: FED_ACCOUNT,
    });
    // The leaf's `account:` line and the resolver_preload KEY are the SAME FED
    // pubkey — asserted structurally on both sides (no production predicate).
    expect(includeFile).toContain(`account: ${FED_ACCOUNT}`);
    expect(preloadKeys(converted.conf)).toContain(FED_ACCOUNT);
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

  // #799 — a $G/default bus renders a NO-ACCOUNT remote: no `account:` line at
  // all (the creds JWT binds it). An emitted `account:` would crash nats-server.
  test("#799 emits NO `account:` line for a $G/default bus (account omitted)", () => {
    const noAccount: StackLeafBinding = { credentials: BINDING.credentials };
    const conf = renderLeafIncludeFile(DESCRIPTOR, noAccount);
    // url + credentials still present...
    expect(conf).toContain('url: "tls://nats.meta-factory.dev:7422"');
    expect(conf).toContain(
      'credentials: "/Users/andreas/.config/nats/andreas.creds"',
    );
    // ...but NO account line anywhere (the regression that crashed the bus).
    expect(conf).not.toContain("account:");
    expect(conf).not.toMatch(/account\s*:/);
  });

  test("#799 operator-mode bus still emits the account line (unchanged)", () => {
    const conf = renderLeafIncludeFile(DESCRIPTOR, BINDING);
    expect(conf).toContain(
      "account: AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
    );
  });
});

// =============================================================================
// #799 — bus-type detection + bind-mode resolution.
// =============================================================================

// A representative operator-mode config: NSC operator JWT + resolver +
// system_account + the account named in the account tree. (The account-tree
// root key path is an NSC operator.creds carve-out, not a principal.)
const OPERATOR_MODE_CONF = [
  "operator: /Users/andreas/.config/nats/operator.creds",
  "system_account: ADSYSACCOUNT",
  "resolver_preload: {",
  "  AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX: eyJ...",
  "}",
  "",
].join("\n");

// A $G/default-account config: a simple creds-authenticated leaf-client — no
// account tree (no operator-mode key, no `accounts{}`, no resolver_preload).
const DEFAULT_G_CONF = [
  "// $G/default-account bus — a simple leaf-client.",
  "jetstream { store_dir: /Users/jc/.config/nats/js }",
  "http: localhost:8222",
  "",
].join("\n");

const VALID_ACCOUNT = "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX";

describe("#799 natsConfigHasAccountTree", () => {
  test("true for an operator-mode config (operator JWT / resolver_preload)", () => {
    expect(natsConfigHasAccountTree(OPERATOR_MODE_CONF)).toBe(true);
  });

  test("true when only `accounts {` is present", () => {
    expect(natsConfigHasAccountTree("accounts {\n  A: { users: [] }\n}\n")).toBe(true);
  });

  test("false for a $G/default-account config (no account tree)", () => {
    expect(natsConfigHasAccountTree(DEFAULT_G_CONF)).toBe(false);
  });

  test("a COMMENTED-OUT account-tree key does not count (comments stripped)", () => {
    const commented = "// operator: /x/operator.creds\n# accounts { }\njetstream { }\n";
    expect(natsConfigHasAccountTree(commented)).toBe(false);
  });

  // #821 MAJOR-1 — non-canonical-but-valid operator-mode shapes. The detector
  // previously checked only the canonical account-tree keys (NSC operator JWT
  // key / accounts / resolver_preload), so these valid operator-mode configs
  // (all in this repo's own SOP/migration docs) were misclassified as $G → a
  // no-account remote was rendered → the #821 crash. Erring toward operator-mode
  // only OVER-refuses (recoverable); never crashes.
  test("MAJOR-1: true for a `resolver:`-only config (e.g. resolver: MEMORY)", () => {
    const conf = ["resolver: MEMORY", "port: 4222", ""].join("\n");
    expect(natsConfigHasAccountTree(conf)).toBe(true);
  });

  test("MAJOR-1: true for a `resolver { ... }` block config", () => {
    const conf = ["resolver {", "  type: full", "  dir: /x/jwt", "}", ""].join("\n");
    expect(natsConfigHasAccountTree(conf)).toBe(true);
  });

  test("MAJOR-1: true for a `system_account:`-only config", () => {
    const conf = ["system_account: ADSYSACCOUNT", "port: 4224", ""].join("\n");
    expect(natsConfigHasAccountTree(conf)).toBe(true);
  });

  test("MAJOR-1: true (fail-closed) for an `include` split config", () => {
    // The account tree may live in the included file; the pure text scanner can't
    // resolve it, so fail closed — assume operator-mode + require an account.
    const conf = ['include "accounts.conf"', "port: 4224", ""].join("\n");
    expect(natsConfigHasAccountTree(conf)).toBe(true);
  });

  test("MAJOR-1: single-quoted + extra-whitespace include still fails closed", () => {
    const conf = ["include   'accounts.conf'", "port: 4224", ""].join("\n");
    expect(natsConfigHasAccountTree(conf)).toBe(true);
  });

  test("MAJOR-1: a COMMENTED-OUT include/resolver/system_account does NOT count", () => {
    const commented = [
      "// include \"accounts.conf\"",
      "# resolver: MEMORY",
      "# system_account: ADSYSACCOUNT",
      "jetstream { store_dir: /x/js }",
      "",
    ].join("\n");
    expect(natsConfigHasAccountTree(commented)).toBe(false);
  });

  test("MAJOR-1: still false for a genuine $G bus (no operator-mode signal)", () => {
    // Regression guard: the widened detector must NOT start flagging a real $G
    // bus (the jc/default case) — that would break #803.
    expect(natsConfigHasAccountTree(DEFAULT_G_CONF)).toBe(false);
  });

  test("MAJOR-1: a $G bus with the join's OWN leafnodes-*.conf include stays $G (re-join safe)", () => {
    // After a $G bus joins once, `ensureLeafInclude` adds `include
    // "leafnodes-<net>.conf"`. The fail-closed include signal must NOT count the
    // join's own leaf fragment — else a RE-join flips the $G bus to operator-mode
    // and over-refuses it (a #803 regression on the idempotent re-join path).
    const reJoined = [
      DEFAULT_G_CONF,
      'include "leafnodes-metafactory-community.conf"',
      "",
    ].join("\n");
    expect(natsConfigHasAccountTree(reJoined)).toBe(false);
  });

  test("MAJOR-1: a $G bus with a NON-leaf include DOES fail closed (account tree may be there)", () => {
    const withRealInclude = [DEFAULT_G_CONF, 'include "accounts.conf"', ""].join("\n");
    expect(natsConfigHasAccountTree(withRealInclude)).toBe(true);
  });
});

describe("#799 resolveLeafBindMode", () => {
  test("operator-mode bus + defined account + creds → operator-account", () => {
    const mode = resolveLeafBindMode(OPERATOR_MODE_CONF, VALID_ACCOUNT, true);
    expect(mode.mode).toBe("operator-account");
    if (mode.mode === "operator-account") expect(mode.account).toBe(VALID_ACCOUNT);
  });

  test("$G/default bus + creds (no account) → creds-only (the #799 fix)", () => {
    const mode = resolveLeafBindMode(DEFAULT_G_CONF, undefined, true);
    expect(mode.mode).toBe("creds-only");
  });

  test("$G/default bus + creds + a stray account → STILL creds-only (account moot)", () => {
    // Even if an account is offered, a $G bus has no account tree to bind it —
    // the binding rides in the creds JWT, so we render no-account rather than
    // refuse (and rather than crash by emitting an unresolvable account line).
    const mode = resolveLeafBindMode(DEFAULT_G_CONF, VALID_ACCOUNT, true);
    expect(mode.mode).toBe("creds-only");
  });

  test("no creds at all → refuse (cannot authenticate to the hub)", () => {
    const mode = resolveLeafBindMode(DEFAULT_G_CONF, undefined, false);
    expect(mode.mode).toBe("refuse");
    if (mode.mode === "refuse") expect(mode.reason).toContain("creds");
  });

  test("operator-mode bus that does NOT define the account → refuse (would crash)", () => {
    // An operator-mode bus whose account tree lacks THIS account: rendering an
    // account-bound leaf crashes nats-server, and operator-mode has no creds-
    // only fallback (its leaves are account-bound by construction).
    const otherAccountConf = [
      "operator: /x/operator.creds",
      "resolver_preload: {",
      "  ASOMEOTHERACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX: eyJ...",
      "}",
      "",
    ].join("\n");
    const mode = resolveLeafBindMode(otherAccountConf, VALID_ACCOUNT, true);
    expect(mode.mode).toBe("refuse");
  });

  // #821 — THE INCIDENT. An operator-mode bus joined WITHOUT an account
  // (no --account, no stack.nats_infra.account) must REFUSE, NOT fall through to
  // creds-only. Rendering a no-account ($G) leaf onto an operator-mode bus makes
  // nats-server exit 1 at runtime (it rejects a remote that carries no account
  // nkey) — the crash that took the live andreas/community bus down. The
  // pre-#821 code skipped the account branch entirely when none was offered and
  // returned `creds-only` regardless of bus type.
  test("operator-mode bus + NO account offered + creds → refuse (the #821 crash)", () => {
    const mode = resolveLeafBindMode(OPERATOR_MODE_CONF, undefined, true);
    expect(mode.mode).toBe("refuse");
    if (mode.mode === "refuse") {
      expect(mode.reason).toContain("operator-mode");
      expect(mode.reason).toContain("account");
    }
  });

  test("operator-mode bus + empty-string account + creds → refuse (#821)", () => {
    // An empty/whitespace account is "no account offered" — same crash path.
    const mode = resolveLeafBindMode(OPERATOR_MODE_CONF, "   ", true);
    expect(mode.mode).toBe("refuse");
  });
});

// #821 MAJOR (code-review) — the health probe must target the bus's OWN monitor
// port, derived from the nats config, NOT a hardcoded :8222. The community bus
// monitors on :8224; probing :8222 false-trips rollback on a SUCCESSFUL join.
describe("#821 natsConfigMonitorUrl", () => {
  test("derives from `http_port: 8224`", () => {
    const conf = ["http_port: 8224", "port: 4224", ""].join("\n");
    expect(natsConfigMonitorUrl(conf)).toBe("http://127.0.0.1:8224");
  });

  test("derives from `monitor_port: 8224` (alias)", () => {
    const conf = ["monitor_port: 8224", ""].join("\n");
    expect(natsConfigMonitorUrl(conf)).toBe("http://127.0.0.1:8224");
  });

  test("derives host:port from `http: 0.0.0.0:8224` (binds 0.0.0.0 → probe 127.0.0.1)", () => {
    const conf = ["http: 0.0.0.0:8224", ""].join("\n");
    // We always PROBE loopback even when the server BINDS 0.0.0.0.
    expect(natsConfigMonitorUrl(conf)).toBe("http://127.0.0.1:8224");
  });

  test("derives from `http: \"localhost:8224\"` (quoted)", () => {
    const conf = ['http: "localhost:8224"', ""].join("\n");
    expect(natsConfigMonitorUrl(conf)).toBe("http://127.0.0.1:8224");
  });

  test("derives from a bare `http: 8224` (port only)", () => {
    const conf = ["http: 8224", ""].join("\n");
    expect(natsConfigMonitorUrl(conf)).toBe("http://127.0.0.1:8224");
  });

  test("a COMMENTED-OUT http directive does NOT count", () => {
    const conf = ["// http_port: 8224", "# http: 8225", "port: 4224", ""].join("\n");
    expect(natsConfigMonitorUrl(conf)).toBeUndefined();
  });

  // #821 NIT (item 3) — an INLINE trailing comment on the `http:` directive must
  // not defeat the port match (else → undefined → false-fallback to :8222 →
  // false-trip rollback on a HEALTHY join). `http_port:` already tolerated this;
  // `http:` must be symmetric.
  test("item-3: `http: 0.0.0.0:8224 # mon` (inline #-comment) derives :8224", () => {
    const conf = ["http: 0.0.0.0:8224 # monitor", ""].join("\n");
    expect(natsConfigMonitorUrl(conf)).toBe("http://127.0.0.1:8224");
  });

  test("item-3: `http: 8224 // mon` (inline //-comment, bare port) derives :8224", () => {
    const conf = ["http: 8224 // monitor", ""].join("\n");
    expect(natsConfigMonitorUrl(conf)).toBe("http://127.0.0.1:8224");
  });

  test("item-3: `http_port: 8224 # mon` stays correct (symmetry regression)", () => {
    const conf = ["http_port: 8224 # monitor", ""].join("\n");
    expect(natsConfigMonitorUrl(conf)).toBe("http://127.0.0.1:8224");
  });

  test("item-3: quoted value with an inline comment after the quote derives the port", () => {
    const conf = ['http: "localhost:8224"  # mon', ""].join("\n");
    expect(natsConfigMonitorUrl(conf)).toBe("http://127.0.0.1:8224");
  });

  test("no monitor directive → undefined (caller falls back)", () => {
    expect(natsConfigMonitorUrl(DEFAULT_G_CONF.replace(/http:.*/g, ""))).toBeUndefined();
  });

  test("the community bus shape (operator-mode + http_port 8224) resolves :8224", () => {
    const community = [
      "operator: /Users/andreas/.config/nats/operator.creds",
      "system_account: ADSYSACCOUNT",
      "port: 4224",
      "http_port: 8224",
      "",
    ].join("\n");
    expect(natsConfigMonitorUrl(community)).toBe("http://127.0.0.1:8224");
  });
});

describe("cortex#1495 v2/v3 natsConfigClientListen", () => {
  test("derives host+port from `listen: 127.0.0.1:4222`", () => {
    expect(natsConfigClientListen("listen: 127.0.0.1:4222\n")).toEqual({ host: "127.0.0.1", port: 4222 });
  });

  test("derives host+port from `listen: 10.0.0.5:4222` (v3: keep the NON-loopback host)", () => {
    expect(natsConfigClientListen("listen: 10.0.0.5:4222\n")).toEqual({ host: "10.0.0.5", port: 4222 });
  });

  test("derives from `listen: \"0.0.0.0:4299\"` (quoted, wildcard host kept RAW)", () => {
    expect(natsConfigClientListen('listen: "0.0.0.0:4299"\n')).toEqual({ host: "0.0.0.0", port: 4299 });
  });

  test("derives from bracketed IPv6 `listen: [::]:4222`", () => {
    expect(natsConfigClientListen("listen: [::]:4222\n")).toEqual({ host: "::", port: 4222 });
  });

  test("derives from bracketed IPv6 with a real addr `listen: [2001:db8::1]:4222`", () => {
    expect(natsConfigClientListen("listen: [2001:db8::1]:4222\n")).toEqual({ host: "2001:db8::1", port: 4222 });
  });

  test("a bare `listen: 4300` yields an empty host (caller defaults it)", () => {
    expect(natsConfigClientListen("listen: 4300\n")).toEqual({ host: "", port: 4300 });
  });

  test("derives from the split `host:`/`port:` directive form", () => {
    expect(natsConfigClientListen("host: 10.0.0.9\nport: 4224\nhttp_port: 8224\n")).toEqual({
      host: "10.0.0.9",
      port: 4224,
    });
  });

  test("a bare `port: 4224` (no host directive) yields an empty host", () => {
    expect(natsConfigClientListen("port: 4224\nhttp_port: 8224\n")).toEqual({ host: "", port: 4224 });
  });

  test("`listen:` wins over `port:` when both are present", () => {
    expect(natsConfigClientListen("listen: 127.0.0.1:4222\nport: 9999\n")).toEqual({ host: "127.0.0.1", port: 4222 });
  });

  test("`http_port` / `monitor_port` never false-match the client `port:` parse", () => {
    expect(natsConfigClientListen("http_port: 8222\nmonitor_port: 8223\n")).toBeUndefined();
  });

  test("a COMMENTED-OUT listen/port does NOT count", () => {
    expect(natsConfigClientListen("// listen: 4222\n# port: 4223\n")).toBeUndefined();
  });

  test("tolerates an inline trailing comment on `listen:`", () => {
    expect(natsConfigClientListen("listen: 127.0.0.1:4222 # client\n")).toEqual({ host: "127.0.0.1", port: 4222 });
  });

  test("no listen/port directive → undefined (caller applies the 127.0.0.1:4222 default)", () => {
    expect(natsConfigClientListen("server_name: work\n")).toBeUndefined();
  });
});

// =============================================================================
// C-1224 (ADR-0013 Model B) — SECRET-AUTHENTICATED leaf rendering.
//
// The Model-B leaf is a secret-authenticated transport pipe: it binds the
// principal's OWN local account (in their own operator-mode NSC store) + authenticates
// to the hub with the shared leaf secret, presented via the dial URL's userinfo
// (`tls://user:secret@host:port`) — the ONLY remote-side form nats-server v2.x
// accepts (a literal `authorization {}`/`username`/`password` field inside a
// remote is rejected at config load). These tests assert the rendered fragment;
// the empirical nats-server `-t` validation lives in the PR description.
// =============================================================================

const SECRET_BINDING: StackLeafBinding = {
  // Model B: NO creds file — the credential is the URL userinfo secret.
  leafSecret: "s3cr3t-leaf-pipe",
  leafUser: "andreas",
  // The principal's OWN local federation account (provision writes this).
  account: "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
};

describe("renderLeafRemote — C-1224 Model B secret-auth", () => {
  test("renders secretAuth + own account, NO credentials, clean url", () => {
    const remote = renderLeafRemote(DESCRIPTOR, SECRET_BINDING);
    // Clean dial URL — the secret is NOT spliced into the structured url
    // (status/logging surfaces stay secret-free).
    expect(remote.url).toBe("tls://nats.meta-factory.dev:7422");
    expect(remote.url).not.toContain("s3cr3t");
    expect(remote.credentials).toBeUndefined();
    expect(remote.secretAuth).toEqual({
      user: "andreas",
      secret: "s3cr3t-leaf-pipe",
    });
    // Own-account binding (operator-mode local account).
    expect(remote.account).toBe(
      "AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
    );
    expect(remote.network_id).toBe("metafactory");
  });

  test("secret-auth on a $G bus (no account) renders secretAuth, no account line", () => {
    const noAccount: StackLeafBinding = {
      leafSecret: "s3cr3t",
      leafUser: "andreas",
    };
    const remote = renderLeafRemote(DESCRIPTOR, noAccount);
    expect(remote.secretAuth).toEqual({ user: "andreas", secret: "s3cr3t" });
    expect(remote.account).toBeUndefined();
    expect(remote.credentials).toBeUndefined();
  });

  test("a leaf secret without a user is a hard error (userinfo needs the user)", () => {
    const noUser: StackLeafBinding = { leafSecret: "s3cr3t" };
    expect(() => renderLeafRemote(DESCRIPTOR, noUser)).toThrow(/leaf user/);
  });

  test("the secret wins when BOTH a secret and a creds path are present", () => {
    const both: StackLeafBinding = {
      ...SECRET_BINDING,
      credentials: "/Users/andreas/.config/nats/andreas.creds",
    };
    const remote = renderLeafRemote(DESCRIPTOR, both);
    expect(remote.secretAuth).toBeDefined();
    expect(remote.credentials).toBeUndefined();
  });

  test("an invalid account nkey on the secret path still throws", () => {
    const badAccount: StackLeafBinding = {
      leafSecret: "s3cr3t",
      leafUser: "andreas",
      account: "BADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
    };
    expect(() => renderLeafRemote(DESCRIPTOR, badAccount)).toThrow();
  });
});

describe("renderLeafIncludeFile — C-1224 Model B secret-auth serialization", () => {
  test("emits userinfo in the url, NO credentials line, with the account line", () => {
    const conf = renderLeafIncludeFile(DESCRIPTOR, SECRET_BINDING);
    // userinfo spliced into the dial URL (URL-encoded user:secret@host).
    expect(conf).toContain(
      'url: "tls://andreas:s3cr3t-leaf-pipe@nats.meta-factory.dev:7422"',
    );
    // No `.creds` file on a Model-B leaf.
    expect(conf).not.toContain("credentials:");
    // Own local account still bound (operator-mode).
    expect(conf).toContain(
      "account: AADPQ7M7LQZTKPNF5CTE7V4XKB2FUYPGKLWZVMW6VXCEEKH62BYKGBHX",
    );
    expect(conf).toContain("leafnodes {");
  });

  test("URL-encodes a secret containing @ : / and space (authority boundary safe)", () => {
    const tricky: StackLeafBinding = {
      leafSecret: "p@ss:w/rd x",
      leafUser: "andreas",
    };
    const conf = renderLeafIncludeFile(DESCRIPTOR, tricky);
    // The raw secret must not appear unencoded (would break the userinfo@host
    // boundary and could inject into the authority).
    expect(conf).not.toContain("p@ss:w/rd x");
    expect(conf).toContain("p%40ss%3Aw%2Frd%20x");
  });

  test("the creds path is unchanged — no userinfo, keeps the credentials line", () => {
    const conf = renderLeafIncludeFile(DESCRIPTOR, BINDING);
    expect(conf).toContain('url: "tls://nats.meta-factory.dev:7422"');
    expect(conf).toContain(
      'credentials: "/Users/andreas/.config/nats/andreas.creds"',
    );
    expect(conf).not.toContain("@nats.meta-factory.dev");
  });
});

// =============================================================================
// cortex#1265 (PR8) — renderBaseIsolatedConfig + the template-drift guard
// =============================================================================

describe("renderBaseIsolatedConfig — the from-scratch base skeleton", () => {
  const IDENTITY = {
    serverName: "research-acme",
    listen: "127.0.0.1:4222",
    jetstreamStoreDir: "~/.config/nats/research-jetstream",
  };

  test("emits a complete hard-isolated base (server_name/listen/jetstream)", () => {
    const conf = renderBaseIsolatedConfig(IDENTITY);
    expect(conf).toContain('server_name: "research-acme"');
    expect(conf).toContain('listen: "127.0.0.1:4222"');
    expect(conf).toContain("jetstream {");
    expect(conf).toContain('store_dir: "~/.config/nats/research-jetstream"');
    expect(conf).toContain('domain: "research-acme"');
  });

  test("DELIBERATELY omits leafnodes/cluster/gateway (the isolation wall, cortex#692)", () => {
    const conf = renderBaseIsolatedConfig(IDENTITY);
    expect(conf).not.toMatch(/^\s*leafnodes\s*\{/m);
    expect(conf).not.toMatch(/^\s*cluster\s*\{/m);
    expect(conf).not.toMatch(/^\s*gateway\s*\{/m);
  });

  test("is anonymous (no account tree) until operator-mode blocks are rendered onto it", () => {
    const base = renderBaseIsolatedConfig(IDENTITY);
    expect(natsConfigHasAccountTree(base)).toBe(false);
    // renderOperatorModeBlocks then converts it to a complete operator-mode config.
    const pkg = {
      operatorJwt: "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJPUCJ9.sig",
      account: "A" + "F".repeat(55),
      accountJwt: "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBRkVEIn0.sig",
    };
    const result = renderOperatorModeBlocks(base, pkg);
    expect(result.status).toBe("converted");
    if (result.status === "converted") {
      // The whole config is loadable: base identity + operator-mode block set.
      expect(result.conf).toContain('server_name: "research-acme"');
      expect(result.conf).toContain("operator: " + pkg.operatorJwt);
      expect(result.conf).toContain("resolver: MEMORY");
      expect(result.conf).toContain("resolver_preload: {");
    }
  });
});

describe("docs/config-layout/nats-server.conf.example — template ↔ renderer drift guard", () => {
  // The template documents the SHAPE the bootstrap renderer emits. If the
  // renderer grows/renames a structural key, this guard fails until the template
  // is updated too — so the human-readable reference can never silently drift.
  const templatePath = join(__dirname, "..", "..", "..", "..", "docs", "config-layout", "nats-server.conf.example");
  const template = readFileSync(templatePath, "utf-8");

  test("the template carries every structural key the renderer emits", () => {
    const base = renderBaseIsolatedConfig({
      serverName: "s", listen: "127.0.0.1:4222", jetstreamStoreDir: "~/x",
    });
    const operatorMode = renderOperatorModeBlocks(base, {
      operatorJwt: "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJPUCJ9.sig",
      account: "A" + "F".repeat(55),
      accountJwt: "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJBRkVEIn0.sig",
      systemAccount: "A" + "S".repeat(55),
      systemAccountJwt: "eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJzdWIiOiJTWVMifQ.sig",
    });
    const rendered = operatorMode.status === "converted" ? operatorMode.conf : "";
    // Every structural key the renderer emits must be documented in the template.
    for (const key of [
      "server_name:",
      "listen:",
      "jetstream {",
      "store_dir:",
      "domain:",
      "operator:",
      "system_account:",
      "resolver: MEMORY",
      "resolver_preload:",
    ]) {
      expect(rendered).toContain(key); // sanity: the renderer really emits it
      expect(template).toContain(key); // the template documents it
    }
  });

  test("the template is placeholder-only — no real JWT/NKEY/principal material", () => {
    // No bare `eyJ…` JWT tokens (3 base64url segments) — only `<PLACEHOLDER>` forms.
    expect(template).not.toMatch(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    // No real 56-char nkey public keys (A…/O…/U…) or seeds (S…).
    expect(template).not.toMatch(/\b[AOU][A-Z2-7]{55}\b/);
    expect(template).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    // No real principal/stack names leaked into the public template.
    expect(template).not.toMatch(/\bandreas\b/);
    expect(template).not.toMatch(/meta-factory/);
  });
});

describe("parseLoopbackListen — safe loopback host:port for a synthesised base (review #1302)", () => {
  test("accepts loopback host:port and strips the scheme", () => {
    expect(parseLoopbackListen("nats://127.0.0.1:4222")).toBe("127.0.0.1:4222");
    expect(parseLoopbackListen("nats://localhost:4222")).toBe("localhost:4222");
    expect(parseLoopbackListen("tls://127.0.0.1:4223")).toBe("127.0.0.1:4223");
    expect(parseLoopbackListen("127.0.0.1:4222")).toBe("127.0.0.1:4222"); // bare host:port
  });

  test("accepts bracketed IPv6 loopback", () => {
    expect(parseLoopbackListen("nats://[::1]:4222")).toBe("[::1]:4222");
  });

  test("DECLINES non-loopback / over-exposed hosts (→ refuse-floor, no synthesis)", () => {
    expect(parseLoopbackListen("nats://0.0.0.0:4222")).toBeUndefined();
    expect(parseLoopbackListen("nats://example.com:4222")).toBeUndefined();
    expect(parseLoopbackListen("nats://10.0.0.5:4222")).toBeUndefined();
    expect(parseLoopbackListen("nats://[::]:4222")).toBeUndefined();
  });

  test("DECLINES userinfo, paths, and malformed host:port", () => {
    expect(parseLoopbackListen("nats://user:pass@127.0.0.1:4222")).toBeUndefined();
    expect(parseLoopbackListen("nats://127.0.0.1:4222/leaf")).toBeUndefined();
    expect(parseLoopbackListen("nats://127.0.0.1")).toBeUndefined(); // no port
    expect(parseLoopbackListen("nats://127.0.0.1:abc")).toBeUndefined(); // non-numeric port
    expect(parseLoopbackListen("nats://127.0.0.1:0")).toBeUndefined(); // out-of-range
    expect(parseLoopbackListen("nats://127.0.0.1:70000")).toBeUndefined();
  });

  test("DECLINES absent / empty", () => {
    expect(parseLoopbackListen(undefined)).toBeUndefined();
    expect(parseLoopbackListen("")).toBeUndefined();
    expect(parseLoopbackListen("nats://")).toBeUndefined();
  });
});
