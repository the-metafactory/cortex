/**
 * C-1257 — CLI tests for `cortex network make-live <stack>`. The config reader +
 * make-live ports are both injected; the read-only state probes are made
 * deterministic by pointing --nats-config / --creds at nonexistent paths (absent
 * ⇒ "needs migration"), so no real disk / arc / launchctl is touched.
 */
import { describe, test, expect } from "bun:test";

import { dispatchNetwork, type MakeLivePortsFactory } from "../network";
import type { ConfigReader } from "../network-derive";
import type { LoadedConfig } from "../../../../common/config/loader";
import type { AgentConfig } from "../../../../common/types/config";
import type { MakeLivePorts } from "../network-make-live-lib";

const AGENTS_PUB = "A" + "R".repeat(55);
const AGENTS_JWT = "eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiJBQVJSIn0.sig";

function loaded(partial: Partial<LoadedConfig>): LoadedConfig {
  return { config: {} as AgentConfig, inlineAgents: [], ...partial };
}
function reader(cfg: LoadedConfig): ConfigReader {
  return () => cfg;
}

const ABSENT_NATS = "/nonexistent-makelive-test/local.conf";
const ABSENT_CREDS = "/nonexistent-makelive-test/cortex-work.creds";
const ABSENT_COMMUNITY_NATS = "/nonexistent-makelive-test/community.conf";

/** A fully-provisioned local stack (nats_infra.agents_account set). */
const PROVISIONED = loaded({
  principal: { id: "andreas" },
  config: { nats: { name: "cortex-work", credsPath: ABSENT_CREDS } } as unknown as AgentConfig,
  stack: {
    id: "andreas/work",
    nkey_seed_path: "~/.config/nats/cortex-work.nk",
    nats_infra: {
      account: "A" + "B".repeat(55),
      agents_account: AGENTS_PUB,
      creds_path: "~/.config/nats/work.creds",
    },
  },
});

/** An un-provisioned stack (no nats_infra account tree). */
const UNPROVISIONED = loaded({
  principal: { id: "andreas" },
  config: { nats: { name: "cortex-work", credsPath: ABSENT_CREDS } } as unknown as AgentConfig,
  stack: { id: "andreas/work", nkey_seed_path: "~/.config/nats/cortex-work.nk" },
});

/**
 * BLOCK 1 — a provisioned stack carrying its OWN per-stack nats-server config
 * (`stack.nats_infra.config_path` → an absent path so the state probe reads
 * "needs migration"). No `--nats-config` flag is passed: derivation must come
 * from config, NOT a hardcoded shared local.conf default.
 */
const PROVISIONED_WITH_CONFIGPATH = loaded({
  principal: { id: "andreas" },
  config: { nats: { name: "cortex-community", credsPath: ABSENT_CREDS } } as unknown as AgentConfig,
  stack: {
    id: "andreas/community",
    nkey_seed_path: "~/.config/nats/cortex-community.nk",
    nats_infra: {
      account: "A" + "B".repeat(55),
      agents_account: AGENTS_PUB,
      config_path: ABSENT_COMMUNITY_NATS, // community.conf, NOT the shared local.conf
      creds_path: "~/.config/nats/community.creds",
    },
  },
});

/**
 * v5.30.2 — a provisioned, federation-ready stack whose `config.nats` carries NO
 * `credsPath` (a from-scratch `cortex stack create` stack before the seed lands,
 * OR a pre-existing unseeded stack). make-live must DEFAULT credsPath to the
 * conventional bus/bot path `~/.config/nats/<slug>-bot.creds` (DISTINCT from the
 * FEDERATION default `~/.config/nats/<slug>.creds`) rather than erroring for `--creds`.
 */
const UNSEEDED_CREDS = loaded({
  principal: { id: "andreas" },
  config: { nats: { name: "cortex-community" } } as unknown as AgentConfig,
  stack: {
    id: "andreas/community",
    nkey_seed_path: "~/.config/nats/cortex-community.nk",
    nats_infra: {
      account: "A" + "B".repeat(55),
      agents_account: AGENTS_PUB,
      config_path: ABSENT_COMMUNITY_NATS,
      // FEDERATION leaf creds — deliberately a DISTINCT path so a test can prove
      // make-live does NOT conflate it with the defaulted bus creds.
      creds_path: "~/.config/nats/community-leaf.creds",
    },
  },
});

/** A recorded credsPath write-back call (v5.30.2). */
interface ConfigWriteCall {
  systemConfigPath: string;
  credsPath: string;
}

