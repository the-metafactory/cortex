/**
 * #753 — config-derived `cortex network join`/`leave` inputs.
 *
 * The one-liner north star: `cortex network join <network>` with NO other
 * flags derives principal / stack / seed / registry / nats-infra from the
 * loaded config + conventions. Flags survive as optional overrides (flag wins).
 * A required value that is neither flagged nor derivable fails with a clear,
 * field-naming error (never a stack trace).
 *
 * Pure-over-injected-reader: every test passes a fake `ConfigReader` returning
 * a fixture `LoadedConfig` — no disk, no real `~/.config/cortex/`.
 */

import { describe, test, expect } from "bun:test";

import {
  deriveJoinInputs,
  deriveLeaveInputs,
  defaultCredsPath,
  type ConfigReader,
} from "../network-derive";
import { DEFAULT_REGISTRY } from "../default-registry";
import type { LoadedConfig } from "../../../../common/config/loader";
import type { AgentConfig } from "../../../../common/types/config";
import {
  CortexConfigSchema,
  deriveStackId,
  ownFederatedSubjectScopePrefix,
} from "../../../../common/types/cortex-config";
import { ownAcceptSubjects } from "../../../../bus/agent-network/accept-subjects";

// A minimal LoadedConfig stub — only the fields the deriver reads matter; the
// `config` AgentConfig is never inspected by the deriver, so a bare cast keeps
// the fixture focused on principal/stack/policy.
function loaded(partial: Partial<LoadedConfig>): LoadedConfig {
  return {
    config: {} as AgentConfig,
    inlineAgents: [],
    ...partial,
  };
}

/** A reader that always returns the given config regardless of path. */
function reader(cfg: LoadedConfig): ConfigReader {
  return () => cfg;
}

// A fully-populated cortex-shape config: principal + stack (seed + nats_infra)
// + policy.federated.registry. The "everything in config" happy path.
const FULL = loaded({
  principal: { id: "andreas" },
  stack: {
    id: "andreas/meta-factory",
    nkey_seed_path: "~/.config/nats/cortex.nk",
    nats_infra: {
      config_path: "~/.config/nats/local.conf",
      plist_path: "~/Library/LaunchAgents/nats.plist",
      account: "A" + "B".repeat(55),
      creds_path: "~/.config/nats/mf.creds",
    },
  },
  policy: {
    principals: [],
    roles: [],
    federated: {
      networks: [],
      registry: {
        url: "https://registry.meta-factory.ai",
        pubkey: "A".repeat(43) + "=",
      },
    },
  },
});

// =============================================================================
// Happy path — no flags, everything from config
// =============================================================================

