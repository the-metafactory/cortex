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
    const res = deriveJoinInputs("metafactory", {}, "/cfg/cortex.yaml", reader(FULL));
    expect(res.ok).toBe(true);
    expect(res.inputs).toEqual({
      principal: "andreas",
      stack: "andreas/meta-factory",
      seedPath: "~/.config/nats/cortex.nk",
      registryUrl: "https://registry.meta-factory.ai",
      registryPubkey: "A".repeat(43) + "=",
      natsConfigPath: "~/.config/nats/local.conf",
      plistPath: "~/Library/LaunchAgents/nats.plist",
      account: "A" + "B".repeat(55),
      credsPath: "~/.config/nats/mf.creds",
    });
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
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg));
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
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg));
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
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg));
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
      account: "A" + "F".repeat(55),
      credsPath: "/flag/x.creds",
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

  test("no account → names stack.nats_infra.account", () => {
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
    const res = deriveJoinInputs("metafactory", {}, "/cfg", reader(cfg));
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("stack.nats_infra.account");
  });
});

// =============================================================================
// Leave derivation
// =============================================================================

describe("deriveLeaveInputs", () => {
  test("derives principal/stack/nats-config/plist from config (no flags)", () => {
    const res = deriveLeaveInputs({}, "/cfg", reader(FULL));
    expect(res.ok).toBe(true);
    expect(res.inputs).toEqual({
      principal: "andreas",
      stack: "andreas/meta-factory",
      natsConfigPath: "~/.config/nats/local.conf",
      plistPath: "~/Library/LaunchAgents/nats.plist",
    });
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