function fakeFactory(): {
  factory: MakeLivePortsFactory;
  calls: string[];
  mutates: boolean[];
  configWrites: ConfigWriteCall[];
} {
  const calls: string[] = [];
  const mutates: boolean[] = [];
  // Recorded into a SEPARATE array so it never disturbs the `calls`-ordering assertions.
  const configWrites: ConfigWriteCall[] = [];
  const factory: MakeLivePortsFactory = (mutate) => {
    mutates.push(mutate);
    const ports: MakeLivePorts = {
      creds: {
        mint: async ({ account, credsPath }) => {
          calls.push(`mint:${account}`);
          return { ok: true, credsPath, userPubkey: "U" + "Z".repeat(55) };
        },
      },
      accountExport: {
        exportAccount: async (account) => {
          calls.push(`export:${account}`);
          return { ok: true, pubKey: AGENTS_PUB, jwt: AGENTS_JWT, seedPath: null };
        },
      },
      resolver: {
        hasAccount: () => false,
        hasResolverPreload: () => true, // M3 — operator-mode bus (fake)
        appendAccount: () => { calls.push("resolver-append"); return { ok: true, changed: true }; },
        bootstrapOperatorMode: () => { calls.push("bootstrap"); return { ok: true, changed: true }; },
      },
      restart: {
        resolveTargets: () => ({ natsDescriptor: "/LA/nats.plist", daemonDescriptor: "/LA/cortex.plist" }),
        restartNats: async () => { calls.push("restart-nats"); return { ok: true }; },
        restartDaemon: async () => { calls.push("restart-daemon"); return { ok: true }; },
      },
      configWrite: {
        writeBusCredsPath: ({ systemConfigPath, credsPath }) => {
          configWrites.push({ systemConfigPath, credsPath });
          return { ok: true, path: systemConfigPath, changed: true };
        },
      },
    };
    return ports;
  };
  return { factory, calls, mutates, configWrites };
}

function run(argv: string[], cfg: LoadedConfig, factory: MakeLivePortsFactory) {
  return dispatchNetwork(argv, reader(cfg), undefined, undefined, undefined, factory);
}