describe("deriveJoinInputs — config-only (the one-liner)", () => {
  test("derives all inputs from config with NO flags", () => {
    // Pin darwin so the macOS plist-path derivation is deterministic on Linux CI.
    const res = deriveJoinInputs("metafactory", {}, "/cfg/cortex.yaml", reader(FULL), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs).toEqual({
      principal: "andreas",
      stack: "andreas/meta-factory",
      // C-1364 — boot-authoritative slug from stack.id (born-aligned here: equals
      // the `stack` id's trailing segment). deriveStackId(FULL).stack.
      bootStackSlug: "meta-factory",
      seedPath: "~/.config/nats/cortex.nk",
      registryUrl: "https://registry.meta-factory.ai",
      registryPubkey: "A".repeat(43) + "=",
      natsConfigPath: "~/.config/nats/local.conf",
      plistPath: "~/Library/LaunchAgents/nats.plist",
      platform: "darwin",
      account: "A" + "B".repeat(55),
      credsPath: "~/.config/nats/mf.creds",
      // #762 — FULL declares no network block, so no caps to announce.
      announceCapabilities: [],
    });
  });

  test("#762 — announceCapabilities derives from the matching network block", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        id: "andreas/meta-factory",
        nkey_seed_path: "~/seed.nk",
        nats_infra: {
          config_path: "~/local.conf",
          plist_path: "~/nats.plist",
          account: "A" + "B".repeat(55),
        },
      },
      policy: {
        principals: [],
        roles: [],
        federated: {
          networks: [
            {
              id: "other-net",
              leaf_node: "other-net",
              peers: [],
              accept_subjects: ["federated.andreas.meta-factory.>"],
              deny_subjects: [],
              announce_capabilities: ["chat", "code-review.typescript"],
              max_hop: 1,
            },
            {
              id: "metafactory",
              leaf_node: "metafactory",
              peers: [],
              accept_subjects: ["federated.andreas.meta-factory.>"],
              deny_subjects: [],
              announce_capabilities: ["chat", "release"],
              max_hop: 1,
            },
          ],
          registry: { url: "https://registry.meta-factory.ai" },
        },
      },
    });
    // Pin darwin: this fixture configures `plist_path` (launchd), so the
    // service-descriptor resolves on macOS. Without the pin the host platform
    // leaks in and the descriptor fails on Linux CI (cortex#771 — these
    // platform-default tests were green on macOS dev boxes but red on the
    // Linux runner, a pre-existing #762/#763 breakage surfaced here).
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg), "darwin");
    expect(res.ok).toBe(true);
    // Only the metafactory block's caps — never the other network's.
    expect(res.inputs?.announceCapabilities).toEqual(["chat", "release"]);
  });

  test("#762 — no matching network block → announceCapabilities is empty", () => {
    // Pin darwin — FULL configures `plist_path` (cortex#771; see above).
    const res = deriveJoinInputs("brand-new-net", {}, "/cfg/cortex.yaml", reader(FULL), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.announceCapabilities).toEqual([]);
  });

  test("creds_path absent in config → convention ~/.config/nats/<network>.creds", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        id: "andreas/meta-factory",
        nkey_seed_path: "~/seed.nk",
        nats_infra: {
          config_path: "~/local.conf",
          plist_path: "~/nats.plist",
          account: "A" + "C".repeat(55),
          // creds_path omitted on purpose
        },
      },
      policy: {
        principals: [], roles: [],
        federated: { networks: [], registry: { url: "https://r.test" } },
      },
    });
    // Pin darwin — `plist_path` fixture (cortex#771; see above).
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.credsPath).toBe("~/.config/nats/metafactory.creds");
    expect(defaultCredsPath("metafactory")).toBe("~/.config/nats/metafactory.creds");
  });

  test("CUSTOM registry, pubkey absent → omitted (TOFU) + registryTofu flag set", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        id: "andreas/meta-factory",
        nkey_seed_path: "~/seed.nk",
        nats_infra: { config_path: "~/c", plist_path: "~/p", account: "A" + "D".repeat(55) },
      },
      policy: {
        principals: [], roles: [],
        // A CUSTOM (non-default) registry with no pubkey ⇒ TOFU.
        federated: { networks: [], registry: { url: "https://r.test" } },
      },
    });
    // Pin darwin — `plist_path` fixture (cortex#771; see above).
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.registryUrl).toBe("https://r.test");
    expect(res.inputs?.registryPubkey).toBeUndefined();
    // cortex#1228 — the CLI uses this to surface the explicit TOFU warning.
    expect(res.inputs?.registryTofu).toBe(true);
  });

  test("no stack.id → convention {principal}/default", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        // id intentionally derived; but stack block must carry seed + infra.
        // Use a stack with id default-shaped to exercise the fallback: omit id.
        nkey_seed_path: "~/seed.nk",
        nats_infra: { config_path: "~/c", plist_path: "~/p", account: "A" + "E".repeat(55) },
      } as unknown as LoadedConfig["stack"],
      policy: {
        principals: [], roles: [],
        federated: { networks: [], registry: { url: "https://r.test" } },
      },
    });
    // Pin darwin — `plist_path` fixture (cortex#771; see above).
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.stack).toBe("andreas/default");
  });
});

// =============================================================================
// Flag overrides win
// =============================================================================

