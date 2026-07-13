/**
 * `cortex config validate` — unit tests.
 *
 * Proves the standalone pre-flight validator runs the daemon's REAL boot
 * validation (`loadConfigWithAgents` → `composeRawConfig` + `CortexConfigSchema`)
 * without booting anything:
 *
 *   - a VALID single-file cortex config → ok (exit 0, `✓ config valid`,
 *     stack/network counts; --json `{"ok":true,…}`).
 *   - an INVALID config (a `policy.federated.networks[0].accept_subjects[1]`
 *     entry that doesn't begin with the receiving stack's own
 *     `federated.<principal>.<stack>.` scope) → the SAME precise Zod issue the
 *     boot path emits, exit 1 (--json `{"ok":false,…}`).
 *
 * Fixtures use placeholder principal/stack/persona strings and `presence: {}`
 * (empty presence is valid — cortex#245), so no 17-20-digit snowflakes or
 * secrets appear. Fixtures are written mode 0600 because the single-file loader
 * enforces chmod-600 on the config it reads (cortex#636).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify } from "yaml";

import { dispatchConfig } from "../config";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "cortex-config-validate-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Write a cortex.yaml fixture mode 0600 (the single-file loader gate). */
function writeConfig(config: Record<string, unknown>): string {
  const path = join(testDir, "cortex.yaml");
  writeFileSync(path, stringify(config), { mode: 0o600 });
  return path;
}

/**
 * Minimal VALID cortex-shape config with a `stack:` block and one federated
 * network. `principal.id: andreas` + `stack.id: andreas/default` →
 * `deriveStackId` resolves the own-scope prefix `federated.andreas.default.`,
 * so the single accept_subject is in-scope and the config validates.
 */
function validConfig(): Record<string, unknown> {
  return {
    principal: { id: "andreas" },
    stack: { id: "andreas/default" },
    agents: [
      {
        id: "luna",
        displayName: "Luna",
        persona: "./personas/luna.md",
        presence: {},
      },
    ],
    claude: {},
    policy: {
      federated: {
        networks: [
          {
            id: "research-collab",
            leaf_node: "leaf",
            peers: [],
            accept_subjects: ["federated.andreas.default.>"],
            deny_subjects: [],
            announce_capabilities: [],
            max_hop: 0,
          },
        ],
      },
    },
  };
}

