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
import type { LoadedConfig } from "../../../../common/config/loader";
import type { AgentConfig } from "../../../../common/types/config";

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

  test("registry pubkey absent → omitted (TOFU), still ok", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: {
        id: "andreas/meta-factory",
        nkey_seed_path: "~/seed.nk",
        nats_infra: { config_path: "~/c", plist_path: "~/p", account: "A" + "D".repeat(55) },
      },
      policy: {
        principals: [], roles: [],
        federated: { networks: [], registry: { url: "https://r.test" } },
      },
    });
    // Pin darwin — `plist_path` fixture (cortex#771; see above).
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg), "darwin");
    expect(res.ok).toBe(true);
    expect(res.inputs?.registryPubkey).toBeUndefined();
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

  test("no registry anywhere → names policy.federated.registry.url", () => {
    const cfg = loaded({
      principal: { id: "andreas" },
      stack: { id: "andreas/mf", nkey_seed_path: "~/s" },
    });
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("policy.federated.registry.url");
  });

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