describe("deriveJoinInputs — flag overrides win", () => {
  test("every flag overrides its config-derived value", () => {
    const res = deriveJoinInputs(
      "metafactory",
      {
        principal: "override-p",
        stack: "override-p/other",
        seedPath: "/flag/seed.nk",
        registryUrl: "https://flag.registry",
        registryPubkey: "Z".repeat(43) + "=",
        natsConfigPath: "/flag/local.conf",
        plistPath: "/flag/nats.plist",
        account: "A" + "F".repeat(55),
        credsPath: "/flag/x.creds",
      },
      "/cfg",
      reader(FULL),
      "darwin",
    );
    expect(res.ok).toBe(true);
    expect(res.inputs).toEqual({
      principal: "override-p",
      stack: "override-p/other",
      // C-1364 — the `--stack` flag moves the LOCATOR/write-path id ("other"),
      // but `bootStackSlug` stays the config's stack.id trailing segment
      // ("meta-factory" from FULL). A flag override CANNOT move the federation
      // identity the daemon boot validator enforces — this is the drift the fix
      // pins shut: guard scope derives from bootStackSlug, never `stack`'s slug.
      bootStackSlug: "meta-factory",
      seedPath: "/flag/seed.nk",
      registryUrl: "https://flag.registry",
      registryPubkey: "Z".repeat(43) + "=",
      natsConfigPath: "/flag/local.conf",
      plistPath: "/flag/nats.plist",
      platform: "darwin",
      account: "A" + "F".repeat(55),
      credsPath: "/flag/x.creds",
      // #762 — no caps flag exists; caps derive from the network block (none here).
      announceCapabilities: [],
    });
  });

  test("flags fully satisfy a config that derives NOTHING (back-compat)", () => {
    // An empty config (legacy bot.yaml-shape: no principal/stack/policy) plus a
    // fully-flagged invocation still derives — preserving the old workflow.
    const empty = loaded({});
    const res = deriveJoinInputs(
      "metafactory",
      {
        principal: "andreas",
        seedPath: "/s",
        registryUrl: "https://r",
        natsConfigPath: "/c",
        plistPath: "/p",
        account: "A" + "G".repeat(55),
        credsPath: "/creds",
      },
      "/cfg",
      reader(empty),
    );
    expect(res.ok).toBe(true);
    expect(res.inputs?.principal).toBe("andreas");
    expect(res.inputs?.stack).toBe("andreas/default");
  });
});

// =============================================================================
// Missing config → clear, field-naming errors (no stack trace)
// =============================================================================

describe("deriveJoinInputs — actionable missing-config errors", () => {
  test("no principal anywhere → names principal.id", () => {
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(loaded({})));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("principal.id");
    expect(res.reason).toContain("--principal");
  });

  test("no seed anywhere → names stack.nkey_seed_path", () => {
    const cfg = loaded({ principal: { id: "andreas" } });
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("stack.nkey_seed_path");
  });

  // cortex#1228 — the registry is NO LONGER a missing-field error: when neither
  // flag nor config supplies it, the derive falls back to the compiled-in
  // DEFAULT_REGISTRY anchor (pinned, no TOFU). See the dedicated default-anchor
  // describe block below. The next still-required field surfaces normally.
  test("no nats config path → names stack.nats_infra.config_path", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: { id: "andreas/mf", nkey_seed_path: "~/s" },
      policy: {
        principals: [], roles: [],
        federated: { networks: [], registry: { url: "https://r" } },
      },
    });
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("stack.nats_infra.config_path");
  });

  test("#799 no account → derives OK with account undefined ($G/default bus)", () => {
    // Pre-#799 a missing account FAILED ("names stack.nats_infra.account"). After
    // #799 the account is OPTIONAL: a $G/default-account bus has none, and the
    // join renders a no-account leaf (binding via the creds JWT). The genuine
    // refusal (no creds / operator-mode missing account) is decided downstream
    // by resolveLeafBindMode, not here.
    const cfg = loaded({
      principal: { id: "jc" },
      stack: {
        id: "jc/default",
        nkey_seed_path: "~/s",
        nats_infra: { config_path: "~/c", plist_path: "~/p" },
      },
      policy: {
        principals: [], roles: [],
        federated: { networks: [], registry: { url: "https://r" } },
      },
    });
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.account).toBeUndefined();
    // creds still resolve via convention.
    expect(res.inputs?.credsPath).toBeDefined();
  });

  test("#799 --account override is still honoured (operator-mode opt-in)", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        id: "andreas/mf",
        nkey_seed_path: "~/s",
        nats_infra: { config_path: "~/c", plist_path: "~/p" },
      },
      policy: {
        principals: [], roles: [],
        federated: { networks: [], registry: { url: "https://r" } },
      },
    });
    const acct = "A" + "B".repeat(55);
    const res = deriveJoinInputs("metafactory", { account: acct }, "/cfg", reader(cfg), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.account).toBe(acct);
  });
});

// =============================================================================
// cortex#1228 — default registry trust anchor: derive fallback + TOFU gating
// =============================================================================