describe("cortex config validate — valid config", () => {
  test("exit 0 with a ✓ line + stack/network summary", async () => {
    const path = writeConfig(validConfig());
    const result = await dispatchConfig(["validate", "--config", path]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`✓ config valid: ${path}`);
    // One stack (a `stack:` block is present), one federated network.
    expect(result.stdout).toContain("1 stack, 1 network");
  });

  test("--json emits {ok:true} with path + counts", async () => {
    const path = writeConfig(validConfig());
    const result = await dispatchConfig(["validate", "--config", path, "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual({ ok: true, path, stacks: 1, networks: 1 });
  });
});

describe("cortex config validate — FND-6 governance drift (posture A, warning-level)", () => {
  /** Cortex config that enables MC and points at a sibling MC yaml. */
  function configWithMc(mcConfigPath: string): Record<string, unknown> {
    const cfg = validConfig();
    cfg.claude = {};
    cfg.mc = { enabled: true, configPath: mcConfigPath };
    return cfg;
  }

  function writeMcYaml(body: string): string {
    const path = join(testDir, "mission-control.yaml");
    writeFileSync(path, body);
    return path;
  }

  test("surfaces a WARNING (exit 0) when the MC yaml sets principals without a listed local_principal", async () => {
    const mcPath = writeMcYaml("governance:\n  principals:\n    - andreas@x.io\n");
    const path = writeConfig(configWithMc(mcPath));
    const result = await dispatchConfig(["validate", "--config", path]);

    // The cortex config is VALID → exit 0, ✓ line still printed …
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ config valid:");
    // … but the governance footgun is surfaced pre-write on stderr.
    expect(result.stderr).toContain("mc.governance");
    expect(result.stderr).toContain("local_principal is unset");
    expect(result.stderr).toContain("403");
  });

  test("--json carries the warning under a warnings[] key (still ok:true)", async () => {
    const mcPath = writeMcYaml("governance:\n  principals:\n    - andreas@x.io\n");
    const path = writeConfig(configWithMc(mcPath));
    const result = await dispatchConfig(["validate", "--config", path, "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; warnings?: string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.warnings?.length).toBe(1);
    expect(parsed.warnings?.[0]).toContain("mc.governance");
  });

  test("NO warning (clean stderr) when local_principal is a listed principal", async () => {
    const mcPath = writeMcYaml(
      "governance:\n  principals:\n    - andreas@x.io\n  local_principal: andreas@x.io\n",
    );
    const path = writeConfig(configWithMc(mcPath));
    const result = await dispatchConfig(["validate", "--config", path]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("cortex config validate — invalid config", () => {
  /**
   * Take the valid config and add an OUT-OF-SCOPE second accept_subject at
   * index [1] — `federated.wrong-network.>` does not begin with the receiving
   * stack's own `federated.andreas.default.` scope, so the boot-time
   * cross-validator (ADR 0001) rejects it. This is precisely the class of bad
   * edit that crash-loops the daemon at restart.
   */
  function invalidConfig(): Record<string, unknown> {
    const cfg = validConfig();
    const policy = cfg.policy as {
      federated: { networks: { accept_subjects: string[] }[] };
    };
    policy.federated.networks[0]!.accept_subjects = [
      "federated.andreas.default.>",
      "federated.wrong-network.>",
    ];
    return cfg;
  }

  test("exit 1 with the precise Zod issue path + message", async () => {
    const path = writeConfig(invalidConfig());
    const result = await dispatchConfig(["validate", "--config", path]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    // The exact boot-path error: field path + the ADR-0001 scope message.
    expect(result.stderr).toContain("✗ config invalid:");
    expect(result.stderr).toContain(
      'policy.federated.networks[0].accept_subjects[1]',
    );
    expect(result.stderr).toContain(
      'must begin with "federated.andreas.default."',
    );
  });

  test("--json emits {ok:false} with the same errors[]", async () => {
    const path = writeConfig(invalidConfig());
    const result = await dispatchConfig(["validate", "--config", path, "--json"]);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr) as {
      ok: boolean;
      path: string;
      errors: string[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.path).toBe(path);
    expect(parsed.errors.length).toBeGreaterThan(0);
    expect(
      parsed.errors.some((e) =>
        e.includes("policy.federated.networks[0].accept_subjects[1]"),
      ),
    ).toBe(true);
  });

  test("a missing config file fails (exit 1), not a crash", async () => {
    const missing = join(testDir, "does-not-exist.yaml");
    const result = await dispatchConfig(["validate", "--config", missing]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("✗ config invalid:");
  });
});

describe("cortex config validate — renderer coverage guard (cortex#1893, ADR-0024 §OQ9)", () => {
  test("zero-renderer config still validates (out of scope → no false hard-fail)", async () => {
    // validConfig() declares no renderers — the guard must not touch it.
    const path = writeConfig(validConfig());
    const result = await dispatchConfig(["validate", "--config", path]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ config valid:");
  });

  test("AC5: dashboard + system-covering pagerduty validates through the real loader", async () => {
    const cfg = validConfig();
    cfg.renderers = [
      { kind: "dashboard", subscribe: ["local.{principal}.>"] },
      { kind: "pagerduty", routingKey: "unit-test-routing-key", subscribe: ["local.{principal}.system.>"] },
    ];
    const path = writeConfig(cfg);
    const result = await dispatchConfig(["validate", "--config", path]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ config valid:");
  });

  test("AC3: dashboard-alone fails config-load with the CONFIG coverage error (no secret echoed)", async () => {
    const cfg = validConfig();
    cfg.renderers = [{ kind: "dashboard", subscribe: ["local.{principal}.>"] }];
    const path = writeConfig(cfg);
    const result = await dispatchConfig(["validate", "--config", path]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("renderer coverage check FAILED (config)");
    expect(result.stderr).toContain("[dashboard]");
  });

  test("AC4: the CONFIG coverage error never echoes the pagerduty routingKey", async () => {
    // pagerduty alone (a single sink) fails, and it carries a secret — prove
    // the failure text never surfaces it.
    const secret = "SUPER-SECRET-ROUTING-KEY-do-not-leak";
    const cfg = validConfig();
    cfg.renderers = [{ kind: "pagerduty", routingKey: secret, subscribe: ["local.{principal}.system.>"] }];
    const path = writeConfig(cfg);
    const result = await dispatchConfig(["validate", "--config", path]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("renderer coverage check FAILED (config)");
    expect(result.stderr).not.toContain(secret);
  });
});

describe("cortex config validate — CLI grammar", () => {
  test("no subcommand → usage error (exit 2)", async () => {
    const result = await dispatchConfig([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no subcommand specified");
  });

  test("unknown subcommand → usage error (exit 2)", async () => {
    const result = await dispatchConfig(["frobnicate"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown subcommand "frobnicate"');
  });

  test("--help → exit 0 with usage", async () => {
    const result = await dispatchConfig(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cortex config validate");
  });
});