describe("cortex network make-live — dry-run (default)", () => {
  test("prints the plan, mutates nothing", async () => {
    const { factory, calls, mutates } = fakeFactory();
    const res = await run(
      ["make-live", "work", "--config", "/x/work.yaml", "--nats-config", ABSENT_NATS],
      PROVISIONED,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("dry-run");
    expect(res.stdout).toContain("ANDREAS_WORK_AGENTS");
    expect(res.stdout).toContain("resolver_preload");
    expect(calls).toEqual([]); // dry-run: no effects
    expect(mutates).toEqual([false]); // ports built with mutate=false
  });

  test("BLOCK 2: prints the resolved nats-server + daemon restart targets", async () => {
    const { factory } = fakeFactory();
    const res = await run(
      ["make-live", "work", "--config", "/x/work.yaml", "--nats-config", ABSENT_NATS],
      PROVISIONED,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("nats-server restart target");
    expect(res.stdout).toContain("/LA/nats.plist");
    expect(res.stdout).toContain("cortex daemon restart target");
    expect(res.stdout).toContain("/LA/cortex.plist");
  });
});

describe("cortex network make-live — BLOCK 1 per-stack nats-config derivation", () => {
  test("derives natsConfigPath from stack.nats_infra.config_path (no --nats-config flag)", async () => {
    const { factory, calls } = fakeFactory();
    const res = await run(
      // NOTE: no --nats-config — must come from config, not a shared default.
      ["make-live", "community", "--config", "/x/community.yaml", "--apply"],
      PROVISIONED_WITH_CONFIGPATH,
      factory,
    );
    expect(res.exitCode).toBe(0);
    // The plan/transcript names the stack's OWN config_path, never local.conf.
    expect(res.stdout).toContain(ABSENT_COMMUNITY_NATS);
    expect(res.stdout).not.toContain("local.conf");
    expect(calls).toContain("export:ANDREAS_COMMUNITY_AGENTS");
  });

  test("fail-fast (usage error) when neither --nats-config nor stack.nats_infra.config_path is set", async () => {
    const { factory, calls } = fakeFactory();
    // PROVISIONED has nats_infra.agents_account but NO config_path, and no flag.
    const res = await run(
      ["make-live", "work", "--config", "/x/work.yaml", "--apply"],
      PROVISIONED,
      factory,
    );
    expect(res.exitCode).toBe(2); // usage error
    expect(res.stderr).toContain("config_path");
    expect(res.stderr).toContain("local.conf"); // names the trap it refuses to default to
    expect(calls).toEqual([]); // nothing minted/restarted
  });
});

describe("cortex network make-live — apply", () => {
  test("runs export → resolver → nats restart → creds → daemon restart in order", async () => {
    const { factory, calls, mutates } = fakeFactory();
    const res = await run(
      ["make-live", "work", "--config", "/x/work.yaml", "--nats-config", ABSENT_NATS, "--apply"],
      PROVISIONED,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(calls).toEqual([
      "export:ANDREAS_WORK_AGENTS",
      "resolver-append",
      "restart-nats",
      "mint:ANDREAS_WORK_AGENTS",
      "restart-daemon",
    ]);
    expect(mutates).toEqual([true]);
  });

  test("un-provisioned stack is a usage error naming provision", async () => {
    const { factory, calls } = fakeFactory();
    const res = await run(
      ["make-live", "work", "--config", "/x/work.yaml", "--nats-config", ABSENT_NATS, "--apply"],
      UNPROVISIONED,
      factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("provision");
    expect(calls).toEqual([]);
  });

  test("--apply + --dry-run is a usage error", async () => {
    const { factory } = fakeFactory();
    const res = await run(
      ["make-live", "work", "--config", "/x/work.yaml", "--apply", "--dry-run"],
      PROVISIONED,
      factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("mutually exclusive");
  });
});

// The two default paths that MUST stay distinct (different NATS accounts).
// BUS_DEFAULT is make-live's bus/bot-user creds (agents account); FED_DEFAULT is
// provision's federation-user creds default (deriveProvisionInputs, network.ts).
// slug = community for these tests.
const BUS_CREDS_DEFAULT = "~/.config/nats/community-bot.creds";
const FED_CREDS_DEFAULT = "~/.config/nats/community.creds";

describe("cortex network make-live — credsPath default (v5.30.2, C-1265c)", () => {
  test("defaults nats.credsPath to ~/.config/nats/<slug>-bot.creds, DISTINCT from provision's federation default", async () => {
    // Guard the invariant directly: the bus/bot default and the federation
    // default must never resolve to the same file (different NATS accounts).
    expect(BUS_CREDS_DEFAULT).not.toBe(FED_CREDS_DEFAULT);

    const { factory } = fakeFactory();
    const res = await run(
      // No --creds; UNSEEDED_CREDS has no config.nats.credsPath. slug=community.
      ["make-live", "community", "--config", "/x/community.yaml"],
      UNSEEDED_CREDS,
      factory,
    );
    expect(res.exitCode).toBe(0); // no longer a usage error — a path is always derivable
    // The bus-creds plan line names the conventional `-bot` bus/bot-user path…
    expect(res.stdout).toContain(BUS_CREDS_DEFAULT);
    // …and NEVER provision's FEDERATION default `~/.config/nats/<slug>.creds`
    // (`community-bot.creds` does not contain that substring) — proving make-live's
    // bus user and `network join`'s federation user resolve to DIFFERENT files and
    // cannot clobber each other on a fresh stack.
    expect(res.stdout).not.toContain(FED_CREDS_DEFAULT);
    // …and NEVER the stack's federation leaf creds (stack.nats_infra.creds_path) —
    // a leaf-creds fallback was the wrong fix.
    expect(res.stdout).not.toContain("community-leaf.creds");
  });

  test("config nats.credsPath takes precedence over the conventional default", async () => {
    const { factory } = fakeFactory();
    const res = await run(
      ["make-live", "community", "--config", "/x/community.yaml"],
      PROVISIONED_WITH_CONFIGPATH, // config.nats.credsPath = ABSENT_CREDS
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(ABSENT_CREDS);
    expect(res.stdout).not.toContain(BUS_CREDS_DEFAULT);
  });

  test("--creds flag takes precedence over both config and the default", async () => {
    const { factory } = fakeFactory();
    const customCreds = "/custom/explicit/path.creds";
    const res = await run(
      ["make-live", "community", "--config", "/x/community.yaml", "--creds", customCreds],
      UNSEEDED_CREDS,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain(customCreds);
    expect(res.stdout).not.toContain(BUS_CREDS_DEFAULT);
  });
});

describe("cortex network make-live — credsPath write-back (v5.30.2, C-1265c)", () => {
  test("on --apply, a DEFAULTED credsPath is written back into config.nats.credsPath", async () => {
    const { factory, configWrites } = fakeFactory();
    const res = await run(
      ["make-live", "community", "--config", "/x/community.yaml", "--apply"],
      UNSEEDED_CREDS, // no config.nats.credsPath, no --creds ⇒ defaulted
      factory,
    );
    expect(res.exitCode).toBe(0);
    // Exactly one write-back, carrying the resolved `-bot` path…
    expect(configWrites).toHaveLength(1);
    expect(configWrites[0]?.credsPath).toBe(BUS_CREDS_DEFAULT);
    // …targeting the SYSTEM-layer config. No `/x/system/system.yaml` marker exists
    // for this test path, so it resolves to the monolith file (`/x/community.yaml`).
    expect(configWrites[0]?.systemConfigPath).toBe("/x/community.yaml");
    // …and the transcript records the self-documenting write.
    expect(res.stdout).toContain("nats.credsPath defaulted");
    expect(res.stdout).toContain("written to config");
  });

  test("on --apply, an EXPLICIT --creds is NEVER written back (no config mutation)", async () => {
    const { factory, configWrites } = fakeFactory();
    const res = await run(
      ["make-live", "community", "--config", "/x/community.yaml", "--creds", "/custom/explicit/path.creds", "--apply"],
      UNSEEDED_CREDS,
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(configWrites).toHaveLength(0); // credsPathDefaulted=false ⇒ no write-back
  });

  test("on --apply, an EXPLICIT config.nats.credsPath is NEVER written back", async () => {
    const { factory, configWrites } = fakeFactory();
    const res = await run(
      ["make-live", "community", "--config", "/x/community.yaml", "--apply"],
      PROVISIONED_WITH_CONFIGPATH, // config.nats.credsPath = ABSENT_CREDS (explicit)
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(configWrites).toHaveLength(0);
  });
});