describe("deriveJoinInputs — default registry anchor (#1228)", () => {
  // A complete stack config WITHOUT a policy.federated.registry block. The
  // registry must fall back to the compiled-in DEFAULT_REGISTRY anchor.
  const NO_REGISTRY = loaded({
    principal: { id: "andreas" },
    stack: {
      id: "andreas/meta-factory",
      nkey_seed_path: "~/seed.nk",
      nats_infra: { config_path: "~/c", plist_path: "~/p", account: "A" + "D".repeat(55) },
    },
    policy: { principals: [], roles: [], federated: { networks: [] } },
  });

  test("NO registry in config → falls back to DEFAULT_REGISTRY, PINNED, no TOFU", () => {
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(NO_REGISTRY), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.registryUrl).toBe(DEFAULT_REGISTRY.url);
    expect(res.inputs?.registryPubkey).toBe(DEFAULT_REGISTRY.pubkey);
    // The default is pre-pinned — registryTofu must be ABSENT (no warning).
    expect(res.inputs?.registryTofu).toBeUndefined();
  });

  test("default URL configured but NO pubkey → still default-pinned (no TOFU)", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        id: "andreas/meta-factory",
        nkey_seed_path: "~/seed.nk",
        nats_infra: { config_path: "~/c", plist_path: "~/p", account: "A" + "D".repeat(55) },
      },
      policy: {
        principals: [], roles: [],
        federated: { networks: [], registry: { url: DEFAULT_REGISTRY.url } },
      },
    });
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.registryPubkey).toBe(DEFAULT_REGISTRY.pubkey);
    expect(res.inputs?.registryTofu).toBeUndefined();
  });

  test("--registry-url override to a CUSTOM registry (no pubkey) → TOFU flagged", () => {
    const res = deriveJoinInputs(
      "metafactory",
      { registryUrl: "https://my.custom.registry" },
      "/cfg",
      reader(NO_REGISTRY),
      "darwin",
    );
    expect(res.ok).toBe(true);
    expect(res.inputs?.registryUrl).toBe("https://my.custom.registry");
    expect(res.inputs?.registryPubkey).toBeUndefined();
    expect(res.inputs?.registryTofu).toBe(true);
  });

  test("--registry-pubkey override pins a custom registry (no TOFU)", () => {
    const res = deriveJoinInputs(
      "metafactory",
      { registryUrl: "https://my.custom.registry", registryPubkey: "Z".repeat(43) + "=" },
      "/cfg",
      reader(NO_REGISTRY),
      "darwin",
    );
    expect(res.ok).toBe(true);
    expect(res.inputs?.registryPubkey).toBe("Z".repeat(43) + "=");
    expect(res.inputs?.registryTofu).toBeUndefined();
  });
});

// =============================================================================
// Leave derivation
// =============================================================================

describe("deriveLeaveInputs", () => {
  test("derives principal/stack/nats-config/plist from config (no flags)", () => {
    const res = deriveLeaveInputs({}, "/cfg", reader(FULL), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs).toEqual({
      principal: "andreas",
      stack: "andreas/meta-factory",
      natsConfigPath: "~/.config/nats/local.conf",
      plistPath: "~/Library/LaunchAgents/nats.plist",
      platform: "darwin",
      // C-820 — leave now ALSO resolves the registry coordinates + seed so it can
      // retag the principal's capabilities (the inverse of join's union).
      registryUrl: "https://registry.meta-factory.ai",
      registryPubkey: "A".repeat(43) + "=",
      seedPath: "~/.config/nats/cortex.nk",
    });
  });

  test("C-820 — registry/seed are OPTIONAL: leave still derives when they're absent", () => {
    // A config with NO registry block + NO seed: leave's PRIMARY effect (local
    // teardown) must still derive; the registry retag is simply skipped later.
    const noRegistry = loaded({
      principal: { id: "jc" },
      stack: {
        id: "jc/clawbox",
        nats_infra: {
          config_path: "~/.config/nats/local.conf",
          plist_path: "~/Library/LaunchAgents/nats.plist",
        },
      },
      policy: { principals: [], roles: [], federated: { networks: [] } },
    });
    const res = deriveLeaveInputs({}, "/cfg", reader(noRegistry), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.registryUrl).toBeUndefined();
    expect(res.inputs?.seedPath).toBeUndefined();
    expect(res.inputs?.principal).toBe("jc");
  });

  test("flag overrides win", () => {
    const res = deriveLeaveInputs(
      { principal: "p2", stack: "p2/s", natsConfigPath: "/c", plistPath: "/p" },
      "/cfg",
      reader(FULL),
    );
    expect(res.inputs?.principal).toBe("p2");
    expect(res.inputs?.natsConfigPath).toBe("/c");
  });

  test("missing nats config → actionable error", () => {
    const cfg = loaded({ principal: { id: "andreas" } });
    const res = deriveLeaveInputs({}, "/cfg", reader(cfg));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("stack.nats_infra.config_path");
  });
});

// =============================================================================
// #763 — Linux/systemd platform-aware descriptor derivation
// =============================================================================

// A Linux-shape config: nats_infra carries `unit_path` (the systemd unit), not
// `plist_path`. Otherwise identical to FULL.
const FULL_LINUX = loaded({
  principal: { id: "jc" },
  stack: {
    id: "jc/clawbox",
    nkey_seed_path: "~/.config/nats/cortex.nk",
    nats_infra: {
      config_path: "~/.config/nats/local.conf",
      unit_path: "~/.config/systemd/user/nats-server.service",
      account: "A" + "B".repeat(55),
    },
  },
  policy: {
    principals: [],
    roles: [],
    federated: {
      networks: [],
      registry: { url: "https://registry.meta-factory.ai" },
    },
  },
});

describe("#763 — deriveJoinInputs platform-aware descriptor", () => {
  test("on LINUX, derives the systemd unit_path (not plist_path) + platform", () => {
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(FULL_LINUX), "linux");
    expect(res.ok).toBe(true);
    expect(res.inputs?.unitPath).toBe("~/.config/systemd/user/nats-server.service");
    expect(res.inputs?.plistPath).toBeUndefined();
    expect(res.inputs?.platform).toBe("linux");
  });

  test("on macOS, derives the plist_path (not unit_path) + platform", () => {
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(FULL), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.plistPath).toBe("~/Library/LaunchAgents/nats.plist");
    expect(res.inputs?.unitPath).toBeUndefined();
    expect(res.inputs?.platform).toBe("darwin");
  });

  test("--unit flag overrides the config unit_path on Linux", () => {
    const res = deriveJoinInputs(
      "metafactory",
      { unitPath: "/flag/nats.service" },
      "/cfg",
      reader(FULL_LINUX),
      "linux",
    );
    expect(res.inputs?.unitPath).toBe("/flag/nats.service");
  });

  test("on LINUX with NO unit configured → actionable error naming unit_path", () => {
    // FULL has only plist_path; on linux that is not the right descriptor.
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(FULL), "linux");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("stack.nats_infra.unit_path");
    expect(res.reason).toContain("--unit");
  });

  test("on macOS with NO plist configured → actionable error naming plist_path", () => {
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(FULL_LINUX), "darwin");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("stack.nats_infra.plist_path");
    expect(res.reason).toContain("--plist");
  });
});

describe("#763 — deriveLeaveInputs platform-aware descriptor", () => {
  test("on LINUX derives unit_path + platform", () => {
    const res = deriveLeaveInputs({}, "/cfg", reader(FULL_LINUX), "linux");
    expect(res.ok).toBe(true);
    expect(res.inputs?.unitPath).toBe("~/.config/systemd/user/nats-server.service");
    expect(res.inputs?.plistPath).toBeUndefined();
    expect(res.inputs?.platform).toBe("linux");
  });
});

// =============================================================================
// O-3 (cortex#1053) — assemble the operator-mode leaf package from config/flags.
// =============================================================================

describe("deriveJoinInputs — O-3 operator-mode leaf package", () => {
  const OP_JWT = "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.FAKE_OP.sig";
  const ACC_JWT = "eyJhbGciOiJlZDI1NTE5LW5rZXkifQ.FAKE_ACC.sig";

  test("config-supplied package (operator_jwt + account + account_jwt) materialises", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        id: "andreas/community",
        nkey_seed_path: "~/seed.nk",
        nats_infra: {
          config_path: "~/community.conf",
          plist_path: "~/nats.plist",
          account: "A" + "B".repeat(55),
          operator_jwt: OP_JWT,
          account_jwt: ACC_JWT,
        },
      },
      policy: {
        principals: [],
        roles: [],
        federated: {
          networks: [],
          registry: { url: "https://r", pubkey: "A".repeat(43) + "=" },
        },
      },
    });
    const res = deriveJoinInputs("metafactory-community", {}, "/cfg", reader(cfg), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.operatorModePackage).toEqual({
      operatorJwt: OP_JWT,
      account: "A" + "B".repeat(55),
      accountJwt: ACC_JWT,
    });
  });

  test("flags override config for the package fields", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        id: "andreas/community",
        nkey_seed_path: "~/seed.nk",
        nats_infra: {
          config_path: "~/community.conf",
          plist_path: "~/nats.plist",
          account: "A" + "B".repeat(55),
          operator_jwt: "eyJ.CONFIG_OP.sig",
          account_jwt: "eyJ.CONFIG_ACC.sig",
        },
      },
      policy: {
        principals: [],
        roles: [],
        federated: {
          networks: [],
          registry: { url: "https://r", pubkey: "A".repeat(43) + "=" },
        },
      },
    });
    const res = deriveJoinInputs(
      "metafactory-community",
      { operatorJwt: OP_JWT, accountJwt: ACC_JWT, account: "A" + "C".repeat(55) },
      "/cfg",
      reader(cfg),
      "darwin",
    );
    expect(res.ok).toBe(true);
    expect(res.inputs?.operatorModePackage).toEqual({
      operatorJwt: OP_JWT,
      account: "A" + "C".repeat(55),
      accountJwt: ACC_JWT,
    });
  });

  test("a SYS account (+ jwt) is carried through when present", () => {
    const res = deriveJoinInputs(
      "metafactory-community",
      {
        operatorJwt: OP_JWT,
        accountJwt: ACC_JWT,
        account: "A" + "B".repeat(55),
        systemAccount: "A" + "D".repeat(55),
        systemAccountJwt: "eyJ.SYS.sig",
      },
      "/cfg",
      reader(loaded({
        principal: { id: "andreas" },
        stack: {
          id: "andreas/community",
          nkey_seed_path: "~/seed.nk",
          nats_infra: { config_path: "~/c.conf", plist_path: "~/p.plist" },
        },
        policy: {
          principals: [],
          roles: [],
          federated: { networks: [], registry: { url: "https://r", pubkey: "A".repeat(43) + "=" } },
        },
      })),
      "darwin",
    );
    expect(res.ok).toBe(true);
    expect(res.inputs?.operatorModePackage).toEqual({
      operatorJwt: OP_JWT,
      account: "A" + "B".repeat(55),
      accountJwt: ACC_JWT,
      systemAccount: "A" + "D".repeat(55),
      systemAccountJwt: "eyJ.SYS.sig",
    });
  });

  test("a PARTIAL package (operator_jwt but no account_jwt) → no package (fail-fast preserved)", () => {
    const res = deriveJoinInputs(
      "metafactory-community",
      { operatorJwt: OP_JWT, account: "A" + "B".repeat(55) }, // no accountJwt
      "/cfg",
      reader(loaded({
        principal: { id: "andreas" },
        stack: {
          id: "andreas/community",
          nkey_seed_path: "~/seed.nk",
          nats_infra: { config_path: "~/c.conf", plist_path: "~/p.plist" },
        },
        policy: {
          principals: [],
          roles: [],
          federated: { networks: [], registry: { url: "https://r", pubkey: "A".repeat(43) + "=" } },
        },
      })),
      "darwin",
    );
    expect(res.ok).toBe(true);
    expect(res.inputs?.operatorModePackage).toBeUndefined();
  });

  test("no package material at all → operatorModePackage undefined (the common case)", () => {
    const res = deriveJoinInputs("metafactory", {}, "/cfg/cortex.yaml", reader(FULL), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.operatorModePackage).toBeUndefined();
  });
});

// =============================================================================
// operator-mode precedence — explicit flags > config > convention.
// (O-4b --from-package source retired in ADR-0015; tests for that path removed.)
// =============================================================================

describe("deriveJoinInputs — operator-mode source precedence", () => {
  // A config with NO operator-mode material — explicit flags are the only source.
  const CFG_NO_PKG = loaded({
    principal: { id: "andreas" },
    stack: {
      id: "andreas/community",
      nkey_seed_path: "~/seed.nk",
      nats_infra: { config_path: "~/community.conf", plist_path: "~/nats.plist" },
    },
    policy: {
      principals: [],
      roles: [],
      federated: {
        networks: [],
        registry: { url: "https://r", pubkey: "A".repeat(43) + "=" },
      },
    },
  });

  test("no package + no flags + no config material → operatorModePackage undefined", () => {
    const res = deriveJoinInputs("metafactory-community", {}, "/cfg", reader(CFG_NO_PKG), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.operatorModePackage).toBeUndefined();
    // creds still falls through to the convention default.
    expect(res.inputs?.credsPath).toBe("~/.config/nats/metafactory-community.creds");
  });
});

// =============================================================================
// C-1224 (ADR-0013 Model B) — leaf shared secret resolution.
// =============================================================================

describe("C-1224 — leaf-secret (secret-auth pipe) derivation", () => {
  test("leaf_secret from config → leafSecret + leafUser defaults to principal", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        id: "andreas/meta-factory",
        nkey_seed_path: "~/.config/nats/cortex.nk",
        nats_infra: {
          config_path: "~/.config/nats/local.conf",
          plist_path: "~/Library/LaunchAgents/nats.plist",
          account: "A" + "B".repeat(55),
          leaf_secret: "s3cr3t-from-config",
        },
      },
    });
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.leafSecret).toBe("s3cr3t-from-config");
    // No leaf_user in config → defaults to the principal id.
    expect(res.inputs?.leafUser).toBe("andreas");
  });

  test("leaf_user from config overrides the principal-id default", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        id: "andreas/meta-factory",
        nkey_seed_path: "~/.config/nats/cortex.nk",
        nats_infra: {
          config_path: "~/.config/nats/local.conf",
          plist_path: "~/Library/LaunchAgents/nats.plist",
          leaf_secret: "s3cr3t",
          leaf_user: "andreas-leaf",
        },
      },
    });
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg), "darwin");
    expect(res.inputs?.leafUser).toBe("andreas-leaf");
  });

  test("--leaf-secret / --leaf-user flags win over config", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        id: "andreas/meta-factory",
        nkey_seed_path: "~/.config/nats/cortex.nk",
        nats_infra: {
          config_path: "~/.config/nats/local.conf",
          plist_path: "~/Library/LaunchAgents/nats.plist",
          leaf_secret: "config-secret",
          leaf_user: "config-user",
        },
      },
    });
    const res = deriveJoinInputs(
      "metafactory",
      { leafSecret: "flag-secret", leafUser: "flag-user" },
      "/cfg",
      reader(cfg),
      "darwin",
    );
    expect(res.inputs?.leafSecret).toBe("flag-secret");
    expect(res.inputs?.leafUser).toBe("flag-user");
  });

  test("no leaf_secret anywhere → leafSecret + leafUser both absent (creds path)", () => {
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(FULL), "darwin");
    expect(res.inputs?.leafSecret).toBeUndefined();
    // leafUser is meaningless without a secret — never resolved on its own.
    expect(res.inputs?.leafUser).toBeUndefined();
  });
});

// =============================================================================
// C-1364 — the join own-scope guard and the daemon boot validator MUST derive
// the stack identity from ONE authority (`deriveStackId` → stack.id, ADR-0004).
//
// Latent drift (found by the PR #1361 adversarial review, vector 4): the join
// own-scope guard built its `federated.{me}.{stack}.` scope from the flag/
// locator-honouring slug (`resolveStackSlug(inputs.stack)`), while the boot
// validator (`CortexConfigSchema` federated subject-scope superRefine) derives
// it from `deriveStackId(config).stack`. For a BORN-ALIGNED stack the two agree;
// for a DRIFTED stack (a `--stack` override, or a locator slug ≠ stack.id
// trailing segment) they DISAGREE — the join then persists an accept-list scoped
// to one identity that the daemon refuses to boot against, or falsely refuses a
// valid one. The fix threads `bootStackSlug = deriveStackId(cfg).stack` and pins
// the guard to it, so guard + boot can never split.
// =============================================================================

describe("C-1364 — join own-scope identity converges with boot on deriveStackId", () => {
  // A DRIFTED stack: config `stack.id` trailing segment is "work", and the join
  // is invoked with `--stack andreas/research` (slug "research" ≠ "work"). This
  // is exactly the "slug ≠ stack.id trailing segment" class ADR-0004 targets.
  const DRIFTED = loaded({
    principal: { id: "andreas" },
    stack: {
      id: "andreas/work",
      nkey_seed_path: "~/seed.nk",
      nats_infra: {
        config_path: "~/local.conf",
        plist_path: "~/nats.plist",
        account: "A" + "B".repeat(55),
      },
    },
    policy: {
      principals: [],
      roles: [],
      federated: {
        networks: [],
        registry: { url: DEFAULT_REGISTRY.url, pubkey: DEFAULT_REGISTRY.pubkey },
      },
    },
  });

  // Build a raw cortex config the DAEMON BOOTS from — stack.id "andreas/work",
  // one federated network whose accept-list is the argument. Parsing it through
  // CortexConfigSchema runs the REAL subject-scope superRefine (the boot verdict).
  function bootConfigWithAccept(accept: string[]): Record<string, unknown> {
    return {
      principal: { id: "andreas" },
      agents: [
        {
          id: "luna",
          displayName: "Luna",
          persona: "./personas/luna.md",
          presence: {
            discord: {
              token: "DISCORD_TOKEN",
              guildId: "111111111111111111",
              agentChannelId: "222222222222222222",
              logChannelId: "333333333333333333",
            },
          },
        },
      ],
      renderers: [],
      claude: { model: "claude-opus-4-5", apiKey: "env:ANTHROPIC_API_KEY" },
      // The authority: stack.id trailing segment "work".
      stack: { id: "andreas/work" },
      policy: {
        federated: {
          networks: [
            {
              id: "metafactory",
              leaf_node: "leaf",
              peers: [],
              accept_subjects: accept,
              deny_subjects: [],
              announce_capabilities: [],
              max_hop: 1,
            },
          ],
        },
      },
    };
  }

  test("bootStackSlug tracks stack.id, NOT the --stack flag → guard + boot prefixes are identical", () => {
    // Join with a --stack override whose slug ("research") disagrees with stack.id.
    const res = deriveJoinInputs(
      "metafactory",
      { stack: "andreas/research" },
      "/cfg",
      reader(DRIFTED),
      "darwin",
    );
    expect(res.ok).toBe(true);
    const inputs = res.inputs;
    if (inputs === undefined) throw new Error("expected inputs");

    // The flag moved the LOCATOR / write-path id (DA-5) ...
    expect(inputs.stack).toBe("andreas/research");
    // ... but the boot-authoritative own-scope slug stays stack.id's segment.
    expect(inputs.bootStackSlug).toBe("work");

    // BOOT derives its prefix EXACTLY as the superRefine does:
    // ownFederatedSubjectScopePrefix(config.principal.id, deriveStackId(config).stack).
    const bootPrefix = ownFederatedSubjectScopePrefix("andreas", deriveStackId(DRIFTED).stack);
    // The JOIN GUARD now derives from bootStackSlug — must be identical (no split).
    const guardPrefix = ownFederatedSubjectScopePrefix(inputs.principal, inputs.bootStackSlug);
    expect(guardPrefix).toBe(bootPrefix);
    expect(guardPrefix).toBe("federated.andreas.work.");

    // Regression witness: the PRE-FIX derivation (the flag/locator slug off
    // inputs.stack) WOULD have produced a different prefix — the split this closes.
    const preFixSlug = inputs.stack.split("/")[1];
    if (preFixSlug === undefined) throw new Error("expected slug");
    expect(preFixSlug).toBe("research");
    expect(ownFederatedSubjectScopePrefix(inputs.principal, preFixSlug)).not.toBe(bootPrefix);
  });

  test("accept-list the join persists from bootStackSlug PASSES boot; the pre-fix flag-slug list is REFUSED (no split verdict)", () => {
    const res = deriveJoinInputs(
      "metafactory",
      { stack: "andreas/research" },
      "/cfg",
      reader(DRIFTED),
      "darwin",
    );
    const inputs = res.inputs;
    if (inputs === undefined) throw new Error("expected inputs");

    // What the join own-scope guard builds + persists (network-lib.ts): the
    // own-scope accept-list from bootStackSlug ("work").
    const acceptFromBoot = ownAcceptSubjects({
      principal: inputs.principal,
      stack: inputs.bootStackSlug,
    });
    expect(acceptFromBoot.every((s) => s.startsWith("federated.andreas.work."))).toBe(true);

    // The PRE-FIX path built the accept-list from the flag/locator slug ("research").
    const preFixSlug = inputs.stack.split("/")[1];
    if (preFixSlug === undefined) throw new Error("expected slug");
    const acceptFromFlag = ownAcceptSubjects({
      principal: inputs.principal,
      stack: preFixSlug,
    });

    // AGREEMENT: the daemon boot validator ACCEPTS exactly what the fixed join
    // writes — both accept, no split.
    expect(() => CortexConfigSchema.parse(bootConfigWithAccept(acceptFromBoot))).not.toThrow();
    // And it REFUSES the pre-fix flag-slug list — proving the latent split the
    // fix closes (join would have written a config the daemon bricks on).
    expect(() => CortexConfigSchema.parse(bootConfigWithAccept(acceptFromFlag))).toThrow();
  });

  test("BORN-ALIGNED stack (no drift) is unchanged: bootStackSlug == the flag/locator slug", () => {
    // FULL is born-aligned (stack.id andreas/meta-factory); no --stack override.
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(FULL), "darwin");
    const inputs = res.inputs;
    if (inputs === undefined) throw new Error("expected inputs");
    // The two derivations coincide for a born-aligned stack — the exact
    // pre-fix behaviour, preserved.
    expect(inputs.bootStackSlug).toBe("meta-factory");
    expect(inputs.stack.split("/")[1]).toBe("meta-factory");
    expect(inputs.bootStackSlug).toBe(deriveStackId(FULL).stack);
  });
});
